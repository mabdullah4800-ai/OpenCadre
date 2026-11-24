import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import { db } from "./db.js";

export const CONSOLE_ACCESS_CHANGED_CODE = 4004;
const PAUSED_SOCKET_CODE = 4003;
export const WORKSPACE_CHANGED_HINT = JSON.stringify({ type: "workspace.changed" });
const MAX_PENDING_WORKSPACES = 128;
const MAX_REFS_PER_WORKSPACE = 16;
const MAX_OBSERVED_WORKSPACES = 128;
const MAX_OBSERVED_PER_PASS = 16;
const MAX_ROSTER_ROWS = 1000;
const MAX_BUFFERED_BYTES = 64 * 1024;
const CONSOLE_EVENT_TYPES = new Set([
  "approval.requested", "approval.noted", "approval.decided", "approval.expired", "approval.withdrawn", "approval.grant_created", "approval.grant_revoked",
  "agent.task_changed", "agent.phase_changed", "agent.resumed", "agent.stale", "agent.suspended",
  "task.created", "task.claimed", "task.released", "task.completed", "task.accepted", "task.rejected",
  "task.lease_expired", "task.superseded", "task.review_recorded",
  "message.sent", "question.asked", "question.answered", "message.escalated",
  "member.role_changed", "member.removed", "workspace.paused", "workspace.resumed",
  "project.linked", "project.unlinked", "workspace.isolation_enabled", "workspace.isolation_disabled",
]);

export interface ConsolePrincipal {
  kind: "console";
  orgId: string;
  agentId: string;
  personId: string;
  sessionHash: string;
  memberRole: string;
}

type EventRef = { id: string; seq: number; orgId: string; type: string };
type Listener = { ws: WebSocket; principal: ConsolePrincipal };
type Observation = { digest: string | null };
const listeners = new Map<string, Set<Listener>>();
const pending = new Map<string, Map<string, EventRef>>();
const observations = new Map<string, Observation>();
let flushScheduled = false;
let observeCursor = 0;
let recheckScheduled = false;

/** Called only by emitEvent. Refs are hints until the post-stack flush proves the exact row committed. */
export function enqueueConsoleEvent(event: { id: string; seq: number; org_id: string; type: string }): void {
  try {
    if (!CONSOLE_EVENT_TYPES.has(event.type) || !listeners.has(event.org_id)) return;
    let refs = pending.get(event.org_id);
    if (!refs) {
      if (pending.size >= MAX_PENDING_WORKSPACES) return;
      refs = new Map();
      pending.set(event.org_id, refs);
    }
    if (!refs.has(event.id) && refs.size >= MAX_REFS_PER_WORKSPACE) return;
    refs.set(event.id, { id: event.id, seq: event.seq, orgId: event.org_id, type: event.type });
    scheduleFlush();
  } catch {
    // A best-effort hint must never alter the event writer or its transaction.
  }
}

export function registerConsoleSocket(ws: WebSocket, principal: ConsolePrincipal): void {
  try {
    let group = listeners.get(principal.orgId);
    if (!group) listeners.set(principal.orgId, (group = new Set()));
    const listener = { ws, principal };
    group.add(listener);
    if (!observations.has(principal.orgId) && observations.size < MAX_OBSERVED_WORKSPACES) observations.set(principal.orgId, { digest: null });
    ws.on("close", () => {
      group!.delete(listener);
      if (group!.size === 0 && listeners.get(principal.orgId) === group) {
        listeners.delete(principal.orgId);
        pending.delete(principal.orgId);
        observations.delete(principal.orgId);
      }
    });
  } catch {
    try { ws.close(1011, "console connection unavailable"); } catch { try { ws.terminate(); } catch { /* best effort */ } }
  }
}

