// No sightings (Codex-OpenCadre-8160's plan, thread 4c76be48): the hub no longer records folders a computer merely had
// open (src/projects.ts isProjectEnabled). This finds, and on request forgets, the ones it recorded before that change.
//
// It is NOT a migration: migrations stay additive (tests/migrations.test.ts), and deleting rows from a production
// database is an operator's decision. scripts/forget-project-sightings.mjs runs it, listing by default and deleting only
// with --apply. Like src/project-preflight.ts, this file has no runtime imports, so that script can load it directly.
import type Database from "better-sqlite3";

/** A projects row is a SIGHTING only when nothing shows anyone ever meant or used that project:
 *   - it is disabled, and its key is a remote or local:<folder> key (a legacy folder-name key stays: an old client may
 *     still send it, and aliases resolve through it);
 *   - no agent was ever created in it (a refused session creates none, so any agent -- live or ended -- means it was
 *     enabled once), and no agent lists it among its projects;
 *   - no alias names it from either side, no link, no clearance policy;
 *   - no event was ever about it (project.enabled / project.disabled) or stamped with it, and no message, task,
 *     approval, grant or file is stamped with it;
 *   - no goal, fact, lock or memory lives in its namespace.
 * Anything else is a project someone switched off, which keeps its row, its name and its history. Every clause is
 * scoped to the row's own workspace: a reference in another workspace keeps nothing. */
export const SIGHTING_WHERE = `
projects.enabled = 0
  AND (projects.project_key LIKE '%/%' OR lower(projects.project_key) LIKE 'local:%')
  AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.org_id = projects.org_id AND (a.project = projects.project_key OR a.home_project = projects.project_key))
  AND NOT EXISTS (SELECT 1 FROM agent_projects ap JOIN agents a ON a.id = ap.agent_id WHERE a.org_id = projects.org_id AND ap.project_key = projects.project_key)
  AND NOT EXISTS (SELECT 1 FROM project_aliases pa WHERE pa.org_id = projects.org_id AND (pa.alias_key = projects.project_key OR pa.project_key = projects.project_key))
  AND NOT EXISTS (SELECT 1 FROM project_links pl WHERE pl.org_id = projects.org_id AND (pl.project_a = projects.project_key OR pl.project_b = projects.project_key))
  AND NOT EXISTS (SELECT 1 FROM clearance_policies cp WHERE cp.org_id = projects.org_id AND cp.project = projects.project_key)
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.org_id = projects.org_id AND (e.project_key = projects.project_key OR (e.subject_type = 'project' AND e.subject_id = projects.project_key)))
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.org_id = projects.org_id AND (m.project_key = projects.project_key OR m.to_project_key = projects.project_key))
  AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.org_id = projects.org_id AND t.project_key = projects.project_key)
  AND NOT EXISTS (SELECT 1 FROM approvals ap2 WHERE ap2.org_id = projects.org_id AND ap2.project_key = projects.project_key)
  AND NOT EXISTS (SELECT 1 FROM approval_grants g WHERE g.org_id = projects.org_id AND g.project_key = projects.project_key)
  AND NOT EXISTS (SELECT 1 FROM files f WHERE f.org_id = projects.org_id AND f.project_key = projects.project_key)
  AND NOT EXISTS (SELECT 1 FROM goals_ns gn WHERE gn.org_id = projects.org_id AND gn.scope_key = projects.project_key)
  AND NOT EXISTS (SELECT 1 FROM blackboard_facts_ns fn WHERE fn.org_id = projects.org_id AND fn.scope_key = projects.project_key)
  AND NOT EXISTS (SELECT 1 FROM resource_locks_ns ln WHERE ln.org_id = projects.org_id AND ln.scope_key = projects.project_key)
  AND NOT EXISTS (SELECT 1 FROM memory_entries me WHERE me.org_id = projects.org_id AND me.scope_key = projects.project_key)
`;

export interface ProjectSighting {
  orgId: string;
  projectKey: string;
  name: string;
}

const orgFilter = (orgId?: string) => (orgId ? { sql: " AND projects.org_id = ?", args: [orgId] } : { sql: "", args: [] });

/** The sightings in one workspace, or in every workspace when orgId is omitted. Reads only. */
export function listProjectSightings(db: Database.Database, { orgId }: { orgId?: string } = {}): ProjectSighting[] {
  const org = orgFilter(orgId);
  return (db.prepare(`SELECT org_id, project_key, name FROM projects WHERE ${SIGHTING_WHERE}${org.sql} ORDER BY org_id, project_key`)
    .all(...org.args) as Array<{ org_id: string; project_key: string; name: string }>)
    .map((r) => ({ orgId: r.org_id, projectKey: r.project_key, name: r.name }));
}

/** Deletes the sightings and returns exactly the rows it deleted. The list and the delete run in one immediate
 * transaction, so a row that gains a reference in between is neither reported nor deleted. */
export function forgetProjectSightings(db: Database.Database, { orgId }: { orgId?: string } = {}): ProjectSighting[] {
  const org = orgFilter(orgId);
  const run = db.transaction(() => {
    const found = listProjectSightings(db, { orgId });
    const removed = db.prepare(`DELETE FROM projects WHERE ${SIGHTING_WHERE}${org.sql}`).run(...org.args).changes;
    if (removed !== found.length) throw new Error(`listed ${found.length} sightings but the delete matched ${removed}; nothing was deleted`);
    return found;
  });
  return run.immediate();
}
