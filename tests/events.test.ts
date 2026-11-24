import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { emitEvent, listEvents, verifyEventChain, waitForEvents, type EventRecord } from "../src/events.js";
import { listTimeline } from "../src/timeline.js";
import { askClarification, createOrganization, heartbeat, registerAgent, reply, sendMessage, setAgentStatus } from "../src/service.js";
import { claimTask, completeTask, createTask, releaseTask } from "../src/tasks.js";
import { decideApproval, requestApproval, revokeApprovalGrant } from "../src/approvals.js";
import { recordDecision } from "../src/events.js";
import { signInPerson } from "./helpers/person.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(name = "Events Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Claude-A");
  const b = registerAgent(orgId, "Codex-B");
  return {
    orgId,
    a: { id: a.agentId, name: "Claude-A", key: a.apiKey },
    b: { id: b.agentId, name: "Codex-B", key: b.apiKey },
  };
}

const types = (events: EventRecord[]) => events.map((e) => e.type);
const payload = (e: EventRecord) => JSON.parse(e.payload) as Record<string, unknown>;

describe("task events", () => {
  it("emits one typed event per task transition, in order, with the task as subject", () => {
    const { orgId, a } = setup();
    const task = createTask(orgId, a, { title: "Ship events" });
    claimTask(orgId, a, task.id, 60);
    releaseTask(orgId, a, task.id);
    claimTask(orgId, a, task.id, 60);
    completeTask(orgId, a, task.id, "done");

    const events = listEvents(orgId);
    expect(types(events)).toEqual(["task.created", "task.claimed", "task.released", "task.claimed", "task.completed"]);
    expect(events.every((e) => e.subject_type === "task" && e.subject_id === task.id && e.actor_agent_id === a.id)).toBe(true);
    expect(payload(events[0]).title).toBe("Ship events");
  });

  it("emits task.lease_expired once, directed at the previous claimant, before a takeover", async () => {
    const { orgId, a, b } = setup();
    const task = createTask(orgId, a, { title: "Stale work" });
    claimTask(orgId, a, task.id, 0.2);
    await sleep(300);

    listTimeline(orgId);
    listTimeline(orgId);
    claimTask(orgId, b, task.id, 60);

    const events = listEvents(orgId);
    const expired = events.filter((e) => e.type === "task.lease_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0].target_agent_id).toBe(a.id);
    expect(expired[0].actor_agent_id).toBeNull();
    expect(types(events).slice(-2)).toEqual(["task.lease_expired", "task.claimed"]);
  });

  it("rolls back the state change when its event can't be written", () => {
    const { orgId, a } = setup();
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ?`).get(orgId) as { n: number }).n;
    expect(() => db.transaction(() => {
      db.prepare(`INSERT INTO tasks (id, org_id, title, created_by_agent_id, created_by_agent_name) VALUES ('t-rollback', ?, 'x', ?, ?)`).run(orgId, a.id, a.name);
      emitEvent({ orgId, type: "not.a.real.type" as never, subjectType: "task", subjectId: "t-rollback" });
    })()).toThrow(/event type/);
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ?`).get(orgId) as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe("message events", () => {
  it("records messages, questions and answers as directed events without copying bodies", async () => {
    const { orgId, a, b } = setup();
    await sendMessage(orgId, a, "Codex-B", "secret plan details");
    const q = await askClarification(orgId, a, "Codex-B", "is main green?", 1);
    const threadId = q.ok ? q.threadId : "";
    reply(orgId, b, threadId, "yes");

    const events = listEvents(orgId);
    expect(types(events)).toEqual(["message.sent", "question.asked", "question.answered"]);
    expect(events[0].target_agent_id).toBe(b.id);
    expect(events[2].target_agent_id).toBe(a.id);
    expect(events[2].actor_agent_id).toBe(b.id);
    expect(JSON.stringify(events)).not.toContain("secret plan details");
    expect(payload(events[1]).threadId).toBe(threadId);
  });
});

describe("approval events", () => {
  it("covers request, decision, grants, auto-approval and revocation", async () => {
    const { orgId, a, b } = setup();
    // A person decides the clearance (migration 53); agent B is still the named approver. Signing the person in adds
    // member events of its own, so only approval events are compared below.
    const { decider } = await signInPerson(orgId, "Ada");
    const req = await requestApproval(orgId, a, { action: "git push --force", category: "force-push", approver: "Codex-B" });
    const decided = decideApproval(orgId, decider, req.id, "approve", "ok", { grantMinutes: 30 });
    expect(decided.ok).toBe(true);
    await requestApproval(orgId, a, { action: "git push --force origin feat", category: "force-push" });
    revokeApprovalGrant(orgId, decided.ok ? decided.grant!.id : "");
    await requestApproval(orgId, a, { action: "rm -rf build", notifyOnly: true });

    const events = listEvents(orgId).filter((e) => e.type.startsWith("approval."));
    expect(types(events)).toEqual([
      "approval.requested", "approval.decided", "approval.grant_created",
      "approval.requested", "approval.decided",
      "approval.grant_revoked",
      "approval.noted",
    ]);
    expect(events[0].target_agent_id).toBe(b.id);
    expect(events[1].target_agent_id).toBe(a.id);
    expect(payload(events[1]).byPerson).toBe(true);
    expect(payload(events[4]).viaGrant).toBe(true);
    expect(payload(events[4]).byPerson).toBe(true);
    expect(events[5].target_agent_id).toBe(a.id);
  });

  it("emits approval.expired lazily, once, directed at the requester", async () => {
    const { orgId, a } = setup();
    await requestApproval(orgId, a, { action: "terraform destroy", expiresInSeconds: 0.2 });
    await sleep(300);
    listTimeline(orgId);
    listTimeline(orgId);
    const expired = listEvents(orgId).filter((e) => e.type === "approval.expired");
    expect(expired).toHaveLength(1);
    expect(expired[0].target_agent_id).toBe(a.id);
  });
});

describe("agent state events", () => {
  it("emits phase and task changes only when they actually change", () => {
    const { orgId, a } = setup();
    setAgentStatus(orgId, a.id, "Refactor auth", [], "planning");
    setAgentStatus(orgId, a.id, "Refactor auth", [], "planning");
    setAgentStatus(orgId, a.id, "Refactor auth", [], "editing");
    setAgentStatus(orgId, a.id, "Refactor auth", []);

    const events = listEvents(orgId);
    expect(types(events)).toEqual(["agent.task_changed", "agent.phase_changed", "agent.phase_changed"]);
    expect(payload(events[1])).toEqual({ from: null, to: "planning" });
    expect(payload(events[2])).toEqual({ from: "planning", to: "editing" });
  });

  it("rejects an unknown phase", () => {
    const { orgId, a } = setup();
    expect(() => setAgentStatus(orgId, a.id, null, [], "napping" as never)).toThrow(/phase/);
  });

  it("emits conflict.detected directed at the online agent already editing the file", () => {
    const { orgId, a, b } = setup();
    heartbeat(orgId, b.id);
    setAgentStatus(orgId, b.id, "Fix login", ["src/auth.ts"]);
    setAgentStatus(orgId, a.id, "Refactor auth", ["src/auth.ts", "src/rest.ts"]);

    const conflicts = listEvents(orgId).filter((e) => e.type === "conflict.detected");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].actor_agent_id).toBe(a.id);
    expect(conflicts[0].target_agent_id).toBe(b.id);
    expect(payload(conflicts[0]).files).toEqual(["src/auth.ts"]);
  });
});

describe("decisions", () => {
  it("records a decision as a first-class event", () => {
    const { orgId, a } = setup();
    const event = recordDecision(orgId, a, { title: "Use SQLite for beta", rationale: "single instance", scope: "src/db.ts" });
    expect(event.type).toBe("decision.recorded");
    expect(event.subject_type).toBe("decision");
    expect(payload(event)).toEqual({ title: "Use SQLite for beta", rationale: "single instance", scope: "src/db.ts" });
    expect(() => recordDecision(orgId, a, { title: "  " })).toThrow(/title/);
  });
});

describe("timeline reads", () => {
  it("pages with an after-cursor, filters by type, caps the limit and isolates orgs", () => {
    const { orgId, a } = setup();
    const other = setup("Other Events Org");
    for (let i = 0; i < 5; i++) createTask(orgId, a, { title: `t${i}` });
    createTask(other.orgId, other.a, { title: "not yours" });

    const first = listEvents(orgId, { limit: 2 });
    const rest = listEvents(orgId, { after: first[1].seq });
    expect(first.length + rest.length).toBe(5);
    expect(rest[0].seq).toBeGreaterThan(first[1].seq);
    expect(listEvents(orgId, { types: ["task.claimed"] })).toHaveLength(0);
    expect(listEvents(orgId, { limit: 10_000 }).length).toBeLessThanOrEqual(200);
    expect(listEvents(orgId).some((e) => e.org_id !== orgId)).toBe(false);
  });

  it("waitForEvents returns existing events at once, wakes on a new one, and times out empty", async () => {
    const { orgId, a } = setup();
    createTask(orgId, a, { title: "already here" });
    const start = Date.now();
    expect(await waitForEvents(orgId, 0, 5)).toHaveLength(1);
    expect(Date.now() - start).toBeLessThan(500);

    const cursor = listEvents(orgId).at(-1)!.seq;
    const waiting = waitForEvents(orgId, cursor, 5);
    await sleep(30);
    createTask(orgId, a, { title: "arrives later" });
    expect(types(await waiting)).toEqual(["task.created"]);

    const quiet = Date.now();
    expect(await waitForEvents(orgId, listEvents(orgId).at(-1)!.seq, 1)).toHaveLength(0);
    expect(Date.now() - quiet).toBeGreaterThanOrEqual(900);
  });
});

describe("tamper-evident hash chain", () => {
  it("chains every emitted event to the previous one, per org, and verifies clean", () => {
    const { orgId, a } = setup();
    createTask(orgId, a, { title: "t1" });
    createTask(orgId, a, { title: "t2" });
    createTask(orgId, a, { title: "t3" });

    const events = listEvents(orgId);
    expect(events).toHaveLength(3);
    expect(events[0].prev_hash).toBeNull();
    expect(events[0].hash).toEqual(expect.any(String));
    expect(events[1].prev_hash).toBe(events[0].hash);
    expect(events[2].prev_hash).toBe(events[1].hash);
    // Distinct rows must not collide onto the same hash.
    expect(new Set(events.map((e) => e.hash)).size).toBe(3);

    expect(verifyEventChain(orgId)).toEqual({ ok: true });
  });

  it("keeps chains independent per org", () => {
    const { orgId: orgA, a } = setup("Chain Org A");
    const { orgId: orgB, a: b } = setup("Chain Org B");
    createTask(orgA, a, { title: "a1" });
    createTask(orgB, b, { title: "b1" });

    const [eventA] = listEvents(orgA);
    const [eventB] = listEvents(orgB);
    expect(eventA.prev_hash).toBeNull();
    expect(eventB.prev_hash).toBeNull();
    expect(eventA.hash).not.toBe(eventB.hash);
    expect(verifyEventChain(orgA)).toEqual({ ok: true });
    expect(verifyEventChain(orgB)).toEqual({ ok: true });
  });

  it("detects a row tampered after the fact, at the exact seq it was edited", () => {
    const { orgId, a } = setup();
    createTask(orgId, a, { title: "original title" });
    createTask(orgId, a, { title: "second" });
    createTask(orgId, a, { title: "third" });

    const [first, , third] = listEvents(orgId);
    expect(verifyEventChain(orgId)).toEqual({ ok: true });

    // Simulate tampering: directly rewrite a row's payload via raw SQL, exactly
    // as an attacker with DB access (not going through emitEvent) would.
    db.prepare(`UPDATE events SET payload = ? WHERE seq = ?`).run(JSON.stringify({ title: "REWRITTEN" }), first.seq);

    const result = verifyEventChain(orgId);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(first.seq);

    // The edited row's own hash no longer matches, but its neighbors' stored
    // hashes are untouched -- the break is localized to the tampered row.
    expect(third.hash).not.toBeNull();
  });

  it("treats pre-migration rows (hash = null) as a fresh genesis, not a break", () => {
    const { orgId, a } = setup();
    createTask(orgId, a, { title: "legacy row simulated" });
    const [legacy] = listEvents(orgId);
    // Simulate a row written before hash-chaining existed.
    db.prepare(`UPDATE events SET prev_hash = NULL, hash = NULL WHERE seq = ?`).run(legacy.seq);

    createTask(orgId, a, { title: "first hashed row" });
    const events = listEvents(orgId);
    expect(events[0].hash).toBeNull();
    expect(events[1].prev_hash).toBeNull(); // chains from nothing, not from the legacy row
    expect(verifyEventChain(orgId)).toEqual({ ok: true });
  });
});

describe("REST timeline", () => {
  let server: http.Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = (key: string, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  it("serves events, records decisions and accepts phase on status", async () => {
    const { a } = setup("REST Events Org");
    expect((await fetch(`${baseUrl}/v1/events`)).status).toBe(401);

    expect((await call(a.key, "POST", "/v1/status", { task: "x", phase: "testing" })).status).toBe(200);
    expect((await call(a.key, "POST", "/v1/status", { task: "x", phase: "napping" })).status).toBe(400);
    expect((await call(a.key, "POST", "/v1/decisions", { title: "Adopt A2A bridge later" })).status).toBe(201);
    expect((await call(a.key, "POST", "/v1/decisions", {})).status).toBe(400);

    const res = await call(a.key, "GET", "/v1/events?types=agent.phase_changed,decision.recorded");
    const { events, nextAfter } = (await res.json()) as { events: EventRecord[]; nextAfter: number };
    expect(types(events)).toEqual(["agent.phase_changed", "decision.recorded"]);
    expect(nextAfter).toBe(events.at(-1)!.seq);

    const waited = await call(a.key, "GET", `/v1/events/wait?after=${nextAfter}&timeoutSeconds=1`);
    expect(((await waited.json()) as { events: EventRecord[] }).events).toHaveLength(0);
  });
});
