// The emulated desktop entrypoint's verdicts (scripts/dev/claude-desktop-emu-verdicts.ts). Review 049a on #671: the
// instrument must not certify a run whose prerequisites were not met. Each case is a state the live run can reach.
import { describe, expect, it } from "vitest";
import { baselineVerdict, controlVerdict, overallVerdict, preMailVerdict, wakeVerdict, type Probe } from "../scripts/dev/claude-desktop-emu-verdicts.js";

const running = (results: number, over: Partial<Probe> = {}): Probe => ({ results, firstResultOk: results >= 1 ? true : null, exitCode: null, exited: false, ...over });
const exited = (results: number, code: number | null = 0): Probe => ({ ...running(results), exited: true, exitCode: code });
const LEGS = ["baseline", "identity", "idle-before-mail", "mail-idle-wake", "mail-control"];

describe("baseline", () => {
  it("passes only when every session finished one successful turn and is still running", () => {
    expect(baselineVerdict(true, { A: running(1), B: running(1), C: running(1) }).status).toBe("PASS");
  });
  it("an incomplete baseline (the wait timed out, a first turn never finished) is inconclusive, not a pass", () => {
    const v = baselineVerdict(false, { A: running(1), B: running(1), C: running(0) });
    expect(v.status).toBe("INCONCLUSIVE");
    expect(v.detail).toContain("timed out");
    expect(v.detail).toContain("C never finished its first turn");
  });
  it("a first turn that ended in an error is inconclusive", () => {
    expect(baselineVerdict(true, { A: running(1, { firstResultOk: false }), C: running(1) }).status).toBe("INCONCLUSIVE");
  });
  it("a session that exited after its first turn is inconclusive", () => {
    expect(baselineVerdict(true, { A: running(1), C: exited(1) }).detail).toContain("C exited");
  });
});

describe("idle before the mail", () => {
  it("an extra turn before the mail is inconclusive: a later 'wake' could be a turn already under way", () => {
    expect(preMailVerdict({ A: running(2), C: running(1) }).status).toBe("INCONCLUSIVE");
    expect(preMailVerdict({ A: running(1), C: running(1) }).status).toBe("PASS");
  });
});

describe("wake", () => {
  const base = { resultsAtMail: 1, replied: true, typedSinceMail: 0, seconds: "8.4", windowSeconds: 120, idleSeconds: 20, nonce: "n" };
  it("passes on a new turn plus the PONG reply, with nothing typed", () => {
    expect(wakeVerdict(running(2), base).status).toBe("PASS");
  });
  it("fails when A stayed idle and running", () => {
    expect(wakeVerdict(running(1), { ...base, replied: false }).status).toBe("FAIL");
  });
  it("is inconclusive when A exited before waking, or something was typed", () => {
    expect(wakeVerdict(exited(1), { ...base, replied: false }).status).toBe("INCONCLUSIVE");
    expect(wakeVerdict(running(2), { ...base, typedSinceMail: 1 }).status).toBe("INCONCLUSIVE");
  });
});

describe("the control", () => {
  const base = { resultsAtMail: 1, replied: false, windowSeconds: 120 };
  it("passes when it stayed idle AND alive through the window", () => {
    expect(controlVerdict(running(1), base).status).toBe("PASS");
  });
  it("a control that exited after its initial setup is inconclusive, never a pass: a dead control is silent too", () => {
    const v = controlVerdict(exited(1), base);
    expect(v.status).toBe("INCONCLUSIVE");
    expect(v.detail).toContain("the control exited");
  });
  it("fails when it woke or replied", () => {
    expect(controlVerdict(running(2), base).status).toBe("FAIL");
    expect(controlVerdict(running(1), { ...base, replied: true }).status).toBe("FAIL");
  });
});

describe("the run", () => {
  const all = LEGS.map((leg) => ({ leg, status: "PASS" as const }));
  it("passes only when every leg ran and passed", () => {
    expect(overallVerdict(LEGS, all)).toEqual({ verdict: "PASS", passed: 5, exitCode: 0 });
  });
  it("a run stopped at an inconclusive baseline is inconclusive (exit 2), not a pass", () => {
    expect(overallVerdict(LEGS, [{ leg: "baseline", status: "INCONCLUSIVE" }])).toEqual({ verdict: "INCONCLUSIVE", passed: 0, exitCode: 2 });
  });
  it("an inconclusive control makes the run inconclusive even when the wake passed", () => {
    expect(overallVerdict(LEGS, all.map((r) => (r.leg === "mail-control" ? { ...r, status: "INCONCLUSIVE" as const } : r))).verdict).toBe("INCONCLUSIVE");
  });
  it("any failed leg fails the run", () => {
    expect(overallVerdict(LEGS, all.map((r) => (r.leg === "identity" ? { ...r, status: "FAIL" as const } : r))).exitCode).toBe(1);
  });
});
