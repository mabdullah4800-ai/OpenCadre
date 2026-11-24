import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planSessionHooks } from "../cli/lib/session-hooks.mjs";

const WAKE = path.join(process.cwd(), "scripts", "opencadre-wake.mjs");
const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";
const root = mkdtempSync(path.join(tmpdir(), "oc-codex-wake-"));
const bin = path.join(root, "bin");
const callsFile = path.join(root, "queue-calls.jsonl");
const nodePathFile = path.join(root, "queue-node-path.txt");
const entry = path.join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
mkdirSync(path.dirname(entry), { recursive: true });
writeFileSync(entry, `const fs = require("node:fs"); if (process.env.CODEX_QUEUE_FAIL === "1") process.exit(7); fs.appendFileSync(process.env.CODEX_NODE_PATH_LOG, process.execPath + "\\n"); fs.appendFileSync(process.env.CODEX_QUEUE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");`);
if (process.platform === "win32") {
  // A hard link is instant, but cannot cross volumes: with node on C: and TEMP on another drive (the fleet's scratch is
  // B:) linkSync throws EXDEV and this whole file failed to load. Copy instead in exactly that case.
  try {
    linkSync(process.execPath, path.join(bin, "node.exe"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(process.execPath, path.join(bin, "node.exe"));
  }
  writeFileSync(path.join(bin, "codex.cmd"), `@echo off\r\n"${path.join(bin, "node.exe")}" "${entry}" %*\r\n`);
}
else {
  // The shim runs the SAME entry the Windows .cmd runs. It used to name `bin/codex.js`, which is never written, so
  // every queue on Linux and macOS failed with "Cannot find module" and seven tests here could not pass there.
  writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, { mode: 0o755 });
}

let server: http.Server;
let url: string;
let mail: Array<Record<string, unknown>> = [];
const requests: string[] = [];
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    requests.push(req.url ?? "");
    await new Promise((done) => setTimeout(done, 30));
    const after = new URL(req.url ?? "/", "http://localhost").searchParams.get("afterId");
    const at = after ? mail.findIndex((m) => m.id === after) : -1;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ messages: at < 0 ? mail : mail.slice(at + 1) }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((done) => server.close(() => done())); });

function queued() {
  return existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
}
async function until(predicate: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("timed out waiting for watcher");
}
function start(thread: string, state: string, fail = false, cooldown = "0", stopHookActive?: boolean) {
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CODEX_QUEUE_LOG: callsFile, CODEX_NODE_PATH_LOG: nodePathFile, CODEX_QUEUE_FAIL: fail ? "1" : "0",
    OPENCADRE_URL: url, OPENCADRE_KEY: "test-key", OPENCADRE_WAKE_STATE_DIR: state, OPENCADRE_AWARENESS_STATE_DIR: state,
    OPENCADRE_WAIT_SECONDS: "1", OPENCADRE_WAKE_COOLDOWN_SECONDS: cooldown };
  const child = spawn(process.execPath, [WAKE, "--codex-queue", "--client", "codex"], { env, cwd: root });
  child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: thread, cwd: root, stop_hook_active: stopHookActive }));
  const completed = new Promise<number | null>((done) => child.on("close", done));
  return { child, completed };
}
function message() { return { id: "m1", priority: "medium", awaiting_reply: false, body: "please review", from_agent_name: "Peer" }; }
function deliveredFile(thread: string, state: string) {
  const hash = createHash("sha256").update(`test-key\n${thread}`).digest("hex").slice(0, 16);
  return path.join(state, `opencadre-stop-delivered-${hash}.json`);
}

