// The wake watcher's ownership (PR-A of the premise plan, §3.F): who owns a seat's lock, cursor and cooldown, and when a
// --rewake watcher may leave because its chat is gone.
//
//   - OWNER CHECK: a Claude Code Stop hook's watcher delivers its wake only through its exit code and the stderr pipe the
//     launching process reads. When that process is gone, the pipe's read end is closed and a zero-byte write fails with
//     EPIPE: the watcher leaves by itself (measured on Windows: two orphans lived for days on 2026-10-01). While the
//     launcher lives the watcher stays, and the probe writes nothing a reader could see.
//   - TOKEN: the lock carries a nonce. A watcher owns the seat only while the lock holds its nonce, so a superseded one
//     can neither release its successor's lock nor write its successor's cursor, even when the successor's lock names
//     the same pid (a pid is not an identity).
//   - OVERLAP: an old-generation watcher (before nonces, the code at 12f6aedb) and a new one never both own one seat.
//   - CLAIM: every seat write and every delivery happens holding the seat's exclusive claim; a claim is recovered only
//     from a holder proven gone, by creating the next one, never by removing or rewriting a file another may hold.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent, sendMessage } from "../src/service.js";
import { HELPERS, installedText, installTransform } from "../cli/lib/helpers.mjs";
import { SPAWN_TEST_TIMEOUT_MS, waitFor } from "./helpers/spawn.js";

const WAKE = path.join(process.cwd(), "scripts", "opencadre-wake.mjs");
/** The last commit before lock tokens: the watcher an upgrade finds still running. */
const OLD_REF = "12f6aedb";

let server: http.Server;
let baseUrl: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const started: ChildProcess[] = [];
afterAll(() => {
  // Only processes this file started, by their own handles.
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill();
});

function setup(name: string) {
  const { orgId } = createOrganization(name);
  const me = registerAgent(orgId, "Sleeper");
  registerAgent(orgId, "Waker");
  const env = {
    OPENCADRE_URL: baseUrl,
    OPENCADRE_KEY: me.apiKey,
    OPENCADRE_WAIT_SECONDS: "1",
    OPENCADRE_WAKE_COOLDOWN_SECONDS: "0",
    OPENCADRE_WAKE_STATE_DIR: mkdtempSync(path.join(tmpdir(), "wake-owner-")),
    OPENCADRE_HOOK_HOME: mkdtempSync(path.join(tmpdir(), "wake-owner-home-")),
    CLAUDE_CODE_SESSION_ATTENDED: "1",
  };
  const hash = createHash("sha256").update(me.apiKey).digest("hex").slice(0, 16);
  return {
    orgId,
    peer: { id: registerAgent(orgId, "Peer").agentId, name: "Peer" },
    env,
    lockPath: path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-${hash}.lock`),
    cursorPath: path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-${hash}.json`),
  };
}

const readJson = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** The watcher has TAKEN its lock: the file exists AND parses. takeLock creates the file and then writes it (flag "wx"),
 * so existsSync alone can see it empty under load, and the read that follows gets null: a recurring full-suite flake
 * ("Cannot read properties of null (reading 'pid')"). The product itself treats an unparseable fresh lock as one being
 * written right now. */
const lockTaken = (file: string) => readJson(file) !== null;
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Run = { child: ChildProcess; done: Promise<{ code: number | null; out: string; err: string }> };
/** Starts a watcher (this checkout's, or `script`) as a Stop hook would: piped stdio, the hook payload on stdin. */
function startWatcher(env: Record<string, string>, script = WAKE): Run {
  const child = spawn(process.execPath, [script, "--rewake"], { env: { ...process.env, ...env } });
  started.push(child);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));
  child.stdin!.end("{}");
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => child.on("exit", (code) => resolve({ code, out, err })));
  return { child, done };
}

/** A stand-in for the chat process that runs the Stop hook: it starts the watcher with piped stdio, reads its stderr, and
 * reports the watcher's pid, then its exit code and stderr. Killing it closes the read ends, as a closed chat does.
 * `detached` keeps the watcher out of Node's kill-on-close job on Windows, so it outlives this stand-in exactly as the
 * measured orphans outlived their chats (without it, Windows kills the watcher with its parent and nothing is tested). */
const OWNER = `
const { spawn } = require("node:child_process");
const c = spawn(process.execPath, [process.env.WAKE_UNDER_TEST, "--rewake"], { stdio: ["pipe", "pipe", "pipe"], env: process.env, detached: true, windowsHide: true });
let err = "";
c.stderr.on("data", (d) => { err += d; });
c.stdout.on("data", () => {});
c.stdin.end("{}");
process.stdout.write(JSON.stringify({ watcher: c.pid }) + "\\n");
c.on("exit", (code) => { process.stdout.write(JSON.stringify({ exit: code, err }) + "\\n"); setTimeout(() => process.exit(0), 20); });
setInterval(() => {}, 1000);
`;
function startOwner(env: Record<string, string>) {
  const owner = spawn(process.execPath, ["-e", OWNER], { env: { ...process.env, ...env, WAKE_UNDER_TEST: WAKE }, stdio: ["ignore", "pipe", "inherit"] });
  started.push(owner);
  const lines: Array<Record<string, unknown>> = [];
  let buf = "";
  owner.stdout!.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  return { owner, lines };
}

describe("the owner check: a --rewake watcher whose chat is gone leaves by itself", { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  // Windows only: Linux returns 0 for a zero-byte write to a pipe with no reader, so there the check never fires and the
  // watcher keeps today's behaviour (the next test still holds there).
  it.runIf(process.platform === "win32")("exits within its check interval once the process that started it is gone, and releases its lock", async () => {
    const { env, lockPath } = setup("Owner Gone Org");
    const { owner, lines } = startOwner({ ...env, OPENCADRE_WAKE_OWNER_CHECK_MS: "200" });
    await waitFor(() => lines.length > 0 && lockTaken(lockPath), "the watcher to take its lock");
    const watcher = Number(lines[0].watcher);
    const lock = readJson(lockPath);
    expect(lock).toMatchObject({ pid: watcher, role: "opencadre-wake", ownerCheck: "stderr-pipe" });
    expect(isAlive(watcher)).toBe(true);
    owner.kill();
    try {
      await waitFor(() => !isAlive(watcher), "the orphaned watcher to exit by itself", 10_000);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      // Ours (this test's stand-in started it), identified by the token in the lock it still holds.
      if (isAlive(watcher) && readJson(lockPath)?.nonce === lock.nonce) process.kill(watcher);
    }
  });

  it("keeps running while the process that started it lives, and its probes put nothing on the wake channel", async () => {
    const { orgId, peer, env, lockPath } = setup("Owner Present Org");
    const { lines } = startOwner({ ...env, OPENCADRE_WAKE_OWNER_CHECK_MS: "100" });
    await waitFor(() => lines.length > 0 && lockTaken(lockPath), "the watcher to take its lock");
    const watcher = Number(lines[0].watcher);
    // Ten and more probes while the chat is idle.
    await sleep(1500);
    expect(isAlive(watcher)).toBe(true);
    await sendMessage(orgId, peer, "Sleeper", "still here, still woken");
    await waitFor(() => lines.length > 1, "the wake to reach the owner", 15_000);
    expect(lines[1].exit).toBe(2);
    // Exactly the wake text: a probe that wrote anything would show here.
    expect(String(lines[1].err)).toMatch(/^OPENCADRE WAKE: 1 new message/);
    expect(String(lines[1].err)).toContain("still here, still woken");
  });
});

