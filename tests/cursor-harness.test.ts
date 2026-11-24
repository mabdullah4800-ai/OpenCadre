// Cursor: every capability of LAUNCH-CLIENT-GATE.md §1 that can be exercised without a signed-in Cursor, driven
// the way Cursor drives it: the payloads below are the shapes Cursor's own hook engine builds (cursor-agent
// 2026.09.23-86fc751, docs/design/HARNESS-CURSOR-LOCAL.md §11), and the answers are checked against the fields
// that engine reads.
//
//   Identity   two Cursor chats (two conversation_ids) are two agents; an unstamped call is refused, never pooled
//   Clearance  a risky command is held before it runs and answered in Cursor's `permission` field
//   Mail       unread mail at the end of a turn becomes a `followup_message`
//   Isolation  Claude Code's own hooks, which Cursor runs by default, stand down on a Cursor payload
//
// Every describe block has an arm that fails without the change; the comments name it.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectHeaders, resolveHub, resolveNamedAgent, STAMP_FIELD, stampActive, mintStamp, stampSignature, verifyStamp } from "../scripts/opencadre-config.mjs";
import {
  contextOutput, followupOutput, foreignHost, hookCommand, hookCwd, hookEvent, permissionOutput, silenceFor, updatedInputOutput,
} from "../scripts/opencadre-hook-dialect.mjs";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { planCursorProjectServer } from "../cli/lib/device.mjs";
import { planCursorProjectRule } from "../cli/lib/session-hooks.mjs";
import { cursorProjectEntryReady, runDoctor } from "../cli/lib/doctor.mjs";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const ROOT = process.cwd();
const REPO_GATE = path.join(ROOT, "examples", "hooks", "opencadre-approval-gate.mjs");
const REPO_AWARENESS = path.join(ROOT, "examples", "hooks", "opencadre-awareness.mjs");
const REPO_WAKE = path.join(ROOT, "scripts", "opencadre-wake.mjs");

/** The base every Cursor hook payload carries (its executor adds session_id, hook_event_name, cursor_version and
 * workspace_roots to the per-event fields). */
const cursorBase = (event: string, conversation: string, workspace: string) => ({
  conversation_id: conversation, generation_id: "gen-1", model: "claude", hook_event_name: event,
  session_id: conversation, cursor_version: "2026.09.23-86fc751", workspace_roots: [workspace], user_email: null, transcript_path: null,
});

