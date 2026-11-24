// Codex identity stamp: two Codex chats on one machine are two agents, and a reopened chat is not refused.
//
// THE BAR (docs/planning/LAUNCH-CLIENT-GATE.md §1 row 2): "Every chat is its own agent on the roster. Two
// chats on one machine are two agents, never one."
//
// WHAT WAS WRONG, MEASURED 2026-09-22 on a real Codex CLI 0.155.1 install: a closed Codex chat's hub
// session stays live until the 12 h TTL (the proxy is hard-killed on exit, so it cannot leave), and a
// reopened chat's hook, which ADOPTS the one live session in the folder, found two and printed "this chat
// has no identity of its own". The stamp removes the deduction: the PreToolUse hook signs the chat's own
// session_id into every OpenCadre call, the proxy answers as that chat, and a stamped chat's hooks
// resolve by that same id instead of adopting.
//
// Every describe block below has an arm that must FAIL without the change, named in its own comments.
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADOPT_LIVE_HEADER, codexStampActive, codexStampInstalled, RESOLVE_ONLY_HEADER, resolveHub, STAMP_FIELD, mintStamp, STAMP_MAX_AGE_MS, verifyStamp,
} from "../scripts/opencadre-config.mjs";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const ROOT = process.cwd();
const STAMP_HOOK = path.join(ROOT, "examples", "hooks", "opencadre-session-stamp.mjs");
const PROXY = path.join(ROOT, "scripts", "opencadre-mcp.mjs");
const CREDENTIAL = `dev_${"a".repeat(48)}`;
// The name Codex gives our tools: its CONFIG key is `opencadre-session` (hyphen) but its TOOL names are
// underscored. MEASURED: 58 of 58 in a live rollout. The hyphen form below is the plausible wrong spelling.
const REAL_TOOL = "mcp__opencadre_session__set_status";
const HYPHEN_TOOL = "mcp__opencadre-session__set_status";

/** A home holding a device credential for `hub`, and a Codex hooks.json that does or does not run the stamp.
 * `trusted` also records Codex trust for the stamp's entry, the step a person takes in /hooks. */
function seededHome(hub = "http://127.0.0.1:9", { stamp = true, trusted = stamp } = {}) {
  const home = tempDir("oc-stamp-home-");
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub, credential: CREDENTIAL, deviceId: "dev-test" } }));
  writeCodexHooks(home, stamp);
  if (trusted) trustStamp(home);
  return home;
}

/** Records Codex trust for the stamp, in Codex's own positional format: the stamp is PreToolUse group 0,
 * handler 1 (after the gate). Codex writes OpenCadre's entries single-quoted (MEASURED on the fleet PC). */
function trustStamp(home: string, { group = 0, handler = 1 } = {}) {
  const file = path.join(home, ".codex", "config.toml");
  const hooksFile = path.join(home, ".codex", "hooks.json");
  const prior = (() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })();
  writeFileSync(file, `${prior}\n[hooks.state.'${hooksFile}:pre_tool_use:${group}:${handler}']\ntrusted_hash = "sha256:test"\n`);
}

function writeCodexHooks(home: string, stamp: boolean) {
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  const gate = { type: "command", command: `node "${path.join(home, ".opencadre", "bin", "opencadre-approval-gate.mjs")}" --client codex` };
  const stampHook = { type: "command", command: `node "${path.join(home, ".opencadre", "bin", "opencadre-session-stamp.mjs")}"` };
  writeFileSync(path.join(home, ".codex", "hooks.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash|mcp__opencadre_session__.*|mcp__opencadre__.*", hooks: stamp ? [gate, stampHook] : [gate] }] },
  }));
}

