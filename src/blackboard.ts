import { db } from "./db.js";
import { emitEvent } from "./events.js";
import { maskSecrets } from "./secrets.js";
import { namespaceFilterSql, namespacesOf, NoNamespaceError, SHARED_NAMESPACE, writeNamespaceOf, type ScopeAgent } from "./scope.js";

/** Shared org-wide fact store (Stage 2 retro finding: "a shared blackboard/world-model replacing
 * N^2 point-to-point messaging"). A fact two or more agents need only used to live in whoever's
 * inbox it was sent to; every other agent had to re-ask or re-derive it, and a stale answer looked
 * identical to a fresh one. One row per (org, key) -- not a message history -- so "what's the
 * answer right now" is always a single read, the same shape goals.ts already uses for the fleet's
 * one current goal, generalized to arbitrary keys.
 *
 * version is optimistic concurrency, not an audit trail: set_fact can pass expectedVersion so two
 * agents racing to update the same disputed fact don't silently clobber each other. Every write
 * still emits an event (blackboard.fact_set/fact_deleted), so the full history is recoverable from
 * the tamper-evident timeline even though only the latest value is stored here.
 *
 * One row per (org, namespace, key) (src/scope.ts namespacesOf): while projects are kept apart, a project agent
 * reads its own project's facts and the shared ones, and sets or deletes only its own project's. With isolation off
 * everything is the shared namespace, exactly as before. */

export interface BlackboardFact {
  org_id: string;
  /** The namespace: '' shared with every project, else the project key. */
  scope_key: string;
  key: string;
  value: string;
  version: number;
  set_by_agent_id: string;
  set_by_agent_name: string;
  set_at: string;
  updated_at: string;
}

type Agent = { id: string; name: string };
type SetResult = { ok: true; fact: BlackboardFact } | { ok: false; error: string; current?: BlackboardFact };

export const MAX_KEY_CHARS = 200;
export const MAX_VALUE_CHARS = 10_000;

export class BlackboardInputError extends Error {}

function readRow(row: BlackboardFact): BlackboardFact {
  return { ...row, value: maskSecrets(row.value) };
}

/** The namespace a fact write or delete by this agent touches. An agent with nowhere to write gets the same input
 * error every other bad fact write gets, so REST and MCP answer it as a refusal, not a server error. */
function writeNamespace(orgId: string, agent: Agent): string {
  try {
    return writeNamespaceOf({ orgId, agentId: agent.id });
  } catch (err) {
    if (err instanceof NoNamespaceError) throw new BlackboardInputError(err.message);
    throw err;
  }
}
const eventProject = (namespace: string) => (namespace === SHARED_NAMESPACE ? null : namespace);
/** Without a viewer (internal callers): the shared namespace only. */
const readFilter = (viewer?: ScopeAgent) => (viewer ? namespaceFilterSql(viewer, "scope_key") : { sql: "scope_key = ''", params: [] as string[] });

/** The fact a reader sees for `key`: its own project's when it has one, else the shared one. A reader of every
 * namespace (isolation off, a workspace-scope actor) gets the shared one first, then the most recently updated. */
export function getFact(orgId: string, key: string, viewer?: ScopeAgent): BlackboardFact | null {
  const filter = readFilter(viewer);
  const own = (viewer ? namespacesOf(viewer).write : null) ?? SHARED_NAMESPACE;
  const row = db.prepare(
    `SELECT * FROM blackboard_facts_ns WHERE org_id = ? AND key = ? AND ${filter.sql}
      ORDER BY CASE WHEN scope_key = ? THEN 0 WHEN scope_key = '' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1`,
  ).get(orgId, key, ...filter.params, own) as BlackboardFact | undefined;
  return row ? readRow(row) : null;
}

/** Every fact the reader can see, key-ascending. `prefix` narrows to keys starting with that string (e.g.
 * "deploy." to see just the deploy-related facts), the same convention a namespaced config uses. A key set both in the
 * reader's project and shared appears twice, each with its scope_key. */
