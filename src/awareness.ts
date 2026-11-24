import { db } from "./db.js";
import { listEvents, type EventRecord, type EventType } from "./events.js";
import { markDelivered, openDeliveriesUpTo } from "./deliveries.js";
import { evaluate, type Priority } from "./policy.js";
import { sweepTimeline } from "./timeline.js";
import { maybeEmitConnectorItem } from "./connector-digest.js";
import { awarenessBoard, type AwarenessBoard } from "./task-board.js";
import { asData } from "./agent-text.js";
import { liveClaimsOf, wipCapFor } from "./tasks.js";

/** Awareness digest (Ambient Awareness v1, slice 3): what changed that matters
 * to this agent, as compact text for a safe checkpoint. P1 and P2 are listed,
 * P3 is collapsed into counts, and unacknowledged P1s addressed to the agent
 * keep resurfacing until it acks them. */

export const DIGEST_MAX_CHARS = 1200;
const SCAN_LIMIT = 200;

export interface AwarenessItem {
  seq: number;
  type: EventType;
  priority: Exclude<Priority, 3>;
  actor: string | null;
  summary: string;
  reason: string;
  directed: boolean;
}

export interface AwarenessDigest {
  text: string;
  items: AwarenessItem[];
  /** P3 events, counted by type. */
  background: Partial<Record<EventType, number>>;
  /** Last event seq this digest covered. */
  cursor: number;
  /** The caller's live claims against its WIP cap (src/tasks.ts wipCapFor), or null when no cap applies. */
  wip: { held: number; cap: number } | null;
  /** The caller's own slice of the work board (src/task-board.ts), with its text block, built only when asked for
   * (`board: true`; /v1/awareness?board=1). Never an item: a hook prints it at SessionStart, and get_awareness shows it,
   * but nothing wakes a session for it. */
  board?: AwarenessBoard;
}

const BACKGROUND_LABEL: Partial<Record<EventType, string>> = {
  "agent.phase_changed": "phase changes",
  "agent.task_changed": "task updates",
  "agent.stale": "agents gone quiet",
  "agent.suspended": "agents auto-paused",
  "agent.resumed": "agents back online",
  "task.created": "tasks created",
  "task.claimed": "tasks claimed",
  "task.released": "tasks released",
  "task.completed": "tasks completed",
  "task.lane_changed": "tasks moved on the board",
  "decision.recorded": "decisions elsewhere",
  "question.asked": "questions between teammates",
  "question.answered": "answers between teammates",
  "conflict.detected": "conflicts between teammates",
  "approval.requested": "approval requests",
  "approval.decided": "approval decisions",
  "approval.expired": "expired approvals",
  "approval.withdrawn": "withdrawn approval requests",
  "approval.noted": "risky commands noted",
  "project.settings_changed": "project setting changes",
};

