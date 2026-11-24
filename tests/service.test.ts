import { describe, expect, it } from "vitest";
import { createOrganization, registerAgent, sendMessage, askClarification, getMessages, reply, listActiveAgents, resolveAgent, heartbeat, broadcastMessage } from "../src/service.js";

function setupOrgWithTwoAgents() {
  const { orgId } = createOrganization("Test Org");
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return { orgId, a: { id: a.agentId, name: "Agent A" }, b: { id: b.agentId, name: "Agent B" } };
}

describe("organizations and agents", () => {
  it("creates an org with a real bootstrap key", () => {
    const { orgId, bootstrapKey } = createOrganization("Acme");
    expect(orgId).toBeTruthy();
    expect(bootstrapKey).toMatch(/^org_/);
  });

  it("registers an agent with a derived urlKey", () => {
    const { orgId } = createOrganization("Acme");
    const agent = registerAgent(orgId, "Claude PC-Alpha!!");
    expect(agent.apiKey).toMatch(/^agt_/);
    expect(agent.urlKey).toBe("claude-pc-alpha");
  });

  it("resolves an agent by name, urlKey, or id", () => {
    const { orgId } = createOrganization("Acme");
    const agent = registerAgent(orgId, "Cursor Beta");
    expect(resolveAgent(orgId, "Cursor Beta")?.id).toBe(agent.agentId);
    expect(resolveAgent(orgId, "cursor-beta")?.id).toBe(agent.agentId);
    expect(resolveAgent(orgId, agent.agentId)?.id).toBe(agent.agentId);
    expect(resolveAgent(orgId, "nonexistent")).toBeNull();
  });

  it("never resolves an agent across a different organization", () => {
    const org1 = createOrganization("Org1");
    const org2 = createOrganization("Org2");
    const agent = registerAgent(org1.orgId, "Shared Name");
    expect(resolveAgent(org1.orgId, "Shared Name")?.id).toBe(agent.agentId);
    expect(resolveAgent(org2.orgId, "Shared Name")).toBeNull();
  });
});

