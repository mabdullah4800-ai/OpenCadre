// Goose: the capabilities of LAUNCH-CLIENT-GATE.md §1 that can be exercised without a signed-in Goose, driven the way
// Goose drives its extensions and hooks. Read in aaif-goose/goose at 80c1197 (docs/research/HARNESS-ADAPTERS.md §3):
//   - identity: each session's stdio extension is spawned with AGENT_SESSION_ID (extension_manager/mod.rs), and every
//     MCP request carries `_meta["agent-session-id"]` (session_context.rs)
//   - hooks: a plugin's hooks/hooks.json; payload { event, session_id, tool_name, tool_input, working_dir, … };
//     PreToolUse and Stop read `{"decision":"block","reason"}`; an empty stdout is no opinion; no stop_hook_active
//   - the shell tool is `shell`, with `tool_input.command`
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeYamlMapEntry, readGooseServer } from "../cli/lib/clients.mjs";
import { gooseDirs } from "../scripts/opencadre-clients.mjs";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME, sessionNamed,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

/** Goose's folders are the home's own: no machine XDG_CONFIG_HOME or GOOSE_PATH_ROOT leaks in. */
const gooseEnv = (home: string, extra: Record<string, string> = {}) => childEnv(home, { XDG_CONFIG_HOME: "", GOOSE_PATH_ROOT: "", ...extra });

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

