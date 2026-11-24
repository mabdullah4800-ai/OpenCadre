// Qwen Code: the capabilities of LAUNCH-CLIENT-GATE.md §1 that can be exercised without a signed-in Qwen Code, driven
// the way it drives its hooks and MCP servers. Read in @qwen-code/qwen-code 0.24.4's bundle
// (docs/research/HARNESS-ADAPTERS.md §3):
//   - hooks: Claude Code's contract and event names; payload `session_id`, `cwd`, `hook_event_name`, `tool_name`,
//     `tool_input`; answers `hookSpecificOutput.permissionDecision`, Stop `decision: "block"`, `stop_hook_active`
//   - identity: the stdio MCP child inherits `QWEN_CODE_SESSION_ID` when it is spawned. /clear, /reset, /new and
//     /resume then CHANGE the variable in Qwen's process (Config.startNewSession), so the hooks see a new id while the
//     child keeps the old one. The child records its seat under Qwen's pid, and the hooks read it from there.
//   - ACP / `serve`: one pooled child serves every session; each call names its session in
//     `_meta["qwen-code/invocation"].sessionId`.
// Each simulated Qwen process is a real process (tests/helpers/fake-qwen-host.mjs) that spawns the proxy, as Qwen does,
// so the proxy finds its host by its own ancestry; hooks are told that pid the way the POSIX install passes `$PPID`.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME, sessionNamed,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

