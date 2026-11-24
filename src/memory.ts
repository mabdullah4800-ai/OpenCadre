import { db, newId } from "./db.js";
import { emitEvent } from "./events.js";
import { maskAndCap, maskSecrets } from "./secrets.js";
import { retentionCutoff } from "./retention.js";
import { namespaceFilterSql, namespacesOf, NoNamespaceError, SHARED_NAMESPACE, writeNamespaceOf, type ScopeAgent } from "./scope.js";

/** Shared project memory: durable, queryable institutional knowledge -- architectural decisions, gotchas, "we tried
 * X and it didn't work" -- that should outlive any one conversation or agent session. Messages are ephemeral inbox
 * traffic and tasks are a work queue; this is the thing neither of them is: a searchable record any agent in the
 * org can consult later, modeled closely on tasks.ts (org-scoped table, mask-on-write-and-read, event per mutation,
 * REST + MCP surface).
 *
 * Scope call: entries are org-scoped only, not project-stamped like tasks/approvals/messages (PROJECT_ISOLATION.md).
 * Project isolation is about who can reach an agent or a piece of live coordination traffic; institutional memory is
 * closer to "what does this whole workspace know", and a first real version shouldn't take on a project-visibility
 * design it doesn't need yet. If per-project memory scoping turns out to matter, add project_key the same way
 * migration 16 did for the other tables -- nothing here forecloses it. Semantic/embedding search is a natural
 * follow-on (see docs note in README/PR description) but is explicitly not attempted here: search is a plain
 * case-insensitive SQLite LIKE over title + body, which is what "keep this to what SQLite can do plainly" means. */

export type MemoryStatus = "active" | "archived";

export interface MemoryRecord {
  id: string;
  org_id: string;
  /** The namespace (src/scope.ts namespacesOf): '' shared with every project, else the project it belongs to. */
  scope_key: string;
  title: string;
  body: string;
  tag: string | null;
  status: MemoryStatus;
  archived_reason: string | null;
  superseded_by: string | null;
  created_by_agent_id: string;
  created_by_agent_name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

type Agent = { id: string; name: string };
type Result = { ok: true; entry: MemoryRecord } | { ok: false; error: string };

export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 20_000;
export const MAX_TAG_CHARS = 60;
const MAX_PAGE = 200;
const DEFAULT_PAGE = 25;

/** Free text is agent-supplied and shown to the whole workspace; masked on write and again on every read (defense in
 * depth, matching tasks.ts), so no path can surface an unmasked secret even if a row reached the table another way. */
const maskText = (text: string | null) => (text === null ? null : maskSecrets(text));

function readRow(row: MemoryRecord): MemoryRecord {
  return { ...row, title: maskSecrets(row.title), body: maskSecrets(row.body), archived_reason: maskText(row.archived_reason) };
}

export class MemoryInputError extends Error {}

const notFound = (id: string): Result => ({ ok: false, error: `No memory entry found matching "${id}"` });

/** A viewer's namespace filter, or none for internal callers. */
const viewerFilter = (viewer?: ScopeAgent) => (viewer ? namespaceFilterSql(viewer, "scope_key") : { sql: "1 = 1", params: [] as string[] });

/** The namespace a memory write by this agent goes into; no project to write in is an input error. */
function writeNamespace(orgId: string, agent: Agent): string {
  try {
    return writeNamespaceOf({ orgId, agentId: agent.id });
  } catch (err) {
    if (err instanceof NoNamespaceError) throw new MemoryInputError(err.message);
    throw err;
  }
}
const eventProject = (namespace: string) => (namespace === SHARED_NAMESPACE ? null : namespace);

/** Whether this agent may archive or supersede an entry in `namespace`: only its own. While projects are kept apart a
 * project agent can't retire a shared note or another project's (a reader of every namespace can). */
function mayModify(orgId: string, agent: Agent, namespace: string): boolean {
  const { read, write } = namespacesOf({ orgId, agentId: agent.id });
  return read === "all" || write === namespace;
}

/** One entry the viewer can see, regardless of status -- an archived entry stays reachable by id, per the module doc
 * above. Without a viewer (internal callers), any entry in the org. */
export function getMemory(orgId: string, id: string, viewer?: ScopeAgent): MemoryRecord | null {
  const filter = viewerFilter(viewer);
  const row = db.prepare(`SELECT * FROM memory_entries WHERE id = ? AND org_id = ? AND ${filter.sql}`).get(id, orgId, ...filter.params) as MemoryRecord | undefined;
  return row ? readRow(row) : null;
}

export function createMemory(
  orgId: string,
  creator: Agent,
  input: { title: string; body: string; tag?: string | null },
): MemoryRecord {
  const title = maskAndCap(input.title?.trim() ?? "", MAX_TITLE_CHARS);
  if (!title) throw new MemoryInputError("title is required");
  const body = maskAndCap(input.body?.trim() ?? "", MAX_BODY_CHARS);
  if (!body) throw new MemoryInputError("body is required");
  const tag = input.tag?.trim() ? maskAndCap(input.tag.trim(), MAX_TAG_CHARS, "") : null;
  const namespace = writeNamespace(orgId, creator);
  const id = newId();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO memory_entries (id, org_id, scope_key, title, body, tag, created_by_agent_id, created_by_agent_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, namespace, title, body, tag, creator.id, creator.name);
    emitEvent({ orgId, type: "memory.recorded", actor: creator, subjectType: "memory", subjectId: id, projectKey: eventProject(namespace), payload: { title, ...(tag ? { tag } : {}) } });
  })();
  return getMemory(orgId, id)!;
}