function runHook(script: string, args: string[], payload: unknown, env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

describe("Cursor project native-tool setup", () => {
  it("pins the project before MCP discovery, preserves other servers, and installs an always-applied native-tool rule", () => {
    const projectRoot = tempDir("oc-cursor-project-");
    const configFile = path.join(projectRoot, ".cursor", "mcp.json");
    mkdirSync(path.dirname(configFile), { recursive: true });
    const proxyPath = path.join(projectRoot, "bin", "opencadre-mcp.mjs");
    writeFileSync(configFile, JSON.stringify({ mcpServers: { other: { command: "other" }, "opencadre-session": { command: "node", args: [proxyPath, "--client", "cursor"] } } }));
    const plan = planCursorProjectServer({ projectRoot, proxyPath });
    const config = JSON.parse(plan.after);
    expect(config.mcpServers.other).toEqual({ command: "other" });
    expect(config.mcpServers["opencadre-session"]).toBeUndefined();
    expect(config.mcpServers["opencadre-project"]).toEqual({ type: "stdio", command: "node", args: [proxyPath, "--client", "cursor", "--project", projectRoot] });
    writeFileSync(configFile, plan.after);
    expect(cursorProjectEntryReady(projectRoot)).toBe(true);
    const rule = planCursorProjectRule({ projectRoot });
    expect(rule.after).toContain("alwaysApply: true");
    expect(rule.after).toContain("CallMcpTool");
    expect(rule.after).toContain("CallDynamicTool");
    expect(rule.after).toContain("empty Agents window");
    expect(rule.after).toContain("Never start opencadre-mcp.mjs from Shell");
  });
});

describe("the hook dialect: one table, and Cursor's row", () => {
  it("maps Cursor's event names to the ones our hooks switch on, and nothing else", () => {
    const c = (e: string) => hookEvent("cursor", { hook_event_name: e });
    expect([c("sessionStart"), c("beforeSubmitPrompt"), c("postToolUse"), c("stop"), c("beforeShellExecution"), c("preToolUse")])
      .toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "PreToolUse", "PreToolUse"]);
    expect(c("afterAgentThought")).toBeNull();
    // CONTROL: Claude Code's names mean nothing to Cursor's row, and Cursor's mean nothing to Claude's.
    expect(c("Stop")).toBeNull();
    expect(hookEvent("claude-code", { hook_event_name: "stop" })).toBeNull();
    expect(hookEvent("claude-code", { hook_event_name: "Stop" })).toBe("Stop");
  });

  it("takes the folder from workspace_roots when there is no cwd (Cursor runs user hooks from ~/.cursor)", () => {
    expect(hookCwd({ workspace_roots: ["/w/repo"] }, "/home/u/.cursor")).toBe("/w/repo");
    expect(hookCwd({ cwd: "/c", workspace_roots: ["/w"] }, "/x")).toBe("/c");
    expect(hookCwd({}, "/x")).toBe("/x");
  });

  it.skipIf(process.platform !== "win32")("normalizes Cursor's /C:/ workspace root before reading project policy", () => {
    expect(hookCwd({ cwd: "", workspace_roots: ["/C:/Users/dev/Desktop/OpenCadre"] }, "C:\\Users\\dev\\.cursor"))
      .toBe("C:\\Users\\dev\\Desktop\\OpenCadre");
  });

  it.skipIf(process.platform !== "win32")("uses the same git project identity for Cursor's /C:/ root", () => {
    const project = gitProject("CursorRoot", "https://github.com/example/cursor-root.git");
    const root = project.replace(/^([A-Za-z]):/, "/$1:").replaceAll("\\", "/");
    expect(projectHeaders(hookCwd({ cwd: "", workspace_roots: [root] }, "C:\\Users\\dev\\.cursor")))
      .toEqual(projectHeaders(project));
  });

  it("finds the command at the top of a beforeShellExecution payload, and under tool_input elsewhere", () => {
    expect(hookCommand({ command: "rm -rf x", cwd: "/w" })).toBe("rm -rf x");
    expect(hookCommand({ tool_input: { command: "ls" } })).toBe("ls");
    expect(hookCommand({ tool_input: { command: ["bash", "-lc", "rm -rf x"] } })).toBe("bash -lc rm -rf x");
    // A tool_input WITHOUT a command is a tool that is not a shell: a top-level `command` must not be read then.
    expect(hookCommand({ tool_input: { path: "a" }, command: "rm -rf x" })).toBeUndefined();
  });

  it("answers in Cursor's flat fields", () => {
    expect(JSON.parse(permissionOutput("cursor", "deny", "held", {}))).toEqual({ permission: "deny", user_message: "held", agent_message: "held" });
    expect(JSON.parse(permissionOutput("cursor", "allow", "ok", { byPerson: true }))).toEqual({ permission: "allow", user_message: "ok", agent_message: "ok" });
    expect(JSON.parse(updatedInputOutput("cursor", { a: 1 }))).toEqual({ updated_input: { a: 1 } });
    expect(JSON.parse(contextOutput("cursor", "SessionStart", "hi"))).toEqual({ additional_context: "hi" });
    expect(JSON.parse(followupOutput("cursor", "mail"))).toEqual({ followup_message: "mail" });
    expect(silenceFor("cursor")).toBe("{}");
  });

  it("a policy 'allow' nobody decided is NO OPINION in Cursor, so Cursor's own approval still applies", () => {
    // Without byPerson the gate would switch off Cursor's approval for a command nobody approved.
    const out = JSON.parse(permissionOutput("cursor", "allow", "onTimeout allow"));
    expect(out.permission).toBeUndefined();
  });

  it("Claude Code and Codex keep exactly the shapes they had", () => {
    expect(JSON.parse(permissionOutput("claude-code", "deny", "r"))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "r" } });
    expect(JSON.parse(followupOutput("codex", "m"))).toEqual({ decision: "block", reason: "m" });
    expect(silenceFor("claude-code")).toBe("");
  });

  it("recognizes a Cursor payload arriving at a hook installed for another client", () => {
    const p = cursorBase("stop", "conv-1", "/w");
    expect(foreignHost("claude-code", p)).toBe("cursor");
    expect(foreignHost(["codex", "claude-code"], p)).toBe("cursor");
    expect(foreignHost("cursor", p)).toBeNull();
    expect(foreignHost("claude-code", { hook_event_name: "Stop", session_id: "s" })).toBeNull();
  });
});

