import { describe, expect, it } from "vitest";
import { createOrganization, registerAgent, sendMessage, waitForMessage } from "../src/service.js";

function setupOrgWithTwoAgents() {
  const { orgId } = createOrganization("Wait Test Org");
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return { orgId, a: { id: a.agentId, name: "Agent A" }, bAgentId: b.agentId };
}

describe("waitForMessage", () => {
  it("returns immediately when mail already exists in the inbox before the call", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    // Message lands BEFORE wait_for_message is ever called -- this is the
    // real-world case of an agent that was offline, comes back, and asks
    // to wait for its next message. It must see the mail that's already
    // sitting there, not block for a brand-new arrival that never comes.
    await sendMessage(orgId, a, "Agent B", "already here before you waited");

    const start = Date.now();
    const messages = await waitForMessage(orgId, bAgentId, 5);
    const elapsedMs = Date.now() - start;

    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("already here before you waited");
    // Must return near-instantly, not burn the whole 5s timeout waiting for
    // a NEW notification that will never fire.
    expect(elapsedMs).toBeLessThan(500);
  });

  it("still resolves via the live notify path when the inbox starts empty", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    const waitPromise = waitForMessage(orgId, bAgentId, 5);
    await new Promise((r) => setTimeout(r, 20));
    await sendMessage(orgId, a, "Agent B", "arrives while waiting");

    const messages = await waitPromise;
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("arrives while waiting");
  });

  it("times out and returns empty when nothing ever arrives", async () => {
    const { orgId, bAgentId } = setupOrgWithTwoAgents();
    const start = Date.now();
    const messages = await waitForMessage(orgId, bAgentId, 1);
    const elapsedMs = Date.now() - start;
    expect(messages).toHaveLength(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
  });
});
