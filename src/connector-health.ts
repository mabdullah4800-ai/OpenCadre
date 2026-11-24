// Self-reported inventory only. Nothing here participates in authentication, billing or clearance.
//
// PR-E1b (PLAN-PR-E addendum §4, as corrected by amendment 2 §4.1) adds three observations to the per-computer label,
// each worded as what the evidence shows and nothing more:
// - `no-recent-report`: the computer was seen in the last 24 h and sent no connector report in that time. That is
//   MISSING TELEMETRY with several possible causes, never "old hooks" or a verdict on the installation.
// - refusal counts: how many requests this computer's credential made that the hub refused as "no session for this chat
//   yet" or "more than one live session; not guessing", per reason, in the last 24 h. Those can be normal startup or a
//   correct safety refusal, so they are shown as observed reasons and counts, never as "broken". A computer's own count
//   of local stamp refusals (report schema 2) is shown beside them, labelled self-reported, and is never evidence for
//   any decision.
// - a recognised cohort (src/compat-policy.ts), only from a `matches-metadata` report whose WHOLE helper set matches.
import { CONNECT_CLIENTS } from "./connect.js";
import { recognizeCohort, requiredFor, type CompatPolicy } from "./compat-policy.js";
export const REPORT_TTL_MS = 24 * 3600_000;
const MAX_REPORTS = 64;
const HASH = /^[0-9a-f]{64}$/;
const NAME = /^(?:opencadre-[a-z0-9-]+\.mjs|pure-ack\.mjs|opencadre-kilo-plugin\.js|opencode-plugin\/(?:index|mail|clearance)\.js)$/;
/** The bound on every count this module stores or shows. */
export const MAX_COUNT = 9999;
/** Report schema 2's reason classes for local stamp refusals (scripts/opencadre-config.mjs verifyStamp): no dated
 * signature, expired or future-dated, a signature that does not match, anything else. No stamp contents, ever. */
export const STAMP_REFUSAL_REASONS = ["undated", "expired", "signature", "other"] as const;
export type StampRefusalReason = (typeof STAMP_REFUSAL_REASONS)[number];
interface ReportBase {
  client: string; component: "hooks" | "proxy";
  installationId: string; bundleId: string | null;
  integrity: "matches-metadata" | "modified-or-missing" | "unknown";
  helpers: Record<string, string> | null;
}
export type ConnectorReport =
  | (ReportBase & { schema: 1 })
  /** Schema 2 (addendum §4.1, optional): schema 1 plus the computer's own count of local stamp refusals. */
  | (ReportBase & { schema: 2; stampRefusals24h: number; stampRefusalReason: StampRefusalReason | null });
type StoredReport = ConnectorReport & { reportedAt: string };
const KEYS_V1 = ["schema", "client", "component", "installationId", "bundleId", "integrity", "helpers"];
const KEYS_V2 = [...KEYS_V1, "stampRefusals24h", "stampRefusalReason"];
export function validHelperHashes(raw: unknown): raw is Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const entries = Object.entries(raw);
  return entries.length > 0 && entries.length <= 32 && entries.every(([name, value]) => name.length <= 80 && NAME.test(name) && typeof value === "string" && HASH.test(value));
}
export function validateConnectorReport(raw: unknown): ConnectorReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = r.schema === 1 ? KEYS_V1 : r.schema === 2 ? KEYS_V2 : null;
  if (!keys || Object.keys(r).length !== keys.length || Object.keys(r).some((k) => !keys.includes(k))) return null;
  if (typeof r.client !== "string" || !(CONNECT_CLIENTS as readonly string[]).includes(r.client) || r.client === "auto"
    || typeof r.component !== "string" || !["hooks", "proxy"].includes(r.component) || typeof r.installationId !== "string" || !/^[0-9a-f]{32}$/.test(r.installationId)
    || !(r.bundleId === null || typeof r.bundleId === "string" && /^[0-9a-f]{12}$/.test(r.bundleId))
    || typeof r.integrity !== "string" || !["matches-metadata", "modified-or-missing", "unknown"].includes(r.integrity)
    || !(r.helpers === null || validHelperHashes(r.helpers)) || r.integrity === "matches-metadata" && r.helpers === null) return null;
  if (r.schema === 2) {
    const count = r.stampRefusals24h;
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > MAX_COUNT) return null;
    // A reason names the refusals counted, so it is present exactly when there are some.
    if (count === 0 ? r.stampRefusalReason !== null : !(STAMP_REFUSAL_REASONS as readonly unknown[]).includes(r.stampRefusalReason)) return null;
  }
  try { if (Buffer.byteLength(JSON.stringify(r), "utf8") > 8192) return null; } catch { return null; }
  return r as unknown as ConnectorReport;
}
function recentReports(raw: string | null, now: number): StoredReport[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed) || parsed.length > MAX_REPORTS) return [];
    return parsed.filter((r) => {
      const { reportedAt, ...body } = r ?? {};
      const time = typeof reportedAt === "string" ? Date.parse(reportedAt) : NaN;
      return validateConnectorReport(body) && time <= now && time > now - REPORT_TTL_MS;
    });
  } catch { return []; }
}
export function mergeConnectorReports(raw: string | null, report: ConnectorReport, now: number): StoredReport[] {
  const key = (r: ConnectorReport) => `${r.installationId}:${r.client}:${r.component}:${r.bundleId}`;
  const rows = recentReports(raw, now).filter((r) => key(r) !== key(report));
  return [...rows, { ...report, reportedAt: new Date(now).toISOString() }].slice(-MAX_REPORTS);
}

