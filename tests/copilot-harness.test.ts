// GitHub Copilot CLI: the capabilities of LAUNCH-CLIENT-GATE.md §1, driven the way Copilot CLI 1.0.88 drives its hooks
// and MCP servers, as MEASURED against the real binary in BYOK mode (docs/research/HARNESS-ADAPTERS.md §3):
//   - each session's stdio MCP process gets COPILOT_AGENT_SESSION_ID; a `preMcpToolCall` hook's `metaToUse` becomes the
//     tools/call's `_meta`
//   - hook payloads are camelCase with no event name: { sessionId, timestamp, cwd, toolName, toolArgs, … }; the shell
//     tool is `bash` (`powershell` on Windows) with `toolArgs.command`
//   - answers: preToolUse `permissionDecision`; sessionStart/userPromptSubmitted `additionalContext`; agentStop
//     `{decision:"block", reason}` with `stop_hook_active` on the re-entry
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyStamp } from "../scripts/opencadre-config.mjs";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME, sessionNamed,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

/** Copilot's folder is the home's own. */
const copilotEnv = (home: string, extra: Record<string, string> = {}) => childEnv(home, { COPILOT_HOME: "", ...extra });

function runHook(script: string, args: string[], payload: unknown, env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("Copilot CLI, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let bin: string;
  let credential: string;
  const project = gitProject("CopilotProj");
  const proxies: ProxyProcess[] = [];

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Copilot Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:copilotproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-copilot-e2e-");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "copilot"], copilotEnv(home));
    expect(connected.code, connected.err).toBe(0);
    bin = path.join(home, ".opencadre", "bin");
    credential = computerCredential(home);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  const server = async (session: string) => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), copilotEnv(home, { COPILOT_AGENT_SESSION_ID: session }), project, "copilot");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    return p;
  };
  const base = (session: string, extra: object = {}) => ({ sessionId: session, timestamp: Date.now(), cwd: project, ...extra });
  const hook = (script: string, event: string, body: object, extra: Record<string, string> = {}) =>
    runHook(path.join(bin, script), ["--client", "copilot", "--event", event], body, copilotEnv(home, { COPILOT_CLI: "1", COPILOT_PROJECT_DIR: project, ...extra }));
  const agentOf = async (task: string) => ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>)
    .find((r) => r.currentTask === task)?.agentName;

  it("connect wrote the server into mcp-config.json and OpenCadre's hook file", () => {
    const mcp = JSON.parse(readFileSync(path.join(home, ".copilot", "mcp-config.json"), "utf8"));
    expect(mcp.mcpServers["opencadre-session"]).toEqual({ type: "local", command: "node", args: [path.join(bin, "opencadre-mcp.mjs"), "--client", "copilot"], tools: ["*"] });
    const { version, hooks } = JSON.parse(readFileSync(path.join(home, ".copilot", "hooks", "opencadre.json"), "utf8"));
    expect(version).toBe(1);
    expect(hooks.preToolUse[0]).toMatchObject({ type: "command", matcher: "bash|powershell|write_bash|write_powershell", timeoutSec: 600 });
    expect(hooks.preToolUse[0].command).toContain("opencadre-approval-gate.mjs\" --client copilot --event preToolUse");
    expect(hooks.preMcpToolCall[0].command).toContain("opencadre-session-stamp.mjs\" --client copilot --event preMcpToolCall");
    for (const e of ["sessionStart", "userPromptSubmitted", "agentStop"]) expect(hooks[e][0].command).toContain(`opencadre-awareness.mjs" --client copilot --event ${e}`);
  });

  it("two sessions are two agents, from the variable Copilot gives each session's server", async () => {
    await (await server("cop-A")).callTool("set_status", { task: "copilot A at work" });
    await (await server("cop-B")).callTool("set_status", { task: "copilot B at work" });
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null }>;
    expect(rows.filter((r) => r.tool === "copilot")).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "copilot", projectName: "CopilotProj" });
  });

  it("the stamp rides _meta for OUR server only, and a stamped call acts as its session whatever the server's variable", async () => {
    const meta = { progressToken: 1, other: "kept" };
    const r = await hook("opencadre-session-stamp.mjs", "preMcpToolCall", base("cop-C", { toolCallId: "t1", serverName: "opencadre-session", toolName: "set_status", arguments: { task: "x" }, _meta: meta }));
    const { metaToUse } = JSON.parse(r.out);
    expect(metaToUse).toMatchObject(meta);
    expect(verifyStamp(credential, metaToUse["opencadre/stamp"])).toEqual({ ok: true, sessionId: "cop-C" });
    expect((await hook("opencadre-session-stamp.mjs", "preMcpToolCall", base("cop-C", { serverName: "github", toolName: "set_status", arguments: {} }))).out).toBe("");
    // A server still carrying session A's variable (a session switched to without a restart) answers as C.
    const stale = await server("cop-A");
    const res = await stale.request("tools/call", { name: "set_status", arguments: { task: "copilot C at work" }, _meta: metaToUse });
    expect(res.error).toBeUndefined();
    const c = await agentOf("copilot C at work");
    expect(c).toMatch(WORD_NAME);
    expect(await sessionNamed(hub.url, operatorKey, c)).toMatchObject({ tool: "copilot", projectName: "CopilotProj" });
    expect(c).not.toBe(await agentOf("copilot A at work"));
    // A forged stamp is refused, not answered as the variable's session.
    const forged = await stale.request("tools/call", { name: "set_status", arguments: { task: "forged" }, _meta: { "opencadre/stamp": { sid: "cop-A", sig: "0".repeat(64) } } });
    expect(forged.error?.message).toMatch(/did not verify/);
  });

  it("sessionStart tells the session who it is and the truth about waking", async () => {
    const r = await hook("opencadre-awareness.mjs", "sessionStart", base("cop-A", { source: "new", initialPrompt: "" }));
    const context = JSON.parse(r.out).additionalContext as string;
    expect(context).toMatch(new RegExp(`You are ${await agentOf("copilot A at work")}`));
    expect(context).toMatch(/Copilot CLI cannot wake an idle session/);
  });

  it("MAIL: unread mail keeps agentStop going once; the re-entry (stop_hook_active) is let go", async () => {
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: await agentOf("copilot A at work"), body: "copilot, please look", priority: "high" }),
    });
    const stop = (active: boolean) => hook("opencadre-awareness.mjs", "agentStop", base("cop-A", { transcriptPath: "", stopReason: "end_turn", stop_hook_active: active }));
    const blocked = JSON.parse((await stop(false)).out);
    expect(blocked).toEqual({ decision: "block", reason: expect.stringMatching(/copilot, please look/) });
    expect((await stop(true)).out).toBe("");
  });

  it("CLEARANCE: a risky bash command is held as the session's agent and denied in Copilot's shape; a harmless one says nothing", async () => {
    const gate = hook("opencadre-approval-gate.mjs", "preToolUse", base("cop-A", { toolName: "bash", toolArgs: { command: "rm -rf ./src", description: "clean", mode: "sync", initial_wait: 10 } }),
      { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].details).toMatch(/^Copilot CLI wants to run this shell command in .*CopilotProj/);
    expect(pending[0].requested_by_agent_name).toBe(await agentOf("copilot A at work"));
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    expect(JSON.parse((await gate).out)).toEqual({ permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/denied by Operator: no/) });
    const quiet = await hook("opencadre-approval-gate.mjs", "preToolUse", base("cop-A", { toolName: "bash", toolArgs: { command: "git status" } }));
    expect(quiet.out).toBe("");
  });

  it("a Claude Code hook that Copilot runs (a repo's .claude/settings.json) stands down when Copilot's own gate is installed", async () => {
    const claudeShaped = { hook_event_name: "PreToolUse", session_id: "cop-A", timestamp: new Date().toISOString(), cwd: project, tool_name: "Bash", tool_input: { command: "rm -rf ./src" } };
    const r = await runHook(path.join(bin, "opencadre-approval-gate.mjs"), ["--client", "claude-code"], claudeShaped,
      copilotEnv(home, { COPILOT_CLI: "1", COPILOT_PROJECT_DIR: project, ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" }));
    expect(r.out).toBe("");
    // Its Stop payload carries transcript_path; Copilot's own hook environment still says it is Copilot's (review of a7db951).
    const stop = { hook_event_name: "Stop", session_id: "cop-A", timestamp: new Date().toISOString(), cwd: project, transcript_path: "/x/events.jsonl", stop_reason: "end_turn", stop_hook_active: false };
    const woke = await runHook(path.join(bin, "opencadre-awareness.mjs"), ["--client", "claude-code"], stop, copilotEnv(home, { COPILOT_CLI: "1", COPILOT_PROJECT_DIR: project }));
    expect(woke.out).toBe("");
  });

  it("a read-only subagent's hooks add no agent; only a risky command opens its seat (review of a7db951, B2)", async () => {
    const before = (await liveSessions(hub.url, operatorKey, deviceId) as unknown[]).length;
    await hook("opencadre-awareness.mjs", "userPromptSubmitted", base("cop-explore-1", { prompt: "look around" }));
    await hook("opencadre-awareness.mjs", "agentStop", base("cop-explore-1", { stopReason: "end_turn", stop_hook_active: false }));
    await hook("opencadre-approval-gate.mjs", "preToolUse", base("cop-explore-1", { toolName: "bash", toolArgs: { command: "ls" } }), { OPENCADRE_GATE_MODE: "ask" });
    expect((await liveSessions(hub.url, operatorKey, deviceId) as unknown[]).length).toBe(before);
  });

  it("a SUBAGENT's risky command (its own session id, no server of its own) is still held, as an agent of its own (B2)", async () => {
    const gate = hook("opencadre-approval-gate.mjs", "preToolUse", base("cop-subagent-7", { toolName: "bash", toolArgs: JSON.stringify({ command: "rm -rf ./src" }) }),
      { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending).toHaveLength(1);
    // Not session A's agent: the subagent is named by its own id (and `toolArgs` given as a JSON string is read).
    expect(pending[0].requested_by_agent_name).toMatch(WORD_NAME);
    expect(await sessionNamed(hub.url, operatorKey, pending[0].requested_by_agent_name)).toMatchObject({ tool: "copilot", projectName: "CopilotProj" });
    expect(pending[0].requested_by_agent_name).not.toBe(await agentOf("copilot A at work"));
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    expect(JSON.parse((await gate).out).permissionDecision).toBe("deny");
    // A shell call whose command cannot be read is blocked, not let through.
    const unreadable = await hook("opencadre-approval-gate.mjs", "preToolUse", base("cop-A", { toolName: "bash", toolArgs: "{not json" }));
    expect(JSON.parse(unreadable.out).permissionDecision).toBe("deny");
  });

  it("COPILOT_CLI=1 leaking into Gemini or Qwen started from Copilot's shell does not stand their gates down (B1)", async () => {
    const { foreignHost } = await import("../scripts/opencadre-hook-dialect.mjs");
    const was = process.env.COPILOT_CLI;
    const wasDir = process.env.COPILOT_PROJECT_DIR;
    process.env.COPILOT_CLI = "1";
    try {
      const iso = new Date().toISOString();
      const copilotClaude = { hook_event_name: "PreToolUse", session_id: "s", timestamp: iso, cwd: project, tool_name: "Bash", tool_input: { command: "x" } };
      const geminiShaped = { ...copilotClaude, hook_event_name: "BeforeTool", transcript_path: "/t", tool_name: "run_shell_command" };
      const qwenShaped = { ...copilotClaude, transcript_path: "/t", tool_name: "run_shell_command" };
      // Copilot's shell children get COPILOT_CLI=1 but not COPILOT_PROJECT_DIR: nothing there is taken for Copilot's hook.
      // (A real Claude Code started from that shell sends permission_mode, which also tells it from VS Code's agent.)
      expect(foreignHost("claude-code", { ...copilotClaude, permission_mode: "default" })).toBeNull();
      process.env.COPILOT_PROJECT_DIR = project;
      expect(foreignHost("claude-code", copilotClaude)).toBe("copilot");
      expect(foreignHost("gemini", geminiShaped)).toBeNull();
      expect(foreignHost("qwen", qwenShaped)).toBeNull();
      expect(foreignHost("gemini", copilotClaude)).toBeNull();
      // Copilot's Stop payload carries transcript_path and is still Copilot's.
      expect(foreignHost("claude-code", { ...copilotClaude, hook_event_name: "Stop", transcript_path: "/t" })).toBe("copilot");
    } finally {
      if (was === undefined) delete process.env.COPILOT_CLI;
      else process.env.COPILOT_CLI = was;
      if (wasDir === undefined) delete process.env.COPILOT_PROJECT_DIR;
      else process.env.COPILOT_PROJECT_DIR = wasDir;
    }
  });

  it("doctor --client copilot finds the server and all three hooks", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "copilot", "--home", home], copilotEnv(home));
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
  });
});
