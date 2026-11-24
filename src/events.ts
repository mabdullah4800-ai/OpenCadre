import { db, newId } from "./db.js";
import { computeEventHash } from "./event-hash.js";
import { queueDelivery } from "./deliveries.js";
import { isDraining } from "./draining.js";
import { sqliteNow as sqliteNowShared } from "./timestamps.js";
import { maskAndCap, maskEventRow } from "./secrets.js";
import { eventStamp } from "./project-stamps.js";
import { MESSAGE_EVENT_TYPES, projectFilterSql, type ScopeAgent } from "./scope.js";
import { enqueueConsoleEvent } from "./console-live.js";

/** Append-only organization timeline (Ambient Awareness v1, slice 1).
 * Features call emitEvent inside the same db.transaction as their own write,
 * so the timeline can never disagree with state. Payloads hold identifiers and
 * short summaries only -- never message bodies or file content.
 *
 * Ambient Intelligence v2 S3.4 (tamper-evident audit trail): every row also
 * carries `hash` = sha256(its own real columns + `prev_hash`), and `prev_hash`
 * = the `hash` of the previous event row for the SAME org_id (chains are
 * per-org, matching every other org-scoped read/write in this codebase). The
 * first chained event for an org, and any row written before this migration,
 * has prev_hash/hash = null -- that's the documented genesis sentinel, not a
 * broken chain. Hashing happens inside emitEvent's own insert, in the same
 * function call as the row write, so no caller can insert an event without it. */

