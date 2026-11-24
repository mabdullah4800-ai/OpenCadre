// Gemini CLI: the capabilities of LAUNCH-CLIENT-GATE.md §1 that can be exercised without a signed-in Gemini CLI,
// driven the way it drives its hooks. Payload and answer shapes are read from @google/gemini-cli 0.61.0's bundle
// (docs/design/HARNESS-GEMINI.md):
//   base        { session_id, transcript_path, cwd, hook_event_name, timestamp }
//   BeforeTool  + tool_name ("mcp_opencadre-session__set_status", "run_shell_command"), tool_input, mcp_context
//   AfterAgent  + prompt, prompt_response, stop_hook_active; `{decision:"block", reason}` sends `reason` back
//   answers     a block is a TOP-LEVEL `decision`; `hookSpecificOutput.tool_input` REPLACES the arguments
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAMP_FIELD, stampActive, verifyStamp } from "../scripts/opencadre-config.mjs";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const geminiBase = (event: string, session: string, cwd: string) => ({
  session_id: session, transcript_path: "", cwd, hook_event_name: event, timestamp: new Date().toISOString(),
});

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

describe("Gemini CLI, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let credential: string;
  let bin: string;
  const project = gitProject("GemProj");
  const proxies: ProxyProcess[] = [];

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Gemini Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:gemproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-gemini-e2e-");
    // A user's own settings and MCP server, which connect must keep.
    mkdirSync(path.join(home, ".gemini"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "Dracula", mcpServers: { github: { command: "gh-mcp" } } }));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "gemini"], childEnv(home));
    expect(connected.code, connected.err).toBe(0);
    credential = computerCredential(home);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  const proxy = async () => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "gemini");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    return p;
  };
  /** What Gemini's scheduler does with a BeforeTool answer: the hook's tool_input REPLACES the arguments. */
  const asGeminiWould = async (session: string, tool: string, args: Record<string, unknown>, server = "opencadre-session") => {
    const r = await runHook(path.join(bin, "opencadre-session-stamp.mjs"), ["--client", "gemini"], {
      ...geminiBase("BeforeTool", session, project), tool_name: `mcp_${server}_${tool}`, tool_input: args,
      mcp_context: { server_name: server, tool_name: tool, command: "node", args: server === "opencadre-session" ? [path.join(bin, "opencadre-mcp.mjs"), "--client", "gemini"] : ["gh-mcp"] },
    }, childEnv(home));
    expect(r.code).toBe(0);
    return r.out ? JSON.parse(r.out).hookSpecificOutput.tool_input : args;
  };

  it("connect wrote the server and the hooks into ~/.gemini/settings.json, keeping the user's own", () => {
    const settings = JSON.parse(readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"));
    expect(settings.theme).toBe("Dracula");
    expect(settings.mcpServers.github).toEqual({ command: "gh-mcp" });
    expect(settings.mcpServers["opencadre-session"]).toEqual({ command: "node", args: [path.join(bin, "opencadre-mcp.mjs"), "--client", "gemini"] });
    const before = settings.hooks.BeforeTool as Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }>;
    expect(before.find((g) => g.matcher === "run_shell_command")!.hooks[0]).toMatchObject({ command: `node "${path.join(bin, "opencadre-approval-gate.mjs")}" --client gemini`, timeout: 600_000 });
    const stampGroup = before.find((g) => g.hooks.some((h) => h.command.includes("opencadre-session-stamp.mjs")))!;
    // The name Gemini gives our tool (generateValidName: one `_`, hyphen kept) is matched; another server's is not.
    expect(new RegExp(stampGroup.matcher).test("mcp_opencadre-session_set_status")).toBe(true);
    expect(new RegExp(stampGroup.matcher).test("mcp_github_set_status")).toBe(false);
    // The gate stays on the shell tool only.
    expect(new RegExp(before.find((g) => g.hooks.some((h) => h.command.includes("opencadre-approval-gate.mjs")))!.matcher).test("mcp_opencadre-session_set_status")).toBe(false);
    for (const event of ["SessionStart", "BeforeAgent", "AfterTool", "AfterAgent"]) expect(JSON.stringify(settings.hooks[event])).toContain("opencadre-awareness.mjs");
    expect(stampActive({ client: "gemini", home })).toBe(true);
  });

  it("starting Gemini mints NO agent, and an unstamped call is refused rather than pooled", async () => {
    const p = await proxy();
    const names = ((await p.request("tools/list", {})).result.tools as Array<{ name: string }>).map((t) => t.name);
    // Gemini names the server itself (mcp_context), so the hub's names travel unprefixed.
    expect(names).toContain("set_status");
    const res = await p.request("tools/call", { name: "set_status", arguments: { task: "no stamp" } });
    expect(res.error?.message).toMatch(/no identity stamp/);
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toEqual([]);
  });

  it("the stamp returns EVERY argument plus the stamp (Gemini replaces them), and only for OpenCadre's own server", async () => {
    const args = { task: "reviewing", files: ["a.ts"] };
    const stamped = await asGeminiWould("gem-A", "set_status", args);
    const { [STAMP_FIELD]: stamp, ...rest } = stamped;
    expect(rest).toEqual(args);
    expect(verifyStamp(credential, stamp)).toEqual({ ok: true, sessionId: "gem-A" });
    // Another server's tool of the same name is not ours.
    expect(await asGeminiWould("gem-A", "set_status", args, "github")).toEqual(args);
    // Nor is a server that merely borrows our NAME but runs something else (a project's own settings, say).
    const r = await runHook(path.join(bin, "opencadre-session-stamp.mjs"), ["--client", "gemini"], {
      ...geminiBase("BeforeTool", "gem-A", project), tool_name: "mcp_opencadre-session_set_status", tool_input: args,
      mcp_context: { server_name: "opencadre-session", tool_name: "set_status", url: "https://evil.example/mcp" },
    }, childEnv(home));
    expect(r.out).toBe("");
  });

  it("two Gemini sessions are two agents, each call landing on its own", async () => {
    const p = await proxy();
    await p.callTool("set_status", await asGeminiWould("gem-A", "set_status", { task: "session A at work" }));
    await p.callTool("set_status", await asGeminiWould("gem-B", "set_status", { task: "session B at work" }));
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null; currentTask?: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tool)).toEqual(["gemini", "gemini"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "gemini", projectName: "GemProj" });
    expect(rows.map((r) => r.currentTask).sort()).toEqual(["session A at work", "session B at work"]);
  });

  it("SessionStart names the same agent the calls act as, and tells the session the truth about waking", async () => {
    const r = await runHook(path.join(bin, "opencadre-awareness.mjs"), ["--client", "gemini"], { ...geminiBase("SessionStart", "gem-A", project), source: "startup" }, childEnv(home));
    const context = JSON.parse(r.out).hookSpecificOutput.additionalContext as string;
    const name = /You are ([A-Z][a-z]+(?: [A-Z][a-z]+| \d+)?) in the OpenCadre fleet/.exec(context)?.[1];
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; currentTask?: string }>;
    expect(rows.find((row) => row.agentName === name)?.currentTask).toBe("session A at work");
    expect(context).toMatch(/Gemini CLI cannot wake an idle session/);
  });

  it("MAIL: unread mail at AfterAgent blocks the stop with the notice; a continued stop is let go", async () => {
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; currentTask?: string }>;
    const a = rows.find((r) => r.currentTask === "session A at work")!.agentName;
    const sent = await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: a, body: "gemini, please look", priority: "high" }),
    });
    expect(sent.status).toBe(201);
    const after = (session: string, active = false) => runHook(path.join(bin, "opencadre-awareness.mjs"), ["--client", "gemini"],
      { ...geminiBase("AfterAgent", session, project), prompt: "x", prompt_response: "y", stop_hook_active: active }, childEnv(home));
    const onA = JSON.parse((await after("gem-A")).out);
    expect(onA.decision).toBe("block");
    expect(onA.reason).toMatch(/gemini, please look/);
    expect((await after("gem-B")).out).toBe("");
    expect((await after("gem-A", true)).out).toBe("");
  });

  it("CLEARANCE: run_shell_command is held, asked for as session A, and a denial is a top-level decision", async () => {
    const gate = runHook(path.join(bin, "opencadre-approval-gate.mjs"), ["--client", "gemini"],
      { ...geminiBase("BeforeTool", "gem-A", project), tool_name: "run_shell_command", tool_input: { command: "rm -rf ./src", description: "clean" } },
      { ...childEnv(home), ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].details).toMatch(/^Gemini CLI wants to run this shell command/);
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; currentTask?: string }>;
    expect(pending[0].requested_by_agent_name).toBe(rows.find((r) => r.currentTask === "session A at work")!.agentName);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    const out = JSON.parse((await gate).out);
    expect(out).toEqual({ decision: "deny", reason: expect.stringMatching(/denied by Operator: no/) });
    // A harmless command: nothing at all (Gemini turns plain text into a system message).
    const quiet = await runHook(path.join(bin, "opencadre-approval-gate.mjs"), ["--client", "gemini"],
      { ...geminiBase("BeforeTool", "gem-A", project), tool_name: "run_shell_command", tool_input: { command: "git status" } }, childEnv(home));
    expect(quiet.out).toBe("");
  });

  it("doctor --client gemini finds the server and the hooks", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "gemini", "--home", home], childEnv(home));
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
  });
});

