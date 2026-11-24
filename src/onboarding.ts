import { db } from "./db.js";
import { SYSTEM_SENDER } from "./escalation.js";

/** First-run checklist (R5). Every step is computed from what actually happened in the workspace, so progress is
 * persisted by construction and can't drift from reality: a step is done because the thing exists, not because
 * someone ticked a box. */

export type OnboardingStepId = "first_agent" | "second_agent" | "first_message" | "first_clearance";

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
  /** When it first became true, where the workspace records that. */
  doneAt: string | null;
  /** A short fact the console can show next to the step, e.g. which agent connected. Never a key or message body. */
  detail: string | null;
}

// Connected agents are the ones someone set up to do work: not people in the console, not a person's first signup key.
const CONNECTED_AGENTS = `SELECT name, created_at FROM agents WHERE org_id = ? AND role = 'agent' AND key_class IN ('agent', 'watcher') AND removed_at IS NULL ORDER BY created_at, rowid LIMIT 2`;

export function onboardingProgress(orgId: string): { steps: OnboardingStep[]; completed: number; total: number } {
  const agents = db.prepare(CONNECTED_AGENTS).all(orgId) as Array<{ name: string; created_at: string }>;
  const firstMessage = db.prepare(
    `SELECT created_at, from_agent_name, to_agent_name FROM messages
     WHERE org_id = ? AND from_agent_id != ? AND to_agent_id IS NOT NULL ORDER BY created_at, rowid LIMIT 1`,
  ).get(orgId, SYSTEM_SENDER.id) as { created_at: string; from_agent_name: string; to_agent_name: string } | undefined;
  const firstClearance = db.prepare(
    `SELECT created_at, requested_by_agent_name, category, status FROM approvals WHERE org_id = ? ORDER BY created_at, rowid LIMIT 1`,
  ).get(orgId) as { created_at: string; requested_by_agent_name: string; category: string | null; status: string } | undefined;

  const steps: OnboardingStep[] = [
    { id: "first_agent", done: agents.length >= 1, doneAt: agents[0]?.created_at ?? null, detail: agents[0]?.name ?? null },
    { id: "second_agent", done: agents.length >= 2, doneAt: agents[1]?.created_at ?? null, detail: agents[1]?.name ?? null },
    {
      id: "first_message",
      done: Boolean(firstMessage),
      doneAt: firstMessage?.created_at ?? null,
      detail: firstMessage ? `${firstMessage.from_agent_name} → ${firstMessage.to_agent_name}` : null,
    },
    {
      id: "first_clearance",
      done: Boolean(firstClearance),
      doneAt: firstClearance?.created_at ?? null,
      detail: firstClearance ? `${firstClearance.requested_by_agent_name}${firstClearance.category ? ` · ${firstClearance.category}` : ""} (${firstClearance.status})` : null,
    },
  ];
  return { steps, completed: steps.filter((s) => s.done).length, total: steps.length };
}
