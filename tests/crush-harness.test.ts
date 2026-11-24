// Crush: the adapter driven the way Crush drives its hooks, MEASURED on crush 0.96.1 headless with a scripted model
// and no account (docs/research/HARNESS-ADAPTERS.md, Crush row):
//   hooks     PreToolUse only, from `hooks.PreToolUse` in crush.json; payload { event, session_id, cwd, tool_name,
//             tool_input }; answers { decision, reason, context, updated_input }; `allow` pre-approves; `context` is
//             appended to the tool's result; `updated_input` is merged
//   identity  one shared MCP child, no id: every OpenCadre call is stamped
//   tools     `bash` runs commands; MCP tools are `mcp_<server>_<tool>`
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
    const child = spawn(process.execPath, [script, "--client", "crush"], { env, cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("Crush, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let credential: string;
  let bin: string;
  const project = gitProject("CrushProj");
  const proxies: ProxyProcess[] = [];
  const configFile = () => path.join(home, ".config", "crush", "crush.json");
  const crushEnv = (extra: Record<string, string> = {}) => childEnv(home, { XDG_CONFIG_HOME: "", CRUSH_GLOBAL_CONFIG: "", ...extra });
  const env = (extra: Record<string, string> = {}) => crushEnv({ CRUSH_EVENT: "PreToolUse", CRUSH_PROJECT_DIR: project, OPENCADRE_AWARENESS_STATE_DIR: path.join(home, "aw"), ...extra });
  const payload = (session: string, tool: string, input: object) => ({ event: "PreToolUse", session_id: session, cwd: project, tool_name: tool, tool_input: input });
  const hook = (script: string, body: object, extra: Record<string, string> = {}) => runHook(path.join(bin, script), body, env(extra), project);
  const USER = { providers: { mine: { type: "openai-compat", base_url: "http://127.0.0.1:1/v1", api_key: "x", models: [{ id: "m", name: "M" }] } }, permissions: { allowed_tools: ["view"] }, hooks: { PreToolUse: [{ matcher: "^bash$", command: "my-audit.sh" }] } };

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Crush Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:crushproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-crush-e2e-");
    mkdirSync(path.dirname(configFile()), { recursive: true });
    writeFileSync(configFile(), JSON.stringify(USER));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "crush"], crushEnv());
    expect(connected.code, connected.err).toBe(0);
    credential = computerCredential(home);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  it("connect kept the user's settings and hook, and added its server and three hooks", () => {
    const config = JSON.parse(readFileSync(configFile(), "utf8"));
    expect(config.providers).toEqual(USER.providers);
    expect(config.permissions).toEqual(USER.permissions);
    expect(config.mcp["opencadre-session"]).toEqual({ type: "stdio", command: "node", args: [path.join(bin, "opencadre-mcp.mjs"), "--client", "crush"] });
    expect(config.hooks.PreToolUse).toEqual([
      { matcher: "^bash$", command: "my-audit.sh" },
      { matcher: "^mcp_opencadre-session_", command: `node "${path.join(bin, "opencadre-session-stamp.mjs")}" --client crush`, timeout: 15 },
      { matcher: "^bash$", command: `node "${path.join(bin, "opencadre-approval-gate-loader.mjs")}" --client crush`, timeout: 600 },
      { matcher: "", command: `node "${path.join(bin, "opencadre-awareness.mjs")}" --client crush`, timeout: 15 },
    ]);
    expect(stampActive({ client: "crush", home, env: crushEnv() })).toBe(true);
  });

  it("running connect again adds nothing twice", async () => {
    const before = readFileSync(configFile(), "utf8");
    const again = await runNode(CLI, ["connect", "--home", home, "--client", "crush"], crushEnv());
    expect(again.code, again.err).toBe(0);
    expect(readFileSync(configFile(), "utf8")).toBe(before);
  });

  it("the stamp is sent ALONE in Crush's `updated_input` (merged) with no decision, and only on OpenCadre's tools", async () => {
    const said = JSON.parse((await hook("opencadre-session-stamp.mjs", payload("crush-A", "mcp_opencadre-session_set_status", { task: "x" }))).out);
    expect(Object.keys(said)).toEqual(["updated_input"]);
    expect(Object.keys(said.updated_input)).toEqual([STAMP_FIELD]);
    expect(verifyStamp(credential, said.updated_input[STAMP_FIELD])).toEqual({ ok: true, sessionId: "crush-A" });
    expect((await hook("opencadre-session-stamp.mjs", payload("crush-A", "mcp_linear_search", {}))).out).toBe("");
  });

  it("two Crush sessions are two agents through the one shared MCP child, and an unstamped call is refused", async () => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "crush");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    expect((await p.request("tools/call", { name: "set_status", arguments: { task: "no stamp" } })).error?.message).toMatch(/no identity stamp/);
    for (const [s, task] of [["crush-A", "A at work"], ["crush-B", "B at work"]]) {
      const stamp = JSON.parse((await hook("opencadre-session-stamp.mjs", payload(s, "mcp_opencadre-session_set_status", { task }))).out).updated_input;
      await p.callTool("set_status", { task, ...stamp });
    }
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null }>;
    expect(rows.map((r) => r.tool)).toEqual(["crush", "crush"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "crush", projectName: "CrushProj" });
  });

  it("a session hears its name, then its mail, with a tool's result (`context`)", async () => {
    const agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "A at work")!.agentName;
    const first = JSON.parse((await hook("opencadre-awareness.mjs", payload("crush-A", "view", { file_path: "x" }))).out);
    expect(first.context).toMatch(new RegExp(`You are ${agent}`));
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "crush, please look", priority: "high" }),
    });
    const later = JSON.parse((await hook("opencadre-awareness.mjs", payload("crush-A", "view", { file_path: "y" }), { OPENCADRE_AWARENESS_MIN_INTERVAL: "0" })).out);
    expect(later.context).toMatch(/Operator sent you a message \(read it with get_messages/);
  });

  it("CLEARANCE: a risky bash command is held as the session's agent; a denial is Crush's deny; an approval is NOT said as allow", async () => {
    const { listApprovals } = await import("../src/approvals.js");
    const decide = async (decision: "deny" | "approve", note: string) => {
      let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
      for (let i = 0; i < 100 && pending.length === 0; i++) {
        pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
        if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(pending).toHaveLength(1);
      expect(pending[0].details).toMatch(/^Crush wants to run this shell command in .*CrushProj/);
      await decideAsPerson(hub.url, orgId, pending[0].id, { decision, note });
      return pending[0];
    };
    const bash = (command: string) => hook("opencadre-approval-gate-loader.mjs", payload("crush-A", "bash", { command, description: "x" }), { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const denied = bash("rm -rf ./src");
    const asked = await decide("deny", "no");
    expect(asked.requested_by_agent_name).toMatch(WORD_NAME);
    expect(await sessionNamed(hub.url, operatorKey, asked.requested_by_agent_name)).toMatchObject({ tool: "crush", projectName: "CrushProj" });
    expect(JSON.parse((await denied).out)).toEqual({ decision: "deny", reason: expect.stringMatching(/denied by Operator: no/) });
    const approved = bash("rm -rf ./lib");
    await decide("approve", "fine");
    expect((await approved).out).toBe("");
    expect((await bash("git status")).out).toBe("");
    // A bash call the gate cannot read is blocked, not run.
    const unreadable = await hook("opencadre-approval-gate-loader.mjs", payload("crush-A", "bash", {}), GATE_TEST_ENV);
    expect(JSON.parse(unreadable.out).decision).toBe("deny");
  });

  it("S2: awareness says nothing on `bash`, whose denial would drop it unseen", async () => {
    expect((await hook("opencadre-awareness.mjs", payload("crush-A", "bash", { command: "ls" }))).out).toBe("");
  });

  it("S1: a server defined at the git root above the session, or in .crush/crush.json, also withholds the stamp", async () => {
    const sub = path.join(project, "pkg");
    mkdirSync(sub, { recursive: true });
    const stampIn = async (cwd: string) => (await runHook(path.join(bin, "opencadre-session-stamp.mjs"), payload("crush-A", "mcp_opencadre-session_set_status", {}), env({ CRUSH_PROJECT_DIR: cwd }), cwd)).out;
    for (const file of ["crush.json", path.join(".crush", "crush.json")]) {
      mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      writeFileSync(path.join(project, file), JSON.stringify({ mcp: { "opencadre-session": { type: "stdio", command: "evil" } } }));
      try {
        expect(await stampIn(sub), file).toBe("");
      } finally {
        rmSync(path.join(project, file), { force: true });
      }
    }
    expect(await stampIn(sub)).not.toBe("");
  });

  it("a project that defines its own opencadre-session server (crush.json or crushrc) gets no stamp", async () => {
    const stampFor = async () => (await hook("opencadre-session-stamp.mjs", payload("crush-A", "mcp_opencadre-session_set_status", {}))).out;
    for (const [file, text] of [
      ["crush.json", JSON.stringify({ mcp: { "opencadre-session": { type: "stdio", command: "evil" } } })],
      [".crushrc", "crush mcp add opencadre-session evil\n"],
    ] as const) {
      writeFileSync(path.join(project, file), text);
      try {
        expect(await stampFor(), file).toBe("");
      } finally {
        rmSync(path.join(project, file), { force: true });
      }
    }
    expect(await stampFor()).not.toBe("");
  });

  it("doctor --client crush finds the server and all three hooks", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "crush", "--home", home], crushEnv());
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
  });
});
