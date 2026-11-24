import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeAdapter } from "../scripts/wake-daemon/adapter.mjs";
import { acquireLease } from "../scripts/wake-daemon/lease.mjs";
import { runWakeCycle } from "../scripts/wake-daemon/orchestrator.mjs";
import { initLimiterState } from "../scripts/wake-daemon/rate-limiter.mjs";

const dir = () => mkdtempSync(path.join(tmpdir(), "wake-orch-"));
const msg = (over: Record<string, unknown> = {}) => ({
  id: "m1", body: "prod is down", priority: "high", from_agent_id: "peer", from_agent_name: "Waker", ...over,
});
const noSleep = () => Promise.resolve();

describe("wake-daemon orchestrator: acceptance tests (docs/design/UNIVERSAL_WAKE.md section 5, item 4)", () => {
  it("busy -> no wake", async () => {
    const adapter = fakeAdapter();
    const leaseDir = dir();
    const result = await runWakeCycle({
      session: { sessionId: "s1", status: "busy" },
      messages: [msg()],
      adapters: [adapter],
      leaseDir,
      limiterState: initLimiterState(),
      verifyStatus: async () => "busy",
      sleep: noSleep,
    });
    expect(result).toEqual({ action: "skipped", reason: "busy" });
    expect(adapter.calls.wake).toBe(0);
  });

  it("blocked status also gets no wake", async () => {
    const adapter = fakeAdapter();
    const result = await runWakeCycle({
      session: { sessionId: "s1", status: "blocked" },
      messages: [msg()],
      adapters: [adapter],
      leaseDir: dir(),
      limiterState: initLimiterState(),
      verifyStatus: async () => "blocked",
      sleep: noSleep,
    });
    expect(result.action).toBe("skipped");
    expect(adapter.calls.wake).toBe(0);
  });

  it("a T1 waiter armed within the last 60s means the daemon stays hands-off", async () => {
    const adapter = fakeAdapter();
    const now = () => 1_000_000;
    const result = await runWakeCycle({
      session: { sessionId: "s1", status: "idle", waiterArmedAt: now() - 30_000 },
      messages: [msg()],
      adapters: [adapter],
      leaseDir: dir(),
      limiterState: initLimiterState(),
      now,
      verifyStatus: async () => "idle",
      sleep: noSleep,
    });
    expect(result).toEqual({ action: "skipped", reason: "waiter-armed" });
    expect(adapter.calls.wake).toBe(0);
  });

  it("two mails in 1s -> one wake (the second rides the cooldown and is coalesced, not dropped)", async () => {
    let status = "idle";
    const adapter = fakeAdapter({ onWake: () => { status = "busy"; } });
    const leaseDir = dir();
    const limiterState = initLimiterState();
    const base = { adapters: [adapter], leaseDir, limiterState, verifyStatus: async () => status, sleep: noSleep };

    const first = await runWakeCycle({ ...base, session: { sessionId: "s1", status: "idle" }, messages: [msg({ id: "m1" })], now: () => 0 });
    expect(first).toEqual({ action: "woke", adapter: "fake" });
    expect(adapter.calls.wake).toBe(1);

    // A second, distinct message a second later: the cooldown (2 min) blocks another wake attempt.
    status = "idle";
    const second = await runWakeCycle({ ...base, session: { sessionId: "s1", status: "idle" }, messages: [msg({ id: "m2" })], now: () => 1000 });
    expect(second).toEqual({ action: "coalesced", reason: "cooldown" });
    expect(adapter.calls.wake).toBe(1); // still just the one wake
    expect(limiterState.pending).toEqual(["m2"]);
  });

  it("verify timeout -> next tier (T1 fails to verify, T2 succeeds)", async () => {
    let status = "idle";
    const t1 = fakeAdapter({ id: "t1", tier: 1, verifyMs: 30 }); // wake() reports attempted, but status never flips
    const t2 = fakeAdapter({ id: "t2", tier: 2, verifyMs: 30, onWake: () => { status = "busy"; } });
    const result = await runWakeCycle({
      session: { sessionId: "s1", status: "idle" },
      messages: [msg()],
      adapters: [t1, t2],
      leaseDir: dir(),
      limiterState: initLimiterState(),
      verifyStatus: async () => status,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    expect(result).toEqual({ action: "woke", adapter: "t2" });
    expect(t1.calls.wake).toBe(1);
    expect(t2.calls.wake).toBe(1);
  });

  it("an adapter reporting locked/busy/no-owner/disabled from canWake fails over without calling wake()", async () => {
    const locked = fakeAdapter({ id: "locked", canWakeResult: { ok: false, reason: "locked" } });
    const free = fakeAdapter({ id: "free" });
    const result = await runWakeCycle({
      session: { sessionId: "s1", status: "idle" },
      messages: [msg()],
      adapters: [locked, free],
      leaseDir: dir(),
      limiterState: initLimiterState(),
      verifyStatus: async () => "busy",
      sleep: noSleep,
    });
    expect(result).toEqual({ action: "woke", adapter: "free" });
    expect(locked.calls.wake).toBe(0);
  });

  it("3 failures -> T6 event: three verify timeouts trip the hard stop and further mail is coalesced, not retried", async () => {
    const never = fakeAdapter({ id: "never-verifies", verifyMs: 10 }); // wake() succeeds, status never flips
    const leaseDir = dir();
    const limiterState = initLimiterState();
    const escalations: Array<{ reason: string }> = [];
    const onEscalate = (_session: unknown, reason: string) => escalations.push({ reason });
    const cycle = (messages: unknown[], now: number) => runWakeCycle({
      session: { sessionId: "s1", status: "idle" },
      messages, adapters: [never], leaseDir, limiterState, now: () => now,
      verifyStatus: async () => "idle",
      onEscalate,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    });

    const r1 = await cycle([msg({ id: "m1" })], 0);
    expect(r1.action).toBe("exhausted");
    const r2 = await cycle([msg({ id: "m2" })], 130_000); // past the 2-min cooldown
    expect(r2.action).toBe("exhausted");
    const r3 = await cycle([msg({ id: "m3" })], 260_000);
    expect(r3).toEqual({ action: "escalated", reason: "verify-failures" });
    expect(escalations).toHaveLength(1);
    expect(escalations[0].reason).toContain("verify failures");

    // Once escalated, later mail is coalesced (T6 owns it now), never retried locally again.
    const r4 = await cycle([msg({ id: "m4" })], 500_000);
    expect(r4).toEqual({ action: "coalesced", reason: "escalated" });
    expect(never.calls.wake).toBe(3); // not 4: no retry storm once escalated
  });

  it("never wakes for low priority or a pure ack, even with a perfectly healthy adapter", async () => {
    const adapter = fakeAdapter();
    const result = await runWakeCycle({
      session: { sessionId: "s1", status: "idle" },
      messages: [msg({ id: "low", priority: "low" }), msg({ id: "ack", body: "thanks" })],
      adapters: [adapter],
      leaseDir: dir(),
      limiterState: initLimiterState(),
      verifyStatus: async () => "idle",
      sleep: noSleep,
    });
    expect(result).toEqual({ action: "none" });
    expect(adapter.calls.wake).toBe(0);
  });

  it("never wakes twice for the same mail while a lease is held (double-wake guard)", async () => {
    const adapter = fakeAdapter();
    const leaseDir = dir();
    const limiterState = initLimiterState();
    // Simulate an in-flight wake from elsewhere by holding the lease directly.
    acquireLease(leaseDir, "s1", { messageIds: ["m1"], adapter: "other", ttlMs: 60_000, now: 0 });

    const result = await runWakeCycle({
      session: { sessionId: "s1", status: "idle" },
      messages: [msg()],
      adapters: [adapter],
      leaseDir, limiterState, now: () => 0,
      verifyStatus: async () => "idle",
      sleep: noSleep,
    });
    expect(result).toEqual({ action: "skipped", reason: "lease-active" });
    expect(adapter.calls.wake).toBe(0);
  });
});
