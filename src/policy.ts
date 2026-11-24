import type { EventRecord } from "./events.js";

/** Relevance and priority rules (Ambient Awareness v1, slice 3). Pure: no I/O,
 * so every rule is unit-testable. Priority is computed from the event type and
 * the viewer's own state -- a sender can raise a message to P1 with "high",
 * never beyond. P0 is reserved for a future operator-only stop event. */

export type Priority = 1 | 2 | 3;
export interface Viewer {
  agentId: string;
  /** Files the viewer announced via set_status. */
  files: string[];
  /** The viewer's `agents.project` (session agents); null or absent for a named agent. */
  project?: string | null;
}

/** False only when both sides have a project and the projects differ. Two repos can share a path such as src/index.ts,
 * so file overlap means something only inside one project. A named agent has no project (NULL) and keeps today's
 * workspace-wide comparison (docs/design/PROJECT_ISOLATION.md §7 item 1). */
export function sameProjectOrUnknown(a: string | null | undefined, b: string | null | undefined): boolean {
  return !a || !b || a === b;
}
export interface Verdict {
  priority: Priority;
  reason: string;
}

const DIRECTED: Partial<Record<EventRecord["type"], Verdict>> = {
  "conflict.detected": { priority: 1, reason: "another agent is editing files you're working on" },
  "approval.requested": { priority: 1, reason: "you're the approver" },
  "approval.decided": { priority: 1, reason: "your approval request was decided" },
  "approval.expired": { priority: 1, reason: "your approval request expired without a decision" },
  // To the approver the request named: it no longer needs a decision. Not urgent, nothing is waiting on it now.
  "approval.withdrawn": { priority: 2, reason: "a request you were asked to decide was withdrawn" },
  "question.asked": { priority: 1, reason: "someone is waiting on your answer" },
  "question.answered": { priority: 1, reason: "your question was answered" },
  "message.sent": { priority: 2, reason: "a message to you" },
  "task.lease_expired": { priority: 2, reason: "your claim lapsed and the task is claimable by others" },
  "task.lane_changed": { priority: 2, reason: "someone moved a task you hold" },
  "agent.renamed": { priority: 2, reason: "a person renamed you" },
  "approval.grant_created": { priority: 2, reason: "you were granted time-boxed approval" },
  "approval.grant_revoked": { priority: 2, reason: "your time-boxed approval was revoked" },
  "approval.noted": { priority: 3, reason: "a risky command was noted for you" },
  "clearance.bypassed": { priority: 1, reason: "a risky command ran without the approval it needed" },
  // Advisory, once per computer per package per status per 24 h (src/connector-digest.ts): never resurfaced.
  "connector.notice": { priority: 2, reason: "this computer's OpenCadre connector" },
};

/** Types that are background context for teammates who aren't the target. */
const BACKGROUND = new Set<EventRecord["type"]>([
  "agent.phase_changed", "agent.task_changed",
  // A teammate going stale/suspended/resumed is fleet status, not a private notice to any one
  // agent -- it belongs alongside phase_changed/task_changed, not silently dropped by evaluate()
  // falling through to null. Someone waiting on that agent for a question, approval or handoff
  // needs to see it went quiet, even if only as a background count.
  "agent.stale", "agent.suspended", "agent.resumed",
  "task.created", "task.claimed", "task.released", "task.completed", "task.lane_changed",
  "question.asked", "question.answered", "conflict.detected",
  "approval.requested", "approval.decided", "approval.expired", "approval.noted", "approval.withdrawn",
  "clearance.bypassed", "clearance.policy_changed", "workspace.paused", "workspace.resumed",
  // A new WIP cap is context, not a call to act: awareness shows the caller's held count against it anyway.
  "project.settings_changed",
  "member.joined", "member.role_changed", "member.removed",
]);

const norm = (p: string) => p.trim().replace(/^\.\//, "").replace(/\/+$/, "");

/** True when one path is the other or contains it as a directory. */
function overlaps(scope: string, file: string): boolean {
  const a = norm(scope);
  const b = norm(file);
  if (!a || !b) return false;
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/** `actorProject` is the `agents.project` of the event's actor (null for a named agent or when unknown). */
export function evaluate(event: EventRecord, viewer: Viewer, actorProject: string | null = null): Verdict | null {
  if (event.actor_agent_id === viewer.agentId) return null;
  const payload = JSON.parse(event.payload) as Record<string, unknown>;

  if (event.target_agent_id === viewer.agentId) {
    const verdict = DIRECTED[event.type];
    if (!verdict) return null;
    if (event.type === "message.sent" && payload.priority === "high") return { priority: 1, reason: "a message to you marked high priority" };
    return verdict;
  }

  // Unlike decision.recorded, relevance never depends on file overlap: a new fleet-wide goal is
  // meant for every agent, not just whoever happens to be touching the same files right now.
  if (event.type === "goal.set") {
    return { priority: 2, reason: "the fleet's goal changed" };
  }

  if (event.type === "decision.recorded") {
    const scope = typeof payload.scope === "string" ? payload.scope : "";
    return sameProjectOrUnknown(viewer.project, actorProject) && viewer.files.some((f) => overlaps(scope, f))
      ? { priority: 2, reason: "a decision about files you're working on" }
      : { priority: 3, reason: "a decision elsewhere in the project" };
  }

  return BACKGROUND.has(event.type) ? { priority: 3, reason: "teammate activity" } : null;
}