interface PageResult {
  entries: MemoryRecord[];
  /** rowid to pass back as `before` to fetch the next (older) page; undefined once there's nothing further. */
  nextCursor?: number;
}

function pageQuery(
  orgId: string,
  where: string,
  params: unknown[],
  opts: { limit?: number; before?: number },
): PageResult {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE) || DEFAULT_PAGE, 1), MAX_PAGE);
  const cursorClause = opts.before !== undefined ? `AND rowid < ?` : "";
  const cursorParams = opts.before !== undefined ? [opts.before] : [];
  // Most-recent-first, like listApprovals; rowid DESC is a total order over created_at so two entries created in the
  // same second still page deterministically.
  const rows = db
    .prepare(`SELECT *, rowid AS _rowid FROM memory_entries WHERE org_id = ? AND ${where} ${cursorClause} ORDER BY rowid DESC LIMIT ?`)
    .all(orgId, ...params, ...cursorParams, limit + 1) as Array<MemoryRecord & { _rowid: number }>;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(({ _rowid, ...row }) => readRow(row as MemoryRecord));
  return { entries: page, nextCursor: hasMore ? rows[limit - 1]._rowid : undefined };
}

/** listMemory(orgId, { tag?, includeArchived?, limit?, before? }): most-recent-first, paginated. Excludes archived
 * entries by default so a stale "we tried X, it didn't work" note that's since been resolved doesn't silently look
 * current forever -- pass includeArchived to see them (still ordered the same way).
 *
 * Also excludes entries older than the workspace's plan retention window (docs/planning/PRICING.md §8
 * item 2). Those rows are HIDDEN, never deleted -- src/retention.ts holds that promise and the tests
 * assert the row survives. With no window configured (`retention_days` NULL, which is every workspace
 * on main until lane 9's plan values land) the clause is absent and behaviour is unchanged. */
export function listMemory(
  orgId: string,
  filter: { tag?: string | null; includeArchived?: boolean; limit?: number; before?: number; viewer?: ScopeAgent } = {},
): PageResult {
  const scope = viewerFilter(filter.viewer);
  const clauses: string[] = [scope.sql];
  const params: unknown[] = [...scope.params];
  if (!filter.includeArchived) clauses.push(`status = 'active'`);
  if (filter.tag) {
    clauses.push(`tag = ?`);
    params.push(filter.tag);
  }
  const cutoff = retentionCutoff(orgId);
  if (cutoff !== null) {
    clauses.push(`created_at >= ?`);
    params.push(cutoff);
  }
  return pageQuery(orgId, clauses.length ? clauses.join(" AND ") : "1 = 1", params, filter);
}

/** Case-insensitive substring search over title + body (plain SQLite LIKE -- no embeddings/vector search; see the
 * module doc). Escapes LIKE's own wildcards in the query so a literal "%" or "_" the caller typed searches literally. */
