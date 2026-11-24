import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { createOrganization, heartbeat, registerAgent, sendMessage, setAgentStatus, staleAfterMs, sweepStaleAgents } from "../src/service.js";
import { createTask } from "../src/tasks.js";
import { requestApproval } from "../src/approvals.js";
import { emitEvent, recordDecision } from "../src/events.js";
import { ackEvent, getDelivery } from "../src/deliveries.js";
import { getAwareness, DIGEST_MAX_CHARS } from "../src/awareness.js";

function setup(name = "Awareness Org") {
  const { orgId } = createOrganization(name);
  const me = registerAgent(orgId, "Claude-Me");
  const other = registerAgent(orgId, "Codex-Other");
  return {
    orgId,
    me: { id: me.agentId, name: "Claude-Me", key: me.apiKey },
    other: { id: other.agentId, name: "Codex-Other", key: other.apiKey },
  };
}

describe("getAwareness", () => {
  it("is empty when nothing relevant happened", () => {
    const { orgId, me } = setup();
    createTask(orgId, me, { title: "my own task" });
    const digest = getAwareness(orgId, me.id);
    expect(digest.items).toHaveLength(0);
    expect(digest.text).toBe("");
  });

  it("orders P1 before P2, collapses P3 into counts, and marks directed events delivered", async () => {
    const { orgId, me, other } = setup();
    createTask(orgId, other, { title: "Landing copy" });
    createTask(orgId, other, { title: "Stripe" });
    await sendMessage(orgId, other, "Claude-Me", "fyi");
    // Explicit high risk: attention-based routing (src/approvals.ts) now scales the approval notice's
    // priority with risk instead of always paging as P1/high, so this test needs a genuinely
    // high-risk request to still exercise "P1 before P2" ordering meaningfully.
    await requestApproval(orgId, other, { action: "terraform apply", approver: "Claude-Me", risk: "high" });

    const digest = getAwareness(orgId, me.id);
    expect(digest.items.map((i) => [i.type, i.priority])).toEqual([
      ["approval.requested", 1],
      ["message.sent", 1],
      ["message.sent", 2],
    ]);
    expect(digest.background).toEqual({ "task.created": 2 });
    expect(digest.text).toMatch(/^OpenCadre awareness/);
    expect(digest.text.indexOf("[P1]")).toBeLessThan(digest.text.indexOf("[P2]"));
    expect(digest.text).toContain("terraform apply");
    expect(digest.text).toContain("2 tasks created");
    expect(digest.text).toContain("ack_event");
    for (const item of digest.items) expect(getDelivery(orgId, me.id, item.seq)?.state).toBe("delivered");
  });

  it("advances its cursor so the next call only shows new activity, but unacknowledged P1s resurface", async () => {
    const { orgId, me, other } = setup();
    await sendMessage(orgId, other, "Claude-Me", "prod is down, stop deploying", "high");
    await sendMessage(orgId, other, "Claude-Me", "lunch?");
    createTask(orgId, other, { title: "noise" });
    const first = getAwareness(orgId, me.id);
    expect(first.items.map((i) => i.priority)).toEqual([1, 2]);
    const urgentSeq = first.items[0].seq;

    const second = getAwareness(orgId, me.id);
    expect(second.items.map((i) => i.seq)).toEqual([urgentSeq]);
    expect(second.background).toEqual({});

    ackEvent(orgId, me.id, urgentSeq, "acknowledged");
    expect(getAwareness(orgId, me.id).items).toHaveLength(0);
  });

  it("names the thread on a message item, so a body already read stays reachable", async () => {
    // Regression: this line read "sent you a message (read it with get_messages)" and omitted the
    // thread id. get_messages returns nothing once the message is read, so a lane that followed the
    // line to its inbox had no way back to the body -- while the one path that still returns it
    // (get_message_status(threadId) / GET /v1/messages/:threadId/status) needs exactly the id withheld.
    const { orgId, me, other } = setup();
    const sent = await sendMessage(orgId, other, "Claude-Me", "the body you will want after reading");
    if (!sent.ok) throw new Error(`send failed: ${sent.error}`);
    const digest = getAwareness(orgId, me.id);
    expect(digest.text).toContain(`thread ${sent.threadId}`);
  });

  it("omits the thread clause entirely when the event carries none, rather than printing an id that isn't one", () => {
    // The refusal case, and the reason line 58 guards instead of interpolating: a message.sent event
    // built without a threadId must degrade to the plain sentence, never render "thread undefined"
    // as though it were a thread a lane could look up.
    const { orgId, me, other } = setup();
    emitEvent({
      orgId,
      type: "message.sent",
      actor: { id: other.id, name: "Codex-Other" },
      subjectType: "message",
      subjectId: "no-thread-message",
      targetAgentId: me.id,
      payload: {},
    });
    const digest = getAwareness(orgId, me.id);
    expect(digest.text).toContain("Codex-Other sent you a message (read it with get_messages)");
    expect(digest.text).not.toContain("undefined");
  });

  it("uses the viewer's announced files to raise relevant decisions", () => {
    const { orgId, me, other } = setup();
    heartbeat(orgId, me.id);
    setAgentStatus(orgId, me.id, "auth refactor", ["src/auth.ts"]);
    recordDecision(orgId, other, { title: "Sessions move to JWT", scope: "src/auth.ts" });
    recordDecision(orgId, other, { title: "Docs style", scope: "docs" });

    const digest = getAwareness(orgId, me.id);
    expect(digest.items.map((i) => i.type)).toEqual(["decision.recorded"]);
    expect(digest.text).toContain("Sessions move to JWT");
    expect(digest.background).toEqual({ "decision.recorded": 1 });
  });

  it(`stays within ${DIGEST_MAX_CHARS} characters and says how many items were left out`, async () => {
    const { orgId, me, other } = setup();
    for (let i = 0; i < 40; i++) await sendMessage(orgId, other, "Claude-Me", `message ${i}`);
    const digest = getAwareness(orgId, me.id);
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest.text).toMatch(/\+\d+ more/);
    expect(digest.items).toHaveLength(40);
  });

  it("surfaces a teammate going stale/suspended as fleet-status background, not silence", () => {
    // Regression: agent.stale/agent.suspended used to be dropped entirely by policy.evaluate()
    // (not in BACKGROUND), so a teammate going quiet left no trace anywhere in the digest.
    const { orgId, me, other } = setup();
    // sweepStaleAgents only ever considers key_class != 'human'; making "me" human here keeps the
    // viewer itself out of the stale-candidate pool so the test isn't racing the injected clock.
    db.prepare(`UPDATE agents SET key_class = 'human' WHERE id = ?`).run(me.id);
    heartbeat(orgId, other.id);
    const beforeThreshold = Date.now() + staleAfterMs() - 1000;
    // Boundary: not yet past the stale threshold -- must not be flagged yet.
    expect(sweepStaleAgents(beforeThreshold).suspended).not.toContain(other.id);
    expect(getAwareness(orgId, me.id).background["agent.stale"]).toBeUndefined();

    const afterThreshold = Date.now() + staleAfterMs() + 1000;
    expect(sweepStaleAgents(afterThreshold).suspended).toContain(other.id);

    const digest = getAwareness(orgId, me.id);
    expect(digest.background).toEqual({ "agent.stale": 1, "agent.suspended": 1 });
    expect(digest.text).toContain("agents gone quiet");
    expect(digest.text).toContain("agents auto-paused");

    // Coming back is visible too.
    heartbeat(orgId, other.id);
    expect(getAwareness(orgId, me.id).background).toEqual({ "agent.resumed": 1 });
  });

  it("an explicit since cursor re-reads history without moving the saved cursor", async () => {
    const { orgId, me, other } = setup();
    createTask(orgId, other, { title: "one" });
    getAwareness(orgId, me.id);
    expect(getAwareness(orgId, me.id, { since: 0 }).background).toEqual({ "task.created": 1 });
    expect(getAwareness(orgId, me.id).background).toEqual({});
  });
});

describe("REST /v1/awareness", () => {
  let server: http.Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("returns the digest for the calling agent", async () => {
    const { orgId, me, other } = setup("REST Awareness Org");
    await sendMessage(orgId, other, "Claude-Me", "ping");
    expect((await fetch(`${baseUrl}/v1/awareness`)).status).toBe(401);
    const res = await fetch(`${baseUrl}/v1/awareness`, { headers: { authorization: `Bearer ${me.key}` } });
    const body = (await res.json()) as { text: string; items: Array<{ type: string }> };
    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.type)).toEqual(["message.sent"]);
    expect(body.text).toContain("Codex-Other");
  });
});
