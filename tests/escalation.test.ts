import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { createOrganization, getMessages, heartbeat, listActiveAgents, registerAgent, sendMessage, setAgentStatus, sweepStaleAgents, type MessageRecord } from "../src/service.js";
import { SYSTEM_SENDER, isPureAck, sweepEscalations } from "../src/escalation.js";
import { isPureAck as isPureAckMjs } from "../scripts/pure-ack.mjs";

function setup({ operators = 1 }: { operators?: number } = {}) {
  const { orgId } = createOrganization("Escalation Org");
  const ops = Array.from({ length: operators }, (_, i) => registerAgent(orgId, `Operator-${i}`, { role: "operator", system: true }));
  const sender = registerAgent(orgId, "Codex-Sender");
  const other = registerAgent(orgId, "Gemini-Other");
  const stuck = registerAgent(orgId, "Claude-Stuck");
  return {
    orgId,
    ops: ops.map((o) => ({ id: o.agentId, name: o.agentName })),
    sender: { id: sender.agentId, name: sender.agentName },
    other: { id: other.agentId, name: other.agentName },
    stuck: { id: stuck.agentId, name: stuck.agentName },
  };
}

async function send(orgId: string, from: { id: string; name: string }, to: string, body: string, priority: "high" | "medium" | "low" = "high") {
  const res = await sendMessage(orgId, from, to, body, priority);
  if (!res.ok) throw new Error(res.error);
  return db.prepare(`SELECT * FROM messages WHERE thread_id = ?`).get(res.threadId) as MessageRecord;
}

/** `minutes` after a message's SQLite created_at (UTC, no zone suffix). */
const after = (m: MessageRecord, minutes: number) => new Date(Date.parse(`${m.created_at.replace(" ", "T")}Z`) + minutes * 60_000);

const notices = (orgId: string) =>
  db.prepare(`SELECT * FROM messages WHERE org_id = ? AND from_agent_id = ? ORDER BY rowid`).all(orgId, SYSTEM_SENDER.id) as MessageRecord[];
const escalations = (orgId: string) => listEvents(orgId, { types: ["message.escalated"] });

