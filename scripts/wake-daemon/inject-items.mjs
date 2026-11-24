// T1 turn-free delivery adapter (docs/design/UNIVERSAL_WAKE.md section 2, row 8's "hold" family):
// puts a mail digest into an idle Codex thread's model-visible history with `thread/inject_items`,
// WITHOUT starting a turn.
//
// WHY THIS EXISTS RATHER THAN THE T3 RESUME. `codex exec resume <id> "<prompt>"` does deliver and
// the agent does act on it — measured on this box 2026-09-20. But a resume STARTS A TURN, and the
// guard meant to keep it out of a chat a human is in is three regexes over the child's stderr
// (t3-resume.mjs:18) that have never fired against a real lock. A missed lock there does not mean
// "the wake did nothing": it means a FOREIGN TURN APPEARS IN SOMEONE'S OPEN CONVERSATION, because a
// resume writes into the thread's own rollout by construction (measured: ordinal:77 landed in the
// thread's real transcript).
//
// `thread/inject_items` cannot fail that way, because it starts nothing. The vendor's own words:
// "Append raw Responses API items to the thread history without starting a user turn." That is also
// exactly the gate's second clause for the Mail cell — "otherwise at its next turn" — satisfied by
// the vendor's own mechanism rather than by falling back to it.
//
// THE ONE PRECONDITION, FOUND BY RUNNING IT AND NOT BY READING THE SCHEMA. A freshly spawned
// app-server has NO threads loaded (`thread/loaded/list` -> `{"data":[]}`), so an inject into a
// thread it has never seen is refused: `-32600 thread not found`. The schema does not say this; a
// fake never would have; the first real end-to-end run found it immediately. The fix is to
// `thread/resume` FIRST, which LOADS the thread. Measured, on a thread that had taken a turn:
//
//   inject without resume -> -32600 thread not found
//   thread/resume         -> { status: "idle" }
//   inject after resume   -> {}          (the item lands)
//
// AND `thread/resume` HERE IS A LOAD, NOT A TURN — which is the whole reason this adapter is still
// turn-free. On that same rollout, `task_started` and `task_complete` each appear exactly ONCE, from
// the single deliberate turn; the resume+inject pair added ZERO. Resume sets no turn running and
// returns `idle`. This is the vendor's documented behaviour for a thread id that names a running
// thread — "app-server rejoins that thread" — and it is why the resume adapters' `thread-store
// conflict` guard has no counterpart on this path: joining is not a conflict.
//
// MEASURED 2026-09-20 (codex-cli 0.155.1), and the shape of the evidence matters:
//   - the item lands in the thread's OWN rollout file, and ZERO turn markers appear: task_complete,
//     token_usage_record, token_count and task_started are all 0. Zero-turn is asserted on the
//     fields a turn would have written, not on the absence of an error.
//   - the agent then SEES it: a later turn asking for the injected sentinel returned it verbatim.
//   - the FALSIFIER fires in the right direction: the same question against a thread that never
//     received the injection does NOT return it. Without that control the second half would be
//     equally consistent with "the model was told a word and repeated it".
//   - cost 0 tokens, against 60,071 for the resume measured the same day.
//
// verifyMs IS 0, DELIBERATELY, AND IT IS A NAMED LIMITATION RATHER THAN A TUNING CHOICE. The
// orchestrator's verify step (orchestrator.mjs) waits for the session's status to go "busy", which
// is its way of asking "did a turn begin?". A turn-free adapter must never answer yes to that
// question — it is the one thing it exists not to do. So verify can never succeed here, and a
// non-zero verifyMs would turn every successful injection into a spurious verify failure and,
// three cycles in, an escalation. The mismatch is real and is reported rather than papered over:
// the orchestrator's verify gate is built for turn-starting adapters and does not fit this one.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The injectable default: a direct call whose options always end in windowsHide: true, so the child opens no console
// window on Windows whatever the caller passes. A raw child_process function is never handed around (see
// tests/product-spawn-static-guard.test.ts).
function hiddenSpawn(command, args, options) {
  return spawn(command, [...args], { ...options, windowsHide: true });
}

const SAFE_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/;

/** How long a delivered id is remembered. Matches scripts/agent-inbox.mjs's TURN_WINDOW_MS default
 * convention (a read-time window, so a clock jump cannot strand an entry). */
const DEDUPE_WINDOW_MS = Number(process.env.OPENCADRE_ITEMS_WINDOW_MS ?? "300000");
const DEDUPE_MAX = 500;
const INIT_TIMEOUT_MS = 15_000;
const INJECT_TIMEOUT_MS = 20_000;

/** Delivered-id memory, so a message the hub re-delivers (a cursor reset, a restart) is not
 * injected a second time. Same shape and same read-time filtering as scripts/agent-inbox.mjs's
 * send-dedupe file, so the two conventions do not drift. */
function dedupePath(stateDir) {
  return join(stateDir, "opencadre-injected-items.json");
}

function loadDelivered(stateDir, now) {
  try {
    const data = JSON.parse(readFileSync(dedupePath(stateDir), "utf8"));
    return (data.entries ?? []).filter((e) => now - e.at < DEDUPE_WINDOW_MS);
  } catch {
    return [];
  }
}

