import { db } from "./db.js";
import { createLegacyAlias } from "./migrations.js";

/** Project stamps (docs/design/PROJECT_ISOLATION.md §3.1, §4). Every row that belongs to a project records that project's
 * key when it is written, resolved through project_aliases so one repository always yields one key. This module only
 * records: nothing filters on a stamp yet (that is §5, a later change). Stamps are write-once (a trigger, migration 16). */

export type AgentScope = "project" | "projects" | "workspace";

const selectAlias = db.prepare(`SELECT project_key FROM project_aliases WHERE org_id = ? AND alias_key = ?`);
const selectAgentHome = db.prepare(`SELECT home_project, scope FROM agents WHERE id = ? AND org_id = ?`);
const selectProjectRow = db.prepare(`SELECT 1 FROM projects WHERE org_id = ? AND project_key = ?`);

/** The canonical key for a project key: its alias target, else the key itself. Null stays null. */
export function resolveProjectKey(orgId: string, key: string | null | undefined): string | null {
  if (!key) return null;
  return (selectAlias.get(orgId, key) as { project_key: string } | undefined)?.project_key ?? key;
}

/** resolveProjectKey for a write that has just seen this key arrive from a client: a legacy folder-name key that now
 * matches exactly one enabled remote key gets its alias first (the migration's rule, applied from then on). */
export function resolveIncomingProjectKey(orgId: string, key: string): string {
  return createLegacyAlias(db, orgId, key);
}

/** An agent's home project (resolved) and scope. Null home: a workspace-wide agent, a person, or an unknown id. */
export function agentProject(orgId: string, agentId: string | null | undefined): { home: string | null; scope: AgentScope } {
  const row = agentId ? (selectAgentHome.get(agentId, orgId) as { home_project: string | null; scope: AgentScope } | undefined) : undefined;
  return { home: resolveProjectKey(orgId, row?.home_project), scope: row?.scope ?? "workspace" };
}

/** The stamp for a row an agent writes: its home project (message sender, approval requester, file uploader). */
export function stampFor(orgId: string, agentId: string | null | undefined): string | null {
  return agentProject(orgId, agentId).home;
}

/** Whether this workspace has the project (after alias resolution): a workspace-wide agent may only name a real one. */
export function projectExists(orgId: string, key: string): boolean {
  return Boolean(selectProjectRow.get(orgId, key));
}

const subjectStamp = {
  message: db.prepare(`SELECT project_key FROM messages WHERE id = ? AND org_id = ?`),
  task: db.prepare(`SELECT project_key FROM tasks WHERE id = ? AND org_id = ?`),
  approval: db.prepare(`SELECT project_key FROM approvals WHERE id = ? AND org_id = ?`),
  grant: db.prepare(`SELECT project_key FROM approval_grants WHERE id = ? AND org_id = ?`),
} as const;

/** The stamp for an event, per §4: the subject row's project; an agent event uses the agent's home; a decision, conflict,
 * review or clearance bypass report uses the actor's home; a clearance policy change or project enable/disable names its
 * project; workspace, member and device events are workspace-level (null). Called inside the emitting transaction, after
 * the subject row is written. */
export function eventStamp(event: { orgId: string; type: string; subjectType: string; subjectId: string; actorId: string | null }): string | null {
  const { orgId, subjectType, subjectId } = event;
  if (subjectType in subjectStamp) {
    const row = subjectStamp[subjectType as keyof typeof subjectStamp].get(subjectId, orgId) as { project_key: string | null } | undefined;
    return row?.project_key ?? null;
  }
  if (subjectType === "agent") return stampFor(orgId, subjectId);
  if (event.type === "clearance.policy_changed") return subjectId && subjectId !== "workspace" ? resolveProjectKey(orgId, subjectId) : null;
  if (subjectType === "decision" || subjectType === "conflict" || subjectType === "review" || subjectType === "clearance") return stampFor(orgId, event.actorId);
  if (subjectType === "project") return resolveProjectKey(orgId, subjectId);
  return null;
}
