// Standalone background bridge -- genuinely independent of any single Claude
// Code turn (that session can only act when invoked; this is a real, always-
// running process). Long-polls OpenCadre for new messages addressed to this
// agent and logs each one once, with a timestamp.
//
// Peek-only: it never marks mail read, so it can run next to the agent's real
// reader without stealing messages. An afterId cursor (the last message it
// printed) keeps it from re-printing, or spinning on, mail it already showed.
//
// Honest scope: this makes messages visible to anything watching the log (a
// human, or a Claude Code session reading it on its next turn). It does NOT
// make a tool-call-driven agent (Cursor cloud, or Claude Code itself)
// continuously "alive" between turns -- see docs/*.md's live-vs-async
// discussion.
//
//   node poll-bridge.mjs <agent-api-key>

const BASE_URL = (process.env.OPENCADRE_URL || "http://localhost:8787").replace(/\/$/, "");
const API_KEY = process.argv[2];
const WAIT_SECONDS = Number(process.env.OPENCADRE_WAIT_SECONDS || 50);

if (!API_KEY) {
  console.error("Usage: node poll-bridge.mjs <agent-api-key>");
  process.exit(1);
}

const ts = () => new Date().toISOString();
let afterId = "";

console.log(`[${ts()}] opencadre poll-bridge starting (peek-only long-poll) against ${BASE_URL}`);
for (;;) {
  try {
    const cursor = afterId ? `&afterId=${encodeURIComponent(afterId)}` : "";
    const res = await fetch(`${BASE_URL}/v1/messages/wait?peek=true&timeoutSeconds=${WAIT_SECONDS}${cursor}`, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout((WAIT_SECONDS + 20) * 1000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { messages } = await res.json();
    for (const m of messages) {
      console.log(
        `[${ts()}] NEW ${m.kind} [${m.priority}]${m.awaiting_reply ? " (awaiting reply)" : ""} ` +
        `from ${m.from_agent_name} (thread ${m.thread_id}): ${m.body}`,
      );
      afterId = m.id;
    }
  } catch (err) {
    console.error(`[${ts()}] poll error:`, err.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
