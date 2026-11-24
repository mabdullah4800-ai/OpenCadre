import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { askClarification, createOrganization, getMessages, registerAgent, sendMessage } from "../src/service.js";
import { projectHeaders } from "../scripts/opencadre-config.mjs";
import { nodeStartupMs, SPAWN_TEST_TIMEOUT_MS, waitFor } from "./helpers/spawn.js";
import { startFetchRecorder } from "./helpers/fetch-recorder.js";

// Every test here starts the wake script as a child process, so every describe uses the spawn timeout.

const WAKE = path.join(process.cwd(), "scripts", "opencadre-wake.mjs");

let server: http.Server;
let baseUrl: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function setup(name: string) {
  const { orgId } = createOrganization(name);
  const me = registerAgent(orgId, "Sleeper");
  const peer = registerAgent(orgId, "Waker");
  const env = { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: me.apiKey, OPENCADRE_WAIT_SECONDS: "1", OPENCADRE_WAKE_STATE_DIR: mkdtempSync(path.join(tmpdir(), "wake-")) };
  return { orgId, me, peer: { id: peer.agentId, name: "Waker" }, env };
}

/** The safety kill for a run that must exit on its own. The tests check that it exits (or how long its own work took),
 * not that it beats a wall clock, so this only has to outlast a busy machine: starting Node alone can take seconds. */
const EXITS_WITHIN_MS = 15_000;

/** Runs the wake script; resolves when it exits or after killAfterMs (exited=false). */
function runWake(env: Record<string, string>, killAfterMs: number) {
  return new Promise<{ exited: boolean; code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [WAKE], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => { child.kill(); resolve({ exited: false, code: null, out }); }, killAfterMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ exited: true, code, out }); });
  });
}

describe("opencadre-wake.mjs", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("stays silent while idle, then exits with one line when real mail arrives", async () => {
    const { orgId, peer, env } = setup("Wake Arrive Org");
    const running = runWake(env, EXITS_WITHIN_MS);
    await new Promise((r) => setTimeout(r, 1500));
    await sendMessage(orgId, peer, "Sleeper", "review PR 51 please");
    const { exited, code, out } = await running;
    expect(exited).toBe(true);
    expect(code).toBe(0);
    expect(out).toMatch(/^OPENCADRE WAKE: 1 new message/m);
    expect(out).toContain("review PR 51 please");
  });

  // The wake latency is the agent's reply latency, so the exit must follow the output promptly
  // (and cleanly: an early process.exit tripped a libuv assertion on Windows).
  it("exits promptly and cleanly once the wake line is printed", async () => {
    const { orgId, peer, env } = setup("Wake Prompt Org");
    await sendMessage(orgId, peer, "Sleeper", "already waiting");
    const start = Date.now();
    const [{ exited, code }, startup] = await Promise.all([runWake(env, EXITS_WITHIN_MS), nodeStartupMs()]);
    expect(exited).toBe(true);
    expect(code).toBe(0);
    // Node's own startup (a bare node started alongside) doesn't count: ~0.1 s idle, seconds on a busy machine.
    expect(Date.now() - start - startup).toBeLessThan(2000);
  });

  it("never wakes for low priority or pure acknowledgements, and leaves all mail unread", async () => {
    const { orgId, me, peer, env } = setup("Wake Filter Org");
    await sendMessage(orgId, peer, "Sleeper", "fyi, background note", "low");
    await sendMessage(orgId, peer, "Sleeper", "thanks");
    const quiet = await runWake(env, 2500);
    expect(quiet).toEqual({ exited: false, code: null, out: "" });

    await sendMessage(orgId, peer, "Sleeper", "prod is down", "high");
    const { exited, out } = await runWake(env, EXITS_WITHIN_MS);
    expect(exited).toBe(true);
    expect(out).toContain("prod is down");
    expect(out).not.toContain("background note");
    expect(getMessages(orgId, me.agentId, undefined, { peek: true })).toHaveLength(3);
  });

  it("does not wake twice for the same mail after being relaunched", async () => {
    const { orgId, peer, env } = setup("Wake Once Org");
    await sendMessage(orgId, peer, "Sleeper", "handle me once");
    expect((await runWake(env, EXITS_WITHIN_MS)).exited).toBe(true);
    expect(await runWake(env, 2500)).toEqual({ exited: false, code: null, out: "" });
  });

  it("exits loudly instead of dying silently when the hub stays unreachable", async () => {
    const { env } = setup("Wake Down Org");
    const { exited, code, out } = await runWake({ ...env, OPENCADRE_URL: "http://127.0.0.1:1", OPENCADRE_WAKE_MAX_FAILURES: "2", OPENCADRE_WAKE_RETRY_MS: "50" }, EXITS_WITHIN_MS);
    expect(exited).toBe(true);
    expect(code).toBe(1);
    expect(out).toMatch(/^OPENCADRE WAKE ERROR/m);
  });
});

