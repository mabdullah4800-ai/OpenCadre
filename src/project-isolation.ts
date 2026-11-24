import { db } from "./db.js";
import { emitEvent } from "./events.js";
import { projectKeyOf, PROJECT_KEY_ERROR } from "./projects.js";
import { projectExists, resolveProjectKey } from "./project-stamps.js";
import { invalidateScopes, projectDisplayName, projectIsolationEnabled } from "./scope.js";
import { projectIsolationPreflight, type PreflightWorkspace } from "./project-preflight.js";
import { classifySharedState } from "./migrations.js";
import { closeConnectorGrants, endConnectorConnections } from "./oauth.js";

/** Project isolation, the admin side (docs/design/PROJECT_ISOLATION.md §3.4, §7 item 3): linked projects and the workspace
 * setting that switches enforcement on. The rules themselves live in src/scope.ts. */

type Actor = { id: string; name: string };

export class ProjectLinkError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
  }
}

export interface ProjectLinkView {
  projectA: string;
  projectB: string;
  nameA: string;
  nameB: string;
  createdBy: string;
  createdAt: string;
}

type LinkRow = { org_id: string; project_a: string; project_b: string; created_by: string; created_at: string };

const view = (row: LinkRow): ProjectLinkView => ({
  projectA: row.project_a, projectB: row.project_b,
  nameA: projectDisplayName(row.org_id, row.project_a)!, nameB: projectDisplayName(row.org_id, row.project_b)!,
  createdBy: row.created_by, createdAt: row.created_at,
});

export function listProjectLinks(orgId: string): ProjectLinkView[] {
  return (db.prepare(`SELECT * FROM project_links WHERE org_id = ? ORDER BY project_a, project_b`).all(orgId) as LinkRow[]).map(view);
}

/** Both keys as canonical project keys of this workspace, in stored order (a < b). */
function pair(orgId: string, rawA: unknown, rawB: unknown): [string, string] {
  const keys = [rawA, rawB].map((raw) => {
    const key = resolveProjectKey(orgId, projectKeyOf(raw));
    if (!key) throw new ProjectLinkError(`projectA and projectB: ${PROJECT_KEY_ERROR}`, 400);
    if (!projectExists(orgId, key)) throw new ProjectLinkError(`${key} isn't a project in this workspace`, 404);
    return key;
  });
  if (keys[0] === keys[1]) throw new ProjectLinkError("a project can't be linked to itself", 400);
  return keys.sort() as [string, string];
}

/** Links two projects (idempotent). Their agents can then see each other in the roster and message, question, reply and
 * share files, while tasks, timeline, approvals and awareness stay per project. */
export function linkProjects(orgId: string, actor: Actor, rawA: unknown, rawB: unknown): { link: ProjectLinkView; created: boolean } {
  const [a, b] = pair(orgId, rawA, rawB);
  const created = db.transaction(() => {
    const inserted = db.prepare(
      `INSERT INTO project_links (org_id, project_a, project_b, created_by, created_by_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, project_a, project_b) DO NOTHING`,
    ).run(orgId, a, b, actor.name, actor.id, new Date().toISOString()).changes > 0;
    if (inserted) {
      emitEvent({
        orgId, type: "project.linked", actor, subjectType: "project", subjectId: `${a} ${b}`, projectKey: null,
        payload: { projectA: a, projectB: b, nameA: projectDisplayName(orgId, a), nameB: projectDisplayName(orgId, b) },
      });
    }
    return inserted;
  })();
  invalidateScopes();
  const row = db.prepare(`SELECT * FROM project_links WHERE org_id = ? AND project_a = ? AND project_b = ?`).get(orgId, a, b) as LinkRow;
  return { link: view(row), created };
}

/** Removes a link. Reach shrinks at once: the next message, reply or roster read between the two projects is refused. */
export function unlinkProjects(orgId: string, actor: Actor, rawA: unknown, rawB: unknown): boolean {
  const [a, b] = pair(orgId, rawA, rawB);
  const removed = db.transaction(() => {
    const gone = db.prepare(`DELETE FROM project_links WHERE org_id = ? AND project_a = ? AND project_b = ?`).run(orgId, a, b).changes > 0;
    if (gone) {
      emitEvent({
        orgId, type: "project.unlinked", actor, subjectType: "project", subjectId: `${a} ${b}`, projectKey: null,
        payload: { projectA: a, projectB: b, nameA: projectDisplayName(orgId, a), nameB: projectDisplayName(orgId, b) },
      });
    }
    return gone;
  })();
  invalidateScopes();
  return removed;
}

/** Switching isolation on while a repository is split across project keys would cut one fleet in two. */
export class PreflightRefusedError extends Error {
  constructor(readonly report: PreflightWorkspace) {
    super("Project isolation can't be switched on yet: a repository is in use under more than one project key. Resolve the splits in the report first.");
  }
}

export interface IsolationState { enabled: boolean }

export function projectIsolationState(orgId: string): IsolationState {
  return { enabled: projectIsolationEnabled(orgId) };
}

/** Switches enforcement on or off for one workspace. On runs the pre-flight first and refuses (PreflightRefusedError) when
 * it flags a split. Off restores the behaviour from before enforcement in one step. `disconnectedConnections` counts the
 * MCP connector connections switching on closed (below). */
export function setProjectIsolation(orgId: string, actor: Actor, enabled: boolean): IsolationState & { changed: boolean; disconnectedConnections: number } {
  let closed: string[] = [];
  const changed = db.transaction(() => {
    const row = db.prepare(`SELECT project_isolation FROM organizations WHERE id = ?`).get(orgId) as { project_isolation: number } | undefined;
    if (!row || (row.project_isolation === 1) === enabled) return false;
    if (enabled) {
      const [report] = projectIsolationPreflight(db, { orgId }).workspaces;
      if (report?.splits.length) throw new PreflightRefusedError(report);
    }
    db.prepare(`UPDATE organizations SET project_isolation = ? WHERE id = ?`).run(enabled ? 1 : 0, orgId);
    // What was written while projects were together is all shared; keeping them apart starts by moving each project's
    // goal, facts, locks and memory into that project (src/migrations.ts classifySharedState). Off moves nothing back:
    // with isolation off every namespace is readable again, so nothing is lost from view.
    if (enabled) classifySharedState(db, orgId);
    // A connector approved for the whole workspace was never scoped to a project, so once projects are kept apart it
    // would still reach all of them (docs/design/MCP-CONNECTOR.md §6.1, the later switch). Its grant, tokens and agent
    // go in this same step; the person reconnects and picks a project (security review S3).
    if (enabled) closed = closeConnectorGrants({ orgId, workspaceScopeOnly: true }, actor);
    emitEvent({
      orgId, type: enabled ? "workspace.isolation_enabled" : "workspace.isolation_disabled", actor, subjectType: "workspace", subjectId: orgId,
      projectKey: null, payload: {},
    });
    return true;
  })();
  invalidateScopes();
  endConnectorConnections(closed, "this workspace now keeps projects apart; reconnect and choose a project");
  return { enabled: projectIsolationEnabled(orgId), changed, disconnectedConnections: closed.length };
}
