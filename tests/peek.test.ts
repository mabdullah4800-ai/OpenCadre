import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { createOrganization, getMessages, registerAgent, sendMessage, waitForMessage } from "../src/service.js";

function setupOrgWithTwoAgents() {
  const { orgId } = createOrganization("Peek Test Org");
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return { orgId, a: { id: a.agentId, name: "Agent A" }, bAgentId: b.agentId, bKey: b.apiKey };
}

describe("getMessages peek", () => {
  it("returns unread mail without marking it read", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "look but don't consume");

    const peeked = getMessages(orgId, bAgentId, undefined, { peek: true });
    expect(peeked.map((m) => m.body)).toEqual(["look but don't consume"]);
    expect(peeked[0].read_at).toBeNull();

    // A peek must not steal the message from the next real reader.
    const consumed = getMessages(orgId, bAgentId);
    expect(consumed.map((m) => m.body)).toEqual(["look but don't consume"]);
    expect(getMessages(orgId, bAgentId)).toHaveLength(0);
  });

  it("does not mark messages read when combined with since", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "since + peek");

    const peeked = getMessages(orgId, bAgentId, "1970-01-01 00:00:00", { peek: true });
    expect(peeked).toHaveLength(1);
    expect(getMessages(orgId, bAgentId)).toHaveLength(1);
  });
});

// created_at is SQLite "YYYY-MM-DD HH:MM:SS"; an ISO since ("…T…Z") used to be
// compared as a raw string, and "T" sorts after " ", so it silently matched nothing.
describe("getMessages since", () => {
  it("accepts ISO 8601 timestamps, not just SQLite datetime strings", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "after an ISO since");

    expect(getMessages(orgId, bAgentId, new Date(Date.now() - 3_600_000).toISOString(), { peek: true })).toHaveLength(1);
    expect(getMessages(orgId, bAgentId, new Date(Date.now() + 3_600_000).toISOString(), { peek: true })).toHaveLength(0);
  });
});

// A peek-only watcher never marks mail read, so without a cursor every
// peek-wait returns the same unread mail instantly and the watcher spins.
describe("afterId cursor", () => {
  it("getMessages returns only unread mail newer than the cursor", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "first");
    const [first] = getMessages(orgId, bAgentId, undefined, { peek: true });
    await sendMessage(orgId, a, "Agent B", "second");

    const after = getMessages(orgId, bAgentId, undefined, { peek: true, afterId: first.id });
    expect(after.map((m) => m.body)).toEqual(["second"]);
    // An unknown cursor falls back to all unread rather than hiding mail.
    expect(getMessages(orgId, bAgentId, undefined, { peek: true, afterId: "no-such-id" })).toHaveLength(2);
  });

  it("a peek-wait with a cursor blocks past already-seen mail and returns only the new message", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "seen already");
    const [seen] = getMessages(orgId, bAgentId, undefined, { peek: true });

    const start = Date.now();
    const waitPromise = waitForMessage(orgId, bAgentId, 5, { peek: true, afterId: seen.id });
    await new Promise((r) => setTimeout(r, 150));
    await sendMessage(orgId, a, "Agent B", "brand new");
    const rows = await waitPromise;

    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
    expect(rows.map((m) => m.body)).toEqual(["brand new"]);
  });
});

describe("waitForMessage peek", () => {
  it("returns already-unread mail immediately without consuming it", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "waiting peek");

    const start = Date.now();
    const peeked = await waitForMessage(orgId, bAgentId, 5, { peek: true });
    expect(Date.now() - start).toBeLessThan(500);
    expect(peeked).toHaveLength(1);
    expect(getMessages(orgId, bAgentId)).toHaveLength(1);
  });

  it("returns mail that arrives mid-wait without consuming it", async () => {
    const { orgId, a, bAgentId } = setupOrgWithTwoAgents();
    const waitPromise = waitForMessage(orgId, bAgentId, 5, { peek: true });
    await new Promise((r) => setTimeout(r, 20));
    await sendMessage(orgId, a, "Agent B", "arrives during peek wait");

    const peeked = await waitPromise;
    expect(peeked.map((m) => m.body)).toEqual(["arrives during peek wait"]);
    expect(getMessages(orgId, bAgentId)).toHaveLength(1);
  });
});

describe("REST peek", () => {
  let baseUrl: string;
  let server: ReturnType<typeof app.listen>;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("GET /v1/messages?peek=true leaves mail unread", async () => {
    const { orgId, a, bAgentId, bKey } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "rest peek");

    const res = await fetch(`${baseUrl}/v1/messages?peek=true`, { headers: { authorization: `Bearer ${bKey}` } });
    expect(res.status).toBe(200);
    const { messages } = (await res.json()) as { messages: Array<{ body: string }> };
    expect(messages.map((m) => m.body)).toEqual(["rest peek"]);
    expect(getMessages(orgId, bAgentId)).toHaveLength(1);
  });

  it("GET /v1/messages/wait?peek=true leaves mail unread", async () => {
    const { orgId, a, bAgentId, bKey } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "rest wait peek");

    const res = await fetch(`${baseUrl}/v1/messages/wait?timeoutSeconds=2&peek=true`, {
      headers: { authorization: `Bearer ${bKey}` },
    });
    const { messages } = (await res.json()) as { messages: Array<{ body: string }> };
    expect(messages).toHaveLength(1);
    expect(getMessages(orgId, bAgentId)).toHaveLength(1);
  });

  it("GET /v1/messages/wait?peek=true&afterId= skips mail the watcher already saw", async () => {
    const { orgId, a, bAgentId, bKey } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "old");
    const [old] = getMessages(orgId, bAgentId, undefined, { peek: true });
    await sendMessage(orgId, a, "Agent B", "new");

    const res = await fetch(`${baseUrl}/v1/messages/wait?timeoutSeconds=2&peek=true&afterId=${old.id}`, {
      headers: { authorization: `Bearer ${bKey}` },
    });
    const { messages } = (await res.json()) as { messages: Array<{ id: string; body: string }> };
    expect(messages.map((m) => m.body)).toEqual(["new"]);
    expect(messages[0].id).toBeTruthy();
  });

  it("GET /v1/messages without peek still consumes (backward compatible)", async () => {
    const { orgId, a, bAgentId, bKey } = setupOrgWithTwoAgents();
    await sendMessage(orgId, a, "Agent B", "rest consume");

    await fetch(`${baseUrl}/v1/messages`, { headers: { authorization: `Bearer ${bKey}` } });
    expect(getMessages(orgId, bAgentId)).toHaveLength(0);
  });
});
