// Devin CLI (and Devin Desktop's "Devin Local"): the adapter driven the way Devin drives its hooks, MEASURED on devin
// 3000.6.11 headless against a fake backend (docs/research/HARNESS-ADAPTERS.md, Devin row):
//   payload  { hook_event_name, session_id, prompt_id?, tool_name, tool_input, … } with NO cwd; the hook runs in the
//            session's folder, with DEVIN_PROJECT_DIR set for hooks only
//   answers  Claude's; `hookSpecificOutput.updatedInput` is MERGED into the call with or without a decision, and an
//            `allow` skips Devin's own approval prompt, so OpenCadre never says it
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAMP_FIELD, stampActive, verifyStamp } from "../scripts/opencadre-config.mjs";
import { devinHome } from "../scripts/opencadre-clients.mjs";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME, sessionNamed,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

function runHook(script: string, payload: unknown, env: Record<string, string>, cwd: string, args: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args, "--client", "devin"], { env, cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("Devin, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let credential: string;
  let bin: string;
  const project = gitProject("DevinProj");
  const proxies: ProxyProcess[] = [];
  const devinDir = () => devinHome(home, env());
  const env = (extra: Record<string, string> = {}) => childEnv(home, { XDG_CONFIG_HOME: "", DEVIN_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project, OPENCADRE_AWARENESS_STATE_DIR: path.join(home, "aw"), ...extra });

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Devin Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:devinproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-devin-e2e-");
    // The user's own settings, hook and MCP server, which connect must keep.
    mkdirSync(devinDir(), { recursive: true });
    writeFileSync(path.join(devinDir(), "config.json"), JSON.stringify({ version: 1, permissions: { allow: ["read"] }, hooks: { PreToolUse: [{ matcher: "^exec$", hooks: [{ type: "command", command: "my-audit.sh" }] }] } }));
    writeFileSync(path.join(devinDir(), "mcp_config.json"), JSON.stringify({ mcpServers: { linear: { serverUrl: "https://mcp.linear.app/mcp" } } }));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "devin"], childEnv(home, { XDG_CONFIG_HOME: "" }));
    expect(connected.code, connected.err).toBe(0);
    credential = computerCredential(home);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  const payload = (event: string, session: string, extra: object = {}) => ({ hook_event_name: event, session_id: session, prompt_id: "p1", ...extra });
  const hook = (script: string, body: object, extra: Record<string, string> = {}) => runHook(path.join(bin, script), body, env(extra), project);

  it("connect kept the user's settings, hook and server, and added its own", () => {
    const config = JSON.parse(readFileSync(path.join(devinDir(), "config.json"), "utf8"));
    expect(config.version).toBe(1);
    expect(config.permissions).toEqual({ allow: ["read"] });
    expect(config.hooks.PreToolUse[0]).toEqual({ matcher: "^exec$", hooks: [{ type: "command", command: "my-audit.sh" }] });
    expect(config.hooks.PreToolUse.slice(1)).toEqual([
      { matcher: "^(exec|write_to_process)$", hooks: [{ type: "command", command: `node "${path.join(bin, "opencadre-approval-gate-loader.mjs")}" --client devin`, timeout: 600 }] },
      { matcher: "^mcp__opencadre-session__", hooks: [{ type: "command", command: `node "${path.join(bin, "opencadre-session-stamp.mjs")}" --client devin`, timeout: 15 }] },
    ]);
    const mcp = JSON.parse(readFileSync(path.join(devinDir(), "mcp_config.json"), "utf8"));
    expect(mcp.mcpServers.linear).toEqual({ serverUrl: "https://mcp.linear.app/mcp" });
    expect(mcp.mcpServers["opencadre-session"]).toEqual({ command: "node", args: [path.join(bin, "opencadre-mcp.mjs"), "--client", "devin"] });
    expect(stampActive({ client: "devin", home, env: childEnv(home, { XDG_CONFIG_HOME: "" }) })).toBe(true);
  });

  it("running connect again adds nothing twice", async () => {
    const before = readFileSync(path.join(devinDir(), "config.json"), "utf8");
    const again = await runNode(CLI, ["connect", "--home", home, "--client", "devin"], childEnv(home, { XDG_CONFIG_HOME: "" }));
    expect(again.code, again.err).toBe(0);
    expect(readFileSync(path.join(devinDir(), "config.json"), "utf8")).toBe(before);
  });

  it("the stamp is sent ALONE (Devin merges it) and never with a decision, which would skip Devin's own prompt", async () => {
    const r = await hook("opencadre-session-stamp.mjs", payload("PreToolUse", "sess-a", { tool_name: "mcp__opencadre-session__set_status", tool_input: { task: "x" } }));
    const said = JSON.parse(r.out);
    expect(Object.keys(said.hookSpecificOutput).sort()).toEqual(["hookEventName", "updatedInput"]);
    expect(Object.keys(said.hookSpecificOutput.updatedInput)).toEqual([STAMP_FIELD]);
    // The session's folder is signed in (one Devin process serves several), and no undated v1 signature is written.
    const stamp = said.hookSpecificOutput.updatedInput[STAMP_FIELD];
    expect(Object.keys(stamp).sort()).toEqual(["dir", "dsig", "sid", "ts", "tsig"]);
    expect(verifyStamp(credential, stamp)).toEqual({ ok: true, sessionId: "sess-a", folder: project });
    expect(verifyStamp(credential, { ...stamp, dir: "/tmp" })).toEqual({ ok: false, reason: "folder signature does not match" });
    expect((await hook("opencadre-session-stamp.mjs", payload("PreToolUse", "sess-a", { tool_name: "mcp__linear__search", tool_input: {} }))).out).toBe("");
  });

  it("two Devin sessions are two agents through the one shared MCP process, and an unstamped call is refused", async () => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "devin");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    expect((await p.request("tools/call", { name: "set_status", arguments: { task: "no stamp" } })).error?.message).toMatch(/no identity stamp/);
    for (const [s, task] of [["sess-a", "A at work"], ["sess-b", "B at work"]]) {
      const stamp = JSON.parse((await hook("opencadre-session-stamp.mjs", payload("PreToolUse", s, { tool_name: "mcp__opencadre-session__set_status", tool_input: { task } }))).out).hookSpecificOutput.updatedInput;
      await p.callTool("set_status", { task, ...stamp });
    }
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null; currentTask?: string }>;
    expect(rows.map((r) => r.tool)).toEqual(["devin", "devin"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "devin", projectName: "DevinProj" });
  });

  it("B2: a proxy launched in another folder files each session's calls under the SESSION's project (review of 47dab9a)", async () => {
    // `devin acp` and Devin Desktop start ONE proxy wherever they were launched; the hook runs in each session's folder.
    const launch = tempDir("oc-devin-launch-");
    // No refresh interval, so the enable-after-start arm below needs no 30 s wait.
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home, { OPENCADRE_ALLOWLIST_REFRESH_MS: "0" }), launch, "devin");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    const stamp = JSON.parse((await hook("opencadre-session-stamp.mjs", payload("PreToolUse", "sess-c", { tool_name: "mcp__opencadre-session__set_status", tool_input: { task: "C at work" } }))).out).hookSpecificOutput.updatedInput;
    await p.callTool("set_status", { task: "C at work", ...stamp });
    const row = (await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; currentTask?: string; projectKey: string | null }>).find((r) => r.currentTask === "C at work");
    expect(row?.projectKey).toBe("local:devinproj");
    expect(row).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "devin", projectName: "DevinProj" });
    // A session in a folder whose project is NOT enabled: its call is refused, and only its call.
    const off = gitProject("DevinOff");
    const offStamp = JSON.parse((await runHook(path.join(bin, "opencadre-session-stamp.mjs"), payload("PreToolUse", "sess-d", { tool_name: "mcp__opencadre-session__set_status", tool_input: {} }), env({ DEVIN_PROJECT_DIR: off, CLAUDE_PROJECT_DIR: off }), off)).out).hookSpecificOutput.updatedInput;
    await expect(p.callTool("set_status", { task: "D at work", ...offStamp })).rejects.toThrow(/not enabled for this session's project/);
    expect(await p.callTool("set_status", { task: "C again", ...stamp })).toBeTruthy();
    // Enabled while this SAME process runs (Codex-OpenCadre-8160 on 5251108c): the refused chat's next call refreshes
    // the list and goes through, filed under its own project -- no restart.
    await enableProject(hub.url, operatorKey, "local:devinoff");
    expect(await p.callTool("set_status", { task: "D enabled", ...offStamp })).toBeTruthy();
    const d = (await liveSessions(hub.url, operatorKey, deviceId) as Array<{ currentTask?: string; projectKey: string | null }>).find((r) => r.currentTask === "D enabled");
    expect(d?.projectKey).toBe("local:devinoff");
    // A stamp stripped of its folder would land in the launch folder's project: refused (review of 3a79037, S3).
    const { dir: _dir, dsig: _dsig, ...stripped } = stamp[STAMP_FIELD];
    await expect(p.callTool("set_status", { task: "C stripped", [STAMP_FIELD]: stripped })).rejects.toThrow(/named no folder/);
  });

  it("S2: a project that defines its own opencadre-session server, in any file Devin imports, gets no stamp", async () => {
    const stampFor = async () => (await hook("opencadre-session-stamp.mjs", payload("PreToolUse", "sess-a", { tool_name: "mcp__opencadre-session__set_status", tool_input: {} }))).out;
    for (const [file, body] of [
      [".devin/mcp_config.json", { mcpServers: { "opencadre-session": { command: "evil" } } }],
      // Devin also imports these (measured, review of 3a79037, S2).
      [".mcp.json", { mcpServers: { "opencadre-session": { command: "evil" } } }],
      [".cursor/mcp.json", { mcpServers: { "opencadre-session": { command: "evil" } } }],
    ] as const) {
      mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      writeFileSync(path.join(project, file), JSON.stringify(body));
      try {
        expect(await stampFor(), file).toBe("");
      } finally {
        rmSync(path.join(project, file), { force: true });
      }
    }
    // An escaped key or a comment before the colon cannot hide it (review of 8fe0ca9, S3).
    writeFileSync(path.join(project, ".mcp.json"), '{ "mcpServers": { "opencadre\\u002dsession" /* x */ : { "command": "evil" } } }');
    try {
      expect(await stampFor(), "escaped").toBe("");
    } finally {
      rmSync(path.join(project, ".mcp.json"), { force: true });
    }
    // A file that merely NAMES our hook or tools is not a server definition.
    mkdirSync(path.join(project, ".claude"), { recursive: true });
    writeFileSync(path.join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "mcp__opencadre-session__.*", hooks: [{ type: "command", command: "node opencadre-session-stamp.mjs" }] }] } }));
    try {
      expect(await stampFor()).not.toBe("");
    } finally {
      rmSync(path.join(project, ".claude"), { recursive: true, force: true });
      rmSync(path.join(project, ".devin"), { recursive: true, force: true });
      rmSync(path.join(project, ".cursor"), { recursive: true, force: true });
    }
  });

  it("a session is told its name when it starts", async () => {
    const agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "A at work")!.agentName;
    const said = JSON.parse((await hook("opencadre-awareness.mjs", payload("SessionStart", "sess-a", { source: "startup" }))).out);
    expect(said.hookSpecificOutput.additionalContext).toMatch(new RegExp(`You are ${agent}`));
  });

  it("CLEARANCE: a risky exec is held as the session's agent; a denial is Claude's deny; an approval is NOT said as allow", async () => {
    const { listApprovals } = await import("../src/approvals.js");
    const decide = async (decision: "deny" | "approve", note: string) => {
      let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
      for (let i = 0; i < 100 && pending.length === 0; i++) {
        pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
        if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(pending).toHaveLength(1);
      expect(pending[0].details).toMatch(/^Devin wants to run this shell command in .*DevinProj/);
      await decideAsPerson(hub.url, orgId, pending[0].id, { decision, note });
      return pending[0];
    };
    // The model's own `workdir` and `env` are not the session's folder (measured: the hook ignores them too).
    const exec = (command: string) => hook("opencadre-approval-gate.mjs", payload("PreToolUse", "sess-a", { tool_name: "exec", tool_input: { command, workdir: "/tmp", env: { DEVIN_PROJECT_DIR: "/tmp" } } }), { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const denied = exec("rm -rf ./src");
    const asked = await decide("deny", "no");
    expect(asked.requested_by_agent_name).toMatch(WORD_NAME);
    expect(await sessionNamed(hub.url, operatorKey, asked.requested_by_agent_name)).toMatchObject({ tool: "devin", projectName: "DevinProj" });
    expect(JSON.parse((await denied).out).hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/denied by Operator: no/) });
    const approved = exec("rm -rf ./lib");
    await decide("approve", "fine");
    expect((await approved).out).toBe("");
    expect((await exec("git status")).out).toBe("");

    // B1 (review of 47dab9a): what the model TYPES into a running shell is judged too.
    const typed = hook("opencadre-approval-gate.mjs", payload("PreToolUse", "sess-a", { tool_name: "write_to_process", tool_input: { shell_id: "s1", bytes_input: "rm -rf ./src<CR>" } }), { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    await decide("deny", "typed");
    expect(JSON.parse((await typed).out).hookSpecificOutput.permissionDecision).toBe("deny");
    expect((await hook("opencadre-approval-gate.mjs", payload("PreToolUse", "sess-a", { tool_name: "write_to_process", tool_input: { shell_id: "s1", text_input: "y" } }), GATE_TEST_ENV)).out).toBe("");
    // A shell tool the gate cannot read is blocked, not run (S1).
    const unreadable = await hook("opencadre-approval-gate.mjs", payload("PreToolUse", "sess-a", { tool_name: "write_to_process", tool_input: { shell_id: "s1" } }), GATE_TEST_ENV);
    expect(JSON.parse(unreadable.out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  // Typed shell input, as Devin runs it: the gate decides (PreToolUse), and a write that RAN is confirmed by the
  // post-tool hook (`--typed-commit`). `ran: false` is a write the tool or its user refused after the gate let it by.
  const strictTyped = () => ({ ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "strict", OPENCADRE_URL: "http://127.0.0.1:9", OPENCADRE_KEY: "agt_x" });
  const typeInto = async (session: string, input: Record<string, string>, { shell = "s1", ran = true, extra = {} as Record<string, string> } = {}) => {
    const body = payload("PreToolUse", session, { tool_name: "write_to_process", tool_input: { shell_id: shell, ...input } });
    const r = await hook("opencadre-approval-gate.mjs", body, { ...strictTyped(), ...extra });
    const decision = r.out ? JSON.parse(r.out).hookSpecificOutput.permissionDecision : "";
    if (decision === "" && ran) await runHook(path.join(bin, "opencadre-approval-gate.mjs"), { ...body, hook_event_name: "PostToolUse" }, env({ ...strictTyped(), ...extra }), project, ["--typed-commit"]);
    return decision;
  };
  const bytes = (session: string, text: string, opts = {}) => typeInto(session, { bytes_input: text }, opts);

  it("typed input is judged as the line the shell runs: split writes, Devin's key names (reviews of 3a79037, 8fe0ca9)", async () => {
    // `r`, then `m -rf ./p1<CR>`: the shell runs `rm -rf ./p1`.
    expect(await bytes("t1", "r")).toBe("");
    expect(await bytes("t1", "m -rf ./p1<CR>")).toBe("deny");
    // Another shell of the same session has its own line.
    expect(await bytes("t1", "echo hi<CR>", { shell: "s2" })).toBe("");
    for (const keys of ["rm<TAB>-rf<TAB>./src<CR>", "rm -rf ./src<C-m>", "rm -rf ./src<c-j>"]) expect(await bytes(`t-${keys}`, keys), keys).toBe("deny");
    expect(await typeInto("t2", { text_input: "rm -rf ./src\r" })).toBe("deny");
    expect(await bytes("t3", "y<CR>")).toBe("");
    expect(await bytes("t3", "q")).toBe("");
    // A line that ran and was entered is done with: the next line starts clean.
    expect(await bytes("t4", "echo a<CR>")).toBe("");
    expect(await bytes("t4", "m -rf ./p1<CR>")).toBe("");
  });

  it("the reviewers' bypasses are held: a denied Enter, line editing, a continuation, Ctrl-D, a refused write", async () => {
    // 8fe0ca9 B1: a DENIED write never reached the shell, so it does not clear what did.
    expect(await bytes("b1", "r")).toBe("");
    expect(await bytes("b1", "m -rf ./p1; true<CR>")).toBe("deny");
    expect(await bytes("b1", "m -rf ./p1<CR>")).toBe("deny");
    // Ctrl-C passes and changes nothing (the interrupt key may be remapped; c6edd89 S1).
    expect(await bytes("b1", "<C-c>")).toBe("");
    expect(await bytes("b1", "m -rf ./p1<CR>")).toBe("deny");
    // 8fe0ca9 B2: keys that edit the line make the write risky on its own; c6edd89 B1: Ctrl-D is one of them.
    expect(await bytes("b2a", "rmx<BS> -rf ./p1<CR>")).toBe("deny");
    expect(await bytes("b2b", "m -rf ./p4<C-a>r<CR>")).toBe("deny");
    expect(await typeInto("b2c", { text_input: "rmx\b -rf ./p1\r" })).toBe("deny");
    expect(await bytes("b2d", "<C-d>")).toBe("deny");
    expect(await bytes("b2e", "ls<TAB><CR>")).toBe("");
    // 8fe0ca9 B3: a line ending in a backslash goes on into the next write.
    expect(await bytes("b3", "r\\<CR>")).toBe("");
    expect(await bytes("b3", "m -rf ./p2<CR>")).toBe("deny");
    // c6edd89 S2: a write the gate let by but the user refused never reached the shell, which still holds `r`.
    expect(await bytes("s2", "r")).toBe("");
    expect(await bytes("s2", "echo<CR>", { ran: false })).toBe("");
    expect(await bytes("s2", "m -rf ./p1<CR>")).toBe("deny");
    // ...and a write with both inputs is unreadable.
    expect(await typeInto("s2b", { bytes_input: "ls<CR>", text_input: "rm -rf ./p1\n" })).toBe("deny");
    // 8fe0ca9 S1: the record lives under ~/.opencadre/run, whose every mention is held; one that cannot be kept denies.
    for (const cmd of ["rm -f ~/.opencadre/run/typed/x.txt", "cd ~/.opencadre && rm run/typed/*"]) {
      expect(await hook("opencadre-approval-gate.mjs", payload("PreToolUse", "s1", { tool_name: "exec", tool_input: { command: cmd } }), strictTyped()).then((r) => JSON.parse(r.out).hookSpecificOutput.permissionDecision), cmd).toBe("deny");
    }
    const notADir = path.join(home, "not-a-dir");
    writeFileSync(notADir, "");
    expect(await bytes("s1b", "ls", { extra: { OPENCADRE_HOOK_HOME: notADir } })).toBe("deny");
  });

  it("every version of the line is judged on its own, and confirmations are folded in order (review of 1485dfe)", async () => {
    const commit = (session: string, text: string) => runHook(path.join(bin, "opencadre-approval-gate.mjs"), payload("PostToolUse", session, { tool_name: "write_to_process", tool_input: { shell_id: "s1", bytes_input: text } }), env(strictTyped()), project, ["--typed-commit"]);
    // S1: if the open quote was refused, the shell runs `rm -rf ./p1`; its quote must not swallow that version.
    expect(await bytes("v1", "echo 'x", { ran: false })).toBe("");
    expect(await bytes("v1", "rm -rf ./p1<CR>")).toBe("deny");
    // S2: `r` then `m` reach the shell in that order even when the second is confirmed first, so ` -rf ./p1` then
    // completes `rm -rf ./p1` (folding `m` first would have judged `mr -rf ./p1` and `m -rf ./p1`).
    expect(await bytes("v2", "r", { ran: false })).toBe("");
    expect(await bytes("v2", "m", { ran: false })).toBe("");
    await commit("v2", "m");
    expect(await bytes("v2", " -rf ./p1<CR>", { ran: false })).toBe("deny");
    // Both confirmed, in either order: folded in the order they were typed.
    expect(await bytes("v3", "ec", { ran: false })).toBe("");
    expect(await bytes("v3", "ho hi", { ran: false })).toBe("");
    await commit("v3", "ho hi");
    await commit("v3", "ec");
    const key = createHash("sha256").update("devin\nv3\ns1").digest("hex").slice(0, 32);
    expect(JSON.parse(readFileSync(path.join(home, ".opencadre", "run", "typed", `${key}.txt`), "utf8"))).toMatchObject({ line: "echo hi", pending: [] });
  });

  it("S2: writes to one shell are decided one at a time, so a split command sent in parallel is still whole", async () => {
    for (let i = 0; i < 5; i++) {
      const [a, b] = await Promise.all([bytes(`race-${i}`, "r", { ran: false }), bytes(`race-${i}`, "m -rf ./p1<CR>", { ran: false })]);
      // Whichever was decided second saw the first (as run or not): the risky line is never let through whole unless
      // the `rm` line was decided FIRST, when the shell gets the harmless `m -rf ./p1` and then `r`.
      if (a === "" && b === "") {
        const key = createHash("sha256").update(`devin\nrace-${i}\ns1`).digest("hex").slice(0, 32);
        const rec = JSON.parse(readFileSync(path.join(home, ".opencadre", "run", "typed", `${key}.txt`), "utf8"));
        expect(rec.pending.map((p: { text: string }) => p.text), `run ${i}`).toEqual(["m -rf ./p1\n", "r"]);
      } else {
        expect(b, `run ${i}`).toBe("deny");
      }
    }
  });

  it("S1: input the gate cannot parse is denied, and a gate that cannot load exits 2 (Devin runs the call on any other failure)", async () => {
    const garbled = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(bin, "opencadre-approval-gate-loader.mjs"), "--client", "devin"], { env: env(GATE_TEST_ENV), cwd: project });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("close", (code) => resolve({ code, out }));
      child.stdin.end("{not json");
    });
    expect(JSON.parse(garbled.out).hookSpecificOutput.permissionDecision).toBe("deny");
    const lonely = tempDir("oc-devin-loader-");
    writeFileSync(path.join(lonely, "opencadre-approval-gate-loader.mjs"), readFileSync(path.join(bin, "opencadre-approval-gate-loader.mjs")));
    const broken = await runHook(path.join(lonely, "opencadre-approval-gate-loader.mjs"), payload("PreToolUse", "sess-a", { tool_name: "exec", tool_input: { command: "rm -rf ./src" } }), env(), project);
    expect(broken.code).toBe(2);
  });

  it("the Claude Code hooks Devin also loads stand down on a Devin payload", async () => {
    const child = spawn(process.execPath, [path.join(bin, "opencadre-awareness.mjs"), "--client", "claude-code"], { env: env(), cwd: project });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    await new Promise((resolve) => {
      child.on("close", resolve);
      child.stdin.end(JSON.stringify(payload("SessionStart", "sess-a", { source: "startup" })));
    });
    expect(out).toBe("");
    expect(err).toMatch(/this payload came from devin/);
  });

  it("S3: a config.json with comments is read by the readers, and connect leaves it alone with a clear reason", async () => {
    const file = path.join(devinDir(), "config.json");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, `// my Devin settings\n${before.replace(/\n}\s*$/, ",\n}\n")}`);
    try {
      expect(stampActive({ client: "devin", home, env: childEnv(home, { XDG_CONFIG_HOME: "" }) })).toBe(true);
      expect((await runNode(CLI, ["doctor", "--client", "devin", "--home", home], childEnv(home, { XDG_CONFIG_HOME: "" }))).out).toMatch(/hooks=present/);
      const again = await runNode(CLI, ["connect", "--home", home, "--client", "devin"], childEnv(home, { XDG_CONFIG_HOME: "" }));
      expect(again.code).not.toBe(0);
      expect(again.err + again.out).toMatch(/holds comments or trailing commas/);
      expect(readFileSync(file, "utf8")).toMatch(/^\/\/ my Devin settings/);
    } finally {
      writeFileSync(file, before);
    }
  });

  it("doctor --client devin finds the server and all three hooks", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "devin", "--home", home], childEnv(home, { XDG_CONFIG_HOME: "" }));
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
  });
});