describe("the lock token: a superseded watcher touches nothing of its successor's", { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  it("records its token and its own process start in the lock", async () => {
    const { env, lockPath } = setup("Token Record Org");
    const run = startWatcher(env);
    await waitFor(() => lockTaken(lockPath), "the watcher to take its lock");
    const lock = readJson(lockPath);
    expect(lock.pid).toBe(run.child.pid);
    expect(lock.nonce).toMatch(/^[0-9a-f]{24}$/);
    // The process incarnation, not the lock's wall time: it started before it wrote the lock.
    expect(lock.procStart).toBeLessThanOrEqual(lock.startedAt);
    expect(lock.startedAt - lock.procStart).toBeLessThan(60_000);
    run.child.kill();
    await run.done;
  });

  it("a stale-token release cannot clear the successor's lock, cursor or cooldown, even when the successor's lock names the same pid", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("Token Release Org");
    // A cursor and a cooldown clock that belong to the successor.
    const successorState = { afterId: "successor-cursor", lastWakeAt: 1234 };
    writeFileSync(cursorPath, JSON.stringify(successorState));
    const run = startWatcher(env);
    await waitFor(() => lockTaken(lockPath), "the watcher to take its lock");
    // A successor took the seat while this watcher was suspended. Its lock names the SAME pid with another token: a pid
    // match is not ownership.
    const successor = { pid: run.child.pid, nonce: "f".repeat(24), startedAt: Date.now(), procStart: Date.now(), role: "opencadre-wake", ownerCheck: "none" };
    writeFileSync(lockPath, JSON.stringify(successor));
    await sendMessage(orgId, peer, "Sleeper", "mail for the successor");
    const { code, out, err } = await run.done;
    expect(code).toBe(0);
    expect(out + err).not.toContain("mail for the successor");
    expect(readJson(lockPath)).toEqual(successor);
    expect(readJson(cursorPath)).toEqual(successorState);
  });

  // The window the heartbeat cannot cover: superseded AFTER its last heartbeat, while it decides what to do with a poll's
  // mail. A Codex queue watcher gives that window a fixed width: it waits up to 1 s for the awareness hook's handoff
  // before it classifies the mail. A hub this test controls answers, and the successor takes the seat 400 ms later.
  for (const [what, priority] of [["advance the cursor past", "low"], ["wake for", "medium"]] as const) {
    it(`superseded mid-decision, it does not ${what} the mail, and the successor's lock and cursor survive`, async () => {
      const thread = "0b2c7a51-3d4e-4f60-8a71-9c0d1e2f3a4b";
      const state = mkdtempSync(path.join(tmpdir(), "wake-owner-mid-"));
      const hash = createHash("sha256").update(`not-a-real-key\n${thread}`).digest("hex").slice(0, 16);
      const lockPath = path.join(state, `wake-${hash}.lock`);
      const cursorPath = path.join(state, `wake-${hash}.json`);
      let answered = 0;
      const hub = http.createServer((req, res) => {
        answered++;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ messages: [{ id: "m1", priority, awaiting_reply: false, body: "for the successor", from_agent_name: "Peer" }] }));
      });
      await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
      try {
        const port = (hub.address() as import("node:net").AddressInfo).port;
        // An empty PATH folder: no `codex` can be found, so a wake that should not happen cannot reach a real Codex.
        const child = spawn(process.execPath, [WAKE, "--codex-queue", "--client", "codex"], {
          env: { ...process.env, PATH: mkdtempSync(path.join(tmpdir(), "wake-owner-nopath-")), OPENCADRE_URL: `http://127.0.0.1:${port}`, OPENCADRE_KEY: "not-a-real-key", OPENCADRE_WAKE_STATE_DIR: state, OPENCADRE_AWARENESS_STATE_DIR: state, OPENCADRE_HOOK_HOME: mkdtempSync(path.join(tmpdir(), "wake-owner-home-")), OPENCADRE_WAIT_SECONDS: "1", OPENCADRE_WAKE_COOLDOWN_SECONDS: "0" },
        });
        started.push(child);
        let err = "";
        child.stderr!.on("data", (d) => (err += d));
        child.stdin!.end(JSON.stringify({ hook_event_name: "Stop", session_id: thread, cwd: state, stop_hook_active: false }));
        const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
        const successorState = { afterId: "successor-cursor", lastWakeAt: 1234 };
        writeFileSync(cursorPath, JSON.stringify(successorState));
        await waitFor(() => answered > 0, "the hub to answer the watcher's poll");
        await sleep(400);
        const successor = { pid: child.pid, nonce: "e".repeat(24), startedAt: Date.now(), procStart: Date.now(), role: "opencadre-wake", ownerCheck: "none" };
        writeFileSync(lockPath, JSON.stringify(successor));
        expect(await done).toBe(0);
        expect(err).toBe("");
        expect(readJson(lockPath)).toEqual(successor);
        expect(readJson(cursorPath)).toEqual(successorState);
      } finally {
        await new Promise<void>((done) => hub.close(() => done()));
      }
    });
  }
});