describe("duplicate-send guard (FLEET_SCALING_AUDIT.md Incident 2)", () => {
  function setupOrgWithThreeAgents() {
    const { orgId } = createOrganization("Dedup Org");
    const sender = registerAgent(orgId, "Sender");
    const b = registerAgent(orgId, "Recipient B");
    const c = registerAgent(orgId, "Recipient C");
    return {
      orgId,
      sender: { id: sender.agentId, name: "Sender" },
      b: { id: b.agentId, name: "Recipient B" },
      c: { id: c.agentId, name: "Recipient C" },
    };
  }

  // Long enough (80+ chars) to clear DUPLICATE_SEND_MIN_BODY_CHARS -- the guard deliberately ignores
  // short bodies (see below), since Incident 2 was several near-identical paragraphs, not a phrase.
  const LONG_BODY = "Confirmed, standing down on this rewrite -- two agents touching the same shared git history at once is not safe.";
  const LONG_BODY_2 = "The audit findings for this task are already recorded on the board, so re-doing the file dump would just be duplicate work.";

  it("rejects the exact same (long) body sent to a different recipient within the window", async () => {
    const { orgId, sender } = setupOrgWithThreeAgents();
    const first = await sendMessage(orgId, sender, "Recipient B", LONG_BODY);
    expect(first.ok).toBe(true);
    const second = await sendMessage(orgId, sender, "Recipient C", LONG_BODY);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain("already sent this exact message");
    expect(second.error).toContain("Recipient B");
  });

  it("allows a retry to the SAME recipient (not a fan-out-by-accident pattern)", async () => {
    const { orgId, sender } = setupOrgWithThreeAgents();
    const first = await sendMessage(orgId, sender, "Recipient B", LONG_BODY);
    expect(first.ok).toBe(true);
    const second = await sendMessage(orgId, sender, "Recipient B", LONG_BODY);
    expect(second.ok).toBe(true); // same recipient twice is a legitimate retry/re-send, not the guarded pattern
  });

  it("allows a genuinely different body to a different recipient", async () => {
    const { orgId, sender } = setupOrgWithThreeAgents();
    const first = await sendMessage(orgId, sender, "Recipient B", LONG_BODY);
    expect(first.ok).toBe(true);
    const second = await sendMessage(orgId, sender, "Recipient C", LONG_BODY_2);
    expect(second.ok).toBe(true);
  });

  it("does not cross-contaminate between different senders", async () => {
    const { orgId, b, c } = setupOrgWithThreeAgents();
    const senderTwo = registerAgent(orgId, "Sender Two");
    const first = await sendMessage(orgId, { id: senderTwo.agentId, name: "Sender Two" }, "Recipient B", LONG_BODY);
    expect(first.ok).toBe(true);
    // A different sender using the same body to a different recipient is not a duplicate of Sender Two's send.
    const second = await sendMessage(orgId, b, "Recipient C", LONG_BODY);
    expect(second.ok).toBe(true);
  });

  it("ignores short bodies entirely -- routine boilerplate/acks legitimately repeat verbatim", async () => {
    // The real case this protects: project-isolation.test.ts's completeness matrix legitimately
    // calls sendMessage with the fixed literal "from alpha" across many independent scenarios --
    // a length-blind check flagged that as a duplicate storm, which it structurally isn't.
    const { orgId, sender } = setupOrgWithThreeAgents();
    const first = await sendMessage(orgId, sender, "Recipient B", "from alpha");
    expect(first.ok).toBe(true);
    const second = await sendMessage(orgId, sender, "Recipient C", "from alpha");
    expect(second.ok).toBe(true);
  });

  it("does NOT apply to broadcast_message -- sending the same body to many recipients is its whole purpose", async () => {
    const { orgId, sender } = setupOrgWithThreeAgents();
    const result = await broadcastMessage(orgId, sender, { channel: "org" }, LONG_BODY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries.every((d) => d.ok)).toBe(true);
  });

  it("reply() rejects the same (long) body answering a second open thread within the window", async () => {
    const { orgId, sender, b, c } = setupOrgWithThreeAgents();
    const q1 = await askClarification(orgId, b, sender.name, "which branch?", 0.05);
    const q2 = await askClarification(orgId, c, sender.name, "which branch, also?", 0.05);
    if (!q1.ok || !q2.ok) throw new Error("setup failed");

    const firstReply = reply(orgId, sender, q1.threadId, LONG_BODY);
    expect(firstReply.ok).toBe(true);
    const secondReply = reply(orgId, sender, q2.threadId, LONG_BODY);
    expect(secondReply.ok).toBe(false);
    if (secondReply.ok) return;
    expect(secondReply.error).toContain("already sent this exact message");
  });

  it("reply() allows a genuinely different answer on a second thread", async () => {
    const { orgId, sender, b, c } = setupOrgWithThreeAgents();
    const q1 = await askClarification(orgId, b, sender.name, "which branch?", 0.05);
    const q2 = await askClarification(orgId, c, sender.name, "which env?", 0.05);
    if (!q1.ok || !q2.ok) throw new Error("setup failed");

    expect(reply(orgId, sender, q1.threadId, "main").ok).toBe(true);
    expect(reply(orgId, sender, q2.threadId, "staging").ok).toBe(true);
  });
});

describe("send_message (offline path)", () => {
  it("queues a message and it's readable via get_messages, then marked read", async () => {
    const { orgId, a, b } = setupOrgWithTwoAgents();
    const result = await sendMessage(orgId, a, "Agent B", "hello there");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delivered).toBe("queued"); // B has no live socket in this test

    const unread1 = getMessages(orgId, b.id);
    expect(unread1).toHaveLength(1);
    expect(unread1[0].body).toBe("hello there");
    expect(unread1[0].from_agent_name).toBe("Agent A");

    // Second call must return nothing new -- the first call marked it read.
    const unread2 = getMessages(orgId, b.id);
    expect(unread2).toHaveLength(0);
  });

  it("returns an error for an unknown target agent, without crashing", async () => {
    const { orgId, a } = setupOrgWithTwoAgents();
    const result = await sendMessage(orgId, a, "NoSuchAgent", "hi");
    expect(result.ok).toBe(false);
  });
});

