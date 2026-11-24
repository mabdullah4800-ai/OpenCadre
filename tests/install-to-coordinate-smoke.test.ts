import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SPAWN_TEST_TIMEOUT_MS, waitFor } from "./helpers/spawn.js";

// One fresh HOME, one unbroken run of the whole path a real seat travels: install -> connect ->
// session joins -> a message wakes it -> an approval round-trips. Every other suite in this repo
// covers one segment of that path; none covers the seam BETWEEN them, which is where the interesting
// failure lives. `installHelpers` (cli/lib/generations.mjs) copies each helper into ~/.opencadre/bin/.gen/<id>/ and
// rewrites its `../../scripts/` imports to `./`, behind entry stubs at the old paths -- so the file that actually runs in
// production is a TRANSFORMED COPY, not the source file. tests/wake.test.ts spawns the repo's scripts/opencadre-wake.mjs
// and tests/connect-cli.test.ts asserts the installed files exist, but nothing runs an installed
// helper as a process against a hub. A helper that survived the copy but lost an import would pass
// both of those and still be dead on a real machine.
//
// Scope, stated so this is not read as more than it is: this is the Claude Code seat, the one whose
// full path is reachable locally. It proves no shell is reachable from this chain -- /bin/sh appears
// nowhere in it, so this test would NOT have caught the execFile("/bin/sh") ENOENT bug in
// scripts/deepseek-shell-guard.mjs; that is a separate lane's cause 2.
//
// The CLI redeems from 127.0.0.1 here; lift the per-IP limit before the app loads.
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
const { app } = await import("../src/rest.js");
const { createOrganization, registerAgent, sendMessage } = await import("../src/service.js");
const { decideApproval, listApprovals } = await import("../src/approvals.js");

const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
// PATH points at an empty folder so no real claude/codex/gemini CLI on this machine is found or touched.
const EMPTY_PATH = mkdtempSync(path.join(tmpdir(), "oc-smoke-path-"));
const WORK_FOLDER = mkdtempSync(path.join(tmpdir(), "oc-smoke-work-"));