export function searchMemory(
  orgId: string,
  query: string,
  filter: { tag?: string | null; includeArchived?: boolean; limit?: number; before?: number; viewer?: ScopeAgent } = {},
): PageResult {
  const needle = query.trim();
  if (!needle) return { entries: [] };
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = `%${escaped.toLowerCase()}%`;
  const scope = viewerFilter(filter.viewer);
  const clauses = [`(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(body) LIKE ? ESCAPE '\\')`, scope.sql];
  const params: unknown[] = [like, like, ...scope.params];
  if (!filter.includeArchived) clauses.push(`status = 'active'`);
  if (filter.tag) {
    clauses.push(`tag = ?`);
    params.push(filter.tag);
  }
  return pageQuery(orgId, clauses.join(" AND "), params, filter);
}

/** Marks an entry archived with a reason. A no-op supersede target is not implied: this is the "manual, no
 * replacement exists" path. Already-archived is a no-op error, not a silent success, so a caller relying on the
 * transition (e.g. to log who archived it) can't be fooled by calling it twice. */
export function archiveMemory(orgId: string, actor: Agent, id: string, reason?: string | null): Result {
  const current = getMemory(orgId, id, { orgId, agentId: actor.id });
  if (!current) return notFound(id);
  if (!mayModify(orgId, actor, current.scope_key)) return { ok: false, error: `Memory entry "${id}" is shared with every project; only a workspace-wide agent or a person can archive it` };
  if (current.status === "archived") return { ok: false, error: `Memory entry "${id}" is already archived` };
  const archivedReason = reason?.trim() ? maskAndCap(reason.trim(), MAX_BODY_CHARS) : null;
  db.transaction(() => {
    db.prepare(
      `UPDATE memory_entries SET status = 'archived', archived_reason = ?, archived_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND org_id = ? AND status = 'active'`,
    ).run(archivedReason, id, orgId);
    emitEvent({ orgId, type: "memory.archived", actor, subjectType: "memory", subjectId: id, projectKey: eventProject(current.scope_key), payload: { title: current.title, ...(archivedReason ? { reason: maskAndCap(archivedReason, 200, "") } : {}) } });
  })();
  return { ok: true, entry: getMemory(orgId, id)! };
}

/** Creates a fresh entry and marks `id` archived + superseded_by the new entry's id, in one transaction: a stale
 * note is never left pointing at a replacement that doesn't exist. Fails the same way archiveMemory does if `id`
 * is unknown or already archived (re-superseding a superseded note would silently rewrite history). */
export function supersedeMemory(
  orgId: string,
  actor: Agent,
  id: string,
  input: { title: string; body: string; tag?: string | null },
): Result {
  const current = getMemory(orgId, id, { orgId, agentId: actor.id });
  if (!current) return notFound(id);
  if (!mayModify(orgId, actor, current.scope_key)) return { ok: false, error: `Memory entry "${id}" is shared with every project; only a workspace-wide agent or a person can supersede it` };
  if (current.status === "archived") return { ok: false, error: `Memory entry "${id}" is already archived` };
  const title = maskAndCap(input.title?.trim() ?? "", MAX_TITLE_CHARS);
  if (!title) return { ok: false, error: "title is required" };
  const body = maskAndCap(input.body?.trim() ?? "", MAX_BODY_CHARS);
  if (!body) return { ok: false, error: "body is required" };
  const tag = input.tag?.trim() ? maskAndCap(input.tag.trim(), MAX_TAG_CHARS, "") : (current.tag ?? null);
  const newId_ = newId();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO memory_entries (id, org_id, scope_key, title, body, tag, created_by_agent_id, created_by_agent_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId_, orgId, current.scope_key, title, body, tag, actor.id, actor.name);
    // The replacement stays where the note it replaces lived, so superseding never moves a note between projects.
    emitEvent({ orgId, type: "memory.recorded", actor, subjectType: "memory", subjectId: newId_, projectKey: eventProject(current.scope_key), payload: { title, ...(tag ? { tag } : {}), supersedes: id } });
    db.prepare(
      `UPDATE memory_entries SET status = 'archived', superseded_by = ?, archived_reason = ?, archived_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND org_id = ? AND status = 'active'`,
    ).run(newId_, `superseded by "${title}"`, id, orgId);
    emitEvent({ orgId, type: "memory.archived", actor, subjectType: "memory", subjectId: id, projectKey: eventProject(current.scope_key), payload: { title: current.title, supersededBy: newId_ } });
  })();
  return { ok: true, entry: getMemory(orgId, newId_)! };
}
