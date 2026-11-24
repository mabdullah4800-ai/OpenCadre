/** Where a client's session id comes from, and what happens when it cannot be determined.
 *
 * WHY THIS FILE EXISTS, AND WHAT IT DELIBERATELY DOES NOT DO: the credential migration from the
 * per-tool shape to the single machine credential is ALREADY tested end-to-end - tests/connect-cli
 * ("migrates today's per-tool credential to the computer entry on the next connect") covers the
 * shape change, the legacy key going, a foreign key surviving, and the credential never reaching
 * output; tests/opencadre-config covers the reader preferring the computer entry and falling back
 * to the tool entry. A reviewer checked and confirmed that, and a first draft of this file
 * re-asserted it under a new name. Duplicating passing coverage under a second title adds no
 * evidence and does inflate the record, so this file was cut back to the part that is genuinely
 * uncovered.
 *
 * WHAT IS NEW IN INCREMENT 2 is the SELECTOR. `sessionIdOrNull` collapsed "the variable was never
 * set" and "the variable was set to something unusable" into the same `null`, so no caller could
 * tell them apart and neither could say anything useful about them. `resolveSessionId` keeps the
 * two apart and never substitutes a value.
 */
import { describe, expect, it } from "vitest";
import { resolveSessionId, SESSION_ABSENT, SESSION_INDETERMINATE } from "../scripts/opencadre-config.mjs";
import { sessionIdSourceFor, COMPUTER_TOOLS, MEASURING_CLIENTS, CLIENT_NAMES } from "../scripts/opencadre-clients.mjs";

const ENV_SOURCE = { from: "env", name: "SOME_SESSION_ID" };
// NOTE: `source` deliberately has NO default. A default would make an explicit `undefined` silently
// mean "the env source", so the "no declaration at all" cases below would test nothing.
const resolve = (env, source) => resolveSessionId({ source, env });

describe("session id source: the table declares where each client's identity comes from", () => {
  it("every served client either declares a source OR is hook-served, and no unserved client does either", () => {
    // A client that is served must be able to name its sessions; a client still being measured has
    // no identity to derive yet, so a source on it would be an unanswered question pretending to be
    // an answer. Both halves matter: the first catches a client added without a declaration, the
    // second catches a declaration quietly attached to a client that is not served.
    //
    // AMENDED FOR DSH, which is a genuine THIRD CASE rather than a client missing a declaration.
    // When a harness delivers its id PER EVENT, the hook passes it as a caller-supplied id, and
    // resolveSessionId honours that BEFORE consulting any declaration - so a declaration would be
    // redundant here and, for DSH specifically, unsatisfiable: DSH never puts the id in its own
    // process env and DSH_* is not inherited by children. This is #197's Antigravity conclusion
    // reached a second time.
    //
    // The list is explicit rather than a rule, so a client cannot become hook-served by accident:
    // adding one here is a deliberate statement that its id arrives per event.
    const HOOK_SERVED = new Set(["dsh"]);
    for (const client of COMPUTER_TOOLS) {
      if (HOOK_SERVED.has(client)) {
        // And it must genuinely have NO declaration - the hook's supplied id is the mechanism.
        expect(sessionIdSourceFor(client), `${client} is hook-served and must not declare a source`).toBeUndefined();
        continue;
      }
      expect(sessionIdSourceFor(client), `${client} is served and must declare a source`).toBeDefined();
    }
    for (const client of MEASURING_CLIENTS) {
      expect(sessionIdSourceFor(client), `${client} is not served and must not declare one`).toBeUndefined();
    }
    expect(COMPUTER_TOOLS.length + MEASURING_CLIENTS.length).toBe(CLIENT_NAMES.length);
    // The hook-served list must not rot: every name in it must still be a served client.
    for (const client of HOOK_SERVED) {
      expect(COMPUTER_TOOLS, `${client} is listed as hook-served but is not a served client`).toContain(client);
    }
  });

  it("a hook-served client resolves from a CALLER-SUPPLIED id with no declaration at all", () => {
    // The property that makes "no declaration" safe rather than an omission: the caller-supplied
    // path is checked first, so the hook's id works without the row declaring anything.
    const supplied = resolveSessionId({ sessionId: "session-from-hook-payload", env: {} });
    expect(supplied).toEqual({ ok: true, id: "session-from-hook-payload" });
    // ...while the env route DSH would have declared is unsatisfiable in a child's environment,
    // which is why declaring it would certify an identity path that never runs.
    const viaEnv = resolveSessionId({ source: { from: "env", name: "DSH_SESSION_ID" }, env: { PATH: "/usr/bin" } });
    expect(viaEnv.ok).toBe(false);
    expect(viaEnv.reason).toBe(SESSION_ABSENT);
  });

  it("declares the two existing clients exactly as their old hardcoded behaviour did", () => {
    // The change is a generalisation, so the specific values it replaced must survive it. These are
    // the literals that used to sit inline in resolveHub and opencadre-mcp.mjs.
    expect(sessionIdSourceFor("claude-code")).toEqual({
      from: "env",
      name: "CLAUDE_CODE_SESSION_ID",
      keeper: "CLAUDE_CODE_HOST_SESSION_ID",
    });
    expect(sessionIdSourceFor("codex")).toEqual({ from: "process", name: "codex" });
  });
});