describe("Claude Code's hooks inside Cursor (Cursor runs them by default, and honours their nested answers)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  // Cursor now fills session_id with the conversation id, so the old "no session_id means not ours" guard no longer
  // catches these payloads.
  const env = (home: string) => ({ ...childEnv(home), ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "strict" });
  const shell = (home: string) => ({ ...cursorBase("preToolUse", "conv-1", home), tool_name: "Shell", tool_input: { command: "rm -rf ./build", cwd: home } });

  it("on a machine where ONLY Claude Code is connected, the Claude Code gate still holds a Cursor chat's risky command", async () => {
    // Review of 7948fb9, finding B1: the first version stood down here unconditionally, and with no Cursor gate
    // installed that left the command unguarded. Cursor honours this nested deny as shipped.
    const home = tempDir("oc-cursor-claude-only-");
    const r = await runHook(REPO_GATE, ["--client", "claude-code"], shell(home), env(home));
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("where Cursor's OWN gate is installed, the Claude Code copy stands down (no double hold) and says Cursor's `{}`", async () => {
    const home = tempDir("oc-cursor-both-");
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(path.join(home, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: 'node "b/opencadre-approval-gate.mjs" --client cursor', timeout: 600 }] } }));
    const r = await runHook(REPO_GATE, ["--client", "claude-code"], shell(home), env(home));
    expect(r.code).toBe(0);
    expect(r.out).toBe("{}");
    // CONTROL: the same command from Claude Code itself is still denied there (strict, no hub).
    const own = await runHook(REPO_GATE, ["--client", "claude-code"], { hook_event_name: "PreToolUse", session_id: "cc-1", cwd: home, tool_name: "Bash", tool_input: { command: "rm -rf ./build" } }, env(home));
    expect(JSON.parse(own.out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("the Claude Code awareness hook does not act on a Cursor stop, and answers Cursor's `{}`", async () => {
    const home = tempDir("oc-cursor-foreign-");
    const r = await runHook(REPO_AWARENESS, ["--client", "claude-code"], cursorBase("stop", "conv-1", home), env(home));
    expect(r.code).toBe(0);
    expect(r.out).toBe("{}");
    expect(r.err).toMatch(/came from cursor/);
  });

  it("the Claude Code idle watcher exits at once instead of holding Cursor's stop", async () => {
    const home = tempDir("oc-cursor-foreign-");
    const started = Date.now();
    const r = await runHook(REPO_WAKE, ["--rewake", "--client", "claude-code"], cursorBase("stop", "conv-1", home),
      { ...env(home), OPENCADRE_URL: "http://127.0.0.1:9", OPENCADRE_KEY: "agt_test" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("{}");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("a named Cursor agent (an older `connect --code oc_`) is seen, never served beside", () => {
  it("resolves from the GLOBAL ~/.cursor/mcp.json, and never from a project's .cursor/mcp.json", () => {
    const home = tempDir("oc-cursor-named-");
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const project = tempDir("oc-cursor-named-proj-");
    mkdirSync(path.join(project, ".cursor"), { recursive: true });
    writeFileSync(path.join(project, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { opencadre: { url: "https://evil.example/mcp", headers: { Authorization: "Bearer agt_evil" } } } }));
    // A repository's file is not read: it could pick which hub the chat talks to.
    expect(resolveNamedAgent({ client: "cursor", home, cwd: project, env: {} }).key).toBeUndefined();
    writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { opencadre: { url: "https://hub.example/mcp", headers: { Authorization: "Bearer agt_named" } } } }));
    expect(resolveNamedAgent({ client: "cursor", home, cwd: project, env: {} })).toMatchObject({ base: "https://hub.example", key: "agt_named", source: "cursor" });
  });

  it("a Cursor hook that names no chat gets no identity (the proxy's app-start seat is never a hook's)", () => {
    const home = tempDir("oc-cursor-noid-");
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub: "http://127.0.0.1:9", credential: `dev_${"d".repeat(48)}`, deviceId: "d" } }));
    expect(resolveHub({ client: "cursor", home, env: {}, cwd: home })).toEqual({});
    expect(resolveHub({ client: "cursor", home, env: {}, cwd: home, sessionId: "conv-1" }).source).toBe("device");
  });
});