let server: http.Server;
let hub: string;
let operatorKey: string;
let operator: { id: string; name: string };

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  hub = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const { orgId } = createOrganization("Install To Coordinate Org");
  const op = registerAgent(orgId, "Operator", { role: "operator", system: true });
  operatorKey = op.apiKey;
  operator = { id: op.agentId, name: op.agentName };
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Runs a script asynchronously -- the hub runs in this process, so a sync spawn would deadlock it. */
function run(script: string, args: string[], env: Record<string, string>, opts: { cwd?: string; input?: string } = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...env, PATH: EMPTY_PATH },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end(opts.input);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("install -> connect -> wake -> coordinate, on one fresh HOME", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("runs the whole path with no step skipped, using the INSTALLED helper copies", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "oc-smoke-home-"));
    const stateDir = mkdtempSync(path.join(tmpdir(), "oc-smoke-state-"));
    // This is the folder the seat works in; connect stamps the project from it, so it must exist.
    const project = realpathSync(WORK_FOLDER);

    // ---- 1. INSTALL + CONNECT: a connect code from the operator, redeemed by the real CLI process.
    const agentName = "Smoke-Agent";
    const codeRes = await fetch(`${hub}/v1/connect-codes`, {
      method: "POST",
      headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ agentName, client: "claude-code" }),
    });
    expect(codeRes.status).toBe(201);
    const { code } = (await codeRes.json()) as { code: string };

    const connected = await run(CLI, ["connect", "--hub", hub, "--code", code, "--home", home, "--client", "claude-code", "--verbose"], {
      ...process.env,
      // The CLI keeps the key in the client config; the wake helper reads the seat's identity from here.
      HOME: home,
      USERPROFILE: home,
      OPENCADRE_HOOK_HOME: home,
      // No Claude Code session leaks in from the suite's own environment.
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_CODE_HOST_SESSION_ID: "",
    } as Record<string, string>);
    expect(connected.err).toBe("");
    expect(connected.code).toBe(0);
    expect(connected.out).toContain("Connected as Smoke-Agent");

    // The key was written to the client config and never printed -- assert both, since printing a key
    // into a terminal is the one install failure that is also a disclosure.
    const claudeConfig = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, { headers?: Record<string, string> }>;
    };
    const key = claudeConfig.mcpServers?.opencadre?.headers?.Authorization?.replace(/^Bearer /, "") ?? "";
    expect(key).toMatch(/^agt_[0-9a-f]{48}$/);
    expect(connected.out).not.toContain(key);
    expect(connected.err).not.toContain(key);

    // ---- 2. THE SEAM THIS TEST EXISTS FOR: the installed copies must really be there, and the
    // copy transform must have landed. A source-only path or an unrewritten ../.. import still passes
    // "does the file exist", so assert the rewrite itself.
    const binDir = path.join(home, ".opencadre", "bin");
    const installedWake = path.join(binDir, "opencadre-wake.mjs");
    const installedAwareness = path.join(binDir, "opencadre-awareness.mjs");
    expect(existsSync(installedWake)).toBe(true);
    expect(existsSync(installedAwareness)).toBe(true);
    // Since Q1g PR-2 the entry paths are stubs; the helpers (and the rewrite) live in the active generation.
    const gen = path.join(binDir, ".gen", readFileSync(path.join(binDir, ".gen", "current"), "utf8").trim());
    expect(existsSync(path.join(gen, "opencadre-config.mjs"))).toBe(true);

    const installedAwarenessText = readFileSync(path.join(gen, "opencadre-awareness.mjs"), "utf8");
    expect(installedAwarenessText).toContain("from \"./opencadre-config.mjs\"");
    expect(installedAwarenessText).not.toContain("../../scripts/");

    // The installed hooks are wired into the client config, not just copied into a folder.
    expect(connected.out).toContain(".claude.json");

    // ---- 3. THE SESSION JOINS. The wake helper resolves the seat's identity from the installed
    // config, so give it a session id as a Claude Code Stop hook would.
    const sessionId = "smoke-session-1";
    const wakeEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENCADRE_HOOK_HOME: home,
      OPENCADRE_WAKE_STATE_DIR: stateDir,
      OPENCADRE_WAIT_SECONDS: "1",
      CLAUDE_CODE_SESSION_ID: sessionId,
    } as Record<string, string>;

    const joining = run(installedWake, ["--rewake", "--client", "claude-code"], wakeEnv, {
      cwd: project,
      input: JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, cwd: project }),
    });

    // ---- 4. A MESSAGE WAKES IT. Relayed through the hub the seat actually connected to, addressed
    // to the agent name the CLI reported -- not an id this test made up.
    const orgId = (await (await fetch(`${hub}/v1/me`, { headers: { authorization: `Bearer ${key}` } })).json()).orgId as string;
    const peer = registerAgent(orgId, "Smoke-Peer");
    const sent = await sendMessage(orgId, { id: peer.agentId, name: peer.agentName }, agentName, "smoke: coordinate with me", "high");
    expect(sent.ok).toBe(true);

    const wakeResult = await joining;
    expect(wakeResult.code).toBe(2); // asyncRewake's "wake this session" exit
    expect(wakeResult.err).toContain("smoke: coordinate with me");
    // The wake line must never carry the key.
    expect(wakeResult.err).not.toContain(key);

    // ---- 5. AN APPROVAL ROUND-TRIPS through the installed gate against the same hub.
    const gate = path.join(binDir, "opencadre-approval-gate.mjs");
    expect(existsSync(gate)).toBe(true);
    const gateRun = run(gate, ["--client", "claude-code"], {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENCADRE_HOOK_HOME: home,
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_APPROVAL_WAIT: "20",
      CLAUDE_CODE_SESSION_ID: sessionId,
    } as Record<string, string>, { cwd: project, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf ./src" } }) });

    // The gate asks the hub; answer it as the operator the way a human would, then let it proceed.
    // Decided in-process, like tests/approval-hook.test.ts does: the hub shares this process, so a
    // REST round-trip here would have to interleave with the child's own polling.
    await waitFor(() => listApprovals(orgId, { status: "pending" }).length > 0, "the gate's approval request to reach the hub");
    const pending = listApprovals(orgId, { status: "pending" })[0];
    // A person decides a clearance (migration 53); the operator agent's decide would be refused.
    const { signInPerson } = await import("./helpers/person.js");
    expect(decideApproval(orgId, (await signInPerson(orgId)).decider, pending.id, "approve", "smoke: go ahead").ok).toBe(true);

    const gateResult = await gateRun;
    expect(gateResult.code).toBe(0);
    // An approved command is allowed through; the round-trip really reached this seat's hub.
    expect(gateResult.out).not.toContain("denied");
  });
});