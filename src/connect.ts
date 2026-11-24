import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { hashKey } from "./auth.js";
import { emitEvent } from "./events.js";
import { AgentNameError, checkAgentName, isOnline, registerAgent } from "./service.js";
import { agentLimitRefusal, readOnlyRefusal } from "./billing.js";
import { parseStamp, parseStampOrNull } from "./timestamps.js";
import { cliAliasUrl, currentCliPackage } from "./cli-package.js";
export { CLI_TARBALL } from "./cli-package.js";

/** One-time connect codes: the console mints one for a named agent, and the
 * `opencadre connect` CLI trades it for that agent's key, so no key is ever
 * copied by hand. The code is the only credential for redeeming, which is why
 * it is short-lived, single use, rate-limited and stored only as a hash. */

// `opencode` joined with #460 (per-session identity, measured): the CLI had a writer for its MCP
// block since #445, and #460 established the session half — so it is now a device client the CLI
// offers. THE HUB MUST AGREE, and this is the file that says so: `src/devices.ts` refuses a `client`
// outside this list with a 400 that names the list, so an omission here is a CLI that offers a tool
// and a hub that rejects it. That is exactly what happened when `opencadre-clients.mjs` promoted
// opencode to `device: true` and nothing pointed at this row — the tests below caught it, and the
// shape is worth naming: A CHANGE THAT IS RIGHT IN ITS OWN FILE BREAKING A FILE IT DOES NOT TOUCH.
export const CONNECT_CLIENTS = ["auto", "claude-code", "codex", "cursor", "antigravity", "gemini", "dsh", "opencode", "qwen", "amp", "kilo", "cline", "devin", "droid", "crush", "vibe", "grok", "goose", "copilot", "windsurf"] as const;
export type ConnectClient = (typeof CONNECT_CLIENTS)[number];

const CODE_TTL_MS = 15 * 60 * 1000;
// Exactly 32 symbols, so 5 random bits pick one without bias; no 0/O or 1/I to misread when retyping.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_CHARS = 10;

export function generateConnectCode(): string {
  return `oc_${Array.from(randomBytes(CODE_CHARS), (b) => CODE_ALPHABET[b & 31]).join("")}`;
}

/** Codes are case-insensitive for people retyping them; anything not code-shaped is simply unknown. */
function normalizeCode(raw: unknown): string | null {
  const m = typeof raw === "string" ? raw.trim().match(/^oc_([a-z0-9]{10})$/i) : null;
  return m ? `oc_${m[1].toUpperCase()}` : null;
}

/** The CLI package's URL, stamped with a short hash of the package itself. npx caches a tarball by its URL, so a machine
 * that ran the command before would otherwise keep running the old CLI after a deploy (found live, and measured again for
 * Q1g: a new tarball at the unchanged bare URL is never fetched, even with --prefer-online). The stamp only changes when
 * the CLI does.
 *
 * The stamp is a PATH segment, `<hub>/cli/<stamp>/opencadre-cli.tgz`, served by the immutable alias route in rest.ts,
 * rather than the `?v=<stamp>` query this used to print: a tool that strips the query would hand npx the bare URL again,
 * and the alias answers 404 for any stamp but the current one, so it can never serve new bytes under an old address. The
 * bare route still accepts `?v=` (a command printed before this change keeps working). Stamp and alias come from one
 * snapshot of the package (src/cli-package.ts), so the stamp printed is always one the alias serves. Without a built
 * package there is nothing to stamp, and nothing to download either (the routes answer 503/404). */
export function cliTarballUrl(hubUrl: string): string {
  const pkg = currentCliPackage();
  // guard-allow(unbuilt): no package is built, so no stamp exists; tests/cli-unstamped-guard.test.ts lists this exception.
  return pkg ? cliAliasUrl(hubUrl, pkg.stamp) : `${hubUrl}/cli/opencadre-cli.tgz`;
}

