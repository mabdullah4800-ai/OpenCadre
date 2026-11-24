// A session's wake watcher is not its chat (a87c4910). Its long-poll is transport, so it must neither keep the session
// alive (x-opencadre-probe: no-heartbeat) nor bring it back once the idle sweep has ended it (resolve-only). Before the
// fix an orphaned watcher beat its session on every poll, so presence read online and the 12 h TTL never fired; and a
// watcher whose identity is an OWN SEAT (a stamped Codex thread, an Antigravity conversation) polled with resolveHub's
// CREATE headers, so an ended session came back, or a never-proven one was minted, on its next poll. A real chat call
// (the MCP proxy) may still revive its own chat-proven session.
//
// Every test here fails on the watcher before the fix unless it is marked CONTROL; each says why.
import { spawn, type ChildProcess } from "node:child_process";
import type http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintStamp, projectHeaders, RESOLVE_ONLY_HEADER, resolveHub, STAMP_FIELD } from "../scripts/opencadre-config.mjs";
import { refusalCounts } from "../src/connector-health.js";
import { db } from "../src/db.js";
import { sweepIdleSessions } from "../src/devices.js";
import { heldRequestCount } from "../src/revocation.js";
import { createOrganization, getMessages, registerAgent, sendMessage, waitForMessage } from "../src/service.js";
import { childEnv, enableProject, gitProject, mintDevice, operatorWorkspace, ProxyProcess, startHub, tempDir } from "./helpers/device-hub.js";
import { startFetchRecorder } from "./helpers/fetch-recorder.js";
import { waitFor } from "./helpers/spawn.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const WAKE = path.join(process.cwd(), "scripts", "opencadre-wake.mjs");
const PROXY = path.join(process.cwd(), "scripts", "opencadre-mcp.mjs");
const THREAD = "5a6b7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const CONVERSATION = "agy-conversation-7f3e2a10";
const PROBE = "x-opencadre-probe";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Client = "claude-code" | "codex" | "antigravity";

// The fallback only: every test stops its own watchers in its own `finally` (stopOwn).
const started: ChildProcess[] = [];
const proxies: ProxyProcess[] = [];
afterAll(async () => {
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill();
  await Promise.all(proxies.map((p) => p.close()));
});

/** Codex's own record of trust for the stamp (PreToolUse group 0, handler 1), as tests/codex-session-stamp.test.ts writes it. */
function trustStamp(home: string) {
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  const hooksFile = path.join(home, ".codex", "hooks.json");
  const gate = { type: "command", command: `node "${path.join(home, ".opencadre", "bin", "opencadre-approval-gate.mjs")}" --client codex` };
  const stamp = { type: "command", command: `node "${path.join(home, ".opencadre", "bin", "opencadre-session-stamp.mjs")}"` };
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|mcp__opencadre_session__.*|mcp__opencadre__.*", hooks: [gate, stamp] }] } }));
  writeFileSync(path.join(home, ".codex", "config.toml"), `[hooks.state.'${hooksFile}:pre_tool_use:0:1']\ntrusted_hash = "sha256:test"\n`);
}

/** A home connected to `hub` with this computer's credential. A Codex home also runs (and trusts) the identity stamp; an
 * Antigravity home lists opencadre-session in Antigravity's MCP config, which is what makes stampActive true for it. */
function connectedHome(hub: string, credential: string, deviceId: string, client: Client) {
  const home = tempDir("oc-wake-live-home-");
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub, credential, deviceId } }));
  if (client === "codex") trustStamp(home);
  if (client === "antigravity") {
    mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: { "opencadre-session": { command: "node", args: ["opencadre-mcp.mjs"] } } }));
  }
  return home;
}
/** The child env: nothing of this run's own identity, and CODEX_HOME pinned to the test home. */
const envFor = (home: string, extra: Record<string, string> = {}) =>
  childEnv(home, { CODEX_HOME: path.join(home, ".codex"), OPENCADRE_WAKE_STATE_DIR: tempDir("oc-wake-live-state-"), ...extra });
const sessionIdFor = (client: Client) => (client === "codex" ? THREAD : client === "antigravity" ? CONVERSATION : "cc-header-chat");

