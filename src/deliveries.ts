import { db } from "./db.js";
import type { EventRecord } from "./events.js";
import { maskEventRow } from "./secrets.js";
import { MESSAGE_EVENT_TYPES, projectFilterSql } from "./scope.js";

/** Delivery and acknowledgement state for directed events (Ambient Awareness
 * v1, slice 2). "delivered" is only a transport receipt: the event was handed
 * to the agent. Acknowledgement is recorded solely when the agent itself calls
 * ackEvent, because a model's own tool call is the only real proof any harness
 * offers that the event was seen. */

export const OUTCOMES = ["acknowledged", "acted", "dismissed"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type DeliveryState = "queued" | "delivered" | Outcome;

export interface DeliveryRecord {
  event_seq: number;
  agent_id: string;
  state: DeliveryState;
  delivered_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export type PulledEvent = EventRecord & { delivery_state: DeliveryState };

/** A directed event about a message stops being open once that message is dealt with: a message or answer the
 * agent has read, or a question that has been answered. Most agents read mail with get_messages and never call
 * ack_event, so without this every high-priority message and answer resurfaced in each awareness digest, and
 * crowded pull_events, forever. The delivery row is left as it is: only ack_event records an acknowledgement. */
const SUBJECT_STILL_OPEN = `NOT EXISTS (
  SELECT 1 FROM messages m WHERE e.subject_type = 'message' AND m.id = e.subject_id AND (
    (e.type IN ('message.sent', 'question.answered') AND m.read_at IS NOT NULL)
    OR (e.type = 'question.asked' AND m.awaiting_reply = 0)))`;

/** Project isolation (PROJECT_ISOLATION.md §5): a directed delivery of a message kind (a message, question or answer)
 * follows the recipient's reach, so mail from a linked project isn't dropped; every other kind follows what it can see. */
function deliveryScopeSql(orgId: string, agentId: string): { sql: string; params: string[] } {
  const agent = { orgId, agentId };
  const reach = projectFilterSql(agent, "e.project_key", { mode: "reach" });
  const visible = projectFilterSql(agent, "e.project_key", { mode: "visible" });
  const kinds = MESSAGE_EVENT_TYPES.map(() => "?").join(", ");
  return {
    sql: `((e.type IN (${kinds}) AND ${reach.sql}) OR (e.type NOT IN (${kinds}) AND ${visible.sql}))`,
    params: [...MESSAGE_EVENT_TYPES, ...reach.params, ...MESSAGE_EVENT_TYPES, ...visible.params],
  };
}

const RANK: Record<DeliveryState, number> = { queued: 0, delivered: 1, acknowledged: 2, acted: 3, dismissed: 3 };
const MAX_PULL = 100;

/** Called by emitEvent inside the emitting transaction. */
export function queueDelivery(eventSeq: number, agentId: string): void {
  db.prepare(`INSERT INTO event_deliveries (event_seq, agent_id, state) VALUES (?, ?, 'queued')`).run(eventSeq, agentId);
}

export function getDelivery(orgId: string, agentId: string, eventSeq: number): DeliveryRecord | null {
  return (db.prepare(
    `SELECT d.* FROM event_deliveries d JOIN events e ON e.seq = d.event_seq
      WHERE e.org_id = ? AND d.agent_id = ? AND d.event_seq = ?`,
  ).get(orgId, agentId, eventSeq) as DeliveryRecord | undefined) ?? null;
}

/** The agent's open directed events (queued or delivered, not yet
 * acknowledged), oldest first. Queued ones become delivered. */
export function pullEvents(orgId: string, agentId: string, limit = MAX_PULL): PulledEvent[] {
  const cap = Math.min(Math.max(Math.trunc(limit) || MAX_PULL, 1), MAX_PULL);
  const scope = deliveryScopeSql(orgId, agentId);
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT e.*, d.state AS delivery_state FROM event_deliveries d JOIN events e ON e.seq = d.event_seq
        WHERE e.org_id = ? AND d.agent_id = ? AND d.state IN ('queued', 'delivered') AND ${SUBJECT_STILL_OPEN} AND ${scope.sql}
        ORDER BY e.seq LIMIT ?`,
    ).all(orgId, agentId, ...scope.params, cap) as PulledEvent[];
    markDelivered(agentId, rows.map((r) => r.seq));
    // Payloads masked on the way out, like listEvents: stored events are hash-chained and never rewritten.
    return rows.map((r) => maskEventRow({ ...r, delivery_state: r.delivery_state === "queued" ? "delivered" : r.delivery_state }));
  })();
}

/** Transport receipt: queued deliveries among these events become delivered. */
export function markDelivered(agentId: string, eventSeqs: number[]): void {
  if (eventSeqs.length === 0) return;
  db.prepare(
    `UPDATE event_deliveries SET state = 'delivered', delivered_at = datetime('now')
      WHERE agent_id = ? AND state = 'queued' AND event_seq IN (${eventSeqs.map(() => "?").join(",")})`,
  ).run(agentId, ...eventSeqs);
}

/** Directed events at or before a cursor that the agent still hasn't acknowledged. */
export function openDeliveriesUpTo(orgId: string, agentId: string, maxSeq: number): EventRecord[] {
  const scope = deliveryScopeSql(orgId, agentId);
  return (db.prepare(
    `SELECT e.* FROM event_deliveries d JOIN events e ON e.seq = d.event_seq
      WHERE e.org_id = ? AND d.agent_id = ? AND d.state IN ('queued', 'delivered') AND e.seq <= ? AND ${SUBJECT_STILL_OPEN} AND ${scope.sql}
      ORDER BY e.seq`,
  ).all(orgId, agentId, maxSeq, ...scope.params) as EventRecord[]).map(maskEventRow);
}

/** Records the agent's own acknowledgement. States only move forward;
 * acted and dismissed are final. Repeating the current state is a no-op. */
export function ackEvent(orgId: string, agentId: string, eventSeq: number, outcome: Outcome):
  | { ok: true; delivery: DeliveryRecord }
  | { ok: false; status: 400 | 404 | 409; error: string } {
  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    return { ok: false, status: 400, error: `outcome must be one of ${OUTCOMES.join(", ")}` };
  }
  const current = getDelivery(orgId, agentId, eventSeq);
  if (!current) return { ok: false, status: 404, error: `No event #${eventSeq} was delivered to you` };
  if (current.state === outcome) return { ok: true, delivery: current };
  if (RANK[outcome] <= RANK[current.state]) {
    return { ok: false, status: 409, error: `Event #${eventSeq} is already ${current.state}` };
  }
  db.prepare(
    `UPDATE event_deliveries
        SET state = ?,
            delivered_at = COALESCE(delivered_at, datetime('now')),
            acknowledged_at = COALESCE(acknowledged_at, datetime('now')),
            resolved_at = CASE WHEN ? IN ('acted', 'dismissed') THEN datetime('now') ELSE resolved_at END
      WHERE event_seq = ? AND agent_id = ?`,
  ).run(outcome, outcome, eventSeq, agentId);
  return { ok: true, delivery: getDelivery(orgId, agentId, eventSeq)! };
}
