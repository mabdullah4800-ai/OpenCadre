import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { registerSocket } from "../src/live.js";
import { consumeMessages, createOrganization, getMessages, getThreadStatus, registerAgent, reply, sendMessage } from "../src/service.js";

let n = 0;
function trio() {
  const { orgId } = createOrganization(`Delivery Org ${++n}`);
  const a = registerAgent(orgId, `Sender-D${n}`);
  const b = registerAgent(orgId, `Receiver-D${n}`);
  const c = registerAgent(orgId, `Outsider-D${n}`);
  return { orgId, a: { id: a.agentId, name: `Sender-D${n}`, key: a.apiKey }, b: { id: b.agentId, name: `Receiver-D${n}`, key: b.apiKey }, c: { id: c.agentId, key: c.apiKey } };
}
const statusOf = (orgId: string, agentId: string, threadId: string) => {
  const r = getThreadStatus(orgId, agentId, threadId);
  if (!r.ok) throw new Error(r.error);
  return r.messages;
};

describe("delivery status", () => {
  it("queued mail is neither delivered nor read; a peek delivers; a read reads", async () => {
    const { orgId, a, b } = trio();
    const sent = await sendMessage(orgId, a, b.name, "hello");
    if (!sent.ok) throw new Error("send failed");
    expect(statusOf(orgId, a.id, sent.threadId)[0]).toMatchObject({ delivered_at: null, read_at: null });

    getMessages(orgId, b.id, undefined, { peek: true });
    const peeked = statusOf(orgId, a.id, sent.threadId)[0];
    expect(peeked.delivered_at).not.toBeNull();
    expect(peeked.read_at).toBeNull();

    getMessages(orgId, b.id);
    const read = statusOf(orgId, a.id, sent.threadId)[0];
    expect(read.read_at).not.toBeNull();
    expect(read.delivered_at).toBe(peeked.delivered_at);
  });

  it("a live push over the recipient's socket marks the message delivered at once, not read", async () => {
    const { orgId, a, b } = trio();
    const frames: string[] = [];
    const socket = { OPEN: 1, readyState: 1, send: (f: string) => frames.push(f), on: () => {}, close: () => {} };
    registerSocket(b.id, socket as unknown as Parameters<typeof registerSocket>[1]);
    const sent = await sendMessage(orgId, a, b.name, "live");
    if (!sent.ok) throw new Error("send failed");
    expect(sent.delivered).toBe("live");
    expect(frames).toHaveLength(1);
    expect(statusOf(orgId, a.id, sent.threadId)[0]).toMatchObject({ delivered_at: expect.any(String), read_at: null });
  });

  it("a peek watcher ingest followed by consume marks both delivered and read", async () => {
    const { orgId, a, b } = trio();
    const sent = await sendMessage(orgId, a, b.name, "watcher path");
    if (!sent.ok) throw new Error("send failed");
    const [msg] = getMessages(orgId, b.id, undefined, { peek: true });
    consumeMessages(orgId, b.id, [msg.id]);
    expect(statusOf(orgId, b.id, sent.threadId)[0]).toMatchObject({ delivered_at: expect.any(String), read_at: expect.any(String) });
  });

  it("covers every message on the thread, replies included, for participants only", async () => {
    const { orgId, a, b, c } = trio();
    const sent = await sendMessage(orgId, a, b.name, "question?");
    if (!sent.ok) throw new Error("send failed");
    getMessages(orgId, b.id);
    reply(orgId, { id: b.id, name: b.name }, sent.threadId, "answer");
    const rows = statusOf(orgId, b.id, sent.threadId);
    expect(rows.map((r) => [r.from, r.to])).toEqual([[a.name, b.name], [b.name, a.name]]);
    expect(rows[1]).toMatchObject({ delivered_at: null, read_at: null });
    expect(getThreadStatus(orgId, c.id, sent.threadId).ok).toBe(false);
  });

  it("recovers a message's full text even after get_messages has already consumed it -- the actual regression this fixes", async () => {
    // A message body used to become permanently unreadable the instant get_messages marked it read
    // (no re-masking needed here: insertMessage already masked it at write time). Confirmed live,
    // this cost a real message body mid-session with no way to recover it.
    const { orgId, a, b } = trio();
    const sent = await sendMessage(orgId, a, b.name, "the full original text, verbatim");
    if (!sent.ok) throw new Error("send failed");

    const consumed = getMessages(orgId, b.id); // NOT peek -- this is the real "gone once read" path
    expect(consumed[0].body).toBe("the full original text, verbatim");
    expect(getMessages(orgId, b.id)).toHaveLength(0); // confirmed actually consumed, not just peeked

    // Both the sender and the recipient can still recover the exact text after consumption.
    expect(statusOf(orgId, a.id, sent.threadId)[0].body).toBe("the full original text, verbatim");
    expect(statusOf(orgId, b.id, sent.threadId)[0].body).toBe("the full original text, verbatim");
  });
});

describe("GET /v1/messages/:threadId/status", () => {
  let base: string;
  let server: ReturnType<typeof app.listen>;
  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("returns the thread status to a participant and 404 to anyone else", async () => {
    const { orgId, a, b, c } = trio();
    const sent = await sendMessage(orgId, a, b.name, "rest status");
    if (!sent.ok) throw new Error("send failed");
    const ok = await fetch(`${base}/v1/messages/${sent.threadId}/status`, { headers: { authorization: `Bearer ${a.key}` } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).messages[0]).toMatchObject({ from: a.name, to: b.name, delivered_at: null, read_at: null });
    const denied = await fetch(`${base}/v1/messages/${sent.threadId}/status`, { headers: { authorization: `Bearer ${c.key}` } });
    expect(denied.status).toBe(404);
  });
});
