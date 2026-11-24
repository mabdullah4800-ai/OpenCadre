import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createOrganization, getMessages, registerAgent, sendMessage, askClarification, setAgentWebhook } from "../src/service.js";
import { setLogSink } from "../src/log.js";

// Webhooks now go through the SSRF guard (src/webhook-guard.ts), which only reaches public https hosts.
// These delivery tests use a real local receiver, so they lift that rule the way local development does.
interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}
let received: Received[] = [];
let respondWith = 200;
/** Statuses to answer in order before falling back to respondWith. */
let script: number[] = [];
/** Runs as each delivery arrives, before it is answered. */
let onReceive: (() => void) | undefined;
/** The hub's log lines, which say when a wake's retry chain has ended. */
let logs: Array<{ msg: string; status?: number }> = [];
let restoreLog: () => void;
let receiver: http.Server;
let hookUrl: string;

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      onReceive?.();
      res.statusCode = script.shift() ?? respondWith;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhook`;
});
afterAll(() => new Promise<void>((r) => receiver.close(() => r())));

beforeEach(() => {
  received = [];
  respondWith = 200;
  script = [];
  onReceive = undefined;
  logs = [];
  restoreLog = setLogSink((line) => logs.push(JSON.parse(line)));
  vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
  vi.stubEnv("OPENCADRE_WEBHOOK_RETRY_MS", "20,40");
});
afterEach(() => {
  restoreLog();
  vi.unstubAllEnvs();
});
const gaveUp = () => logs.some((l) => l.msg === "webhook gave up after retries");

function setupOrgWithTwoAgents() {
  const { orgId } = createOrganization("Webhook Test Org");
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return { orgId, a: { id: a.agentId, name: "Agent A" }, b: { id: b.agentId, name: "Agent B" }, bAgentId: b.agentId };
}

async function until(predicate: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

describe("webhook notification on offline delivery", () => {
  it("fires the registered webhook when send_message can't deliver live", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    setAgentWebhook(orgId, bAgentId, hookUrl, "Bearer cursor-key");

    await sendMessage(orgId, a, "Agent B", "hello");
    await until(() => received.length > 0);

    expect(received).toHaveLength(1);
    expect(received[0].path).toBe("/webhook");
    expect(received[0].headers.authorization).toBe("Bearer cursor-key");
    expect(received[0].body).toMatchObject({ type: "message", body: "hello" });
  });

  it("fires the webhook for an offline ask_clarification too, with awaitingReply true", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    setAgentWebhook(orgId, bAgentId, hookUrl, null);

    await askClarification(orgId, a, "Agent B", "are we good?", 1);
    await until(() => received.length > 0);

    expect(received[0].body).toMatchObject({ type: "question", awaitingReply: true });
    // No auth header was registered -- must not send a bogus one.
    expect(received[0].headers.authorization).toBeUndefined();
  });

  it("sends a stable event id and attempt number, and retries a 5xx until it lands", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    setAgentWebhook(orgId, bAgentId, hookUrl, null);
    script = [503, 500];

    await sendMessage(orgId, a, "Agent B", "retry me");
    await until(() => received.length >= 3);

    expect(received.map((r) => r.headers["x-opencadre-attempt"])).toEqual(["1", "2", "3"]);
    const ids = new Set(received.map((r) => r.headers["x-opencadre-event-id"]));
    expect(ids.size).toBe(1);
    expect(received[2].body).toMatchObject({ eventId: [...ids][0], attempt: 3, body: "retry me" });
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(3);
  });

  it("gives up after the last retry, and never retries a 4xx the receiver rejected", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    setAgentWebhook(orgId, bAgentId, hookUrl, null);
    respondWith = 500;
    await sendMessage(orgId, a, "Agent B", "always failing");
    // Wait for the chain to end, not a fixed time: under load three attempts can take longer than any guess.
    await until(gaveUp);
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(3);

    received = [];
    respondWith = 401;
    await sendMessage(orgId, a, "Agent B", "bad auth");
    await until(() => logs.some((l) => l.msg === "webhook rejected" && l.status === 401));
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(1);
  });

  // Review (opencadre-55): a burst to an unreachable agent must not hammer its receiver.
  it("runs one wake at a time per agent, however many messages arrive during it", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    setAgentWebhook(orgId, bAgentId, hookUrl, null);
    respondWith = 500;
    for (let i = 0; i < 10; i++) await sendMessage(orgId, a, "Agent B", `burst ${i}`, "high");
    await until(gaveUp);
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.headers["x-opencadre-event-id"])).size).toBe(1);
  });

  // Review (opencadre-55): a retry for mail the agent already read would wake it for nothing.
  it("stops retrying once the message has been read another way", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_RETRY_MS", "150,150");
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    setAgentWebhook(orgId, bAgentId, hookUrl, null);
    respondWith = 500;
    // Read it the moment the first delivery arrives, so the read always lands before the retry is due.
    onReceive = () => void getMessages(orgId, bAgentId);
    await sendMessage(orgId, a, "Agent B", "read me elsewhere");
    await until(() => received.length >= 1);
    await new Promise((r) => setTimeout(r, 450));
    expect(received).toHaveLength(1);
  });

  it("sends no webhook for low-priority mail", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    setAgentWebhook(orgId, bAgentId, hookUrl, null);
    await sendMessage(orgId, a, "Agent B", "fyi", "low");
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(0);
  });

  it("never fires a webhook when none is registered", async () => {
    const { orgId, a } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "hello");
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(0);
  });

  it("clearing a webhook with url=null stops future notifications", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    setAgentWebhook(orgId, bAgentId, hookUrl, null);
    setAgentWebhook(orgId, bAgentId, null, null);

    await sendMessage(orgId, a, "Agent B", "hello");
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(0);
  });

  it("a webhook delivery failure never blocks the message from being sent", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    setAgentWebhook(orgId, bAgentId, "http://127.0.0.1:1/unreachable", null);

    const result = await sendMessage(orgId, a, "Agent B", "hello");
    expect(result.ok).toBe(true);
  });

  it("without the local-development switch, a loopback webhook is never contacted", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "");
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    setAgentWebhook(orgId, bAgentId, hookUrl, null);

    const result = await sendMessage(orgId, a, "Agent B", "hello", "high");
    expect(result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0);
  });
});
