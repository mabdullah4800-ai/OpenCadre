import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { claudeResumeAdapter, codexExecResumeAdapter, isLocked } from "../scripts/wake-daemon/t3-resume.mjs";
import { runWakeCycle } from "../scripts/wake-daemon/orchestrator.mjs";
import { initLimiterState } from "../scripts/wake-daemon/rate-limiter.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = () => mkdtempSync(path.join(tmpdir(), "wake-t3-"));
const msg = (over: Record<string, unknown> = {}) => ({
  id: "m1", body: "prod is down", priority: "high", from_agent_id: "peer", from_agent_name: "Waker", ...over,
});

/** A fake ChildProcess that lets a test script exactly what the mocked `codex`/`claude`
 * subprocess prints and how it exits, without ever spawning a real process. */
function fakeChild({ stderr = "", stdout = "", code = 0, delayMs = 0 }: { stderr?: string; stdout?: string; code?: number; delayMs?: number }) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void; killed?: boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  setTimeout(() => {
    if (child.killed) return;
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  }, delayMs);
  return child;
}

const spawnCalls: Array<{ command: string; args: string[] }> = [];
function mockSpawnFactory(response: { stderr?: string; stdout?: string; code?: number; delayMs?: number }) {
  spawnCalls.length = 0;
  return (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    return fakeChild(response);
  };
}

describe("isLocked", () => {
  it("recognises a thread-store conflict", () => {
    expect(isLocked("Error: thread-store conflict: session owned by another process")).toBe(true);
    expect(isLocked("resumed fine")).toBe(false);
  });
});

describe("T3 headless-resume adapters (docs/design/UNIVERSAL_WAKE.md section 5, item 7)", () => {
  it("codexExecResumeAdapter: a locked thread reports `locked` from canWake, without a retry", async () => {
    const spawnFn = mockSpawnFactory({ stderr: "Error: thread-store conflict\n", code: 1 });
    const adapter = codexExecResumeAdapter({ spawnFn, timeoutMs: 5000 });
    const session = { sessionId: "s1", threadId: "thread-abc", status: "idle" };
    const digest = { ids: ["m1"], top: "high" as const, line: "[high] from Waker: prod is down" };

    const gate = await adapter.canWake(session, digest);
    expect(gate).toEqual({ ok: false, reason: "locked" });
    // canWake and the subsequent wake() share the one invocation: no second spawn.
    const result = await adapter.wake(session, digest);
    expect(result.attempted).toBe(false);
    expect(result.detail).toContain("locked");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({ command: "codex", args: ["exec", "resume", "thread-abc", digest.line] });
  });

  it("claudeResumeAdapter: a locked thread also reports `locked`, with the right argv", async () => {
    const spawnFn = mockSpawnFactory({ stderr: "session is locked by another client\n", code: 1 });
    const adapter = claudeResumeAdapter({ spawnFn, timeoutMs: 5000 });
    const session = { sessionId: "s1", threadId: "claude-thread-1", status: "idle" };
    const digest = { ids: ["m1"], top: "high" as const, line: "[high] from Waker: prod is down" };

    const gate = await adapter.canWake(session, digest);
    expect(gate).toEqual({ ok: false, reason: "locked" });
    expect(spawnCalls[0]).toMatchObject({ command: "claude", args: ["-p", "--resume", "claude-thread-1", digest.line] });
  });

  it("a free thread runs the turn: canWake ok, wake attempted", async () => {
    const spawnFn = mockSpawnFactory({ stdout: "turn started\n", code: 0 });
    const adapter = codexExecResumeAdapter({ spawnFn, timeoutMs: 5000 });
    const session = { sessionId: "s1", threadId: "thread-free", status: "idle" };
    const digest = { ids: ["m1"], top: "high" as const, line: "hi" };

    expect(await adapter.canWake(session, digest)).toEqual({ ok: true });
    const result = await adapter.wake(session, digest);
    expect(result).toEqual({ attempted: true, detail: "resume turn started" });
    expect(spawnCalls).toHaveLength(1); // canWake + wake still only spawned once
  });

  it("a nonzero exit that isn't a lock is reported as disabled, not locked", async () => {
    const spawnFn = mockSpawnFactory({ stderr: "command not found\n", code: 127 });
    const adapter = codexExecResumeAdapter({ spawnFn, timeoutMs: 5000 });
    const session = { sessionId: "s1", threadId: "t", status: "idle" };
    const digest = { ids: ["m1"], top: "high" as const, line: "hi" };
    expect(await adapter.canWake(session, digest)).toEqual({ ok: false, reason: "disabled" });
  });

  it("a hung subprocess times out and reports no-owner rather than hanging forever", async () => {
    const spawnFn = mockSpawnFactory({ delayMs: 200 }); // longer than the adapter's timeout
    const adapter = codexExecResumeAdapter({ spawnFn, timeoutMs: 20 });
    const session = { sessionId: "s1", threadId: "t", status: "idle" };
    const digest = { ids: ["m1"], top: "high" as const, line: "hi" };
    expect(await adapter.canWake(session, digest)).toEqual({ ok: false, reason: "no-owner" });
  });

  it("end-to-end through the orchestrator: locked T3 falls to T4 within ~1s, no retry storm", async () => {
    const lockedSpawn = mockSpawnFactory({ stderr: "thread-store conflict\n", code: 1 });
    const t3 = codexExecResumeAdapter({ spawnFn: lockedSpawn, timeoutMs: 5000 });
    let woke = false;
    const t4 = {
      id: "t4-fallback", tier: 4, verifyMs: 50, idleTokenCost: "per-tick" as const,
      calls: { detect: 0, canWake: 0, wake: 0 },
      async detect() { this.calls.detect++; return true; },
      async canWake() { this.calls.canWake++; return { ok: true }; },
      async wake() { this.calls.wake++; woke = true; return { attempted: true, detail: "t4" }; },
    };

    const start = Date.now();
    const result = await runWakeCycle({
      session: { sessionId: "s1", threadId: "thread-abc", status: "idle" },
      messages: [msg()],
      adapters: [t3, t4],
      leaseDir: dir(),
      limiterState: initLimiterState(),
      verifyStatus: async () => (woke ? "busy" : "idle"),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    const elapsedMs = Date.now() - start;

    expect(result).toEqual({ action: "woke", adapter: "t4-fallback" });
    expect(t4.calls.wake).toBe(1);
    expect(lockedSpawn).toBeDefined();
    expect(spawnCalls).toHaveLength(1); // T3 was tried exactly once, never retried after `locked`
    expect(elapsedMs).toBeLessThan(1000);
  });
});