function runHook(script: string, payload: unknown, env: Record<string, string>, cwd?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--client", "codex"], { env, cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

const preToolUse = (tool_name: string, tool_input: unknown, session_id: unknown = "chat-A") =>
  ({ hook_event_name: "PreToolUse", session_id, tool_name, tool_input, tool_use_id: "call_1", cwd: ROOT, turn_id: "t1" });

describe("the stamp hook: signs OpenCadre calls, and says nothing about anything else", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const home = seededHome();
  const env = childEnv(home);

  it("stamps an OpenCadre call: allow + updatedInput carrying EVERY original argument and a signature that verifies", async () => {
    const args = { task: "reviewing #530", files: ["a.ts"], phase: "reviewing" };
    const r = await runHook(STAMP_HOOK, preToolUse(REAL_TOOL, args), env);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out).hookSpecificOutput;
    expect(out.hookEventName).toBe("PreToolUse");
    // Codex applies updatedInput ONLY with "allow" (output_parser.rs:162-168); "ask" fails the hook run.
    expect(out.permissionDecision).toBe("allow");
    const { [STAMP_FIELD]: stamp, ...rest } = out.updatedInput;
    // updatedInput REPLACES the arguments, so losing one here would silently change the call.
    expect(rest).toEqual(args);
    expect(verifyStamp(CREDENTIAL, stamp)).toEqual({ ok: true, sessionId: "chat-A" });
  });

  it("OVERWRITES a stamp the model supplied: the model is never a source of identity", async () => {
    const forged = { sid: "chat-SIBLING", sig: "0".repeat(64) };
    const r = await runHook(STAMP_HOOK, preToolUse(REAL_TOOL, { task: "x", [STAMP_FIELD]: forged }), env);
    const stamp = JSON.parse(r.out).hookSpecificOutput.updatedInput[STAMP_FIELD];
    expect(stamp.sid).toBe("chat-A");
    expect(verifyStamp(CREDENTIAL, stamp).ok).toBe(true);
  });

  it("stamps a call with NO arguments too (tool_input absent)", async () => {
    const r = await runHook(STAMP_HOOK, preToolUse("mcp__opencadre_session__get_messages", undefined), env);
    expect(Object.keys(JSON.parse(r.out).hookSpecificOutput.updatedInput)).toEqual([STAMP_FIELD]);
  });

  // Each of these is SILENCE (exit 0, no output), which Codex reads as "no opinion". A hook that denied or
  // printed here would break every other tool, so the negative fixtures matter as much as the positive one.
  for (const [name, payload] of [
    ["a shell call", preToolUse("Bash", { command: "ls" })],
    ["the HYPHEN spelling of our tool (the config key, not a real tool name)", preToolUse(HYPHEN_TOOL, { task: "x" })],
    ["another product's MCP tool", preToolUse("mcp__filesystem__read_file", { path: "x" })],
    ["a payload with no session_id", { hook_event_name: "PreToolUse", tool_name: REAL_TOOL, tool_input: { task: "x" }, tool_use_id: "call_1", cwd: ROOT }],
    ["a null session_id", preToolUse(REAL_TOOL, { task: "x" }, null)],
    ["a blank session_id", preToolUse(REAL_TOOL, { task: "x" }, "  ")],
    ["tool_input that is not an object (cannot be copied whole)", preToolUse(REAL_TOOL, ["x"])],
    ["unparseable stdin", "{not json"],
  ] as const) {
    it(`says nothing for ${name}`, async () => {
      const r = await runHook(STAMP_HOOK, payload, env);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
    });
  }

  it("says nothing on a machine with no device credential to sign with", async () => {
    const bare = tempDir("oc-stamp-bare-");
    const r = await runHook(STAMP_HOOK, preToolUse(REAL_TOOL, { task: "x" }), childEnv(bare));
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });
});

describe("Codex project MCP precedence", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("keeps a user-level stamp silent when a project replaces its proxy", async () => {
    const project = gitProject("codex-project-proxy-precedence");
    const globalHome = seededHome();
    mkdirSync(path.join(project, ".codex"));
    const projectProxy = path.join(project, "project-home", ".opencadre", "bin", "opencadre-mcp.mjs");
    writeFileSync(path.join(project, ".codex", "config.toml"),
      `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ${JSON.stringify([projectProxy, "--client", "codex"])}\n`);
    const payload = { ...preToolUse(REAL_TOOL, { task: "x" }), cwd: project };
    const userHook = await runHook(STAMP_HOOK, payload, childEnv(globalHome), project);
    expect(userHook.code).toBe(0);
    expect(userHook.out).toBe("");

    // Codex accepts quoted TOML table names with spacing; a non-proxy server must never receive our stamp.
    writeFileSync(path.join(project, ".codex", "config.toml"),
      `[ mcp_servers . "opencadre-session" ]\nurl = "https://example.invalid/mcp"\n`);
    expect((await runHook(STAMP_HOOK, payload, childEnv(globalHome), project)).out).toBe("");

    // A multi-line TOML args array is not understood by this small guard. It must fail closed:
    // neither user-level nor project hook signs until the project uses the writer's one-line form.
    writeFileSync(path.join(project, ".codex", "config.toml"),
      `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = [\n  ${JSON.stringify(projectProxy)},\n  "--client", "codex"\n]\n`);
    expect((await runHook(STAMP_HOOK, payload, childEnv(globalHome), project)).out).toBe("");

    // A hook installed beside the project proxy may stamp with the project's own credential.
    const sameBinProxy = path.join(path.dirname(STAMP_HOOK), "opencadre-mcp.mjs");
    writeFileSync(path.join(project, ".codex", "config.toml"),
      `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ${JSON.stringify([sameBinProxy, "--client", "codex"])}\n`);
    const projectHook = await runHook(STAMP_HOOK, payload, childEnv(globalHome), project);
    const stamp = JSON.parse(projectHook.out).hookSpecificOutput.updatedInput[STAMP_FIELD];
    expect(verifyStamp(CREDENTIAL, stamp)).toEqual({ ok: true, sessionId: "chat-A" });
  });
});

