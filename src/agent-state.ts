import { parseStamp } from "./timestamps.js";

/** Canonical agent state (reliability sprint R1.4). One word per agent, computed by the hub from signals it
 * already has, so every client, the console and other agents see the same thing instead of each guessing
 * from a heartbeat timestamp. Pure: the caller passes the signals, which keeps every rule unit-testable. */

export const AGENT_STATES = ["working", "waiting", "blocked", "idle", "online", "offline"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** A working phase counts as current for this long after the agent last set it. Long builds and test runs
 * rarely re-announce status, and the 2-minute heartbeat already catches a dead agent. */
export const WORK_STALE_MS = 30 * 60 * 1000;

export interface StateSignals {
  online: boolean;
  /** agents.status: "paused" means auto-suspended for staleness. */
  status: string;
  phase: string | null;
  statusUpdatedAt: string | null;
  usageLimited: boolean;
  usageResetsAt: string | null;
  pendingApprovals: number;
  openQuestions: number;
}

export interface AgentStateResult {
  state: AgentState;
  reason: string;
}

// agents.status_updated_at is SQLite's "YYYY-MM-DD HH:MM:SS" UTC, but the GUARDED reader accepts an
// ISO value too -- the naive form would return NaN for one, and NaN in the comparison below is
// false, which reads a fresh agent as stale. One definition: src/timestamps.ts.
const parseSqlite = parseStamp;

export function computeAgentState(s: StateSignals, now = Date.now()): AgentStateResult {
  if (s.status === "paused") return { state: "offline", reason: "auto-suspended after no heartbeat" };
  if (!s.online) return { state: "offline", reason: "no heartbeat in the last 2 minutes" };
  const outOfUsage = s.usageResetsAt ? `out of usage until ${s.usageResetsAt}` : "out of usage";
  // A pending approval needs a person to act, so it outranks an out-of-usage agent (which only needs time);
  // the reason still says both, so neither fact is hidden.
  if (s.pendingApprovals > 0) {
    return { state: "waiting", reason: `waiting on ${s.pendingApprovals} approval request(s)${s.usageLimited ? `; also ${outOfUsage}` : ""}` };
  }
  if (s.usageLimited) return { state: "blocked", reason: outOfUsage };
  if (s.openQuestions > 0) return { state: "waiting", reason: `waiting on an answer to ${s.openQuestions} question(s)` };
  const fresh = s.statusUpdatedAt !== null && now - parseSqlite(s.statusUpdatedAt) <= WORK_STALE_MS;
  if (s.phase === "waiting" && fresh) return { state: "waiting", reason: "reported waiting" };
  if (s.phase && s.phase !== "waiting" && fresh) return { state: "working", reason: s.phase };
  if (s.statusUpdatedAt === null) return { state: "online", reason: "connected, no status reported yet" };
  return { state: "idle", reason: "no status update in the last 30 minutes" };
}
