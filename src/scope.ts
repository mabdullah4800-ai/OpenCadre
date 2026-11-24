import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "./db.js";
import { resolveProjectKey } from "./project-stamps.js";

/** Project isolation, enforcement (docs/design/PROJECT_ISOLATION.md §3.3, §3.4, §5). THE one place that decides which
 * projects an agent may see and address. Every surface filters or checks through these functions; none computes a
 * project rule of its own.
 *
 * - reach: the projects an agent may address (roster, messages, questions, replies, files it shares). `project` scope:
 *   its home plus the projects linked to it. `projects` scope: its chosen projects plus their links. `workspace` scope:
 *   everything. Reach always includes workspace-level participants (project_key NULL: people, workspace-wide named
 *   agents and the hub itself), since they belong to every project.
 * - visible: the rows an agent may read or act on (timeline, tasks, approvals, grants, files, awareness). The same sets
 *   without links, and without workspace-level rows unless the agent is workspace scope. Links share communication only.
 * - People (key_class human) and the hub's system sender are workspace scope, whatever their row says.
 *
 * Everything here is gated on the workspace setting `project_isolation`: while it is off, reach and visible are the whole
 * workspace and every check passes, which is exactly the behaviour before enforcement. Every key is resolved through
 * project_aliases. Results are cached for one request (withScopeCache), and a link, unlink or setting change invalidates
 * every cache at once, so a change takes effect on the very next check, even inside a held long-poll. */

export type Scope = "project" | "projects" | "workspace";
export interface ScopeAgent { orgId: string; agentId: string }
/** A set of project keys. `all`: every project and every workspace-level row. `workspaceLevel`: rows with no project. */
export interface ProjectSet { all: boolean; keys: string[]; workspaceLevel: boolean }

/** The hub's own voice (src/escalation.ts SYSTEM_SENDER). Not an agents row. */
export const SYSTEM_AGENT_ID = "opencadre-system";
/** Directed deliveries of these event kinds follow reach, so mail between linked projects isn't dropped (§5). */
export const MESSAGE_EVENT_TYPES = ["message.sent", "question.asked", "question.answered"] as const;
export const NOT_REACHABLE = "NOT_REACHABLE";

export class NotReachableError extends Error {
  readonly code = NOT_REACHABLE;
}

const ALL: ProjectSet = Object.freeze({ all: true, keys: [], workspaceLevel: true }) as ProjectSet;

// --- Per-request cache -------------------------------------------------------------------------------------------------
const requestCache = new AsyncLocalStorage<Map<string, unknown>>();
let generation = 0;

/** Runs fn with a fresh scope cache: REST and MCP wrap each request in one. Outside it nothing is cached. */
export function withScopeCache<T>(fn: () => T): T {
  return requestCache.run(new Map(), fn);
}

/** A link, unlink, scope or setting change: every cached answer is stale from now on. */
export function invalidateScopes(): void {
  generation++;
}

function cached<T>(key: string, compute: () => T): T {
  const store = requestCache.getStore();
  if (!store) return compute();
  const entry = `${generation}|${key}`;
  if (store.has(entry)) return store.get(entry) as T;
  const value = compute();
  store.set(entry, value);
  return value;
}

// --- Lookups -----------------------------------------------------------------------------------------------------------
const selectIsolation = db.prepare(`SELECT project_isolation FROM organizations WHERE id = ?`);
const selectAgent = db.prepare(`SELECT id, name, kind, key_class, scope, home_project FROM agents WHERE id = ? AND org_id = ?`);
const selectChosen = db.prepare(`SELECT project_key FROM agent_projects WHERE agent_id = ?`);
const selectLinks = db.prepare(
  `SELECT project_b AS key FROM project_links WHERE org_id = ? AND project_a = ? UNION SELECT project_a FROM project_links WHERE org_id = ? AND project_b = ?`,
);
const selectProjectName = db.prepare(`SELECT name FROM projects WHERE org_id = ? AND project_key = ?`);

/** Whether this workspace enforces project isolation. */
export function projectIsolationEnabled(orgId: string): boolean {
  return cached(`isolation|${orgId}`, () => (selectIsolation.get(orgId) as { project_isolation: number } | undefined)?.project_isolation === 1);
}

export type AgentScopeRow = { id: string; name?: string; kind?: string | null; key_class?: string | null; scope?: string | null; home_project?: string | null };

function agentRow(agent: ScopeAgent): AgentScopeRow | null {
  if (agent.agentId === SYSTEM_AGENT_ID) return { id: SYSTEM_AGENT_ID, key_class: "system", scope: "workspace" };
  return cached(`agent|${agent.orgId}|${agent.agentId}`, () => (selectAgent.get(agent.agentId, agent.orgId) as AgentScopeRow | undefined) ?? null);
}

