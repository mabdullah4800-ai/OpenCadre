import { describe, expect, it } from "vitest";
import { SESSION_ABSENT, SESSION_INDETERMINATE, resolveSessionId } from "../scripts/opencadre-config.mjs";

/**
 * The absent-vs-indeterminate SELECTOR.
 *
 * `sessionIdOrNull` returns null for BOTH "the variable was never set" and "the variable
 * was set to something unusable", so by the time a caller holds its result the two cases
 * are indistinguishable. That collapse is what this increment exists to undo: the two
 * situations need different things said about them, because an absent variable is usually
 * a configuration or harness problem the user did not cause, while a malformed one is a
 * value they can see and fix.
 *
 * This test pins the SPLIT independent of the user-facing copy. The copy has its own
 * tests (tests/mcp-proxy.test.ts); if those were the only coverage, a resolver that
 * collapsed the two reasons would be caught only indirectly, through a message string,
 * and a future copy edit could quietly take the discriminator with it.
 *
 * The load-bearing property is not "it returns the right reason" but:
 *   it NEVER substitutes a value. A defaulted id would name a different session, and with
 *   a machine-wide credential it would silently make every chat on the box one agent.
 *
 * Written by DeepSeek-D2V6 (reviewer).
 */

// The hub's own rule for session ids, mirrored here so the boundary cases are explicit:
// printable ASCII, no spaces, 1..200 characters.
const VALID = "sess-abc-123";
const SPACES = "not a valid session id";
const NEWLINE = "abc\ndef";
const TOO_LONG = "x".repeat(201);
const EMPTY = "";
const WHITESPACE_ONLY = "   ";

describe("resolveSessionId: absent and indeterminate are DISTINCT reasons", () => {
  it("absent cases report SESSION_ABSENT, never indeterminate", () => {
    const absent = [
      { label: "no source at all", args: {} },
      { label: "source present but undefined", args: { source: undefined } },
      { label: "unknown from value", args: { source: { from: "nonsense" } } },
      { label: "env source, variable missing", args: { source: { from: "env", name: "NOT_SET_ANYWHERE" }, env: {} } },
      {
        label: "env source, variable explicitly null",
        args: { source: { from: "env", name: "X" }, env: { X: null } },
      },
    ];
    for (const { label, args } of absent) {
      const r = resolveSessionId(args);
      expect(r.ok, `${label}: expected a refusal`).toBe(false);
      expect(r.reason, `${label}: expected absent`).toBe(SESSION_ABSENT);
    }
  });

  it("present-but-unusable values report SESSION_INDETERMINATE, never absent", () => {
    const indeterminate = [
      { label: "spaces", value: SPACES },
      { label: "newline", value: NEWLINE },
      { label: "over 200 chars", value: TOO_LONG },
      { label: "empty string", value: EMPTY },
      { label: "whitespace only", value: WHITESPACE_ONLY },
    ];
    for (const { label, value } of indeterminate) {
      const r = resolveSessionId({ source: { from: "env", name: "X" }, env: { X: value } });
      expect(r.ok, `${label}: expected a refusal`).toBe(false);
      expect(r.reason, `${label}: expected indeterminate`).toBe(SESSION_INDETERMINATE);
    }
    // A caller-supplied value goes through the same rule, so a malformed one is
    // indeterminate for the same reason: it was SET, and it is unusable.
    const supplied = resolveSessionId({ source: { from: "env", name: "X" }, sessionId: SPACES, env: {} });
    expect(supplied.ok).toBe(false);
    expect(supplied.reason).toBe(SESSION_INDETERMINATE);
  });

  it("THE COLLAPSE THIS PREVENTS: both cases used to be one indistinguishable null", () => {
    // Same rejected input, two different causes, two different reasons. If this ever
    // returns one value for both, the split has silently regressed to the old behaviour.
    const absent = resolveSessionId({ source: { from: "env", name: "MISSING" }, env: {} });
    const indeterminate = resolveSessionId({ source: { from: "env", name: "X" }, env: { X: SPACES } });
    expect(absent.reason).not.toBe(indeterminate.reason);
    expect([absent.reason, indeterminate.reason].sort()).toEqual([SESSION_ABSENT, SESSION_INDETERMINATE].sort());
  });

  it("NEVER substitutes a value: a refusal carries no id, for either reason", () => {
    // The property that matters most. A defaulted id would name a different session,
    // and with a machine-wide credential every chat on the box would become one agent.
    const refusals = [
      resolveSessionId({ source: { from: "env", name: "MISSING" }, env: {} }),
      resolveSessionId({ source: { from: "env", name: "X" }, env: { X: SPACES } }),
      resolveSessionId({}),
    ];
    for (const r of refusals) {
      expect(r.ok).toBe(false);
      expect(r, "a refusal must not carry an id").not.toHaveProperty("id");
      expect(r.id).toBeUndefined();
    }
  });

  it("a valid id is returned verbatim, and a caller-supplied id wins", () => {
    const fromEnv = resolveSessionId({ source: { from: "env", name: "X" }, env: { X: VALID } });
    expect(fromEnv).toEqual({ ok: true, id: VALID });

    const supplied = resolveSessionId({ source: { from: "env", name: "X" }, sessionId: "supplied-1", env: {} });
    expect(supplied).toEqual({ ok: true, id: "supplied-1" });
  });

  it("a process-declared source synthesizes a distinct id per call, never a constant", () => {
    const a = resolveSessionId({ source: { from: "process", name: "codex" } });
    const b = resolveSessionId({ source: { from: "process", name: "codex" } });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.id).toMatch(/^codex-/);
    // Two sessions must not collapse into one identity.
    expect(a.id).not.toBe(b.id);
  });
});