describe("ask_clarification (offline fallback path -- no live socket registered)", () => {
  it("falls back to a durable, awaiting-reply question when the target isn't live", async () => {
    const { orgId, a, b } = setupOrgWithTwoAgents();
    const result = await askClarification(orgId, a, "Agent B", "are we good to ship?", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.live).toBe(false);

    const inbox = getMessages(orgId, b.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].kind).toBe("question");
    expect(inbox[0].awaiting_reply).toBe(1);
  });

  it("a reply to a durable question clears awaiting_reply and reaches the original asker", async () => {
    const { orgId, a, b } = setupOrgWithTwoAgents();
    const asked = await askClarification(orgId, a, "Agent B", "are we good to ship?", 1);
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;

    const result = reply(orgId, b, asked.threadId, "yes, ship it");
    expect(result.ok).toBe(true);

    const askerInbox = getMessages(orgId, a.id);
    expect(askerInbox).toHaveLength(1);
    expect(askerInbox[0].kind).toBe("reply");
    expect(askerInbox[0].body).toBe("yes, ship it");
  });

  it("replying to an unknown thread fails cleanly", () => {
    const { orgId, b } = setupOrgWithTwoAgents();
    const result = reply(orgId, b, "not-a-real-thread-id", "??");
    expect(result.ok).toBe(false);
  });

  // reply used to accept only question threads, so agents answering a plain
  // send_message got "No pending question found" and fell back to new threads.
  it("a reply to a plain message thread reaches its sender on the same thread", async () => {
    const { orgId, a, b } = setupOrgWithTwoAgents();
    const sent = await sendMessage(orgId, a, "Agent B", "ping");
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    expect(reply(orgId, b, sent.threadId, "pong")).toEqual({ ok: true });

    const senderInbox = getMessages(orgId, a.id);
    expect(senderInbox).toHaveLength(1);
    expect(senderInbox[0]).toMatchObject({ kind: "reply", body: "pong", thread_id: sent.threadId });
  });

  it("an agent cannot reply into a plain thread that was never addressed to it", async () => {
    const { orgId, a, b } = setupOrgWithTwoAgents();
    const c = registerAgent(orgId, "Agent C");
    const sent = await sendMessage(orgId, a, "Agent B", "for B only");
    if (!sent.ok) return;

    expect(reply(orgId, { id: c.agentId, name: "Agent C" }, sent.threadId, "butting in").ok).toBe(false);
    expect(getMessages(orgId, a.id)).toHaveLength(0);
  });

  // The thread's starter kept hitting "No message addressed to you" when following up on their
  // own thread before the other side answered, and fell back to opening new threads.
  it("the sender can follow up on their own thread, reaching the other participant", async () => {
    const { orgId, a, b } = setupOrgWithTwoAgents();
    const sent = await sendMessage(orgId, a, "Agent B", "please check PR 80");
    if (!sent.ok) throw new Error("send failed");

    expect(reply(orgId, a, sent.threadId, "also check PR 81")).toEqual({ ok: true });
    const inbox = getMessages(orgId, b.id);
    expect(inbox.map((m) => [m.body, m.thread_id])).toEqual([["please check PR 80", sent.threadId], ["also check PR 81", sent.threadId]]);
    expect(getMessages(orgId, a.id)).toHaveLength(0);
  });

  // Found in review by Codex-Session: the open-question lookup ignored who the question was
  // for, so the asker's own follow-up went back to the asker and closed their own question.
  it("the asker's follow-up on an open question reaches the other agent and leaves the question open", async () => {
    const { orgId, a, b } = setupOrgWithTwoAgents();
    const asked = await askClarification(orgId, a, "Agent B", "are we good to ship?", 0);
    if (!asked.ok) throw new Error("ask failed");

    expect(reply(orgId, a, asked.threadId, "context: the deploy is at 5pm")).toEqual({ ok: true });
    const bInbox = getMessages(orgId, b.id, undefined, { peek: true });
    expect(bInbox.map((m) => m.body)).toEqual(["are we good to ship?", "context: the deploy is at 5pm"]);
    expect(bInbox.find((m) => m.kind === "question")?.awaiting_reply).toBe(1);
    expect(getMessages(orgId, a.id, undefined, { peek: true })).toHaveLength(0);

    // B's real answer still closes the question and reaches A.
    expect(reply(orgId, b, asked.threadId, "yes, ship it")).toEqual({ ok: true });
    expect(getMessages(orgId, a.id).map((m) => m.body)).toEqual(["yes, ship it"]);
  });

  it("an agent the question wasn't addressed to can't answer it", async () => {
    const { orgId, a } = setupOrgWithTwoAgents();
    const c = registerAgent(orgId, "Agent C");
    const asked = await askClarification(orgId, a, "Agent B", "B only: ok to deploy?", 0);
    if (!asked.ok) throw new Error("ask failed");
    expect(reply(orgId, { id: c.agentId, name: "Agent C" }, asked.threadId, "sure!").ok).toBe(false);
  });
});

describe("presence", () => {
  it("an agent with no heartbeat is offline", () => {
    const { orgId } = setupOrgWithTwoAgents();
    const agents = listActiveAgents(orgId);
    expect(agents.every((a) => a.online === false)).toBe(true);
  });

  it("heartbeat marks an agent online", () => {
    const { orgId, a } = setupOrgWithTwoAgents();
    heartbeat(orgId, a.id);
    const agents = listActiveAgents(orgId);
    const found = agents.find((x) => x.id === a.id);
    expect(found?.online).toBe(true);
  });
});
