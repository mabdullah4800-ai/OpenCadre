// The awareness digest's per-computer connector item (PLAN-PR-E addendum §3.2(b), amendment 2 §4; PR-E1b).
//
// WHY. A computer's own update notice exists only in helpers new enough to carry it. The hub already knows what each
// computer self-reports (devices.connector_reports) and when it was last seen, and every hook and MCP client already
// asks the hub for its awareness digest. So the hub adds one item to the digest of a session on that computer: it rides
// a call that already happens (no new request), and it also reaches hooks that render the digest but predate the
// notice. MCP-only clients receive it through get_awareness.
//
// WHICH COMPUTER (amendment 2 §4.2, frozen). The caller's computer is resolved ONLY by the explicit, org-scoped
// session-to-device query below. No row means no item: a named agent, a non-session agent, a session with no device, an
// ended session, or a revoked or merged device. A merged device is not followed to the computer it merged into, and
// nothing is guessed from a client, folder or project.
//
// WHAT IT SAYS. Only what the hub knows: the computer's self-reported status (src/connector-health.ts), worded as the
// evidence allows, and the stamped command rebuilt from the hub's OWN package snapshot (cliAliasUrl). Never a
// credential, device id or installation id, and never text a computer sent. Required-entry text comes from the reviewed
// policy file, held to its character class (src/compat-policy.ts). The item is advisory; nothing executes it.
//
// HOW OFTEN. Once per computer per (hub package, status) per ROLLING 24 h. The device row keeps a claim for EVERY
// (package, status) it carried in the last 24 h (devices.connector_digest, {"<stamp>:<status>": claimedAt ms}), not
// only the last one, so a status or package that flips away and back inside 24 h is not carried a second time. A claim
// is taken by compare-and-set on that column inside the same transaction as the event insert, so of several sessions
// asking at once exactly one carries it, and a failed insert leaves the claims as they were. The item is then an
// ordinary directed awareness event for that session: delivered once at priority 2, visible in the timeline, and never
// resurfaced.
//
// BOUNDED, AND NEVER BY EVICTION. Only claims 24 h old or older are dropped. If CONNECTOR_DIGEST_MAX_CLAIMS live claims
// are already held, a NEW (package, status) is refused, not emitted; no live claim is evicted to make room, because
// evicting one would re-enable the item it suppresses. Claims that cannot be parsed refuse every emit (fail closed)
// rather than being read as empty. Four statuses can carry an item, so the cap is reached only by 16+ package deploys
// inside one day.
import { db } from "./db.js";
import { connectorHealth, type ConnectorStatus } from "./connector-health.js";
import { cliAliasUrl, currentCliPackage, publicHubUrl } from "./cli-package.js";
import { emitEvent } from "./events.js";

export const CONNECTOR_DIGEST_DEDUPE_MS = 24 * 3600_000;
/** The most live (younger than 24 h) claims one computer holds. At the cap a new item is refused, never an old claim evicted. */
export const CONNECTOR_DIGEST_MAX_CLAIMS = 64;
const CLAIM_KEY = /^[0-9a-f]{12}:[a-z-]{1,40}$/;

/**
 * The claims after claiming `key` at `now`, or null when `key` must not be emitted: it was claimed less than 24 h ago,
 * the live claims are at the cap, or the stored claims are unreadable. Pure, so the rule is testable on its own.
 * Claims at least 24 h old are the only ones dropped; a claim dated in the future (a clock that stepped back) is live.
 */
export function claimDigestKey(raw: string | null, key: string, now: number): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? "{}"); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const live: Record<string, number> = {};
  for (const [k, at] of Object.entries(parsed as Record<string, unknown>)) {
    if (!CLAIM_KEY.test(k) || !Number.isSafeInteger(at)) return null;
    if (now - (at as number) < CONNECTOR_DIGEST_DEDUPE_MS) live[k] = at as number;
  }
  if (Object.hasOwn(live, key)) return null;
  if (Object.keys(live).length >= CONNECTOR_DIGEST_MAX_CLAIMS) return null;
  live[key] = now;
  return JSON.stringify(live);
}

/** Amendment 2 §4.2, verbatim: the ONLY way a digest item is mapped to a computer. */
export const SESSION_DEVICE_SQL = `SELECT d.id FROM agents a JOIN devices d ON d.id = a.device_id AND d.org_id = a.org_id
 WHERE a.org_id = ? AND a.id = ? AND a.kind = 'session' AND a.ended_at IS NULL
   AND d.revoked_at IS NULL AND d.merged_into_device_id IS NULL`;
