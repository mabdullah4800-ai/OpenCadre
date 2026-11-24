#!/usr/bin/env node
// Session state writer for the universal wake daemon (docs/design/UNIVERSAL_WAKE.md, section 3).
// Zero dependencies. Installed as a hook command in Claude Code, Codex, Cursor and Gemini CLI:
//
//   node scripts/wake-state-hook.mjs --surface claude-code|codex|cursor|gemini
//
// Reads the hook JSON on stdin and atomically writes ~/.opencadre/state/<sessionId>.json:
//   {surface, sessionId, threadId, agentKeyHash, status, since, pid, waiterArmedAt}
// so the daemon can tell whether a session is busy, idle, blocked on a permission prompt, or gone.
//
// A hook must never block or add context: this always exits 0 with no stdout, writes nothing for
// events it doesn't track, and swallows every error.
//
// Env: OPENCADRE_WAKE_STATE_DIR overrides the base directory (default ~/.opencadre); files go in <base>/state.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Event names are distinct across clients, so one table covers all four.
const STATUS_BY_EVENT = {
  SessionStart: "idle", sessionStart: "idle",
  UserPromptSubmit: "busy", beforeSubmitPrompt: "busy", BeforeAgent: "busy",
  Stop: "idle", stop: "idle", AfterAgent: "idle",
  PermissionRequest: "blocked",
  SessionEnd: "gone", sessionEnd: "gone",
};

// The id becomes a file name, so anything that could leave the state dir is rejected.
const SAFE_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/;

function statusFor(payload) {
  const event = payload.hook_event_name ?? payload.hookEventName;
  // Claude Code reports permission prompts as a Notification; other notifications aren't state changes.
  if (event === "Notification") return payload.notification_type === "permission_prompt" ? "blocked" : null;
  return Object.hasOwn(STATUS_BY_EVENT, event) ? STATUS_BY_EVENT[event] : null;
}

function readPrevious(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Windows refuses a rename while another process is renaming onto the same file; retry briefly.
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * attempt);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const surface = args.includes("--surface") ? args[args.indexOf("--surface") + 1] ?? null : null;

  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== "object") return;

  const status = statusFor(payload);
  const sessionId = payload.session_id ?? payload.sessionId ?? payload.conversation_id ?? payload.conversationId;
  if (!status || typeof sessionId !== "string" || !SAFE_ID.test(sessionId)) return;

  const dir = join(process.env.OPENCADRE_WAKE_STATE_DIR || join(homedir(), ".opencadre"), "state");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.json`);
  const previous = readPrevious(file);

  const state = {
    surface,
    sessionId,
    threadId: payload.thread_id ?? payload.threadId ?? payload.conversation_id ?? payload.conversationId ?? sessionId,
    // Filled in once the shared key resolver (scripts/opencadre-config.mjs) lands; the key itself is never stored.
    agentKeyHash: null,
    status,
    // since = when this status began, so a repeated event doesn't reset it.
    since: previous.status === status && previous.since ? previous.since : new Date().toISOString(),
    // The hook exits at once; its parent is the long-lived client process.
    pid: process.ppid,
    // Owned by the T1 waiter hooks; carried over so this writer never clears it.
    waiterArmedAt: previous.waiterArmedAt ?? null,
  };

  const tmp = join(dir, `.${sessionId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(state));
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

try {
  await main();
} catch {
  // Silent by design: see the header.
}
process.exitCode = 0;
