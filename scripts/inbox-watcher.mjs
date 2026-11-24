#!/usr/bin/env node
/**
 * Zero-token inbox ingest — NO reply generation.
 * Holds /live + poll fallback, queues mail, wakes agent for LLM replies.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPriority } from "./priority.mjs";
import { appendExchange } from "./display-queue.mjs";
import { buildWakePrompt } from "./webhook-wake-prompt.mjs";
import { signalAgentWake } from "./agent-wake-signal.mjs";
import { isPureAck } from "./pure-ack.mjs";
import { classifyRecipient, phantomWarning } from "./phantom-identity.mjs";

const MCP_URL = process.env.OPENCADRE_MCP_URL;
const API_KEY = process.env.OPENCADRE_API_KEY;
if (!MCP_URL || !API_KEY) {
  console.error("Missing OPENCADRE_MCP_URL or OPENCADRE_API_KEY");
  process.exit(1);
}

// Identity is required, never defaulted. A watcher that guesses its own name, or
// falls back to a name the fleet has retired, runs happily and watches nobody --
// the failure is silent, so it has to be made impossible instead of documented.
const SELF = process.env.OPENCADRE_AGENT_NAME ?? "";
if (!SELF) {
  console.error(
    "inbox-watcher: OPENCADRE_AGENT_NAME is required. Set it to the agent name this " +
      "watcher runs as (the same name the hub knows); there is no default because a " +
      "wrong guess wakes nobody.",
  );
  process.exit(1);
}

const SUPERVISOR = process.env.OPENCADRE_SUPERVISOR ?? "";
const WATCH_PEERS = (process.env.OPENCADRE_WATCH_PEERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const POLL_SECONDS = Number(process.env.OPENCADRE_POLL_SECONDS ?? "2");
const WEBHOOK_URL = process.env.OPENCADRE_AGENT_WEBHOOK_URL ?? "";
const WEBHOOK_INCLUDE_PROMPT = process.env.OPENCADRE_WEBHOOK_INCLUDE_PROMPT !== "0";
const LOG_PATH = process.env.OPENCADRE_WATCHER_LOG ?? path.join(process.env.HOME ?? "/tmp", ".cursor/opencadre-watcher.log");
const QUEUE_PATH = process.env.OPENCADRE_QUEUE_PATH ?? path.join(process.env.HOME ?? "/tmp", ".cursor/opencadre-inbox-queue.jsonl");
const SEEN_PATH = path.join(path.dirname(QUEUE_PATH), "opencadre-inbox-seen.json");
const REST_URL = MCP_URL.replace(/\/mcp\/?$/, "");
const LIVE_URL = `${REST_URL.replace(/^http/i, "ws")}/live`;

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  fs.appendFileSync(LOG_PATH, msg);
  process.stdout.write(msg);
}

function shouldWatch(from) {
  if (from === SELF) return false;
  if (WATCH_PEERS.length === 0) return true;
  return WATCH_PEERS.includes(from);
}

function loadSet(filePath) {
  try {
    return new Set(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return new Set();
  }
}

function saveSet(filePath, set) {
  fs.writeFileSync(filePath, JSON.stringify([...set].slice(-500)));
}

const seen = loadSet(SEEN_PATH);

function enqueue(entry) {
  // Message ids dedupe a live push against the same message fetched by the poll.
  const key = entry.id ?? `${entry.threadId}:${(entry.body ?? entry.summary ?? "").slice(0, 80)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  saveSet(SEEN_PATH, seen);
  const priority = entry.hubPriority === "high" ? "high" : classifyPriority(entry);
  fs.appendFileSync(QUEUE_PATH, `${JSON.stringify({ ...entry, priority })}\n`);
  log(`queued from ${entry.from} thread=${entry.threadId}`);
  return true;
}

async function notifyWebhook(entry) {
  if (!WEBHOOK_URL) return;
  try {
    const wake = WEBHOOK_INCLUDE_PROMPT ? buildWakePrompt() : { empty: true };
    const headers = { "content-type": "application/json" };
    const authHeader = process.env.OPENCADRE_WEBHOOK_AUTH_HEADER;
    if (authHeader) headers.authorization = authHeader;
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        source: "opencadre-ingest-wake",
        from: entry.from,
        threadId: entry.threadId,
        prompt: wake.empty ? undefined : wake.prompt,
      }),
    });
    log(`webhook notified thread=${entry.threadId}`);
  } catch (err) {
    log(`webhook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleInboundMail(rawEntry) {
  const entry = rawEntry;
  // Queue EVERY message durably; WATCH_PEERS only decides who may wake the agent.
  if (!enqueue(entry)) return;
  if (!shouldWatch(entry.from)) {
    log(`queued without wake (sender outside watch peers) thread=${entry.threadId} from=${entry.from}`);
    return;
  }

  const body = entry.body ?? entry.summary ?? "";
  if (isPureAck(body)) {
    appendExchange({ at: new Date().toISOString(), priority: classifyPriority(entry), inbound: entry, shown: true, status: "skipped_pure_ack" });
    log(`pure-ack skipped thread=${entry.threadId} from=${entry.from}`);
    return;
  }

  appendExchange({ at: new Date().toISOString(), priority: classifyPriority(entry), inbound: entry, shown: false, status: "pending_agent_reply" });
  signalAgentWake(entry);
  await notifyWebhook(entry);
  log(`agent-wake signaled thread=${entry.threadId} from=${entry.from} (no auto-reply)`);
}

function toEntry(m) {
  return {
    id: m.id, kind: m.kind, from: m.from_agent_name, threadId: m.thread_id, body: m.body,
    fileId: m.file_id ?? null, hubPriority: m.priority, awaitingReply: Boolean(m.awaiting_reply), at: new Date().toISOString(),
  };
}

// One consuming read over REST JSON: the rows returned are exactly the rows marked
// read, and each is queued before the next poll. (The old MCP text path peeked,
// consumed separately, and its regex dropped high/low priority mail and replies.)
async function pollInbox() {
  try {
    const res = await fetch(`${REST_URL}/v1/messages`, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { messages } = await res.json();
    for (const m of messages) await handleInboundMail(toEntry(m));
  } catch (err) {
    log(`poll error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleLivePayload(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!["message", "question", "reply"].includes(payload.type)) return;
  void handleInboundMail({
    id: payload.id,
    kind: payload.type,
    hubPriority: payload.priority,
    from: payload.from,
    threadId: payload.threadId ?? "unknown",
    body: payload.body ?? "",
    fileId: payload.fileId ?? null,
    at: new Date().toISOString(),
    live: true,
  });
}

function connectLive() {
  const url = `${LIVE_URL}?apiKey=${encodeURIComponent(API_KEY)}`;
  log(`connecting live ${LIVE_URL}`);
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => log("live connected"));
  ws.addEventListener("message", (e) => handleLivePayload(String(e.data)));
  ws.addEventListener("close", (e) => {
    log(`live closed code=${e.code}`);
    setTimeout(connectLive, 5000);
  });
}

// Ask the hub who exists. The watcher is only useful if its own name is a live
// agent: a retired name queues mail forever and wakes nothing, and nothing in the
// log used to say so. Fail loudly at startup instead.
//
// Then warn (never refuse) if our own row looks like a phantom -- on the roster but
// nothing behind it, which is the same silent-death shape one step softer. A real
// agent mid-startup is indistinguishable from a phantom, so this only reports.
async function assertSelfIsLive() {
  try {
    const res = await fetch(`${REST_URL}/v1/agents`, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log(`could not verify agent name (HTTP ${res.status}); starting anyway`);
      return;
    }
    const { agents } = await res.json();
    const rows = agents ?? [];
    const names = rows.map((a) => a.name);
    if (!names.includes(SELF)) {
      console.error(
        `inbox-watcher: unknown agent "${SELF}" -- the hub has no such agent, so this ` +
          `watcher would wake nobody. Live agents: ${names.join(", ") || "(none)"}`,
      );
      process.exit(1);
    }
    log(`verified self=${SELF} is a live agent`);
    const line = phantomWarning(classifyRecipient(rows.find((a) => a.name === SELF)));
    if (line) log(line);
  } catch (err) {
    log(`could not verify agent name (${err instanceof Error ? err.message : String(err)}); starting anyway`);
  }
}

export function startWatcher() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  log(
    `ingest-wake-only starting self=${SELF} watch=${WATCH_PEERS.join("|") || "(all)"} ` +
      `${SUPERVISOR ? `supervisor=${SUPERVISOR} ` : ""}poll=${POLL_SECONDS}s auto-reply=OFF`,
  );
  void assertSelfIsLive().then(() => {
    connectLive();
    setInterval(() => void pollInbox(), POLL_SECONDS * 1000);
    void pollInbox();
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startWatcher();
