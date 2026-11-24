// Mistral Vibe: the adapter driven the way Vibe drives its hooks, MEASURED on vibe 2.25.8 headless with a scripted
// model and no account (docs/research/HARNESS-ADAPTERS.md, Vibe row):
//   hooks     ~/.vibe/hooks.toml `[[hooks]]` of type pre_tool / post_tool / post_agent; payload { hook_event_name,
//             session_id, transcript_path, cwd, tool_name, tool_input }; answers { decision, reason,
//             hook_specific_output: { tool_input | additional_context } }; a `tool_input` REPLACES the arguments
//   identity  a shared MCP pool, no id: every OpenCadre call is stamped
//   tools     `bash` runs commands; MCP tools are `<server>_<tool>`
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAMP_FIELD, stampActive, verifyStamp } from "../scripts/opencadre-config.mjs";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME, sessionNamed,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

function runHook(script: string, payload: unknown, env: Record<string, string>, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--client", "vibe"], { env, cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("Mistral Vibe, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let credential: string;
  let bin: string;
  const project = gitProject("VibeProj");
  const proxies: ProxyProcess[] = [];
  const vibeDir = () => path.join(home, ".vibe");
  const vibeEnv = (extra: Record<string, string> = {}) => childEnv(home, { VIBE_HOME: "", ...extra });
  const env = (extra: Record<string, string> = {}) => vibeEnv({ OPENCADRE_AWARENESS_STATE_DIR: path.join(home, "aw"), OPENCADRE_AWARENESS_MIN_INTERVAL: "0", ...extra });
  const payload = (event: string, session: string, extra: object = {}) => ({ hook_event_name: event, session_id: session, parent_session_id: null, transcript_path: path.join(home, "t.jsonl"), cwd: project, ...extra });
  const hook = (script: string, body: object, extra: Record<string, string> = {}) => runHook(path.join(bin, script), body, env(extra), project);
  const USER_CONFIG = 'active_model = "mine"\n\n[[providers]]\nname = "mine"\napi_base = "http://127.0.0.1:1/v1"\n\n[[mcp_servers]]\nname = "linear"\ntransport = "http"\nurl = "https://mcp.linear.app/mcp"\n';
  const USER_HOOKS = '[[hooks]]\nname = "audit"\ntype = "pre_tool"\nmatch = "bash"\ncommand = "my-audit.sh"\n';

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Vibe Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:vibeproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-vibe-e2e-");
    mkdirSync(vibeDir(), { recursive: true });
    writeFileSync(path.join(vibeDir(), "config.toml"), USER_CONFIG);
    writeFileSync(path.join(vibeDir(), "hooks.toml"), USER_HOOKS);
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "vibe"], vibeEnv());
    expect(connected.code, connected.err).toBe(0);
    credential = computerCredential(home);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  it("connect kept the user's config, server and hook, and added its own entries", () => {
    const config = readFileSync(path.join(vibeDir(), "config.toml"), "utf8");
    expect(config.startsWith(USER_CONFIG.trimEnd())).toBe(true);
    expect(config).toContain(`[[mcp_servers]]\nname = "opencadre-session"\ntransport = "stdio"\ncommand = "node"\nargs = [${JSON.stringify(path.join(bin, "opencadre-mcp.mjs"))}, "--client", "vibe"]`);
    const hooks = readFileSync(path.join(vibeDir(), "hooks.toml"), "utf8");
    expect(hooks.startsWith(USER_HOOKS.trimEnd())).toBe(true);
    expect(hooks).toContain('name = "opencadre-gate"\ntype = "pre_tool"\nmatch = "bash"\nstrict = true');
    for (const name of ["opencadre-stamp", "opencadre-awareness", "opencadre-mail"]) expect(hooks).toContain(`name = "${name}"`);
    expect(stampActive({ client: "vibe", home, env: vibeEnv() })).toBe(true);
  });

  it("running connect again adds nothing twice", async () => {
    const before = [readFileSync(path.join(vibeDir(), "config.toml"), "utf8"), readFileSync(path.join(vibeDir(), "hooks.toml"), "utf8")];
    const again = await runNode(CLI, ["connect", "--home", home, "--client", "vibe"], vibeEnv());
    expect(again.code, again.err).toBe(0);
    expect([readFileSync(path.join(vibeDir(), "config.toml"), "utf8"), readFileSync(path.join(vibeDir(), "hooks.toml"), "utf8")]).toEqual(before);
  });

  it("the stamp REPLACES the arguments with every one kept plus the stamp, and only on OpenCadre's tools", async () => {
    const said = JSON.parse((await hook("opencadre-session-stamp.mjs", payload("pre_tool", "vibe-A", { tool_name: "opencadre-session_set_status", tool_input: { task: "x" } }))).out);
    expect(said.decision).toBeUndefined();
    expect(Object.keys(said.hook_specific_output.tool_input).sort()).toEqual([STAMP_FIELD, "task"]);
    expect(verifyStamp(credential, said.hook_specific_output.tool_input[STAMP_FIELD])).toEqual({ ok: true, sessionId: "vibe-A" });
    expect((await hook("opencadre-session-stamp.mjs", payload("pre_tool", "vibe-A", { tool_name: "linear_search", tool_input: {} }))).out).toBe("");
  });

  it("two Vibe sessions are two agents through the one shared MCP process, and an unstamped call is refused", async () => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "vibe");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    expect((await p.request("tools/call", { name: "set_status", arguments: { task: "no stamp" } })).error?.message).toMatch(/no identity stamp/);
    for (const [s, task] of [["vibe-A", "A at work"], ["vibe-B", "B at work"]]) {
      const input = JSON.parse((await hook("opencadre-session-stamp.mjs", payload("pre_tool", s, { tool_name: "opencadre-session_set_status", tool_input: { task } }))).out).hook_specific_output.tool_input;
      await p.callTool("set_status", input);
    }
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null }>;
    expect(rows.map((r) => r.tool)).toEqual(["vibe", "vibe"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "vibe", projectName: "VibeProj" });
  });

  it("a session hears its name with a tool's result, and unread mail continues its turn once", async () => {
    const agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "A at work")!.agentName;
    const first = JSON.parse((await hook("opencadre-awareness.mjs", payload("post_tool", "vibe-A", { tool_name: "read_file", tool_input: {} }))).out);
    expect(first.hook_specific_output.additional_context).toMatch(new RegExp(`You are ${agent}`));
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "vibe, please look", priority: "high" }),
    });
    const stop = JSON.parse((await hook("opencadre-awareness.mjs", payload("post_agent", "vibe-A"))).out);
    expect(stop).toEqual({ decision: "deny", reason: expect.stringMatching(/vibe, please look|unread OpenCadre message/) });
    // The same mail does not continue the turn again (Vibe has no stop_hook_active).
    expect((await hook("opencadre-awareness.mjs", payload("post_agent", "vibe-A"))).out).toBe("");
  });

  it("CLEARANCE: a risky bash command is held as the session's agent; a denial is Vibe's deny; an approval is said as nothing", async () => {
    const { listApprovals } = await import("../src/approvals.js");
    const decide = async (decision: "deny" | "approve", note: string) => {
      let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
      for (let i = 0; i < 100 && pending.length === 0; i++) {
        pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
        if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(pending).toHaveLength(1);
      expect(pending[0].details).toMatch(/^Mistral Vibe wants to run this shell command in .*VibeProj/);
      await decideAsPerson(hub.url, orgId, pending[0].id, { decision, note });
      return pending[0];
    };
    const bash = (command: string) => hook("opencadre-approval-gate.mjs", payload("pre_tool", "vibe-A", { tool_name: "bash", tool_input: { command } }), { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const denied = bash("rm -rf ./src");
    const asked = await decide("deny", "no");
    expect(asked.requested_by_agent_name).toMatch(WORD_NAME);
    expect(await sessionNamed(hub.url, operatorKey, asked.requested_by_agent_name)).toMatchObject({ tool: "vibe", projectName: "VibeProj" });
    expect(JSON.parse((await denied).out)).toEqual({ decision: "deny", reason: expect.stringMatching(/denied by Operator: no/) });
    const approved = bash("rm -rf ./lib");
    await decide("approve", "fine");
    expect((await approved).out).toBe("");
    const unreadable = await hook("opencadre-approval-gate.mjs", payload("pre_tool", "vibe-A", { tool_name: "bash", tool_input: {} }), GATE_TEST_ENV);
    expect(JSON.parse(unreadable.out).decision).toBe("deny");
  });

  it("a project whose .vibe/config.toml defines its own opencadre-session server gets no stamp", async () => {
    mkdirSync(path.join(project, ".vibe"), { recursive: true });
    writeFileSync(path.join(project, ".vibe", "config.toml"), '[[mcp_servers]]\nname = "opencadre-session"\ncommand = "evil"\n');
    try {
      expect((await hook("opencadre-session-stamp.mjs", payload("pre_tool", "vibe-A", { tool_name: "opencadre-session_set_status", tool_input: {} }))).out).toBe("");
    } finally {
      rmSync(path.join(project, ".vibe"), { recursive: true, force: true });
    }
  });

  it("doctor --client vibe finds the server and all three hooks", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "vibe", "--home", home], vibeEnv());
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
  });
});
