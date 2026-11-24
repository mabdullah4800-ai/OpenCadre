import { describe, expect, it } from "vitest";
import {
  consumeMessages,
  createOrganization,
  getMessages,
  registerAgent,
  resolvePeekDefault,
  sendMessage,
} from "../src/service.js";

describe("watcher key class peek-default", () => {
  it("resolvePeekDefault returns true for watcher, false for agent", () => {
    expect(resolvePeekDefault("watcher")).toBe(true);
    expect(resolvePeekDefault("agent")).toBe(false);
    expect(resolvePeekDefault("watcher", false)).toBe(false);
    expect(resolvePeekDefault("agent", true)).toBe(true);
  });

  it("watcher getMessages without explicit peek leaves mail unread", async () => {
    const { orgId } = createOrganization("Peek Default Org");
    const a = registerAgent(orgId, "Sender");
    const watcher = registerAgent(orgId, "Inbox-Watcher", { keyClass: "watcher" });

    await sendMessage(orgId, { id: a.agentId, name: "Sender" }, "Inbox-Watcher", "do not steal");

    const peek = resolvePeekDefault("watcher");
    const rows = getMessages(orgId, watcher.agentId, undefined, { peek });
    expect(rows).toHaveLength(1);
    expect(rows[0].read_at).toBeNull();

    const again = getMessages(orgId, watcher.agentId, undefined, { peek });
    expect(again).toHaveLength(1);
  });

  it("agent key class still consumes on fetch (backward compatible)", async () => {
    const { orgId } = createOrganization("Agent Key Org");
    const a = registerAgent(orgId, "Sender");
    const agent = registerAgent(orgId, "Reader");

    await sendMessage(orgId, { id: a.agentId, name: "Sender" }, "Reader", "consume me");

    getMessages(orgId, agent.agentId);
    expect(getMessages(orgId, agent.agentId)).toHaveLength(0);
  });

  it("consume_messages marks peeked mail read", async () => {
    const { orgId } = createOrganization("Consume Org");
    const a = registerAgent(orgId, "Sender");
    const watcher = registerAgent(orgId, "Watcher", { keyClass: "watcher" });

    await sendMessage(orgId, { id: a.agentId, name: "Sender" }, "Watcher", "peek then consume");

    const peeked = getMessages(orgId, watcher.agentId, undefined, { peek: resolvePeekDefault("watcher") });
    expect(peeked[0].read_at).toBeNull();

    const result = consumeMessages(orgId, watcher.agentId, [peeked[0].id]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consumed).toBe(1);
    expect(getMessages(orgId, watcher.agentId)).toHaveLength(0);
  });

  it("watcher can explicitly consume via peek=false", async () => {
    const { orgId } = createOrganization("Explicit Consume Org");
    const a = registerAgent(orgId, "Sender");
    const watcher = registerAgent(orgId, "Watcher", { keyClass: "watcher" });

    await sendMessage(orgId, { id: a.agentId, name: "Sender" }, "Watcher", "explicit");

    getMessages(orgId, watcher.agentId, undefined, { peek: false });
    expect(getMessages(orgId, watcher.agentId)).toHaveLength(0);
  });
});