describe("sweepEscalations", () => {
  it("does nothing for an unread P1 at 9 minutes", async () => {
    const { orgId, sender, stuck } = setup();
    const m = await send(orgId, sender, stuck.name, "prod is down, stop deploying");
    await sweepEscalations(after(m, 9));
    expect(notices(orgId)).toHaveLength(0);
    expect(escalations(orgId)).toHaveLength(0);
  });

  it("at 10 minutes sends one high-priority notice to each operator and emits one event", async () => {
    const { orgId, ops, sender, stuck } = setup({ operators: 2 });
    const m = await send(orgId, sender, stuck.name, "prod is down, stop deploying");
    await sweepEscalations(after(m, 10));

    const sent = notices(orgId);
    expect(sent.map((n) => n.to_agent_id).sort()).toEqual(ops.map((o) => o.id).sort());
    for (const n of sent) {
      expect(n.priority).toBe("high");
      expect(n.from_agent_name).toBe(SYSTEM_SENDER.name);
      expect(n.body).toBe(
        `ESCALATION: Claude-Stuck has not read 1 high-priority message(s) from Codex-Sender for 10 min. ` +
          `Oldest: "prod is down, stop deploying". They may be idle; check their session.`,
      );
    }
    const events = escalations(orgId);
    expect(events).toHaveLength(1);
    expect(events[0].subject_id).toBe(stuck.id);
    expect(JSON.parse(events[0].payload)).toMatchObject({ recipientAgentId: stuck.id, messageIds: [m.id], messageCount: 1, level: 1, operatorCount: 2 });
  });

  it("skips a P1 that was read at 9 minutes", async () => {
    const { orgId, sender, stuck } = setup();
    const m = await send(orgId, sender, stuck.name, "prod is down");
    getMessages(orgId, stuck.id);
    await sweepEscalations(after(m, 10));
    expect(notices(orgId)).toHaveLength(0);
    expect(escalations(orgId)).toHaveLength(0);
  });

  it("skips low and medium priority", async () => {
    const { orgId, sender, stuck } = setup();
    await send(orgId, sender, stuck.name, "lunch?", "medium");
    const m = await send(orgId, sender, stuck.name, "fyi", "low");
    await sweepEscalations(after(m, 60));
    expect(notices(orgId)).toHaveLength(0);
    expect(escalations(orgId)).toHaveLength(0);
  });

  it("skips a pure acknowledgement sent at high priority", async () => {
    const { orgId, sender, stuck } = setup();
    const m = await send(orgId, sender, stuck.name, "Thanks.");
    await sweepEscalations(after(m, 60));
    expect(notices(orgId)).toHaveLength(0);
  });

  it("re-notifies at 20 and 40 minutes, then never again", async () => {
    const { orgId, sender, stuck } = setup();
    const m = await send(orgId, sender, stuck.name, "prod is down");
    const counts: number[] = [];
    for (const minute of [10, 11, 19, 20, 30, 40, 41, 80, 500]) {
      await sweepEscalations(after(m, minute));
      counts.push(notices(orgId).length);
    }
    expect(counts).toEqual([1, 1, 1, 2, 2, 3, 3, 3, 3]);
    expect(escalations(orgId).map((e) => JSON.parse(e.payload).level)).toEqual([1, 2, 3]);
  });

  // Change request 6b: agent state changes (status, heartbeat, suspend and resume) must not re-arm escalation.
  it("stays at three notices however the recipient's state changes between sweeps", async () => {
    const { orgId, sender, stuck } = setup();
    const m = await send(orgId, sender, stuck.name, "prod is down");
    for (const [i, minute] of [10, 15, 20, 25, 40, 45, 90, 600].entries()) {
      if (i % 2 === 0) setAgentStatus(orgId, stuck.id, `still busy ${i}`, [], "testing");
      else heartbeat(orgId, stuck.id);
      if (i === 5) sweepStaleAgents(Date.now() + 24 * 60 * 60 * 1000);
      listActiveAgents(orgId);
      await sweepEscalations(after(m, minute));
    }
    expect(notices(orgId)).toHaveLength(3);
  });

  it("batches two stuck messages to the same recipient into one notice", async () => {
    const { orgId, ops, sender, other, stuck } = setup();
    const first = await send(orgId, sender, stuck.name, "first: prod is down");
    const second = await send(orgId, other, stuck.name, "second: rollback needed");
    // Same second as the first, so both are exactly 10 minutes old at the sweep.
    db.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).run(first.created_at, second.id);
    await sweepEscalations(after(first, 10));

    const sent = notices(orgId);
    expect(sent).toHaveLength(1);
    expect(sent[0].to_agent_id).toBe(ops[0].id);
    expect(sent[0].body).toContain("has not read 2 high-priority message(s) from Codex-Sender, Gemini-Other");
    expect(sent[0].body).toContain(`Oldest: "first: prod is down"`);
    const events = escalations(orgId);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload).messageIds).toEqual([first.id, second.id]);
  });

  it("truncates the oldest body preview to 120 characters", async () => {
    const { orgId, sender, stuck } = setup();
    const m = await send(orgId, sender, stuck.name, `${"x".repeat(120)}TAIL`);
    await sweepEscalations(after(m, 10));
    expect(notices(orgId)[0].body).toContain(`Oldest: "${"x".repeat(120)}".`);
  });

  it("skips messages addressed to an operator", async () => {
    const { orgId, ops, sender } = setup({ operators: 2 });
    const m = await send(orgId, sender, ops[0].name, "operator, please look");
    await sweepEscalations(after(m, 60));
    expect(notices(orgId)).toHaveLength(0);
    expect(escalations(orgId)).toHaveLength(0);
  });

  it("emits only the event when the org has no operator", async () => {
    const { orgId, sender, stuck } = setup({ operators: 0 });
    const m = await send(orgId, sender, stuck.name, "prod is down");
    await expect(sweepEscalations(after(m, 10))).resolves.toBeUndefined();
    expect(notices(orgId)).toHaveLength(0);
    const events = escalations(orgId);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload).operatorCount).toBe(0);
  });

  it("re-notifications at 20 and 40 minutes reply into the same thread instead of starting a new one", async () => {
    const { orgId, ops, sender, stuck } = setup();
    const m = await send(orgId, sender, stuck.name, "prod is down");
    await sweepEscalations(after(m, 10));
    await sweepEscalations(after(m, 20));
    await sweepEscalations(after(m, 40));

    const sent = notices(orgId);
    expect(sent).toHaveLength(3);
    const threadIds = new Set(sent.map((n) => n.thread_id));
    expect(threadIds.size).toBe(1);
    expect(sent.every((n) => n.to_agent_id === ops[0].id)).toBe(true);
    // Each later notice is a reply, not a fresh top-of-thread message.
    expect(sent[1].kind).toBe("reply");
    expect(sent[2].kind).toBe("reply");
  });

  it("gives each operator their own thread, and a second unrelated recipient's escalations don't share it", async () => {
    const { orgId, ops, sender, other, stuck } = setup({ operators: 2 });
    const m1 = await send(orgId, sender, stuck.name, "prod is down");
    await sweepEscalations(after(m1, 10));
    await sweepEscalations(after(m1, 20));

    const m2 = await send(orgId, sender, other.name, "also stuck");
    await sweepEscalations(after(m2, 10));

    const rows = db.prepare(`SELECT * FROM escalation_threads WHERE org_id = ? ORDER BY recipient_agent_id, operator_id`).all(orgId) as Array<{
      recipient_agent_id: string; operator_id: string; thread_id: string;
    }>;
    // (stuck, op0), (stuck, op1), (other, op0), (other, op1): one row per recipient x operator that ever escalated.
    expect(rows).toHaveLength(2 * ops.length);
    const stuckThreads = new Set(rows.filter((r) => r.recipient_agent_id === stuck.id).map((r) => r.thread_id));
    expect(stuckThreads.size).toBe(ops.length); // one thread per operator for the same recipient
    const otherThreads = rows.filter((r) => r.recipient_agent_id === other.id).map((r) => r.thread_id);
    expect(otherThreads.every((t) => !stuckThreads.has(t))).toBe(true);
  });

  it("never puts message body text in the event payload", async () => {
    const { orgId, sender, stuck } = setup();
    const m = await send(orgId, sender, stuck.name, "SECRET-BODY-TEXT rotate the prod credentials");
    await sweepEscalations(after(m, 10));
    const [event] = escalations(orgId);
    expect(event.payload).not.toContain("SECRET-BODY-TEXT");
    expect(event.payload).not.toContain("rotate");
  });
});

describe("isPureAck (TS port)", () => {
  it("agrees with scripts/pure-ack.mjs", () => {
    const samples = [
      "Thanks.", "got it", "Acknowledged!", "Confirmed, got both: 16:12:09Z. Round-trip works. Thanks.",
      "thanks, fix the build", "Got it?", "", "   ", "TASK ASSIGNMENT: acknowledge receipt.", "x".repeat(401), "roger roger",
    ];
    for (const s of samples) expect(isPureAck(s), s).toBe(isPureAckMjs(s));
  });
});
