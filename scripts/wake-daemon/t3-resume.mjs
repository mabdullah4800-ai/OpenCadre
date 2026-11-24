// T3 headless-resume adapters (docs/design/UNIVERSAL_WAKE.md, section 2 row T3; section 5 item 7):
// `codex exec resume <id> "<prompt>"` and `claude -p --resume <id>` wrappers.
//
// The one thing that matters here: a session already owned by a live UI (the desktop app, an
// interactive client) refuses the resume with a "thread-store conflict" (or Claude's analogous
// resume-lock message), and that refusal MUST be reported as `locked` and MUST NOT be retried —
// retrying a locked session is a retry storm against someone else's live conversation. A single
// subprocess call decides this; there is no separate non-invasive probe (doc section 4,
// "Alternative A"), so canWake() performs the actual invocation and wake() reuses its result
// (see the memoization note in adapter.mjs) rather than spawning a second time.

import { spawn } from "node:child_process";

// The injectable default: a direct call whose options always end in windowsHide: true, so the child opens no console
// window on Windows whatever the caller passes. A raw child_process function is never handed around (see
// tests/product-spawn-static-guard.test.ts).
function hiddenSpawn(command, args, options) {
  return spawn(command, [...args], { ...options, windowsHide: true });
}

const LOCK_MARKERS = [/thread-store conflict/i, /session (is )?locked/i, /resume lock/i];

function isLocked(text) {
  return LOCK_MARKERS.some((re) => re.test(text ?? ""));
}

function runResume({ command, args, timeoutMs, spawnFn }) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    let child;
    try {
      child = spawnFn(command, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: null, out: "", err: String(e?.message ?? e), timedOut: false, spawnFailed: true });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best effort */ }
      resolve({ code: null, out, err, timedOut: true, spawnFailed: false });
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, out, err: err || String(e?.message ?? e), timedOut: false, spawnFailed: true });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err, timedOut: false, spawnFailed: false });
    });
  });
}

/** Builds a T3 WakeAdapter. `buildArgs(session, digest)` returns the resume command's argv. */
function headlessResumeAdapter({ id, resumeCommand, buildArgs, timeoutMs = 20_000, verifyMs = 5000, spawnFn = hiddenSpawn }) {
  // Keyed by sessionId: canWake() and the immediately-following wake() for the SAME cycle share
  // one subprocess call, so a locked session is probed exactly once. When canWake finds it
  // locked, the orchestrator never calls wake() for this adapter (it fails over at once) — that
  // entry is cleaned up on a setImmediate after settling so it can never be replayed into a
  // LATER cycle (which must re-probe: the session may have unlocked by then).
  const inFlight = new Map();

  function invoke(session, digest) {
    const key = session.sessionId;
    if (!inFlight.has(key)) {
      const args = buildArgs(session, digest);
      const promise = runResume({ command: resumeCommand, args, timeoutMs, spawnFn });
      inFlight.set(key, promise);
      promise.finally(() => {
        setImmediate(() => {
          if (inFlight.get(key) === promise) inFlight.delete(key);
        });
      });
    }
    return inFlight.get(key);
  }

  return {
    id,
    tier: 3,
    idleTokenCost: "zero",
    verifyMs,
    async detect() {
      return true; // `connect` is responsible for confirming the CLI is installed/configured
    },
    async canWake(session, digest) {
      const result = await invoke(session, digest);
      if (isLocked(result.err) || isLocked(result.out)) return { ok: false, reason: "locked" };
      if (result.timedOut || result.spawnFailed) return { ok: false, reason: "no-owner" };
      if (result.code !== 0) return { ok: false, reason: "disabled" };
      return { ok: true };
    },
    async wake(session, digest) {
      const result = await invoke(session, digest);
      inFlight.delete(session.sessionId); // this cycle is done with it either way
      if (isLocked(result.err) || isLocked(result.out)) {
        return { attempted: false, detail: "locked: thread-store conflict, not retried" };
      }
      if (result.timedOut) return { attempted: false, detail: `timed out after ${timeoutMs}ms` };
      if (result.spawnFailed) return { attempted: false, detail: `spawn failed: ${result.err}` };
      return { attempted: result.code === 0, detail: result.code === 0 ? "resume turn started" : `exit ${result.code}: ${result.err}` };
    },
  };
}

export function codexExecResumeAdapter({ command = "codex", timeoutMs, verifyMs, spawnFn } = {}) {
  return headlessResumeAdapter({
    id: "codex-exec-resume",
    resumeCommand: command,
    buildArgs: (session, digest) => ["exec", "resume", session.threadId ?? session.sessionId, digest.line],
    timeoutMs, verifyMs, spawnFn,
  });
}

export function claudeResumeAdapter({ command = "claude", timeoutMs, verifyMs, spawnFn } = {}) {
  return headlessResumeAdapter({
    id: "claude-p-resume",
    resumeCommand: command,
    buildArgs: (session, digest) => ["-p", "--resume", session.threadId ?? session.sessionId, digest.line],
    timeoutMs, verifyMs, spawnFn,
  });
}

export { isLocked };
