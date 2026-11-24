import { describe, expect, it } from "vitest";
import { createOrganization, getMessages, registerAgent, searchMessages, sendMessage } from "../src/service.js";

/** Two agents in one workspace; A sends, B receives. */
function twoAgents(orgName = "Search Org") {
  const { orgId } = createOrganization(orgName);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return { orgId, a: { id: a.agentId, name: "Agent A" }, b: { id: b.agentId, name: "Agent B" } };
}

describe("search_messages", () => {
  it("finds a message the recipient already read, which get_messages no longer returns", async () => {
    const { orgId, a, b } = twoAgents();
    await sendMessage(orgId, a, "Agent B", "the deploy key rotated on Tuesday");

    // Consume it: after this, getMessages returns nothing for B.
    expect(getMessages(orgId, b.id)).toHaveLength(1);
    expect(getMessages(orgId, b.id)).toHaveLength(0);

    const found = searchMessages(orgId, b.id, { query: "rotated" });
    expect(found).toHaveLength(1);
    expect(found[0].body).toBe("the deploy key rotated on Tuesday");
  });

  it("searches the sender's own sent mail too", async () => {
    const { orgId, a } = twoAgents();
    await sendMessage(orgId, a, "Agent B", "please rebase PR 50");
    const found = searchMessages(orgId, a.id, { query: "rebase" });
    expect(found).toHaveLength(1);
    expect(found[0].to_agent_name).toBe("Agent B");
  });

  it("does not mark a match read", async () => {
    const { orgId, a, b } = twoAgents();
    await sendMessage(orgId, a, "Agent B", "unread on purpose");
    expect(searchMessages(orgId, b.id, { query: "unread" })).toHaveLength(1);
    expect(searchMessages(orgId, b.id, { query: "unread" })).toHaveLength(1);
    // Still unread, so the ordinary inbox reader still gets it.
    expect(getMessages(orgId, b.id)).toHaveLength(1);
  });

  it("never returns another pair's thread", async () => {
    const { orgId, a, b } = twoAgents();
    const c = registerAgent(orgId, "Agent C");
    await sendMessage(orgId, a, "Agent B", "secret between A and B");
    await sendMessage(orgId, a, "Agent C", "secret between A and C");

    const forC = searchMessages(orgId, c.agentId, { query: "secret" });
    expect(forC).toHaveLength(1);
    expect(forC[0].body).toBe("secret between A and C");
  });

  it("ANDs the filters: query plus from plus threadId", async () => {
    const { orgId, a, b } = twoAgents();
    const sent = await sendMessage(orgId, a, "Agent B", "alpha beta");
    await sendMessage(orgId, b, "Agent A", "alpha gamma");
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    expect(searchMessages(orgId, b.id, { query: "alpha" })).toHaveLength(2);
    expect(searchMessages(orgId, b.id, { query: "alpha", from: "Agent A" })).toHaveLength(1);
    expect(searchMessages(orgId, b.id, { query: "alpha", threadId: sent.threadId })).toHaveLength(1);
    // A filter combination that cannot match returns nothing, not everything.
    expect(searchMessages(orgId, b.id, { query: "gamma", from: "Agent A" })).toHaveLength(0);
  });

  it("treats % and _ in a query literally, not as wildcards", async () => {
    const { orgId, a, b } = twoAgents();
    await sendMessage(orgId, a, "Agent B", "100% done");
    await sendMessage(orgId, a, "Agent B", "other note");
    // A bare "%" would match every row if it were not escaped.
    const found = searchMessages(orgId, b.id, { query: "%" });
    expect(found).toHaveLength(1);
    expect(found[0].body).toBe("100% done");
  });

  it("caps the page at 100 rows and returns newest first", async () => {
    const { orgId, a, b } = twoAgents();
    for (let i = 0; i < 120; i++) await sendMessage(orgId, a, "Agent B", `note ${i}`);
    const found = searchMessages(orgId, b.id, { query: "note" });
    expect(found).toHaveLength(100);
    expect(found[0].body).toBe("note 119");
  });

  it("returns nothing for a query that matches nothing", async () => {
    const { orgId, a, b } = twoAgents();
    await sendMessage(orgId, a, "Agent B", "hello");
    expect(searchMessages(orgId, b.id, { query: "zzz-no-such-text" })).toHaveLength(0);
  });

  it("is scoped to one workspace", async () => {
    const first = twoAgents("Search Org One");
    const second = twoAgents("Search Org Two");
    await sendMessage(first.orgId, first.a, "Agent B", "only in workspace one");
    expect(searchMessages(second.orgId, second.b.id, { query: "workspace" })).toHaveLength(0);
  });
});
