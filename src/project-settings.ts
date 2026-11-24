import { db } from "./db.js";
import { emitEvent } from "./events.js";
import { projectKeyOf } from "./projects.js";
import { projectExists, resolveProjectKey } from "./project-stamps.js";
import { canSee, isWorkspaceScope, projectIsolationEnabled } from "./scope.js";

/** Per-project settings an admin sets (migration 60). Today one: the WIP cap, the most live task claims one agent may
 * hold before claimTask refuses a new one (fleet coordination plan, failure 3: owners claimed 5-7 items at once). The
 * cap is per agent, by its home project: an agent's limit is its home project's cap (src/tasks.ts wipCapFor).
 *
 * Rows are keyed like clearance_policies: project_key '' is the workspace default. The effective cap for a project is
 * that project's row if it has one (even one with no cap: that project is then unlimited), else the workspace row, else
 * none -- today's behaviour. */

export const WIP_CAP_MIN = 1;
export const WIP_CAP_MAX = 50;
export const WIP_CAP_ERROR = `wipCap must be a whole number from ${WIP_CAP_MIN} to ${WIP_CAP_MAX}, or null for no cap`;
/** The REST path segment (URL-encoded or not) and MCP project value that name the workspace default rather than a
 * project. "*" is a key no project can have: projectKeyOf never yields one (sanitizeProject turns it into nothing). */
export const WORKSPACE_SETTINGS_KEY = "*";
/** What an Operator key is told when it tries to loosen a cap. Such a key is owner-equivalent (src/permissions.ts
 * roleFor), and the agent holding it is one the cap limits, so a key may only tighten. */
export const WIP_CAP_LOOSEN_REFUSAL =
  "Only a signed-in person can raise or remove the WIP cap. An Operator key may only set one where none applies, or lower it. Ask an owner or admin to change it in OpenCadre.";

export class ProjectSettingsError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404) {
    super(message);
  }
}

export interface ProjectSettingsView {
  /** The project key, or "" for the workspace default. */
  project: string;
  /** This row's own cap: null when it has none or there is no row. */
  wipCap: number | null;
  /** The cap that applies to an agent in this project. */
  effectiveWipCap: number | null;
  /** project: this project's own row decides. workspace: the workspace default does. default: nothing is set. */
  source: "project" | "workspace" | "default";
}

type Row = { wip_cap: number | null };
const selectRow = db.prepare(`SELECT wip_cap FROM project_settings WHERE org_id = ? AND project_key = ?`);

/** The project a REST path segment or MCP argument names: "" for the workspace default (or nothing given), else a
 * normalized project key. Null when it isn't one. */
export function parseProjectParam(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "" || raw === WORKSPACE_SETTINGS_KEY) return "";
  return projectKeyOf(raw);
}

export const isValidWipCap = (cap: unknown): cap is number | null =>
  cap === null || (typeof cap === "number" && Number.isInteger(cap) && cap >= WIP_CAP_MIN && cap <= WIP_CAP_MAX);

/** The cap that applies in `projectKey` (null: the workspace's own default). */
export function effectiveWipCap(orgId: string, projectKey: string | null): number | null {
  const key = resolveProjectKey(orgId, projectKey);
  const own = key ? (selectRow.get(orgId, key) as Row | undefined) : undefined;
  if (own) return own.wip_cap;
  return (selectRow.get(orgId, "") as Row | undefined)?.wip_cap ?? null;
}

function view(orgId: string, project: string): ProjectSettingsView {
  const own = selectRow.get(orgId, project) as Row | undefined;
  const workspace = project ? (selectRow.get(orgId, "") as Row | undefined) : own;
  const deciding = project && own ? own : workspace;
  return {
    project,
    wipCap: own?.wip_cap ?? null,
    effectiveWipCap: deciding?.wip_cap ?? null,
    source: project && own ? "project" : workspace ? "workspace" : "default",
  };
}

/** The project's key as stored, after checking the caller may reach it. A project outside the caller's visible
 * projects reads exactly like one that doesn't exist (PROJECT_ISOLATION.md §5). Writing the workspace default takes a
 * workspace-wide caller while projects are kept apart: a project's admin agent sets only its own projects. */
function reachable(orgId: string, callerId: string, project: string, mode: "read" | "write"): string {
  if (!project) {
    if (mode === "write" && projectIsolationEnabled(orgId) && !isWorkspaceScope({ orgId, agentId: callerId })) {
      throw new ProjectSettingsError("Only a workspace-wide admin can set the workspace default. Set your own project's cap instead.", 403);
    }
    return "";
  }
  const key = resolveProjectKey(orgId, project)!;
  if (!projectExists(orgId, key) || !canSee({ orgId, agentId: callerId }, key)) {
    throw new ProjectSettingsError(`No project "${project}" in this workspace`, 404);
  }
  return key;
}

export function getProjectSettings(orgId: string, callerId: string, project: string): ProjectSettingsView {
  return view(orgId, reachable(orgId, callerId, project, "read"));
}

/** Sets (or, with null, removes) the cap on one project or the workspace default. The permission check
 * (projectSettings.write, admin) is the caller's: src/rest.ts and src/mcp.ts. `personId` is the signed-in person
 * behind the request (a console session), or null for an Operator key, which may only TIGHTEN: judged against the
 * effective cap where it is set, a key may set a cap where none applies, keep it, or lower it, never raise it or set
 * null (on a project row, null would lift a workspace cap there). Emits project.settings_changed when the row is new or
 * its cap changed. */
export function setWipCap(
  orgId: string,
  by: { agent: { id: string; name: string }; personId: string | null },
  project: string,
  cap: unknown,
): ProjectSettingsView & { previous: number | null } {
  if (!isValidWipCap(cap)) throw new ProjectSettingsError(WIP_CAP_ERROR, 400);
  const key = reachable(orgId, by.agent.id, project, "write");
  return db.transaction(() => {
    if (by.personId === null) {
      const applies = view(orgId, key).effectiveWipCap;
      if (cap === null || (applies !== null && cap > applies)) throw new ProjectSettingsError(WIP_CAP_LOOSEN_REFUSAL, 403);
    }
    const before = selectRow.get(orgId, key) as Row | undefined;
    db.prepare(
      `INSERT INTO project_settings (org_id, project_key, wip_cap, updated_at, updated_by_person_id)
       VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT (org_id, project_key) DO UPDATE SET
         wip_cap = excluded.wip_cap, updated_at = excluded.updated_at, updated_by_person_id = excluded.updated_by_person_id`,
    ).run(orgId, key, cap, by.personId);
    const previous = before?.wip_cap ?? null;
    if (!before || previous !== cap) {
      emitEvent({
        orgId, type: "project.settings_changed", actor: by.agent, subjectType: "project", subjectId: key || "workspace",
        // The project it is about; the workspace default is workspace-level, so it is stamped with no project.
        projectKey: key || null,
        payload: { project: key, previous, wipCap: cap },
      });
    }
    return { ...view(orgId, key), previous };
  })();
}