describe("old and new watchers during an upgrade: exactly one owns a seat", { timeout: SPAWN_TEST_TIMEOUT_MS * 3 }, () => {
  let oldWake: string;
  beforeAll(() => {
    // An installed copy of every helper, with the wake watcher as it was before tokens.
    const dir = mkdtempSync(path.join(tmpdir(), "wake-old-gen-"));
    for (const name of Object.keys(HELPERS)) {
      mkdirSync(path.dirname(path.join(dir, ...name.split("/"))), { recursive: true });
      writeFileSync(path.join(dir, ...name.split("/")), installedText(name));
    }
    oldWake = path.join(dir, "opencadre-wake.mjs");
    // The old commit is not in this repository, so the two tests that need the old watcher are skipped below.
    try {
      writeFileSync(oldWake, installTransform(execFileSync("git", ["show", `${OLD_REF}:scripts/opencadre-wake.mjs`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })));
    } catch {
      // no old watcher available
    }
  });

  // PUBLIC-SNAPSHOT SKIP: needs the watcher as it was at an old commit of the private pre-release history. See CONTRIBUTING.md, "Skipped tests".
  it.skip("an old watcher owns the seat: new ones arriving leave at once, the lock is untouched, and only the old one wakes", async () => {
    const { orgId, peer, env, lockPath } = setup("Overlap Old Owns Org");
    const old = startWatcher(env, oldWake);
    await waitFor(() => lockTaken(lockPath), "the old watcher to take its lock");
    const before = readFileSync(lockPath, "utf8");
    expect(JSON.parse(before).nonce).toBeUndefined();
    const arrivals = [startWatcher(env), startWatcher(env), startWatcher(env)];
    for (const a of arrivals) expect(await a.done).toEqual({ code: 0, out: "", err: "" });
    expect(readFileSync(lockPath, "utf8")).toBe(before);
    await sendMessage(orgId, peer, "Sleeper", "one wake from the old one");
    const woke = await old.done;
    expect(woke.code).toBe(2);
    expect(woke.err).toContain("one wake from the old one");
  });

  // PUBLIC-SNAPSHOT SKIP: needs the watcher as it was at an old commit of the private pre-release history. See CONTRIBUTING.md, "Skipped tests".
  it.skip("a new watcher owns the seat: old ones arriving leave at once, the lock is untouched, and only the new one wakes", async () => {
    const { orgId, peer, env, lockPath } = setup("Overlap New Owns Org");
    const fresh = startWatcher(env);
    await waitFor(() => lockTaken(lockPath), "the new watcher to take its lock");
    const before = readFileSync(lockPath, "utf8");
    expect(JSON.parse(before).nonce).toMatch(/^[0-9a-f]{24}$/);
    const arrivals = [startWatcher(env, oldWake), startWatcher(env, oldWake)];
    for (const a of arrivals) expect(await a.done).toEqual({ code: 0, out: "", err: "" });
    expect(readFileSync(lockPath, "utf8")).toBe(before);
    await sendMessage(orgId, peer, "Sleeper", "one wake from the new one");
    const woke = await fresh.done;
    expect(woke.code).toBe(2);
    expect(woke.err).toContain("one wake from the new one");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("new watchers racing over one stale lock: exactly one takes it", async () => {
    const { env, lockPath } = setup("Overlap Race Org");
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, startedAt: Date.now() }));
    const racers = [startWatcher(env), startWatcher(env), startWatcher(env), startWatcher(env)];
    await waitFor(() => readJson(lockPath)?.nonce !== undefined, "a racer to take the stale lock");
    // Every loser leaves at once; give them time, then exactly one is left, and it is the one the lock names.
    await sleep(4000);
    const running = racers.filter((r) => r.child.exitCode === null);
    expect(running).toHaveLength(1);
    expect(readJson(lockPath).pid).toBe(running[0].child.pid);
    running[0].child.kill();
    await running[0].done;
  });
});

// ---- the seat's claim: deterministic interleavings -------------------------------------------------------------------
//
// Every seat write and every delivery happens holding the seat's claim (wake-<hash>.claims/<n>, created exclusively). The
// races below are put at exact points through the watcher's test seam (OPENCADRE_WAKE_TEST_GATES): at a named point,
// while <gates>/<name>.hold exists, the watcher records <name>.reached and waits.

const claimsOf = (lockPath: string) => lockPath.replace(/\.lock$/, ".claims");
/** A claim as a watcher writes one. `holder` defaults to a LIVE holder: this test runner, with its real process start. */
function writeClaim(lockPath: string, n: number, holder: { nonce?: string; pid?: number; procStart?: number } = {}) {
  mkdirSync(claimsOf(lockPath), { recursive: true });
  const record = { nonce: holder.nonce ?? "c".repeat(24), pid: holder.pid ?? process.pid, procStart: holder.procStart ?? Math.round(Date.now() - process.uptime() * 1000) };
  writeFileSync(path.join(claimsOf(lockPath), String(n)), JSON.stringify(record));
  return JSON.stringify(record);
}
const releaseClaimFile = (lockPath: string, n: number) => writeFileSync(path.join(claimsOf(lockPath), `${n}.done`), "");
const claimFiles = (lockPath: string) => (existsSync(claimsOf(lockPath)) ? readdirSync(claimsOf(lockPath)).filter((f) => !f.startsWith(".tmp-")).sort() : []);

function gates() {
  const dir = mkdtempSync(path.join(tmpdir(), "wake-gates-"));
  return {
    dir,
    hold: (name: string) => writeFileSync(path.join(dir, `${name}.hold`), ""),
    reached: (name: string) => existsSync(path.join(dir, `${name}.reached`)),
    release: (name: string) => rmSync(path.join(dir, `${name}.hold`), { force: true }),
  };
}
/** Makes a lock look like its owner stopped heartbeating (suspended), so another watcher judges it stale. */
const ageLock = (lockPath: string) => {
  const old = new Date(Date.now() - 3600_000);
  utimesSync(lockPath, old, old);
};

/** A fake `codex` on an otherwise empty PATH: every `codex queue` appends one line to the returned log. */
function fakeCodex() {
  const dir = mkdtempSync(path.join(tmpdir(), "wake-codex-"));
  const log = path.join(dir, "queue.log");
  const entry = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  if (process.platform === "win32") writeFileSync(path.join(dir, "codex.cmd"), "@echo off\r\n");
  else writeFileSync(path.join(dir, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, { mode: 0o755 });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { dir, calls };
}
/** A Codex queue watcher for `thread` (its seat is the key and the thread). */
function startCodexWatcher(env: Record<string, string>, thread: string, pathDir: string): Run {
  const child = spawn(process.execPath, [WAKE, "--codex-queue", "--client", "codex"], { env: { ...process.env, ...env, PATH: pathDir } });
  started.push(child);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));
  // stop_hook_active: the handoff wait (stopDelivered) does not apply, so the poll goes straight to the decision.
  child.stdin!.end(JSON.stringify({ hook_event_name: "Stop", session_id: thread, cwd: env.OPENCADRE_WAKE_STATE_DIR, stop_hook_active: true }));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => child.on("exit", (code) => resolve({ code, out, err })));
  return { child, done };
}
const exitedWithin = <T,>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => "still running" as const)]);

