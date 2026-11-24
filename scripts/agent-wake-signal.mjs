#!/usr/bin/env node
/** Signal that the chat agent must wake (zero-token — no LLM). */
import fs from "node:fs";
import path from "node:path";
import { readPendingAgentReply } from "./display-queue.mjs";
import { classifyPriority } from "./priority.mjs";

function wakePath() {
  return (
    process.env.OPENCADRE_AGENT_WAKE_PATH ??
    path.join(process.env.HOME ?? "/tmp", ".cursor/opencadre-agent-wake.jsonl")
  );
}

export function signalAgentWake(entry) {
  const priority = classifyPriority(entry);
  const record = {
    at: new Date().toISOString(),
    priority,
    from: entry.from,
    threadId: entry.threadId,
    kind: entry.kind ?? "message",
    preview: (entry.body ?? entry.summary ?? "").slice(0, 200),
  };
  fs.mkdirSync(path.dirname(wakePath()), { recursive: true });
  fs.appendFileSync(wakePath(), `${JSON.stringify(record)}\n`);
  return record;
}

export function readPendingWake() {
  try {
    return fs
      .readFileSync(wakePath(), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function clearWakeSignals() {
  fs.writeFileSync(wakePath(), "");
}

/** Clear stale wake lines once display queue has no pending_agent_reply rows. */
export function clearWakeIfNoPending() {
  if (readPendingAgentReply().length > 0) return false;
  clearWakeSignals();
  return true;
}

if (process.argv[2] === "pending") {
  console.log(JSON.stringify(readPendingWake(), null, 2));
} else if (process.argv[2] === "clear-if-idle") {
  console.log(clearWakeIfNoPending() ? "cleared" : "skipped (pending replies exist)");
}
