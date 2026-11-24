import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireLease, readLease, releaseLease } from "../scripts/wake-daemon/lease.mjs";

const dir = () => mkdtempSync(path.join(tmpdir(), "wake-lease-"));

describe("wake-daemon lease", () => {
  it("acquires when no lease exists, and blocks a second acquire while it's active", () => {
    const base = dir();
    const first = acquireLease(base, "sess-1", { messageIds: ["m1"], adapter: "fake", ttlMs: 60_000, now: 1000 });
    expect(first).toMatchObject({ messageIds: ["m1"], adapter: "fake", expires: 61_000 });
    expect(acquireLease(base, "sess-1", { messageIds: ["m2"], adapter: "fake", ttlMs: 60_000, now: 2000 })).toBeNull();
  });

  it("readLease returns null once the lease has expired, and a new acquire then succeeds", () => {
    const base = dir();
    acquireLease(base, "sess-1", { messageIds: ["m1"], adapter: "fake", ttlMs: 1000, now: 0 });
    expect(readLease(base, "sess-1", 500)).not.toBeNull();
    expect(readLease(base, "sess-1", 5000)).toBeNull();
    expect(acquireLease(base, "sess-1", { messageIds: ["m2"], adapter: "fake", ttlMs: 1000, now: 5000 })).toMatchObject({ messageIds: ["m2"] });
  });

  it("release removes the lease so a fresh acquire succeeds immediately", () => {
    const base = dir();
    acquireLease(base, "sess-1", { messageIds: ["m1"], adapter: "fake", ttlMs: 60_000, now: 0 });
    releaseLease(base, "sess-1");
    expect(readLease(base, "sess-1", 10)).toBeNull();
    expect(acquireLease(base, "sess-1", { messageIds: ["m2"], adapter: "fake", ttlMs: 60_000, now: 10 })).not.toBeNull();
  });

  it("release on a missing lease is a silent no-op", () => {
    const base = dir();
    expect(() => releaseLease(base, "never-acquired")).not.toThrow();
  });

  it("writes the lease atomically (no partial file visible)", () => {
    const base = dir();
    acquireLease(base, "sess-1", { messageIds: ["m1", "m2"], adapter: "codex-exec-resume", ttlMs: 60_000, now: 0 });
    const raw = readFileSync(path.join(base, "wake-sess-1.lock"), "utf8");
    expect(JSON.parse(raw)).toEqual({ messageIds: ["m1", "m2"], adapter: "codex-exec-resume", expires: 60_000 });
  });

  it("rejects a sessionId that could escape the state directory", () => {
    const base = dir();
    expect(() => acquireLease(base, "../escape", { messageIds: [], adapter: null, ttlMs: 1000, now: 0 })).toThrow();
  });
});
