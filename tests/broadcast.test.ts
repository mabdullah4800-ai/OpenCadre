import { describe, expect, it } from "vitest";
import { broadcastMessage, createOrganization, getMessages, registerAgent, sendMessage } from "../src/service.js";

function setupThreeAgents() {
  const { orgId } = createOrganization("Broadcast Org");
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  const c = registerAgent(orgId, "Agent C");
  return {
    orgId,
    a: { id: a.agentId, name: "Agent A" },
    b: { id: b.agentId, name: "Agent B" },
    c: { id: c.agentId, name: "Agent C" },
  };
}

describe("broadcast_message", () => {
  it("fans out toAgents with independent threads per recipient", async () => {
    const { orgId, a, b, c } = setupThreeAgents();
    const result = await broadcastMessage(orgId, a, { toAgents: ["Agent B", "Agent C"] }, "fleet standup in 5");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries.every((d) => d.ok)).toBe(true);
    const threads = result.deliveries.filter((d) => d.ok).map((d) => d.threadId);
    expect(new Set(threads).size).toBe(2);

    const inboxB = getMessages(orgId, b.id);
    const inboxC = getMessages(orgId, c.id);
    expect(inboxB).toHaveLength(1);
    expect(inboxC).toHaveLength(1);
    expect(inboxB[0].body).toBe("fleet standup in 5");
    expect(inboxC[0].body).toBe("fleet standup in 5");
  });

  it("org channel delivers to every other agent, excluding sender", async () => {
    const { orgId, a, b, c } = setupThreeAgents();
    const result = await broadcastMessage(orgId, a, { channel: "org" }, "org-wide ping");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliveries).toHaveLength(2);
    expect(getMessages(orgId, b.id)).toHaveLength(1);
    expect(getMessages(orgId, c.id)).toHaveLength(1);
    expect(getMessages(orgId, a.id)).toHaveLength(0);
  });

  it("reports per-recipient errors without aborting the rest", async () => {
    const { orgId, a, b } = setupThreeAgents();
    const result = await broadcastMessage(orgId, a, { toAgents: ["Agent B", "NoSuchAgent"] }, "partial");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries.filter((d) => d.ok)).toHaveLength(1);
    expect(result.deliveries.find((d) => !d.ok)?.error).toMatch(/No agent found/);
    expect(getMessages(orgId, b.id)).toHaveLength(1);
  });

  it("dedupes duplicate names in toAgents", async () => {
    const { orgId, a, b } = setupThreeAgents();
    const result = await broadcastMessage(orgId, a, { toAgents: ["Agent B", "Agent B"] }, "once");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliveries).toHaveLength(1);
    expect(getMessages(orgId, b.id)).toHaveLength(1);
  });

  it("returns error when no recipients", async () => {
    const { orgId } = createOrganization("Solo Org");
    const solo = registerAgent(orgId, "Solo");
    const result = await broadcastMessage(
      orgId,
      { id: solo.agentId, name: "Solo" },
      { channel: "org" },
      "hello?",
    );
    expect(result.ok).toBe(false);
  });
});

describe("broadcast batching (FLEET_SCALING_AUDIT.md finding 2)", () => {
  it("every recipient gets exactly one message with a distinct thread, at a fan-out too large to eyeball", async () => {
    const { orgId } = createOrganization("Broadcast Batch Org");
    const sender = registerAgent(orgId, "Sender");
    const recipients = Array.from({ length: 25 }, (_, i) => registerAgent(orgId, `Recipient-${i}`));

    const result = await broadcastMessage(orgId, { id: sender.agentId, name: "Sender" }, { channel: "org" }, "fan-out check");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliveries).toHaveLength(25);
    expect(result.deliveries.every((d) => d.ok)).toBe(true);
    const threadIds = result.deliveries.map((d) => (d as { threadId: string }).threadId);
    expect(new Set(threadIds).size).toBe(25); // every recipient's thread is independent, none merged or dropped

    for (const r of recipients) {
      const inbox = getMessages(orgId, r.agentId);
      expect(inbox).toHaveLength(1);
      expect(inbox[0].body).toBe("fan-out check");
    }
  });

  it("a mix of valid and invalid recipients still inserts every valid one -- the batch transaction doesn't roll back on a per-recipient logical failure", async () => {
    const { orgId, a, b, c } = setupThreeAgents();
    const result = await broadcastMessage(orgId, a, { toAgents: ["Agent B", "Nope1", "Agent C", "Nope2"] }, "mixed batch");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliveries.filter((d) => d.ok)).toHaveLength(2);
    expect(result.deliveries.filter((d) => !d.ok)).toHaveLength(2);
    expect(getMessages(orgId, b.id)).toHaveLength(1);
    expect(getMessages(orgId, c.id)).toHaveLength(1);
  });
});

describe("broadcast vs send_message parity", () => {
  it("broadcast to one agent matches send_message semantics", async () => {
    const { orgId, a, b } = setupThreeAgents();
    const direct = await sendMessage(orgId, a, "Agent B", "direct");
    const viaBroadcast = await broadcastMessage(orgId, a, { toAgents: ["Agent B"] }, "broadcast");
    expect(direct.ok && viaBroadcast.ok).toBe(true);
    if (!direct.ok || !viaBroadcast.ok) return;
    expect(direct.threadId).not.toBe(
      (viaBroadcast.deliveries[0] as { threadId: string }).threadId,
    );
  });
});
