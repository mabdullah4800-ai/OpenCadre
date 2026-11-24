import { describe, expect, it } from "vitest";
import { askClarification, consumeMessages, createOrganization, getMessages, registerAgent, reply, sendMessage } from "../src/service.js";
import { getDelivery, pullEvents } from "../src/deliveries.js";
import { getAwareness } from "../src/awareness.js";

// Most agents read mail with get_messages and never call ack_event. A directed event about a message must stop
// resurfacing once the message is dealt with, or every urgent message and answer repeats in each digest forever.
function setup(name: string) {
  const { orgId } = createOrganization(name);
  const me = registerAgent(orgId, "Claude-Me");
  const other = registerAgent(orgId, "Codex-Other");
  return { orgId, me: { id: me.agentId, name: "Claude-Me" }, other: { id: other.agentId, name: "Codex-Other" } };
}
const resurfaced = (orgId: string, agentId: string) => getAwareness(orgId, agentId).items.map((i) => i.type);

describe("reading a message closes its directed event", () => {
  it("an urgent message stops resurfacing once read, without faking an acknowledgement", async () => {
    const { orgId, me, other } = setup("Read Closes Org");
    await sendMessage(orgId, other, "Claude-Me", "prod is down, stop deploying", "high");
    const first = getAwareness(orgId, me.id);
    const seq = first.items[0].seq;
    expect(resurfaced(orgId, me.id)).toEqual(["message.sent"]); // still open: not read yet

    getMessages(orgId, me.id, undefined, { peek: true });
    expect(resurfaced(orgId, me.id)).toEqual(["message.sent"]); // a peek isn't a read

    getMessages(orgId, me.id);
    expect(resurfaced(orgId, me.id)).toEqual([]);
    expect(pullEvents(orgId, me.id)).toEqual([]);
    expect(getDelivery(orgId, me.id, seq)?.state).toBe("delivered");
  });

  it("consuming a peeked message (the watcher and console path) closes it too", async () => {
    const { orgId, me, other } = setup("Consume Closes Org");
    await sendMessage(orgId, other, "Claude-Me", "urgent", "high");
    const [message] = getMessages(orgId, me.id, undefined, { peek: true });
    expect(pullEvents(orgId, me.id).map((e) => e.type)).toEqual(["message.sent"]);
    consumeMessages(orgId, me.id, [message.id]);
    expect(pullEvents(orgId, me.id)).toEqual([]);
  });

  it("a question stays open after it's read, and closes once answered; the answer closes when the asker reads it", async () => {
    const { orgId, me, other } = setup("Question Closes Org");
    const asked = await askClarification(orgId, other, "Claude-Me", "which region?", 0);
    if (!asked.ok) throw new Error(asked.error);
    getMessages(orgId, me.id);
    expect(pullEvents(orgId, me.id).map((e) => e.type)).toEqual(["question.asked"]);

    expect(reply(orgId, me, asked.threadId, "us-east").ok).toBe(true);
    expect(pullEvents(orgId, me.id)).toEqual([]);

    expect(pullEvents(orgId, other.id).map((e) => e.type)).toEqual(["question.answered"]);
    getMessages(orgId, other.id);
    expect(pullEvents(orgId, other.id)).toEqual([]);
  });

  it("an unread message from a teammate still resurfaces, and other people's reads don't close mine", async () => {
    const { orgId, me, other } = setup("Unread Stays Org");
    const third = registerAgent(orgId, "Gemini-Third");
    await sendMessage(orgId, other, "Claude-Me", "urgent for me", "high");
    await sendMessage(orgId, other, "Gemini-Third", "urgent for third", "high");
    getAwareness(orgId, me.id);
    getMessages(orgId, third.agentId);
    expect(resurfaced(orgId, me.id)).toEqual(["message.sent"]);
  });
});
