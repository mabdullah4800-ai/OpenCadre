#!/usr/bin/env node
/**
 * Runnable connect → send → receive → reply smoke for any OpenCadre client class.
 * Works against a live hub (env vars) or injected URLs for local tests.
 *
 * Usage:
 *   node examples/clients/lib/inbox-smoke.mjs --mode rest
 *   node examples/clients/lib/inbox-smoke.mjs --mode mcp
 *   OPENCADRE_MCP_URL=... OPENCADRE_URL=... OPENCADRE_API_KEY=... node examples/clients/lib/inbox-smoke.mjs
 *
 * `--mode` omitted means `rest`. Both legs now assert OCCURRENCE — that the message just sent
 * arrived — but the default is the one a reader reaches without knowing which to pick, so it is the
 * one whose long-standing assertion was already sound.
 */
import { fileURLToPath } from "node:url";
import { loadEnvFile, mcpRequest, deriveRestBaseUrl } from "../../../scripts/mcp-smoke-test.mjs";

export function parseArgs(argv = process.argv.slice(2)) {
  // A MISSING --mode NOW DEFAULTS TO rest, where it used to default to mcp. The reason is not that
  // one transport is better: it is that the default should be the option whose assertions are SOUND,
  // so a reader who runs this by hand, or a lane that writes a new harness doc, cannot inherit a weak
  // check by omission. The MCP leg was the weaker one (see its receive block) and the usage block
  // listed `--mode mcp` first — so the path of least resistance led to the weaker instrument.
  //
  // Nothing breaks from this: all ten wrapper scripts in examples/clients/ pass --mode EXPLICITLY
  // (verified), so no existing caller's behaviour changes. The default only ever caught the case it
  // was silently getting wrong.
  const mode = argv.includes("--mode") ? argv[argv.indexOf("--mode") + 1] : "rest";
  const client = argv.includes("--client") ? argv[argv.indexOf("--client") + 1] : "generic";
  return { mode: mode === "rest" ? "rest" : "mcp", client };
}

