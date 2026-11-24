// Factory Droid: the adapter driven the way Droid drives it, MEASURED on droid 0.226.2 headless with a scripted model
// and no account (docs/research/HARNESS-ADAPTERS.md, Droid row):
//   identity  one shared MCP process; every `tools/call` carries `_meta.assemblySessionId`, the hooks' `session_id`
//   hooks     a FLAT ~/.factory/hooks.json; Claude's payload (session_id, cwd, transcript_path, permission_mode) and
//             answers, except that `allow` skips Droid's own prompt; DROID_PROJECT_DIR and CLAUDE_PROJECT_DIR are set
//   shell     `Execute`, with `tool_input.command`
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stampActive } from "../scripts/opencadre-config.mjs";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

function runHook(script: string, client: string, payload: unknown, env: Record<string, string>, cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--client", client], { env, cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("Factory Droid, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let bin: string;
  const project = gitProject("DroidProj");
  const proxies: ProxyProcess[] = [];
  const factory = () => path.join(home, ".factory");
  const env = (extra: Record<string, string> = {}) => childEnv(home, {
    FACTORY_HOME_OVERRIDE: "", DROID_PROJECT_DIR: project, FACTORY_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project,
    OPENCADRE_AWARENESS_STATE_DIR: path.join(home, "aw"), ...extra,
  });
  const payload = (event: string, session: string, extra: object = {}) => ({
    session_id: session, transcript_path: path.join(home, "t.jsonl"), cwd: project, permission_mode: "auto-high", hook_event_name: event, ...extra,
  });
  const hook = (script: string, body: object, extra: Record<string, string> = {}) => runHook(path.join(bin, script), "droid", body, env(extra), project);

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Droid Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:droidproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-droid-e2e-");
    // The user's own model, hook and server, which connect must keep.
    mkdirSync(factory(), { recursive: true });
    writeFileSync(path.join(factory(), "hooks.json"), JSON.stringify({ PreToolUse: [{ matcher: "Execute", hooks: [{ type: "command", command: "my-audit.sh" }] }] }));
    writeFileSync(path.join(factory(), "mcp.json"), JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "droid"], childEnv(home, { FACTORY_HOME_OVERRIDE: "" }));
    expect(connected.code, connected.err).toBe(0);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  const agentOf = async (task: string) => ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === task)?.agentName;

  it("connect kept the user's hook and server, and added its own to the FLAT hooks file", () => {
    const hooks = JSON.parse(readFileSync(path.join(factory(), "hooks.json"), "utf8"));
    expect(hooks.hooks).toBeUndefined();
    expect(hooks.PreToolUse[0]).toEqual({ matcher: "Execute", hooks: [{ type: "command", command: "my-audit.sh" }] });
    expect(hooks.PreToolUse[1]).toEqual({ matcher: "Execute", hooks: [{ type: "command", command: `node "${path.join(bin, "opencadre-approval-gate-loader.mjs")}" --client droid`, timeout: 600 }] });
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) expect(hooks[event][0].hooks[0].command).toBe(`node "${path.join(bin, "opencadre-awareness.mjs")}" --client droid`);
    const mcp = JSON.parse(readFileSync(path.join(factory(), "mcp.json"), "utf8"));
    expect(mcp.mcpServers.linear).toEqual({ type: "http", url: "https://mcp.linear.app/mcp" });
    expect(mcp.mcpServers["opencadre-session"]).toEqual({ type: "stdio", command: "node", args: [path.join(bin, "opencadre-mcp.mjs"), "--client", "droid"] });
    expect(stampActive({ client: "droid", home, env: childEnv(home, { FACTORY_HOME_OVERRIDE: "" }) })).toBe(true);
  });

  it("running connect again adds nothing twice", async () => {
    const before = readFileSync(path.join(factory(), "hooks.json"), "utf8");
    const again = await runNode(CLI, ["connect", "--home", home, "--client", "droid"], childEnv(home, { FACTORY_HOME_OVERRIDE: "" }));
    expect(again.code, again.err).toBe(0);
    expect(readFileSync(path.join(factory(), "hooks.json"), "utf8")).toBe(before);
  });

  it("two Droid sessions are two agents through the one shared MCP process; a call naming none is refused", async () => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "droid");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    // Nothing is opened for the process itself.
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(0);
    expect((await p.request("tools/call", { name: "set_status", arguments: { task: "no id" } })).error?.message).toMatch(/no identity stamp|did not say which/);
    for (const [s, task] of [["droid-A", "A at work"], ["droid-B", "B at work"]]) {
      const res = await p.request("tools/call", { name: "set_status", arguments: { task }, _meta: { assemblySessionId: s, caller: "AGENT" } });
      expect(res.error, JSON.stringify(res.error)).toBeUndefined();
    }
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null }>;
    expect(rows.map((r) => r.tool)).toEqual(["droid", "droid"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "droid", projectName: "DroidProj" });
  });

  it("a session is told its name when it starts, and unread mail continues its turn once", async () => {
    const agent = (await agentOf("A at work"))!;
    const said = JSON.parse((await hook("opencadre-awareness.mjs", payload("SessionStart", "droid-A", { source: "startup" }))).out);
    expect(said.hookSpecificOutput.additionalContext).toMatch(new RegExp(`You are ${agent}`));
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "droid, please look", priority: "high" }),
    });
    const stop = JSON.parse((await hook("opencadre-awareness.mjs", payload("Stop", "droid-A", { stop_hook_active: false }))).out);
    expect(stop).toMatchObject({ decision: "block", reason: expect.stringMatching(/droid, please look/) });
    expect((await hook("opencadre-awareness.mjs", payload("Stop", "droid-A", { stop_hook_active: true }))).out).toBe("");
  });

  it("CLEARANCE: a risky Execute is held as the session's agent; a denial is Claude's deny; an approval is NOT said as allow", async () => {
    const { listApprovals } = await import("../src/approvals.js");
    const decide = async (decision: "deny" | "approve", note: string) => {
      let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
      for (let i = 0; i < 100 && pending.length === 0; i++) {
        pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
        if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(pending).toHaveLength(1);
      expect(pending[0].details).toMatch(/^Factory Droid wants to run this shell command in .*DroidProj/);
      await decideAsPerson(hub.url, orgId, pending[0].id, { decision, note });
      return pending[0];
    };
    const exec = (command: string, session = "droid-A") => hook("opencadre-approval-gate-loader.mjs", payload("PreToolUse", session, { tool_name: "Execute", tool_input: { command, riskLevel: "high", riskLevelReason: "x" } }), { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const denied = exec("rm -rf ./src");
    expect((await decide("deny", "no")).requested_by_agent_name).toBe(await agentOf("A at work"));
    // Said by exit 2, reason on stderr: an earlier hook's JSON `allow` would override a JSON deny (review of e7ee431, B1).
    const d = await denied;
    expect(d.code).toBe(2);
    expect(d.out).toBe("");
    expect(d.err).toMatch(/denied by Operator: no/);
    const approved = exec("rm -rf ./lib");
    await decide("approve", "fine");
    expect((await approved).out).toBe("");
    expect((await exec("git status")).out).toBe("");
    // A brand-new session whose FIRST act is the risky command is held as the agent its later calls land on.
    const first = exec("rm -rf ./app", "droid-C");
    const asked = await decide("deny", "first");
    await first;
    const p = proxies[0];
    await p.request("tools/call", { name: "set_status", arguments: { task: "C at work" }, _meta: { assemblySessionId: "droid-C" } });
    expect(asked.requested_by_agent_name).toBe(await agentOf("C at work"));
  });

  it("a gate that cannot read the Execute blocks it; the Claude Code hooks Droid's env also fits stand down", async () => {
    const unreadable = await hook("opencadre-approval-gate-loader.mjs", payload("PreToolUse", "droid-A", { tool_name: "Execute", tool_input: {} }), GATE_TEST_ENV);
    expect(unreadable.code).toBe(2);
    expect(unreadable.err).toMatch(/could not read this shell command/);
    // Droid sets CLAUDE_PROJECT_DIR for its hooks too; a Claude Code hook must not act on a Droid session.
    const claude = await runHook(path.join(bin, "opencadre-awareness.mjs"), "claude-code", payload("SessionStart", "droid-A", { source: "startup" }), env(), project);
    expect(claude.out).toBe("");
    expect(claude.err).toMatch(/this payload came from droid/);
  });

  it("the proxy refuses Droid's placeholder session ids and any stamp in a call's arguments (review of e7ee431)", async () => {
    const p = proxies[0];
    for (const placeholder of ["unknown-session", "unknown"]) {
      expect((await p.request("tools/call", { name: "set_status", arguments: { task: "ghost" }, _meta: { assemblySessionId: placeholder } })).error?.message).toMatch(/named no session/);
    }
    expect((await p.request("tools/call", { name: "set_status", arguments: { task: "x", _opencadre_stamp: { sid: "droid-A" } }, _meta: { assemblySessionId: "droid-A" } })).error?.message).toMatch(/never sends/);
    expect((await p.request("tools/call", { name: "set_status", arguments: { task: "none" } })).error?.message).toMatch(/Factory Droid did not say which session/);
    // A hook handed the placeholder names no one: the gate blocks a risky command rather than act as a shared agent.
    const ghost = await hook("opencadre-approval-gate-loader.mjs", payload("PreToolUse", "unknown", { tool_name: "Execute", tool_input: { command: "rm -rf ./x" } }), { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    expect(ghost.code).toBe(2);
    expect(ghost.err).toMatch(/no OpenCadre session|blocked/);
  });

  it("doctor --client droid finds the server and the hooks", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "droid", "--home", home], childEnv(home, { FACTORY_HOME_OVERRIDE: "" }));
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
  });
});
