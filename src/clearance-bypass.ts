import { db } from "./db.js";
import { emitEvent } from "./events.js";
import { requestApproval } from "./approvals.js";
import type { Risk } from "./approvals.js";
import { resolveAddressable, sendMessage } from "./service.js";
import { maskAndCap } from "./secrets.js";
import { stampFor } from "./project-stamps.js";
import { operatorsFor, projectLabel } from "./scope.js";

/** Post-execution clearance reports (R4). A hook that runs after a command (where the client has no
 * in-path gate, or a gate let a command through without a decision) reports each risky command it
 * saw run. The hub checks it against the clearance record:
 *   required "record"   (notify): the record is created now if the gate didn't make one.
 *   required "approval" (ask/strict): no approval for this command → clearance.bypassed, and the
 *   approver (or else the workspace's operators) gets one notice. Repeat reports are not re-announced. */

export type ClearanceRequirement = "record" | "approval";
export type ExecutedOutcome = "recorded" | "already_recorded" | "approved" | "bypassed" | "already_reported";

/** A gate's record and the post-execution report of the same command fall inside this window. */
const WINDOW = "-30 minutes";
const MAX_ACTION_CHARS = 500;

type Agent = { id: string; name: string };

export async function reportExecuted(
  orgId: string,
  agent: Agent,
  input: { action: string; required: ClearanceRequirement; category?: string | null; risk?: Risk; approver?: string | null; details?: string | null },
): Promise<{ outcome: ExecutedOutcome; approvalId?: string }> {
  // Masked before anything else, as requestApproval stores it, so the record lookup below compares like with like.
  // Cut exactly like the gate cuts (no ellipsis), after masking; only a bounded prefix is scanned.
  const action = maskAndCap(input.action.trim(), MAX_ACTION_CHARS, "");
  if (!action) throw new Error("action is required");
  const category = input.category?.trim() || null;
  // The approver must be reachable from the reporting agent's project (throws NotReachableError otherwise).
  const approver = input.approver ? resolveAddressable(orgId, input.approver, agent) : null;
  if (input.approver && !approver) throw new Error(`No agent found matching approver "${input.approver}"`);

  // An "approved" row counts only with a person behind it (person approvals, migration 53; a grant's auto-approval
  // records its person too). One no person decided -- an agent's decision from before 53 -- is not a clearance, and is
  // reported as what it is rather than as "approved".
  const records = (db.prepare(
    `SELECT id, status, decided_by_person_id FROM approvals
     WHERE org_id = ? AND requested_by_agent_id = ? AND action = ? AND created_at >= datetime('now', ?)
     ORDER BY created_at DESC, rowid DESC`,
  ).all(orgId, agent.id, action, WINDOW) as Array<{ id: string; status: string; decided_by_person_id: string | null }>)
    .map((r) => ({ id: r.id, byPerson: Boolean(r.decided_by_person_id), status: r.status === "approved" && !r.decided_by_person_id ? "approved_without_person" : r.status }));

  if (input.required === "record") {
    if (records.length) return { outcome: "already_recorded", approvalId: records[0].id };
    const noted = await requestApproval(orgId, agent, {
      action, category, risk: input.risk, approver: approver?.name ?? null, notifyOnly: true,
      // requestApproval masks and caps details.
      details: input.details ?? "Reported after the command ran (this client has no gate before execution).",
    });
    return { outcome: "recorded", approvalId: noted.id };
  }

  const approved = records.find((r) => r.status === "approved" && r.byPerson);
  if (approved) return { outcome: "approved", approvalId: approved.id };

  // Synchronous check-and-emit: better-sqlite3 runs it atomically, so concurrent reports announce once.
  const fresh = db.transaction(() => {
    const earlier = db.prepare(
      `SELECT payload FROM events
       WHERE org_id = ? AND type = 'clearance.bypassed' AND actor_agent_id = ? AND created_at >= datetime('now', ?)`,
    ).all(orgId, agent.id, WINDOW) as Array<{ payload: string }>;
    if (earlier.some((e) => (JSON.parse(e.payload) as { action?: string }).action === action)) return false;
    emitEvent({
      orgId, type: "clearance.bypassed", actor: agent, subjectType: "clearance", subjectId: agent.id,
      targetAgentId: approver?.id ?? null,
      payload: { action, ...(category ? { category } : {}), ...(records[0] ? { lastStatus: records[0].status, approvalId: records[0].id } : {}) },
    });
    return true;
  })();
  if (!fresh) return { outcome: "already_reported" };

  // Without an approver: operator people, plus operator agents that can see this agent's project (PROJECT_ISOLATION.md §5).
  const project = stampFor(orgId, agent.id);
  const recipients = approver ? [approver.id] : operatorsFor(orgId, project, { orderBy: "created_at" }).filter((id) => id !== agent.id);
  const why = !records[0] ? "no clearance was requested"
    : records[0].status === "approved_without_person" ? "its clearance request was never approved by a person"
      : `its clearance request ended ${records[0].status}`;
  for (const id of recipients) {
    // skipDuplicateCheck: intentional fan-out of one bypass notice to every relevant operator, not
    // an accidental repeat (src/service.ts's duplicate-send guard).
    await sendMessage(orgId, agent, id,
      `CLEARANCE BYPASSED${projectLabel(orgId, project)}: ${agent.name} ran a${category ? ` ${category}` : " risky"} command that needed approval, and ${why}: ${maskAndCap(action, 300, "")}`,
      "high", null, { skipDuplicateCheck: true });
  }
  return { outcome: "bypassed" };
}