/** Like runWake, with CLI args and stderr captured separately. */
function runRewake(env: Record<string, string>, killAfterMs: number, args = ["--rewake"]) {
  return new Promise<{ exited: boolean; code: number | null; out: string; err: string; ms: number }>((resolve) => {
    const start = Date.now();
    // CLAUDE_CODE_SESSION_ATTENDED pinned to "attended" so a run of this suite from an unattended Claude (`claude -p`)
    // measures the same watcher as one from a terminal; the unattended case sets it itself.
    const child = spawn(process.execPath, [WAKE, ...args], { env: { ...process.env, CLAUDE_CODE_SESSION_ATTENDED: "1", OPENCADRE_HOOK_HOME: mkdtempSync(path.join(tmpdir(), "wake-home-")), ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { child.kill(); resolve({ exited: false, code: null, out, err, ms: Date.now() - start }); }, killAfterMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ exited: true, code, out, err, ms: Date.now() - start }); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lockFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".lock"));
const lockPathFor = (env: { OPENCADRE_KEY: string; OPENCADRE_WAKE_STATE_DIR: string }) =>
  path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-${createHash("sha256").update(env.OPENCADRE_KEY).digest("hex").slice(0, 16)}.lock`);

// Claude Code runs the wake as a Stop hook with asyncRewake: exit 2 wakes the idle session
// and stderr becomes the system reminder.
describe("opencadre-wake.mjs --rewake (Claude Code asyncRewake)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("exits 2 with the wake text on stderr when real mail arrives", async () => {
    const { orgId, peer, env } = setup("Rewake Arrive Org");
    const running = runRewake(env, EXITS_WITHIN_MS);
    await sleep(1500);
    await sendMessage(orgId, peer, "Sleeper", "review PR 70 please");
    const { exited, code, err } = await running;
    expect(exited).toBe(true);
    expect(code).toBe(2);
    expect(err).toMatch(/^OPENCADRE WAKE: 1 new message/m);
    expect(err).toContain("get_messages");
    expect(err).toContain("review PR 70 please");
    expect(err).not.toContain("relaunch");
  });

  it("leaves at once, silently, in an UNATTENDED Claude run (claude -p), where it would hold the run open forever", async () => {
    // Measured on claude 2.1.277: with this watcher long-polling a live hub, a `claude -p` turn never exited; claude
    // sets CLAUDE_CODE_SESSION_ATTENDED=0 there. The mail is already waiting, so an attended watcher (the control
    // below, same env but that one variable) wakes on it; the unattended one must not even wait.
    const { orgId, peer, env } = setup("Rewake Unattended Org");
    await sendMessage(orgId, peer, "Sleeper", "mail for a headless run");
    const unattended = await runRewake({ ...env, CLAUDE_CODE_SESSION_ATTENDED: "0" }, EXITS_WITHIN_MS);
    expect(unattended).toMatchObject({ exited: true, code: 0, out: "", err: "" });
    expect(unattended.ms).toBeLessThan(5000);
    const attended = await runRewake(env, EXITS_WITHIN_MS);
    expect(attended).toMatchObject({ exited: true, code: 2 });
    expect(attended.err).toContain("mail for a headless run");
  });

  it("never wakes for low priority or pure acknowledgements", async () => {
    const { orgId, peer, env } = setup("Rewake Filter Org");
    await sendMessage(orgId, peer, "Sleeper", "fyi, background note", "low");
    await sendMessage(orgId, peer, "Sleeper", "thanks");
    expect(await runRewake(env, 2500)).toMatchObject({ exited: false, out: "", err: "" });
  });

  // Exit 2 is the wake signal, used only for delivered mail (review of #694): an outage is reported once a day per seat
  // and hub as a non-fatal hook error (exit 1), and a later run that day leaves silently (exit 0), so a long outage does
  // not wake an idle agent at every turn end. tests/wake-owner.test.ts has the cursor, Codex and class controls.
  it("an unreachable hub is reported once with exit 1 (never the exit-2 wake), then silently the same day", async () => {
    const { env } = setup("Rewake Down Org");
    const down = { ...env, OPENCADRE_URL: "http://127.0.0.1:1", OPENCADRE_WAKE_MAX_FAILURES: "2", OPENCADRE_WAKE_RETRY_MS: "50" };
    const { exited, code, err } = await runRewake(down, EXITS_WITHIN_MS);
    expect(exited).toBe(true);
    expect(code).toBe(1);
    expect(err).toMatch(/^OPENCADRE WAKE ERROR: hub unreachable/m);
    expect(await runRewake(down, EXITS_WITHIN_MS)).toMatchObject({ exited: true, code: 0, err: "" });
  });

  // Hooks must never nag sessions that aren't set up for OpenCadre.
  it("exits 0 silently when no hub is configured", async () => {
    const { env } = setup("Rewake Unconfigured Org");
    expect(await runRewake({ ...env, OPENCADRE_URL: "", OPENCADRE_KEY: "" }, EXITS_WITHIN_MS)).toMatchObject({ exited: true, code: 0, out: "", err: "" });
  });

  it("--client claude-code resolves the key from ~/.claude.json", async () => {
    const { orgId, me, peer, env } = setup("Rewake Claude Config Org");
    const home = mkdtempSync(path.join(tmpdir(), "wake-claude-"));
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { opencadre: { type: "http", url: `${baseUrl}/mcp`, headers: { Authorization: `Bearer ${me.apiKey}` } } } }));
    await sendMessage(orgId, peer, "Sleeper", "found you via claude config");
    const { code, err } = await runRewake({ ...env, OPENCADRE_URL: "", OPENCADRE_KEY: "", OPENCADRE_HOOK_HOME: home }, EXITS_WITHIN_MS, ["--rewake", "--client", "claude-code"]);
    expect(code).toBe(2);
    expect(err).toContain("found you via claude config");
  });

  it("does not print the key", async () => {
    const { orgId, me, peer, env } = setup("Rewake No Key Org");
    await sendMessage(orgId, peer, "Sleeper", "hello");
    const { out, err } = await runRewake(env, EXITS_WITHIN_MS);
    expect(out + err).not.toContain(me.apiKey);
  });
});

// Every Stop spawns another background watcher, so without a lock N idle watchers would wake Claude N times.
describe("opencadre-wake.mjs single-watcher lock", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("a second watcher exits 0 at once while the first waits, and the first still wakes", async () => {
    const { orgId, peer, env } = setup("Lock Second Org");
    const first = runRewake(env, 20_000);
    await waitFor(() => existsSync(lockPathFor(env)), "the first watcher to take the lock");
    const [second, startup] = await Promise.all([runRewake(env, EXITS_WITHIN_MS), nodeStartupMs()]);
    expect(second).toMatchObject({ exited: true, code: 0, out: "", err: "" });
    // "At once" is the script's own time: a bare node started alongside takes Node's startup out of it.
    expect(second.ms - startup).toBeLessThan(2000);

    await sendMessage(orgId, peer, "Sleeper", "only one wake please");
    const { code, err } = await first;
    expect(code).toBe(2);
    expect(err).toContain("only one wake please");
    expect(lockFiles(env.OPENCADRE_WAKE_STATE_DIR)).toHaveLength(0);
  });

  it("takes over a stale lock left by a dead process", async () => {
    const { orgId, peer, env } = setup("Lock Stale Org");
    const lockPath = lockPathFor(env);
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, startedAt: Date.now() }));

    await sendMessage(orgId, peer, "Sleeper", "stale lock mail");
    const { code, err } = await runRewake(env, EXITS_WITHIN_MS);
    expect(code).toBe(2);
    expect(err).toContain("stale lock mail");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("takes over a lock whose owner stopped heartbeating (pid reused by another process)", async () => {
    const { orgId, peer, env } = setup("Lock Heartbeat Org");
    const lockPath = lockPathFor(env);
    // This test runner is alive, so only the old heartbeat marks the lock stale.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 0 }));
    const old = new Date(Date.now() - 3600_000);
    utimesSync(lockPath, old, old);

    await sendMessage(orgId, peer, "Sleeper", "heartbeat mail");
    const { code, err } = await runRewake(env, EXITS_WITHIN_MS);
    expect(code).toBe(2);
    expect(err).toContain("heartbeat mail");
  });

  it("also applies to one-shot mode and releases the lock on exit", async () => {
    const { orgId, peer, env } = setup("Lock OneShot Org");
    await sendMessage(orgId, peer, "Sleeper", "one-shot mail");
    const { code, out } = await runRewake(env, EXITS_WITHIN_MS, []);
    expect(code).toBe(0);
    expect(out).toContain("one-shot mail");
    expect(lockFiles(env.OPENCADRE_WAKE_STATE_DIR)).toHaveLength(0);
  });

  it("a watcher that finds its lock taken over while suspended exits 0 without moving the cursor", async () => {
    const { orgId, peer, env } = setup("Lock Takeover Org");
    const lockPath = lockPathFor(env);
    const cursorPath = path.join(env.OPENCADRE_WAKE_STATE_DIR, `${path.basename(lockPath, ".lock")}.json`);

    // A first pass wakes on one mail, which writes a cursor: the test needs a cursor to exist, or
    // "unmoved" and "never written" would look the same at the end.
    await sendMessage(orgId, peer, "Sleeper", "first mail");
    expect((await runRewake(env, EXITS_WITHIN_MS)).code).toBe(2);
    const cursorAfterFirst = JSON.parse(readFileSync(cursorPath, "utf8"));

    // The watcher takes the lock, then the lock is overwritten with a foreign live pid: this is what
    // a takeover looks like to a watcher suspended between polls (ownsLock compares the lock's token, which this foreign lock does not carry).
    const running = runRewake(env, EXITS_WITHIN_MS);
    await waitFor(() => existsSync(lockPath), "the watcher to take the lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    // Mail arrives while this watcher no longer owns the lock. It must leave it for the successor.
    await sendMessage(orgId, peer, "Sleeper", "mail the successor must keep");
    const { exited, code, out, err } = await running;
    expect(exited).toBe(true);
    expect(code).toBe(0);
    expect(out).not.toContain("mail the successor must keep");
    expect(err).not.toContain("mail the successor must keep");

    // The cursor is the load-bearing assertion: an unmoved cursor is what leaves the mail for the
    // successor. If it had advanced, the successor would never see this mail.
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toEqual(cursorAfterFirst);
  });

  // Reversed in review of #694 (Olive, b9875de2): an unwritable state dir used to degrade to a lock-less watcher that
  // still woke, so two concurrent hooks both delivered the same mail. Now there is no seat without a lock: nothing is
  // delivered, and the broken folder is reported (once a day per seat) with exit 1, a non-fatal hook error that is not
  // the wake signal. tests/wake-owner.test.ts has the concurrent and injected-error controls.
  it("an unwritable state dir delivers nothing, reports the folder once on stderr, and exits 1 (never the exit-2 wake)", async () => {
    const { orgId, peer, env } = setup("Lock Unwritable Org");
    // A file where the state dir should be: mkdir fails with EEXIST (swallowed) and every write inside
    // fails with ENOENT, which is not EEXIST: no lock can be had here.
    // This is the portable way to express "cannot write here" without depending on file permissions.
    env.OPENCADRE_WAKE_STATE_DIR = mkdtempSync(path.join(tmpdir(), "wake-blocked-"));
    const blocked = path.join(env.OPENCADRE_WAKE_STATE_DIR, "not-a-dir");
    writeFileSync(blocked, "a file, standing where the state dir would go");
    env.OPENCADRE_WAKE_STATE_DIR = blocked;

    await sendMessage(orgId, peer, "Sleeper", "mail despite an unwritable state dir");
    const { exited, code, err } = await runRewake(env, EXITS_WITHIN_MS);
    expect(exited).toBe(true);
    expect(code).toBe(1);
    expect(err).toMatch(/^OPENCADRE WAKE ERROR: this agent's wake state in .* cannot be used/);
    expect(err).not.toContain("mail despite an unwritable state dir");
    // Reported once: the next Stop's watcher defers silently.
    const again = await runRewake(env, EXITS_WITHIN_MS);
    expect(again).toMatchObject({ exited: true, code: 0, err: "" });
  });
});

// A device credential serves every session on the machine, so each session's watcher needs its own inbox and lock.
describe("opencadre-wake.mjs --rewake on a connected machine (per-session identity)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  async function connectedMachine(name: string) {
    const { orgId } = createOrganization(name);
    const operatorKey = registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey;
    const auth = { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" };
    const { code } = await (await fetch(`${baseUrl}/v1/org/devices`, { method: "POST", headers: auth, body: JSON.stringify({ name: "PC", client: "claude-code" }) })).json();
    const { deviceCredential } = await (await fetch(`${baseUrl}/v1/connect/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).json();
    const home = mkdtempSync(path.join(tmpdir(), "wake-device-"));
    mkdirSync(path.join(home, ".opencadre"));
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ devices: { "claude-code": { hub: baseUrl, credential: deviceCredential } } }));
    const stateDir = mkdtempSync(path.join(tmpdir(), "wake-device-state-"));
    // The watcher runs in this checkout (the hook's cwd): its project is enabled unless a test turns it off.
    const project = projectHeaders(process.cwd());
    const setProject = async (enabled: boolean) =>
      expect((await fetch(`${baseUrl}/v1/org/projects`, { method: "PUT", headers: auth, body: JSON.stringify({ projectKey: project["x-opencadre-project"], enabled }) })).status).toBe(200);
    await setProject(true);
    const join = async (sessionId: string) => ((await (await fetch(`${baseUrl}/v1/sessions/join`, {
      method: "POST", headers: { authorization: `Bearer ${deviceCredential}`, "x-opencadre-session": sessionId, ...project },
    })).json()) as { agentName: string }).agentName;
    return { orgId, home, stateDir, deviceCredential, join, setProject, peer: { id: registerAgent(orgId, "Waker").agentId, name: "Waker" } };
  }

  /** The Stop hook as Claude Code runs it: hook JSON on stdin, no session env. Killed (exited=false) after killAfterMs,
   * or as soon as `stop` resolves. */
  function runStopHook(m: { home: string; stateDir: string }, sessionId: string, killAfterMs: number, stop?: Promise<unknown>) {
    return new Promise<{ exited: boolean; code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, [WAKE, "--rewake", "--client", "claude-code"], {
        env: { ...process.env, OPENCADRE_URL: "", OPENCADRE_KEY: "", CLAUDE_CODE_SESSION_ID: "", CLAUDE_CODE_HOST_SESSION_ID: "", OPENCADRE_HOOK_HOME: m.home, OPENCADRE_WAKE_STATE_DIR: m.stateDir, OPENCADRE_WAIT_SECONDS: "1" },
      });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, cwd: process.cwd() }));
      const kill = () => { child.kill(); resolve({ exited: false, code: null, err }); };
      const timer = setTimeout(kill, killAfterMs);
      void stop?.then(kill);
      child.on("exit", (code) => { clearTimeout(timer); resolve({ exited: true, code, err }); });
    });
  }

  it("wakes only the session the mail is for, with one lock per session", async () => {
    const m = await connectedMachine("Rewake Device Org");
    const one = await m.join("wake-session-1");
    await m.join("wake-session-2");
    const watcher1 = runStopHook(m, "wake-session-1", 20_000);
    // Session two's watcher keeps polling until two of its 1 s polls after session one woke.
    const watcher2 = runStopHook(m, "wake-session-2", 20_000, watcher1.then(() => sleep(2000)));
    // Two watchers for one credential run side by side: the lock is per session, not per credential.
    await waitFor(() => lockFiles(m.stateDir).length === 2, "both watchers to take their own lock");
    await sendMessage(m.orgId, m.peer, one, "for session one only");
    const [r1, r2] = await Promise.all([watcher1, watcher2]);
    expect(r1).toMatchObject({ exited: true, code: 2 });
    expect(r1.err).toContain("for session one only");
    expect(r2).toMatchObject({ exited: false, err: "" });
    expect(r1.err + r2.err).not.toContain(m.deviceCredential);
  });

  it("stays silent without a session id: no identity is guessed", async () => {
    const m = await connectedMachine("Rewake Device No Session Org");
    expect(await runStopHook(m, "", EXITS_WITHIN_MS)).toMatchObject({ exited: true, code: 0, err: "" });
  });

  it("a session the hub has never seen (a helper process): exits 0 silently at once and creates no agent", async () => {
    const m = await connectedMachine("Rewake Device Helper Org");
    const r = await runStopHook(m, "helper-never-joined", EXITS_WITHIN_MS);
    expect(r).toMatchObject({ exited: true, code: 0, err: "" });
    expect(lockFiles(m.stateDir)).toHaveLength(0);
    const { db } = await import("../src/db.js");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE org_id = (SELECT id FROM organizations WHERE name = ?) AND kind = 'session'`).get("Rewake Device Helper Org")).toEqual({ n: 0 });
  });

  it("a session whose project the workspace turned off: exits 0 silently at once, even with mail waiting", async () => {
    const m = await connectedMachine("Rewake Device Project Off Org");
    const name = await m.join("wake-off-session");
    await sendMessage(m.orgId, m.peer, name, "mail that must not wake anyone");
    await m.setProject(false);
    const r = await runStopHook(m, "wake-off-session", EXITS_WITHIN_MS);
    expect(r).toMatchObject({ exited: true, code: 0, err: "" });
    expect(lockFiles(m.stateDir)).toHaveLength(0);
  });
});

// WAKE-LAYER.md section 7: a persisted per-seat cooldown that COALESCES. Measured motivation (lane 9,
// n=213): one wake re-reads a median 497k tokens because it lands on a session that has been running
// for hours, and the cost sits in per-wake context size, not wake count. So the cooldown's job is to
// turn N wakes into one wake carrying all N messages, not merely to space them apart.
describe("opencadre-wake.mjs cooldown (coalescing)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const cursorOf = (dir: string) => {
    // The cursor is `wake-<hash>.json`. Match it exactly rather than counting `.json` files: a
    // concurrent watcher or a leftover temp file would otherwise make this return null and turn a
    // real assertion into an unreadable one.
    const files = readdirSync(dir).filter((f) => /^wake-[0-9a-f]{16}\.json$/.test(f));
    return files.length === 1 ? JSON.parse(readFileSync(path.join(dir, files[0]), "utf8")) : null;
  };

  it("two real mails inside the cooldown give ONE wake listing both, and the cursor does not advance until it fires", async () => {
    const { orgId, peer, env } = setup("Cooldown Coalesce Org");
    // Short enough that the hold expires inside this test's window, long enough that both mails land
    // inside it. The behavior under test is the hold-and-coalesce, not the 120 s default's duration.
    const cooled = { ...env, OPENCADRE_WAKE_COOLDOWN_SECONDS: "6" };

    // A first wake sets lastWakeAt, which is what starts the cooldown.
    const first = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "first real mail");
    expect((await first).code).toBe(2);
    const cursorAfterFirst = cursorOf(env.OPENCADRE_WAKE_STATE_DIR);
    expect(typeof cursorAfterFirst.lastWakeAt).toBe("number");

    // Two more mails, 1 s apart, both inside the cooldown. The second watcher must HOLD, not wake.
    const holding = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "second real mail");
    await sleep(1000);
    await sendMessage(orgId, peer, "Sleeper", "third real mail");

    // While holding, the cursor must NOT move: that is what leaves the mail for the wake that coalesces.
    await sleep(1500);
    expect(cursorOf(env.OPENCADRE_WAKE_STATE_DIR)).toEqual(cursorAfterFirst);

    // The hold ends when the cooldown does, with one wake carrying BOTH held messages.
    const { exited, code, err } = await holding;
    expect(exited).toBe(true);
    expect(code).toBe(2);
    expect(err).toContain("second real mail");
    expect(err).toContain("third real mail");
  });

  it("a high priority mail ends the hold at once", async () => {
    const { orgId, peer, env } = setup("Cooldown High Org");
    const cooled = { ...env, OPENCADRE_WAKE_COOLDOWN_SECONDS: "120" };

    const first = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "the mail that sets the cooldown");
    expect((await first).code).toBe(2);

    const holding = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "prod is down", "high");
    const { exited, code, err } = await holding;
    expect(exited).toBe(true);
    expect(code).toBe(2);
    expect(err).toContain("prod is down");
  });

  it("a watcher killed during a hold leaves the cursor unmoved, and its successor wakes for the held mail", async () => {
    const { orgId, peer, env } = setup("Cooldown Killed Org");
    // A long cooldown on purpose: the watcher must still be holding when it is killed. That is the
    // guarantee under test — dying mid-hold loses nothing, because the cursor never moved past the mail.
    const cooled = { ...env, OPENCADRE_WAKE_COOLDOWN_SECONDS: "120" };

    const first = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "sets the cooldown");
    expect((await first).code).toBe(2);
    const cursorAfterFirst = cursorOf(env.OPENCADRE_WAKE_STATE_DIR);

    // Hold, then kill the watcher mid-hold.
    const holding = runRewake(cooled, 4_000);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "held while the watcher dies");
    await sleep(1500);
    const killedMidHold = await holding;
    expect(killedMidHold.exited).toBe(false); // killed by the test, still holding
    // The load-bearing assertion: the cursor did not move, so the mail is still unread behind it.
    expect(cursorOf(env.OPENCADRE_WAKE_STATE_DIR)).toEqual(cursorAfterFirst);

    // A successor is a fresh watcher: with the cooldown now long past, it wakes for the held mail.
    const successor = runRewake({ ...cooled, OPENCADRE_WAKE_COOLDOWN_SECONDS: "0" }, EXITS_WITHIN_MS);
    const { exited, code, err } = await successor;
    expect(exited).toBe(true);
    expect(code).toBe(2);
    expect(err).toContain("held while the watcher dies");
  });

  it("cooldown 0 restores today's behavior: every real mail wakes at once", async () => {
    const { orgId, peer, env } = setup("Cooldown Off Org");
    const off = { ...env, OPENCADRE_WAKE_COOLDOWN_SECONDS: "0" };

    const first = runRewake(off, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "one");
    expect((await first).code).toBe(2);

    const second = runRewake(off, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "two");
    const { code, err } = await second;
    expect(code).toBe(2);
    expect(err).toContain("two");
    // One wake per mail, no coalescing delay.
    expect(err).not.toContain("one");
  });

  it("a low-priority mail during a hold does NOT advance the cursor past the held mail", async () => {
    // 9d1f's finding. The empty-real branch advanced afterId and saved the cursor without checking
    // whether anything was held, so a low/ack poll landing during a hold moved the saved cursor PAST
    // the held mail. A watcher killed after that loses the held mail permanently -- which is exactly
    // the guarantee the hold is supposed to give.
    const { orgId, peer, env } = setup("Cooldown Held Low Org");
    const cooled = { ...env, OPENCADRE_WAKE_COOLDOWN_SECONDS: "120" };

    const first = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "sets the cooldown");
    expect((await first).code).toBe(2);
    const cursorAfterFirst = cursorOf(env.OPENCADRE_WAKE_STATE_DIR);

    // Long enough to still be holding across all three sends below; the test kills it deliberately.
    const holding = runRewake(cooled, 12_000);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "held real mail");
    await sleep(1500);
    // A low-priority mail arrives during the hold: it must not drag the cursor past the held mail.
    await sendMessage(orgId, peer, "Sleeper", "fyi, background note", "low");
    await sleep(1500);
    const killedMidHold = await holding;
    expect(killedMidHold.exited).toBe(false); // still holding when the test killed it
    expect(cursorOf(env.OPENCADRE_WAKE_STATE_DIR)).toEqual(cursorAfterFirst);

    // The successor must still see the held mail. With the cursor advanced past it, it would not.
    const successor = runRewake({ ...cooled, OPENCADRE_WAKE_COOLDOWN_SECONDS: "0" }, EXITS_WITHIN_MS);
    const { code, err } = await successor;
    expect(code).toBe(2);
    expect(err).toContain("held real mail");
  });

  it("a question awaiting a reply ends the hold at once, like high priority", async () => {
    // 9d1f's second finding, and the sprint's own words: "a question still wakes promptly". A message
    // with awaiting_reply is addressed work, not ping-pong, so the cooldown must not sit on it.
    const { orgId, peer, env } = setup("Cooldown Question Org");
    const cooled = { ...env, OPENCADRE_WAKE_COOLDOWN_SECONDS: "120" };

    const first = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "sets the cooldown");
    expect((await first).code).toBe(2);

    const holding = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    // A real question, medium priority, awaiting a reply. askClarification blocks until its timeout,
    // so it is fired without awaiting: the row is inserted immediately, which is all the watcher sees.
    void askClarification(orgId, peer, "Sleeper", "which branch should I merge?", 30);
    const { exited, code, err } = await holding;
    expect(exited).toBe(true);
    expect(code).toBe(2);
    expect(err).toContain("which branch should I merge?");
  });
});

// The hold is released by a check that runs only when a long-poll RETURNS. With a fixed poll timeout and no further
// mail, release landed up to one whole poll (50 s by default) after the cooldown ended: measured 2026-10-09, cooldown
// end 23:18:06.4, wake 23:18:47.8. These tests put a recorder in front of the hub so the timeout each poll asked for
// is visible, and use a poll (20 s) far longer than the cooldown (6 s), so a release that waits for the poll is
// unmistakable.
describe("opencadre-wake.mjs cooldown releases on the clock", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const POLL = 20;
  const COOLDOWN = 6;
  let recorder: Awaited<ReturnType<typeof startFetchRecorder>>;
  let recorderUrl: string;
  const polls: { key: string; at: number; timeoutSeconds: number }[] = [];
  beforeAll(async () => {
    recorder = await startFetchRecorder((req, res) => {
      if (req.url?.startsWith("/v1/messages/wait")) {
        const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        polls.push({ key, at: Date.now(), timeoutSeconds: Number(new URL(req.url, "http://hub").searchParams.get("timeoutSeconds")) });
      }
      app(req, res);
    });
    recorderUrl = recorder.url;
  });
  afterAll(() => recorder?.close());

  const cursorOf = (dir: string) => {
    const files = readdirSync(dir).filter((f) => /^wake-[0-9a-f]{16}\.json$/.test(f));
    return files.length === 1 ? JSON.parse(readFileSync(path.join(dir, files[0]), "utf8")) : null;
  };
  const lastWakeAtOf = (dir: string) => Number(cursorOf(dir)?.lastWakeAt);
  const pollsOf = (key: string) => polls.filter((p) => p.key === key);
  /** A first wake through the recorder, which sets lastWakeAt and so starts the cooldown. */
  async function wokenOnce(name: string) {
    const { orgId, me, peer, env } = setup(name);
    const cooled = { ...env, OPENCADRE_URL: recorderUrl, OPENCADRE_WAIT_SECONDS: String(POLL), OPENCADRE_WAKE_COOLDOWN_SECONDS: String(COOLDOWN) };
    const first = runRewake(cooled, EXITS_WITHIN_MS);
    await waitFor(() => polls.some((p) => p.key === me.apiKey), "the first watcher's first poll");
    await sendMessage(orgId, peer, "Sleeper", "sets the cooldown");
    expect((await first).code).toBe(2);
    const lastWakeAt = lastWakeAtOf(env.OPENCADRE_WAKE_STATE_DIR);
    expect(Number.isFinite(lastWakeAt)).toBe(true);
    return { orgId, me, peer, env: cooled, cooled, lastWakeAt };
  }

  it("held mail wakes as soon as the cooldown ends, with no further mail, not at the next poll boundary", async () => {
    const { orgId, me, peer, env, cooled, lastWakeAt } = await wokenOnce("Hold Clock Org");
    const cursorAfterFirst = cursorOf(env.OPENCADRE_WAKE_STATE_DIR);
    // Killed well before the 20 s poll would return: a watcher that waits for the poll fails here as "never exited".
    const holding = runRewake(cooled, 14_000);
    const before = pollsOf(me.apiKey).length;
    await waitFor(() => pollsOf(me.apiKey).length > before, "the holding watcher's first poll");
    const sentAt = Date.now();
    await sendMessage(orgId, peer, "Sleeper", "held until the clock runs out");
    // Arrived inside the cooldown, so it is HELD, not woken for at once.
    expect(sentAt).toBeLessThan(lastWakeAt + COOLDOWN * 1000);
    // The shorter polls do not touch the cursor-safety guarantee: while holding, the saved cursor stays behind the mail.
    await waitFor(() => pollsOf(me.apiKey).some((p) => p.at > sentAt), "a poll while holding");
    const cursorWhileHolding = cursorOf(env.OPENCADRE_WAKE_STATE_DIR);
    expect(Date.now()).toBeLessThan(lastWakeAt + COOLDOWN * 1000); // read inside the hold, or the check below is moot
    expect(cursorWhileHolding).toEqual(cursorAfterFirst);
    const { exited, code, err } = await holding;
    const wokeAt = Date.now();
    expect(exited).toBe(true);
    expect(code).toBe(2);
    expect(err).toContain("held until the clock runs out");
    // Not early (the hold was honoured) and not late: within 2.5 s of the cooldown's end, against a 20 s poll.
    expect(wokeAt).toBeGreaterThanOrEqual(lastWakeAt + COOLDOWN * 1000 - 250);
    expect(wokeAt - (lastWakeAt + COOLDOWN * 1000)).toBeLessThan(2_500);
  });

  it("while mail is held, each poll asks the hub for no longer than the cooldown has left", async () => {
    const { orgId, me, peer, cooled, lastWakeAt } = await wokenOnce("Hold Poll Org");
    const holding = runRewake(cooled, 14_000);
    const before = pollsOf(me.apiKey).length;
    await waitFor(() => pollsOf(me.apiKey).length > before, "the holding watcher's first poll");
    const sentAt = Date.now();
    await sendMessage(orgId, peer, "Sleeper", "held mail");
    // The watcher itself must have exited with a wake: runRewake also resolves when its kill timer fires.
    const { exited, code } = await holding;
    expect(exited).toBe(true);
    expect(code).toBe(2);
    // Every poll that began after the held mail arrived began while it was held.
    const whileHolding = pollsOf(me.apiKey).filter((p) => p.at > sentAt);
    expect(whileHolding.length).toBeGreaterThan(0);
    for (const p of whileHolding) {
      expect(Number.isInteger(p.timeoutSeconds)).toBe(true);
      expect(p.timeoutSeconds).toBeGreaterThanOrEqual(1);
      expect(p.timeoutSeconds).toBeLessThan(POLL);
      // +1: the watcher reads its clock a moment before the hub records the request.
      expect(p.timeoutSeconds).toBeLessThanOrEqual(Math.ceil((lastWakeAt + COOLDOWN * 1000 - p.at) / 1000) + 1);
    }
  });

  it("mail held with under a second of cooldown left polls for 1 s (never 0 or negative) and still wakes on the clock", async () => {
    const { orgId, me, peer, cooled, lastWakeAt } = await wokenOnce("Hold Boundary Org");
    const end = lastWakeAt + COOLDOWN * 1000;
    const holding = runRewake(cooled, 14_000);
    const before = pollsOf(me.apiKey).length;
    await waitFor(() => pollsOf(me.apiKey).length > before, "the holding watcher's first poll");
    // Sent ~0.9 s before the cooldown ends, so the watcher classifies it with a positive sub-second remainder and
    // must ask for exactly 1 s (ceil, floor 1). The 1 s poll is REQUIRED below: a schedule that crossed the end before
    // classifying would skip the shortened branch and leave the floor unexercised, so it must fail, not pass.
    await waitFor(() => Date.now() >= end - 900, "the last 0.9 s of the cooldown", COOLDOWN * 1000 + 2_000);
    const sentAt = Date.now();
    expect(sentAt).toBeLessThan(end);
    await sendMessage(orgId, peer, "Sleeper", "held at the boundary");
    const { exited, code, err } = await holding;
    const wokeAt = Date.now();
    expect(exited).toBe(true);
    expect(code).toBe(2);
    expect(err).toContain("held at the boundary");
    expect(wokeAt - end).toBeLessThan(2_500);
    const heldPolls = pollsOf(me.apiKey).filter((p) => p.at > sentAt && p.at < end);
    expect(heldPolls.map((p) => p.timeoutSeconds)).toContain(1);
    for (const p of pollsOf(me.apiKey)) {
      expect(Number.isInteger(p.timeoutSeconds)).toBe(true);
      expect(p.timeoutSeconds).toBeGreaterThanOrEqual(1);
      expect([1, POLL]).toContain(p.timeoutSeconds);
    }
  });

  it("with nothing held, every poll uses the full wait: inside the cooldown and after it has elapsed", async () => {
    const { orgId, me, peer, cooled, lastWakeAt } = await wokenOnce("Hold Idle Org");
    const end = lastWakeAt + COOLDOWN * 1000;
    const idle = runRewake(cooled, EXITS_WITHIN_MS);
    const before = pollsOf(me.apiKey).length;
    await waitFor(() => pollsOf(me.apiKey).length > before, "the idle watcher's first poll");
    // The idle watcher's first poll began inside the cooldown with nothing held. A low mail is not held either: the
    // watcher re-polls, still holding nothing, so that poll must ask for the full wait too.
    expect(pollsOf(me.apiKey).at(-1)!.at).toBeLessThan(end);
    await sendMessage(orgId, peer, "Sleeper", "fyi inside the cooldown", "low");
    await waitFor(() => pollsOf(me.apiKey).length > before + 1, "the poll after the first low mail");
    // The same once the cooldown is over: an elapsed cooldown with nothing held is not a reason to poll faster.
    await waitFor(() => Date.now() > end + 200, "the cooldown to end", COOLDOWN * 1000 + 2_000);
    await sendMessage(orgId, peer, "Sleeper", "fyi after the cooldown", "low");
    await waitFor(() => pollsOf(me.apiKey).length > before + 2, "the poll after the second low mail");
    expect(pollsOf(me.apiKey).at(-1)!.at).toBeGreaterThan(end);
    // Real mail after the cooldown wakes at once.
    await sendMessage(orgId, peer, "Sleeper", "after the cooldown");
    const { code, err } = await idle;
    expect(code).toBe(2);
    expect(err).toContain("after the cooldown");
    const mine = pollsOf(me.apiKey);
    expect(mine.length).toBeGreaterThanOrEqual(4);
    for (const p of mine) expect(p.timeoutSeconds).toBe(POLL);
  });

  it("cooldown 0 (off) never shortens a poll and never busy-polls", async () => {
    const { orgId, me, peer, env } = setup("Hold Off Org");
    const off = { ...env, OPENCADRE_URL: recorderUrl, OPENCADRE_WAIT_SECONDS: String(POLL), OPENCADRE_WAKE_COOLDOWN_SECONDS: "0" };
    const first = runRewake(off, EXITS_WITHIN_MS);
    await waitFor(() => pollsOf(me.apiKey).length > 0, "the first watcher's first poll");
    await sendMessage(orgId, peer, "Sleeper", "one");
    expect((await first).code).toBe(2);
    // Straight after a wake, with the cooldown off: an idle watcher, a low mail, then real mail that wakes at once.
    const second = runRewake(off, EXITS_WITHIN_MS);
    const before = pollsOf(me.apiKey).length;
    await waitFor(() => pollsOf(me.apiKey).length > before, "the second watcher's first poll");
    await sendMessage(orgId, peer, "Sleeper", "fyi", "low");
    await waitFor(() => pollsOf(me.apiKey).length > before + 1, "the poll after the low mail");
    await sendMessage(orgId, peer, "Sleeper", "two");
    const { code, err } = await second;
    expect(code).toBe(2);
    expect(err).toContain("two");
    const mine = pollsOf(me.apiKey);
    // Two polls for the first watcher, two or three for the second: a 1 s loop would add more, each asking for 1.
    expect(mine.length).toBeLessThanOrEqual(5);
    for (const p of mine) expect(p.timeoutSeconds).toBe(POLL);
  });
});

// R6 (docs/planning/RELIABILITY_SPRINT.md) asks for "idle cost per agent-hour per client". The cost
// half was already measured (one wake re-reads a median 497k tokens, lane 9, n=213); the RATE half had
// no artefact at all, because the cursor file keeps only the LAST wake and overwrites it every time.
// That is the difference between an unmeasured number and an unmeasurable one: no file on any client
// held a count. These tests pin the record that makes the rate readable.
describe("opencadre-wake.mjs wake history (R6 wakes per agent-hour)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const historyOf = (dir: string) => {
    const files = readdirSync(dir).filter((f) => /^wake-history-[0-9a-f]{16}\.jsonl$/.test(f));
    if (files.length !== 1) return null;
    const raw = readFileSync(path.join(dir, files[0]), "utf8");
    return { raw, lines: raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
  };

  it("a wake appends exactly one parseable line, and the line holds no key material", async () => {
    const { orgId, peer, env } = setup("Wake History Org");
    const off = { ...env, OPENCADRE_WAKE_COOLDOWN_SECONDS: "0" };

    const running = runRewake(off, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "one real mail");
    expect((await running).code).toBe(2);

    const history = historyOf(env.OPENCADRE_WAKE_STATE_DIR);
    expect(history).not.toBeNull();
    expect(history!.lines).toHaveLength(1);
    expect(history!.lines[0]).toMatchObject({ n: 1, urgent: false });
    // A readable instant, not merely a number: the rate is lines per hour, so `t` has to be a time.
    expect(Number.isNaN(Date.parse(history!.lines[0].t))).toBe(false);
    // The fleet's first rule is that a key never reaches a file. A cursor file names the seat by HASH
    // for exactly this reason, and the history file sits beside it and must hold to the same rule.
    expect(history!.raw).not.toContain(env.OPENCADRE_KEY);
  });

  it("a coalesced wake records the count it carried, so the rate and the coalescing are both readable", async () => {
    // This is the R6 assertion: the number on disk has to be WAKES, not messages. Two mails inside one
    // cooldown are one wake carrying two messages, and the history must say 1 line with n=2 -- a log
    // that counted messages would report twice the wake rate the operator is billed for.
    const { orgId, peer, env } = setup("Wake History Coalesce Org");
    const cooled = { ...env, OPENCADRE_WAKE_COOLDOWN_SECONDS: "6" };

    const first = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "first real mail");
    expect((await first).code).toBe(2);

    const holding = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "second real mail");
    await sleep(1000);
    await sendMessage(orgId, peer, "Sleeper", "third real mail");
    expect((await holding).code).toBe(2);

    const history = historyOf(env.OPENCADRE_WAKE_STATE_DIR);
    expect(history!.lines).toHaveLength(2);
    expect(history!.lines.map((l) => l.n)).toEqual([1, 2]);
    // A clock-released hold is not an urgent one; `urgent` false is what says the cooldown coalesced
    // by waiting rather than being bypassed.
    expect(history!.lines[1]).toMatchObject({ n: 2, urgent: false });
  });

  it("an urgent wake is marked distinct from a clock-released one", async () => {
    const { orgId, peer, env } = setup("Wake History Urgent Org");
    const cooled = { ...env, OPENCADRE_WAKE_COOLDOWN_SECONDS: "120" };

    const first = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "sets the cooldown");
    expect((await first).code).toBe(2);

    const holding = runRewake(cooled, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "prod is down", "high");
    expect((await holding).code).toBe(2);

    const history = historyOf(env.OPENCADRE_WAKE_STATE_DIR);
    expect(history!.lines).toHaveLength(2);
    // Without this flag the log could not answer whether the 120 s cooldown is doing anything: a seat
    // woken every time a question arrives looks identical to one woken by the clock.
    expect(history!.lines[1]).toMatchObject({ n: 1, urgent: true });
  });

  it("an oversized history is trimmed to the RECENT window, and the wake that trims it survives", async () => {
    // The cap is the only path that DROPS recorded wakes, so it is the one worth a test. Two ways to
    // get it wrong, and a test that cannot tell them apart is not worth the spawn: a trim that kept the
    // OLDEST lines would delete the week you are asking about and keep a stale one, and a trim that
    // lost the current line would make the rate wrong at exactly the moment it matters.
    //
    // The seed has to cross BOTH caps to be a seed at all. 5000 short lines is ~275 KB, so a file can
    // be over the line cap and under the byte cap -- and a file of long lines can be the reverse. Only
    // a seed past both says the trim is size-gated AND that what it keeps is bounded by lines.
    const { orgId, peer, env } = setup("Wake History Trim Org");
    const off = { ...env, OPENCADRE_WAKE_COOLDOWN_SECONDS: "0" };
    const dir = env.OPENCADRE_WAKE_STATE_DIR;

    const seeded = runRewake(off, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "the seeding wake");
    expect((await seeded).code).toBe(2);

    // Seed a real history past the byte cap, then let a real wake run against it. 9600 lines of this
    // exact shape is 528000 bytes > 512 KB, and the 5000 the trim keeps is 275 KB < 512 KB -- so
    // "the file is under the cap afterwards" is a real claim here and not an accident of the seed.
    const file = path.join(dir, readdirSync(dir).find((f) => /^wake-history-[0-9a-f]{16}\.jsonl$/.test(f))!);
    const seeds = Array.from({ length: 9600 }, (_, i) => JSON.stringify({ t: "2026-09-01T00:00:00.000Z", n: 99, urgent: false, i }));
    writeFileSync(file, `${seeds.join("\n")}\n`);

    const running = runRewake(off, EXITS_WITHIN_MS);
    await sleep(1200);
    await sendMessage(orgId, peer, "Sleeper", "the wake that trims");
    expect((await running).code).toBe(2);

    const raw = readFileSync(file);
    const parsed = raw.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const kept = parsed.filter((l) => l.n === 99);

    // The wake that triggered the trim is the last line, not a casualty of it.
    expect(parsed.at(-1)).toMatchObject({ n: 1, urgent: false });
    // Bounded in both senses. A line-only cap would leave a long-line file permanently over the size
    // gate, rewriting itself on every single wake -- the cost the gate exists to avoid.
    expect(kept).toHaveLength(5000);
    expect(raw.length).toBeLessThan(512 * 1024);
    // Recent, not oldest: the head of the seed is gone and the tail of it survived.
    expect(kept.some((l) => l.i === 0)).toBe(false);
    expect(kept.at(-1).i).toBe(9599);
  });

  it("every wake goes through the one recorder", async () => {
    // The regression this guards: a fifth wake site added later that moves the cooldown clock and
    // forgets the history would leave the R6 rate silently low, and nothing else would notice, because
    // the log is only ever read by a human asking a question. The clock move and the record are one
    // function so they cannot drift -- `lastWakeAt = Date.now()` is that function's body, exactly once.
    const src = readFileSync(WAKE, "utf8");
    const clockMoves = src.match(/lastWakeAt = Date\.now\(\)/g) ?? [];
    expect(clockMoves).toHaveLength(1);
    const recorder = src.slice(src.indexOf("const recordWake"));
    expect(recorder.slice(0, recorder.indexOf("};"))).toContain("lastWakeAt = Date.now()");
    expect(recorder.slice(0, recorder.indexOf("};"))).toContain("recordHistory(");
    // And the record is genuinely per-seat, hashed, not the key itself.
    expect(src).toMatch(/wake-history-\$\{keyHash\}\.jsonl/);
  });
});
