// The Codex CLI's hook matcher must name MCP tools, and the CLI must get a gate that can REFUSE.
//
// TWO DEFECTS, both OURS rather than the vendor's, both measured 2026-09-21 on a live Codex CLI
// session (6246) and confirmed by reading `cli/lib/session-hooks.mjs`:
//
//   1. Codex never got a `PreToolUse` handler at all. The gate was emitted only for claude-code; Codex
//      got the post-execution `--report` recorder instead. So "Clearance is after-the-fact for Codex"
//      was our choice, not a vendor limit -- Codex supports PreToolUse and it can DENY
//      (DOCS, developers.openai.com/codex/hooks, fetched 2026-09-21).
//   2. The Codex `PostToolUse` matcher was `Edit|Write|Bash|apply_patch` and named no MCP tool, so even
//      the handler we DID install could not observe an OpenCadre MCP call. That is why a live session
//      reported the payload question as "cannot tell" rather than a negative: the matcher excluded the
//      calls, so no payload could surface.
//
// THE PREFIX IS NOT THE OBVIOUS ONE, and this is the assertion that would have caught it. Two servers
// exist: `opencadre-session` (our local stdio proxy) and `opencadre` (the hub, src/mcp.ts). The proxy
// FORWARDS, so Codex sees the HUB's tools. Measured from Codex's own logs (~/.codex/logs_2.sqlite, 87
// rows): `mcp__opencadre__get_messages`. A matcher built from the `[mcp_servers.opencadre-session]`
// config table would install cleanly and NEVER FIRE.
//
// THE PREFIX HAS BEEN TWO THINGS, AND A FIRST DRAFT OF THIS FILE ASSERTED ONLY THE WRONG ONE.
// Our writer names the table `opencadre-session` (SESSION_SERVER, cli/lib/clients.mjs:116) and the
// hyphen does NOT survive into the canonical tool name, so the LIVE form is
// `mcp__opencadre_session__<tool>` -- reported by a live Codex session (6246, 2026-09-21).
// `mcp__opencadre__<tool>` also exists in real history (namespace `opencadre`, the hub's own
// serverInfo name), and both are DISTINCT populations in ~/.codex/logs_2.sqlite (53 vs 94 rows).
// The matcher must cover both: covering one is a filter that installs cleanly and never fires on the
// machines using the other spelling.
//
// `matcher` is a regex string (DOCS), and the vendor's own examples include `mcp__filesystem__.*`.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { planSessionHooks } from "../cli/lib/session-hooks.mjs";

const tempHome = () => mkdtempSync(path.join(tmpdir(), "codex-matcher-"));
const P = {
  awarenessPath: "X/opencadre-awareness.mjs",
  wakePath: "X/opencadre-wake.mjs",
  usagePath: "X/opencadre-usage.mjs",
  gatePath: "X/opencadre-approval-gate.mjs",
};
const plan = (home: string, client = "codex") => planSessionHooks({ home, client, ...P });
const hooksOf = (after: string) => JSON.parse(after).hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
/** Every matcher written for an event, across its groups. */
const matchers = (after: string, event: string) => (hooksOf(after)[event] ?? []).map((g) => g.matcher ?? "");

/** Seeds an EXISTING install -- the state every machine that already ran `connect` is in. */
function seeded(home: string, event: string, matcher: string, commands: string[]) {
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(
    path.join(home, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { [event]: [{ matcher, hooks: commands.map((command) => ({ type: "command", command, timeout: 10 })) }] } }, null, 2),
  );
}