function summarize(e: EventRecord): string {
  const p = JSON.parse(e.payload) as Record<string, string | string[] | undefined>;
  const who = e.actor_agent_name ?? "OpenCadre";
  switch (e.type) {
    // The thread id is the recovery pointer, not decoration: get_messages returns nothing once the
    // message is read, while get_message_status(threadId) returns bodies regardless of read state
    // (GET /v1/messages/:threadId/status, src/rest.ts). A lane that followed this line to the inbox
    // and consumed the body had no way back to it, because the one id that reaches it was withheld here.
    case "message.sent": {
      const thread = typeof p.threadId === "string" ? `; thread ${p.threadId}` : "";
      return `${who} sent you a message (read it with get_messages${thread})`;
    }
    case "question.asked": return `${who} asked you a question (reply on thread ${p.threadId})`;
    case "question.answered": return `${who} answered your question on thread ${p.threadId}`;
    case "approval.requested": return `${who} needs your approval: ${p.action}`;
    case "approval.decided": return `${who} ${p.decision === "approve" ? "approved" : "denied"} your request${p.note ? `: ${p.note}` : ""}`;
    case "approval.expired": return `your approval request expired: ${p.action}`;
    case "approval.withdrawn": return `${who} withdrew its approval request: ${p.action}${p.note ? ` (${p.note})` : ""}`;
    case "approval.grant_created": return `${who} let you run ${p.category} actions without asking until ${p.expiresAt}`;
    case "approval.grant_revoked": return `your ${p.category} grant was revoked`;
    case "conflict.detected": return `${who} is also editing ${(p.files as string[]).join(", ")}`;
    // A task's title and a held reason are agents' data: one quoted line each (review of #782, H1).
    case "task.lane_changed": return `${who} moved ${asData(p.title as string, 120)} to ${String(p.to).toUpperCase()}${p.reason ? `: ${asData(p.reason as string, 80)}` : ""}`;
    case "task.lease_expired": return `your claim on ${asData(p.title as string, 120)} expired`;
    case "agent.renamed": return `${who} renamed you from ${p.from} to ${p.to}: other agents now reach you as ${p.to}`;
    // A decision's title is an agent's text too: one quoted line (src/agent-text.ts).
    case "decision.recorded": return `${who} decided: ${asData(p.title as string, 200)}${p.scope ? ` (${asData(p.scope as string, 120)})` : ""}`;
    // Built by the hub from its own snapshot and the computer's self-report (src/connector-digest.ts), never from text
    // a computer sent.
    case "connector.notice": return typeof p.text === "string" ? p.text : "OpenCadre connector notice";
    case "project.settings_changed": {
      const where = p.project ? `project ${p.project}` : "the workspace default";
      return `${who} set the WIP cap for ${where} to ${p.wipCap ?? "none"} (was ${p.previous ?? "none"})`;
    }
    case "goal.set": {
      const text = typeof p.text === "string" ? p.text : "";
      return `${who} set the fleet goal: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
    }
    default: return `${who}: ${e.type}`;
  }
}

function render(after: number, items: AwarenessItem[], background: AwarenessDigest["background"]): string {
  if (items.length === 0 && Object.keys(background).length === 0) return "";
  const header = `OpenCadre awareness (events after #${after}):`;
  const counts = Object.entries(background).map(([type, n]) => `${n} ${BACKGROUND_LABEL[type as EventType] ?? type}`);
  const footer = [
    counts.length ? `Background: ${counts.join(", ")}.` : "",
    items.some((i) => i.directed) ? "Ack what you've handled with ack_event(seq, outcome)." : "",
  ].filter(Boolean);

  const lines = [header];
  const budget = DIGEST_MAX_CHARS - footer.join("\n").length - 40; // room for the "+N more" line
  let used = header.length;
  let shown = 0;
  for (const item of items) {
    const line = `[P${item.priority}] #${item.seq} ${item.summary}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < items.length) lines.push(`+${items.length - shown} more (see pull_events)`);
  return [...lines, ...footer].join("\n");
}

export function getAwareness(orgId: string, agentId: string, options: { since?: number; board?: boolean } = {}): AwarenessDigest {
  sweepTimeline(orgId);
  const agent = db.prepare(`SELECT editing_files, awareness_cursor, project FROM agents WHERE id = ? AND org_id = ?`)
    .get(agentId, orgId) as { editing_files: string | null; awareness_cursor: number | null; project: string | null } | undefined;
  if (!agent) return { text: "", items: [], background: {}, cursor: 0, wip: null, ...(options.board ? { board: { now: [], next: [], held: [], wip: null, text: "" } } : {}) };

  const viewer = { agentId, files: agent.editing_files ? (JSON.parse(agent.editing_files) as string[]) : [], project: agent.project };
  // Each actor's project, looked up once per actor: decision relevance compares only within one project (src/policy.ts).
  const selectProject = db.prepare(`SELECT project FROM agents WHERE id = ? AND org_id = ?`);
  const actorProjects = new Map<string, string | null>();
  const projectOf = (actorId: string | null): string | null => {
    if (!actorId || !agent.project) return null; // a viewer without a project compares with everyone, so skip the lookup
    if (!actorProjects.has(actorId)) {
      actorProjects.set(actorId, (selectProject.get(actorId, orgId) as { project: string | null } | undefined)?.project ?? null);
    }
    return actorProjects.get(actorId)!;
  };
  const after = options.since ?? agent.awareness_cursor ?? 0;
  // A checkpoint read (no `since`) may carry this session's connector item; a re-read with `since` never emits one.
  // Advisory only: a failure here must never cost the caller its digest.
  if (options.since === undefined) {
    try { maybeEmitConnectorItem(orgId, agentId); } catch { /* the digest stands without it */ }
  }
  // Scanned with the agent's project scope (src/scope.ts): the digest never summarizes another project's board.
  const fresh = listEvents(orgId, { after, limit: SCAN_LIMIT, viewer: agentId });
  const cursor = fresh.at(-1)?.seq ?? after;

  const items = new Map<number, AwarenessItem>();
  const background: AwarenessDigest["background"] = {};
  const consider = (event: EventRecord, resurfaced: boolean) => {
    const verdict = evaluate(event, viewer, event.type === "decision.recorded" ? projectOf(event.actor_agent_id) : null);
    if (!verdict) return;
    if (verdict.priority === 3) {
      if (!resurfaced) background[event.type] = (background[event.type] ?? 0) + 1;
      return;
    }
    if (resurfaced && verdict.priority !== 1) return;
    items.set(event.seq, {
      seq: event.seq, type: event.type, priority: verdict.priority, actor: event.actor_agent_name,
      summary: summarize(event), reason: verdict.reason, directed: event.target_agent_id === agentId,
    });
  };
  for (const event of openDeliveriesUpTo(orgId, agentId, after)) consider(event, true);
  for (const event of fresh) consider(event, false);

  const sorted = [...items.values()].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  db.transaction(() => {
    markDelivered(agentId, sorted.filter((i) => i.directed).map((i) => i.seq));
    if (options.since === undefined && cursor !== after) {
      db.prepare(`UPDATE agents SET awareness_cursor = ? WHERE id = ?`).run(cursor, agentId);
    }
  })();
  // The board, with the WIP line inside it (slice C put that line in `text`), only when asked for: it costs several
  // queries, and only SessionStart and get_awareness print it. Kept out of `text` and out of the items, so a hook that
  // speaks only for items (examples/hooks/opencadre-awareness.mjs) never wakes a session just to repeat it.
  if (options.board) {
    const board = awarenessBoard(orgId, agentId);
    return { text: render(after, sorted, background), items: sorted, background, cursor, wip: board.wip, board };
  }
  const cap = wipCapFor(orgId, agentId);
  const wip = cap === null ? null : { held: liveClaimsOf(orgId, agentId).length, cap };
  return { text: render(after, sorted, background), items: sorted, background, cursor, wip };
}