export const EVENT_TYPES = [
  "agent.phase_changed",
  "agent.task_changed",
  "agent.capabilities_set",
  "agent.round_budget_set",
  "blackboard.fact_set",
  "blackboard.fact_deleted",
  "task.review_recorded",
  "agent.key_rotated",
  "agent.removed",
  // A person named (renamed) an agent: payload { from, to, profileId, profile, byPerson } (sessions PR1, migration 55).
  "agent.renamed",
  // A person set or cleared an agent's wake webhook (PUT /v1/org/agents/:agentId/webhook): payload { agentName, host,
  // authHeaderSet, previousHost? } or { agentName, previousHost? }; previousHost names the host an overwrite or clear
  // replaced. Never the header, and never the URL's path or query, which can carry a token.
  "agent.webhook_set",
  "agent.webhook_cleared",
  "agent.stale",
  "agent.suspended",
  "agent.resumed",
  "agent.connected",
  "agent.usage_limited",
  "agent.usage_restored",
  "message.sent",
  "message.escalated",
  "question.asked",
  "question.answered",
  "task.created",
  "task.claimed",
  "task.released",
  "task.completed",
  "task.accepted",
  "task.rejected",
  "task.lease_expired",
  // A correction replaced a filed row (migration 39). The counterpart of memory.archived: it records
  // that the row a reader may be holding is no longer the live one, and names what replaced it.
  "task.superseded",
  // A task moved between the work board's lanes, or was re-ranked (src/tasks.ts setTaskLane, migration 61).
  "task.lane_changed",
  "resource.locked",
  "resource.released",
  "resource.lock_expired",
  "goal.set",
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "approval.noted",
  // The requester took its own pending request back (src/approvals.ts withdrawApproval): final, like denied.
  "approval.withdrawn",
  "approval.grant_created",
  "approval.grant_revoked",
  "memory.recorded",
  "memory.archived",
  "conflict.detected",
  "decision.recorded",
  "review.prescreened",
  "clearance.policy_changed",
  "clearance.bypassed",
  // A gate fallback of "allow" handed a risky command back to the tool's own permission settings with no OpenCadre
  // approval (F7 / Q1f). Not an execution and not a decision: see src/clearance-bypass.ts recordPolicyPass.
  "clearance.policy_pass",
  "workspace.paused",
  "workspace.resumed",
  "workspace.isolation_enabled",
  "workspace.isolation_disabled",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "invite.created",
  "invite.revoked",
  "device.created",
  "device.revoked",
  "device.reconnected",
  // The awareness digest's per-computer connector item, directed at the one session that carries it (PR-E1b,
  // src/connector-digest.ts). Payload { status, stamp, text }: no credential, device id or installation id.
  "connector.notice",
  "session.joined",
  "session.ended",
  "project.enabled",
  "project.disabled",
  "project.linked",
  "project.unlinked",
  // An admin changed a project's settings, or the workspace default's (src/project-settings.ts): today, the WIP cap.
  "project.settings_changed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type SubjectType = "agent" | "task" | "approval" | "grant" | "message" | "decision" | "conflict" | "review" | "clearance" | "workspace" | "member" | "device" | "project" | "memory" | "goal" | "resource" | "blackboard_fact";

export interface EventRecord {
  seq: number;
  id: string;
  org_id: string;
  type: EventType;
  actor_agent_id: string | null;
  actor_agent_name: string | null;
  subject_type: SubjectType;
  subject_id: string;
  target_agent_id: string | null;
  payload: string;
  created_at: string;
  prev_hash: string | null;
  hash: string | null;
  /** The project this event belongs to (PROJECT_ISOLATION.md §4), or null for a workspace-level event. Not hashed as a
   * column: a non-null stamp is also written into the payload as `project_key`, and the payload is hashed. */
  project_key: string | null;
}

type Actor = { id: string; name: string } | null;

const MAX_PAGE = 200;
const MAX_WAIT_SECONDS = 280;

const insert = db.prepare(
  `INSERT INTO events (id, org_id, type, actor_agent_id, actor_agent_name, subject_type, subject_id, target_agent_id, payload, created_at, prev_hash, hash, project_key)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const lastHashForOrg = db.prepare(`SELECT hash FROM events WHERE org_id = ? ORDER BY seq DESC LIMIT 1`);

const waiters = new Map<string, Set<() => void>>();

// SQLite's own `datetime('now')` format, generated in JS rather than left to the column default so
// emitEvent knows created_at before it hashes the row, in the same insert. Defined in
// src/timestamps.ts -- the one definition of each conversion -- and imported under the local name
// the call site below already uses.
const sqliteNow = sqliteNowShared;

export function emitEvent(event: {
  orgId: string;
  type: EventType;
  actor?: Actor;
  subjectType: SubjectType;
  subjectId: string;
  targetAgentId?: string | null;
  payload?: Record<string, unknown>;
  /** The project stamp, when the caller knows it better than the subject row does (e.g. a grant deleted before its
   * event). Omitted: derived by eventStamp. */
  projectKey?: string | null;
}): EventRecord {
  if (!(EVENT_TYPES as readonly string[]).includes(event.type)) throw new Error(`unknown event type "${event.type}"`);
  const id = newId();
  const createdAt = sqliteNow();
  const actorAgentId = event.actor?.id ?? null;
  const targetAgentId = event.targetAgentId ?? null;
  const projectKey = event.projectKey !== undefined
    ? event.projectKey
    : eventStamp({ orgId: event.orgId, type: event.type, subjectType: event.subjectType, subjectId: event.subjectId, actorId: actorAgentId });
  // The stamp's tamper-evident copy: the payload is hashed, the column is not. Named like the column, so it can't collide
  // with a payload's own projectKey (session.joined's request key, project.enabled's subject). Absent means null.
  const payload = JSON.stringify(projectKey ? { ...(event.payload ?? {}), project_key: projectKey } : (event.payload ?? {}));
  const prevHash = (lastHashForOrg.get(event.orgId) as { hash: string | null } | undefined)?.hash ?? null;
  const hash = computeEventHash(
    { id, org_id: event.orgId, type: event.type, actor_agent_id: actorAgentId, subject_type: event.subjectType, subject_id: event.subjectId, target_agent_id: targetAgentId, payload, created_at: createdAt },
    prevHash,
  );
  const seq = Number(insert.run(
    id, event.orgId, event.type, actorAgentId, event.actor?.name ?? null,
    event.subjectType, event.subjectId, targetAgentId, payload, createdAt, prevHash, hash, projectKey,
  ).lastInsertRowid);
  if (event.targetAgentId) queueDelivery(seq, event.targetAgentId);
  // Waiters re-read after this synchronous transaction finishes, so they only see committed rows.
  for (const wake of waiters.get(event.orgId) ?? []) wake();
  const record = db.prepare(`SELECT * FROM events WHERE seq = ?`).get(seq) as EventRecord;
  try { enqueueConsoleEvent(record); } catch { /* a console hint cannot change the event write */ }
  return record;
}

/** Walks an org's event chain in seq order and recomputes each row's hash from
 * its own current column values, detecting any row edited after the fact.
 * A row with hash = null (written before this migration, or a still-uninitialized
 * chain) is treated as a fresh genesis point, not a break -- see the module
 * doc comment. Returns the seq of the first row whose stored hash/prev_hash no
 * longer matches what its current columns produce. */
export function verifyEventChain(orgId: string): { ok: boolean; brokenAtSeq?: number } {
  const rows = db.prepare(`SELECT * FROM events WHERE org_id = ? ORDER BY seq ASC`).all(orgId) as EventRecord[];
  let expectedPrevHash: string | null = null;
  for (const row of rows) {
    if (row.hash == null) {
      expectedPrevHash = null;
      continue;
    }
    if (row.prev_hash !== expectedPrevHash) return { ok: false, brokenAtSeq: row.seq };
    if (computeEventHash(row, row.prev_hash) !== row.hash) return { ok: false, brokenAtSeq: row.seq };
    expectedPrevHash = row.hash;
  }
  return { ok: true };
}

/** The events a viewer may read (PROJECT_ISOLATION.md §5): those stamped with a project it can see, plus mail addressed to
 * it (message kinds) from a project it can reach, so a message from a linked project still reaches its recipient. */
export function eventViewerFilterSql(viewer: ScopeAgent, alias = ""): { sql: string; params: string[] } {
  const column = `${alias}project_key`;
  const visible = projectFilterSql(viewer, column, { mode: "visible" });
  const reach = projectFilterSql(viewer, column, { mode: "reach" });
  const kinds = MESSAGE_EVENT_TYPES.map(() => "?").join(", ");
  return {
    sql: `(${visible.sql} OR (${alias}target_agent_id = ? AND ${alias}type IN (${kinds}) AND ${reach.sql}))`,
    params: [...visible.params, viewer.agentId, ...MESSAGE_EVENT_TYPES, ...reach.params],
  };
}

/** latest: return the newest `limit` events (still in seq order) instead of the oldest after the cursor.
 * viewer: the agent reading, whose project scope filters the rows (src/scope.ts). Every agent-facing read passes it;
 * without one (the hub's own sweeps, chain checks) every event in the workspace is returned.
 * Payloads come back with secrets masked (src/secrets.ts). New payloads are masked where they are built; an event
 * written before that keeps its stored payload, because rewriting it would break the hash chain, and is masked here on
 * every read instead. Only this output copy changes: hash and prev_hash still describe the stored row.
 *
 * `createdAtOrAfter` is the RETENTION window, applied IN SQL so it composes with the LIMIT rather than
 * after it. It is OPT-IN and undefined for every live path -- the long-poll waiter, the awareness
 * digest and the delivery path pass nothing, so a billing window can never silence live coordination.
 * Only the history reader (`listTimeline`) supplies it.
 *
 * WHY THIS IS A PARAMETER AND NOT A FILTER AT THE CALL SITE. The window used to be applied by
 * `listTimeline` as a JS `.filter()` over the page `listEvents` had already cut to `MAX_PAGE`. So 200
 * expired rows consumed the page and live rows behind them were unreachable, and a paging caller that
 * computes its next cursor from the returned rows re-served its own cursor forever. A filter cannot fix
 * that: the rows it needs have already been discarded by the LIMIT. The predicate has to be in the
 * WHERE clause, which means it belongs here, guarded by an argument that only the history path passes. */
export function listEvents(
  orgId: string,
  { after = 0, types, limit = MAX_PAGE, latest = false, viewer, subject, createdAtOrAfter }: { after?: number; types?: string[]; limit?: number; latest?: boolean; viewer?: string; subject?: { type: string; id: string }; createdAtOrAfter?: string | null } = {},
): EventRecord[] {
  const cap = Math.min(Math.max(Math.trunc(limit) || MAX_PAGE, 1), MAX_PAGE);
  const wanted = (types ?? []).filter((t) => (EVENT_TYPES as readonly string[]).includes(t));
  if (types?.length && wanted.length === 0) return [];
  const typeClause = wanted.length ? ` AND type IN (${wanted.map(() => "?").join(",")})` : "";
  const scope = viewer ? eventViewerFilterSql({ orgId, agentId: viewer }) : { sql: "1 = 1", params: [] };
  // One subject's story (a task's history): without it, a reader must page the whole workspace.
  const subjectClause = subject ? " AND subject_type = ? AND subject_id = ?" : "";
  const subjectParams = subject ? [subject.type, subject.id] : [];
  // The retention window is opt-in and belongs before LIMIT, so hidden rows cannot consume a page.
  const windowClause = createdAtOrAfter ? " AND created_at >= ?" : "";
  const windowParams = createdAtOrAfter ? [createdAtOrAfter] : [];
  const rows = db.prepare(`SELECT * FROM events WHERE org_id = ? AND seq > ?${typeClause}${subjectClause} AND ${scope.sql}${windowClause} ORDER BY seq ${latest ? "DESC" : "ASC"} LIMIT ?`)
    .all(orgId, after, ...wanted, ...subjectParams, ...scope.params, ...windowParams, cap) as EventRecord[];
  return (latest ? rows.reverse() : rows).map(maskEventRow);
}

/** Long-poll: returns events after the cursor immediately if any exist, else
 * blocks until one is emitted for this org or the timeout passes. */
/** Bumped on graceful shutdown so every waiter returns instead of waiting again. */
let shutdownGeneration = 0;

function waitForOrgEvent(orgId: string, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const set = waiters.get(orgId) ?? new Set();
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (set.size === 0) waiters.delete(orgId);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
    waiters.set(orgId, set);
  });
}

/** Long-poll for events after `after`. Returns as soon as a matching event exists, or empty at the timeout.
 * Every event in the org wakes the waiter, but an event outside `types` doesn't end the wait: it keeps
 * waiting for the remaining time, so a watcher filtered to agent.* isn't woken by routine message traffic.
 * The same holds for project isolation: waking stays workspace-wide (so a workspace-scope waiter is never starved), and
 * only the re-query is filtered by the viewer's scope. An event it can't see sends it back to waiting. */
export async function waitForEvents(orgId: string, after: number, timeoutSeconds: number, types?: string[], viewer?: string): Promise<EventRecord[]> {
  const deadline = Date.now() + Math.min(Math.max(timeoutSeconds, 0), MAX_WAIT_SECONDS) * 1000;
  const generation = shutdownGeneration;
  for (;;) {
    const ready = listEvents(orgId, { after, types, viewer });
    const remaining = deadline - Date.now();
    if (ready.length > 0 || remaining <= 0 || generation !== shutdownGeneration || isDraining()) return ready;
    await waitForOrgEvent(orgId, remaining);
  }
}

/** Gauge for /v1/metrics. */
export function pendingEventWaiterCount(): number {
  let n = 0;
  for (const set of waiters.values()) n += set.size;
  return n;
}

/** Unblocks every pending event long-poll, e.g. on graceful shutdown. */
export function resolveAllEventWaiters(): void {
  shutdownGeneration++;
  for (const set of waiters.values()) for (const wake of [...set]) wake();
}

export function recordDecision(orgId: string, actor: { id: string; name: string }, input: { title: string; rationale?: string | null; scope?: string | null }): EventRecord {
  const title = input.title?.trim();
  if (!title) throw new Error("title is required");
  // Cut after masking (maskAndCap): a slice first could leave a fragment of a secret that read-time masking can't see.
  const payload: Record<string, string> = { title: maskAndCap(title, 200, "") };
  if (input.rationale?.trim()) payload.rationale = maskAndCap(input.rationale.trim(), 2000, "");
  if (input.scope?.trim()) payload.scope = maskAndCap(input.scope.trim(), 500, "");
  return emitEvent({ orgId, type: "decision.recorded", actor, subjectType: "decision", subjectId: newId(), payload });
}