describe("the signature: a stamp names ONE chat on ONE machine", () => {
  const good = mintStamp(CREDENTIAL, "chat-A");
  it("verifies its own stamp", () => expect(verifyStamp(CREDENTIAL, good)).toEqual({ ok: true, sessionId: "chat-A" }));
  it("refuses a valid signature moved onto another chat's id (the sibling-impersonation case)", () =>
    expect(verifyStamp(CREDENTIAL, { ...good, sid: "chat-B" }).ok).toBe(false));
  it("refuses a valid signature moved onto another time (the time is signed too)", () =>
    expect(verifyStamp(CREDENTIAL, { ...good, ts: good.ts + 1 }).ok).toBe(false));
  // Review of 8c294fd, finding 3: harnesses keep a call's arguments on disk (Gemini's chat recording, a Codex
  // rollout), so a stamp copied from there must not act as the chat for good.
  it("refuses a stamp older than STAMP_MAX_AGE_MS, and one dated in the future", () => {
    const now = Date.now();
    expect(verifyStamp(CREDENTIAL, mintStamp(CREDENTIAL, "chat-A", now - STAMP_MAX_AGE_MS + 1000), { now }).ok).toBe(true);
    expect(verifyStamp(CREDENTIAL, mintStamp(CREDENTIAL, "chat-A", now - STAMP_MAX_AGE_MS - 1000), { now })).toEqual({ ok: false, reason: "expired" });
    expect(verifyStamp(CREDENTIAL, mintStamp(CREDENTIAL, "chat-A", now + 5 * 60 * 1000), { now }).ok).toBe(false);
  });
  it("refuses an undated v1 stamp (sid + sig only), naming the fix", () => {
    const r = verifyStamp(CREDENTIAL, { sid: good.sid, sig: good.sig });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/run the connect command again/);
  });
  it("refuses a stamp signed by another machine's credential", () =>
    expect(verifyStamp(`dev_${"b".repeat(48)}`, good).ok).toBe(false));
  it("refuses a bare id with no signature, which is what a model could type", () =>
    expect(verifyStamp(CREDENTIAL, { sid: "chat-A" }).ok).toBe(false));
  it("refuses a string, an array and null", () => {
    for (const bad of ["chat-A", ["chat-A"], null]) expect(verifyStamp(CREDENTIAL, bad).ok).toBe(false);
  });
});