const rowIsWorkspace = (row: AgentScopeRow) => row.id === SYSTEM_AGENT_ID || row.key_class === "human" || row.key_class === "system" || row.scope === "workspace";

/** True for people, the hub's system sender and workspace-scope agents. Not gated: it describes the agent itself. */
export function isWorkspaceScope(agent: ScopeAgent): boolean {
  const row = agentRow(agent);
  return Boolean(row && rowIsWorkspace(row));
}

/** The projects an agent belongs to, resolved, ignoring the setting: its home for `project` scope, its chosen projects
 * for `projects` scope. Null for a workspace-wide agent (it belongs to all of them). Unknown agents belong to none. */
function membershipOfRow(orgId: string, row: AgentScopeRow | null): string[] | null {
  if (!row) return [];
  if (rowIsWorkspace(row)) return null;
  if (row.scope === "projects") {
    return cached(`chosen|${orgId}|${row.id}`, () => {
      const keys = (selectChosen.all(row.id) as Array<{ project_key: string }>).map((r) => resolveProjectKey(orgId, r.project_key)!);
      return [...new Set(keys)];
    });
  }
  const home = resolveProjectKey(orgId, row.home_project);
  return home ? [home] : [];
}

/** An agent's own projects (see membershipOfRow), for things that aren't enforcement, like the "project" broadcast channel. */
export function ownProjectsOf(agent: ScopeAgent): string[] | null {
  return membershipOfRow(agent.orgId, agentRow(agent));
}

function linkedTo(orgId: string, key: string): string[] {
  return cached(`links|${orgId}|${key}`, () => (selectLinks.all(orgId, key, orgId, key) as Array<{ key: string }>).map((r) => r.key));
}

/** The projects an agent may address. Cached per request. */
export function reachOf(agent: ScopeAgent): ProjectSet {
  return cached(`reach|${agent.orgId}|${agent.agentId}`, () => {
    if (!projectIsolationEnabled(agent.orgId)) return ALL;
    const own = membershipOfRow(agent.orgId, agentRow(agent));
    if (own === null) return ALL;
    const keys = new Set(own);
    for (const key of own) for (const linked of linkedTo(agent.orgId, key)) keys.add(linked);
    return { all: false, keys: [...keys], workspaceLevel: true };
  });
}

/** The projects whose rows an agent may read or act on: reach without links and without workspace-level rows. Cached per request. */
export function visibleOf(agent: ScopeAgent): ProjectSet {
  return cached(`visible|${agent.orgId}|${agent.agentId}`, () => {
    if (!projectIsolationEnabled(agent.orgId)) return ALL;
    const own = membershipOfRow(agent.orgId, agentRow(agent));
    if (own === null) return ALL;
    return { all: false, keys: own, workspaceLevel: false };
  });
}

/** Whether a row stamped `projectKey` (null: workspace-level) is inside the set. */
export function inProjectSet(set: ProjectSet, projectKey: string | null | undefined): boolean {
  if (set.all) return true;
  if (projectKey === null || projectKey === undefined) return set.workspaceLevel;
  return set.keys.includes(projectKey);
}

/** Whether the agent may read or act on a row stamped `projectKey`. */
export function canSee(agent: ScopeAgent, projectKey: string | null | undefined): boolean {
  return inProjectSet(visibleOf(agent), projectKey);
}

/** A WHERE fragment and its parameters limiting `column` (a project_key stamp) to the agent's visible or reach set. */
export function projectFilterSql(agent: ScopeAgent, column: string, { mode }: { mode: "visible" | "reach" }): { sql: string; params: string[] } {
  const set = mode === "reach" ? reachOf(agent) : visibleOf(agent);
  return projectSetSql(set, column);
}

export function projectSetSql(set: ProjectSet, column: string): { sql: string; params: string[] } {
  if (set.all) return { sql: "1 = 1", params: [] };
  const parts: string[] = [];
  if (set.keys.length) parts.push(`${column} IN (${set.keys.map(() => "?").join(", ")})`);
  if (set.workspaceLevel) parts.push(`${column} IS NULL`);
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "0 = 1", params: [...set.keys] };
}

/** Whether `caller` may address `target`: the whole workspace while isolation is off; otherwise a workspace-scope caller
 * reaches everyone, everyone reaches a workspace-wide target (a person, the hub, a workspace-scope agent), and anyone
 * else must share a project with the caller's reach. */
export function isReachable(caller: ScopeAgent, target: AgentScopeRow | string): boolean {
  if (!projectIsolationEnabled(caller.orgId)) return true;
  const reach = reachOf(caller);
  if (reach.all) return true;
  const row = typeof target === "string" ? agentRow({ orgId: caller.orgId, agentId: target }) : target;
  const membership = membershipOfRow(caller.orgId, row);
  if (membership === null) return true;
  return membership.some((key) => reach.keys.includes(key));
}

