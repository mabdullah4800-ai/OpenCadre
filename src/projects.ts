import { db } from "./db.js";
import { emitEvent } from "./events.js";
import { normalizeProject } from "./clearance-policy.js";
import { disconnectAgent } from "./live.js";
import { endHeldRequests } from "./revocation.js";
// One direction only: billing never imports this module, so there is no cycle. The plan limit is asked
// here rather than checked by the caller because this is the single site where a project becomes ENABLED.
import { projectLimitRefusal } from "./billing.js";

/** Projects are opt-in (docs/CLIENT-ONBOARDING.md, "Connect a computer").
 *
 * A connected computer joins sessions only in projects its workspace has enabled; every other project on it stays
 * silent. A project is a git repository, named by its normalized remote (host/owner/repo) so the same repo on two
 * computers is one project, or `local:<folder>` when it has no remote. A row exists only because someone MEANT it:
 * `opencadre connect` run in that folder (enable-current) or an operator adding the key in the console. A session in a
 * folder nobody enabled gets 403 project_not_enabled and leaves no trace -- no row, no name, no timestamp -- so the hub
 * never learns which folders a computer has open (Codex-OpenCadre-8160's no-sightings plan, thread 4c76be48). */

export const PROJECT_NAME_HEADER = "x-opencadre-project-name";
export const PROJECT_NOT_ENABLED = "project_not_enabled";
export const PROJECT_KEY_ERROR = "projectKey must be a git remote key such as github.com/owner/repo, or local:<folder>";
const MAX_KEY_LENGTH = 200;
/** last_seen_at is refreshed at most this often per ENABLED project: every device request checks it. */
const SEEN_REFRESH_MS = 60_000;

export class ProjectError extends Error {
  /** 402 is the PLAN's refusal, not the request's: the workspace is at its project limit, which is a
   * billing fact about the workspace rather than something wrong with what the caller sent. It travels as
   * a ProjectError so the callers that already map this type keep working unchanged -- both routes do
   * `res.status(err.status).json({ error: err.message })` and neither branches on the value. */
  constructor(message: string, readonly status: 400 | 404 | 402) {
    super(message);
  }
}

/** A folder name for display: the last path segment, reduced to [A-Za-z0-9._-], at most 40 characters. */
export function sanitizeProject(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const segment = raw.split(/[\\/]/).filter((s) => s.trim()).pop() ?? "";
  const clean = segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 40).replace(/[-.]+$/, "");
  return clean || null;
}

/** The project key a request or an operator names, or null when it isn't one. Three forms:
 * - a git remote in any spelling, normalized exactly like normalizeProject (github.com/owner/repo);
 * - `local:<folder>` for a repository without a remote (the folder name sanitized like a session name);
 * - a bare folder name, which is what clients before remote keys sent (the key of this PC's live "OpenCadre" chats).
 * Keep in step with projectIdentity in scripts/opencadre-config.mjs. */
export function projectKeyOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_KEY_LENGTH) return null;
  const local = value.match(/^local:(.*)$/i);
  if (local) {
    const name = sanitizeProject(local[1]);
    return name ? `local:${name}` : null;
  }
  if (/[^\x21-\x7e]/.test(value)) return null;
  if (!/[/:@\\]/.test(value)) return sanitizeProject(value);
  const key = normalizeProject(value);
  return key && key.includes("/") ? key : null;
}

/** The display name: the client's own name for it when given (the repo's name as spelled in its remote), else the
 * key's last segment. */
export function projectNameFor(key: string, rawName?: unknown): string {
  return sanitizeProject(rawName) ?? sanitizeProject(key.replace(/^local:/i, "")) ?? "Project";
}

type ProjectRow = {
  org_id: string; project_key: string; name: string; enabled: number; first_seen_at: string | null; last_seen_at: string | null;
  enabled_at: string | null; enabled_by_agent_name: string | null;
};

export interface ProjectView {
  projectKey: string;
  name: string;
  enabled: boolean;
  sessionCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  enabledAt: string | null;
  enabledByAgentName: string | null;
}