describe("a stamped Codex chat's hooks resolve by their own id instead of adopting", () => {
  // The switch reads the file Codex itself reads. The control arm is the same call without the stamp in
  // hooks.json: it must keep today's resolve-only + adopt headers exactly, since without the stamp the
  // proxy still sits on its own seat and only adoption joins the two.
  it("with the stamp installed AND trusted: exact-chat resolve-only, no adopt", () => {
    const home = seededHome();
    expect(codexStampActive({ home })).toBe(true);
    const { headers } = resolveHub({ client: "codex", home, env: childEnv(home), sessionId: "chat-C", cwd: home });
    expect(headers[RESOLVE_ONLY_HEADER]).toBe("1");
    expect(headers[ADOPT_LIVE_HEADER]).toBeUndefined();
    expect(headers["x-opencadre-session"]).toBe("chat-C");
  });

  it("CONTROL, without the stamp: resolve-only + adopt, exactly as before", () => {
    const home = seededHome(undefined, { stamp: false });
    expect(codexStampInstalled({ home })).toBe(false);
    const { headers } = resolveHub({ client: "codex", home, env: childEnv(home), sessionId: "chat-C", cwd: home });
    expect(headers[RESOLVE_ONLY_HEADER]).toBe("1");
    expect(headers[ADOPT_LIVE_HEADER]).toBe("1");
  });

  it("INSTALLED BUT NOT YET TRUSTED keeps resolve-only + adopt: Codex will skip the stamp, so the hooks must not use their own seat", () => {
    // Review finding (d193, against 1647207): right after connect --upgrade the stamp is in hooks.json but Codex
    // skips it until a person trusts it in /hooks. Using the own seat then would split the chat from its
    // unstamped tool calls, which stay on the proxy's process seat.
    const home = seededHome(undefined, { stamp: true, trusted: false });
    expect(codexStampInstalled({ home })).toBe(true);
    expect(codexStampActive({ home })).toBe(false);
    const { headers } = resolveHub({ client: "codex", home, env: childEnv(home), sessionId: "chat-C", cwd: home });
    expect(headers[RESOLVE_ONLY_HEADER]).toBe("1");
    expect(headers[ADOPT_LIVE_HEADER]).toBe("1");
  });

  it("trust recorded for a DIFFERENT hook position does not count as trusting the stamp", () => {
    const home = seededHome(undefined, { stamp: true, trusted: false });
    trustStamp(home, { group: 0, handler: 0 }); // the gate's position, not the stamp's
    expect(codexStampActive({ home })).toBe(false);
  });

  it("never applies to another client, even on a machine with the stamp installed", () => {
    const home = seededHome();
    const { headers } = resolveHub({ client: "claude-code", home, env: childEnv(home), sessionId: "cc-chat", cwd: home });
    expect(headers[RESOLVE_ONLY_HEADER]).toBe("1");
  });

  it("with no caller-supplied id there is nothing to key on, so it stays resolve-only", () => {
    const home = seededHome();
    const { headers } = resolveHub({ client: "codex", home, env: childEnv(home), cwd: home });
    expect(headers[RESOLVE_ONLY_HEADER]).toBe("1");
  });
});

/** A stand-in hub that records every request the proxy makes, and answers like /mcp.
 *
 * It keeps the REAL hub's rule (src/mcp.ts routeMcpTransport): an MCP session belongs to the identity that
 * opened it, and a request from any other identity on it is refused with 401. Its sessions are named
 * `s-<identity>`, so a request that crosses identities is refused here exactly as it would be in production.
 * `slowInitFor` delays one identity's initialize, to make a second chat's calls overlap with it. */