describe("delivery happens as the seat's owner: no stale wake, no duplicate, no lost mail", { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  it("a takeover attempted during a Codex delivery (launcher resolution) cannot happen: exactly one queue, by the owner", async () => {
    const { orgId, peer, env } = setup("Deliver Codex Org");
    const thread = "4d6e8f00-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    const hash = createHash("sha256").update(`${env.OPENCADRE_KEY}\n${thread}`).digest("hex").slice(0, 16);
    const lockPath = path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-${hash}.lock`);
    const historyPath = path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-history-${hash}.jsonl`);
    const codex = fakeCodex();
    const g = gates();
    g.hold("deliver-codex");
    const owner = startCodexWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir }, thread, codex.dir);
    await waitFor(() => lockTaken(lockPath), "the owner to take its lock");
    await sendMessage(orgId, peer, "Sleeper", "queue this once");
    await waitFor(() => g.reached("deliver-codex"), "the owner to start delivering");
    // The owner looks suspended mid-delivery, and a successor arrives for the same seat.
    ageLock(lockPath);
    const before = readFileSync(lockPath, "utf8");
    const successor = startCodexWatcher(env, thread, codex.dir);
    expect(await exitedWithin(successor.done, 15_000)).toEqual({ code: 0, out: "", err: "" });
    expect(readFileSync(lockPath, "utf8")).toBe(before);
    expect(codex.calls()).toHaveLength(0);
    g.release("deliver-codex");
    expect((await owner.done).code).toBe(0);
    expect(codex.calls()).toHaveLength(1);
    expect(readFileSync(historyPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("an exit-2 wake: a successor arriving while the owner commits cannot take over, and only the owner wakes", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("Deliver Commit Org");
    const g = gates();
    g.hold("seat-owned");
    const owner = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir });
    await waitFor(() => lockTaken(lockPath), "the owner to take its lock");
    await sendMessage(orgId, peer, "Sleeper", "wake exactly once");
    await waitFor(() => g.reached("seat-owned"), "the owner to hold the seat for its wake");
    ageLock(lockPath);
    const before = readFileSync(lockPath, "utf8");
    const successor = startWatcher(env);
    expect(await exitedWithin(successor.done, 15_000)).toEqual({ code: 0, out: "", err: "" });
    expect(readFileSync(lockPath, "utf8")).toBe(before);
    expect(existsSync(cursorPath)).toBe(false);
    g.release("seat-owned");
    const woke = await owner.done;
    expect(woke.code).toBe(2);
    expect(woke.err).toContain("wake exactly once");
    // The cursor moved past the mail before the claim was let go: a later watcher will not wake for it again.
    expect(readJson(cursorPath).afterId).toBeTruthy();
    const after = startWatcher(env);
    expect(await exitedWithin(after.done, 3000)).toBe("still running");
    after.child.kill();
  });

  it("old owner vs successor: superseded before it takes the seat for its wake, it neither writes nor wakes; the successor keeps its lock, cursor and cooldown", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("Deliver Superseded Org");
    const g = gates();
    const owner = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir });
    await waitFor(() => lockTaken(lockPath), "the owner to take its lock");
    g.hold("seat-wanted");
    await sendMessage(orgId, peer, "Sleeper", "for whoever owns the seat");
    await waitFor(() => g.reached("seat-wanted"), "the owner to want the seat for its wake");
    // A successor took the seat meanwhile: its lock, its cursor and its cooldown clock.
    const successorLock = { pid: process.pid, nonce: "b".repeat(24), startedAt: Date.now(), procStart: Date.now(), role: "opencadre-wake", ownerCheck: "none" };
    writeFileSync(lockPath, JSON.stringify(successorLock));
    const successorState = { afterId: "successor-cursor", lastWakeAt: 4321 };
    writeFileSync(cursorPath, JSON.stringify(successorState));
    g.release("seat-wanted");
    expect(await exitedWithin(owner.done, 15_000)).toEqual({ code: 0, out: "", err: "" });
    expect(readJson(lockPath)).toEqual(successorLock);
    expect(readJson(cursorPath)).toEqual(successorState);
  });
});