export async function runInboxSmoke({
  mode = "mcp",
  client = "generic",
  mcpUrl,
  restBaseUrl,
  senderKey,
  receiverKey,
  fetchImpl = fetch,
} = {}) {
  const fileEnv = loadEnvFile();
  const url = mcpUrl ?? process.env.OPENCADRE_MCP_URL ?? fileEnv.OPENCADRE_MCP_URL;
  const key = senderKey ?? process.env.OPENCADRE_API_KEY ?? fileEnv.OPENCADRE_API_KEY;
  const restUrl = restBaseUrl ?? process.env.OPENCADRE_URL ?? fileEnv.OPENCADRE_URL ?? (url ? deriveRestBaseUrl(url) : "");
  const recvKey = receiverKey ?? key;
  const steps = [];

  if (!key || (mode === "mcp" && !url) || (mode === "rest" && !restUrl)) {
    return { client, mode, pass: false, steps: [{ name: "config", pass: false, detail: "Missing URL or API key" }] };
  }

  // UNIQUE PER RUN — AND THE RECEIVE LEGS' SAFETY DEPENDS ON THAT, not on the shape of their
  // assertions. Both transports now assert OCCURRENCE by matching this string (REST:
  // `messages.some((m) => m.body === pingBody)`; MCP: `recvText.includes(pingBody)`), which is what
  // makes a wrong-inbox peek fail. See `includes(pingBody)` in particular: a CONTAINMENT check would
  // also pass on any other message whose text contained this string, and nothing in the assertion
  // notices. It is safe only because the timestamp below cannot repeat.
  //
  // SO IF YOU CHANGE THIS LINE TO A CONSTANT — a literal body, a fixed string, a value shared
  // between runs — you SILENTLY REINTRODUCE that hole, in both legs, with every test still green.
  // The assertion is not what protects you; this uniqueness is. Keep `new Date().toISOString()` (or
  // another per-run value) or tighten the assertions to a structured match first.
  //
  // Found by 1051 while reviewing the MCP leg's fix (#478), which is when the property was noticed.
  const pingBody = `smoke from ${client} at ${new Date().toISOString()}`;
  let threadId = "";

  if (mode === "mcp") {
    // connect
    try {
      const init = await mcpRequest(url, key, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: `${client}-inbox-smoke`, version: "1.0" },
      }, fetchImpl);
      steps.push({ name: "connect", pass: init.ok, detail: init.ok ? "MCP initialize OK" : `HTTP ${init.status}` });
    } catch (err) {
      steps.push({ name: "connect", pass: false, detail: err instanceof Error ? err.message : String(err) });
    }

    // send (self-test: learn our own name from GET /v1/me, send to the supervisor or to self).
    // get_active_agents text is not a stable contract (states changed from online/offline in R1.4).
    try {
      let selfName;
      if (restUrl) {
        const me = await fetchImpl(`${restUrl}/v1/me`, { headers: { Authorization: `Bearer ${key}` } });
        if (me.ok) selfName = (await me.json()).agentName;
      }
      const toAgent = process.env.OPENCADRE_SUPERVISOR ?? selfName ?? "Supervisor";
      const sent = await mcpRequest(url, key, "tools/call", {
        name: "send_message",
        arguments: { toAgent, body: pingBody, priority: "low" },
      }, fetchImpl);
      const sentText = sent.data?.result?.content?.[0]?.text ?? "";
      threadId = sentText.match(/Thread: ([0-9a-f-]+)/i)?.[1] ?? "";
      steps.push({ name: "send", pass: sent.ok && !sentText.startsWith("Error:"), detail: sentText.slice(0, 100) });
    } catch (err) {
      steps.push({ name: "send", pass: false, detail: err instanceof Error ? err.message : String(err) });
    }

    // receive (peek — don't consume if sending to someone else)
    //
    // ASKS FOR THE MESSAGE JUST SENT, not for a response that is merely not-an-error. The previous
    // assertion was `recv.ok && !recvText.startsWith("Error:")`, which is TRUE for any non-error text
    // at all — including the empty inbox's `"No new messages."`. Measured: with the sender's inbox
    // peeked instead of the receiver's, that assertion reported PASS over a receive path that had
    // delivered nothing. Same defect as the REST leg (#476), one rung lower: it could not distinguish
    // a working receive from one reading nothing.
    //
    // THE MCP RESPONSE CARRIES THE BODY — measured, not assumed. A peek returns
    //   `1 message(s):\n[message, low] from <sender> (thread <id>): <body>`
    // so `includes(pingBody)` is an occurrence check, exactly as the REST leg does with
    // `messages.some((m) => m.body === pingBody)`.
    //
    // DELIBERATELY NOT ALSO MATCHING THE THREAD ID, though the text carries one: `threadId` exists
    // only if `send` succeeded, so requiring it here would make `receive` fail whenever `send` did —
    // collapsing two legs into one and destroying the per-leg attribution this smoke exists to give.
    // A leg asserts its own step.
    try {
      const recv = await mcpRequest(url, recvKey, "tools/call", { name: "get_messages", arguments: { peek: true } }, fetchImpl);
      const recvText = recv.data?.result?.content?.[0]?.text ?? "";
      const arrived = recvText.includes(pingBody);
      steps.push({
        name: "receive",
        pass: recv.ok && arrived,
        detail: `${recvText.split("\n")[0]?.slice(0, 60) ?? ""}; the one just sent ${arrived ? "ARRIVED" : "DID NOT ARRIVE"}`,
      });
    } catch (err) {
      steps.push({ name: "receive", pass: false, detail: err instanceof Error ? err.message : String(err) });
    }

    // reply (only if we got a thread from self-send loopback scenario)
    if (threadId) {
      try {
        const replied = await mcpRequest(url, recvKey, "tools/call", {
          name: "reply",
          arguments: { threadId, body: `ack smoke ${client}` },
        }, fetchImpl);
        const replyText = replied.data?.result?.content?.[0]?.text ?? "";
        steps.push({ name: "reply", pass: replied.ok && replyText.includes("Reply sent"), detail: replyText.slice(0, 60) });
      } catch (err) {
        steps.push({ name: "reply", pass: false, detail: err instanceof Error ? err.message : String(err) });
      }
    } else {
      steps.push({ name: "reply", pass: true, detail: "skipped (no thread — send was to another agent)" });
    }
  } else {
    // REST-only path
    try {
      const me = await fetchImpl(`${restUrl}/v1/me`, { headers: { Authorization: `Bearer ${key}` } });
      const meBody = await me.json();
      steps.push({ name: "connect", pass: me.ok, detail: me.ok ? `agent=${meBody.agentName}` : `HTTP ${me.status}` });
    } catch (err) {
      steps.push({ name: "connect", pass: false, detail: err instanceof Error ? err.message : String(err) });
    }

    try {
      const toAgent = process.env.OPENCADRE_SUPERVISOR ?? "Supervisor";
      const sent = await fetchImpl(`${restUrl}/v1/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ toAgent, body: pingBody, priority: "low" }),
      });
      const sentBody = await sent.json();
      threadId = sentBody.threadId ?? "";
      steps.push({ name: "send", pass: sent.ok, detail: sent.ok ? `thread ${threadId}` : JSON.stringify(sentBody).slice(0, 80) });
    } catch (err) {
      steps.push({ name: "send", pass: false, detail: err instanceof Error ? err.message : String(err) });
    }

    // receive (peek — don't consume if sending to someone else)
    //
    // ASKS FOR THE MESSAGE JUST SENT, not for a non-empty inbox. The previous assertion was
    // `recv.ok && count >= 0`, true for EVERY array including an empty one: it checked the response's
    // SHAPE, not that delivery OCCURRED, so it passed while nothing had arrived. Found by 1051 while
    // reviewing the Goal 1 smoke run — the run's own transcript had printed `PASS receive: 0
    // message(s) peek` over broken addressing, and nobody read it as a failure.
    //
    // `count >= 1` would be stronger but still wrong: it passes on SOMEONE ELSE'S message — a stale
    // row in the receiver's inbox, or a leftover from a previous smoke in the same org — so it can go
    // green while the send/receive path under test is broken. Matching the BODY asserts the
    // OCCURRENCE, and also catches the subtler failure of a leg returning the WRONG messages.
    //
    // pingBody is unique per run (`smoke from <client> at <ISO>`), so the match is exact rather than
    // heuristic — no new machinery is needed for it.
    try {
      // PEEKED AS THE RECEIVER. If this read any other principal the leg would fail on CORRECT code,
      // which is worse than a leg that cannot fail — so this identity is load-bearing, not incidental.
      // OPENCADRE_SUPERVISOR above is what makes the send go TO the receiver in the first place.
      const recv = await fetchImpl(`${restUrl}/v1/messages?peek=true`, { headers: { Authorization: `Bearer ${recvKey}` } });
      const recvBody = await recv.json();
      const messages = Array.isArray(recvBody.messages) ? recvBody.messages : null;
      const arrived = messages?.some((m) => m?.body === pingBody) ?? false;
      steps.push({
        name: "receive",
        pass: recv.ok && arrived,
        detail: messages === null
          ? "no messages[] in the response"
          : `${messages.length} message(s) peek; the one just sent ${arrived ? "ARRIVED" : "DID NOT ARRIVE"}`,
      });
    } catch (err) {
      steps.push({ name: "receive", pass: false, detail: err instanceof Error ? err.message : String(err) });
    }

    if (threadId) {
      try {
        const replied = await fetchImpl(`${restUrl}/v1/messages/${threadId}/reply`, {
          method: "POST",
          headers: { Authorization: `Bearer ${recvKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ body: `ack smoke ${client}` }),
        });
        steps.push({ name: "reply", pass: replied.ok, detail: replied.ok ? "Reply sent" : `HTTP ${replied.status}` });
      } catch (err) {
        steps.push({ name: "reply", pass: false, detail: err instanceof Error ? err.message : String(err) });
      }
    } else {
      steps.push({ name: "reply", pass: true, detail: "skipped (no thread)" });
    }
  }

  return { client, mode, pass: steps.every((s) => s.pass), steps };
}

async function main() {
  const { mode, client } = parseArgs();
  const result = await runInboxSmoke({ mode, client });
  console.log(`\n=== ${client} inbox smoke (${mode}) ===`);
  for (const s of result.steps) {
    console.log(`${s.pass ? "PASS" : "FAIL"}  ${s.name}: ${s.detail}`);
  }
  console.log(result.pass ? "RESULT: PASS\n" : "RESULT: FAIL\n");
  process.exit(result.pass ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