async function recordingHub({ slowInitFor, slowMs = 400 }: { slowInitFor?: string; slowMs?: number } = {}) {
  const seen: Array<{ session: string | undefined; mcpSession: string | undefined; status: number; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const session = req.headers["x-opencadre-session"] as string | undefined;
      const mcpSession = req.headers["mcp-session-id"] as string | undefined;
      const answer = (status: number, headers: Record<string, string>, payload?: unknown) => {
        seen.push({ session, mcpSession, status, body });
        res.writeHead(status, headers).end(payload === undefined ? undefined : JSON.stringify(payload));
      };
      if (mcpSession && mcpSession !== `s-${session}`) {
        answer(401, { "content-type": "application/json" }, { error: "This API key doesn't match the agent this MCP session belongs to." });
        return;
      }
      if (body?.id === undefined) {
        answer(202, {});
        return;
      }
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "opencadre", version: "t" } }
        : { content: [{ type: "text", text: "ok" }] };
      const reply = () => answer(200, { "content-type": "application/json", "mcp-session-id": `s-${session}` }, { jsonrpc: "2.0", id: body.id, result });
      if (body.method === "initialize" && session === slowInitFor) setTimeout(reply, slowMs);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("the proxy: takes a call's identity from a verified stamp, and never forwards the stamp", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  let hub: Awaited<ReturnType<typeof recordingHub>>;
  let proxy: ProxyProcess;
  beforeAll(async () => {
    hub = await recordingHub();
    const home = seededHome(hub.url);
    proxy = new ProxyProcess(PROXY, childEnv(home), tempDir("oc-stamp-cwd-"), "codex");
    expect((await proxy.initialize()).error).toBeUndefined();
  });
  afterAll(async () => {
    await proxy.close();
    await hub.close();
  });
  const calls = () => hub.seen.filter((s) => s.body?.method === "tools/call");

  it("CONTROL, no stamp: the call goes out on this process's own seat, as before", async () => {
    await proxy.callTool("set_status", { task: "unstamped" });
    expect(calls().at(-1)!.session).toMatch(/^codex-/);
  });

  it("a valid stamp: the call goes out as THAT chat, with the stamp removed and every other argument intact", async () => {
    const stamp = mintStamp(CREDENTIAL, "chat-A");
    await proxy.callTool("set_status", { task: "as A", files: ["x"], [STAMP_FIELD]: stamp });
    const last = calls().at(-1)!;
    expect(last.session).toBe("chat-A");
    expect(last.body.params.arguments).toEqual({ task: "as A", files: ["x"] });
  });

  it("a second chat's stamp on the same connection is answered as the second chat", async () => {
    await proxy.callTool("set_status", { task: "as B", [STAMP_FIELD]: mintStamp(CREDENTIAL, "chat-B") });
    expect(calls().at(-1)!.session).toBe("chat-B");
  });

  it("a stamp that does not verify is REFUSED locally and nothing reaches the hub, not even under this process's seat", async () => {
    const before = hub.seen.length;
    const res = await proxy.request("tools/call", { name: "set_status", arguments: { task: "forged", [STAMP_FIELD]: { sid: "chat-A", sig: "0".repeat(64) } } });
    expect(res.error?.message).toMatch(/did not verify/);
    expect(hub.seen.length).toBe(before);
  });

  it("a stamp whose dated signature is forged is refused, however fresh its date", async () => {
    const real = mintStamp(CREDENTIAL, "chat-A");
    const before = hub.seen.length;
    const res = await proxy.request("tools/call", { name: "set_status", arguments: { task: "forged", [STAMP_FIELD]: { ...real, tsig: "0".repeat(real.tsig.length) } } });
    expect(res.error?.message).toMatch(/did not verify/);
    expect(hub.seen.length).toBe(before);
  });

  it("a model-typed bare id (no signature) is refused the same way", async () => {
    const res = await proxy.request("tools/call", { name: "set_status", arguments: { [STAMP_FIELD]: { sid: "chat-A" } } });
    expect(res.error?.message).toMatch(/did not verify/);
  });

  it("no request ever carried the stamp field to the hub", () => {
    for (const s of hub.seen) expect(JSON.stringify(s.body ?? {})).not.toContain(STAMP_FIELD);
  });

  it("an UNSTAMPED call made AFTER stamped ones goes out on this process's own seat, never the last chat's", async () => {
    // Review finding 1 against the first version: a stamp moved the proxy's global headers, so this call
    // was sent as chat-B. It must not inherit a chat it did not come from.
    await proxy.callTool("set_status", { task: "unstamped, after" });
    const last = calls().at(-1)!;
    expect(last.body.params.arguments.task).toBe("unstamped, after");
    expect(last.session).toMatch(/^codex-/);
    expect(last.mcpSession).toBe(`s-${last.session}`);
    expect(last.status).toBe(200);
  });
});

