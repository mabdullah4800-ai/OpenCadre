import { db } from "./db.js";
import { emitEvent } from "./events.js";
import { isReachable, namespaceFilterSql, namespacesOf, NoNamespaceError, SHARED_NAMESPACE, writeNamespaceOf, type ScopeAgent } from "./scope.js";

/** Named-resource mutex (design retro finding #4): the hub can't provision a git worktree on a
 * remote agent's own machine -- that's client-side, out of a multi-tenant server's reach. This is
 * the buildable version: a leased claim on an opaque, caller-defined string (a path, a branch name,
 * a lockfile, anything two agents might collide on), same shape as tasks.ts's leased task claims --
 * a lease that isn't renewed expires, so a crashed or abandoned agent can't hold a resource hostage
 * forever. Every mutation is a single conditional UPSERT, so two agents racing for the same
 * resource_key can't both win. */

export interface ResourceLockRecord {
  org_id: string;
  /** The namespace: '' shared with every project, else the project key. A key is locked per namespace, so projects kept
   * apart can't see, probe or take over each other's locks. */
  scope_key: string;
  resource_key: string;
  holder_agent_id: string;
  holder_agent_name: string;
  note: string | null;
  acquired_at: string;
  lease_expires_at: string;
  lease_expiry_emitted_at: string | null;
}

type Agent = { id: string; name: string };
/** A successful claim or renew always says what happened to the lease: `leaseChanged` is whether its expiry moved, and
 * `leaseExpiresAt` is the expiry it has now (the same value as `lock.lease_expires_at`). */
type LeaseOutcome = { lock: ResourceLockRecord; leaseChanged: boolean; leaseExpiresAt: string };
type Failure = { ok: false; error: string };
/** `alreadyHeld` is true when the caller already held an unexpired lease on the key: nothing was taken over, and the
 * lease moved only if the requested one ends later. */
export type ClaimResult = ({ ok: true; alreadyHeld: boolean } & LeaseOutcome) | Failure;
export type RenewResult = ({ ok: true } & LeaseOutcome) | Failure;

export const DEFAULT_LOCK_LEASE_SECONDS = 30 * 60;
const MAX_LOCK_LEASE_SECONDS = 24 * 60 * 60;
export const MAX_RESOURCE_KEY_CHARS = 500;

const nowIso = () => new Date().toISOString();

function leaseExpiry(leaseSeconds: number): string | null {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > MAX_LOCK_LEASE_SECONDS) return null;
  return new Date(Date.now() + leaseSeconds * 1000).toISOString();
}

function getLock(orgId: string, namespace: string, resourceKey: string): ResourceLockRecord | undefined {
  return db.prepare(`SELECT * FROM resource_locks_ns WHERE org_id = ? AND scope_key = ? AND resource_key = ?`).get(orgId, namespace, resourceKey) as ResourceLockRecord | undefined;
}

/** The namespace this agent's lock operations use; no project to lock in is an input error, like a bad key. */
function lockNamespace(orgId: string, agent: Agent): string {
  try {
    return writeNamespaceOf({ orgId, agentId: agent.id });
  } catch (err) {
    if (err instanceof NoNamespaceError) throw new ResourceLockInputError(err.message);
    throw err;
  }
}
const eventProject = (namespace: string) => (namespace === SHARED_NAMESPACE ? null : namespace);

const isHeld = (lock: ResourceLockRecord | undefined, now: string) => !!lock && lock.lease_expires_at > now;
/** Both are ISO-8601 UTC strings from toISOString(), so the later one is the lexically greater one. */
const laterOf = (a: string, b: string) => (a >= b ? a : b);

/** Emits resource.lock_expired once per lapsed lock, directed at the holder -- same lazy-sweep-before-read
 * pattern as tasks.ts's sweepExpiredLeases, so a hub that's been idle doesn't need a background timer to
 * eventually notice, and every read/claim sees consistent state. Does NOT delete the row: an expired lock
 * stays visible (list_resource_locks) until someone claims over it, same as a lapsed task claim stays
 * "claimed" in storage until reclaimed. */
export function sweepExpiredLocks(orgId: string): void {
  const lapsed = db.prepare(
    `SELECT * FROM resource_locks_ns WHERE org_id = ? AND lease_expires_at <= ? AND lease_expiry_emitted_at IS NULL`,
  ).all(orgId, nowIso()) as ResourceLockRecord[];
  for (const lock of lapsed) {
    db.transaction(() => {
      const marked = db.prepare(
        `UPDATE resource_locks_ns SET lease_expiry_emitted_at = datetime('now') WHERE org_id = ? AND scope_key = ? AND resource_key = ? AND lease_expiry_emitted_at IS NULL`,
      ).run(orgId, lock.scope_key, lock.resource_key).changes;
      if (marked === 0) return;
      emitEvent({
        orgId, type: "resource.lock_expired", subjectType: "resource", subjectId: lock.resource_key, targetAgentId: lock.holder_agent_id,
        projectKey: eventProject(lock.scope_key),
        payload: { resourceKey: lock.resource_key, holder: lock.holder_agent_name, leaseExpiresAt: lock.lease_expires_at },
      });
    })();
  }
}

