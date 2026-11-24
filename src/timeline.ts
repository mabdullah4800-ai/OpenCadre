import { listEvents, waitForEvents, type EventRecord } from "./events.js";
import { sweepExpiredLeases } from "./tasks.js";
import { sweepExpiredApprovals } from "./approvals.js";
import { retentionCutoff } from "./retention.js";

/** Timeline reads. Lease and approval expiry happen silently in storage, so
 * their events are emitted here, just before anyone looks at the timeline.
 * `viewer` is the reading agent: its project scope filters what it gets (src/scope.ts). */

export function sweepTimeline(orgId: string): void {
  sweepExpiredLeases(orgId);
  sweepExpiredApprovals(orgId);
}

/** The workspace's history, minus anything past its plan's retention window (PRICING.md §8 item 2).
 *
 * Retention gates the history reader and nothing else. The cutoff is an opt-in `listEvents`
 * argument applied in SQL before LIMIT; live waiters and deliveries do not supply it.
 * Applying a JS filter after LIMIT let expired rows consume a page and hide live rows behind them. */
export function listTimeline(orgId: string, options: { after?: number; types?: string[]; limit?: number; latest?: boolean; viewer?: string; subject?: { type: string; id: string } } = {}): EventRecord[] {
  sweepTimeline(orgId);
  return listEvents(orgId, { ...options, createdAtOrAfter: retentionCutoff(orgId) });
}

export function waitForTimeline(orgId: string, after: number, timeoutSeconds: number, types?: string[], viewer?: string): Promise<EventRecord[]> {
  sweepTimeline(orgId);
  return waitForEvents(orgId, after, timeoutSeconds, types, viewer);
}
