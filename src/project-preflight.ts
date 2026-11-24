// Project isolation pre-flight (docs/design/PROJECT_ISOLATION.md §7, item 3). READ-ONLY: it only runs SELECTs.
//
// For each workspace it lists every enabled project with its live agents and how many rows are stamped with it, and it
// flags a repository whose live agents use more than one project key (e.g. the legacy "OpenCadre" folder key next to
// github.com/mabdullah4800-ai/opencadre, with no alias joining them). Enforcement must not be switched on while anything is
// flagged: one fleet would split into two halves that can't see each other.
//
// One copy, used by the hub (switching project_isolation on, src/project-isolation.ts) and by the ops script
// (scripts/project-isolation-preflight.mjs, which imports this file directly). So this file has no runtime imports and
// uses only type annotations Node can strip: no enums, namespaces or parameter properties.
import type Database from "better-sqlite3";

/** The tables whose rows carry a project_key stamp (src/migrations.ts, STAMPED_TABLES). */
export const PREFLIGHT_TABLES = ["messages", "tasks", "approvals", "approval_grants", "files", "events"] as const;
type Counts = Record<(typeof PREFLIGHT_TABLES)[number], number>;

export interface PreflightAgent { name: string; kind: string; scope: string }
export interface PreflightProject { projectKey: string; name: string; aliases: string[]; liveAgents: PreflightAgent[]; stampedRows: Counts }
export interface PreflightSplit { name: string; keys: Array<{ projectKey: string; liveAgents: string[] }> }
export interface PreflightWorkspace {
  orgId: string;
  name: string;
  projects: PreflightProject[];
  workspaceLevel: { liveAgents: PreflightAgent[]; stampedRows: Counts };
  splits: PreflightSplit[];
}
export interface PreflightReport { workspaces: PreflightWorkspace[]; flagged: boolean }

/** A folder-name key from a client before remote keys: no "/" and not local:<folder> (src/migrations.ts). */
const isLegacyKey = (key: string) => !key.includes("/") && !/^local:/i.test(key);
/** The name a key is known by when no projects row names it: the last path segment, as projectNameFor does. */
const nameOfKey = (key: string) => key.replace(/^local:/i, "").split("/").pop() ?? key;
const zero = (): Counts => ({ messages: 0, tasks: 0, approvals: 0, approval_grants: 0, files: 0, events: 0 });

/** The pre-flight report for one workspace, or for every workspace when orgId is omitted. Reads only. */
export function projectIsolationPreflight(db: Database.Database, { orgId }: { orgId?: string } = {}): PreflightReport {
  const orgs = (orgId
    ? db.prepare(`SELECT id, name FROM organizations WHERE id = ?`).all(orgId)
    : db.prepare(`SELECT id, name FROM organizations ORDER BY created_at, id`).all()) as Array<{ id: string; name: string }>;
  const workspaces = orgs.map((org) => workspaceReport(db, org));
  return { workspaces, flagged: workspaces.some((w) => w.splits.length > 0) };
}

type LiveRow = { id: string; name: string; kind: string; scope: string; key_class: string; home_project: string | null; project: string | null; key: string | null };