describe("resolveSessionId: absent and indeterminate are different, and neither is repaired", () => {
  it("reads a usable value straight through", () => {
    expect(resolve({ SOME_SESSION_ID: "abc-123" }, ENV_SOURCE)).toEqual({ ok: true, id: "abc-123" });
  });

  it("reports ABSENT when the variable is not set at all", () => {
    expect(resolve({}, ENV_SOURCE)).toEqual({ ok: false, reason: SESSION_ABSENT });
  });

  it("reports INDETERMINATE when the variable is set but unusable", () => {
    // The case the old code could not distinguish from absence. Each of these is "set", and each
    // fails the hub's own rule (printable ASCII, no spaces, 1-200 chars) for a different reason.
    expect(resolve({ SOME_SESSION_ID: "" }, ENV_SOURCE)).toEqual({ ok: false, reason: SESSION_INDETERMINATE });
    expect(resolve({ SOME_SESSION_ID: "   " }, ENV_SOURCE)).toEqual({ ok: false, reason: SESSION_INDETERMINATE });
    expect(resolve({ SOME_SESSION_ID: "has a space" }, ENV_SOURCE)).toEqual({ ok: false, reason: SESSION_INDETERMINATE });
    expect(resolve({ SOME_SESSION_ID: "tab\there" }, ENV_SOURCE)).toEqual({ ok: false, reason: SESSION_INDETERMINATE });
    expect(resolve({ SOME_SESSION_ID: "x".repeat(201) }, ENV_SOURCE)).toEqual({ ok: false, reason: SESSION_INDETERMINATE });
  });

  it("NEVER repairs or defaults - a refusal is the whole answer", () => {
    // The property that matters most: a substituted id would name a different session, and with a
    // machine-wide credential it would silently make every chat on the box one agent. So no failure
    // mode may return ok:true, and none may carry an id alongside a reason.
    for (const bad of [undefined, null, "", "   ", "has a space", "x".repeat(201)]) {
      const out = resolve({ SOME_SESSION_ID: bad }, ENV_SOURCE);
      expect(out.ok).toBe(false);
      expect(out.id).toBeUndefined();
    }
    // And a client with no declaration at all refuses rather than falling through to something.
    expect(resolve({ SOME_SESSION_ID: "abc" }, undefined)).toEqual({ ok: false, reason: SESSION_ABSENT });
    expect(resolve({ SOME_SESSION_ID: "abc" }, { from: "nonsense" })).toEqual({ ok: false, reason: SESSION_ABSENT });
  });

  it("synthesizes per process for a client declared that way, and stays distinct", () => {
    const a = resolveSessionId({ source: { from: "process", name: "codex" }, env: {} });
    const b = resolveSessionId({ source: { from: "process", name: "codex" }, env: {} });
    expect(a.ok && b.ok).toBe(true);
    // Distinct is the point: two chats are two agents. The prefix is preserved from the branch this
    // replaced, so an id already in the wild keeps its shape.
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^codex-[0-9a-f-]{36}$/);
  });

  it("mints ONE stable, client-qualified app-start seat for a call-sourced client", () => {
    // OpenCode's id arrives on the request (`_meta["ai.opencode/sessionID"]`), so at `initialize` there
    // is no chat id yet - and refusing to create until one arrives is settled dead (the tool list comes
    // from the resolved session, so a refused initialize serves zero tools and the id-carrying call can
    // never come: docs/design/MCP-PROXY-CREATION-GATE.md §6). The seat below is what startup uses, and
    // it must CONVERGE: two starts in one project take the same row, not a new one per launch.
    const a = resolveSessionId({ source: { from: "call", name: "opencode" }, env: {} });
    const b = resolveSessionId({ source: { from: "call", name: "opencode" }, env: {} });
    expect(a).toEqual({ ok: true, id: "opencode-appstart" });
    expect(b).toEqual(a);

    // The qualifier is IN the seat, not a shared bare name: two DIFFERENT call-sourced clients in one
    // project must not silently alias to each other's row (fleet decision #16791 - an unqualified
    // seat is worse than an error). And the separator is `-`, because a space fails the hub's pattern.
    const other = resolveSessionId({ source: { from: "call", name: "other-client" }, env: {} });
    expect(other).toEqual({ ok: true, id: "other-client-appstart" });
    expect(a.id).not.toBe(other.id);

    // A call-sourced row with no name still yields a seat rather than an empty/undefined id.
    expect(resolveSessionId({ source: { from: "call" }, env: {} })).toEqual({ ok: true, id: "local-appstart" });
  });

  it("honours a caller-supplied id, but still refuses to repair a bad one", () => {
    expect(resolveSessionId({ source: undefined, sessionId: "supplied-1", env: {} })).toEqual({ ok: true, id: "supplied-1" });
    // Supplied-but-unusable is INDETERMINATE, not ABSENT: the value exists and is wrong.
    expect(resolveSessionId({ source: undefined, sessionId: "bad id", env: {} })).toEqual({ ok: false, reason: SESSION_INDETERMINATE });
  });

  it("names an Antigravity chat from the id its hook supplies, and never from the environment", () => {
    // Antigravity's conversationId arrives on the hook's stdin (and on each MCP call's `_meta`), not through the
    // environment the MCP child starts with, so the table declares a stamp-only source: no id at start, the caller's
    // id when there is one. opencadre-antigravity.mjs passes input.conversationId, exactly as the wake, awareness and
    // approval-gate hooks pass their harness's session id. Pinned so nobody invents an env var agy never sets.
    const source = sessionIdSourceFor("antigravity");
    expect(source).toEqual({ from: "stamp", name: "antigravity" });
    expect(resolveSessionId({ source, sessionId: "conv-from-stdin", env: {} })).toEqual({ ok: true, id: "conv-from-stdin" });
    // And it still fails closed: empty or malformed is INDETERMINATE, nothing supplied is ABSENT.
    expect(resolveSessionId({ source, sessionId: "", env: {} })).toEqual({ ok: false, reason: SESSION_INDETERMINATE });
    expect(resolveSessionId({ source, sessionId: "has a space", env: {} })).toEqual({ ok: false, reason: SESSION_INDETERMINATE });
    // Nothing supplied: the proxy's stable placeholder, never an identity a hook may use (resolveHub refuses it).
    expect(resolveSessionId({ source, env: {} })).toEqual({ ok: true, id: "antigravity-appstart" });
  });
});