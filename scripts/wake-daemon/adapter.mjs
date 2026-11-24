// WakeAdapter interface (docs/design/UNIVERSAL_WAKE.md, section 3) and a fake adapter for
// tests / the verify-failover harness. Plain JS with JSDoc — no build step needed to use it
// from scripts/, and vitest doesn't type-check test files, so this stays dependency-free.
//
// One deliberate deviation from the doc's literal TypeScript signature: canWake here receives
// (session, digest) instead of just (session). T3 headless-resume adapters (scripts/wake-daemon/
// t3-resume.mjs) cannot tell a locked thread from a free one without attempting the actual
// resume command, and that command needs the digest to build its prompt/args — so canWake and
// wake share one memoized invocation for those adapters. Adapters that don't need it (T1/T2/T4/T5)
// simply ignore the second argument.
//
/**
 * @typedef {Object} SessionState
 * @property {string} sessionId
 * @property {string} [threadId]
 * @property {string} [surface]
 * @property {string} [agentId]
 * @property {"busy"|"idle"|"blocked"|"gone"} status
 * @property {string} [since]
 * @property {number} [waiterArmedAt]
 */
/**
 * @typedef {Object} WakeDigest
 * @property {string[]} ids
 * @property {"high"|"medium"} top
 * @property {string} line
 */
/**
 * @typedef {Object} WakeAdapter
 * @property {string} id
 * @property {1|2|3|4|5} tier
 * @property {() => Promise<boolean>} detect
 * @property {(session: SessionState, digest: WakeDigest) => Promise<{ok: boolean, reason?: "locked"|"busy"|"no-owner"|"disabled"}>} canWake
 * @property {(session: SessionState, digest: WakeDigest) => Promise<{attempted: boolean, detail: string}>} wake
 * @property {number} verifyMs
 * @property {"zero"|"per-tick"} idleTokenCost
 */

/** A WakeAdapter double for unit tests and the verify/failover harness. Every behaviour is
 * overridable so a test can force detect()=false, a locked/busy canWake, a failed wake, or a
 * verify that never lands (drive verifyStatus to keep returning "idle" past verifyMs). */
export function fakeAdapter(overrides = {}) {
  const calls = { detect: 0, canWake: 0, wake: 0 };
  const adapter = {
    id: overrides.id ?? "fake",
    tier: overrides.tier ?? 1,
    verifyMs: overrides.verifyMs ?? 200,
    idleTokenCost: overrides.idleTokenCost ?? "zero",
    async detect() {
      calls.detect++;
      return overrides.detectResult ?? true;
    },
    async canWake(session, digest) {
      calls.canWake++;
      if (overrides.canWake) return overrides.canWake(session, digest);
      return overrides.canWakeResult ?? { ok: true };
    },
    async wake(session, digest) {
      calls.wake++;
      if (overrides.wake) return overrides.wake(session, digest);
      overrides.onWake?.(session, digest);
      return overrides.wakeResult ?? { attempted: true, detail: `fake:${adapter.id}` };
    },
  };
  Object.defineProperty(adapter, "calls", { value: calls, enumerable: false });
  return adapter;
}