describe("Cursor PowerShell hook input", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it.skipIf(process.platform !== "win32")("holds a recursive delete using the project policy when Cursor sends a /C:/ workspace root", async () => {
    const home = tempDir("oc-cursor-path-gate-");
    const project = path.join(home, "project");
    mkdirSync(path.join(project, ".opencadre"), { recursive: true });
    writeFileSync(path.join(project, ".opencadre", "approval-gate.json"), JSON.stringify({ mode: "ask" }));
    const cursorRoot = project.replace(/^([A-Za-z]):/, "/$1:").replaceAll("\\", "/");
    const payload = { ...cursorBase("beforeShellExecution", "conv-path", cursorRoot),
      command: "Remove-Item -Recurse -Force C:\\oc-clearance-test-does-not-exist", cwd: "" };
    const r = await runHook(REPO_GATE, ["--client", "cursor"], payload, { ...childEnv(home), ...GATE_TEST_ENV });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).permission).toBe("deny");
  });

  it.skipIf(process.platform !== "win32")("blocks risky shell commands when Cursor drops a UNC server from workspace_roots", async () => {
    const home = tempDir("oc-cursor-unc-gate-");
    // Cursor 3.22.7 sent this exact root after opening \\localhost\C$\Users\... in the editor.
    const root = "/C$/Users/dev/Desktop/OpenCadre";
    const base = { ...cursorBase("beforeShellExecution", "conv-unc", root), cwd: "" };
    const risky = await runHook(REPO_GATE, ["--client", "cursor"],
      { ...base, command: "Remove-Item -Recurse -Force C:\\oc-clearance-test-does-not-exist" },
      childEnv(home, { OPENCADRE_URL: "http://127.0.0.1:9", OPENCADRE_KEY: "test" }));
    expect(risky.code).toBe(0);
    expect(JSON.parse(risky.out).permission).toBe("deny");
    expect(JSON.parse(risky.out).user_message).toMatch(/network share.*mapped drive/i);

    const withoutOpenCadre = await runHook(REPO_GATE, ["--client", "cursor"],
      { ...base, command: "Remove-Item -Recurse -Force C:\\oc-clearance-test-does-not-exist" }, childEnv(home));
    expect(withoutOpenCadre.code).toBe(0);
    expect(withoutOpenCadre.out).toBe("{}");

    const harmless = await runHook(REPO_GATE, ["--client", "cursor"],
      { ...base, command: "Get-Location" }, childEnv(home));
    expect(harmless.code).toBe(0);
    expect(harmless.out).toBe("{}");
  });

  it("denies a risky command even when stdin begins with a UTF-8 BOM", async () => {
    const home = tempDir("oc-cursor-bom-gate-");
    const payload = { ...cursorBase("beforeShellExecution", "conv-bom", home), command: "rm -rf ./src", cwd: home };
    for (const prefix of ["", "\uFEFF"]) {
      const r = await runHook(REPO_GATE, ["--client", "cursor"], prefix + JSON.stringify(payload),
        { ...childEnv(home), ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "strict" });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).permission, `BOM=${Boolean(prefix)}`).toBe("deny");
    }
  });

  it("blocks shell execution when Cursor sends malformed hook input", async () => {
    const home = tempDir("oc-cursor-malformed-gate-");
    for (const raw of ["{not json", "\uFEFF{not json"]) {
      const r = await runHook(REPO_GATE, ["--client", "cursor"], raw,
        { ...childEnv(home), ...GATE_TEST_ENV });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).permission, `BOM=${raw.startsWith("\uFEFF")}`).toBe("deny");
    }
  });
});