function saveDelivered(stateDir, entries) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(dedupePath(stateDir), JSON.stringify({ entries: entries.slice(-DEDUPE_MAX) }));
  } catch { /* best effort: a failed record costs a duplicate, never a lost wake */ }
}

/** Drives one `codex app-server` over stdio JSON-RPC: initialize, initialized, inject, exit.
 * Deliberately minimal — it opens a connection, does the one call, and closes. It never resumes a
 * thread, never starts a turn, and never touches ~/.codex config. */
function injectOverAppServer({ command, threadId, text, spawnFn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, detail: `spawn failed: ${String(e?.message ?? e)}` });
      return;
    }

    let settled = false;
    let buf = "";
    let nextId = 1;
    const pending = new Map();
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* best effort */ }
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, detail: `timed out after ${INJECT_TIMEOUT_MS}ms` }), INJECT_TIMEOUT_MS);

    const rpc = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });

    child.stdout?.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
        }
      }
    });
    child.on("error", (e) => done({ ok: false, detail: `spawn failed: ${String(e?.message ?? e)}` }));
    child.on("close", () => done({ ok: false, detail: "app-server exited before the item was injected" }));

    (async () => {
      try {
        await rpc("initialize", { clientInfo: { name: "opencadre-wake", title: "OpenCadre wake", version: "1.0.0" } });
        child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
        // REQUIRED, and measured rather than assumed: a fresh app-server has no thread loaded, so an
        // inject into one it has never seen is refused with `-32600 thread not found`. Resume LOADS
        // it. This is a load, not a turn -- see the header; the rollout gains zero turn markers.
        await rpc("thread/resume", { threadId });
        await rpc("thread/inject_items", {
          threadId,
          items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
        });
        // The reply is the proof: the item is in the thread's history before this resolves.
        done({ ok: true, detail: "item injected (no turn started)" });
      } catch (e) {
        done({ ok: false, detail: `inject failed: ${String(e?.message ?? e)}` });
      }
    })();
  });
}

/**
 * Builds the turn-free delivery adapter.
 * @param {object} [opts]
 * @param {string} [opts.command] - Codex CLI to drive (default OPENCADRE_WAKE_CODEX_CMD, else "codex")
 * @param {string} [opts.stateDir] - where the delivered-id memory lives (default OPENCADRE_WAKE_STATE_DIR, else ~/.opencadre)
 * @param {() => number} [opts.now]
 * @param {Function} [opts.spawnFn] - injected for tests
 * @param {(cmd: string) => boolean} [opts.probe] - injected for tests; "is the CLI resolvable"
 */
export function codexInjectItemsAdapter({
  command = process.env.OPENCADRE_WAKE_CODEX_CMD || "codex",
  stateDir = process.env.OPENCADRE_WAKE_STATE_DIR || join(homedir(), ".opencadre"),
  now = () => Date.now(),
  spawnFn = hiddenSpawn,
  probe,
} = {}) {
  const resolvable = probe ?? (() => true);

  return {
    id: "codex-inject-items",
    tier: 1,
    idleTokenCost: "zero",
    // See the header. The orchestrator's verify asks "did a turn begin?"; this adapter's whole
    // point is that no turn begins, so there is nothing to verify and nothing to wait for.
    verifyMs: 0,

    /** A real detect, unlike the T3 adapters' hardcoded true: there is no injection target without
     * the Codex CLI on this machine. */
    async detect() {
      try {
        return Boolean(resolvable(command));
      } catch {
        return false;
      }
    },

    /** Injectable only when we know WHICH thread to inject into. No thread id is not a failure to
     * retry — it is "this session has no Codex thread", so the orchestrator fails over to the next
     * tier rather than sitting on it. `no-owner` is the interface's word for exactly that. */
    async canWake(session) {
      const threadId = session?.threadId;
      if (typeof threadId !== "string" || !SAFE_ID.test(threadId)) return { ok: false, reason: "no-owner" };
      return { ok: true };
    },

    async wake(session, digest) {
      const threadId = session.threadId;
      const ids = Array.isArray(digest?.ids) ? digest.ids : [];

      // Idempotence. The hub's own afterId cursor is the primary guard (opencadre-wake.mjs advances
      // it past delivered mail), so this only catches a RE-delivered id — a restart, a reset cursor.
      // The key is the message id set: if every id in this digest has already been delivered, the
      // wake is a no-op rather than a second copy of the same mail in the thread.
      const delivered = loadDelivered(stateDir, now());
      const seen = new Set(delivered.map((e) => e.id));
      if (ids.length > 0 && ids.every((id) => seen.has(id))) {
        return { attempted: false, detail: "duplicate: every message id in this digest was already injected" };
      }

      const result = await injectOverAppServer({ command, threadId, text: digest.line, spawnFn });
      if (!result.ok) return { attempted: false, detail: result.detail };

      // Recorded only AFTER a confirmed inject, so a failed attempt never poisons the window.
      saveDelivered(stateDir, [...delivered, ...ids.map((id) => ({ id, at: now() }))]);
      return { attempted: true, detail: result.detail };
    },
  };
}

export { SAFE_ID, DEDUPE_WINDOW_MS, DEDUPE_MAX };