describe("the Gemini installer never moves a group's matcher", () => {
  it("takes our handler OUT of a shared or user group, into a group of its own, and drops a migrated Claude watcher", async () => {
    const { planSessionHooks } = await import("../cli/lib/session-hooks.mjs");
    const home = tempDir("oc-gemini-plan-");
    mkdirSync(path.join(home, ".gemini"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ hooks: {
      // Both of ours in one group (the shape a hand edit or an old writer can leave), and a user's own handler in it.
      BeforeTool: [{ matcher: "run_shell_command|mcp_opencadre-session_.*", hooks: [
        { type: "command", command: 'node "/b/opencadre-approval-gate.mjs" --client gemini' },
        { type: "command", command: 'node "/b/opencadre-session-stamp.mjs" --client gemini' },
        { type: "command", command: "my-audit.sh" },
      ] }],
      // What `gemini hooks migrate` copies from Claude Code: an asyncRewake watcher Gemini would run in the foreground.
      AfterAgent: [{ hooks: [{ type: "command", command: 'node "/b/opencadre-wake.mjs" --rewake --client claude-code', timeout: 604800 }] }],
    } }));
    const plan = planSessionHooks({ home, client: "gemini", awarenessPath: "/b/opencadre-awareness.mjs", gatePath: "/b/opencadre-approval-gate.mjs", stampPath: "/b/opencadre-session-stamp.mjs" });
    const hooks = JSON.parse(plan.after).hooks;
    const groups = hooks.BeforeTool as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    // The user's group keeps ITS matcher and ITS handler, and none of ours.
    expect(groups.find((g) => g.hooks.some((h) => h.command === "my-audit.sh"))).toEqual({ matcher: "run_shell_command|mcp_opencadre-session_.*", hooks: [{ type: "command", command: "my-audit.sh" }] });
    // Ours sit in groups of their own, each on the matcher it needs, once.
    const gate = groups.filter((g) => g.hooks.some((h) => h.command.includes("opencadre-approval-gate.mjs")));
    const stamp = groups.filter((g) => g.hooks.some((h) => h.command.includes("opencadre-session-stamp.mjs")));
    expect(gate.map((g) => g.matcher)).toEqual(["run_shell_command"]);
    expect(stamp.map((g) => g.matcher)).toEqual(["mcp_opencadre-session_.*"]);
    expect(JSON.stringify(hooks.AfterAgent)).not.toContain("opencadre-wake.mjs");
    // Running it again changes nothing.
    writeFileSync(path.join(home, ".gemini", "settings.json"), plan.after);
    expect(planSessionHooks({ home, client: "gemini", awarenessPath: "/b/opencadre-awareness.mjs", gatePath: "/b/opencadre-approval-gate.mjs", stampPath: "/b/opencadre-session-stamp.mjs" }).after).toBe(plan.after);
  });
});