describe("the seat's claim: recovered only from a holder proven gone, never by removing anything", { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  it("a claim held by a live holder is never reclaimed, however long it is held: the owner defers, keeps the mail, and wakes once it is released", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("Claim Live Holder Org");
    const owner = startWatcher({ ...env, OPENCADRE_WAKE_CLAIM_STALE_MS: "300" });
    await waitFor(() => lockTaken(lockPath), "the owner to take its lock");
    const holder = writeClaim(lockPath, 0);
    await sendMessage(orgId, peer, "Sleeper", "deliver after the holder");
    // Held ten times past the age threshold: a slow, valid holder is not an abandoned one.
    expect(await exitedWithin(owner.done, 3500)).toBe("still running");
    expect(readFileSync(path.join(claimsOf(lockPath), "0"), "utf8")).toBe(holder);
    expect(claimFiles(lockPath)).toEqual(["0"]);
    expect(existsSync(cursorPath)).toBe(false);
    releaseClaimFile(lockPath, 0);
    const woke = await owner.done;
    expect(woke.code).toBe(2);
    expect(woke.err).toContain("deliver after the holder");
  });

  it("a claim whose holder is proven gone is recovered by taking the NEXT number, and the owner wakes", async () => {
    const { orgId, peer, env, lockPath } = setup("Claim Dead Holder Org");
    const g = gates();
    const owner = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir });
    await waitFor(() => lockTaken(lockPath), "the owner to take its lock");
    const dead = writeClaim(lockPath, 0, { pid: 2147483646 });
    g.hold("seat-owned");
    await sendMessage(orgId, peer, "Sleeper", "after a dead holder");
    await waitFor(() => g.reached("seat-owned"), "the owner to recover the claim");
    // The abandoned claim was not removed or rewritten: recovery made the next one, which is the owner's.
    expect(readFileSync(path.join(claimsOf(lockPath), "0"), "utf8")).toBe(dead);
    expect(readJson(path.join(claimsOf(lockPath), "1")).nonce).toBe(readJson(lockPath).nonce);
    g.release("seat-owned");
    const woke = await owner.done;
    expect(woke.code).toBe(2);
    expect(woke.err).toContain("after a dead holder");
  });

  it("a claim whose holder pid is now another process (a later incarnation) is proven gone", async () => {
    const { orgId, peer, env, lockPath } = setup("Claim Reused Pid Org");
    const owner = startWatcher({ ...env, OPENCADRE_WAKE_CLAIM_STALE_MS: "300" });
    await waitFor(() => lockTaken(lockPath), "the owner to take its lock");
    // This runner's pid, but a holder that started an hour before this runner was created.
    writeClaim(lockPath, 0, { procStart: Math.round(Date.now() - process.uptime() * 1000) - 3600_000 });
    await sendMessage(orgId, peer, "Sleeper", "after a reused pid");
    const woke = await owner.done;
    expect(woke.code).toBe(2);
    expect(woke.err).toContain("after a reused pid");
  });

  it("stale-claim replacement: a successor's live claim made after the owner judged the old one abandoned is neither removed nor rewritten", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("Claim Replace Org");
    const g = gates();
    const owner = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir });
    await waitFor(() => lockTaken(lockPath), "the owner to take its lock");
    writeClaim(lockPath, 0, { pid: 2147483646 }); // abandoned: its holder is gone
    g.hold("claim-next");
    await sendMessage(orgId, peer, "Sleeper", "only after the successor lets go");
    await waitFor(() => g.reached("claim-next"), "the owner to judge the abandoned claim");
    // Between that judgement and its move, a successor recovered the same claim first: it holds claim 1, live.
    const successor = writeClaim(lockPath, 1, { nonce: "5".repeat(24) });
    g.release("claim-next");
    expect(await exitedWithin(owner.done, 2500)).toBe("still running");
    expect(readFileSync(path.join(claimsOf(lockPath), "1"), "utf8")).toBe(successor);
    expect(claimFiles(lockPath)).toEqual(["0", "1"]);
    expect(existsSync(cursorPath)).toBe(false);
    // The successor lets go; only then does the owner deliver, once.
    releaseClaimFile(lockPath, 1);
    const woke = await owner.done;
    expect(woke.code).toBe(2);
    expect(woke.err).toContain("only after the successor lets go");
  });

  it("a watcher finding the claim held by a live holder leaves the stale lock alone", async () => {
    const { env, lockPath } = setup("Claim Defer Org");
    const stale = JSON.stringify({ pid: 2147483646, startedAt: Date.now() });
    writeFileSync(lockPath, stale);
    writeClaim(lockPath, 0);
    const run = startWatcher(env);
    try {
      expect(await exitedWithin(run.done, 10_000)).toEqual({ code: 0, out: "", err: "" });
      expect(readFileSync(lockPath, "utf8")).toBe(stale);
    } finally {
      if (run.child.exitCode === null) run.child.kill();
    }
  });

  it("a lock replaced after the watcher judged it stale is not removed: the watcher leaves and the new owner keeps it", async () => {
    const { env, lockPath } = setup("Claim Recheck Org");
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, startedAt: Date.now() }));
    const g = gates();
    g.hold("takeover-judged");
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir });
    await waitFor(() => g.reached("takeover-judged"), "the watcher to judge the lock stale");
    // Meanwhile another watcher took the seat: a fresh lock, a live pid (this runner).
    const successor = JSON.stringify({ pid: process.pid, nonce: "d".repeat(24), startedAt: Date.now() });
    writeFileSync(lockPath, successor);
    g.release("takeover-judged");
    try {
      expect(await exitedWithin(run.done, 10_000)).toEqual({ code: 0, out: "", err: "" });
      expect(readFileSync(lockPath, "utf8")).toBe(successor);
    } finally {
      if (run.child.exitCode === null) run.child.kill();
    }
  });
});

// ---- no seat, no delivery: error paths (review of #694 at b9875de2) -------------------------------------------------
//
// Olive reproduced, with the real watcher, a fake Codex and a state dir that is a regular file, that the lock-less
// fallback let two concurrent hooks queue the same mail twice. Now any failure to make or read the lock or the claim
// (anything but a busy live holder) means no seat: nothing is written or delivered, the mail stays unread, and a seat
// that stays unusable is reported once on stderr with exit 1 (never 2, the asyncRewake wake signal). Errors are injected
// through the watcher's fault seam (OPENCADRE_WAKE_TEST_FAULTS) where a real filesystem cannot portably produce them.

const THREAD = "4d6e8f00-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const codexSeat = (env: Record<string, string>) => createHash("sha256").update(`${env.OPENCADRE_KEY}\n${THREAD}`).digest("hex").slice(0, 16);
const REPORTED = /^OPENCADRE WAKE ERROR: this agent's wake state in .* cannot be used/;

describe("no seat, no delivery: a lock, claim or lock read that fails for any reason defers, and a broken seat is reported", { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  it("healthy control: two concurrent hooks on one seat deliver the mail exactly once", async () => {
    const { orgId, peer, env } = setup("Errors Healthy Org");
    const codex = fakeCodex();
    await sendMessage(orgId, peer, "Sleeper", "deliver me once");
    const runs = await Promise.all([startCodexWatcher(env, THREAD, codex.dir).done, startCodexWatcher(env, THREAD, codex.dir).done]);
    expect(codex.calls()).toHaveLength(1);
    expect(runs.map((r) => r.code)).toEqual([0, 0]);
    expect(readJson(path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-${codexSeat(env)}.json`))?.afterId).toBeTruthy();
  });

  it("a state dir that is a regular file: two concurrent hooks deliver nothing, write nothing, and the folder is reported once", async () => {
    const { orgId, peer, env } = setup("Errors File State Org");
    const broken = path.join(mkdtempSync(path.join(tmpdir(), "wake-broken-")), "state-is-a-file");
    writeFileSync(broken, "not a directory");
    const brokenEnv = { ...env, OPENCADRE_WAKE_STATE_DIR: broken };
    const codex = fakeCodex();
    await sendMessage(orgId, peer, "Sleeper", "must stay unread");
    const runs = await Promise.all([startCodexWatcher(brokenEnv, THREAD, codex.dir).done, startCodexWatcher(brokenEnv, THREAD, codex.dir).done]);
    expect(codex.calls()).toHaveLength(0);
    expect(readFileSync(broken, "utf8")).toBe("not a directory");
    // One run reports (exit 1, the error on stderr); the other finds it reported and leaves silently (exit 0).
    expect(runs.map((r) => r.code).sort()).toEqual([0, 1]);
    expect(runs.filter((r) => REPORTED.test(r.err))).toHaveLength(1);
    expect(runs.every((r) => !r.err.includes("must stay unread") && r.out === "")).toBe(true);
  });

  for (const code of ["EACCES", "EPERM"]) {
    it(`lock creation failing with ${code}: no wake, no lock, no cursor, reported with exit 1 (never the exit-2 wake)`, async () => {
      const { orgId, peer, env, lockPath, cursorPath } = setup(`Errors Lock ${code} Org`);
      await sendMessage(orgId, peer, "Sleeper", "not through a lock-less watcher");
      const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_FAULTS: `lock-create:${code}` });
      const done = await exitedWithin(run.done, 15_000);
      expect(done).toMatchObject({ code: 1, out: "" });
      expect((done as { err: string }).err).toMatch(REPORTED);
      expect((done as { err: string }).err).toContain(code);
      expect((done as { err: string }).err).not.toContain("not through a lock-less watcher");
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(cursorPath)).toBe(false);
    });
  }

  for (const [point, what] of [["claim-create", "claim creation"], ["lock-read", "the lock re-read under the claim"]] as const) {
    it(`${what} failing (EPERM): the mail is deferred, never delivered or recorded, and the seat is reported once it keeps failing`, async () => {
      const { orgId, peer, env } = setup(`Errors ${point} Org`);
      const codex = fakeCodex();
      const seat = codexSeat(env);
      const run = startCodexWatcher({ ...env, OPENCADRE_WAKE_TEST_FAULTS: `${point}:EPERM` }, THREAD, codex.dir);
      await waitFor(() => existsSync(path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-${seat}.lock`)), "the watcher to take its lock");
      await sendMessage(orgId, peer, "Sleeper", "deferred, not delivered");
      const done = await exitedWithin(run.done, 20_000);
      expect(done).toMatchObject({ code: 1, out: "" });
      expect((done as { err: string }).err).toMatch(REPORTED);
      expect((done as { err: string }).err).toContain("EPERM");
      expect(codex.calls()).toHaveLength(0);
      expect(existsSync(path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-${seat}.json`))).toBe(false);
      expect(existsSync(path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-history-${seat}.jsonl`))).toBe(false);
    });
  }
});