describe("Codex Stop idle wake", { timeout: 20000 }, () => {
  it("installs an async Stop watcher with a multi-day timeout", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oc-wake-hooks-"));
    const plan = planSessionHooks({ home, client: "codex", awarenessPath: "awareness.mjs", wakePath: "wake/opencadre-wake.mjs" });
    const stop = JSON.parse(plan.after).hooks.Stop.flatMap((g: { hooks: unknown[] }) => g.hooks);
    expect(stop).toContainEqual({ type: "command", command: 'node "wake/opencadre-wake.mjs" --codex-queue --client codex', async: true, timeout: 604800 });
  });
  it("queues exactly one turn for this thread and only peeks at mail", async () => {
    mail = [message()];
    const state = mkdtempSync(path.join(tmpdir(), "oc-wake-one-"));
    const n = queued().length;
    const watcher = start(THREAD_A, state);
    expect(await watcher.completed).toBe(0);
    const calls = queued().slice(n);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["queue", "--thread", THREAD_A, "--message",
      'You have 1 unread OpenCadre message(s). Use "get_messages" to read them and answer each on its thread.']);
    expect(requests.every((u) => u.includes("peek=true"))).toBe(true);
  });
  it("does not queue a second turn for old mail already delivered by awareness Stop", async () => {
    mail = [{ ...message(), created_at: "2020-01-01 00:00:00" }];
    const state = mkdtempSync(path.join(tmpdir(), "oc-wake-stop-old-"));
    const n = queued().length;
    const watcher = start(THREAD_A, state, false, "0", false);
    // Awareness can finish after the watcher starts. The exact handoff still suppresses the old id.
    setTimeout(() => writeFileSync(deliveredFile(THREAD_A, state), JSON.stringify({ ids: ["m1"] })), 100);
    await until(() => requests.some((u) => u.includes("afterId=m1")));
    expect(queued()).toHaveLength(n);
    mail = [mail[0], { ...message(), id: "m2", created_at: "2020-01-01 00:00:00" }];
    expect(await watcher.completed).toBe(0);
    expect(queued().slice(n)).toHaveLength(1);
  });
  it("wakes conservatively when the awareness handoff is missing", async () => {
    mail = [{ ...message(), created_at: "2020-01-01 00:00:00" }];
    const state = mkdtempSync(path.join(tmpdir(), "oc-wake-no-handoff-"));
    const n = queued().length;
    const watcher = start(THREAD_A, state, false, "0", false);
    expect(await watcher.completed).toBe(0);
    expect(queued().slice(n)).toHaveLength(1);
  });
  it("queues old unread mail on a continued Stop, when awareness stays silent", async () => {
    mail = [{ ...message(), created_at: "2020-01-01 00:00:00" }];
    const state = mkdtempSync(path.join(tmpdir(), "oc-wake-stop-active-"));
    const n = queued().length;
    writeFileSync(deliveredFile(THREAD_A, state), JSON.stringify({ ids: ["m1"] }));
    const watcher = start(THREAD_A, state, false, "0", true);
    expect(await watcher.completed).toBe(0);
    expect(queued().slice(n)).toHaveLength(1);
  });
  it.skipIf(process.platform !== "win32")("uses the npm shim's adjacent node.exe", async () => {
    mail = [message()];
    const state = mkdtempSync(path.join(tmpdir(), "oc-wake-adjacent-node-"));
    const watcher = start(THREAD_A, state);
    expect(await watcher.completed).toBe(0);
    expect(path.resolve(readFileSync(nodePathFile, "utf8").trim().split("\n").at(-1)!)).toBe(path.resolve(bin, "node.exe"));
  });
  it("a failed queue leaves the cursor behind for a later retry", async () => {
    mail = [message()];
    const state = mkdtempSync(path.join(tmpdir(), "oc-wake-fail-"));
    const n = queued().length;
    const watcher = start(THREAD_A, state, true);
    expect(await watcher.completed).toBe(1);
    expect(queued()).toHaveLength(n);
    const cursorFiles = (await import("node:fs")).readdirSync(state).filter((name) => name.endsWith(".json"));
    expect(cursorFiles).toHaveLength(0);
  });
  it("runs no queue command when no mail arrives", async () => {
    mail = [];
    const state = mkdtempSync(path.join(tmpdir(), "oc-wake-none-"));
    const n = queued().length;
    const watcher = start(THREAD_A, state);
    await new Promise((done) => setTimeout(done, 500));
    expect(queued()).toHaveLength(n);
    watcher.child.kill();
    await watcher.completed;
  });
  it("one thread gets one watcher even when Stop launches twice", async () => {
    mail = [];
    const state = mkdtempSync(path.join(tmpdir(), "oc-wake-lock-"));
    const n = queued().length;
    const requestCount = requests.length;
    const first = start(THREAD_A, state);
    await until(() => requests.length > requestCount);
    const second = start(THREAD_A, state);
    expect(await second.completed).toBe(0);
    mail = [message()];
    expect(await first.completed).toBe(0);
    expect(queued().slice(n)).toHaveLength(1);
  });
  it("ignores low mail and pure acks while urgent mail bypasses cooldown", async () => {
    mail = [{ ...message(), id: "m-low", priority: "low" }, { ...message(), id: "m-ack", body: "thanks" }];
    const state = mkdtempSync(path.join(tmpdir(), "oc-wake-priority-"));
    const hash = createHash("sha256").update(`test-key\n${THREAD_A}`).digest("hex").slice(0, 16);
    writeFileSync(path.join(state, `wake-${hash}.json`), JSON.stringify({ afterId: "", lastWakeAt: Date.now() }));
    const n = queued().length;
    const requestCount = requests.length;
    const watcher = start(THREAD_A, state, false, "120");
    await until(() => requests.length > requestCount);
    await new Promise((done) => setTimeout(done, 200));
    expect(queued()).toHaveLength(n);
    mail = [{ ...message(), id: "m-high", priority: "high" }];
    expect(await watcher.completed).toBe(0);
    expect(queued().slice(n)).toHaveLength(1);
  });
  it("two threads keep separate locks and each queues its own thread", async () => {
    mail = [message()];
    const state = mkdtempSync(path.join(tmpdir(), "oc-wake-two-"));
    const n = queued().length;
    const a = start(THREAD_A, state);
    const b = start(THREAD_B, state);
    expect(await a.completed).toBe(0);
    expect(await b.completed).toBe(0);
    expect(queued().slice(n).map((v) => v[2]).sort()).toEqual([THREAD_A, THREAD_B]);
  });
});

