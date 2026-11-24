// Wake lease (docs/design/UNIVERSAL_WAKE.md, section 3, "Double wake" guard).
// File `wake-<sessionId>.lock` holds {messageIds, adapter, expires}, so at most one wake is
// ever in flight per session. One daemon process per machine (section 3's "Loop") owns the
// directory, so this only needs to be safe against a crash leaving a stale lease behind, not
// against concurrent daemons racing the same file.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const SAFE_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/;

function leasePath(dir, sessionId) {
  if (!SAFE_ID.test(sessionId)) throw new Error(`unsafe sessionId: ${sessionId}`);
  return join(dir, `wake-${sessionId}.lock`);
}

/** Returns the active lease, or null if none exists or it has expired. Expired leases are
 * left on disk for the caller to overwrite atomically on next acquire (not removed here, so
 * a read never has a write side effect). */
export function readLease(dir, sessionId, now = Date.now()) {
  try {
    const lease = JSON.parse(readFileSync(leasePath(dir, sessionId), "utf8"));
    if (typeof lease.expires === "number" && lease.expires > now) return lease;
  } catch { /* missing or corrupt: no active lease */ }
  return null;
}

/** Acquires a lease for messageIds/adapter, valid for ttlMs. Returns the lease on success, or
 * null when an unexpired lease is already held (double-wake guard) — the caller must not wake
 * in that case; the existing wake in flight, or its T1 waiter, owns this mail. */
export function acquireLease(dir, sessionId, { messageIds, adapter, ttlMs, now = Date.now() }) {
  if (readLease(dir, sessionId, now)) return null;
  mkdirSync(dir, { recursive: true });
  const lease = { messageIds, adapter, expires: now + ttlMs };
  const path = leasePath(dir, sessionId);
  const tmp = join(dir, `.wake-${sessionId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(lease));
  renameSync(tmp, path);
  return lease;
}

export function releaseLease(dir, sessionId) {
  try {
    rmSync(leasePath(dir, sessionId), { force: true });
  } catch { /* nothing to release */ }
}
