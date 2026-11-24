import { db } from "./db.js";
import { emitEvent } from "./events.js";

/** Per-project clearance mode stored on the hub (R4). Gates read it and combine it with their
 * local config; local config can only make the result stricter, never looser. */

export const CLEARANCE_MODES = ["off", "notify", "ask", "strict"] as const;
export type ClearanceMode = (typeof CLEARANCE_MODES)[number];

export const isClearanceMode = (value: unknown): value is ClearanceMode =>
  typeof value === "string" && (CLEARANCE_MODES as readonly string[]).includes(value);

const MAX_PROJECT_LENGTH = 200;

/** The key a project is stored under: host/owner/repo from a git remote, lowercased, with no scheme,
 * credentials, port or .git suffix. "" is the workspace default. Returns null for anything that
 * isn't a plausible remote. Mirrored in scripts/opencadre-config.mjs (normalizeProject) for gates. */
export function normalizeProject(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const key = raw.trim()
    .replace(/\\/g, "/")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^/]*@/, "")
    .replace(/^([^/:]+):\d+(?=\/)/, "$1")
    .replace(/^([^/:]+):(?!\/)/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (key.length > MAX_PROJECT_LENGTH) return null;
  if (key && (!/^[a-z0-9][a-z0-9._~/-]*$/.test(key) || key.split("/").includes(".."))) return null;
  return key;
}

interface PolicyRow {
  org_id: string;
  project: string;
  mode: ClearanceMode;
  updated_by_agent_id: string | null;
  updated_by_agent_name: string | null;
  updated_at: string;
}

export interface ClearancePolicy {
  project: string;
  mode: ClearanceMode;
  /** project: set for this project. workspace: the workspace default. default: nothing set (off, so local config decides). */
  source: "project" | "workspace" | "default";
  updatedBy: string | null;
  updatedAt: string | null;
}

type Actor = { id: string; name: string };

const selectRow = db.prepare(`SELECT * FROM clearance_policies WHERE org_id = ? AND project = ?`);

const toPolicy = (project: string, row: PolicyRow | undefined, source: ClearancePolicy["source"]): ClearancePolicy => ({
  project,
  mode: row?.mode ?? "off",
  source: row ? source : "default",
  updatedBy: row?.updated_by_agent_name ?? null,
  updatedAt: row?.updated_at ?? null,
});

/** The mode a gate in `project` must enforce at least: the project's own setting, else the workspace default, else off. */
export function getClearancePolicy(orgId: string, project: string): ClearancePolicy {
  const own = project ? (selectRow.get(orgId, project) as PolicyRow | undefined) : undefined;
  if (own) return toPolicy(project, own, "project");
  return toPolicy(project, selectRow.get(orgId, "") as PolicyRow | undefined, "workspace");
}

export function listClearancePolicies(orgId: string): ClearancePolicy[] {
  const rows = db.prepare(`SELECT * FROM clearance_policies WHERE org_id = ? ORDER BY project`).all(orgId) as PolicyRow[];
  return rows.map((row) => toPolicy(row.project, row, row.project ? "project" : "workspace"));
}

export function setClearancePolicy(orgId: string, actor: Actor, project: string, mode: ClearanceMode): ClearancePolicy {
  return db.transaction(() => {
    const previous = (selectRow.get(orgId, project) as PolicyRow | undefined)?.mode ?? null;
    db.prepare(
      `INSERT INTO clearance_policies (org_id, project, mode, updated_by_agent_id, updated_by_agent_name, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (org_id, project) DO UPDATE SET
         mode = excluded.mode, updated_by_agent_id = excluded.updated_by_agent_id,
         updated_by_agent_name = excluded.updated_by_agent_name, updated_at = excluded.updated_at`,
    ).run(orgId, project, mode, actor.id, actor.name);
    if (previous !== mode) {
      emitEvent({
        orgId, type: "clearance.policy_changed", actor, subjectType: "clearance", subjectId: project || "workspace",
        payload: { project, mode, previous },
      });
    }
    return toPolicy(project, selectRow.get(orgId, project) as PolicyRow, project ? "project" : "workspace");
  })();
}

/** Removes a setting so the project falls back to the workspace default (or the workspace to off). */
export function clearClearancePolicy(orgId: string, actor: Actor, project: string): boolean {
  return db.transaction(() => {
    const previous = (selectRow.get(orgId, project) as PolicyRow | undefined)?.mode;
    if (!previous) return false;
    db.prepare(`DELETE FROM clearance_policies WHERE org_id = ? AND project = ?`).run(orgId, project);
    emitEvent({
      orgId, type: "clearance.policy_changed", actor, subjectType: "clearance", subjectId: project || "workspace",
      payload: { project, mode: null, previous },
    });
    return true;
  })();
}
