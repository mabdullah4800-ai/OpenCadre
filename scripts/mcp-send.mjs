#!/usr/bin/env node
/** Send OpenCadre reply or message from CLI (used by LLM agent, not the pinger). */
import fs from "node:fs";
import path from "node:path";
import { sendAgentReply } from "./agent-inbox.mjs";
import { classifyRecipient, phantomWarning } from "./phantom-identity.mjs";

const ENV_FILE = process.env.OPENCADRE_ENV_FILE ?? path.join(process.env.HOME ?? "/tmp", ".cursor/opencadre-watcher.env");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const MCP_URL = process.env.OPENCADRE_MCP_URL;
const API_KEY = process.env.OPENCADRE_API_KEY;
// No default: a retracted name here silently misroutes mail to an agent that no
// longer exists. Callers must name a recipient or set OPENCADRE_SUPERVISOR.
const SUPERVISOR = process.env.OPENCADRE_SUPERVISOR ?? "";
// The roster lives on REST even when messages go over MCP.
const REST_URL = (MCP_URL ?? "").replace(/\/mcp\/?$/, "");

/** Warn (never refuse) when the recipient looks like a phantom: on the roster, nothing behind it. */
async function warnIfPhantom(toAgent) {
  if (!toAgent || !REST_URL) return;
  try {
    const res = await fetch(`${REST_URL}/v1/agents`, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const { agents } = await res.json();
    const row = (agents ?? []).find((a) => a.name === toAgent);
    const line = phantomWarning(classifyRecipient(row));
    if (line) console.error(line);
  } catch {
    // Never let a diagnostic failure block a send.
  }
}

async function mcpCall(name, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  if (!line) return { ok: false, text };
  const data = JSON.parse(line.slice(6));
  const content = data?.result?.content?.[0]?.text ?? text;
  return { ok: !String(content).startsWith("Error:"), text: content };
}

const args = process.argv.slice(2);
const mode = args[0];
let toAgent = SUPERVISOR;
let threadId = args[1];
let bodyParts = args.slice(2);
if (args[1] === "--to" && args[2]) {
  toAgent = args[2];
  threadId = args[3];
  bodyParts = args.slice(4);
}
const body = bodyParts.join(" ");
if (!mode || !body) {
  console.error("usage: mcp-send.mjs reply <threadId> <body>");
  console.error("       mcp-send.mjs reply --to <toAgent> <threadId> <body>");
  console.error("       mcp-send.mjs send <toAgent> <body>");
  process.exit(1);
}

let result;
if (mode === "reply") {
  if (!threadId) {
    console.error("reply requires threadId");
    process.exit(1);
  }
  // Warn once, after the recipient is final. For `send` the recipient is not
  // known until args[1] ?? SUPERVISOR is resolved below, so warning here for
  // both modes would double-fetch the roster and can warn about the wrong name.
  await warnIfPhantom(toAgent);
  result = await sendAgentReply({ threadId, body, toAgent, mcpCall });
} else if (mode === "send") {
  toAgent = args[1] ?? SUPERVISOR;
  if (!toAgent) {
    console.error("send requires a recipient: pass <toAgent>, or set OPENCADRE_SUPERVISOR");
    process.exit(1);
  }
  await warnIfPhantom(toAgent);
  result = await mcpCall("send_message", { toAgent, body });
} else {
  console.error("unknown mode", mode);
  process.exit(1);
}
console.log(result.text);
process.exit(result.ok ? 0 : 1);