export class ResourceLockInputError extends Error {}

function validateKey(resourceKey: string): void {
  if (!resourceKey.trim()) throw new ResourceLockInputError("resourceKey is required");
  if (resourceKey.length > MAX_RESOURCE_KEY_CHARS) throw new ResourceLockInputError(`resourceKey exceeds ${MAX_RESOURCE_KEY_CHARS} characters`);
}

/** Claims resourceKey for `agent`, or fails if someone else already holds an unexpired lease on it.
 * Re-claiming your own held lock is a renewal, not a takeover (keeps the original acquired_at, emits nothing) -- same
 * "your own claim is a renewal, not a new claim" rule tasks.ts's claimTask uses, so an agent re-asserting a lock it
 * already holds doesn't read as a takeover in the timeline. It follows renewResourceLock's rule, so it never shortens
 * the lease, and it answers `alreadyHeld: true` so the caller can tell it apart from a fresh claim (board task 081baee9:
 * a holder's re-claim used to re-lease silently and answer a bare "Claimed"). */
export function claimResource(orgId: string, agent: Agent, resourceKey: string, leaseSeconds = DEFAULT_LOCK_LEASE_SECONDS, note?: string | null): ClaimResult {
  validateKey(resourceKey);
  const expires = leaseExpiry(leaseSeconds);
  if (!expires) return { ok: false, error: `leaseSeconds must be between 0 and ${MAX_LOCK_LEASE_SECONDS}` };
  const namespace = lockNamespace(orgId, agent);
  sweepExpiredLocks(orgId);
  const outcome = db.transaction((): ClaimResult | null => {
    const before = getLock(orgId, namespace, resourceKey);
    const now = nowIso();
    if (before && before.holder_agent_id === agent.id && isHeld(before, now)) {
      const leaseExpiresAt = laterOf(before.lease_expires_at, expires);
      db.prepare(
        `UPDATE resource_locks_ns SET holder_agent_name = ?, note = ?, lease_expires_at = ?, lease_expiry_emitted_at = NULL
         WHERE org_id = ? AND scope_key = ? AND resource_key = ? AND holder_agent_id = ?`,
      ).run(agent.name, note?.trim() || null, leaseExpiresAt, orgId, namespace, resourceKey, agent.id);
      return { ok: true, alreadyHeld: true, leaseChanged: leaseExpiresAt !== before.lease_expires_at, leaseExpiresAt, lock: getLock(orgId, namespace, resourceKey)! };
    }
    const n = db.prepare(
      `INSERT INTO resource_locks_ns (org_id, scope_key, resource_key, holder_agent_id, holder_agent_name, note, acquired_at, lease_expires_at, lease_expiry_emitted_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, NULL)
       ON CONFLICT(org_id, scope_key, resource_key) DO UPDATE SET
         holder_agent_id = excluded.holder_agent_id,
         holder_agent_name = excluded.holder_agent_name,
         note = excluded.note,
         acquired_at = CASE WHEN resource_locks_ns.holder_agent_id = excluded.holder_agent_id THEN resource_locks_ns.acquired_at ELSE datetime('now') END,
         lease_expires_at = excluded.lease_expires_at,
         lease_expiry_emitted_at = NULL
       WHERE resource_locks_ns.holder_agent_id = ? OR resource_locks_ns.lease_expires_at <= ?`,
    ).run(orgId, namespace, resourceKey, agent.id, agent.name, note?.trim() || null, expires, agent.id, now).changes;
    if (n === 0) return null;
    if (!(before && before.holder_agent_id === agent.id)) {
      emitEvent({
        orgId, type: "resource.locked", actor: agent, subjectType: "resource", subjectId: resourceKey, projectKey: eventProject(namespace),
        payload: { resourceKey, leaseExpiresAt: expires, ...(before ? { takeoverFrom: before.holder_agent_name } : {}) },
      });
    }
    // A fresh claim, a takeover of a lapsed lock, or your own lapsed lock re-taken: in each the lease is new.
    return { ok: true, alreadyHeld: false, leaseChanged: true, leaseExpiresAt: expires, lock: getLock(orgId, namespace, resourceKey)! };
  })();
  if (outcome === null) {
    const holder = getLock(orgId, namespace, resourceKey);
    return { ok: false, error: `"${resourceKey}" is locked by ${holder?.holder_agent_name ?? "another agent"} until ${holder?.lease_expires_at}` };
  }
  return outcome;
}

