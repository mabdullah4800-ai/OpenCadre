import { db } from "./db.js";
import { isReachable, type ScopeAgent } from "./scope.js";

/** Real outcome history per agent (Stage 2 retro finding: "learned trust/routing weights per
 * agent x task-type, built from real outcome history"). This is the history, not the learning --
 * counting an agent's task.accepted vs task.rejected events (src/tasks.ts's acceptTask/rejectTask,
 * always a distinct agent from the claimant, never self-reported) is the honest, buildable
 * foundation a trust-weight system would train on. It does not itself route tasks or weight
 * anything; it answers "what actually happened," the same way the tamper-evident event log answers
 * every other "what actually happened" question in this codebase.
 *
 * Reads events directly rather than adding new columns/a migration: acceptTask/rejectTask already
 * emit task.accepted/task.rejected with target_agent_id set to the claimant, so this is a pure
 * aggregate over data that already exists and is already tamper-evident. */

export interface AgentReliability {
  agent_id: string;
  agent_name: string;
  accepted: number;
  rejected: number;
  total: number;
  /** accepted / total, or null when total is 0 -- no outcome history yet is a distinct state from
   * "0% reliable," and callers (a future routing/trust-weight consumer included) must not conflate
   * the two. */
  accept_rate: number | null;
}

function toReliability(agentId: string, agentName: string, accepted: number, rejected: number): AgentReliability {
  const total = accepted + rejected;
  return { agent_id: agentId, agent_name: agentName, accepted, rejected, total, accept_rate: total === 0 ? null : accepted / total };
}

/** One agent's own outcome history. Present even for a removed agent's id (the row it counts is
 * an immutable past event, not the agent's current existence), with 0/0/null if it never had a
 * reviewed task, name falls back to the id in that case since there's no agents row to read it from. */
export function getAgentReliability(orgId: string, agentId: string, viewer?: ScopeAgent): AgentReliability {
  // While projects are kept apart, an agent outside the viewer's reach reads exactly like an id with no history: its
  // name and outcomes stay in its own project, and the answer doesn't confirm it exists.
  if (viewer && !isReachable(viewer, agentId)) return toReliability(agentId, agentId, 0, 0);
  const counts = db.prepare(
    `SELECT type, COUNT(*) AS n FROM events WHERE org_id = ? AND target_agent_id = ? AND type IN ('task.accepted', 'task.rejected') GROUP BY type`,
  ).all(orgId, agentId) as Array<{ type: string; n: number }>;
  const accepted = counts.find((c) => c.type === "task.accepted")?.n ?? 0;
  const rejected = counts.find((c) => c.type === "task.rejected")?.n ?? 0;
  const agentRow = db.prepare(`SELECT name FROM agents WHERE id = ? AND org_id = ?`).get(agentId, orgId) as { name: string } | undefined;
  return toReliability(agentId, agentRow?.name ?? agentId, accepted, rejected);
}

/** Every agent in the org with at least one accepted or rejected task, most-reliable first (ties
 * broken by more total history, since a 1/1 record and a 40/40 record aren't equally trustworthy
 * even though both are 100%). Agents with zero history are omitted, not zero-filled -- listing every
 * agent that ever existed with an empty record would bury the ones with real signal. */
export function listAgentReliability(orgId: string, viewer?: ScopeAgent): AgentReliability[] {
  const rows = db.prepare(
    `SELECT e.target_agent_id AS agent_id, COALESCE(a.name, e.target_agent_id) AS agent_name, e.type, COUNT(*) AS n
       FROM events e
       LEFT JOIN agents a ON a.id = e.target_agent_id AND a.org_id = e.org_id
      WHERE e.org_id = ? AND e.target_agent_id IS NOT NULL AND e.type IN ('task.accepted', 'task.rejected')
      GROUP BY e.target_agent_id, agent_name, e.type`,
  ).all(orgId) as Array<{ agent_id: string; agent_name: string; type: string; n: number }>;

  const byAgent = new Map<string, { name: string; accepted: number; rejected: number }>();
  for (const row of rows) {
    const entry = byAgent.get(row.agent_id) ?? { name: row.agent_name, accepted: 0, rejected: 0 };
    if (row.type === "task.accepted") entry.accepted = row.n;
    else entry.rejected = row.n;
    byAgent.set(row.agent_id, entry);
  }
  return [...byAgent.entries()]
    .filter(([agentId]) => !viewer || isReachable(viewer, agentId))
    .map(([agentId, { name, accepted, rejected }]) => toReliability(agentId, name, accepted, rejected))
    .sort((a, b) => (b.accept_rate ?? 0) - (a.accept_rate ?? 0) || b.total - a.total);
}