// ---- a hub outage is not a wake (review of #694 at b83b2fc2) --------------------------------------------------------
//
// Exit 2 under --rewake is the wake signal and is used ONLY for delivered mail. An outage, once the transient retries are
// spent, is reported once a day per seat and hub with exit 1 (a non-fatal hook error); a later run that day leaves with a
// silent exit 0. No turn is queued and the cursor and cooldown stay put. Report classes are separate: a state-folder
// report never suppresses an outage report, nor the reverse.

const OUTAGE = /^OPENCADRE WAKE ERROR: hub unreachable after 2 attempts/;
const STATE = /^OPENCADRE WAKE ERROR: this agent's wake state in .* cannot be used/;
const fast = { OPENCADRE_WAKE_MAX_FAILURES: "2", OPENCADRE_WAKE_RETRY_MS: "50" };
/** A hub that answers every request with a 500. */
async function erroringHub() {
  const hub = http.createServer((_req, res) => res.writeHead(500, { "content-type": "application/json" }).end("{}"));
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(hub.address() as import("node:net").AddressInfo).port}`, close: () => new Promise<void>((done) => hub.close(() => done())) };
}

describe("a hub outage is reported, never delivered as a wake", { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  for (const kind of ["unreachable", "erroring"] as const) {
    it(`--rewake, hub ${kind}: exit 1 with one report and the cursor and cooldown unmoved, then exit 0 silently the same day`, async () => {
      const { env, cursorPath } = setup(`Outage Rewake ${kind} Org`);
      const hub = kind === "erroring" ? await erroringHub() : null;
      try {
        const down = { ...env, ...fast, OPENCADRE_URL: hub?.url ?? "http://127.0.0.1:1" };
        const saved = { afterId: "earlier-cursor", lastWakeAt: 2468 };
        writeFileSync(cursorPath, JSON.stringify(saved));
        const first = await exitedWithin(startWatcher(down).done, 15_000);
        expect(first).toMatchObject({ code: 1, out: "" });
        expect((first as { err: string }).err).toMatch(OUTAGE);
        expect(readJson(cursorPath)).toEqual(saved);
        expect(await exitedWithin(startWatcher(down).done, 15_000)).toEqual({ code: 0, out: "", err: "" });
        expect(readJson(cursorPath)).toEqual(saved);
      } finally {
        await hub?.close();
      }
    });
  }

  it("--codex-queue, hub unreachable: no turn is queued; exit 1 with one report, then exit 0 silently", async () => {
    const { env } = setup("Outage Codex Org");
    const codex = fakeCodex();
    const down = { ...env, ...fast, OPENCADRE_URL: "http://127.0.0.1:1" };
    const first = await exitedWithin(startCodexWatcher(down, THREAD, codex.dir).done, 15_000);
    expect(first).toMatchObject({ code: 1, out: "" });
    expect((first as { err: string }).err).toMatch(OUTAGE);
    expect(await exitedWithin(startCodexWatcher(down, THREAD, codex.dir).done, 15_000)).toEqual({ code: 0, out: "", err: "" });
    expect(codex.calls()).toHaveLength(0);
    expect(existsSync(path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-${codexSeat(env)}.json`))).toBe(false);
  });

  it("report classes are separate: a state-folder report and an outage report on one seat are both delivered", async () => {
    const { env } = setup("Outage Classes Org");
    const broken = path.join(mkdtempSync(path.join(tmpdir(), "wake-broken-")), "state-is-a-file");
    writeFileSync(broken, "not a directory");
    const brokenState = await exitedWithin(startWatcher({ ...env, OPENCADRE_WAKE_STATE_DIR: broken }).done, 15_000);
    expect(brokenState).toMatchObject({ code: 1 });
    expect((brokenState as { err: string }).err).toMatch(STATE);
    const outage = await exitedWithin(startWatcher({ ...env, ...fast, OPENCADRE_URL: "http://127.0.0.1:1" }).done, 15_000);
    expect(outage).toMatchObject({ code: 1 });
    expect((outage as { err: string }).err).toMatch(OUTAGE);
    // And each stays suppressed only for itself.
    expect(await exitedWithin(startWatcher({ ...env, OPENCADRE_WAKE_STATE_DIR: broken }).done, 15_000)).toEqual({ code: 0, out: "", err: "" });
    expect(await exitedWithin(startWatcher({ ...env, ...fast, OPENCADRE_URL: "http://127.0.0.1:1" }).done, 15_000)).toEqual({ code: 0, out: "", err: "" });
  });

  it("positive control: real mail on a healthy hub is the one case that exits 2, with the delivery", async () => {
    const { orgId, peer, env, cursorPath } = setup("Outage Positive Org");
    await sendMessage(orgId, peer, "Sleeper", "this one wakes");
    const woke = await exitedWithin(startWatcher(env).done, 15_000);
    expect(woke).toMatchObject({ code: 2, out: "" });
    expect((woke as { err: string }).err).toMatch(/^OPENCADRE WAKE: 1 new message/);
    expect(readJson(cursorPath)?.afterId).toBeTruthy();
  });
});

