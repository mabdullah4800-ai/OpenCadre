import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import {
  askClarification,
  createOrganization,
  getMessages,
  registerAgent,
  reply,
  sendMessage,
  waitForMessage,
} from "../src/service.js";

// Fleet coordination plan, slice A (docs/superpowers/plans/2026-11-07-fleet-coordination.md, failure 4): a reply used to
// clear awaiting_reply but never set read_at, so a peek reader (the Stop hook, the wake watcher, any watcher key) kept
// listing a thread the agent had already answered. Answering a message now marks it, and the replier's earlier inbound
// mail on that thread, read.

function setup(name: string) {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Asker");
  const b = registerAgent(orgId, "Answerer");
  return { orgId, a: { id: a.agentId, name: "Asker" }, b: { id: b.agentId, name: "Answerer" }, bKey: b.apiKey };
}

const peek = (orgId: string, agentId: string) => getMessages(orgId, agentId, undefined, { peek: true });
const readAt = (id: string) => (db.prepare(`SELECT read_at FROM messages WHERE id = ?`).get(id) as { read_at: string | null }).read_at;
const stateOf = (id: string) => db.prepare(`SELECT delivered_at, read_at FROM messages WHERE id = ?`).get(id) as { delivered_at: string | null; read_at: string | null };

describe("reply marks the replier's answered mail read", () => {
  it("after a reply, peek and wait no longer list the answered message", async () => {
    const { orgId, a, b } = setup("Reply Read Org");
    const sent = await sendMessage(orgId, a, "Answerer", "please review PR 60");
    if (!sent.ok) throw new Error("send failed");
    await sendMessage(orgId, a, "Answerer", "an unrelated thread");
    expect(peek(orgId, b.id).map((m) => m.body)).toEqual(["please review PR 60", "an unrelated thread"]);

    expect(reply(orgId, b, sent.threadId, "reviewed, LGTM")).toEqual({ ok: true });

    expect(peek(orgId, b.id).map((m) => m.body)).toEqual(["an unrelated thread"]);
    const waited = await waitForMessage(orgId, b.id, 1, { peek: true, beat: false });
    expect(waited.map((m) => m.body)).toEqual(["an unrelated thread"]);
  });

  it("marks earlier inbound messages on the thread the replier has received, not only the one answered", async () => {
    const { orgId, a, b } = setup("Reply Read Earlier Org");
    const sent = await sendMessage(orgId, a, "Answerer", "first");
    if (!sent.ok) throw new Error("send failed");
    expect(reply(orgId, a, sent.threadId, "second, same thread")).toEqual({ ok: true });
    expect(peek(orgId, b.id)).toHaveLength(2);

    expect(reply(orgId, b, sent.threadId, "answering both")).toEqual({ ok: true });
    expect(peek(orgId, b.id)).toHaveLength(0);
  });

  it("a newer message on the same thread stays unread", async () => {
    const { orgId, a, b } = setup("Reply Read Later Org");
    // An open question is what reply() answers even when a later follow-up has arrived on the thread.
    const asked = await askClarification(orgId, a, "Answerer", "ok to deploy?", 0);
    if (!asked.ok) throw new Error("ask failed");
    expect(reply(orgId, a, asked.threadId, "context: the deploy is at 5pm")).toEqual({ ok: true });
    const [question, followUp] = peek(orgId, b.id);
    expect([question.body, followUp.body]).toEqual(["ok to deploy?", "context: the deploy is at 5pm"]);

    expect(reply(orgId, b, asked.threadId, "yes")).toEqual({ ok: true });

    expect(readAt(question.id)).not.toBeNull();
    expect(readAt(followUp.id)).toBeNull();
    expect(peek(orgId, b.id).map((m) => m.body)).toEqual(["context: the deploy is at 5pm"]);
  });

  it("leaves the other participant's copies on the thread untouched", async () => {
    const { orgId, a, b } = setup("Reply Read Other Org");
    const sent = await sendMessage(orgId, a, "Answerer", "ping");
    if (!sent.ok) throw new Error("send failed");
    expect(reply(orgId, b, sent.threadId, "pong")).toEqual({ ok: true });
    // A's unread copy of B's first answer must survive B answering again.
    expect(reply(orgId, b, sent.threadId, "pong again")).toEqual({ ok: true });
    expect(peek(orgId, a.id).map((m) => m.body)).toEqual(["pong", "pong again"]);
  });

  // No write path puts two recipients on one thread today (broadcastMessage gives each recipient its own thread, and a
  // reply only ever goes to the other end). The schema still allows it -- messages has no (thread_id, to_agent_id)
  // constraint -- so this pins that the UPDATE is keyed on the replier, not the thread.
  it("never marks a third agent's copy on the same thread_id", async () => {
    const { orgId, a, b } = setup("Reply Read Third Org");
    const c = registerAgent(orgId, "Bystander");
    const sent = await sendMessage(orgId, a, "Answerer", "for Answerer and Bystander");
    if (!sent.ok) throw new Error("send failed");
    const original = db.prepare(`SELECT body FROM messages WHERE thread_id = ?`).get(sent.threadId) as { body: string };
    // Backdated so that, ordered by created_at, it is not the asker's latest sent row: the follow-up below still goes to Answerer.
    db.prepare(
      // Delivered, so the delivered_at rule can't be what spares it: only the recipient filter does.
      `INSERT INTO messages (id, org_id, thread_id, from_agent_id, from_agent_name, to_agent_id, to_agent_name, body, kind, awaiting_reply, created_at, delivered_at)
       VALUES ('third-copy', ?, ?, ?, ?, ?, 'Bystander', ?, 'message', 0, '2000-01-01 00:00:00', '2000-01-01 00:00:01')`,
    ).run(orgId, sent.threadId, a.id, a.name, c.agentId, original.body);
    // The message answered comes AFTER the third copy, so only the recipient filter (not the rowid bound) protects it.
    expect(reply(orgId, a, sent.threadId, "follow-up for Answerer")).toEqual({ ok: true });
    expect(peek(orgId, b.id)).toHaveLength(2); // Answerer has received both of its own

    expect(reply(orgId, b, sent.threadId, "got it")).toEqual({ ok: true });
    expect(peek(orgId, b.id)).toEqual([]);
    expect(readAt("third-copy")).toBeNull();
    expect(peek(orgId, c.agentId).map((m) => m.id)).toEqual(["third-copy"]);
  });

  // Review of #779: an older row the replier was never handed must not vanish from get_messages, peek and awareness
  // just because it answered a newer one. "Handed" is delivered_at: set by a live push, any get_messages (peek
  // included, so wait_for_message too) and consume_messages; not by a webhook notice or an awareness line.
  it("an older message the replier never received stays unread after it answers a newer one", async () => {
    const { orgId, a, b } = setup("Reply Read Unseen Org");
    const sent = await sendMessage(orgId, a, "Answerer", "first, never fetched");
    if (!sent.ok) throw new Error("send failed");
    expect(reply(orgId, a, sent.threadId, "second, also never fetched")).toEqual({ ok: true });
    const [first, second] = db.prepare(`SELECT id FROM messages WHERE thread_id = ? AND to_agent_id = ? ORDER BY rowid`).all(sent.threadId, b.id) as { id: string }[];
    expect(stateOf(first.id).delivered_at).toBeNull();

    // Answering by thread id alone (e.g. from an awareness line) answers the latest message, the second one.
    expect(reply(orgId, b, sent.threadId, "answering the second")).toEqual({ ok: true });

    expect(stateOf(first.id)).toEqual({ delivered_at: null, read_at: null });
    expect(stateOf(second.id).read_at).not.toBeNull();
    expect(peek(orgId, b.id).map((m) => m.body)).toEqual(["first, never fetched"]);
  });

  it("an answered message is delivered as well as read, so no receipt says read but not delivered", async () => {
    const { orgId, a, b } = setup("Reply Read Delivered Org");
    const sent = await sendMessage(orgId, a, "Answerer", "answered without fetching");
    if (!sent.ok) throw new Error("send failed");
    const [row] = db.prepare(`SELECT id FROM messages WHERE thread_id = ?`).all(sent.threadId) as { id: string }[];
    expect(stateOf(row.id)).toEqual({ delivered_at: null, read_at: null });

    expect(reply(orgId, b, sent.threadId, "done")).toEqual({ ok: true });

    const after = stateOf(row.id);
    expect(after.read_at).not.toBeNull();
    expect(after.delivered_at).not.toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE org_id = ? AND read_at IS NOT NULL AND delivered_at IS NULL`).get(orgId)).toEqual({ n: 0 });
  });

  // askClarification always opens a new thread, so through the API a question is the first row on its thread and nothing
  // sits below it. The schema allows it, though, so the question is made here by flagging a follow-up awaiting_reply.
  it("below a pending question, an older row is marked read only if the replier received it", async () => {
    const { orgId, a, b } = setup("Reply Read Below Question Org");
    const run = async (fetchedOlder: boolean) => {
      const sent = await sendMessage(orgId, a, "Answerer", `older (${fetchedOlder ? "fetched" : "never fetched"})`);
      if (!sent.ok) throw new Error("send failed");
      const [older] = db.prepare(`SELECT id FROM messages WHERE thread_id = ?`).all(sent.threadId) as { id: string }[];
      if (fetchedOlder) peek(orgId, b.id);
      expect(reply(orgId, a, sent.threadId, `the question (${fetchedOlder ? "fetched" : "never fetched"})`)).toEqual({ ok: true });
      const question = db.prepare(`SELECT id FROM messages WHERE thread_id = ? AND id != ?`).get(sent.threadId, older.id) as { id: string };
      db.prepare(`UPDATE messages SET awaiting_reply = 1, kind = 'question' WHERE id = ?`).run(question.id);

      expect(reply(orgId, b, sent.threadId, "answer")).toEqual({ ok: true });

      expect(stateOf(question.id).read_at).not.toBeNull();
      expect((db.prepare(`SELECT awaiting_reply FROM messages WHERE id = ?`).get(question.id) as { awaiting_reply: number }).awaiting_reply).toBe(0);
      return stateOf(older.id);
    };
    expect(await run(false)).toEqual({ delivered_at: null, read_at: null });
    const fetched = await run(true);
    expect(fetched.delivered_at).not.toBeNull();
    expect(fetched.read_at).not.toBeNull();
  });

  it("an answered question still clears awaiting_reply", async () => {
    const { orgId, a, b } = setup("Reply Read Awaiting Org");
    const asked = await askClarification(orgId, a, "Answerer", "are we good to ship?", 0);
    if (!asked.ok) throw new Error("ask failed");
    const [question] = peek(orgId, b.id);
    expect(question.awaiting_reply).toBe(1);

    expect(reply(orgId, b, asked.threadId, "yes, ship it")).toEqual({ ok: true });
    const row = db.prepare(`SELECT awaiting_reply, read_at FROM messages WHERE id = ?`).get(question.id) as { awaiting_reply: number; read_at: string | null };
    expect(row.awaiting_reply).toBe(0);
    expect(row.read_at).not.toBeNull();
  });

  it("a follow-up on the replier's own thread marks nothing the other side has not read", async () => {
    const { orgId, a, b } = setup("Reply Read Own Org");
    const sent = await sendMessage(orgId, a, "Answerer", "please check PR 80");
    if (!sent.ok) throw new Error("send failed");
    expect(reply(orgId, a, sent.threadId, "also PR 81")).toEqual({ ok: true });
    expect(peek(orgId, b.id).map((m) => m.body)).toEqual(["please check PR 80", "also PR 81"]);
  });
});

describe("a peek-default (watcher) key replying over REST", () => {
  let server: http.Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("marks the answered message read, so its default peek no longer lists it", async () => {
    const { orgId } = createOrganization("Reply Read Watcher Org");
    const a = registerAgent(orgId, "Asker");
    const w = registerAgent(orgId, "Watcher-Answerer", { keyClass: "watcher" });
    const sent = await sendMessage(orgId, { id: a.agentId, name: "Asker" }, "Watcher-Answerer", "please review");
    if (!sent.ok) throw new Error("send failed");
    const headers = { authorization: `Bearer ${w.apiKey}`, "content-type": "application/json" };
    const inbox = async () => ((await (await fetch(`${baseUrl}/v1/messages`, { headers })).json()) as { messages: { body: string }[] }).messages;

    // Watcher keys peek by default, so before this fix the answered message stayed listed forever.
    expect((await inbox()).map((m) => m.body)).toEqual(["please review"]);
    expect((await inbox()).map((m) => m.body)).toEqual(["please review"]);

    const res = await fetch(`${baseUrl}/v1/messages/${sent.threadId}/reply`, { method: "POST", headers, body: JSON.stringify({ body: "done" }) });
    expect(res.status).toBe(200);
    expect(await inbox()).toEqual([]);
    // The wake watcher's exact request (scripts/opencadre-wake.mjs) returns nothing for it either.
    const waited = await fetch(`${baseUrl}/v1/messages/wait?peek=true&timeoutSeconds=1`, { headers: { ...headers, "x-opencadre-probe": "no-heartbeat" } });
    expect(((await waited.json()) as { messages: unknown[] }).messages).toEqual([]);
  });
});