/** Policy passes (F7 / board Q1f; Codex ruling corrections 1, 2 and 5). A gate whose onTimeout / onHubUnreachable is
 * "allow" answers NO OPINION: the command goes back to the tool's own permission settings. That is not an approval (no
 * person decided anything in OpenCadre) and not an execution (the tool may still deny it, die first, or never run it;
 * only a post-tool report, above, says a command ran). So it is recorded as what it is: `clearance.policy_pass`, with
 * `outcome: "handed_back"` and nothing about who decided next.
 *
 * Deduplicated by the gate's receipt id: a record queued offline is retried under the same id, and recorded once. */
export type PolicyPassReason = "timeout" | "hub_unreachable";
export const POLICY_PASS_REASONS: readonly PolicyPassReason[] = ["timeout", "hub_unreachable"];
/** A queued record is kept 7 days on the gate's machine; the hub's duplicate check looks back a little further. */
const POLICY_PASS_WINDOW = "-8 days";

export function recordPolicyPass(
  orgId: string,
  agent: Agent,
  input: {
    receiptId: string; reason: PolicyPassReason; action: string; category?: string | null; risk?: Risk;
    approvalId?: string | null; client?: string | null; project?: string | null; occurredAt: string; delivery: "live" | "queued";
  },
): { outcome: "recorded" | "already_recorded" } {
  const action = maskAndCap(input.action.trim(), MAX_ACTION_CHARS, "");
  if (!action) throw new Error("action is required");
  const payload = {
    receiptId: input.receiptId,
    reason: input.reason,
    outcome: "handed_back",
    handedBackTo: "client_permission_settings",
    action,
    ...(input.category ? { category: input.category } : {}),
    ...(input.risk ? { risk: input.risk } : {}),
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    ...(input.client ? { client: input.client } : {}),
    ...(input.project ? { project: input.project } : {}),
    occurredAt: input.occurredAt,
    delivery: input.delivery,
  };
  const fresh = db.transaction(() => {
    const earlier = db.prepare(
      `SELECT payload FROM events
       WHERE org_id = ? AND type = 'clearance.policy_pass' AND actor_agent_id = ? AND created_at >= datetime('now', ?)`,
    ).all(orgId, agent.id, POLICY_PASS_WINDOW) as Array<{ payload: string }>;
    if (earlier.some((e) => (JSON.parse(e.payload) as { receiptId?: string }).receiptId === input.receiptId)) return false;
    emitEvent({ orgId, type: "clearance.policy_pass", actor: agent, subjectType: "clearance", subjectId: agent.id, payload });
    return true;
  })();
  return { outcome: fresh ? "recorded" : "already_recorded" };
}