const FAKE_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-qwen-host.mjs");
// The Windows host ancestry check uses the system PowerShell. Keep the test PATH isolated from
// developer-installed CLIs while allowing that one OS tool to be found by Qwen's MCP child and hooks.
const qwenChildEnv = (home: string) => childEnv(home, process.platform === "win32"
  ? { PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0") }
  : {});

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

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

describe("Qwen Code, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let bin: string;
  const project = gitProject("QwenProj");
  const proxies: ProxyProcess[] = [];
  /** A Qwen process started with `session` in QWEN_CODE_SESSION_ID: the fake host, whose child is the proxy. */
  const qwenHost = async (session: string | null, flags: string[] = [], extra: Record<string, string> = {}) => {
    const env = { ...qwenChildEnv(home), QWEN_CODE_CLI: FAKE_HOST, FAKE_QWEN_PROXY: path.join(bin, "opencadre-mcp.mjs"), ...(session ? { QWEN_CODE_SESSION_ID: session } : {}), ...extra };
    const p = new ProxyProcess(FAKE_HOST, env, project, "qwen", flags);
    proxies.push(p);
    return p;
  };
  const pidOf = (p: ProxyProcess) => String(p.child.pid);
  let HOST_A = "";
  const payload = (event: string, session: string, extra: object = {}) => ({ session_id: session, cwd: project, hook_event_name: event, transcript_path: "", ...extra });
  /** A hook as Qwen runs it: the host's CURRENT session id in the environment, and the host pid its install passes. */
  const hook = (script: string, session: string, host: string, body: object, extra: Record<string, string> = {}) =>
    runHook(path.join(bin, script), ["--client", "qwen", "--host-pid", host], body, { ...qwenChildEnv(home), QWEN_CODE_SESSION_ID: session, ...extra });
  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Qwen Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:qwenproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-qwen-e2e-");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "qwen"], qwenChildEnv(home));
    expect(connected.code, connected.err).toBe(0);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  it("connect wrote the server and Claude-shaped hooks into ~/.qwen/settings.json, under Qwen's tool names", () => {
    const settings = JSON.parse(readFileSync(path.join(home, ".qwen", "settings.json"), "utf8"));
    expect(settings.mcpServers["opencadre-session"]).toEqual({ command: "node", args: [path.join(bin, "opencadre-mcp.mjs"), "--client", "qwen"], alwaysLoadTools: true });
    const pre = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }>;
    // `monitor` runs a model-chosen shell command too.
    expect(pre[0].matcher).toBe("run_shell_command|monitor");
    // On POSIX the hook runs under `bash -c`, where $PPID is Qwen: the host whose MCP child recorded the seat.
    const hostArg = process.platform === "win32" ? "" : ' --host-pid "$PPID"';
    expect(pre[0].hooks[0]).toMatchObject({ command: `node "${path.join(bin, "opencadre-approval-gate.mjs")}" --client qwen${hostArg}`, timeout: 600 });
    expect(settings.hooks.PostToolUse[0].matcher).toBe("run_shell_command|edit|write_file");
    // Mail at the end of a turn only: no idle watcher, which Qwen could not use.
    expect(JSON.stringify(settings.hooks.Stop)).toContain("opencadre-awareness.mjs");
    expect(JSON.stringify(settings.hooks.Stop)).not.toContain("opencadre-wake.mjs");
  });

  it("two Qwen processes are two agents; a process without the variable is refused rather than guessed", async () => {
    for (const [session, task] of [["qwen-A", "qwen A at work"], ["qwen-B", "qwen B at work"]]) {
      const p = await qwenHost(session);
      if (session === "qwen-A") HOST_A = pidOf(p);
      expect((await p.initialize()).error).toBeUndefined();
      await p.callTool("set_status", { task });
    }
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null; currentTask?: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tool)).toEqual(["qwen", "qwen"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "qwen", projectName: "QwenProj" });
    const bare = await qwenHost(null);
    const res = await bare.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(res.error?.message).toMatch(/no id/);
  });

  const agentOf = async (task: string) => ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>)
    .find((r) => r.currentTask === task)!.agentName;
  const nameIn = (out: string) => /You are ([A-Z][a-z]+(?: [A-Z][a-z]+| \d+)?) in the OpenCadre fleet/.exec(JSON.parse(out).hookSpecificOutput.additionalContext)?.[1];

  it("after /clear Qwen exports a NEW session id to its hooks, and they still name the agent its tool calls act as", async () => {
    // What Qwen 0.24.4 does: startNewSession sets QWEN_CODE_SESSION_ID to the new id; the MCP child keeps "qwen-A".
    const r = await hook("opencadre-awareness.mjs", "after-clear-7f3", HOST_A, payload("SessionStart", "after-clear-7f3", { source: "clear" }));
    expect(nameIn(r.out)).toBe(await agentOf("qwen A at work"));
    expect(JSON.parse(r.out).hookSpecificOutput.additionalContext).toMatch(/Qwen Code cannot wake an idle session/);
    // Falsifier: from a host whose child recorded nothing, the new id names no agent, and the hook says nothing.
    const stranger = await hook("opencadre-awareness.mjs", "after-clear-7f3", "900099", payload("SessionStart", "after-clear-7f3", { source: "clear" }));
    expect(stranger.out).toBe("");
  });

  it("MAIL: unread mail at Stop blocks it once with the notice, after /clear too", async () => {
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: await agentOf("qwen A at work"), body: "qwen, please look", priority: "high" }),
    });
    const stop = (active: boolean) => hook("opencadre-awareness.mjs", "after-clear-7f3", HOST_A, payload("Stop", "after-clear-7f3", { stop_hook_active: active }));
    const blocked = JSON.parse((await stop(false)).out);
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toMatch(/qwen, please look/);
    expect((await stop(true)).out).toBe("");
  });

  it("CLEARANCE: run_shell_command after /clear is held, requested as the process's agent, and denied in Claude's shape", async () => {
    const gate = hook("opencadre-approval-gate.mjs", "after-clear-7f3", HOST_A,
      payload("PreToolUse", "after-clear-7f3", { tool_name: "run_shell_command", tool_input: { command: "rm -rf ./src" } }),
      { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].details).toMatch(/^Qwen Code wants to run this shell command/);
    expect(pending[0].requested_by_agent_name).toBe(await agentOf("qwen A at work"));
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    expect(JSON.parse((await gate).out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("a second process resuming the SAME session is its own agent, and its hooks name it", async () => {
    // `qwen --resume qwen-A` in another terminal while the first still runs: both export "qwen-A" at spawn.
    const p = await qwenHost("qwen-A");
    const HOST_C = pidOf(p);
    expect((await p.initialize()).error).toBeUndefined();
    await p.callTool("set_status", { task: "qwen A resumed elsewhere" });
    const resumed = await agentOf("qwen A resumed elsewhere");
    expect(resumed).not.toBe(await agentOf("qwen A at work"));
    const r = await hook("opencadre-awareness.mjs", "qwen-A", HOST_C, payload("SessionStart", "qwen-A", { source: "resume" }));
    expect(nameIn(r.out)).toBe(resumed);
  });

  it("ACP mode: the pooled child holds no seat, each call's own session id names its agent, and a nameless call is refused", async () => {

    const before = (await liveSessions(hub.url, operatorKey, deviceId) as unknown[]).length;
    const p = await qwenHost("acp-bootstrap", ["--acp"]);
    const HOST_ACP = pidOf(p);
    expect((await p.initialize()).error).toBeUndefined();
    expect((await liveSessions(hub.url, operatorKey, deviceId) as unknown[]).length).toBe(before);
    const nameless = await p.request("tools/call", { name: "set_status", arguments: { task: "nobody" } });
    expect(nameless.error?.message).toMatch(/did not say which session it belongs to/);
    const invocation = (sessionId: string) => ({ "qwen-code/invocation": { version: 1, sessionId, promptId: "p1" } });
    for (const [sid, task] of [["acp-s1", "acp session 1"], ["acp-s2", "acp session 2"]]) {
      const res = await p.request("tools/call", { name: "set_status", arguments: { task }, _meta: invocation(sid) });
      expect(res.error).toBeUndefined();
    }
    const one = await agentOf("acp session 1");
    expect(one).not.toBe(await agentOf("acp session 2"));
    // A session's hooks run with that session's id in QWEN_CODE_SESSION_ID; the pooled record sends them to it.
    const r = await hook("opencadre-awareness.mjs", "acp-s1", HOST_ACP, payload("SessionStart", "acp-s1", { source: "startup" }));
    expect(nameIn(r.out)).toBe(one);
  });

  it("a proxy that cannot find the Qwen process that started it FAILS CLOSED: its calls are refused, not pooled", async () => {
    const before = (await liveSessions(hub.url, operatorKey, deviceId) as unknown[]).length;
    // Spawned straight from the test runner: no ancestor is Qwen.
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), { ...qwenChildEnv(home), QWEN_CODE_SESSION_ID: "orphan-1" }, project, "qwen");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    const res = await p.request("tools/call", { name: "set_status", arguments: { task: "orphan" } });
    expect(res.error?.message).toMatch(/could not find the process that started it/);
    expect((await liveSessions(hub.url, operatorKey, deviceId) as unknown[]).length).toBe(before);
  });

  it("a prompt that merely CONTAINS --acp after `--` does not make an interactive Qwen look like ACP", async () => {
    const p = await qwenHost("qwen-D", ["--", "please", "--acp"]);
    expect((await p.initialize()).error).toBeUndefined();
    await p.callTool("set_status", { task: "qwen D interactive" });
    const named = await agentOf("qwen D interactive");
    expect(named).toMatch(WORD_NAME);
    expect(await sessionNamed(hub.url, operatorKey, named)).toMatchObject({ tool: "qwen", projectName: "QwenProj" });
  });

  it("a hook from a process whose child has not recorded a seat yet never borrows a seat another process holds", async () => {
    // A third terminal resumed qwen-A before its MCP child started: its hook exports "qwen-A", which A's child holds.
    const r = await hook("opencadre-awareness.mjs", "qwen-A", String(process.pid), payload("SessionStart", "qwen-A", { source: "resume" }));
    expect(r.out).toBe("");
  });

  it("doctor --client qwen finds the server and the hooks", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "qwen", "--home", home], qwenChildEnv(home));
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
  });
});

