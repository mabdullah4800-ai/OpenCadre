// F8: Claude Code's PowerShell tool is gated, like its Bash tool.
//
// THE DEFECT. Claude Code on Windows has a PowerShell tool beside Bash. MEASURED on claude.exe 2.1.284 (board 82e35277,
// B:\ai-work\temp\2040-q1d\f8-2026-09-30T19-17-04-572Z): PreToolUse fires for it with `tool_name: "PowerShell"` and
// `tool_input: { command, description }`. OpenCadre installed its gate on the matcher "Bash" only, so every command
// the PowerShell tool ran was never shown to the gate at all.
//
// THREE HALVES, each with the world in which it fails:
//   1. the installer writes a matcher that selects PowerShell      (fails if the matcher is "Bash" again)
//   2. doctor accepts that install and flags a Bash-only one       (fails if doctor ignores the matcher)
//   3. the gate reads a PowerShell tool's command as PowerShell    (fails if it is routed to the POSIX reading)
//
// On (3): the Windows-native checks (ps-recursive-delete, cmd-tree-delete, disk-destroy, opaque-shell-command) run in
// BOTH shells by design, so those rows hold whichever reading is chosen: they prove the Claude-dialect PowerShell
// payload reaches the checks, not the routing. The routing is proved by the rows where the two readings DISAGREE: a
// computed invocation only PowerShell knows (`iex $payload`), ordinary PowerShell the POSIX reading over-flags
// (`$lines = @(...)`), and a comment only PowerShell blanks. The Bash tool's rows show the other direction.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { listApprovals } from "../src/approvals.js";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { childEnv, CLI, gitProject, mintDevice, operatorWorkspace, runNode, startHub, tempDir } from "./helpers/device-hub.js";
import { CLAUDE_GATE_TOOLS, claudeMatcherCovers, planSessionHooks } from "../cli/lib/session-hooks.mjs";
import { hookCommand, typedShellInput } from "../scripts/opencadre-hook-dialect.mjs";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The gate as Claude Code runs it: no --client (claude-code), a Claude-dialect payload, and NO shell override, so the
 * reading is chosen by the payload alone. */
function runGate(toolName: string, command: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith("OPENCADRE_")) base[k] = v;
  return new Promise((resolve) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "gate-cc-ps-"));
    const child = spawn(process.execPath, [HOOK], { env: { ...base, ...GATE_TEST_ENV, HOME: cwd, USERPROFILE: cwd, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "f8", cwd, tool_name: toolName, tool_input: { command, description: "f8 test" } }));
  });
}

/** notify mode: a risky command is recorded as `noted` with its category, and never blocked. */
async function noted(toolName: string, command: string) {
  const { orgId } = createOrganization(`F8 ${toolName} ${command}`);
  const agent = registerAgent(orgId, "Claude Coder");
  await runGate(toolName, command, { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: agent.apiKey, OPENCADRE_GATE_MODE: "notify" });
  return listApprovals(orgId, { status: "noted" }).map((a) => a.category);
}

const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

describe("the gate holds Claude Code's PowerShell tool", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const held: Array<[command: string, categories: string[]]> = [
    ["Remove-Item -Recurse -Force C:\\x", ["ps-recursive-delete"]],
    ["rm -r -fo x", ["ps-recursive-delete"]],
    ["Format-Volume -DriveLetter D", ["disk-destroy"]],
    ["git push --force origin main", ["force-push"]],
    [`powershell -EncodedCommand ${encoded("Remove-Item -Recurse -Force C:\\x")}`, ["ps-recursive-delete"]],
    ["pwsh -enc not-base64!", ["opaque-shell-command"]],
    // A representative subset of tests/approval-gate-powershell.test.ts, through the Claude-dialect tool.
    ["ri -r -fo ./old", ["ps-recursive-delete"]],
    ["Get-ChildItem .\\old | Remove-Item -Recurse -Force", ["ps-recursive-delete"]],
    ["$removed = Remove-Item -Recurse -Force C:\\work\\old -PassThru", ["ps-recursive-delete"]],
    ["cmd /c rd /s /q C:\\work\\old", ["cmd-tree-delete"]],
    ["del /f /q C:\\work\\old\\*", ["cmd-tree-delete"]],
    ["Clear-Disk -Number 1 -RemoveData", ["disk-destroy"]],
    // Only the PowerShell reading holds these: they are the routing's own evidence.
    ["iex $payload", ["unresolved-dynamic-command"]],
    ["Invoke-Expression (Get-Content .\\run.txt -Raw)", ["unresolved-dynamic-command"]],
  ];
  it.each(held)("holds %s", async (command, categories) => {
    expect(await noted("PowerShell", command)).toEqual(categories);
  });

  const harmless = [
    "Get-ChildItem",
    "Remove-Item C:\\work\\old\\file.txt",
    "Remove-Item -Recurse -Force node_modules",
    "Get-Volume",
    // The POSIX reading flags these; the PowerShell reading does not (the over-fire fixed in #534).
    "$lines = @(gh api 'x')",
    "$env:FOO = 'bar'; node script.mjs",
    "Get-Date # rm -rf C:\\work\\old",
  ];
  it.each(harmless)("passes %s", async (command) => {
    expect(await noted("PowerShell", command)).toEqual([]);
  });

  it("denies a held PowerShell command in Claude Code's own answer shape, and lets a harmless one through", async () => {
    // strict with no hub: a risky command fails closed, so this is the answer Claude Code acts on.
    const env = { OPENCADRE_URL: "", OPENCADRE_KEY: "", OPENCADRE_GATE_MODE: "strict" };
    const risky = await runGate("PowerShell", "Remove-Item -Recurse -Force C:\\x", env);
    expect(JSON.parse(risky.out).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    const ordinary = await runGate("PowerShell", "Get-ChildItem", env);
    expect(ordinary.code).toBe(0);
    expect(ordinary.out).not.toMatch(/deny/);
  });
});

