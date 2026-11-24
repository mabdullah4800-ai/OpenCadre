import { db } from "./db.js";
import { emitEvent } from "./events.js";
import { maskSecrets } from "./secrets.js";
import { namespacesOf, SHARED_NAMESPACE, writeNamespaceOf, type ScopeAgent } from "./scope.js";

/** The current goal: what Claude-Supervisor (or any agent, per convention) has set for the fleet to work toward.
 * Deliberately one row per namespace, not a history table -- "the goal" is meant to be one thing everyone can point
 * to, and past goals are still recoverable from the tamper-evident event log (goal.set events), not lost.
 *
 * One goal per namespace (src/scope.ts namespacesOf): while projects are kept apart, each project has its own goal and
 * the shared namespace ('') holds the workspace goal, which only a workspace-scope actor (a person, a workspace-wide
 * agent) sets. With isolation off there is only the shared goal, exactly as before. */

export interface GoalRecord {
  org_id: string;
  /** The namespace: '' for the workspace goal, else the project key. */
  scope_key: string;
  text: string;
  set_by_agent_id: string;
  set_by_agent_name: string;
  set_at: string;
  updated_at: string;
}

type Agent = { id: string; name: string };

function readRow(row: GoalRecord): GoalRecord {
  return { ...row, text: maskSecrets(row.text) };
}

const selectOne = db.prepare(`SELECT * FROM goals_ns WHERE org_id = ? AND scope_key = ?`);

/** The goals an agent can read: its project's (if it has one set) and the workspace's. A workspace-scope reader, or any
 * reader while isolation is off, sees the workspace goal as `workspace` and no project goal. Without a viewer (internal
 * callers), the workspace goal. */
export function getGoals(orgId: string, viewer?: ScopeAgent): { project: GoalRecord | null; workspace: GoalRecord | null } {
  const shared = selectOne.get(orgId, SHARED_NAMESPACE) as GoalRecord | undefined;
  const own = viewer ? namespacesOf(viewer).write : null;
  const project = own && own !== SHARED_NAMESPACE ? (selectOne.get(orgId, own) as GoalRecord | undefined) : undefined;
  return { project: project ? readRow(project) : null, workspace: shared ? readRow(shared) : null };
}

/** The one goal an agent should work toward: its project's goal when it has one, else the workspace goal. */
export function getGoal(orgId: string, viewer?: ScopeAgent): GoalRecord | null {
  const { project, workspace } = getGoals(orgId, viewer);
  return project ?? workspace;
}

/** Replaces the goal in the setter's namespace: its project while projects are kept apart, else the workspace goal.
 * Any agent may call this (like create_task) -- the convention that Claude-Supervisor is the one who actually does is a
 * fleet-protocol norm, not a permission the hub enforces by name, matching how every other tool here is gated by role
 * (operator/agent), never by which specific named agent is calling. */
export function setGoal(orgId: string, setter: Agent, text: string): GoalRecord {
  const trimmed = maskSecrets(text.trim());
  if (!trimmed) throw new Error("text is required");
  const namespace = writeNamespaceOf({ orgId, agentId: setter.id });
  db.transaction(() => {
    db.prepare(
      `INSERT INTO goals_ns (org_id, scope_key, text, set_by_agent_id, set_by_agent_name, set_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(org_id, scope_key) DO UPDATE SET
         text = excluded.text, set_by_agent_id = excluded.set_by_agent_id,
         set_by_agent_name = excluded.set_by_agent_name, set_at = excluded.set_at, updated_at = excluded.updated_at`,
    ).run(orgId, namespace, trimmed, setter.id, setter.name);
    emitEvent({
      orgId, type: "goal.set", actor: setter, subjectType: "goal", subjectId: orgId,
      projectKey: namespace === SHARED_NAMESPACE ? null : namespace, payload: { text: trimmed },
    });
  })();
  return readRow(selectOne.get(orgId, namespace) as GoalRecord);
}