/** Extends the caller's own lease to `leaseSeconds` from now, but never shortens it: the new expiry is the later of the
 * current one and now + leaseSeconds, and `leaseChanged: false` says the current one was kept (board task 081baee9: a
 * renew(60 s) on a lock held until 12:42 used to cut it to 12:13). To give a lock up early, release it. Allowed after
 * expiry as long as nobody else has claimed it in the meantime (same rule as tasks.ts's renewClaim) -- a slow renew
 * shouldn't lose the lock to a race that hasn't actually happened yet. */
export function renewResourceLock(orgId: string, agent: Agent, resourceKey: string, leaseSeconds = DEFAULT_LOCK_LEASE_SECONDS): RenewResult {
  const expires = leaseExpiry(leaseSeconds);
  if (!expires) return { ok: false, error: `leaseSeconds must be between 0 and ${MAX_LOCK_LEASE_SECONDS}` };
  const notHeld: Failure = { ok: false, error: `You don't hold the lock on "${resourceKey}" (or it doesn't exist)` };
  // An agent with no namespace to lock in holds no locks, so there is nothing of its to renew.
  const namespace = namespacesOf({ orgId, agentId: agent.id }).write;
  if (namespace === null) return notHeld;
  return db.transaction((): RenewResult => {
    const before = getLock(orgId, namespace, resourceKey);
    if (!before || before.holder_agent_id !== agent.id) return notHeld;
    const leaseExpiresAt = laterOf(before.lease_expires_at, expires);
    db.prepare(
      `UPDATE resource_locks_ns SET lease_expires_at = ?, lease_expiry_emitted_at = CASE WHEN ? THEN NULL ELSE lease_expiry_emitted_at END
       WHERE org_id = ? AND scope_key = ? AND resource_key = ? AND holder_agent_id = ?`,
    ).run(leaseExpiresAt, leaseExpiresAt !== before.lease_expires_at ? 1 : 0, orgId, namespace, resourceKey, agent.id);
    return { ok: true, leaseChanged: leaseExpiresAt !== before.lease_expires_at, leaseExpiresAt, lock: getLock(orgId, namespace, resourceKey)! };
  })();
}

/** Only the current holder can release -- there is no force-release here on purpose: an operator
 * override belongs in a later, explicitly-scoped decision, not a default anyone can invoke on
 * anyone else's lock. A lapsed lease is not "held" (isHeld), so release still fails cleanly for it --
 * claim it instead. */
export function releaseResource(orgId: string, agent: Agent, resourceKey: string): { ok: true } | { ok: false; error: string } {
  const namespace = namespacesOf({ orgId, agentId: agent.id }).write;
  const lock = namespace === null ? undefined : getLock(orgId, namespace, resourceKey);
  if (namespace === null || !lock || !isHeld(lock, nowIso())) return { ok: false, error: `No active lock on "${resourceKey}"` };
  if (lock.holder_agent_id !== agent.id) return { ok: false, error: `"${resourceKey}" is locked by ${lock.holder_agent_name}, not you` };
  db.transaction(() => {
    db.prepare(`DELETE FROM resource_locks_ns WHERE org_id = ? AND scope_key = ? AND resource_key = ?`).run(orgId, namespace, resourceKey);
    emitEvent({ orgId, type: "resource.released", actor: agent, subjectType: "resource", subjectId: resourceKey, projectKey: eventProject(namespace), payload: { resourceKey } });
  })();
  return { ok: true };
}

/** Every currently-tracked lock in the org, held or lapsed (a lapsed one is still shown -- it
 * explains why a `claim_resource` succeeded as a takeover a moment later). No project scoping: a
 * resource key is usually a filesystem path or branch name, meaningful across whatever projects
 * share that path, so this is deliberately workspace-wide (memory_entries precedent). */
export function listResourceLocks(orgId: string, viewer?: ScopeAgent): ResourceLockRecord[] {
  sweepExpiredLocks(orgId);
  const filter = viewer ? namespaceFilterSql(viewer, "scope_key") : { sql: "1 = 1", params: [] as string[] };
  const locks = db.prepare(`SELECT * FROM resource_locks_ns WHERE org_id = ? AND ${filter.sql} ORDER BY resource_key, scope_key`).all(orgId, ...filter.params) as ResourceLockRecord[];
  // With projects kept apart, a lock is visible only when its HOLDER is: the roster's own rule (isReachable), so a
  // reader in project A doesn't learn project B's file paths, notes and agent names (Codex-OpenCadre-f46c on 6ad905a).
  // isReachable is true for everyone while isolation is off, so a workspace without it sees exactly what it did.
  return viewer ? locks.filter((lock) => isReachable(viewer, lock.holder_agent_id)) : locks;
}