describe("the proxy: two chats' overlapping calls never cross identities", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  // Review finding 2 against the first version: forward() read the proxy's GLOBAL headers and session after
  // waiting, so while chat A's hub session was still being opened, chat B's stamp could change them and A's
  // call left as B (or on the wrong session, and was refused 401). Here chat A's initialize is held for 400 ms
  // while calls from both chats are in flight together. Every call must reach the hub as its OWN chat, on
  // its OWN session.
  it("every call reaches the hub as its own chat and on its own session, with A's session opening slowly", async () => {
    const hub = await recordingHub({ slowInitFor: "chat-A" });
    const home = seededHome(hub.url);
    const proxy = new ProxyProcess(PROXY, childEnv(home), tempDir("oc-stamp-cwd-"), "codex");
    try {
      expect((await proxy.initialize()).error).toBeUndefined();
      const as = (sid: string, task: string) => ({ task, [STAMP_FIELD]: mintStamp(CREDENTIAL, sid) });
      const results = await Promise.all([
        proxy.request("tools/call", { name: "set_status", arguments: as("chat-A", "A1") }),
        proxy.request("tools/call", { name: "set_status", arguments: as("chat-B", "B1") }),
        proxy.request("tools/call", { name: "set_status", arguments: as("chat-A", "A2") }),
        proxy.request("tools/call", { name: "set_status", arguments: as("chat-B", "B2") }),
        proxy.request("tools/call", { name: "set_status", arguments: { task: "P1" } }),
      ]);
      for (const r of results) expect(r.error, JSON.stringify(r.error)).toBeUndefined();
      const calls = hub.seen.filter((s) => s.body?.method === "tools/call");
      expect(calls.map((c) => c.body.params.arguments.task).sort()).toEqual(["A1", "A2", "B1", "B2", "P1"]);
      for (const c of calls) {
        const task = c.body.params.arguments.task as string;
        const expected = task.startsWith("A") ? "chat-A" : task.startsWith("B") ? "chat-B" : undefined;
        if (expected) expect(c.session, task).toBe(expected);
        else expect(c.session, task).toMatch(/^codex-/);
        expect(c.mcpSession, task).toBe(`s-${c.session}`);
        expect(c.status, task).toBe(200);
      }
      // Chat A's session was opened once, even though two of A's calls were waiting for it.
      expect(hub.seen.filter((s) => s.body?.method === "initialize" && s.session === "chat-A").length).toBe(1);
    } finally {
      await proxy.close();
      await hub.close();
    }
  });

  it("refuses one message that carries two different chats' stamps", async () => {
    const hub = await recordingHub();
    const home = seededHome(hub.url);
    const proxy = new ProxyProcess(PROXY, childEnv(home), tempDir("oc-stamp-cwd-"), "codex");
    try {
      await proxy.initialize();
      const before = hub.seen.length;
      proxy.write([
        { jsonrpc: "2.0", id: "b1", method: "tools/call", params: { name: "set_status", arguments: { [STAMP_FIELD]: mintStamp(CREDENTIAL, "chat-A") } } },
        { jsonrpc: "2.0", id: "b2", method: "tools/call", params: { name: "set_status", arguments: { [STAMP_FIELD]: mintStamp(CREDENTIAL, "chat-B") } } },
      ]);
      expect((await proxy.response("b1")).error?.message).toMatch(/two different chats/);
      expect(hub.seen.length).toBe(before);
    } finally {
      await proxy.close();
      await hub.close();
    }
  });

  it("refuses one message that mixes a stamped call with an UNSTAMPED one, which must not run as the stamped chat", async () => {
    // Review finding 3 (d193, against d777d2d): the batch went out whole on the stamped chat's channel, so the
    // unstamped call ran as chat A. Refusing is the answer: neither call can be attributed honestly as sent.
    const hub = await recordingHub();
    const home = seededHome(hub.url);
    const proxy = new ProxyProcess(PROXY, childEnv(home), tempDir("oc-stamp-cwd-"), "codex");
    try {
      await proxy.initialize();
      const before = hub.seen.length;
      proxy.write([
        { jsonrpc: "2.0", id: "m1", method: "tools/call", params: { name: "set_status", arguments: { task: "A", [STAMP_FIELD]: mintStamp(CREDENTIAL, "chat-A") } } },
        { jsonrpc: "2.0", id: "m2", method: "tools/call", params: { name: "set_status", arguments: { task: "unstamped" } } },
      ]);
      expect((await proxy.response("m1")).error?.message).toMatch(/stamped and unstamped/);
      expect((await proxy.response("m2")).error?.message).toMatch(/stamped and unstamped/);
      expect(hub.seen.length).toBe(before);
    } finally {
      await proxy.close();
      await hub.close();
    }
  });
});

