#!/usr/bin/env node
/** Mark a thread as replied after LLM agent sent via mcp-send.mjs */
import { markAgentReplied } from "./display-queue.mjs";

const threadId = process.argv[2];
const outThread = process.argv[3] ?? "unknown";
if (!threadId) {
  console.error("usage: mark-agent-replied.mjs <inboundThreadId> [outboundThreadId]");
  process.exit(1);
}
const ok = markAgentReplied(threadId, { threadId: outThread, at: new Date().toISOString() });
console.log(ok ? "MARKED" : "NOT_FOUND");
process.exit(ok ? 0 : 1);