// --- Hub-side refusal counts (addendum §4.1, amendment 2 §4.1) ------------------------------------------------------
// Stored on the device row as {"<reason>": {"<hour index>": count}}: at most 24 hourly buckets per reason, each capped,
// pruned on every write. No path, chat id, session id, project or credential is stored: only the reason and the hour.
export const REFUSAL_REASONS = ["no_session", "ambiguous_session"] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
const HOUR_MS = 3600_000;
const WINDOW_HOURS = 24;
type RefusalBuckets = Partial<Record<RefusalReason, Record<string, number>>>;

function readBuckets(raw: string | null, now: number): RefusalBuckets {
  const newest = Math.floor(now / HOUR_MS);
  const oldest = newest - (WINDOW_HOURS - 1);
  const out: RefusalBuckets = {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? "{}"); } catch { return out; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const reason of REFUSAL_REASONS) {
    const buckets = (parsed as Record<string, unknown>)[reason];
    if (!buckets || typeof buckets !== "object" || Array.isArray(buckets)) continue;
    const kept: Record<string, number> = {};
    for (const [hour, count] of Object.entries(buckets as Record<string, unknown>)) {
      const h = Number(hour);
      if (!/^\d{1,9}$/.test(hour) || h < oldest || h > newest || !Number.isSafeInteger(count) || (count as number) <= 0) continue;
      kept[hour] = Math.min(count as number, MAX_COUNT);
    }
    if (Object.keys(kept).length) out[reason] = kept;
  }
  return out;
}
/** The stored JSON after one more `reason` refusal at `now`: older buckets pruned, every count capped. */
export function bumpRefusal(raw: string | null, reason: RefusalReason, now: number): string {
  const buckets = readBuckets(raw, now);
  const hour = String(Math.floor(now / HOUR_MS));
  const row = (buckets[reason] ??= {});
  row[hour] = Math.min((row[hour] ?? 0) + 1, MAX_COUNT);
  return JSON.stringify(buckets);
}
/** Refusals per reason in the last 24 h (the current hour and the 23 before it), each capped at MAX_COUNT. */
export function refusalCounts(raw: string | null, now: number): Record<RefusalReason, number> {
  const buckets = readBuckets(raw, now);
  const sum = (reason: RefusalReason) => Math.min(Object.values(buckets[reason] ?? {}).reduce((a, b) => a + b, 0), MAX_COUNT);
  return { no_session: sum("no_session"), ambiguous_session: sum("ambiguous_session") };
}

export type ConnectorStatus =
  | "unknown" | "reported-current" | "update-available" | "check-installation" | "no-recent-report" | "security-update-required";
export interface ConnectorRefusals {
  /** Observed by the hub on this computer's credential, last 24 h. */
  noSession: number;
  ambiguousSession: number;
  /** Self-reported by the computer (report schema 2). Never authentication evidence. */
  selfReportedStamp: { count: number; reason: StampRefusalReason | null } | null;
}
export interface ConnectorHealthInputs {
  /** devices.last_seen_at: the basis of `no-recent-report`. */
  lastSeenAt?: string | null;
  /** devices.connector_refusals. */
  refusals?: string | null;
  /** The compatibility policy from the hub's current package snapshot. */
  compat?: CompatPolicy | null;
}

export function connectorHealth(raw: string | null, target: unknown, now: number, inputs: ConnectorHealthInputs = {}) {
  const reports = recentReports(raw, now);
  const policy = inputs.compat ?? null;
  const known = reports.filter((r) => r.integrity === "matches-metadata" && r.helpers);
  const cohorts = known.map((r) => recognizeCohort(policy, r.helpers));
  const required = cohorts.map((c) => (c ? requiredFor(policy, c.id) : null)).find(Boolean) ?? null;
  let status: ConnectorStatus = "unknown";
  if (reports.some((r) => r.integrity === "modified-or-missing")) status = "check-installation";
  else if (required) status = "security-update-required";
  else if (validHelperHashes(target) && reports.length) {
    if (known.some((r) => Object.keys(target).some((name) => r.helpers![name] !== target[name]))) status = "update-available";
    else if (known.length === reports.length) status = "reported-current";
  } else if (!reports.length) {
    const seen = inputs.lastSeenAt ? Date.parse(inputs.lastSeenAt) : NaN;
    if (seen <= now && seen > now - REPORT_TTL_MS) status = "no-recent-report";
  }
  // A cohort is named only when every coherent report names the same one: a mixed computer has no single cohort.
  const sameCohort = cohorts.length > 0 && cohorts.every((c) => c && c.id === cohorts[0]!.id) ? cohorts[0]! : null;
  const counted = refusalCounts(inputs.refusals ?? null, now);
  const stamp = reports.filter((r): r is StoredReport & { schema: 2 } => r.schema === 2 && r.stampRefusals24h > 0);
  const top = stamp.reduce<(StoredReport & { schema: 2 }) | null>((best, r) => (!best || r.stampRefusals24h > best.stampRefusals24h ? r : best), null);
  const selfReportedStamp = top ? { count: Math.min(stamp.reduce((a, r) => a + r.stampRefusals24h, 0), MAX_COUNT), reason: top.stampRefusalReason } : null;
  const refusals: ConnectorRefusals | null = counted.no_session || counted.ambiguous_session || selfReportedStamp
    ? { noSession: counted.no_session, ambiguousSession: counted.ambiguous_session, selfReportedStamp }
    : null;
  return {
    status,
    reportedAt: reports.at(-1)?.reportedAt ?? null,
    reports: reports.map(({ client, component, bundleId, integrity, reportedAt }) => ({ client, component, bundleId, integrity, reportedAt })),
    cohort: sameCohort ? { id: sameCohort.id, required: Boolean(required) } : null,
    /** Set only for `security-update-required`: the policy's own feature text, already held to its character class. */
    requiredFeature: status === "security-update-required" ? required!.feature : null,
    refusals,
  };
}
