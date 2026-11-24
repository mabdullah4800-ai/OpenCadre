import { resolveAllApprovalWaiters } from "./approvals.js";
import { setDraining } from "./draining.js";
import { resolveAllEventWaiters } from "./events.js";
import { resolveAllInboxWaiters } from "./live.js";

/** Stops new long-polls from holding and releases every held one (mail, timeline, approvals), so
 * clients get an answer and re-poll against the next process instead of hanging on a dead socket. */
export function beginShutdown(): void {
  setDraining(true);
  resolveAllInboxWaiters();
  resolveAllEventWaiters();
  resolveAllApprovalWaiters();
}