// ---- the takeover's final re-read (review of #694 at 7012c8d3) ------------------------------------------------------
//
// Olive's trace: a stale, unparseable lock; a successor replaces it at takeover-judged; the final re-read fails (EACCES)
// and, read as "no lock", authorised removing the successor's fresh lock. The final re-read now tells a read error from a
// missing, unparseable or other-owner lock: an error defers and is reported, and nothing is removed or written.

describe("the takeover's final re-read: a lock it cannot read is never removed", { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  /** A stale, unparseable lock: a damaged record left long ago. */
  const staleDamaged = (lockPath: string) => {
    writeFileSync(lockPath, "{ damaged");
    ageLock(lockPath);
  };
  const successorLock = () => JSON.stringify({ pid: process.pid, nonce: "a".repeat(24), startedAt: Date.now(), procStart: Math.round(Date.now() - process.uptime() * 1000), role: "opencadre-wake", ownerCheck: "none" });

  it("late-read fault: a successor replaces the stale lock at takeover-judged and the final re-read fails (EACCES): the successor's lock is byte-identical, ours is not written, no delivery, and the folder is reported", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("Reread Fault Org");
    staleDamaged(lockPath);
    await sendMessage(orgId, peer, "Sleeper", "not for a watcher that cannot read the lock");
    const g = gates();
    g.hold("takeover-judged");
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir, OPENCADRE_WAKE_TEST_FAULTS: "takeover-reread:EACCES" });
    await waitFor(() => g.reached("takeover-judged"), "the watcher to judge the damaged lock stale");
    const successor = successorLock();
    writeFileSync(lockPath, successor);
    g.release("takeover-judged");
    const done = await exitedWithin(run.done, 15_000);
    expect(done).toMatchObject({ code: 1, out: "" });
    expect((done as { err: string }).err).toMatch(STATE);
    expect((done as { err: string }).err).toContain("EACCES");
    expect((done as { err: string }).err).not.toContain("not for a watcher");
    expect(readFileSync(lockPath, "utf8")).toBe(successor);
    expect(existsSync(cursorPath)).toBe(false);
  });

  it("readable-successor control: the same interleaving with a readable successor leaves (held), and the successor's lock is preserved", async () => {
    const { env, lockPath } = setup("Reread Readable Org");
    staleDamaged(lockPath);
    const g = gates();
    g.hold("takeover-judged");
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir });
    await waitFor(() => g.reached("takeover-judged"), "the watcher to judge the damaged lock stale");
    const successor = successorLock();
    writeFileSync(lockPath, successor);
    g.release("takeover-judged");
    expect(await exitedWithin(run.done, 15_000)).toEqual({ code: 0, out: "", err: "" });
    expect(readFileSync(lockPath, "utf8")).toBe(successor);
  });

  it("a successor's lock still being written (unparseable, but new) is not taken for the damaged one judged stale", async () => {
    const { env, lockPath } = setup("Reread Fresh Unparseable Org");
    staleDamaged(lockPath);
    const g = gates();
    g.hold("takeover-judged");
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir });
    await waitFor(() => g.reached("takeover-judged"), "the watcher to judge the damaged lock stale");
    writeFileSync(lockPath, ""); // created a moment ago, its content not yet written
    g.release("takeover-judged");
    expect(await exitedWithin(run.done, 15_000)).toEqual({ code: 0, out: "", err: "" });
    expect(readFileSync(lockPath, "utf8")).toBe("");
  });

  it("positive control: a stale damaged lock nobody replaced is taken over, and the watcher wakes for mail", async () => {
    const { orgId, peer, env, lockPath } = setup("Reread Takeover Org");
    staleDamaged(lockPath);
    await sendMessage(orgId, peer, "Sleeper", "after the damaged lock");
    const woke = await exitedWithin(startWatcher(env).done, 15_000);
    expect(woke).toMatchObject({ code: 2 });
    expect((woke as { err: string }).err).toContain("after the damaged lock");
  });
});

// ---- the claim list keeps its errors (review of #694 at eb9fc6b1) ---------------------------------------------------
//
// 049a's trace: with claim 0 present and the claims listing denied, the listing read as empty, so the watcher re-created
// claim 0 forever (over 41,000 creates in 200 ms). Listing and claim reads now keep their errors typed (only ENOENT is
// "absent"), an error defers the seat and is reported, and a lost create must show in the next listing or it is an error
// after a few tries: every path is bounded. The watcher's trace seam counts claim creates (<gates>/trace.log).