describe("Cursor, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let credential: string;
  let bin: string;
  const project = gitProject("CursorProj", "https://github.com/example/cursor-proj.git");
  const proxies: ProxyProcess[] = [];

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Cursor Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "github.com/example/cursor-proj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-cursor-e2e-");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "cursor"], childEnv(home));
    expect(connected.code, connected.err).toBe(0);
    credential = computerCredential(home);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  const proxy = async () => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "cursor");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    return p;
  };
  /** What Cursor does with a preToolUse answer: MERGE `updated_input`'s keys into the call's arguments. `tool` is the
   * name Cursor calls, i.e. the prefixed one the proxy listed. */
  const asCursorWould = async (conversation: string, tool: string, args: Record<string, unknown>) => {
    const r = await runHook(path.join(bin, "opencadre-session-stamp.mjs"), ["--client", "cursor"],
      { ...cursorBase("preToolUse", conversation, project), tool_name: `MCP:${tool}`, tool_input: args, tool_use_id: "t1" }, childEnv(home));
    expect(r.code).toBe(0);
    return { ...args, ...(JSON.parse(r.out).updated_input ?? {}) };
  };

  it("connect wrote the stamp into ~/.cursor/hooks.json, which is what makes a Cursor chat's hooks use its own seat", () => {
    expect(stampActive({ client: "cursor", home })).toBe(true);
    // CONTROL: no other client reads Cursor's file.
    expect(stampActive({ client: "claude-code", home })).toBe(false);
  });

  it("stamps Cursor MCP calls when PowerShell prefixes stdin with a UTF-8 BOM", async () => {
    const payload = { ...cursorBase("preToolUse", "conv-bom", project), tool_name: "MCP:opencadre_get_active_agents", tool_input: {} };
    for (const prefix of ["", "\uFEFF"]) {
      const r = await runHook(path.join(bin, "opencadre-session-stamp.mjs"), ["--client", "cursor"],
        prefix + JSON.stringify(payload), childEnv(home));
      expect(r.code).toBe(0);
      const stamp = JSON.parse(r.out).updated_input?.[STAMP_FIELD];
      expect(verifyStamp(credential, stamp), `BOM=${Boolean(prefix)}`).toEqual({ ok: true, sessionId: "conv-bom" });
    }
  });

  it("stays silent when the project's own .cursor/mcp.json runs an OpenCadre proxy installed elsewhere", async () => {
    // Cursor lets the USER hook's answer override a project hook's (cursor.com/docs/hooks: a lower-priority source
    // overrides a higher-priority one). So a machine-wide stamp would win over the project's own and be rejected by a
    // project proxy that holds another credential. Only the hook beside that proxy may sign.
    const root = gitProject("CursorPrec", "https://github.com/example/cursor-prec.git");
    mkdirSync(path.join(root, ".cursor"), { recursive: true });
    const mcpFile = path.join(root, ".cursor", "mcp.json");
    const call = async () => {
      const r = await runHook(path.join(bin, "opencadre-session-stamp.mjs"), ["--client", "cursor"],
        { ...cursorBase("preToolUse", "conv-prec", root), tool_name: "MCP:opencadre_get_active_agents", tool_input: {} }, childEnv(home));
      expect(r.code).toBe(0);
      return r.out.trim() ? JSON.parse(r.out).updated_input?.[STAMP_FIELD] : undefined;
    };
    const server = (proxy: string) => ({ command: "node", args: [proxy, "--client", "cursor", "--project", root] });
    // Native paths: on Windows these are backslash paths, the form connect writes there.
    const elsewhere = path.join(root, "other-home", ".opencadre", "bin", "opencadre-mcp.mjs");
    const beside = path.join(bin, "opencadre-mcp.mjs");

    // Another install's proxy: silent. Named anything, even not "opencadre-*", once its args run our proxy.
    for (const name of ["opencadre-project", "work-fleet"]) {
      writeFileSync(mcpFile, JSON.stringify({ mcpServers: { [name]: server(elsewhere) } }));
      expect(await call(), name).toBeUndefined();
    }
    // An OpenCadre entry we cannot read a proxy from (a URL server) or an unreadable file: silent, never a guess.
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "opencadre-project": { url: "https://example.invalid/mcp" } } }));
    expect(await call()).toBeUndefined();
    writeFileSync(mcpFile, "{ not json");
    expect(await call()).toBeUndefined();

    // KNOWN POSITIVE: the project server connect writes points at this hook's own install, so the call is stamped as
    // this chat, in JSONC with comments as Cursor allows, and alongside unrelated servers.
    writeFileSync(mcpFile, `{\n  // written by opencadre connect\n  "mcpServers": {\n    "github": { "command": "gh-mcp" },\n    "opencadre-project": ${JSON.stringify(server(beside))}\n  }\n}\n`);
    expect(verifyStamp(credential, await call())).toEqual({ ok: true, sessionId: "conv-prec" });
    // And a project with no OpenCadre server at all is stamped too: nothing to defer to.
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }));
    expect(verifyStamp(credential, await call())).toEqual({ ok: true, sessionId: "conv-prec" });
  });

  it("forwards all six parallel Cursor stamps before hook exit on Windows", async () => {
    // Cursor's Windows hook runner can decide at process exit before it receives a
    // trailing stdout event. Measure the delivery lead time, not only eventual output.
    const one = (id: number) => new Promise<{ code: number | null; out: string; leadMs: number }>((resolve) => {
      const child = spawn(process.execPath, [path.join(bin, "opencadre-session-stamp.mjs"), "--client", "cursor"], { env: childEnv(home) });
      let out = "";
      let firstOutputAt = 0;
      let exitAt = 0;
      child.stdout.on("data", (chunk) => {
        if (!firstOutputAt) firstOutputAt = Date.now();
        out += chunk;
      });
      child.on("exit", () => { exitAt = Date.now(); });
      child.on("close", (code) => resolve({ code, out, leadMs: exitAt - firstOutputAt }));
      child.stdin.end(JSON.stringify({ ...cursorBase("preToolUse", `conv-flush-${id}`, project),
        tool_name: "MCP:opencadre_get_active_agents", tool_input: {}, tool_use_id: `flush-${id}` }));
    });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => one(i)));
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out).updated_input?.[STAMP_FIELD]).toBeDefined();
      expect(result.leadMs).toBeGreaterThanOrEqual(100);
    }
  }, 30_000);

  it("binds project tools when Cursor launches its MCP child from outside the project", async () => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), home, "cursor", ["--project", project]);
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    const listed = await p.request("tools/list", {});
    expect((listed.result.tools as Array<{ name: string }>).map((t) => t.name)).toContain("opencadre_get_active_agents");
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toEqual([]);
  });
  it("starting Cursor mints NO agent: initialize and tools/list ask the hub for no seat", async () => {
    const p = await proxy();
    const listed = await p.request("tools/list", {});
    expect((listed.result.tools as unknown[]).length).toBeGreaterThan(10);
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toEqual([]);
  });

  it("Cursor sees the hub's tools as opencadre_<tool>, so no other server's tool can share a name with them", async () => {
    const p = await proxy();
    const names = ((await p.request("tools/list", {})).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("opencadre_set_status");
    expect(names).toContain("opencadre_send_message");
    expect(names.every((n) => n.startsWith("opencadre_"))).toBe(true);
  });

  it("an UNSTAMPED call is refused, never answered as one pooled 'Cursor app' agent", async () => {
    // Without STAMP_ONLY in the proxy this call opened the app-start seat and every chat's unstamped calls
    // landed on that one agent.
    const p = await proxy();
    const res = await p.request("tools/call", { name: "opencadre_set_status", arguments: { task: "no stamp" } });
    expect(res.error?.message).toMatch(/no identity stamp/);
    expect(res.error?.message).toContain("CallMcpTool");
    expect(res.error?.message).toContain("do not run opencadre-mcp.mjs from a shell");
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toEqual([]);
  });

  it("the stamp hook signs only OpenCadre's tools, and says `{}` for anyone else's, same-named ones included", async () => {
    const ours = await asCursorWould("conv-A", "opencadre_set_status", { task: "x" });
    expect(verifyStamp(credential, ours[STAMP_FIELD])).toEqual({ ok: true, sessionId: "conv-A" });
    for (const other of ["MCP:read_file", "MCP:send_message", "MCP:opencadre_"]) {
      const r = await runHook(path.join(bin, "opencadre-session-stamp.mjs"), ["--client", "cursor"],
        { ...cursorBase("preToolUse", "conv-A", project), tool_name: other, tool_input: { path: "x" } }, childEnv(home));
      expect(r.out, other).toBe("{}");
    }
    const shell = await runHook(path.join(bin, "opencadre-session-stamp.mjs"), ["--client", "cursor"],
      { ...cursorBase("preToolUse", "conv-A", project), tool_name: "Shell", tool_input: { command: "ls" } }, childEnv(home));
    expect(shell.out).toBe("{}");
  });

  it("two Cursor chats are two agents, each call landing on its own, each a Cursor session in its project", async () => {
    const p = await proxy();
    await p.callTool("opencadre_set_status", await asCursorWould("conv-A", "opencadre_set_status", { task: "chat A at work" }));
    await p.callTool("opencadre_set_status", await asCursorWould("conv-B", "opencadre_set_status", { task: "chat B at work" }));
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null; currentTask?: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tool)).toEqual(["cursor", "cursor"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "cursor", projectName: "cursor-proj" });
    expect(rows.map((r) => r.currentTask).sort()).toEqual(["chat A at work", "chat B at work"]);
  });

  it("a stamp the MODEL typed for another chat is overwritten by the hook: the model is never a source of identity", async () => {
    const forged = mintStamp(credential, "conv-B");
    const merged = await asCursorWould("conv-A", "opencadre_set_status", { task: "chat A at work", [STAMP_FIELD]: forged });
    expect(merged[STAMP_FIELD].sid).toBe("conv-A");
  });

  it("the chat's sessionStart hook names the SAME agent its tool calls act as", async () => {
    const r = await runHook(path.join(bin, "opencadre-awareness.mjs"), ["--client", "cursor"], cursorBase("sessionStart", "conv-A", project), childEnv(home));
    const context = JSON.parse(r.out).additional_context as string;
    const name = /You are ([A-Z][a-z]+(?: [A-Z][a-z]+| \d+)?) in the OpenCadre fleet/.exec(context)?.[1];
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; currentTask?: string }>;
    expect(rows.find((row) => row.agentName === name)?.currentTask).toBe("chat A at work");
    // Cursor cannot wake an idle chat, and the chat is told so rather than told to keep a watcher.
    expect(context).toMatch(/Cursor cannot wake an idle chat/);
    expect(context).not.toMatch(/opencadre-wake\.mjs/);
  });

  it("introduces the same Cursor chat from a BOM-prefixed sessionStart", async () => {
    const payload = cursorBase("sessionStart", "conv-A", project);
    // Chat A's own agent: a Cursor session in cursor-proj. Its name is a word now (sessions PR1), so the row says which
    // tool and project it is.
    const chatA = (await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null; projectName: string | null; currentTask?: string }>)
      .find((row) => row.currentTask === "chat A at work");
    expect(chatA).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "cursor", projectName: "cursor-proj" });
    for (const prefix of ["", "\uFEFF"]) {
      const r = await runHook(path.join(bin, "opencadre-awareness.mjs"), ["--client", "cursor"],
        prefix + JSON.stringify(payload), childEnv(home));
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).additional_context, `BOM=${Boolean(prefix)}`).toContain(`You are ${chatA!.agentName} in the OpenCadre fleet`);
    }
  });

  it("MAIL: unread mail at the end of chat A's turn becomes a followup_message; chat B's stop stays quiet", async () => {
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; currentTask?: string }>;
    const a = rows.find((r) => r.currentTask === "chat A at work")!.agentName;
    const sent = await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: a, body: "please review the cursor PR", priority: "high" }),
    });
    expect(sent.status).toBe(201);
    const stop = (conv: string) => runHook(path.join(bin, "opencadre-awareness.mjs"), ["--client", "cursor"],
      { ...cursorBase("stop", conv, project), status: "completed", loop_count: 0 }, childEnv(home));
    const onA = JSON.parse((await stop("conv-A")).out);
    expect(onA.followup_message).toMatch(/1 unread OpenCadre message/);
    expect(onA.followup_message).toMatch(/opencadre_get_messages/);
    expect(onA.followup_message).toMatch(/please review the cursor PR/);
    expect(JSON.parse((await stop("conv-B")).out)).toEqual({});
    // A turn the user aborted is not extended.
    const aborted = await runHook(path.join(bin, "opencadre-awareness.mjs"), ["--client", "cursor"],
      { ...cursorBase("stop", "conv-A", project), status: "aborted", loop_count: 0 }, childEnv(home));
    expect(JSON.parse(aborted.out)).toEqual({});
    // A stop that a follow-up already continued is let go, as Claude Code's stop_hook_active is.
    const continued = await runHook(path.join(bin, "opencadre-awareness.mjs"), ["--client", "cursor"],
      { ...cursorBase("stop", "conv-A", project), status: "completed", loop_count: 1 }, childEnv(home));
    expect(JSON.parse(continued.out)).toEqual({});
  });

  it("doctor does not call a Cursor project ready when its project server is missing", async () => {
    const outside = await runDoctor({ client: "cursor", home });
    expect(outside.lines.join("\n")).toContain("Run doctor from your Cursor project folder");
    expect(outside.lines.join("\n")).not.toContain("Cursor project MCP entry missing");
    const missing = await runDoctor({ client: "cursor", home, projectRoot: project });
    expect(missing.healthy).toBe(false);
    expect(missing.lines.join("\n")).toContain("Cursor project MCP entry missing");
    const config = planCursorProjectServer({ projectRoot: project, proxyPath: path.join(bin, "opencadre-mcp.mjs") });
    mkdirSync(path.dirname(config.file), { recursive: true });
    writeFileSync(config.file, config.after);
    const ready = await runDoctor({ client: "cursor", home, projectRoot: project });
    expect(ready.lines.join("\n")).toContain("Cursor project MCP entry points to this folder");
  });
  it("doctor --client cursor reports the install healthy-shaped, and a hooks file without the stamp as incomplete", async () => {
    const ok = await runNode(CLI, ["doctor", "--client", "cursor", "--home", home], childEnv(home));
    expect(ok.out).toMatch(/hooks=present/);
    const hooksFile = path.join(home, ".cursor", "hooks.json");
    const installed = readFileSync(hooksFile, "utf8");
    try {
      const without = JSON.parse(installed);
      delete without.hooks.preToolUse;
      writeFileSync(hooksFile, JSON.stringify(without));
      const broken = await runNode(CLI, ["doctor", "--client", "cursor", "--home", home], childEnv(home));
      expect(broken.out).toMatch(/hooks=partial/);
      expect(broken.out).toMatch(/no identity stamp/);
    } finally {
      writeFileSync(hooksFile, installed);
    }
  });

  it("CLEARANCE: a risky command is held before it runs, asked for as chat A, and a denial comes back in Cursor's field", async () => {
    const cursorRoot = process.platform === "win32"
      ? project.replace(/^([A-Za-z]):/, "/$1:").replaceAll("\\", "/") : project;
    const gate = runHook(path.join(bin, "opencadre-approval-gate.mjs"), ["--client", "cursor"],
      { ...cursorBase("beforeShellExecution", "conv-A", cursorRoot), command: "Remove-Item -Recurse -Force C:\\oc-clearance-test-does-not-exist", cwd: "", sandbox: false },
      { ...childEnv(home), ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    // The request reaches the hub while the command is still held: the gate is waiting on it.
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending, JSON.stringify(await Promise.race([gate, new Promise((r) => setTimeout(() => r("still held"), 50))]))).toHaveLength(1);
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; currentTask?: string }>;
    expect(pending[0].requested_by_agent_name).toBe(rows.find((r) => r.currentTask === "chat A at work")!.agentName);
    expect(pending[0].details).toMatch(/^Cursor wants to run this shell command/);
    const decided = await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not now" });
    expect(decided.status).toBe(200);
    const r = await gate;
    const out = JSON.parse(r.out);
    expect(out.permission).toBe("deny");
    expect(out.agent_message).toMatch(/denied by Operator: not now/);
  });

  it("a harmless command gets `{}` (no opinion), never an empty answer Cursor would log as a failed hook", async () => {
    const r = await runHook(path.join(bin, "opencadre-approval-gate.mjs"), ["--client", "cursor"],
      { ...cursorBase("beforeShellExecution", "conv-A", project), command: "git status", cwd: project }, childEnv(home));
    expect(r.out).toBe("{}");
  });

  it("the credential never left credentials.json", () => {
    for (const file of [path.join(home, ".cursor", "mcp.json"), path.join(home, ".cursor", "hooks.json")]) {
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).not.toContain(credential);
    }
  });
});