const selectProject = db.prepare(`SELECT * FROM projects WHERE org_id = ? AND project_key = ?`);
const countLiveSessions = db.prepare(
  `SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND project = ? AND kind = 'session' AND ended_at IS NULL AND removed_at IS NULL`,
);

/** Whether this project is enabled for the workspace. READ-ONLY for every project that isn't: a folder nobody enabled
 * is never inserted and never timestamped, so asking cannot record it. Only an enabled project's last_seen_at is
 * refreshed (the console shows it as "last used"). A missing or invalid key is never enabled. Runs inside the caller's
 * transaction. */
export function isProjectEnabled(orgId: string, key: string | null, nowMs = Date.now()): boolean {
  if (!key) return false;
  const row = selectProject.get(orgId, key) as ProjectRow | undefined;
  if (row?.enabled !== 1) return false;
  const seenMs = row.last_seen_at ? Date.parse(row.last_seen_at) : NaN;
  if (!Number.isFinite(seenMs) || nowMs - seenMs >= SEEN_REFRESH_MS) {
    const now = new Date(nowMs).toISOString();
    db.prepare(`UPDATE projects SET last_seen_at = ?, first_seen_at = COALESCE(first_seen_at, ?) WHERE org_id = ? AND project_key = ?`).run(now, now, orgId, key);
  }
  return true;
}

/** GET /v1/devices/projects: the keys a connected computer may name, exactly the rows isProjectEnabled answers true
 * for. The client keeps this as its local allowlist and sends nothing folder-bearing for any other folder. */
export function enabledProjectKeys(orgId: string): string[] {
  return (db.prepare(`SELECT project_key FROM projects WHERE org_id = ? AND enabled = 1 ORDER BY project_key`).all(orgId) as Array<{ project_key: string }>)
    .map((r) => r.project_key);
}

function view(row: ProjectRow): ProjectView {
  return {
    projectKey: row.project_key, name: row.name, enabled: row.enabled === 1,
    sessionCount: (countLiveSessions.get(row.org_id, row.project_key) as { n: number }).n,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, enabledAt: row.enabled_at, enabledByAgentName: row.enabled_by_agent_name,
  };
}

/** A folder-name key from a client before remote keys (e.g. "OpenCadre"): no "/" and not local:<folder>. */
const isLegacyKey = (key: string) => !key.includes("/") && !/^local:/i.test(key);

/** GET /v1/org/projects: enabled projects first, then disabled ones (added or enabled once, then switched off), each by name.
 *
 * One row per project: a legacy folder-name key is left out when an enabled remote key ("/" in it) of the same name
 * (case-insensitive) exists in this workspace and the legacy key has no live sessions. Its row stays in the table,
 * since an old client may still send that key. */
export function listProjects(orgId: string): ProjectView[] {
  const rows = db.prepare(`SELECT * FROM projects WHERE org_id = ?`).all(orgId) as ProjectRow[];
  const views = rows.map(view);
  const enabledRemoteNames = new Set(views.filter((p) => p.enabled && p.projectKey.includes("/")).map((p) => p.name.toLowerCase()));
  return views
    .filter((p) => !(isLegacyKey(p.projectKey) && p.sessionCount === 0 && enabledRemoteNames.has(p.name.toLowerCase())))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.projectKey.localeCompare(b.projectKey));
}

/** Enables or disables one project. An operator may enable a key no computer has used yet (it is created); disabling a project this
 * workspace doesn't have is a 404. `by` names who did it: an operator agent, or a device enabling its own chat's project. */
