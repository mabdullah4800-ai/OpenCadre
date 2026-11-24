import { db } from "./db.js";
import { toSqliteTime } from "./timestamps.js";

/** Real, countable per-org usage (Stage 3 retro finding: "usage metering (tokens, agent-hours,
 * approvals) as the billing substrate from day one"). src/usage.ts already exists but only stores
 * the LATEST self-reported subscription-usage percentage from a client's own usage panel (Claude
 * Code/Codex CLI) -- no history, no token counts, no agent-hours, no per-org rollup, and nothing the
 * hub itself measured. This is the other half: what the hub can say for certain happened, from its
 * own tamper-evident event log and agent rows, not from a client's self-report.
 *
 * This is metering, not billing: it counts real activity in a window and exposes it as a report.
 * Turning that into an invoice (rates, plans, payment) is a genuinely separate system with its own
 * requirements (what's the unit, who's charged, what plan) that isn't decided here. */

export interface OrgUsageSummary {
  orgId: string;
  since: string;
  until: string;
  messagesSent: number;
  tasksCompleted: number;
  approvalsDecided: number;
  /** Distinct agents with a heartbeat in the window (src/service.ts's heartbeat, called on every
   * authenticated request) -- "how many distinct identities did real work here," not a headcount. */
  activeAgents: number;
  /** Summed, clamped-to-the-window online time for session-kind agents only (kind = 'session' --
   * the actual coding-tool sessions, src/devices.ts), in hours. A named/API agent (an always-on bot,
   * a webhook-driven agent) has no session boundary in this schema to measure "online time" against,
   * so it isn't counted here -- documented, not silently assumed to be zero usage. */
  sessionAgentHours: number;
}

export const DEFAULT_USAGE_WINDOW_DAYS = 30;
const MAX_USAGE_WINDOW_DAYS = 366;

export class OrgUsageInputError extends Error {}

/** Counts rows of `type` since a bound. The parameter is NAMED `sinceSql` deliberately: it is compared
 * as a string against `created_at`, which holds SQLite's `datetime('now')` spelling, so passing the ISO
 * `since` here is a silent under-count (see the note in getOrgUsageSummary). This function was caught
 * shadowing that exact name and the parameter is now named after its CONTRACT rather than its meaning,
 * so a future edit cannot pass the wrong spelling without the name looking wrong. */
function countEvents(orgId: string, type: string, sinceSql: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND type = ? AND created_at >= ?`).get(orgId, type, sinceSql) as { n: number }).n;
}

export function getOrgUsageSummary(orgId: string, opts: { sinceDays?: number } = {}): OrgUsageSummary {
  const sinceDays = opts.sinceDays ?? DEFAULT_USAGE_WINDOW_DAYS;
  if (!Number.isFinite(sinceDays) || sinceDays <= 0 || sinceDays > MAX_USAGE_WINDOW_DAYS) {
    throw new OrgUsageInputError(`sinceDays must be between 1 and ${MAX_USAGE_WINDOW_DAYS}`);
  }
  const untilMs = Date.now();
  const sinceMs = untilMs - sinceDays * 24 * 60 * 60 * 1000;
  // TWO SPELLINGS OF THE SAME INSTANT, on purpose.
  //
  // `since`/`until` are returned to callers, and an ISO string with a zone (`...T14:30:00.000Z`) is the
  // right shape for a JSON API. But the SQL comparisons below run against `created_at`, which columns
  // default to SQLite's `datetime('now')` -> `"2026-09-19 14:30:00"`. Those two strings differ at index
  // 10, where ' ' sorts BELOW 'T', so a string comparison resolves THERE and never reaches the time:
  // every row on the cutoff's calendar day was excluded although it was inside the window, and usage
  // silently under-counted by up to a day of activity on the meter billing reads.
  //
  // So the SQL gets the SQLite spelling and the response keeps the ISO one. `tests/org-usage.test.ts`
  // pins the boundary with a row two hours inside the window, which fails on the ISO comparison.
  const since = new Date(sinceMs).toISOString();
  const until = new Date(untilMs).toISOString();
  const sinceSql = toSqliteTime(sinceMs);
  const untilSql = toSqliteTime(untilMs);

  const messagesSent = countEvents(orgId, "message.sent", sinceSql);
  const tasksCompleted = countEvents(orgId, "task.completed", sinceSql);
  const approvalsDecided = countEvents(orgId, "approval.decided", sinceSql);

  const activeAgents = (db.prepare(
    `SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND removed_at IS NULL AND last_heartbeat_at >= ?`,
  ).get(orgId, sinceSql) as { n: number }).n;   // sinceSql, not since -- same column, same spelling rule

  // Only rows that could possibly overlap [since, until]: started before the window ends, and either
  // still running (ended_at IS NULL) or ended after the window began.
  const sessionRows = db.prepare(
    `SELECT created_at, ended_at FROM agents
      WHERE org_id = ? AND kind = 'session' AND created_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`,
  ).all(orgId, untilSql, sinceSql) as Array<{ created_at: string; ended_at: string | null }>;

  let totalMs = 0;
  for (const row of sessionRows) {
    const startMs = Math.max(new Date(row.created_at).getTime(), sinceMs);
    const endMs = Math.min(row.ended_at ? new Date(row.ended_at).getTime() : untilMs, untilMs);
    totalMs += Math.max(0, endMs - startMs);
  }

  return {
    orgId, since, until, messagesSent, tasksCompleted, approvalsDecided, activeAgents,
    sessionAgentHours: Math.round((totalMs / (1000 * 60 * 60)) * 100) / 100,
  };
}