function workspaceReport(db: Database.Database, org: { id: string; name: string }): PreflightWorkspace {
  const aliasRows = db.prepare(`SELECT alias_key, project_key FROM project_aliases WHERE org_id = ?`).all(org.id) as Array<{ alias_key: string; project_key: string }>;
  const aliases = new Map(aliasRows.map((r) => [r.alias_key, r.project_key]));
  const resolve = (key: string | null) => (key ? aliases.get(key) ?? key : null);
  const projects = db.prepare(`SELECT project_key, name, enabled FROM projects WHERE org_id = ?`).all(org.id) as Array<{ project_key: string; name: string; enabled: number }>;
  const nameOf = new Map(projects.map((p) => [p.project_key, p.name]));

  // A live agent: not removed, and for a session not ended. Its project is its home (a session's), resolved.
  const live = (db.prepare(
    `SELECT id, name, kind, scope, key_class, home_project, project FROM agents
     WHERE org_id = ? AND removed_at IS NULL AND NOT (kind = 'session' AND ended_at IS NOT NULL) ORDER BY name`,
  ).all(org.id) as Array<Omit<LiveRow, "key">>).map((a): LiveRow => ({ ...a, key: resolve(a.home_project ?? (a.kind === "session" ? a.project : null)) }));
  const agentView = (a: LiveRow): PreflightAgent => ({ name: a.name, kind: a.kind, scope: a.scope });

  const counts = new Map<string, Counts>();
  for (const table of PREFLIGHT_TABLES) {
    const rows = db.prepare(`SELECT project_key, COUNT(*) AS n FROM ${table} WHERE org_id = ? GROUP BY project_key`).all(org.id) as Array<{ project_key: string | null; n: number }>;
    for (const row of rows) {
      const key = row.project_key ?? "";
      const entry = counts.get(key) ?? zero();
      entry[table] = row.n;
      counts.set(key, entry);
    }
  }

  const enabled = projects
    .filter((p) => p.enabled === 1 && resolve(p.project_key) === p.project_key)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.project_key.localeCompare(b.project_key))
    .map((p): PreflightProject => ({
      projectKey: p.project_key,
      name: p.name,
      aliases: [...aliases].filter(([, target]) => target === p.project_key).map(([alias]) => alias).sort(),
      liveAgents: live.filter((a) => a.key === p.project_key).map(agentView),
      stampedRows: counts.get(p.project_key) ?? zero(),
    }));

  // A split: one repository name in use by live agents under more than one resolved key, where at least one of them is
  // a legacy folder key or a local:<folder> key (two remote keys of the same name are two different repositories).
  const keysByName = new Map<string, Map<string, string[]>>();
  for (const agent of live) {
    if (!agent.key) continue;
    const name = (nameOf.get(agent.key) ?? nameOfKey(agent.key)).toLowerCase();
    const entry = keysByName.get(name) ?? new Map<string, string[]>();
    entry.set(agent.key, [...(entry.get(agent.key) ?? []), agent.name]);
    keysByName.set(name, entry);
  }
  const splits = [...keysByName]
    .filter(([, keys]) => keys.size > 1 && [...keys.keys()].some((k) => isLegacyKey(k) || /^local:/i.test(k)))
    .map(([name, keys]): PreflightSplit => ({
      name,
      keys: [...keys].map(([projectKey, agents]) => ({ projectKey, liveAgents: agents })).sort((a, b) => a.projectKey.localeCompare(b.projectKey)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    orgId: org.id,
    name: org.name,
    projects: enabled,
    workspaceLevel: { liveAgents: live.filter((a) => !a.key).map(agentView), stampedRows: counts.get("") ?? zero() },
    splits,
  };
}

/** The report as aligned, readable text. */
export function formatPreflight(report: PreflightReport): string {
  const lines: string[] = [];
  const rows = (stamped: Counts) => PREFLIGHT_TABLES.map((t) => `${t} ${stamped[t]}`).join(", ");
  const agents = (list: PreflightAgent[]) => (list.length ? list.map((a) => `${a.name} (${a.kind}, ${a.scope})`).join(", ") : "none");
  for (const w of report.workspaces) {
    lines.push(`Workspace ${w.name} (${w.orgId})`);
    if (!w.projects.length) lines.push("  No enabled projects.");
    for (const p of w.projects) {
      lines.push(`  ${p.name}  ${p.projectKey}${p.aliases.length ? `  (aliases: ${p.aliases.join(", ")})` : ""}`);
      lines.push(`    live agents   ${agents(p.liveAgents)}`);
      lines.push(`    stamped rows  ${rows(p.stampedRows)}`);
    }
    lines.push("  Workspace-level (no project)");
    lines.push(`    live agents   ${agents(w.workspaceLevel.liveAgents)}`);
    lines.push(`    stamped rows  ${rows(w.workspaceLevel.stampedRows)}`);
    if (w.splits.length) {
      lines.push("  SPLIT: a repository is in use under more than one project key. Don't enable enforcement until it is one key.");
      for (const split of w.splits) {
        lines.push(`    ${split.name}`);
        for (const k of split.keys) lines.push(`      ${k.projectKey}  live: ${k.liveAgents.join(", ")}`);
      }
    } else {
      lines.push("  OK: no repository is split across project keys.");
    }
    lines.push("");
  }
  lines.push(report.flagged ? "Pre-flight FAILED: resolve the splits above first." : "Pre-flight passed. Nothing was changed.");
  return lines.join("\n");
}