export function connectCommand(hubUrl: string, code: string, client: ConnectClient): string {
  const clientArg = client === "auto" ? "" : ` --client ${client}`;
  return `npx -y ${cliTarballUrl(hubUrl)} connect --hub ${hubUrl} --code ${code}${clientArg}`;
}

/** Throws AgentNameError when the name is malformed (400) or already taken (409). */
export function createConnectCode(
  orgId: string,
  creator: { id: string },
  rawName: unknown,
  client: ConnectClient,
): { code: string; expiresAt: string } {
  const agentName = checkAgentName(orgId, rawName);
  const code = generateConnectCode();
  const now = Date.now();
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO connect_codes (code_hash, org_id, agent_name, client, created_by_agent_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(hashKey(code), orgId, agentName, client, creator.id, new Date(now).toISOString(), expiresAt);
  return { code, expiresAt };
}

interface ConnectCodeRow {
  org_id: string;
  agent_name: string;
  client: ConnectClient;
  created_by_agent_id: string;
  expires_at: string;
  redeemed_at: string | null;
}

export type RedeemResult =
  | { ok: true; apiKey: string; agentId: string; agentName: string; client: ConnectClient; orgName: string }
  | { ok: false; status: 400 | 404 | 409 | 410 | 402 | 423; error: string };

export function redeemConnectCode(raw: unknown): RedeemResult {
  const code = normalizeCode(raw);
  const notFound = { ok: false, status: 404, error: "unknown connect code" } as const;
  if (!code) return notFound;
  return db.transaction((): RedeemResult => {
    const row = db.prepare(`SELECT * FROM connect_codes WHERE code_hash = ?`).get(hashKey(code)) as ConnectCodeRow | undefined;
    if (!row) return notFound;
    if (row.redeemed_at) return { ok: false, status: 410, error: "this connect code was already used; generate a new command in the console" };
    // parseStamp, not a bare Date.parse: `expires_at` is written ISO today (this file, above) but the
    // guarded reader accepts either spelling, so a future writer switching to datetime('now') cannot
    // silently make this comparison NaN — which would read a LAPSED code as usable.
    if (parseStamp(row.expires_at) <= Date.now()) return { ok: false, status: 410, error: "this connect code expired; generate a new command in the console" };
    // A paused workspace adds no agents. The code stays unspent, so it works once an operator resumes (if still unexpired).
    const paused = (db.prepare(`SELECT paused_at FROM organizations WHERE id = ?`).get(row.org_id) as { paused_at: string | null } | undefined)?.paused_at;
    if (paused) return { ok: false, status: 423, error: "this workspace is paused by an operator; ask them to resume it, then run the same command again" };
    // Redeeming adds an agent, so it is a write and a lapsed workspace refuses it (src/billing.ts).
    // Same promise as the pause refusal above, and for the same reason: the code is not spent, so the
    // exact same command works unchanged once the workspace is put back on a plan.
    const billingRefused = readOnlyRefusal(row.org_id, "POST");
    if (billingRefused) return { ok: false, status: 402, error: billingRefused.body.error };

    // ...and the PLAN's agent limit, immediately after it and before the agent exists -- the same order
    // as the read-only refusal above, so a refusal performs no half-write. The code is NOT spent, for the
    // same reason it is not spent on a lapse: the workspace can raise its plan or retire an agent and the
    // exact same command works unchanged. A spent code would turn a recoverable refusal into a lost one.
    //
    // The refusal carries no `code` field because this shape has none (status + error only), and 402 is
    // already in its union -- adding a field here would be a second vocabulary for the same word. The
    // MESSAGE names the unit and the remedy, which is what the caller acts on.
    const limitRefused = agentLimitRefusal(row.org_id, undefined, "connect_code");
    if (limitRefused) return { ok: false, status: 402, error: limitRefused.body.error };

    let agent: ReturnType<typeof registerAgent>;
    try {
      agent = registerAgent(row.org_id, row.agent_name);
    } catch (err) {
      // Someone took the name after the code was made (409), or the name rules changed since (400). The code stays
      // unspent, but it can't succeed; the refusal says why.
      if (err instanceof AgentNameError) return { ok: false, status: err.status, error: err.message };
      throw err;
    }
    db.prepare(`UPDATE connect_codes SET redeemed_at = ?, agent_id = ? WHERE code_hash = ?`).run(new Date().toISOString(), agent.agentId, hashKey(code));
    emitEvent({
      orgId: row.org_id, type: "agent.connected", actor: { id: agent.agentId, name: agent.agentName },
      subjectType: "agent", subjectId: agent.agentId,
      payload: { agentName: agent.agentName, client: row.client, createdByAgentId: row.created_by_agent_id },
    });
    const org = db.prepare(`SELECT name FROM organizations WHERE id = ?`).get(row.org_id) as { name: string };
    return { ok: true, apiKey: agent.apiKey, agentId: agent.agentId, agentName: agent.agentName, client: row.client, orgName: org.name };
  })();
}

/** Where a connect is, for the console's status and failure states (R5):
 * - waiting: the code hasn't been used yet
 * - expired: nobody used it in time
 * - installed: the CLI finished, but the client itself hasn't started talking to the hub yet (restart it)
 * - not_started: installed over NOT_STARTED_AFTER_MS ago and the client still never checked in
 * - online: the client is running and connected
 * - offline: it was connected, then went quiet
 * The CLI's own smoke test checks in within seconds of redeeming, so only activity after CLI_GRACE_MS counts as the client. */
export type ConnectStage = "waiting" | "expired" | "installed" | "not_started" | "online" | "offline";
const CLI_GRACE_MS = 60_000;
export const NOT_STARTED_AFTER_MS = 10 * 60_000;

// agents.last_heartbeat_at is SQLite's "YYYY-MM-DD HH:MM:SS" UTC, but the GUARDED reader is used
// uniformly: the naive form returns NaN for an ISO value, and NaN in a comparison is false.
const heartbeatMs = parseStampOrNull;

/** Null when the code doesn't exist in this org, so another org's code is indistinguishable from none. */
export function connectCodeStatus(orgId: string, raw: unknown, nowMs = Date.now()): {
  state: "pending" | "redeemed" | "expired";
  stage: ConnectStage;
  agentOnline: boolean;
  agentName: string;
  client: ConnectClient;
  expiresAt: string;
  redeemedAt: string | null;
  lastSeenAt: string | null;
} | null {
  const code = normalizeCode(raw);
  if (!code) return null;
  const row = db.prepare(
    `SELECT c.agent_name, c.client, c.expires_at, c.redeemed_at, a.last_heartbeat_at
     FROM connect_codes c LEFT JOIN agents a ON a.id = c.agent_id
     WHERE c.code_hash = ? AND c.org_id = ?`,
  ).get(hashKey(code), orgId) as { agent_name: string; client: ConnectClient; expires_at: string; redeemed_at: string | null; last_heartbeat_at: string | null } | undefined;
  if (!row) return null;
  const state = row.redeemed_at ? "redeemed" : parseStamp(row.expires_at) <= nowMs ? "expired" : "pending";
  const agentOnline = isOnline(row.last_heartbeat_at);
  const seenMs = heartbeatMs(row.last_heartbeat_at);

  let stage: ConnectStage;
  if (!row.redeemed_at) stage = state === "expired" ? "expired" : "waiting";
  else {
    const redeemedMs = Date.parse(row.redeemed_at);
    const clientCheckedIn = seenMs !== null && seenMs > redeemedMs + CLI_GRACE_MS;
    if (clientCheckedIn) stage = agentOnline ? "online" : "offline";
    else stage = nowMs - redeemedMs >= NOT_STARTED_AFTER_MS ? "not_started" : "installed";
  }
  return {
    state, stage, agentOnline, agentName: row.agent_name, client: row.client,
    expiresAt: row.expires_at, redeemedAt: row.redeemed_at, lastSeenAt: seenMs === null ? null : new Date(seenMs).toISOString(),
  };
}