describe("Goose, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let bin: string;
  const project = gitProject("GooseProj");
  const proxies: ProxyProcess[] = [];
  const configFile = () => path.join(gooseDirs(home, gooseEnv(home)).config, "config.yaml");
  const USER_CONFIG = "GOOSE_PROVIDER: openai\nGOOSE_MODEL: gpt-4o\nextensions:\n  developer:\n    enabled: true\n    type: platform\n    name: developer\n    bundled: true\nGOOSE_MODE: smart_approve\n";

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Goose Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:gooseproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-goose-e2e-");
    mkdirSync(path.dirname(configFile()), { recursive: true });
    writeFileSync(configFile(), USER_CONFIG);
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "goose"], gooseEnv(home));
    expect(connected.code, connected.err).toBe(0);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  /** A Goose session's extension: spawned with that session's id in AGENT_SESSION_ID. */
  const extension = async (session: string) => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), gooseEnv(home, { AGENT_SESSION_ID: session }), project, "goose");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    return p;
  };
  const payload = (event: string, session: string, extra: object = {}) => ({ event, session_id: session, working_dir: project, ...extra });
  const hook = (script: string, body: object, extra: Record<string, string> = {}) =>
    runHook(path.join(bin, script), ["--client", "goose"], body, gooseEnv(home, extra));
  const agentOf = async (task: string) => ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>)
    .find((r) => r.currentTask === task)?.agentName;
  const send = async (toAgent: string, body: string) => {
    const sent = await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent, body, priority: "high" }),
    });
    expect(sent.status).toBe(201);
  };

  it("connect added the extension to config.yaml, kept every other line, and wrote OpenCadre's Goose plugin", () => {
    const after = readFileSync(configFile(), "utf8");
    // The user's lines are all still there, in order.
    for (const line of USER_CONFIG.trim().split("\n")) expect(after).toContain(line);
    expect(after.indexOf("GOOSE_MODE: smart_approve")).toBeGreaterThan(after.indexOf("opencadre-session:"));
    expect(readGooseServer(after)).toMatchObject({ found: true, sessionServer: true, disabled: false });
    expect(after).toContain(`args: [${JSON.stringify(path.join(bin, "opencadre-mcp.mjs"))}, "--client", "goose"]`);
    const plugin = path.join(home, ".agents", "plugins", "opencadre");
    expect(JSON.parse(readFileSync(path.join(plugin, "plugin.json"), "utf8")).name).toBe("opencadre");
    const hooks = JSON.parse(readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8")).hooks;
    // Fails CLOSED: Goose's default lets a command run when its hook fails.
    expect(hooks.PreToolUse[0]).toMatchObject({ matcher: "^shell$", hooks: [{ type: "command", timeout: 600, on_failure: "block" }] });
    expect(hooks.PreToolUse[0].hooks[0].command).toBe(`node '${path.join(bin, "opencadre-approval-gate.mjs").replaceAll("\\", "/")}' --client goose`);
    expect(hooks.Stop[0].hooks[0].command).toContain("opencadre-awareness.mjs' --client goose");
  });

  it("two Goose sessions are two agents, each joining when its extension starts, and each is told the protocol", async () => {
    const a = await extension("goose-A");
    const b = await extension("goose-B");
    // Joined at start, so the hooks (which only look an agent up) find it before any OpenCadre call.
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(2);
    const init = a.messages.find((m) => m.result?.serverInfo);
    expect(init?.result.instructions).toMatch(/get_messages/);
    await a.callTool("set_status", { task: "goose A at work" });
    await b.callTool("set_status", { task: "goose B at work" });
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tool)).toEqual(["goose", "goose"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "goose", projectName: "GooseProj" });
  });

  it("a call naming its session in _meta acts as THAT session, even from an extension spawned with a stale id", async () => {
    // An extension the model added mid-session inherits Goose's own (stale) AGENT_SESSION_ID.
    const stale = await extension("goose-stale");
    const res = await stale.request("tools/call", { name: "set_status", arguments: { task: "goose C at work" }, _meta: { "agent-session-id": "goose-C" } });
    expect(res.error).toBeUndefined();
    const named = await agentOf("goose C at work");
    expect(named).toMatch(WORD_NAME);
    expect(await sessionNamed(hub.url, operatorKey, named)).toMatchObject({ tool: "goose", projectName: "GooseProj" });
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ currentTask?: string }>;
    // A, B, C, and the seat the stale extension opened at start, which carries no task: the call did not land there.
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.currentTask === "goose C at work")).toHaveLength(1);
    // And that agent IS session goose-C: its Stop hook finds the mail sent to it.
    await send((await agentOf("goose C at work"))!, "for session C");
    const stop = JSON.parse((await hook("opencadre-awareness.mjs", payload("Stop", "goose-C"))).out);
    expect(stop.reason).toMatch(/for session C/);
  });

  it("MAIL: unread mail blocks the Stop once, in Goose's shape; the same mail again is let go, new mail blocks again", async () => {
    await send((await agentOf("goose A at work"))!, "goose, please look");
    const stop = () => hook("opencadre-awareness.mjs", payload("Stop", "goose-A", { last_assistant_message: "done" }));
    const first = JSON.parse((await stop()).out);
    expect(first).toEqual({ decision: "block", reason: expect.stringMatching(/goose, please look/) });
    expect((await stop()).out).toBe("");
    await send((await agentOf("goose A at work"))!, "and one more thing");
    expect(JSON.parse((await stop()).out).reason).toMatch(/and one more thing/);
    // The other session has no mail.
    expect((await hook("opencadre-awareness.mjs", payload("Stop", "goose-B"))).out).toBe("");
  });

  it("CLEARANCE: a risky `shell` command is held as the session's agent, and a denial blocks it in Goose's shape", async () => {
    const gate = hook("opencadre-approval-gate.mjs", payload("PreToolUse", "goose-A", { tool_name: "shell", tool_input: { command: "rm -rf ./src" }, tool_call_id: "t1" }),
      { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].details).toMatch(/^Goose wants to run this shell command in .*GooseProj/);
    expect(pending[0].requested_by_agent_name).toBe(await agentOf("goose A at work"));
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    expect(JSON.parse((await gate).out)).toEqual({ decision: "block", reason: expect.stringMatching(/denied by Operator: no/) });
    const quiet = await hook("opencadre-approval-gate.mjs", payload("PreToolUse", "goose-A", { tool_name: "shell", tool_input: { command: "git status" } }));
    expect(quiet.out).toBe("");
  });

  it("CLEARANCE before any OpenCadre call: a brand-new session's risky command is still held (review of d6a7ef7, B1)", async () => {
    await extension("goose-fresh");
    const gate = hook("opencadre-approval-gate.mjs", payload("PreToolUse", "goose-fresh", { tool_name: "shell", tool_input: { command: "rm -rf ./src" } }),
      { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending).toHaveLength(1);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    expect(JSON.parse((await gate).out).decision).toBe("block");
  });

  it("the same session id under another Goose data root is another agent, and its hooks name it (B2)", async () => {
    const other = { GOOSE_PATH_ROOT: path.join(home, "profile-2") };
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), gooseEnv(home, { AGENT_SESSION_ID: "goose-A", ...other }), project, "goose");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    await p.callTool("set_status", { task: "goose A in profile 2" });
    const second = await agentOf("goose A in profile 2");
    expect(second).not.toBe(await agentOf("goose A at work"));
    await send(second!, "for profile two");
    const stop = JSON.parse((await hook("opencadre-awareness.mjs", payload("Stop", "goose-A"), other)).out);
    expect(stop.reason).toMatch(/for profile two/);
  });

  it("a Claude-shaped payload (hook_event_name, no `event`) is not handled as Goose's", async () => {
    const r = await hook("opencadre-approval-gate.mjs", { hook_event_name: "PreToolUse", session_id: "goose-A", cwd: project, tool_name: "shell", tool_input: { command: "echo hi" } });
    expect(r.out).toBe("");
    const a = await hook("opencadre-awareness.mjs", { hook_event_name: "Stop", session_id: "goose-A", cwd: project });
    expect(a.out).toBe("");
  });

  it("doctor --client goose finds the extension and the plugin", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "goose", "--home", home], gooseEnv(home));
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
    // Goose switched the plugin off in its own config: doctor must not call that present (S1).
    const before = readFileSync(configFile(), "utf8");
    writeFileSync(configFile(), `${before}plugins:\n  ${path.join(home, ".agents", "plugins", "opencadre")}:\n    enabled: false\n`);
    try {
      const off = await runNode(CLI, ["doctor", "--client", "goose", "--home", home], gooseEnv(home));
      expect(off.out).toMatch(/hooks=partial/);
    } finally {
      writeFileSync(configFile(), before);
    }
  });

  it("connecting again changes nothing", async () => {
    const before = readFileSync(configFile(), "utf8");
    const r = await runNode(CLI, ["connect", "--home", home, "--client", "goose"], gooseEnv(home));
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(configFile(), "utf8")).toBe(before);
  });
});