describe("recognising Qwen among a proxy's ancestors", () => {
  it("takes the NEAREST ancestor running Qwen's entry script, past a Node shim, with either slash, and none when there is none", async () => {
    const { locateHost, hostFlags } = await import("../scripts/opencadre-config.mjs");
    const { hostHandoffFor } = await import("../scripts/opencadre-clients.mjs");
    const { entryEnv, pattern } = hostHandoffFor("qwen");
    const entry = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@qwen-code\\qwen-code\\cli.js";
    const chain = [
      { pid: 30, ppid: 20, line: "C:\\Users\\me\\scoop\\shims\\node.exe C:\\Users\\me\\.opencadre\\bin\\opencadre-mcp.mjs --client qwen" },
      { pid: 20, ppid: 10, line: `"C:\\Program Files\\nodejs\\node.exe" --expose-gc ${entry} "--acp"` },
      { pid: 10, ppid: 1, line: "node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@qwen-code\\qwen-code\\cli-entry.js --acp" },
    ];
    expect(locateHost({ entryEnv, pattern, env: { QWEN_CODE_CLI: entry }, chain })).toMatchObject({ pid: 20 });
    // Without the variable (or with a garbled one), the production pattern finds the same process, backslashes and all.
    expect(locateHost({ entryEnv, pattern, env: {}, chain })).toMatchObject({ pid: 20 });
    expect(locateHost({ entryEnv, pattern, env: {}, chain: chain.slice(0, 1) })).toBeNull();
    // A checkout that merely has "qwen-code" in its path is not Qwen.
    expect(locateHost({ entryEnv, pattern, env: {}, chain: [{ pid: 5, ppid: 1, line: "vim /home/me/src/qwen-code/notes.txt" }] })).toBeNull();
    expect(hostFlags(chain[1].line)).toContain("--acp");
    expect(hostFlags("node cli.js -p please -- --acp")).not.toContain("--acp");
    // Linux keeps the real argv: a prompt that mentions the flag is one argument, not a flag.
    expect(hostFlags("node cli.js -p explain the --acp flag", ["node", "cli.js", "-p", "explain the --acp flag"])).not.toContain("--acp");
  });

  it("a hook told its host's pid reads ONLY that host's record, never an outer Qwen's (a nested `qwen -p`)", async () => {
    const { findHostHandoff } = await import("../scripts/opencadre-config.mjs");
    const { hostHandoffFor } = await import("../scripts/opencadre-clients.mjs");
    const home = tempDir("oc-qwen-nested-");
    // This test process plays the INNER host's hook; its parent plays the OUTER Qwen, whose child (this process) is live.
    mkdirSync(path.join(home, ".opencadre", "run"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "run", `qwen-${process.ppid}.json`),
      JSON.stringify({ client: "qwen", hostPid: process.ppid, proxyPid: process.pid, seat: "OUTER-SEAT", mode: "process" }));
    const env = { OPENCADRE_HOOK_HOME: home } as NodeJS.ProcessEnv;
    // Without --host-pid the parent IS read (a hook its host ran directly): the record is real.
    expect(findHostHandoff({ client: "qwen", spec: hostHandoffFor("qwen"), argv: [], env })?.seat).toBe("OUTER-SEAT");
    // Told its own host (an inner Qwen with no record yet), it reads that alone and finds nothing.
    const inner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
    try {
      expect(findHostHandoff({ client: "qwen", spec: hostHandoffFor("qwen"), argv: ["--host-pid", String(inner.pid)], env })).toBeNull();
    } finally {
      inner.kill();
    }
  });
});
