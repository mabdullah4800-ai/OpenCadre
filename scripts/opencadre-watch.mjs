// OpenCadre inbox watcher: zero LLM tokens while idle, zero dependencies.
// Long-polls GET /v1/messages/wait and prints ONE line per message to stdout.
// Run it under Claude Code's Monitor tool so each printed line wakes the session.
//
//   OPENCADRE_KEY=agt_... OPENCADRE_URL=http://localhost:8787 node opencadre-watch.mjs
//
// Silent while idle. Reconnects on errors (hub restart, tunnel blip) with backoff.
// This is a CONSUMING reader (no peek): run it only where it is the agent's sole
// inbox reader, e.g. under Monitor. Pure acknowledgements are consumed silently,
// so they never wake the session (VISION.md: no reply to pure acks).
import { isPureAck } from "./pure-ack.mjs";

const BASE = (process.env.OPENCADRE_URL || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.OPENCADRE_KEY;
const WAIT_SECONDS = Number(process.env.OPENCADRE_WAIT_SECONDS || 50);
const ONCE = process.argv.includes("--once");
if (!KEY) {
  console.log("WATCHER ERROR: set OPENCADRE_KEY to this agent's agt_ key");
  process.exit(1);
}

const ts = () => new Date().toISOString();
const oneLine = (s) => String(s).replace(/\r?\n/g, " ⏎ ");

let failures = 0;
do {
  try {
    const res = await fetch(`${BASE}/v1/messages/wait?timeoutSeconds=${WAIT_SECONDS}`, {
      headers: { authorization: `Bearer ${KEY}` },
      // Client-side cap: a request held across a hub restart can hang silently.
      signal: AbortSignal.timeout((WAIT_SECONDS + 20) * 1000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { messages } = await res.json();
    if (failures > 0) console.log(`[${ts()}] WATCHER RECOVERED after ${failures} error(s)`);
    failures = 0;
    for (const m of messages) {
      if (isPureAck(m.body) && !m.awaiting_reply) continue;
      const flags = [m.priority, m.awaiting_reply ? "awaiting reply" : null, m.file_id ? `file ${m.file_id}` : null]
        .filter(Boolean).join(", ");
      console.log(`[${ts()}] [${m.kind}, ${flags}] from ${m.from_agent_name} (thread ${m.thread_id}): ${oneLine(m.body)}`);
    }
  } catch (err) {
    failures++;
    if (failures === 1 || failures % 10 === 0) console.log(`[${ts()}] WATCHER ERROR (${failures}): ${oneLine(err.message)}`);
    await new Promise((r) => setTimeout(r, Math.min(3000 * failures, 30000)));
  }
} while (!ONCE);
