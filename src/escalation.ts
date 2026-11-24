import { db } from "./db.js";
import { emitEvent } from "./events.js";
import { reply, sendMessage, type MessageRecord } from "./service.js";
import { currentUsage, shortTime } from "./usage.js";
import { maskAndCap } from "./secrets.js";
import { parseStamp, toSqliteTime } from "./timestamps.js";
import { stampFor } from "./project-stamps.js";
import { operatorsFor, projectLabel, SYSTEM_AGENT_ID } from "./scope.js";

/** Hub-side operator escalation (docs/design/UNIVERSAL_WAKE.md, tier T6). A high-
 * priority message still unread after N minutes means every local wake path failed
 * or the agent is gone, so the hub tells the org's operators. It runs here rather
 * than in any client daemon, so a dead laptop still escalates. Each message
 * escalates at N, 2N and 4N minutes, then stops.
 *
 * A recipient can have several distinct stuck messages, each crossing its own N/2N/4N
 * threshold at a different time, so one recipient can trigger several separate escalation
 * sends over time. Without care that piles up as separate near-duplicate inbox messages
 * for the operator (observed live: a single backlogged agent produced six standalone
 * ESCALATION notices). escalation_threads remembers one ongoing thread per (org, recipient,
 * operator) so every later escalation for that pair replies into it instead of starting a
 * new one -- the operator sees one evolving notice, not a pile. */

const DEFAULT_MINUTES = 10;
const PREVIEW_CHARS = 120;

/** The hub's own voice. Deliberately not an agents row: a row would show up in the
 * fleet listing, org broadcasts and name checks, and would need a key nobody holds.
 * messages.from_agent_id has no foreign key, so a fixed non-UUID id is unambiguous
 * (agent ids are UUIDs) and a reply to it lands harmlessly as a dead letter. */
export const SYSTEM_SENDER = { id: SYSTEM_AGENT_ID, name: "OpenCadre" } as const;

/** Port of scripts/pure-ack.mjs: src can't import from scripts/ under rootDir, and a
 * parity test keeps the two in step. */
export function isPureAck(body: string | null | undefined): boolean {
  const t = (body ?? "").trim();
  if (!t || t.length > 400) return false;
  if (/\?/.test(t)) return false;
  if (/\b(please|must|stop|rebase|commit hash|git status|do not|policy|fix|confirm|task assignment|guidance)\b/i.test(t)) {
    return false;
  }
  return (
    /^(confirmed|thanks|thank you|got it|ack|acknowledged|roger|copy|understood)\b/i.test(t) ||
    /^confirmed, got both:/i.test(t) ||
    /round-trip works\.?\s*thanks\.?$/i.test(t)
  );
}

type Stuck = Pick<MessageRecord, "id" | "org_id" | "to_agent_id" | "to_agent_name" | "from_agent_name" | "body" | "created_at"> & { level: number; to_usage: string | null };

// created_at is SQLite's "YYYY-MM-DD HH:MM:SS" UTC; that format compares correctly as text.
// Both conversions come from src/timestamps.ts, which is the one definition of each. The read side
// is the GUARDED form: the naive one returns NaN for an ISO value, and NaN in a comparison is false.
const fromSqliteTime = parseStamp;

