// Wake rate limiter (docs/design/UNIVERSAL_WAKE.md, section 3, "Rate limit" guard):
// token bucket per session, 1 wake per 2 min, 10 per hour, coalesce blocked mail into one
// digest, hard stop after 3 failed verifies (T6 takes over from there).
//
// Pure functions over a plain state object so tests can drive them with a fake clock instead
// of real timers (mirrors src/escalation.ts's sweepEscalations(now) pattern). The daemon keeps
// one state object per sessionId for its process lifetime.

export const COOLDOWN_MS = 2 * 60_000;
export const HOUR_MS = 60 * 60_000;
export const MAX_PER_HOUR = 10;
export const MAX_VERIFY_FAILURES = 3;

export function initLimiterState() {
  return {
    wakes: [], // timestamps of completed (verified) wakes, for the token bucket
    verifyFailures: 0,
    escalated: false, // hard stop: once true, canWake never allows another wake for this session
    pending: [], // message ids blocked by the bucket, waiting to be coalesced into the next wake
  };
}

/** Whether a new wake may be attempted right now. Does not mutate. */
export function canWake(state, now = Date.now()) {
  if (state.escalated) return { allow: false, reason: "escalated" };
  const lastWake = state.wakes[state.wakes.length - 1];
  if (lastWake !== undefined && now - lastWake < COOLDOWN_MS) return { allow: false, reason: "cooldown" };
  const withinHour = state.wakes.filter((t) => now - t < HOUR_MS);
  if (withinHour.length >= MAX_PER_HOUR) return { allow: false, reason: "hourly-limit" };
  return { allow: true };
}

/** Mail that arrived while canWake() was refusing: coalesce it instead of dropping it, so the
 * next allowed wake covers everything at once. */
export function coalesce(state, messageIds) {
  const seen = new Set(state.pending);
  for (const id of messageIds) if (!seen.has(id)) { state.pending.push(id); seen.add(id); }
  return state.pending;
}

/** Call once a wake has actually been attempted (consumes the bucket slot and any coalesced
 * mail folded into this attempt). */
export function recordWake(state, now = Date.now()) {
  state.wakes = [...state.wakes.filter((t) => now - t < HOUR_MS), now];
  state.pending = [];
}

/** Call when a wake's verify step timed out. Returns true the moment the hard stop trips
 * (3rd consecutive failure), so the caller knows to escalate to T6 exactly once. */
export function recordVerifyFailure(state) {
  state.verifyFailures += 1;
  if (state.verifyFailures >= MAX_VERIFY_FAILURES) {
    const justTripped = !state.escalated;
    state.escalated = true;
    return justTripped;
  }
  return false;
}

/** Call when a wake verified successfully: clears the failure streak so a later transient
 * failure doesn't inherit an old count. */
export function recordVerifySuccess(state) {
  state.verifyFailures = 0;
}
