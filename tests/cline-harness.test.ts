// Cline's CLI: the adapter driven the way Cline drives its file hooks (npm `cline` 3.0.65, @cline/core 0.0.86; MEASURED,
// and run live in tests/cline-live.test.ts). A hook ~/.cline/hooks/<Event>.mjs gets
//   { hookName: "tool_call" | "tool_result", sessionContext: { rootSessionId }, workspaceRoots, tool_call: { id, name, input }, … }
// on stdin and answers { overrideInput } (replaces the input), { context } (added to the conversation) or `{}`.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAMP_FIELD, stampActive, verifyStamp } from "../scripts/opencadre-config.mjs";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

function runHook(file: string, payload: unknown, env: Record<string, string>, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { env, cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("Cline, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let credential: string;
  let bin: string;
  const project = gitProject("ClineProj");
  const proxies: ProxyProcess[] = [];
  const hooksDir = () => path.join(home, ".cline", "hooks");
  const mcpFile = () => path.join(home, ".cline", "data", "settings", "cline_mcp_settings.json");

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Cline Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:clineproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-cline-e2e-");
    // A user's own MCP server, which connect must keep.
    mkdirSync(path.dirname(mcpFile()), { recursive: true });
    writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { linear: { type: "streamableHttp", url: "https://mcp.linear.app/mcp" } } }));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "cline"], childEnv(home));
    expect(connected.code, connected.err).toBe(0);
    credential = computerCredential(home);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  const payload = (hookName: string, session: string, extra: object) => ({
    clineVersion: "", hookName, timestamp: new Date().toISOString(), taskId: `conv_${session}`, sessionContext: { rootSessionId: session },
    workspaceRoots: [project], workspaceInfo: { rootPath: project }, userId: "u", agent_id: "agent_1", parent_agent_id: null, ...extra,
  });
  const pre = (session: string, name: string, input: object, extra: Record<string, string> = {}) =>
    runHook(path.join(hooksDir(), "PreToolUse.mjs"), payload("tool_call", session, { iteration: 1, tool_call: { id: `call_${Math.random()}`, name, input } }), childEnv(home, extra), project);
  const post = (session: string, name: string) =>
    // Its own state folder: whether a session was already told its name is kept there, by session id.
    runHook(path.join(hooksDir(), "PostToolUse.mjs"), payload("tool_result", session, { iteration: 1, tool_result: { id: "c", name, input: {}, output: "ok" } }), childEnv(home, { OPENCADRE_AWARENESS_MIN_INTERVAL: "0", OPENCADRE_AWARENESS_STATE_DIR: path.join(home, "awareness-state") }), project);

  it("connect wrote the server beside the user's own and the two one-line hooks", () => {
    const config = JSON.parse(readFileSync(mcpFile(), "utf8"));
    expect(config.mcpServers.linear).toEqual({ type: "streamableHttp", url: "https://mcp.linear.app/mcp" });
    expect(config.mcpServers["opencadre-session"]).toEqual({ command: "node", args: [path.join(bin, "opencadre-mcp.mjs"), "--client", "cline"], timeout: 120 });
    for (const event of ["PreToolUse", "PostToolUse"]) {
      expect(readFileSync(path.join(hooksDir(), `${event}.mjs`), "utf8")).toContain(`import ${JSON.stringify(pathToFileURL(path.join(bin, "opencadre-cline-hook.mjs")).href)};`);
    }
    expect(stampActive({ client: "cline", home, env: childEnv(home) })).toBe(true);
  });

  it("stamps OpenCadre's own calls with the session, carrying every argument; other tools get no opinion", async () => {
    const args = { task: "reviewing", files: ["a.ts"] };
    const r = await pre("ses_A", "opencadre-session__set_status", args);
    const { [STAMP_FIELD]: stamp, ...rest } = JSON.parse(r.out).overrideInput;
    expect(rest).toEqual(args);
    expect(verifyStamp(credential, stamp)).toEqual({ ok: true, sessionId: "ses_A" });
    expect(JSON.parse((await pre("ses_A", "linear__set_status", args)).out)).toEqual({});
    expect(JSON.parse((await pre("ses_A", "read_files", { paths: ["a"] })).out)).toEqual({});
  });

  it("two sessions are two agents, and an unstamped call is refused", async () => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "cline");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    expect((await p.request("tools/call", { name: "set_status", arguments: { task: "no stamp" } })).error?.message).toMatch(/no identity stamp/);
    for (const [s, task] of [["ses_A", "A at work"], ["ses_B", "B at work"]]) {
      await p.callTool("set_status", JSON.parse((await pre(s, "opencadre-session__set_status", { task })).out).overrideInput);
    }
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null; currentTask?: string }>;
    expect(rows.map((r) => r.tool)).toEqual(["cline", "cline"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "cline", projectName: "ClineProj" });
    expect(rows.map((r) => r.currentTask).sort()).toEqual(["A at work", "B at work"]);
  });

  it("the session is told its name at its first tool result, once", async () => {
    const agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "A at work")!.agentName;
    const first = JSON.parse((await post("ses_A", "read_files")).out);
    expect(first.context).toMatch(new RegExp(`You are ${agent}`));
    expect(JSON.parse((await post("ses_A", "read_files")).out).context ?? "").not.toMatch(/You are /);
  });

  it("CLEARANCE: a risky command is held as the session's agent; a denial REPLACES the command with the reason, and says it", async () => {
    const run = pre("ses_A", "run_commands", { commands: ["ls", "rm -rf ./src"] }, { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].details).toMatch(/^Cline wants to run this shell command in .*ClineProj/);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    const said = JSON.parse((await run).out);
    expect(said.overrideInput).toEqual({ commands: [expect.stringMatching(/^echo "OpenCadre blocked this command, it was NOT run: .*denied by Operator: no/)] });
    expect(said.context).toMatch(/denied by Operator: no/);
    // A harmless one: no opinion.
    expect(JSON.parse((await pre("ses_A", "run_commands", { commands: ["git status"] }, { OPENCADRE_GATE_MODE: "ask" })).out)).toEqual({});
  });

  it("B1 (review of 2ff9038): every input shape Cline runs is read and held, and one it cannot read is blocked", async () => {
    const { clineCommandLine } = await import("../scripts/opencadre-hook-dialect.mjs");
    expect(clineCommandLine({ command: "rm -rf ./a" })).toBe("rm -rf ./a");
    expect(clineCommandLine({ commands: [{ command: "rm", args: ["-rf", "./b"] }] })).toBe("rm -rf ./b");
    expect(clineCommandLine({ cmd: "rm -rf ./c" })).toBe("rm -rf ./c");
    expect(clineCommandLine("rm -rf ./d")).toBe("rm -rf ./d");
    expect(clineCommandLine({ commands: "rm -rf ./e" })).toBe("rm -rf ./e");
    // Held in strict mode with no hub: each shape the gate used to pass.
    for (const input of [{ command: "rm -rf ./a" }, { commands: [{ command: "rm", args: ["-rf", "./b"] }] }, { cmd: "rm -rf ./c" }, { commands: [42] }]) {
      const said = JSON.parse((await pre("ses_A", "run_commands", input, { OPENCADRE_GATE_MODE: "strict", OPENCADRE_URL: "http://127.0.0.1:9", OPENCADRE_KEY: "agt_x" })).out);
      expect(said.overrideInput?.commands?.[0], JSON.stringify(input)).toMatch(/^echo "OpenCadre blocked this command, it was NOT run/);
    }
  });

  it("B2: where another PreToolUse hook could undo the rewrite, a deny STOPS the run instead", async () => {
    const other = path.join(project, ".clinerules", "hooks");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, "PreToolUse.mjs"), "// a repository's own hook\n");
    try {
      const said = JSON.parse((await pre("ses_A", "run_commands", { commands: ["rm -rf ./src"] }, { OPENCADRE_GATE_MODE: "strict", OPENCADRE_URL: "http://127.0.0.1:9", OPENCADRE_KEY: "agt_x" })).out);
      expect(said.cancel).toBe(true);
      expect(said.errorMessage).toMatch(/another PreToolUse hook could otherwise undo this/);
      expect(said.overrideInput).toBeUndefined();
      // A harmless command is still no opinion.
      expect(JSON.parse((await pre("ses_A", "run_commands", { commands: ["git status"] }, { OPENCADRE_GATE_MODE: "strict" })).out)).toEqual({});
    } finally {
      rmSync(path.join(project, ".clinerules"), { recursive: true, force: true });
    }
  });

  it("…and Cline's other spellings of that hook count too: any case, any extension (review of 7ffc12c, S1)", async () => {
    const other = path.join(project, ".clinerules", "hooks");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, "pretooluse.sh"), "#!/bin/sh\necho '{}'\n");
    try {
      const said = JSON.parse((await pre("ses_A", "run_commands", { commands: ["rm -rf ./src"] }, { OPENCADRE_GATE_MODE: "strict", OPENCADRE_URL: "http://127.0.0.1:9", OPENCADRE_KEY: "agt_x" })).out);
      expect(said.cancel).toBe(true);
      expect(said.overrideInput).toBeUndefined();
    } finally {
      rmSync(path.join(project, ".clinerules"), { recursive: true, force: true });
    }
  });

  it("S2: input the hook cannot read stops the run", async () => {
    const r = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [path.join(hooksDir(), "PreToolUse.mjs")], { env: childEnv(home), cwd: project });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("close", () => resolve(out));
      child.stdin.end("{not json");
    });
    expect(JSON.parse(r)).toEqual({ cancel: true, errorMessage: expect.stringMatching(/could not read this call/) });
  });

  it("a gate that cannot run BLOCKS the command (Cline would run it after a hook it had to kill)", async () => {
    const partial = tempDir("oc-cline-partial-");
    cpSync(bin, partial, { recursive: true });
    // The Cline hook runs from the active generation and starts the gate BESIDE it there (Q1g PR-2), so that is the copy
    // that must be missing.
    rmSync(path.join(partial, ".gen", readFileSync(path.join(partial, ".gen", "current"), "utf8").trim(), "opencadre-approval-gate.mjs"));
    const hookFile = path.join(partial, "PreToolUse.mjs");
    writeFileSync(hookFile, `import ${JSON.stringify(pathToFileURL(path.join(partial, "opencadre-cline-hook.mjs")).href)};\n`);
    const r = await runHook(hookFile, payload("tool_call", "ses_A", { tool_call: { id: "c", name: "run_commands", input: { commands: ["ls"] } } }), childEnv(home), project);
    expect(JSON.parse(r.out).overrideInput.commands[0]).toMatch(/could not decide this command, so it was blocked/);
  });

  it("doctor --client cline finds the server and both hooks", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "cline", "--home", home], childEnv(home));
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
  });
});

describe("connect for Cline never replaces a hook of the user's own", () => {
  it("refuses by name, before the code is spent", async () => {
    const home = tempDir("oc-cline-own-");
    mkdirSync(path.join(home, ".cline", "hooks"), { recursive: true });
    writeFileSync(path.join(home, ".cline", "hooks", "PreToolUse.mjs"), "// mine\n");
    const r = await runNode(CLI, ["connect", "--hub", "http://127.0.0.1:9", "--code", "ocd_ZZZZZZZZZZ", "--home", home, "--client", "cline"], childEnv(home));
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/PreToolUse\.mjs is a Cline hook of your own/);
    expect(readFileSync(path.join(home, ".cline", "hooks", "PreToolUse.mjs"), "utf8")).toBe("// mine\n");
  });
});