const stuckMessages = db.prepare(
  `SELECT m.id, m.org_id, m.to_agent_id, m.to_agent_name, m.from_agent_name, m.body, m.created_at, COALESCE(e.level, 0) AS level, a.usage AS to_usage
   FROM messages m
   JOIN agents a ON a.id = m.to_agent_id AND a.org_id = m.org_id
   LEFT JOIN message_escalations e ON e.message_id = m.id
   WHERE m.priority = 'high' AND m.read_at IS NULL AND m.created_at <= ? AND a.role != 'operator' AND a.removed_at IS NULL
   ORDER BY m.org_id, m.to_agent_id, m.created_at, m.rowid`,
);
const recordLevel = db.prepare(
  `INSERT INTO message_escalations (message_id, level, last_notified_at) VALUES (?, ?, ?)
   ON CONFLICT(message_id) DO UPDATE SET level = excluded.level, last_notified_at = excluded.last_notified_at`,
);
const getEscalationThread = db.prepare(
  `SELECT thread_id FROM escalation_threads WHERE org_id = ? AND recipient_agent_id = ? AND operator_id = ?`,
);
const upsertEscalationThread = db.prepare(
  `INSERT INTO escalation_threads (org_id, recipient_agent_id, operator_id, thread_id, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(org_id, recipient_agent_id, operator_id) DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
);

function thresholdMinutes(): number {
  const n = Number(process.env.OPENCADRE_ESCALATE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MINUTES;
}

/** One pass over every org. Takes the clock as an argument so tests never need timers. */
export async function sweepEscalations(now: Date): Promise<void> {
  const n = thresholdMinutes();
  const minutesOld = (m: Stuck) => (now.getTime() - fromSqliteTime(m.created_at)) / 60_000;
  const levelOf = (m: Stuck) => (minutesOld(m) >= 4 * n ? 3 : minutesOld(m) >= 2 * n ? 2 : 1);

  const cutoff = toSqliteTime(new Date(now.getTime() - n * 60_000));
  const byRecipient = new Map<string, Stuck[]>();
  for (const m of stuckMessages.all(cutoff) as Stuck[]) {
    if (isPureAck(m.body)) continue;
    const key = `${m.org_id}|${m.to_agent_id}`;
    byRecipient.set(key, [...(byRecipient.get(key) ?? []), m]);
  }

  for (const stuck of byRecipient.values()) {
    const due = stuck.filter((m) => levelOf(m) > m.level);
    if (due.length === 0) continue;
    const [oldest] = stuck;
    const { org_id: orgId, to_agent_id: recipientId } = oldest;
    // Operator people, plus operator agents that can see the recipient's project (PROJECT_ISOLATION.md §5).
    const project = stampFor(orgId, recipientId);
    const operatorIds = operatorsFor(orgId, project);

    // Record the level before notifying, so a crash mid-send can't re-notify next sweep.
    db.transaction(() => {
      for (const m of due) recordLevel.run(m.id, levelOf(m), toSqliteTime(now));
      emitEvent({
        orgId, type: "message.escalated", subjectType: "agent", subjectId: recipientId,
        payload: {
          recipientAgentId: recipientId, messageIds: stuck.map((m) => m.id), messageCount: stuck.length,
          level: Math.max(...due.map(levelOf)), operatorCount: operatorIds.length,
        },
      });
    })();

    const senders = [...new Set(stuck.map((m) => m.from_agent_name))].join(", ");
    // Out of usage is a known cause with a known fix, so say so instead of sending the operator to debug a session.
    const usage = currentUsage(oldest.to_usage, now.getTime());
    const advice = usage?.limited
      ? `${oldest.to_agent_name} is OUT OF USAGE (resets ${shortTime(usage.resetsAt)}) — route this work to another agent.`
      : "They may be idle; check their session.";
    // maskAndCap masks THEN cuts (docs/decisions #1789: the previous plain .slice() could cut a secret in half
    // and still show the unmasked front of it) -- never slice-then-mask agent text, see src/secrets.ts.
    const body = `ESCALATION${projectLabel(orgId, project)}: ${oldest.to_agent_name} has not read ${stuck.length} high-priority message(s) from ${senders} ` +
      `for ${Math.floor(minutesOld(oldest))} min. Oldest: "${maskAndCap(oldest.body, PREVIEW_CHARS, "")}". ${advice}`;
    // High priority, so operators with a webhook get woken by the existing path. Reply into this
    // recipient's existing escalation thread with this operator when there is one, so repeated
    // escalations update one message thread instead of piling up as separate mail; fall back to a
    // fresh message (recording its thread for next time) when there's no prior thread, or the reply
    // failed -- e.g. NOT_REACHABLE after a project link was removed since the thread was opened.
    // skipDuplicateCheck on both calls: this is intentional fan-out (the same escalation body to
    // every operator's own thread), not the accidental repeat-across-threads pattern the
    // duplicate-send guard targets (src/service.ts).
    for (const operatorId of operatorIds) {
      const existing = getEscalationThread.get(orgId, recipientId, operatorId) as { thread_id: string } | undefined;
      const replied = existing ? reply(orgId, SYSTEM_SENDER, existing.thread_id, body, { skipDuplicateCheck: true }) : undefined;
      if (replied?.ok) continue;
      const sent = await sendMessage(orgId, SYSTEM_SENDER, operatorId, body, "high", null, { skipDuplicateCheck: true });
      if (sent.ok) upsertEscalationThread.run(orgId, recipientId, operatorId, sent.threadId, toSqliteTime(now));
    }
  }
}
