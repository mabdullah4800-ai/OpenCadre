/** Agent inbox reply path — single-flight, dedupe, auto mark-replied after send. */
import fs from "node:fs";
import path from "node:path";
import { markAgentReplied } from "./display-queue.mjs";

function stateDir() {
  return process.env.OPENCADRE_INBOX_STATE_DIR ?? path.join(process.env.HOME ?? "/tmp", ".cursor");
}

function dedupePath() {
  return path.join(stateDir(), "opencadre-send-dedupe.json");
}

function lockDir() {
  return path.join(stateDir(), "opencadre-send-locks");
}
const TURN_WINDOW_MS = Number(process.env.OPENCADRE_TURN_WINDOW_MS ?? "300000");
const LOCK_TIMEOUT_MS = Number(process.env.OPENCADRE_SEND_LOCK_MS ?? "30000");

function normalizeBody(body) {
  return body.trim().replace(/\s+/g, " ");
}

function dedupeKey(threadId, body) {
  return `${threadId}:${normalizeBody(body)}`;
}

function loadDedupeEntries() {
  try {
    const data = JSON.parse(fs.readFileSync(dedupePath(), "utf8"));
    const now = Date.now();
    return (data.entries ?? []).filter((entry) => now - entry.at < TURN_WINDOW_MS);
  } catch {
    return [];
  }
}

function saveDedupeEntries(entries) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(dedupePath(), JSON.stringify({ entries: entries.slice(-500) }));
}

export function resetSendState() {
  try {
    fs.unlinkSync(dedupePath());
  } catch {
    /* empty */
  }
  try {
    fs.rmSync(lockDir(), { recursive: true, force: true });
  } catch {
    /* empty */
  }
}

export function checkSendAllowed(threadId, body) {
  const normalized = normalizeBody(body);
  const key = dedupeKey(threadId, body);
  const entries = loadDedupeEntries();

  if (entries.some((entry) => entry.key === key)) {
    return { allowed: false, reason: "duplicate_thread_body" };
  }

  const crossThread = entries.find((entry) => entry.bodyKey === normalized && entry.threadId !== threadId);
  if (crossThread) {
    return {
      allowed: false,
      reason: "duplicate_body_cross_thread",
      priorThreadId: crossThread.threadId,
    };
  }

  return { allowed: true };
}

export function recordSend(threadId, body) {
  const normalized = normalizeBody(body);
  const entries = loadDedupeEntries();
  entries.push({
    key: dedupeKey(threadId, body),
    bodyKey: normalized,
    threadId,
    at: Date.now(),
  });
  saveDedupeEntries(entries);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withThreadLock(threadId, fn) {
  fs.mkdirSync(lockDir(), { recursive: true });
  const lockFile = path.join(lockDir(), `${threadId}.lock`);
  const started = Date.now();

  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      try {
        return await fn();
      } finally {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* empty */
        }
      }
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code !== "EEXIST") throw err;
      await sleep(50);
    }
  }

  throw new Error(`send lock timeout for thread ${threadId}`);
}

export async function sendAgentReply({ threadId, body, toAgent, mcpCall }) {
  const initial = checkSendAllowed(threadId, body);
  if (!initial.allowed) {
    return {
      ok: false,
      skipped: true,
      reason: initial.reason,
      text: `Skipped duplicate send (${initial.reason})`,
    };
  }

  return withThreadLock(threadId, async () => {
    const recheck = checkSendAllowed(threadId, body);
    if (!recheck.allowed) {
      return {
        ok: false,
        skipped: true,
        reason: recheck.reason,
        text: `Skipped duplicate send (${recheck.reason})`,
      };
    }

    let result = await mcpCall("reply", { threadId, body });
    if (!result.ok) {
      result = await mcpCall("send_message", {
        toAgent,
        body: `[Re thread ${threadId}] ${body}`,
      });
    }

    if (result.ok) {
      recordSend(threadId, body);
      markAgentReplied(threadId, { threadId, body, at: new Date().toISOString() });
    }

    return result;
  });
}