describe("Goose's config.yaml, merged line by line", () => {
  const entry = ["opencadre-session:", "  enabled: true", "  cmd: node", '  args: ["/p/opencadre-mcp.mjs", "--client", "goose"]'];

  it("adds the entry under the user's own indent, replaces an old one in place, and is idempotent", () => {
    const four = "# mine\nextensions:\n    developer:\n        enabled: true\n\n    opencadre-session:\n        enabled: false\n        cmd: old\n\n    memory:\n        enabled: true\nGOOSE_MODEL: x\n";
    const once = mergeYamlMapEntry(four, "extensions", "opencadre-session", entry);
    expect(once).toBe("# mine\nextensions:\n    developer:\n        enabled: true\n\n    opencadre-session:\n      enabled: true\n      cmd: node\n      args: [\"/p/opencadre-mcp.mjs\", \"--client\", \"goose\"]\n\n    memory:\n        enabled: true\nGOOSE_MODEL: x\n");
    expect(mergeYamlMapEntry(once, "extensions", "opencadre-session", entry)).toBe(once);
    expect(mergeYamlMapEntry("", "extensions", "opencadre-session", entry)).toBe(`extensions:\n${entry.map((l) => `  ${l}`).join("\n")}\n`);
    expect(mergeYamlMapEntry("extensions: {}\nA: 1\n", "extensions", "opencadre-session", entry)).toMatch(/^extensions:\n {2}opencadre-session:/);
  });

  it("refuses a shape it would have to guess at, rather than write a broken config", () => {
    // A byte-order mark or a second `extensions:` would make Goose reject the whole file (S5).
    for (const bad of ["extensions:\n  - a\n", "extensions: {a: 1}\n", "extensions:\n\tdev: 1\n", "\uFEFFextensions:\n  dev:\n    enabled: true\n", "extensions:\n  a: 1\nextensions:\n  b: 2\n"]) {
      expect(() => mergeYamlMapEntry(bad, "extensions", "opencadre-session", entry)).toThrow(/cannot add opencadre-session/);
    }
  });
});
