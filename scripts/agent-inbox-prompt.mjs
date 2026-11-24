#!/usr/bin/env node
/**
 * Emit prompt for LLM agent to reply to pending OpenCadre mail.
 * NO reply text is generated here — the agent must reason and call mcp-send.mjs.
 */
import { readPendingAgentReply } from "./display-queue.mjs";
import { sortByHierarchy } from "./hierarchy.mjs";
import { clearWakeIfNoPending } from "./agent-wake-signal.mjs";

function formatEntry(record, i) {
  const inbound = record.inbound ?? record;
  return [
    `--- Message ${i + 1} (REPLY REQUIRED) ---`,
    `Thread: ${inbound.threadId}`,
    `From: ${inbound.from}`,
    `Kind: ${inbound.kind ?? "message"}`,
    inbound.fileId ? `File: ${inbound.fileId}` : "",
    "Body (verbatim):",
    inbound.body ?? inbound.summary ?? "",
    `Received: ${inbound.at ?? record.at ?? ""}`,
    // Always name the sender, so the reply routes correctly whatever the sender is called. This
    // used to omit --to for one specific fleet-supervisor name, which printed a command that
    // defaulted to a possibly-unrelated supervisor on every other hub. Do not reintroduce that
    // name, even in a comment: tests/watcher-scripts.test.ts greps this file for it and fails.
    `Reply: node scripts/mcp-send.mjs reply --to ${inbound.from} ${inbound.threadId} "<your reasoned reply>"`,
    `(mcp-send auto-marks replied after a successful send — do not duplicate-send the same body to other threads)`,
    "--- END ---",
  ]
    .filter(Boolean)
    .join("\n");
}

const pending = sortByHierarchy(readPendingAgentReply());

if (pending.length === 0) {
  clearWakeIfNoPending();
  console.log("OPENCADRE_INBOX_EMPTY");
  process.exit(0);
}

console.log("OPENCADRE_AGENT_REPLY_REQUIRED_BEGIN");
console.log(
  [
    "OpenCadre mail waiting. The zero-token pinger ingested these — it did NOT reply.",
    "YOU must read each message, reason, and send a real on-thread reply via mcp-send.mjs.",
    "Display inbound verbatim in chat. No template acks. No regex stubs.",
    "",
    ...pending.map((r, i) => formatEntry(r, i)),
    "",
    "OPENCADRE_AGENT_REPLY_REQUIRED_END",
  ].join("\n"),
);