describe("the whole installed chain against a real hub: reopen, and two chats", { timeout: 120_000 }, () => {
  // Installed by `connect --client codex` into a temp home, then driven the way Codex drives it: the
  // awareness hook on SessionStart, the proxy on tool calls. The BEFORE arm reproduces the refusal the
  // operator's real install printed on 2026-09-22; the AFTER arm is the same state with the stamp.
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let deviceId: string;
  let home: string;
  let credential: string;
  let bin: string;
  const project = gitProject("StampProj");
  const proxies: ProxyProcess[] = [];

  beforeAll(async () => {
    hub = await startHub();
    ({ operatorKey } = await operatorWorkspace("Stamp Org"));
    await enableProject(hub.url, operatorKey, "local:stampproj");
    const minted = await mintDevice(hub.url, operatorKey, "codex");
    deviceId = minted.deviceId;
    home = tempDir("oc-stamp-e2e-");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "codex"], childEnv(home));
    expect(connected.code, connected.err).toBe(0);
    credential = computerCredential(home);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  const hookSays = async (sessionId: string) => {
    const r = await runHook(path.join(bin, "opencadre-awareness.mjs"),
      { hook_event_name: "SessionStart", source: "startup", session_id: sessionId, cwd: project, transcript_path: "", model: "m" }, childEnv(home));
    return r.out + r.err;
  };
  const stamped = (sid: string, args: object) => ({ ...args, [STAMP_FIELD]: mintStamp(credential, sid) });
  const nameIn = (text: string) => text.match(/You are ([A-Z][a-z]+(?: [A-Z][a-z]+| \d+)?) in the OpenCadre fleet/)?.[1];

  it("connect installs the stamp hook into Codex's PreToolUse group, NOT yet trusted", () => {
    const hooks = readFileSync(path.join(home, ".codex", "hooks.json"), "utf8");
    expect(hooks).toContain("opencadre-session-stamp.mjs");
    expect(codexStampInstalled({ home })).toBe(true);
    // A fresh install has no Codex trust for the new entry: Codex will skip it until /hooks trusts it.
    expect(codexStampActive({ home })).toBe(false);
  });

  it("sets the stage: two live Codex sessions in the folder, the state a closed-then-reopened chat leaves behind", async () => {
    for (const task of ["stale-1", "stale-2"]) {
      const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "codex");
      proxies.push(p);
      expect((await p.initialize()).error).toBeUndefined();
      await p.callTool("set_status", { task });
    }
    expect((await liveSessions(hub.url, operatorKey, deviceId)).length).toBeGreaterThanOrEqual(2);
  });

  it("BEFORE: without the stamp, a new chat's hook is refused (this reproduces the measured defect)", async () => {
    const hooksFile = path.join(home, ".codex", "hooks.json");
    const installed = readFileSync(hooksFile, "utf8");
    try {
      writeFileSync(hooksFile, installed.replace(/,?\s*\{[^{}]*opencadre-session-stamp\.mjs[^{}]*\}/, ""));
      expect(codexStampInstalled({ home })).toBe(false);
      expect(await hookSays("codex-chat-C")).toMatch(/no identity of its own/);
    } finally {
      writeFileSync(hooksFile, installed);
    }
  });

  it("INSTALLED BUT UNTRUSTED behaves exactly as before, so the chat is never split from its unstamped calls", async () => {
    // Review finding (d193, against 1647207). Before this fix the hook used its own seat here while Codex
    // skipped the untrusted stamp, so the chat's tool calls stayed on the proxy's process seat: one chat, two agents.
    expect(codexStampActive({ home })).toBe(false);
    expect(await hookSays("codex-chat-C")).toMatch(/no identity of its own/);
  });

  it("the person trusts the stamp in /hooks (recorded the way Codex records it)", () => {
    trustStamp(home);
    expect(codexStampActive({ home })).toBe(true);
  });

  it("AFTER: with the stamp, the same new chat gets its OWN identity, and its tool calls land on that same agent", async () => {
    expect(nameIn(await hookSays("codex-chat-C"))).toBeUndefined();
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "codex");
    proxies.push(p);
    await p.initialize();
    await p.callTool("set_status", stamped("codex-chat-C", { task: "chat C at work" }));
    const said = await hookSays("codex-chat-C");
    const nameC = nameIn(said);
    expect(nameC, said).toBeTruthy();
    const rows = await liveSessions(hub.url, operatorKey, deviceId);
    expect(rows.find((r) => r.agentName === nameC)?.currentTask).toBe("chat C at work");
  });

  it("two chats are two agents: a second new chat gets a DIFFERENT agent, and each call lands on its own", async () => {
    const nameC = nameIn(await hookSays("codex-chat-C"));
    expect(nameIn(await hookSays("codex-chat-D"))).toBeUndefined();
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "codex");
    proxies.push(p);
    await p.initialize();
    await p.callTool("set_status", stamped("codex-chat-D", { task: "chat D at work" }));
    const nameD = nameIn(await hookSays("codex-chat-D"));
    expect(nameD).toBeTruthy();
    expect(nameD).not.toBe(nameC);
    const rows = await liveSessions(hub.url, operatorKey, deviceId);
    expect(rows.find((r) => r.agentName === nameD)?.currentTask).toBe("chat D at work");
    expect(rows.find((r) => r.agentName === nameC)?.currentTask).toBe("chat C at work");
  });
});
