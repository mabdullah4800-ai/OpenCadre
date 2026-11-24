import { describe, expect, it } from "vitest";
import {
  canWake, coalesce, initLimiterState, MAX_PER_HOUR, MAX_VERIFY_FAILURES,
  recordVerifyFailure, recordVerifySuccess, recordWake,
} from "../scripts/wake-daemon/rate-limiter.mjs";

describe("wake-daemon rate limiter", () => {
  it("allows the first wake, then refuses within the 2-minute cooldown", () => {
    const state = initLimiterState();
    expect(canWake(state, 0)).toEqual({ allow: true });
    recordWake(state, 0);
    expect(canWake(state, 60_000)).toEqual({ allow: false, reason: "cooldown" });
    expect(canWake(state, 120_000)).toEqual({ allow: true });
  });

  it("refuses the 11th wake within one rolling hour", () => {
    const state = initLimiterState();
    let t = 0;
    for (let i = 0; i < MAX_PER_HOUR; i++) {
      expect(canWake(state, t)).toEqual({ allow: true });
      recordWake(state, t);
      t += 2 * 60_000 + 1; // clear the cooldown each time, stay under an hour total drift is fine
    }
    expect(canWake(state, t)).toEqual({ allow: false, reason: "hourly-limit" });
  });

  it("an hour-old wake ages out of the hourly bucket", () => {
    const state = initLimiterState();
    for (let i = 0; i < MAX_PER_HOUR; i++) recordWake(state, i * 1000);
    expect(canWake(state, 61 * 60_000)).toEqual({ allow: true });
  });

  it("coalesces mail ids blocked by the bucket without duplicates", () => {
    const state = initLimiterState();
    coalesce(state, ["a", "b"]);
    coalesce(state, ["b", "c"]);
    expect(state.pending).toEqual(["a", "b", "c"]);
  });

  it("recordWake clears whatever was pending", () => {
    const state = initLimiterState();
    coalesce(state, ["a"]);
    recordWake(state, 0);
    expect(state.pending).toEqual([]);
  });

  it("hard-stops after 3 consecutive verify failures, and reports the trip exactly once", () => {
    const state = initLimiterState();
    expect(recordVerifyFailure(state)).toBe(false);
    expect(recordVerifyFailure(state)).toBe(false);
    expect(state.verifyFailures).toBe(MAX_VERIFY_FAILURES - 1);
    expect(recordVerifyFailure(state)).toBe(true); // trips here
    expect(recordVerifyFailure(state)).toBe(false); // already escalated: not reported again
    expect(canWake(state, 1_000_000)).toEqual({ allow: false, reason: "escalated" });
  });

  it("a verify success resets the failure streak", () => {
    const state = initLimiterState();
    recordVerifyFailure(state);
    recordVerifyFailure(state);
    recordVerifySuccess(state);
    expect(state.verifyFailures).toBe(0);
    expect(recordVerifyFailure(state)).toBe(false);
  });
});