const creates = (g: { dir: string }) => {
  const log = path.join(g.dir, "trace.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("create ") && !l.endsWith(".done")) : [];
};

describe("the claim list keeps its errors, and every claim retry is bounded", { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  for (const code of ["EACCES", "EPERM", "EIO"]) it(`a persistently unreadable claim list (${code}) with claim 0 present: deferred and reported, zero creates, no delivery`, async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup(`List Denied ${code} Org`);
    const g = gates();
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir, OPENCADRE_WAKE_TEST_FAULTS: `claim-list:${code}` });
    await waitFor(() => lockTaken(lockPath), "the watcher to take its lock");
    const holder = writeClaim(lockPath, 0);
    await sendMessage(orgId, peer, "Sleeper", "not while the claims cannot be listed");
    const done = await exitedWithin(run.done, 15_000);
    expect(done).toMatchObject({ code: 1, out: "" });
    expect((done as { err: string }).err).toMatch(STATE);
    expect((done as { err: string }).err).toContain(code);
    expect((done as { err: string }).err).not.toContain("not while the claims");
    expect(creates(g)).toEqual([]);
    expect(readFileSync(path.join(claimsOf(lockPath), "0"), "utf8")).toBe(holder);
    expect(existsSync(cursorPath)).toBe(false);
  });

  it("a transient listing denial (EACCES twice) that clears to a readable live holder: busy, claim unmodified, zero creates, no report; it wakes once released", async () => {
    const { orgId, peer, env, lockPath } = setup("List Transient Org");
    const g = gates();
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir, OPENCADRE_WAKE_TEST_FAULTS: "claim-list:EACCES*2" });
    await waitFor(() => lockTaken(lockPath), "the watcher to take its lock");
    const holder = writeClaim(lockPath, 0);
    await sendMessage(orgId, peer, "Sleeper", "after the denial clears");
    expect(await exitedWithin(run.done, 3500)).toBe("still running");
    expect(creates(g)).toEqual([]);
    expect(readFileSync(path.join(claimsOf(lockPath), "0"), "utf8")).toBe(holder);
    releaseClaimFile(lockPath, 0);
    const woke = await run.done;
    expect(woke.code).toBe(2);
    expect(woke.err).toMatch(/^OPENCADRE WAKE: 1 new message/);
  });

  it("a listing that does not show claims that exist: a bounded number of create attempts, then reported, no delivery", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("List Omits Org");
    const g = gates();
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir, OPENCADRE_WAKE_TEST_FAULTS: "claim-list-omits:all" });
    await waitFor(() => lockTaken(lockPath), "the watcher to take its lock");
    writeClaim(lockPath, 0);
    await sendMessage(orgId, peer, "Sleeper", "not through an endless retry");
    const done = await exitedWithin(run.done, 15_000);
    expect(done).toMatchObject({ code: 1, out: "" });
    expect((done as { err: string }).err).toContain("claim list does not show claim 0");
    // Three tries per attempt to take the seat, three attempts before the report, one at exit: never unbounded.
    expect(creates(g).length).toBeGreaterThan(0);
    expect(creates(g).length).toBeLessThanOrEqual(12);
    expect(existsSync(cursorPath)).toBe(false);
  });

  it("an unreadable claim (EACCES on claim 0) is an error, not a holder to wait for forever: reported, no delivery", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("Claim Read Denied Org");
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_FAULTS: "claim-read:EACCES" });
    await waitFor(() => lockTaken(lockPath), "the watcher to take its lock");
    writeClaim(lockPath, 0);
    await sendMessage(orgId, peer, "Sleeper", "not past an unreadable claim");
    const done = await exitedWithin(run.done, 15_000);
    expect(done).toMatchObject({ code: 1, out: "" });
    expect((done as { err: string }).err).toContain("EACCES");
    expect(existsSync(cursorPath)).toBe(false);
  });

  it("control: a readable live holder is busy, with zero creates, until it releases", async () => {
    const { orgId, peer, env, lockPath } = setup("List Live Holder Org");
    const g = gates();
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir });
    await waitFor(() => lockTaken(lockPath), "the watcher to take its lock");
    writeClaim(lockPath, 0);
    await sendMessage(orgId, peer, "Sleeper", "after the holder");
    expect(await exitedWithin(run.done, 2500)).toBe("still running");
    expect(creates(g)).toEqual([]);
    releaseClaimFile(lockPath, 0);
    expect((await run.done).code).toBe(2);
    expect(creates(g)[0]).toBe("create 1");
  });

  it("control: a missing claims folder means no claims: claim 0 is taken and the mail is delivered", async () => {
    const { orgId, peer, env, lockPath } = setup("List Empty Org");
    const g = gates();
    await sendMessage(orgId, peer, "Sleeper", "first claim ever");
    const woke = await exitedWithin(startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir }).done, 15_000);
    expect(woke).toMatchObject({ code: 2 });
    expect((woke as { err: string }).err).toContain("first claim ever");
    expect(creates(g)[0]).toBe("create 0");
    expect(existsSync(path.join(claimsOf(lockPath), "0"))).toBe(true);
  });
});

// ---- contention is bounded; what cannot be read is never "released" (049a's constraints on the claim-list fix) -------

describe("bounded under contention, and conservative about holders it cannot read", { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  const traceLines = (g: { dir: string }) => (existsSync(path.join(g.dir, "trace.log")) ? readFileSync(path.join(g.dir, "trace.log"), "utf8").split("\n") : []);

  it("repeated lost races (every create beaten by a watcher that then lets go): each attempt to take the seat ends at its deadline and defers; nothing is delivered", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("Contention Org");
    const g = gates();
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir, OPENCADRE_WAKE_TEST_FAULTS: "claim-create-loses:all" });
    await waitFor(() => lockTaken(lockPath), "the watcher to take its lock");
    await sendMessage(orgId, peer, "Sleeper", "not under endless contention");
    // Every attempt returns (a "deferred busy" line each time), and each tries a bounded number of creates.
    await waitFor(() => traceLines(g).filter((l) => l === "deferred busy").length >= 2, "two bounded attempts to end", 15_000);
    const lines = traceLines(g);
    const firstAttempt = lines.slice(0, lines.indexOf("deferred busy")).filter((l) => l.startsWith("create "));
    expect(firstAttempt.length).toBeGreaterThan(0);
    expect(firstAttempt.length).toBeLessThanOrEqual(50);
    expect(run.child.exitCode).toBeNull(); // still running: busy contention defers; it is not an error to report
    expect(existsSync(cursorPath)).toBe(false);
    run.child.kill();
    const done = await run.done;
    expect(done.err).not.toContain("not under endless contention");
  });

  it("a malformed claim body is never taken for a released or abandoned one, however old: the owner waits, with zero creates", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("Malformed Claim Org");
    const g = gates();
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir, OPENCADRE_WAKE_CLAIM_STALE_MS: "300" });
    await waitFor(() => lockTaken(lockPath), "the watcher to take its lock");
    mkdirSync(claimsOf(lockPath), { recursive: true });
    const body = path.join(claimsOf(lockPath), "0");
    writeFileSync(body, "{ malformed");
    const old = new Date(Date.now() - 3600_000);
    utimesSync(body, old, old);
    await sendMessage(orgId, peer, "Sleeper", "only after a real release");
    expect(await exitedWithin(run.done, 3000)).toBe("still running");
    expect(creates(g)).toEqual([]);
    expect(readFileSync(body, "utf8")).toBe("{ malformed");
    expect(existsSync(cursorPath)).toBe(false);
    releaseClaimFile(lockPath, 0); // its holder's release marker: only that frees it
    expect((await run.done).code).toBe(2);
  });

  it("a process query that cannot say (unknown) never proves a long-held claim's holder gone", async () => {
    const { orgId, peer, env, lockPath, cursorPath } = setup("Unknown Incarnation Org");
    const g = gates();
    const run = startWatcher({ ...env, OPENCADRE_WAKE_TEST_GATES: g.dir, OPENCADRE_WAKE_CLAIM_STALE_MS: "300", OPENCADRE_WAKE_TEST_FAULTS: "creation-time:unknown" });
    await waitFor(() => lockTaken(lockPath), "the watcher to take its lock");
    // The holder's pid is alive (this runner) with a start an hour off: proven reuse, if the query could answer.
    writeClaim(lockPath, 0, { procStart: Math.round(Date.now() - process.uptime() * 1000) - 3600_000 });
    await sendMessage(orgId, peer, "Sleeper", "not on an unknown");
    expect(await exitedWithin(run.done, 3000)).toBe("still running");
    expect(creates(g)).toEqual([]);
    expect(existsSync(cursorPath)).toBe(false);
    releaseClaimFile(lockPath, 0);
    expect((await run.done).code).toBe(2);
  });
});
