// Daemon core (docs/design/UNIVERSAL_WAKE.md, section 3 "Loop" and the guard table). One call
// to runWakeCycle() is one pass of: policy filter -> busy guard -> waiter-armed guard -> rate
// limit -> lease -> try adapters in tier order with verify/failover -> escalate on 3 failures.
//
// Pure orchestration: every side effect (lease files, adapter I/O, the clock, session-state
// verification) is injected, so this is unit-testable with a fake clock and fake adapters
// (scripts/wake-daemon/adapter.mjs) and needs no real Codex/Claude session to exercise.

import { acquireLease, releaseLease } from "./lease.mjs";
import { buildDigest, filterEligible } from "./policy.mjs";
import { canWake as bucketAllows, coalesce, recordVerifyFailure, recordVerifySuccess, recordWake } from "./rate-limiter.mjs";

const WAITER_ARMED_GRACE_MS = 60_000;
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

/**
 * @param {object} args
 * @param {import("./adapter.mjs").SessionState} args.session
 * @param {object[]} args.messages - candidate mail (already de-duplicated by the caller's cursor)
 * @param {import("./adapter.mjs").WakeAdapter[]} args.adapters - tried in array order (tier order)
 * @param {string} args.leaseDir
 * @param {object} args.limiterState - from initLimiterState(), one per session, kept by the caller
 * @param {() => number} [args.now]
 * @param {(sessionId: string) => Promise<string>} args.verifyStatus - reads current session status
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {(session: object, reason: string) => void} [args.onEscalate] - T6: hub already
 *   escalates unread-mail-by-time on its own (src/escalation.ts), independent of this daemon.
 *   This callback is a local hook for tests/observability, not a required call for T6 to fire.
 * @param {boolean} [args.wakeMedium]
 * @returns {Promise<{action: string, adapter?: string, reason?: string}>}
 */
export async function runWakeCycle({
  session,
  messages,
  adapters,
  leaseDir,
  limiterState,
  now = () => Date.now(),
  verifyStatus,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onEscalate,
  wakeMedium,
}) {
  const eligible = filterEligible(messages, session, { wakeMedium });
  if (eligible.length === 0) return { action: "none" };

  if (session.status === "busy" || session.status === "blocked") {
    return { action: "skipped", reason: "busy" };
  }

  if (typeof session.waiterArmedAt === "number" && now() - session.waiterArmedAt < WAITER_ARMED_GRACE_MS) {
    return { action: "skipped", reason: "waiter-armed" };
  }

  const bucket = bucketAllows(limiterState, now());
  if (!bucket.allow) {
    coalesce(limiterState, eligible.map((m) => m.id));
    return { action: "coalesced", reason: bucket.reason };
  }

  // Everything blocked by the bucket earlier now rides along in this digest too.
  const idsForDigest = new Set([...limiterState.pending, ...eligible.map((m) => m.id)]);
  const digestMessages = eligible.filter((m) => idsForDigest.has(m.id));
  const digest = buildDigest(digestMessages.length > 0 ? digestMessages : eligible);

  const lease = acquireLease(leaseDir, session.sessionId, { messageIds: digest.ids, adapter: null, ttlMs: DEFAULT_LEASE_TTL_MS, now: now() });
  if (!lease) return { action: "skipped", reason: "lease-active" };

  try {
    for (const adapter of adapters) {
      if (!(await adapter.detect())) continue;

      const gate = await adapter.canWake(session, digest);
      if (!gate.ok) continue; // locked/busy/no-owner/disabled: fail over to the next tier at once

      const result = await adapter.wake(session, digest);
      if (!result.attempted) continue; // adapter declined at the last moment (e.g. T3 found itself locked): next tier, no retry

      const verified = await waitForBusy(session.sessionId, verifyStatus, adapter.verifyMs, sleep);
      if (verified) {
        recordWake(limiterState, now());
        recordVerifySuccess(limiterState);
        return { action: "woke", adapter: adapter.id };
      }

      const justEscalated = recordVerifyFailure(limiterState);
      if (justEscalated) {
        onEscalate?.(session, "3 consecutive verify failures; deferring to hub T6 escalation");
        return { action: "escalated", reason: "verify-failures" };
      }
      // verify timed out: fall through to the next tier (doc: "verify timeout -> next tier")
    }
    return { action: "exhausted" };
  } finally {
    releaseLease(leaseDir, session.sessionId);
  }
}

async function waitForBusy(sessionId, verifyStatus, verifyMs, sleep) {
  const deadline = Date.now() + verifyMs;
  for (;;) {
    const status = await verifyStatus(sessionId);
    if (status === "busy") return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(25, deadline - Date.now()));
  }
}