export function listFacts(orgId: string, opts: { prefix?: string } = {}, viewer?: ScopeAgent): BlackboardFact[] {
  const filter = readFilter(viewer);
  const rows = opts.prefix
    ? (db.prepare(`SELECT * FROM blackboard_facts_ns WHERE org_id = ? AND ${filter.sql} AND key LIKE ? || '%' ESCAPE '\\' ORDER BY key, scope_key`).all(orgId, ...filter.params, opts.prefix.replace(/[%_\\]/g, "\\$&")) as BlackboardFact[])
    : (db.prepare(`SELECT * FROM blackboard_facts_ns WHERE org_id = ? AND ${filter.sql} ORDER BY key, scope_key`).all(orgId, ...filter.params) as BlackboardFact[]);
  return rows.map(readRow);
}

/** Sets a fact in the setter's namespace, creating it if new. Without expectedVersion this always wins (last-write-wins,
 * the same trust model as setAgentStatus/setGoal). With expectedVersion, the write only applies if the
 * fact's current version matches -- an agent that read version 3 and wants to update it can prove
 * nobody else changed it since. A mismatch returns the CURRENT fact (not an error message
 * describing it) so the caller can see exactly what changed under them and decide whether to retry. */
export function setFact(orgId: string, setter: Agent, key: string, value: string, opts: { expectedVersion?: number } = {}): SetResult {
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new BlackboardInputError("key is required");
  if (trimmedKey.length > MAX_KEY_CHARS) throw new BlackboardInputError(`key must be ${MAX_KEY_CHARS} characters or fewer`);
  const maskedValue = maskSecrets(value);
  if (maskedValue.length > MAX_VALUE_CHARS) throw new BlackboardInputError(`value must be ${MAX_VALUE_CHARS} characters or fewer`);
  const namespace = writeNamespace(orgId, setter);

  return db.transaction((): SetResult => {
    const existing = db.prepare(`SELECT * FROM blackboard_facts_ns WHERE org_id = ? AND scope_key = ? AND key = ?`).get(orgId, namespace, trimmedKey) as BlackboardFact | undefined;
    if (opts.expectedVersion !== undefined && existing && existing.version !== opts.expectedVersion) {
      return { ok: false, error: `expectedVersion ${opts.expectedVersion} is stale; current version is ${existing.version}`, current: readRow(existing) };
    }
    if (opts.expectedVersion !== undefined && !existing) {
      return { ok: false, error: `expectedVersion ${opts.expectedVersion} given, but "${trimmedKey}" doesn't exist yet` };
    }
    db.prepare(
      `INSERT INTO blackboard_facts_ns (org_id, scope_key, key, value, version, set_by_agent_id, set_by_agent_name, set_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(org_id, scope_key, key) DO UPDATE SET
         value = excluded.value, version = blackboard_facts_ns.version + 1,
         set_by_agent_id = excluded.set_by_agent_id, set_by_agent_name = excluded.set_by_agent_name,
         set_at = excluded.set_at, updated_at = excluded.updated_at`,
    ).run(orgId, namespace, trimmedKey, maskedValue, setter.id, setter.name);
    const fact = readRow(db.prepare(`SELECT * FROM blackboard_facts_ns WHERE org_id = ? AND scope_key = ? AND key = ?`).get(orgId, namespace, trimmedKey) as BlackboardFact);
    emitEvent({
      orgId, type: "blackboard.fact_set", actor: setter, subjectType: "blackboard_fact", subjectId: trimmedKey,
      projectKey: eventProject(namespace), payload: { key: trimmedKey, value: maskedValue, version: fact.version },
    });
    return { ok: true, fact };
  })();
}

/** Deletes the fact in the deleter's own namespace only: a project agent can't delete a shared fact or another
 * project's. */
export function deleteFact(orgId: string, deleter: Agent, key: string): { ok: true } | { ok: false; error: string } {
  let namespace: string;
  try {
    namespace = writeNamespace(orgId, deleter);
  } catch (err) {
    if (err instanceof BlackboardInputError) return { ok: false, error: err.message };
    throw err;
  }
  const changed = db.prepare(`DELETE FROM blackboard_facts_ns WHERE org_id = ? AND scope_key = ? AND key = ?`).run(orgId, namespace, key).changes;
  if (changed === 0) return { ok: false, error: `No fact found for key "${key}"` };
  emitEvent({ orgId, type: "blackboard.fact_deleted", actor: deleter, subjectType: "blackboard_fact", subjectId: key, projectKey: eventProject(namespace), payload: { key } });
  return { ok: true };
}