type Run = { child: ChildProcess; done: Promise<{ code: number | null; err: string }> };
/** The watcher as it is launched: Claude Code's --rewake and Codex's --codex-queue Stop hooks (payload on stdin), an
 * Antigravity background task (ANTIGRAVITY_CONVERSATION_ID in `env`, no payload), or a named agent. Recorded in `own`,
 * the calling test's list, so the test can stop exactly its own watchers. */
function startWatcher(own: Run[], client: Client | "named", env: Record<string, string>, cwd: string, sessionId?: string): Run {
  const args = client === "codex" ? ["--codex-queue", "--client", "codex"] : client === "claude-code" ? ["--rewake", "--client", "claude-code"] : [];
  const child = spawn(process.execPath, [WAKE, ...args], { env, cwd });
  started.push(child);
  let err = "";
  child.stdout!.on("data", () => {});
  child.stderr!.on("data", (d) => (err += d));
  const hook = client === "codex" || client === "claude-code";
  child.stdin!.end(hook ? JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, cwd, stop_hook_active: true }) : "");
  // 'close', not 'exit': it fires after the child's stdio has drained, so `err` is complete before the test moves on.
  const run: Run = { child, done: new Promise((resolve) => child.on("close", (code) => resolve({ code, err }))) };
  own.push(run);
  return run;
}
/** Ends a test's own watchers (and no one else's) and waits until each has exited. */
async function stopOwn(own: Run[]) {
  for (const { child } of own) if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(own.map((r) => r.done));
}
/** The run's result, or "still running" after `ms`. The timer is cleared as soon as the race settles. */
async function exitedWithin<T>(p: Promise<T>, ms = 20_000): Promise<T | "still running"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<"still running">((resolve) => { timer = setTimeout(() => resolve("still running"), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** A fake `codex` on an otherwise empty PATH: every `codex queue` appends one line (as tests/wake-owner.test.ts fakes it). */
function fakeCodex() {
  const dir = tempDir("oc-wake-live-codex-");
  const log = path.join(dir, "queue.log");
  const entry = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  if (process.platform === "win32") writeFileSync(path.join(dir, "codex.cmd"), "@echo off\r\n");
  else writeFileSync(path.join(dir, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, { mode: 0o755 });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
  return { dir, calls };
}

// Rows and the clock-free heartbeat checks, read straight from the hub's database (it runs in this process).
type Row = { id: string; name: string; seat_id: string | null; ended_at: string | null; last_heartbeat_at: string | null; liveness: string | null };
const rowsOf = (deviceId: string) =>
  db.prepare(`SELECT id, name, seat_id, ended_at, last_heartbeat_at, liveness FROM agents WHERE device_id = ? AND kind = 'session'`).all(deviceId) as Row[];
const rowOf = (id: string) => db.prepare(`SELECT id, name, seat_id, ended_at, last_heartbeat_at, liveness FROM agents WHERE id = ?`).get(id) as Row;
const backdate = (id: string, by: string) => {
  db.prepare(`UPDATE agents SET last_heartbeat_at = datetime('now', ?) WHERE id = ?`).run(by, id);
  return rowOf(id).last_heartbeat_at;
};
/** The hub's own count of no_session refusals on this computer's credential: proof that an exit 0 was that one. */
const noSessionRefusals = (deviceId: string) =>
  refusalCounts((db.prepare(`SELECT connector_refusals FROM devices WHERE id = ?`).get(deviceId) as { connector_refusals: string | null }).connector_refusals, Date.now()).no_session;

// --- The request itself, deterministically: a stand-in hub that records every wait and can refuse some ---------------

async function recordingHub() {
  const seen: Array<{ headers: http.IncomingHttpHeaders; status: number }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let failNext = 0;
  const recorder = await startFetchRecorder((req, res) => {
    if (!req.url?.startsWith("/v1/messages/wait")) return void res.writeHead(404).end();
    const status = failNext > 0 ? (failNext--, 503) : 200;
    seen.push({ headers: req.headers, status });
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status === 200 ? { messages: [] } : { error: "busy" }));
    }, 100);
    timers.add(timer);
  });
  return {
    url: recorder.url,
    seen,
    failNext: (n: number) => void (failNext = n),
    close: async () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      await recorder.close();
    },
  };
}