const selectSessionDevice = db.prepare(SESSION_DEVICE_SQL);

/** The computer behind a live session agent of this workspace, or null for every other caller. */
export function deviceForSession(orgId: string, agentId: string): string | null {
  const rows = selectSessionDevice.all(orgId, agentId) as Array<{ id: string }>;
  return rows.length === 1 ? rows[0].id : null;
}

/** The statuses that carry an item. reported-current and unknown say nothing worth a line. */
const ITEM_STATUSES: ReadonlySet<ConnectorStatus> = new Set(["update-available", "check-installation", "no-recent-report", "security-update-required"]);

/** The item's text. `cli` is `npx -y <hub>/cli/<stamp>/opencadre-cli.tgz`, built here, never taken from a report. */
export function connectorItemText(status: ConnectorStatus, cli: string, feature: string | null): string | null {
  const trust = "Review any changed-hook or Trust prompt yourself; an agent must not approve it.";
  switch (status) {
    case "update-available":
      return `OpenCadre connector: this computer reported helpers that differ from the hub's current build. This is an optional update, not a compatibility verdict. Update command: ${cli} connect --upgrade (then restart your AI tools). ${trust}`;
    case "check-installation":
      return `OpenCadre connector: this computer reported OpenCadre helper files that are modified or missing. Check the installation with: ${cli} doctor --client <tool>. Nothing was changed.`;
    case "no-recent-report":
      return `OpenCadre connector: no recent connector report from this computer. Possible causes: helpers that predate build reports; a report that failed or was offline at its checkpoint; a named-agent configuration. This is missing telemetry, not a verdict on the installation. Current upgrade command: ${cli} connect --upgrade`;
    case "security-update-required":
      return feature
        ? `OpenCadre connector: a security update is required for ${feature}. Other features keep working. Update command: ${cli} connect --upgrade (then restart your AI tools). ${trust}`
        : null;
    default:
      return null;
  }
}

const selectDevice = db.prepare(
  `SELECT connector_reports, connector_refusals, last_seen_at FROM devices WHERE id = ? AND org_id = ?`,
);
const selectClaims = db.prepare(`SELECT connector_digest FROM devices WHERE id = ? AND org_id = ?`);
/** Compare-and-set: the write lands only if the claims are still the ones read, so two writers cannot both claim. */
const writeClaims = db.prepare(`UPDATE devices SET connector_digest = ? WHERE id = ? AND org_id = ? AND connector_digest = ?`);

/**
 * Emits this session's connector item as a directed `connector.notice` event when its computer warrants one and no
 * session of that computer carried the same (package, status) item in the last 24 h. Returns the emitted text, or null.
 * Called by getAwareness before it lists events, so the item appears in the same digest.
 */
export function maybeEmitConnectorItem(orgId: string, agentId: string, now = Date.now()): string | null {
  const deviceId = deviceForSession(orgId, agentId);
  if (!deviceId) return null;
  const pkg = currentCliPackage();
  if (!pkg) return null;
  const build = pkg.build();
  const row = selectDevice.get(deviceId, orgId) as { connector_reports: string; connector_refusals: string; last_seen_at: string | null } | undefined;
  if (!row) return null;
  const health = connectorHealth(row.connector_reports, build.ok ? build.build.helpers : null, now, {
    lastSeenAt: row.last_seen_at, refusals: row.connector_refusals, compat: pkg.compat(),
  });
  if (!ITEM_STATUSES.has(health.status)) return null;
  const text = connectorItemText(health.status, `npx -y ${cliAliasUrl(publicHubUrl(), pkg.stamp)}`, health.requiredFeature);
  if (!text) return null;
  const key = `${pkg.stamp}:${health.status}`;
  return db.transaction(() => {
    const current = (selectClaims.get(deviceId, orgId) as { connector_digest: string } | undefined)?.connector_digest;
    if (current === undefined) return null;
    const next = claimDigestKey(current, key, now);
    if (next === null) return null;
    if (writeClaims.run(next, deviceId, orgId, current).changes !== 1) return null;
    emitEvent({
      orgId, type: "connector.notice", subjectType: "agent", subjectId: agentId, targetAgentId: agentId,
      payload: { status: health.status, stamp: pkg.stamp, text },
    });
    return text;
  })();
}