export function setProjectEnabled(
  orgId: string,
  by: { actor: { id: string; name: string } | null; name: string; via: "operator" | "connect"; deviceId?: string },
  rawKey: unknown,
  enabled: unknown,
  rawName?: unknown,
): ProjectView {
  const key = projectKeyOf(rawKey);
  if (!key) throw new ProjectError(PROJECT_KEY_ERROR, 400);
  const name = rawName === undefined || rawName === null ? null : sanitizeProject(rawName);
  if (rawName !== undefined && rawName !== null && !name) throw new ProjectError("name must contain letters or digits", 400);
  // A RENAME ONLY: a name with no `enabled` changes the name and nothing else. Before this a rename had to restate
  // `enabled`, so a console form opened before another operator switched the project re-sent the old value: it
  // reversed that switch, and a stale false also cut the project's live sessions off (Codex-OpenCadre-f46c on 5511d8f).
  if (enabled === undefined && name) {
    const row = selectProject.get(orgId, key) as ProjectRow | undefined;
    if (!row) throw new ProjectError("project not found", 404);
    if (name !== row.name) db.prepare(`UPDATE projects SET name = ? WHERE org_id = ? AND project_key = ?`).run(name, orgId, key);
    return view(selectProject.get(orgId, key) as ProjectRow);
  }
  if (typeof enabled !== "boolean") throw new ProjectError("enabled must be true or false", 400);
  // THE PLAN'S PROJECT LIMIT, and it fires only on a TRANSITION TO ENABLED -- not on a rename, not on a
  // re-enable of something already on, and not on a disable. Those are the cases where the count does not
  // move, and refusing them would refuse a workspace for an act that costs it nothing.
  //
  // This is the ONLY site where a project can become ENABLED (both `via: "operator"` from the console route
  // and `via: "connect"` from a device enabling its own chat's project come through here), which is why one
  // gate covers both. `countEnabledProjects` counts exactly what this creates, so the refusal's remedy --
  // "disable a project" -- reduces the same number it measured.
  //
  // Checked BEFORE the transaction opens, so a refusal performs no write at all.
  if (enabled === true) {
    const current = selectProject.get(orgId, key) as ProjectRow | undefined;
    if (current?.enabled !== 1) {
      const refusal = projectLimitRefusal(orgId);
      if (refusal) throw new ProjectError(refusal.body.error, 402);
    }
  }
  const result = db.transaction(() => {
    const row = selectProject.get(orgId, key) as ProjectRow | undefined;
    if (!row && !enabled) throw new ProjectError("project not found", 404);
    const now = new Date().toISOString();
    if (!row) {
      db.prepare(`INSERT INTO projects (org_id, project_key, name, enabled, enabled_at, enabled_by_agent_name) VALUES (?, ?, ?, 1, ?, ?)`)
        .run(orgId, key, name ?? projectNameFor(key), now, by.name);
    } else {
      if (name && name !== row.name) db.prepare(`UPDATE projects SET name = ? WHERE org_id = ? AND project_key = ?`).run(name, orgId, key);
      if ((row.enabled === 1) !== enabled) {
        db.prepare(`UPDATE projects SET enabled = ?, enabled_at = ?, enabled_by_agent_name = ? WHERE org_id = ? AND project_key = ?`)
          .run(enabled ? 1 : 0, enabled ? now : null, enabled ? by.name : null, orgId, key);
      }
    }
    if (!row || (row.enabled === 1) !== enabled) {
      emitEvent({
        orgId, type: enabled ? "project.enabled" : "project.disabled", actor: by.actor, subjectType: "project", subjectId: key,
        payload: { projectKey: key, name: name ?? row?.name ?? projectNameFor(key), via: by.via, ...(by.deviceId ? { deviceId: by.deviceId } : {}) },
      });
    }
    return view(selectProject.get(orgId, key) as ProjectRow);
  })();
  if (!enabled) cutOffProjectSessions(orgId, key);
  return result;
}

/** A disabled project's sessions are refused on their next request (src/devices.ts); this also ends what they already
 * hold open: `/live` sockets and long-polls (message, events and approval waits), the same way revoking a device does.
 * Every session agent whose project is this key counts, ended or not, so a request an ended session still holds can't
 * outlive the switch. Named agents have no project and are untouched. */
function cutOffProjectSessions(orgId: string, key: string): void {
  const sessions = db.prepare(`SELECT id FROM agents WHERE org_id = ? AND kind = 'session' AND project = ?`).all(orgId, key) as Array<{ id: string }>;
  for (const s of sessions) {
    disconnectAgent(s.id, "OpenCadre isn't enabled for this project");
    endHeldRequests(s.id, 403, PROJECT_NOT_ENABLED);
  }
}