describe("the Bash tool keeps the POSIX reading", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("still holds rm -rf", async () => {
    expect(await noted("Bash", "rm -rf /tmp/old")).toEqual(["rm-rf"]);
  });
  it("still flags a POSIX command whose program is a variable (the PowerShell reading would not)", async () => {
    expect(await noted("Bash", "$CMD --force")).toEqual(["unresolved-dynamic-command"]);
  });
  it("still passes an ordinary compound", async () => {
    expect(await noted("Bash", "git status && npm test")).toEqual([]);
  });
});

describe("the Claude dialect reads the PowerShell tool's command", () => {
  it("from tool_input.command, like Bash, and not as typed shell input", () => {
    const input = { tool_name: "PowerShell", tool_input: { command: "Get-ChildItem", description: "list" } };
    expect(hookCommand(input)).toBe("Get-ChildItem");
    expect(typedShellInput(input)).toBeNull();
  });
});

describe("the installer's matcher covers PowerShell", () => {
  const plan = (client: string) => JSON.parse(planSessionHooks({
    home: tempDir("oc-f8-plan-"), client, awarenessPath: "/b/opencadre-awareness.mjs", wakePath: "/b/opencadre-wake.mjs",
    usagePath: "/b/opencadre-usage.mjs", gatePath: "/b/opencadre-approval-gate.mjs", stampPath: "/b/opencadre-session-stamp.mjs",
  }).after);

  it("writes the gate on Bash|PowerShell for claude-code, in one group", () => {
    const pre = plan("claude-code").hooks.PreToolUse;
    expect(pre).toHaveLength(1);
    expect(pre[0].matcher).toBe("Bash|PowerShell");
    expect(pre[0].hooks[0].command).toMatch(/opencadre-approval-gate\.mjs" --client claude-code$/);
    for (const tool of CLAUDE_GATE_TOOLS) expect(claudeMatcherCovers(pre[0].matcher, tool)).toBe(true);
  });

  const gate = { type: "command", command: 'node "/b/opencadre-approval-gate.mjs" --client claude-code', timeout: 600 };
  const lint = { type: "command", command: "node my-bash-linter.mjs" };
  const audit = { type: "command", command: "node my-bash-audit.mjs" };
  const other = { matcher: "Edit", hooks: [{ type: "command", command: "node my-edit-hook.mjs" }] };
  /** Plans the claude-code hooks over `preToolUse` and returns the planned PreToolUse list, plus a second plan over the
   * first one's result (the re-install). */
  function upgrade(preToolUse: unknown[]) {
    const home = tempDir("oc-f8-upgrade-");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const file = path.join(home, ".claude", "settings.json");
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: preToolUse } }));
    const args = { home, client: "claude-code", awarenessPath: "/b/opencadre-awareness.mjs", wakePath: "/b/opencadre-wake.mjs", usagePath: "/b/opencadre-usage.mjs", gatePath: "/b/opencadre-approval-gate.mjs" };
    const first = planSessionHooks(args);
    writeFileSync(file, first.after);
    const second = planSessionHooks(args);
    return { first, pre: JSON.parse(first.after).hooks.PreToolUse, second };
  }

  it("widens an OpenCadre-only Bash group in place, keeping its group", () => {
    const { first, pre, second } = upgrade([other, { matcher: "Bash", hooks: [gate] }]);
    expect(pre).toEqual([other, { matcher: "Bash|PowerShell", hooks: [gate] }]);
    expect(first.changed).toContainEqual(expect.objectContaining({ event: "matcher", from: "Bash", to: "Bash|PowerShell" }));
    expect(second.after).toBe(first.after);
    expect(second.changed).toEqual([]);
  });

  it("never widens a MIXED group: it is split into its runs in place, foreign runs staying Bash-only", () => {
    const { pre, second } = upgrade([other, { matcher: "Bash", hooks: [lint, gate, audit] }]);
    expect(pre).toEqual([other, { matcher: "Bash", hooks: [lint] }, { matcher: "Bash|PowerShell", hooks: [gate] }, { matcher: "Bash", hooks: [audit] }]);
    // Re-install: idempotent, no duplicate group and no duplicate handler.
    expect(second.after).toBe(second.before);
    expect(JSON.parse(second.after).hooks.PreToolUse).toEqual(pre);
    expect(second.changed).toEqual([]);
  });

  it("a mixed group whose FIRST handler is ours: its run comes first", () => {
    const { pre, second } = upgrade([{ matcher: "Bash", hooks: [gate, lint] }, other]);
    expect(pre).toEqual([{ matcher: "Bash|PowerShell", hooks: [gate] }, { matcher: "Bash", hooks: [lint] }, other]);
    expect(JSON.parse(second.after).hooks.PreToolUse).toEqual(pre);
  });

  // ORDER REGRESSION (F8 re-review of 91dfaa55): [before, gate, after] had become [before, after, gate]. The handlers a
  // Bash call runs, flattened in file order, must be the input sequence exactly, wherever ours sit; every foreign
  // handler must stay byte-for-byte what it was (its timeout and any other field) and Bash-only.
  const f1 = { type: "command", command: "node f1.mjs", timeout: 7 };
  const f2 = { type: "command", command: "node f2.mjs", timeout: 8, statusMessage: "f2 running" };
  const f3 = { type: "command", command: "node f3.mjs" };
  const gate2 = { ...gate };
  const orders: Array<[name: string, hooks: object[]]> = [
    ["first", [gate, f1, f2]],
    ["middle", [f1, gate, f2]],
    ["last", [f1, f2, gate]],
    ["interleaved", [f1, gate, f2, gate2, f3]],
  ];
  it.each(orders)("keeps the Bash handler order exactly with ours %s", (_name, hooks) => {
    const flatBash = (groups: Array<{ matcher?: string; hooks: object[] }>) =>
      groups.filter((g) => claudeMatcherCovers(g.matcher, "Bash")).flatMap((g) => g.hooks).map((h) => JSON.stringify(h));
    const { pre, second } = upgrade([other, { matcher: "Bash", hooks }]);
    expect(flatBash(pre)).toEqual(hooks.map((h) => JSON.stringify(h)));
    for (const g of pre) {
      const foreign = g.hooks.filter((h: { command: string }) => !h.command.includes("opencadre-approval-gate.mjs"));
      if (foreign.length) expect(g.matcher).toBe(g === pre[0] ? "Edit" : "Bash");
      if (foreign.length && g !== pre[0]) expect(g.hooks).toHaveLength(foreign.length); // no foreign run shares ours
    }
    for (const g of pre.filter((g: { hooks: Array<{ command: string }> }) => g.hooks.some((h) => h.command.includes("opencadre-approval-gate.mjs")))) {
      expect(g.matcher).toBe("Bash|PowerShell");
    }
    // Second install and upgrade: an identical file.
    expect(second.after).toBe(second.before);
    expect(second.changed).toEqual([]);
  });

  it("a fresh install beside a user's own Bash group leaves that group as it is", () => {
    const { pre, second } = upgrade([{ matcher: "Bash", hooks: [lint] }]);
    expect(pre[0]).toEqual({ matcher: "Bash", hooks: [lint] });
    expect(pre).toHaveLength(2);
    expect(pre[1].matcher).toBe("Bash|PowerShell");
    expect(pre[1].hooks.map((h: { command: string }) => h.command)).toEqual([expect.stringMatching(/opencadre-approval-gate\.mjs" --client claude-code$/)]);
    expect(JSON.parse(second.after).hooks.PreToolUse).toEqual(pre);
  });

  it("leaves the other clients' shell matchers alone", () => {
    expect(plan("codex").hooks.PreToolUse[0].matcher).toBe("Bash|exec_command|write_stdin|mcp__opencadre_session__.*|mcp__opencadre__.*");
    expect(plan("qwen").hooks.PreToolUse[0].matcher).toBe("run_shell_command|monitor");
  });

  it("reads matchers the way Claude Code does: a name list exactly, anything else as a pattern", () => {
    expect(claudeMatcherCovers("Bash", "PowerShell")).toBe(false);
    expect(claudeMatcherCovers("Bash|PowerShell", "PowerShell")).toBe(true);
    expect(claudeMatcherCovers("Bash|PowerShellX", "PowerShell")).toBe(false);
    expect(claudeMatcherCovers("*", "PowerShell")).toBe(true);
    expect(claudeMatcherCovers(undefined, "PowerShell")).toBe(true);
    expect(claudeMatcherCovers("Power.*", "PowerShell")).toBe(true);
  });
});

describe("doctor accepts the new install and flags a Bash-only one", () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let home: string;
  let project: string;
  const settingsFile = () => path.join(home, ".claude", "settings.json");
  const doctor = () => runNode(CLI, ["doctor", "--client", "claude-code", "--home", home], childEnv(home));

  beforeAll(async () => {
    hub = await startHub();
    const { operatorKey } = await operatorWorkspace("F8 doctor");
    const minted = await mintDevice(hub.url, operatorKey);
    home = tempDir("oc-f8-doctor-");
    project = gitProject("F8Doctor");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "claude-code"], childEnv(home), project);
    expect(connected.code, connected.err).toBe(0);
  }, 60_000);
  afterAll(() => hub.close());

  it("a fresh connect installs Bash|PowerShell, and doctor reads it as healthy", async () => {
    const pre = JSON.parse(readFileSync(settingsFile(), "utf8")).hooks.PreToolUse;
    expect(pre.map((g: { matcher: string }) => g.matcher)).toEqual(["Bash|PowerShell"]);
    const r = await doctor();
    expect(r.out).not.toMatch(/does not cover/);
    expect(r.out).not.toMatch(/gate_matcher=/);
    expect(r.out).toMatch(/verdict=healthy/);
    expect(r.code).toBe(0);
  }, 30_000);

  it("a Bash-only install (from before F8) is red, gate_outdated, exit 1; running connect again repairs it", async () => {
    const fresh = readFileSync(settingsFile(), "utf8");
    const settings = JSON.parse(fresh);
    settings.hooks.PreToolUse[0].matcher = "Bash";
    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    try {
      const r = await doctor();
      expect(r.out).toMatch(/\[red\] Approval gate in ~\/\.claude\/settings\.json does not cover Claude Code's PowerShell tool/);
      expect(r.out).toMatch(/gate_matcher=outdated/);
      expect(r.out).toMatch(/verdict=gate_outdated/);
      expect(r.out).not.toMatch(/verdict=healthy|Session server connected/);
      expect(r.code).toBe(1);

      // The fix doctor names: the connect command, run again on this connected computer.
      const again = await runNode(CLI, ["connect", "--home", home, "--client", "claude-code"], childEnv(home), project);
      expect(again.code, again.err).toBe(0);
      expect(JSON.parse(readFileSync(settingsFile(), "utf8")).hooks.PreToolUse[0].matcher).toBe("Bash|PowerShell");
      const after = await doctor();
      expect(after.out).toMatch(/verdict=healthy/);
      expect(after.code).toBe(0);
    } finally {
      writeFileSync(settingsFile(), fresh);
    }
  }, 60_000);

  it("a Bash-only gate sharing its group with a user's hook: doctor flags it, connect moves only ours, the user's stays Bash-only", async () => {
    const fresh = readFileSync(settingsFile(), "utf8");
    const settings = JSON.parse(fresh);
    const users = { type: "command", command: "node my-bash-linter.mjs" };
    settings.hooks.PreToolUse = [{ matcher: "Bash", hooks: [users, settings.hooks.PreToolUse[0].hooks[0]] }];
    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    try {
      const r = await doctor();
      expect(r.out).toMatch(/verdict=gate_outdated/);
      expect(r.code).toBe(1);

      const again = await runNode(CLI, ["connect", "--home", home, "--client", "claude-code"], childEnv(home), project);
      expect(again.code, again.err).toBe(0);
      const pre = JSON.parse(readFileSync(settingsFile(), "utf8")).hooks.PreToolUse;
      expect(pre).toHaveLength(2);
      expect(pre[0]).toEqual({ matcher: "Bash", hooks: [users] });
      expect(pre[1].matcher).toBe("Bash|PowerShell");
      expect(pre[1].hooks[0].command).toMatch(/opencadre-approval-gate\.mjs" --client claude-code$/);
      // Healthy with ours in a group of its own and the user's hook left Bash-only.
      const after = await doctor();
      expect(after.out).not.toMatch(/does not cover/);
      expect(after.out).toMatch(/verdict=healthy/);
      expect(after.code).toBe(0);
    } finally {
      writeFileSync(settingsFile(), fresh);
    }
  }, 60_000);
});