describe("Codex hooks: the matcher covers MCP tool calls", () => {
  it("MATCHES the LIVE canonical name our own config produces — false on the matcher this replaced", () => {
    // THE FALSIFIER. `opencadre-session` is the table name our writer emits; the hyphen normalises to
    // an underscore in the canonical tool name, so this is what a real call looks like.
    const m = matchers(plan(tempHome()).after, "PostToolUse").join("|");
    expect(m, "the matcher must name MCP tools or our own calls are unobservable").toContain("mcp__opencadre_session__");
    expect(new RegExp(m).test("mcp__opencadre_session__get_messages")).toBe(true);
    expect(new RegExp(m).test("mcp__opencadre_session__set_status")).toBe(true);
  });

  it("ALSO matches the second form real installs have used", () => {
    // A first draft of this change covered only this one and MISSED the live form -- both directions
    // of the same error. Both populations exist in Codex's own logs and neither is an artifact.
    const m = matchers(plan(tempHome()).after, "PostToolUse").join("|");
    expect(new RegExp(m).test("mcp__opencadre__get_messages")).toBe(true);
    expect(new RegExp(m).test("mcp__opencadre__set_status")).toBe(true);
  });

  it("STILL matches the tool names it always did — the regression arm", () => {
    // Without this arm a matcher of ".*" would pass the assertions above and be a WORSE bug than the
    // one being fixed: it would install the gate on every tool call.
    const m = matchers(plan(tempHome()).after, "PostToolUse").join("|");
    for (const name of ["Bash", "exec_command", "write_stdin", "apply_patch", "Edit", "Write"]) {
      expect(new RegExp(m).test(name), `${name} must still match`).toBe(true);
    }
    expect(m).not.toBe(".*");
  });

  it("applies the widened matcher to an EXISTING install, not only a fresh one", () => {
    // Measured defect in the writer, found while building this: with every handler already present the
    // loop returned early and the matcher was never rewritten -- so the fix would have reached fresh
    // installs only, silently, on exactly the machines that needed it.
    const home = tempHome();
    seeded(home, "PostToolUse", "Edit|Write|Bash|apply_patch", [
      `node "X/opencadre-awareness.mjs" --client codex`,
      `node "X/opencadre-approval-gate.mjs" --report --client codex`,
    ]);
    expect(matchers(plan(home).after, "PostToolUse").join("|")).toContain("mcp__opencadre__");
  });

  it("records a matcher MOVE in `changed`, so the re-trust warning is true for this edit too", () => {
    // A matcher move is covered by the hook trust hash exactly as a command move is. If it were not
    // recorded, the caller would tell the operator nothing changed while Codex silently skipped the
    // hooks -- the failure this warning exists to prevent.
    const home = tempHome();
    seeded(home, "PostToolUse", "Edit|Write|Bash|apply_patch", [
      `node "X/opencadre-awareness.mjs" --client codex`,
      `node "X/opencadre-approval-gate.mjs" --report --client codex`,
    ]);
    const moved = plan(home).changed.filter((c) => c.event === "matcher");
    expect(moved).toHaveLength(1);
    expect(moved[0].from).toBe("Edit|Write|Bash|apply_patch");
    expect(moved[0].to).toContain("mcp__opencadre__");
  });

  it("never rewrites a group that is not ours", () => {
    // The refresh must not touch a user's own hook group. Their matcher is theirs.
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(
      path.join(home, ".codex", "hooks.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "MyOwnTool", hooks: [{ type: "command", command: "node my-own-hook.mjs" }] }] } }, null, 2),
    );
    const after = plan(home).after;
    expect(matchers(after, "PostToolUse")).toContain("MyOwnTool");
    expect(JSON.parse(after).hooks.PostToolUse.some((g: { hooks: Array<{ command: string }> }) => g.hooks.some((h) => h.command === "node my-own-hook.mjs"))).toBe(true);
  });

  it("is idempotent — a second run produces a byte-identical file", () => {
    const home = tempHome();
    const first = plan(home).after;
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "hooks.json"), first);
    expect(plan(home).after).toBe(first);
  });
});

describe("Codex hooks: the gate can refuse BEFORE a tool runs", () => {
  it("matches the desktop app's exec_command and write_stdin in both pre- and post-tool hooks", () => {
    const after = plan(tempHome()).after;
    for (const event of ["PreToolUse", "PostToolUse"]) {
      for (const tool of ["exec_command", "write_stdin"])
        expect(matchers(after, event).some((m) => new RegExp(m).test(tool)), `${event} ${tool}`).toBe(true);
    }
    expect((hooksOf(after).PostToolUse ?? []).flatMap((g) => g.hooks).some((h) => h.command.includes("--typed-commit"))).toBe(true);
  });
  it("installs a PreToolUse gate for Codex, and it is the BLOCKING invocation", () => {
    const after = plan(tempHome()).after;
    const pre = (hooksOf(after).PreToolUse ?? []).flatMap((g) => g.hooks);
    const gate = pre.find((h) => h.command.includes("opencadre-approval-gate.mjs"));
    expect(gate, "Codex must get a PreToolUse gate — without one Clearance is after-the-fact by our choice").toBeTruthy();
    // --report means "the command already ran". A gate in the execution path must NOT carry it.
    expect(gate!.command).not.toContain("--report");
  });

  it("KEEPS the post-execution recorder — refusing and recording are different jobs", () => {
    // A refusal says what did NOT happen; a record says what DID, and an audit trail of executed
    // commands is evidence a refusal can never produce.
    const post = (hooksOf(plan(tempHome()).after).PostToolUse ?? []).flatMap((g) => g.hooks);
    const rec = post.find((h) => h.command.includes("opencadre-approval-gate.mjs"));
    expect(rec).toBeTruthy();
    expect(rec!.command).toContain("--report");
  });

  it("leaves Claude Code unchanged — its gate was already in the execution path", () => {
    const after = plan(tempHome(), "claude-code").after;
    const pre = (hooksOf(after).PreToolUse ?? []).flatMap((g) => g.hooks);
    expect(pre.some((h) => h.command.includes("opencadre-approval-gate.mjs") && !h.command.includes("--report"))).toBe(true);
    expect(hooksOf(after).PreToolUse.some((g) => (g.matcher ?? "").includes("mcp__"))).toBe(false);
    // And Claude Code has no recorder -- its gate runs before the command already.
    expect((hooksOf(after).PostToolUse ?? []).flatMap((g) => g.hooks).some((h) => h.command.includes("opencadre-approval-gate.mjs"))).toBe(false);
  });

  it("does NOT copy Codex's tool vocabulary onto Claude Code", () => {
    // Found while building: unifying the two bases put `apply_patch` -- a name that exists only in
    // Codex -- into Claude Code's matcher. A matcher filters names in ONE client's vocabulary, so a
    // copied entry is a filter that can never match, and it would have been invisible.
    const m = matchers(plan(tempHome(), "claude-code").after, "PostToolUse").join("|");
    expect(m).toBe("Edit|Write|Bash");
    expect(m).not.toContain("apply_patch");
    expect(m).not.toContain("mcp__");
  });
});