describe("the watcher's wait request", { timeout: 60_000 }, () => {
  let stand: Awaited<ReturnType<typeof recordingHub>>;
  beforeAll(async () => { stand = await recordingHub(); });
  afterAll(() => stand.close());

  // RED before the fix: the Claude Code watcher sent no probe header (it was already resolve-only); the stamped Codex and
  // the Antigravity watchers sent neither, because resolveHub gave their own seat the CREATE headers (the premise below).
  for (const client of ["claude-code", "codex", "antigravity"] as const) {
    it(`${client}: every wait (first, repeated, retried, and after a project switch) is no-heartbeat and resolve-only`, async () => {
      const own: Run[] = [];
      try {
        const project = gitProject("HeaderProj");
        const home = connectedHome(stand.url, `dev_${"a".repeat(48)}`, "dev-test", client);
        const sessionId = sessionIdFor(client);
        const env = envFor(home, { OPENCADRE_WAIT_SECONDS: "1", OPENCADRE_WAKE_RETRY_MS: "50", ...(client === "antigravity" ? { ANTIGRAVITY_CONVERSATION_ID: sessionId } : {}) });
        if (client !== "claude-code") {
          // Passive Codex is resolve-only; Antigravity keeps its existing own-seat creation headers.
          expect(resolveHub({ client, home, env, sessionId, cwd: project }).headers[RESOLVE_ONLY_HEADER]).toBe(client === "codex" ? "1" : undefined);
        }
        const from = stand.seen.length;
        stand.failNext(2);
        startWatcher(own, client, env, project, sessionId);
        await waitFor(() => stand.seen.slice(from).filter((s) => s.status === 200).length >= 3, "three answered waits after two refused");
        // The chat's folder moves to another project: the watcher re-resolves its identity, and the new one must say the same.
        writeFileSync(path.join(project, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/acme/header-two.git\n`);
        const moved = () => stand.seen.slice(from).filter((s) => s.headers["x-opencadre-project"] === "github.com/acme/header-two");
        await waitFor(() => moved().length >= 2, "two waits as the new project's identity");
        await stopOwn(own);
        const waits = stand.seen.slice(from);
        expect(waits.filter((s) => s.status === 503)).toHaveLength(2);
        expect(waits[0].headers["x-opencadre-project"], "the first identity was the folder's, before the switch").toBe("local:headerproj");
        for (const { headers } of waits) {
          expect(headers["x-opencadre-session"]).toBe(sessionId);
          expect(headers[PROBE]).toBe("no-heartbeat");
          expect(headers[RESOLVE_ONLY_HEADER]).toBe("1");
          // An own seat never adopts another chat's live session: forcing resolve-only adds no adoption.
          if (client !== "claude-code") expect(headers["x-opencadre-adopt-live"]).toBeUndefined();
        }
      } finally {
        await stopOwn(own);
      }
    });
  }

  // CONTROL (green before and after): a named agent is not a session, and its requests are unchanged.
  it("a named agent key sends neither header", async () => {
    const own: Run[] = [];
    try {
      const project = gitProject("NamedProj");
      const env = envFor(tempDir("oc-wake-live-named-"), { OPENCADRE_URL: stand.url, OPENCADRE_KEY: "test-key", OPENCADRE_WAIT_SECONDS: "1" });
      const from = stand.seen.length;
      startWatcher(own, "named", env, project);
      await waitFor(() => stand.seen.length - from >= 3, "three waits");
      await stopOwn(own);
      for (const { headers } of stand.seen.slice(from)) {
        expect(headers["x-opencadre-session"]).toBeUndefined();
        expect(headers[PROBE]).toBeUndefined();
        expect(headers[RESOLVE_ONLY_HEADER]).toBeUndefined();
      }
    } finally {
      await stopOwn(own);
    }
  });
});

// --- The hold's own minute beat, on vitest's clock (no 60 s wait) -----------------------------------------------------

// CONTROL pair at the hub (the watcher is not involved): the interval inside a held wait is the beat a test with real
// timers never reaches. In-process only, no child processes, and its own describe so the fake clock cannot leak.
//
// heartbeat() writes SQLite's datetime('now'), which no fake JS clock moves. So the row is set to a fixed OLD marker AFTER
// the hold's entry beat (waitForMessage runs synchronously up to its first await), and the fake clock only has to make
// the production setInterval fire: beat:true must replace the marker (the known positive for the interval itself, not
// the entry beat), beat:false must leave it.
describe("a held wait's minute beat (fake timers)", () => {
  const OLD = "2000-01-01 00:00:00";
  afterEach(() => { vi.useRealTimers(); });

  for (const beat of [false, true]) {
    it(`beat:${beat}: ${beat ? "the interval replaces" : "the interval never touches"} an old last_heartbeat_at once the hold passes a minute`, async () => {
      const { orgId } = createOrganization(`Hold Beat ${beat}`);
      const { agentId } = registerAgent(orgId, "Holder");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      const held = waitForMessage(orgId, agentId, 120, { peek: true, beat });
      try {
        db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(OLD, agentId);
        await vi.advanceTimersByTimeAsync(61_000);
        if (beat) expect(rowOf(agentId).last_heartbeat_at).not.toBe(OLD);
        else expect(rowOf(agentId).last_heartbeat_at).toBe(OLD);
      } finally {
        // Settle the hold on the fake clock (past its 120 s timeout, which also clears its interval), then restore.
        await vi.advanceTimersByTimeAsync(120_000);
        vi.useRealTimers();
      }
      expect(await held).toEqual([]);
    });
  }
});

// --- Against a real hub in this process, with the idle sweep driven directly (no 12 h wait) --------------------------

describe("against a real hub: the watcher keeps no session alive and revives none", { timeout: 90_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  beforeAll(async () => { hub = await startHub(); });
  afterAll(() => hub.close());

  let n = 0;
  async function machine(client: Client) {
    const { orgId, operatorKey } = await operatorWorkspace(`Wake Liveness ${client} ${++n}`);
    const project = gitProject("WakeLive");
    await enableProject(hub.url, operatorKey, "local:wakelive");
    const { deviceId, code } = await mintDevice(hub.url, operatorKey, client);
    const redeemed = await fetch(`${hub.url}/v1/connect/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const { deviceCredential: credential } = (await redeemed.json()) as { deviceCredential: string };
    const home = connectedHome(hub.url, credential, deviceId, client);
    const peer = { id: registerAgent(orgId, "Peer").agentId, name: "Peer" };
    return { orgId, project, deviceId, credential, home, peer };
  }
  /** The stamped chat's own row (its seat is the thread id). */
  const chatRow = (deviceId: string) => rowsOf(deviceId).find((r) => r.seat_id === THREAD)!;
  /** Nothing new, revived or re-seated: the device holds exactly the rows it held, and none of them is live. */
  const nothingLive = (deviceId: string, count: number) => {
    expect(rowsOf(deviceId)).toHaveLength(count);
    expect(rowsOf(deviceId).filter((r) => r.ended_at === null)).toEqual([]);
  };
  /** The Codex chat itself: the MCP proxy making one stamped tool call (chat-proven), as Codex drives it. */
  async function codexChatCall(m: Awaited<ReturnType<typeof machine>>, proxy?: ProxyProcess) {
    const p = proxy ?? new ProxyProcess(PROXY, envFor(m.home), m.project, "codex");
    if (!proxy) {
      proxies.push(p);
      expect((await p.initialize()).error).toBeUndefined();
    }
    await p.callTool("set_status", { task: "working", [STAMP_FIELD]: mintStamp(m.credential, THREAD) });
    return p;
  }

  // RED before the fix at the first heartbeat assertion: the wait beat the session on entry. The other halves are
  // compatibility checks (a live own seat is still FOUND resolve-only, and mail still queues a turn) and a CONTROL (the
  // chat's own call keeps the session).
  it("a live stamped Codex chat: found by its resolve-only wait, never beaten by it, kept by its own call, and woken for mail", async () => {
    const own: Run[] = [];
    try {
      const m = await machine("codex");
      const proxy = await codexChatCall(m);
      const chat = chatRow(m.deviceId);
      expect(chat).toMatchObject({ ended_at: null, liveness: "chat" });
      const count = rowsOf(m.deviceId).length;
      const beat = backdate(chat.id, "-10 minutes");
      const codex = fakeCodex();
      const watcher = startWatcher(own, "codex", envFor(m.home, { PATH: codex.dir, OPENCADRE_WAIT_SECONDS: "1", OPENCADRE_WAKE_COOLDOWN_SECONDS: "0" }), m.project, THREAD);
      await waitFor(() => heldRequestCount(chat.id) > 0, "the watcher's wait to be held as this chat");
      expect(rowOf(chat.id).last_heartbeat_at, "the wait's entry").toBe(beat);
      await sleep(2500);
      await waitFor(() => heldRequestCount(chat.id) > 0, "a later wait");
      expect(rowOf(chat.id).last_heartbeat_at, "later polls and their holds").toBe(beat);

      // CONTROL: the chat's own call is liveness. A session the sweep would end is kept by it.
      backdate(chat.id, "-13 hours");
      await codexChatCall(m, proxy);
      expect(sweepIdleSessions().ended).not.toContain(chat.id);
      expect(rowOf(chat.id).ended_at).toBeNull();

      await sendMessage(m.orgId, m.peer, chat.name, "please review");
      expect(await exitedWithin(watcher.done)).toMatchObject({ code: 0 });
      expect(codex.calls()).toHaveLength(1);
      expect(codex.calls()[0].slice(0, 3)).toEqual(["queue", "--thread", THREAD]);
      expect(rowsOf(m.deviceId)).toHaveLength(count);
    } finally {
      await stopOwn(own);
    }
  });

  // RED before the fix: each poll beat the session, so the sweep found it fresh and ended nothing.
  it("Claude Code: an orphaned watcher's session is reaped while it polls, and the watcher leaves without a revival", async () => {
    const own: Run[] = [];
    try {
      const m = await machine("claude-code");
      const joined = await fetch(`${hub.url}/v1/sessions/join`, {
        method: "POST", headers: { authorization: `Bearer ${m.credential}`, "x-opencadre-session": "cc-orphan", "x-opencadre-client": "claude-code", ...projectHeaders(m.project) },
      });
      const { agentId } = (await joined.json()) as { agentId: string };
      const stale = backdate(agentId, "-13 hours");
      const refused = noSessionRefusals(m.deviceId);
      const watcher = startWatcher(own, "claude-code", envFor(m.home, { OPENCADRE_WAIT_SECONDS: "1" }), m.project, "cc-orphan");
      await waitFor(() => heldRequestCount(agentId) > 0, "the watcher's wait to be held");
      await sleep(1500);
      await waitFor(() => heldRequestCount(agentId) > 0, "a later wait");
      expect(rowOf(agentId).last_heartbeat_at).toBe(stale);
      expect(sweepIdleSessions().ended).toContain(agentId);
      const ended = rowOf(agentId).ended_at;
      expect(await exitedWithin(watcher.done)).toEqual({ code: 0, err: "" });
      expect(noSessionRefusals(m.deviceId), "it left on the hub's no_session answer").toBeGreaterThan(refused);
      expect(rowOf(agentId)).toMatchObject({ ended_at: ended, seat_id: "cc-orphan" });
      nothingLive(m.deviceId, 1);
    } finally {
      await stopOwn(own);
    }
  });

  // RED before the fix, twice over: the held wait beat the session on entry (so the sweep ended nothing), and had it
  // ended, the next own-seat poll carried create headers and revived it.
  it("stamped Codex: an expiry that lands DURING a held wait ends the session; the watcher's next poll exits 0 and revives nothing", async () => {
    const own: Run[] = [];
    try {
      const m = await machine("codex");
      await (await codexChatCall(m)).close();
      const chat = chatRow(m.deviceId);
      const count = rowsOf(m.deviceId).length;
      backdate(chat.id, "-13 hours");
      const refused = noSessionRefusals(m.deviceId);
      const codex = fakeCodex();
      const watcher = startWatcher(own, "codex", envFor(m.home, { PATH: codex.dir, OPENCADRE_WAIT_SECONDS: "4" }), m.project, THREAD);
      await waitFor(() => heldRequestCount(chat.id) > 0, "the watcher's wait to be held");
      expect(heldRequestCount(chat.id), "the sweep runs inside the hold").toBeGreaterThan(0);
      expect(sweepIdleSessions().ended).toContain(chat.id);
      const ended = rowOf(chat.id).ended_at;
      expect(await exitedWithin(watcher.done)).toEqual({ code: 0, err: "" });
      expect(noSessionRefusals(m.deviceId), "it left on the hub's no_session answer").toBeGreaterThan(refused);
      expect(rowOf(chat.id)).toMatchObject({ ended_at: ended, seat_id: THREAD });
      nothingLive(m.deviceId, count);
      expect(codex.calls()).toHaveLength(0);
    } finally {
      await stopOwn(own);
    }
  });

  // RED before the fix: the own-seat poll revived the ended chat-proven row (ended_at back to NULL) and queued a turn.
  // Its tail is the CONTROL: the chat's own call still revives it as the same agent, with its inbox.
  it("stamped Codex: an ended session stays ended for its watcher; the reopened chat's real call revives it with its id, name and inbox", async () => {
    const own: Run[] = [];
    try {
      const m = await machine("codex");
      await (await codexChatCall(m)).close();
      const chat = chatRow(m.deviceId);
      const count = rowsOf(m.deviceId).length;
      await sendMessage(m.orgId, m.peer, chat.name, "sent before the chat went idle");
      backdate(chat.id, "-13 hours");
      expect(sweepIdleSessions().ended).toContain(chat.id);
      const ended = rowOf(chat.id).ended_at;
      const refused = noSessionRefusals(m.deviceId);
      const codex = fakeCodex();
      const env = envFor(m.home, { PATH: codex.dir, OPENCADRE_WAIT_SECONDS: "1", OPENCADRE_WAKE_COOLDOWN_SECONDS: "0" });
      expect(await exitedWithin(startWatcher(own, "codex", env, m.project, THREAD).done)).toEqual({ code: 0, err: "" });
      expect(noSessionRefusals(m.deviceId), "it left on the hub's no_session answer").toBeGreaterThan(refused);
      expect(rowOf(chat.id)).toMatchObject({ ended_at: ended, seat_id: THREAD });
      nothingLive(m.deviceId, count);
      expect(codex.calls()).toHaveLength(0);

      await codexChatCall(m);
      expect(rowOf(chat.id)).toMatchObject({ name: chat.name, ended_at: null, seat_id: THREAD });
      expect(rowsOf(m.deviceId)).toHaveLength(count);
      expect(getMessages(m.orgId, chat.id, undefined, { peek: true }).map((x) => x.body)).toContain("sent before the chat went idle");
      // Live again, so its next Stop's watcher finds it and queues the turn the mail is waiting for.
      expect(await exitedWithin(startWatcher(own, "codex", env, m.project, THREAD).done)).toMatchObject({ code: 0 });
      expect(codex.calls()).toHaveLength(1);
    } finally {
      await stopOwn(own);
    }
  });

  // RED before the fix: an own-seat watcher's first poll MINTED a session for a chat or conversation that had never made
  // an OpenCadre call, then kept polling it (so the watcher never exits within the bound, and a row exists).
  for (const client of ["codex", "antigravity"] as const) {
    it(`${client}: a never-proven ${client === "codex" ? "thread" : "conversation"} gets no_session; the watcher exits 0 and no row is created`, async () => {
      const own: Run[] = [];
      try {
        const m = await machine(client);
        const sessionId = sessionIdFor(client);
        const env = envFor(m.home, client === "codex"
          ? { PATH: fakeCodex().dir, OPENCADRE_WAIT_SECONDS: "1" }
          : { ANTIGRAVITY_CONVERSATION_ID: sessionId, OPENCADRE_WAIT_SECONDS: "1" });
        // Passive Codex already resolves only; Antigravity's watcher must add the guard.
        expect(resolveHub({ client, home: m.home, env, sessionId, cwd: m.project }).headers[RESOLVE_ONLY_HEADER]).toBe(client === "codex" ? "1" : undefined);
        expect(await exitedWithin(startWatcher(own, client, env, m.project, sessionId).done)).toEqual({ code: 0, err: "" });
        expect(noSessionRefusals(m.deviceId), "it left on the hub's no_session answer").toBeGreaterThan(0);
        expect(rowsOf(m.deviceId)).toEqual([]);
      } finally {
        await stopOwn(own);
      }
    });
  }
});