/** Recheck after sign-out/expiry. The subsequent persisted read prevents rollback or nested transactions from closing a live session. */
export function scheduleConsoleAccessRecheck(): void {
  try {
    recheckScheduled = true;
    scheduleFlush();
  } catch {
    // Keepalive performs the same persisted-state check if scheduling is unavailable.
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  try {
    setImmediate(() => {
      flushScheduled = false;
      flushConsoleLiveChanges();
    });
  } catch {
    flushScheduled = false;
  }
}

function currentAccess(principal: ConsolePrincipal): 4001 | 4003 | 4004 | null {
  const session = db.prepare(`SELECT s.person_id, s.expires_at, p.id AS existing_person
    FROM sessions s LEFT JOIN people p ON p.id = s.person_id WHERE s.token_hash = ?`).get(principal.sessionHash) as
    { person_id: string; expires_at: string; existing_person: string | null } | undefined;
  if (!session || session.person_id !== principal.personId || !session.existing_person || Date.parse(session.expires_at) <= Date.now()) return 4001;
  const member = db.prepare(`SELECT m.role, m.agent_id, a.role AS agent_role, o.paused_at
    FROM workspace_members m JOIN agents a ON a.id = m.agent_id AND a.org_id = m.org_id
    JOIN organizations o ON o.id = m.org_id WHERE m.org_id = ? AND m.person_id = ?`).get(principal.orgId, principal.personId) as
    { role: string; agent_id: string; agent_role: string; paused_at: string | null } | undefined;
  if (!member || member.agent_id !== principal.agentId || member.role !== principal.memberRole) return CONSOLE_ACCESS_CHANGED_CODE;
  if (member.paused_at && member.agent_role !== "operator") return PAUSED_SOCKET_CODE;
  return null;
}

function closeListener(listener: Listener, code: number): void {
  try {
    listener.ws.close(code, code === 4001 ? "session expired" : code === PAUSED_SOCKET_CODE ? "workspace paused" : "workspace access changed");
  } catch {
    try { listener.ws.terminate(); } catch { /* keep other listeners progressing */ }
  }
}

function sendHint(listener: Listener): void {
  try {
    if (listener.ws.readyState !== listener.ws.OPEN || listener.ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
    listener.ws.send(WORKSPACE_CHANGED_HINT);
  } catch { /* hint loss is recovered by polling/reconnect */ }
}

/** Safe to call from the existing keepalive. Never flushes from inside a database transaction. */
export function flushConsoleLiveChanges(): void {
  try {
    if (db.inTransaction) return;
    let committedWorkspaces = new Set<string>();
    for (const [orgId, refs] of pending) {
      for (const ref of refs.values()) {
        const row = db.prepare(`SELECT id FROM events WHERE id = ? AND seq = ? AND org_id = ? AND type = ?`).get(ref.id, ref.seq, ref.orgId, ref.type);
        if (row) committedWorkspaces.add(orgId);
      }
    }
    pending.clear();
    const shouldRecheck = recheckScheduled;
    recheckScheduled = false;
    for (const [orgId, group] of listeners) {
      const changed = committedWorkspaces.has(orgId);
      if (!changed && !shouldRecheck) continue;
      recheckGroup(orgId, group, changed);
      if (group.size === 0 && listeners.get(orgId) === group) {
        listeners.delete(orgId);
        observations.delete(orgId);
      }
    }
  } catch {
    // A failing revalidation or observer must never escape into emitEvent/mutation callers.
  }
}

function recheckGroup(orgId: string, group: Set<Listener>, send: boolean): void {
  for (const listener of [...group]) {
    try {
      const code = currentAccess(listener.principal);
      if (code !== null) {
        closeListener(listener, code);
        group.delete(listener);
      } else if (send) sendHint(listener);
    } catch {
      // One database or socket failure must not block another console listener.
    }
  }
  if (group.size === 0 && listeners.get(orgId) === group) {
    listeners.delete(orgId);
    pending.delete(orgId);
    observations.delete(orgId);
  }
}

/** Authorization revalidation is not limited by the optional roster-observation caps. */
function recheckAll(): void {
  for (const [orgId, group] of listeners) recheckGroup(orgId, group, false);
}

function observationDigest(rows: Array<Record<string, unknown>>, isOnline: (at: string | null) => boolean): string {
  const visible = rows.map((row) => [row.id, row.name, row.status, row.phase ?? null, row.current_task ?? null,
    row.editing_files ?? null, row.kind ?? null, row.liveness ?? null, isOnline(row.last_heartbeat_at as string | null)]);
  return createHash("sha256").update(JSON.stringify(visible)).digest("hex");
}

/** Bounded keepalive observer; only persisted committed state is sampled. */
export async function sweepConsoleLive(): Promise<void> {
  flushConsoleLiveChanges();
  try {
    if (db.inTransaction) return;
    recheckAll();
    if (db.inTransaction || observations.size === 0) return;
    const { isOnline } = await import("./service.js");
    const orgIds = [...observations.keys()];
    if (!orgIds.length) return;
    const count = Math.min(MAX_OBSERVED_PER_PASS, orgIds.length);
    for (let offset = 0; offset < count; offset++) {
      const orgId = orgIds[(observeCursor + offset) % orgIds.length];
      if (db.inTransaction) return;
      const group = listeners.get(orgId);
      if (!group?.size) { observations.delete(orgId); continue; }
      const rows = db.prepare(`SELECT id, name, status, current_task, editing_files, last_heartbeat_at, phase, kind, liveness
        FROM agents WHERE org_id = ? AND removed_at IS NULL AND NOT (kind = 'session' AND ended_at IS NOT NULL)
          AND (key_class != 'human' OR id IN (SELECT agent_id FROM workspace_members WHERE org_id = ?))
        ORDER BY id LIMIT ?`).all(orgId, orgId, MAX_ROSTER_ROWS + 1) as Array<Record<string, unknown>>;
      const state = observations.get(orgId);
      if (!state) continue;
      if (rows.length > MAX_ROSTER_ROWS) { state.digest = null; continue; }
      const digest = observationDigest(rows, isOnline);
      const changed = state.digest !== null && state.digest !== digest;
      state.digest = digest;
      recheckGroup(orgId, group, changed);
    }
    observeCursor = (observeCursor + count) % Math.max(orgIds.length, 1);
  } catch {
    // Keepalive observations are opportunistic; the console's ordinary polling remains authoritative.
  }
}

export function consoleLiveSnapshot(): { workspaces: number; listeners: number; pendingRefs: number } {
  let listenerCount = 0;
  let pendingRefs = 0;
  for (const group of listeners.values()) listenerCount += group.size;
  for (const refs of pending.values()) pendingRefs += refs.size;
  return { workspaces: listeners.size, listeners: listenerCount, pendingRefs };
}