// --- Namespaced shared state (goal, facts, resource locks, memory) ------------------------------------------------------
/** The namespace of workspace-shared state that every project reads. A project namespace is its project key. */
export const SHARED_NAMESPACE = "";

/** Where an agent's shared-state writes go, and which namespaces it reads, for the stores that were workspace-wide
 * before project isolation reached them (goal, facts, resource locks, memory). While isolation is off, and for a
 * workspace-scope actor (a person, the hub, a workspace-wide agent), everything is the shared namespace and every
 * namespace is readable: exactly the behaviour before. With isolation on, a project agent writes into its own project
 * and reads its own projects plus the shared namespace. Links widen communication only, so they don't widen this.
 * `write` is null for a project agent with no project: it may read shared state but has nowhere private to write. */
export function namespacesOf(agent: ScopeAgent): { write: string | null; read: string[] | "all" } {
  return cached(`namespaces|${agent.orgId}|${agent.agentId}`, () => {
    if (!projectIsolationEnabled(agent.orgId)) return { write: SHARED_NAMESPACE, read: "all" as const };
    const row = agentRow(agent);
    const own = membershipOfRow(agent.orgId, row);
    if (own === null) return { write: SHARED_NAMESPACE, read: "all" as const };
    const home = resolveProjectKey(agent.orgId, row?.home_project);
    const write = home && own.includes(home) ? home : (own[0] ?? null);
    return { write, read: [...own, SHARED_NAMESPACE] };
  });
}

/** A WHERE fragment limiting `column` (a namespace) to the ones the agent reads. */
export function namespaceFilterSql(agent: ScopeAgent, column: string): { sql: string; params: string[] } {
  const { read } = namespacesOf(agent);
  if (read === "all") return { sql: "1 = 1", params: [] };
  return { sql: `${column} IN (${read.map(() => "?").join(", ")})`, params: read };
}

/** Thrown when a project agent with no project writes shared state: it would otherwise land in every project. */
export class NoNamespaceError extends Error {
  constructor() {
    super("This agent has no project, so it can't write project state while projects are kept apart. Connect it from a project folder.");
  }
}

/** The namespace an agent writes into, or NoNamespaceError. */
export function writeNamespaceOf(agent: ScopeAgent): string {
  const { write } = namespacesOf(agent);
  if (write === null) throw new NoNamespaceError();
  return write;
}

/** A project's display name: its projects row, else the key's last segment. */
export function projectDisplayName(orgId: string, key: string | null | undefined): string | null {
  if (!key) return null;
  const row = selectProjectName.get(orgId, key) as { name: string } | undefined;
  return row?.name ?? key.replace(/^local:/i, "").split("/").pop() ?? key;
}

/** Who hears about a row in `projectKey` (escalations, clearance bypass notices): operator-role people, who are always
 * workspace scope, plus operator-role agents that can see the project. While isolation is off, every operator. */
export function operatorsFor(orgId: string, projectKey: string | null, { orderBy = "name" }: { orderBy?: "name" | "created_at" } = {}): string[] {
  const rows = db.prepare(`SELECT id FROM agents WHERE org_id = ? AND role = 'operator' AND removed_at IS NULL ORDER BY ${orderBy === "name" ? "name" : "created_at"}`)
    .all(orgId) as Array<{ id: string }>;
  return rows.map((r) => r.id).filter((id) => canSee({ orgId, agentId: id }, projectKey));
}

/** " (project Alpha)" for a notice about a row in a project, "" for a workspace-level one. */
export function projectLabel(orgId: string, projectKey: string | null): string {
  const name = projectDisplayName(orgId, projectKey);
  return name ? ` (project ${name})` : "";
}

/** Throws NotReachableError when `caller` may not address `target`. A session's name already carries its project, so its
 * error names both projects; a named agent's project isn't in its name, so its error says only that it isn't reachable
 * (§5.1, project-existence disclosure). */
export function assertReachable(caller: ScopeAgent, target: AgentScopeRow | string): void {
  if (isReachable(caller, target)) return;
  const row = typeof target === "string" ? agentRow({ orgId: caller.orgId, agentId: target }) : target;
  const name = row?.name ?? "That agent";
  if (row?.kind === "session") {
    const theirs = membershipOfRow(caller.orgId, row) ?? [];
    const mine = membershipOfRow(caller.orgId, agentRow(caller)) ?? [];
    const names = (keys: string[]) => keys.map((k) => projectDisplayName(caller.orgId, k)).join(", ") || "no project";
    throw new NotReachableError(
      `${name} is in project ${names(theirs)}, which isn't linked to ${names(mine)}. An admin can link the projects in Settings → Projects.`,
    );
  }
  throw new NotReachableError(`${name} is not reachable from this project.`);
}
