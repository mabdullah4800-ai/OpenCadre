import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { app } from "../src/rest.js";
import { acceptLiveConnection, LIVE_MAX_PAYLOAD_BYTES } from "../src/live-connection.js";
import { consoleLiveSnapshot, enqueueConsoleEvent, flushConsoleLiveChanges, registerConsoleSocket, sweepConsoleLive } from "../src/console-live.js";
import { authenticateLiveRequest } from "../src/live-auth.js";
import { liveSocketCount, pushToAgent, sweepKeepalive } from "../src/live.js";
import { askClarification, createOrganization, getMessages, getThreadStatus, heartbeat, isOnline, registerAgent, reply, sendMessage, setAgentStatus, staleAfterMs, sweepStaleAgents } from "../src/service.js";
import { listEvents } from "../src/events.js";
import { acceptInvite, changeRole, createInvite, createSession, deleteSession, removeMember, SESSION_COOKIE, upsertPerson } from "../src/accounts.js";
import { pauseWorkspace } from "../src/kill-switch.js";
import { signInPerson } from "./helpers/person.js";
import { db, newId } from "../src/db.js";
import { emitEvent } from "../src/events.js";
import { createDevice, redeemDeviceCode, resolveSessionAgent } from "../src/devices.js";
import { setProjectEnabled } from "../src/projects.js";
import { linkProjects, setProjectIsolation, unlinkProjects } from "../src/project-isolation.js";
import { decideApproval, requestApproval } from "../src/approvals.js";
import { acceptTask, claimTask, completeTask, createTask, rejectTask, releaseTask, supersedeTask, sweepExpiredLeases } from "../src/tasks.js";
import { sweepEscalations } from "../src/escalation.js";
import { ConsoleCase } from "./helpers/console-case.js";

class FakeConsoleSocket extends EventEmitter {
  readonly OPEN = WebSocket.OPEN;
  readyState = WebSocket.OPEN;
  attempts = 0;
  closeAttempts = 0;
  terminateAttempts = 0;
  closeCode?: number;
  requestedCloseCode?: number;
  readonly sent: string[] = [];
  constructor(
    readonly bufferedAmount: number,
    private readonly throwsOnSend = false,
    private readonly throwsOnClose = false,
    private readonly throwsOnTerminate = false,
  ) { super(); }
  send(payload: string): void {
    this.attempts++;
    if (this.throwsOnSend) throw new Error("injected send failure");
    this.sent.push(payload);
  }
  close(code = 1000): void {
    this.closeAttempts++;
    this.requestedCloseCode = code;
    if (this.throwsOnClose) throw new Error("injected close failure");
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  terminate(): void {
    this.terminateAttempts++;
    if (this.throwsOnTerminate) throw new Error("injected terminate failure");
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

let server: ReturnType<typeof app.listen>;
let base: string;
let wsBase: string;
let wss: WebSocketServer;
let cleanupSeparationCase: (() => Promise<void>) | undefined;

afterEach(async () => {
  const cleanup = cleanupSeparationCase;
  cleanupSeparationCase = undefined;
  await cleanup?.();
});

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  wss = new WebSocketServer({ server, path: "/live", maxPayload: LIVE_MAX_PAYLOAD_BYTES });
  wss.on("connection", (ws, req) => acceptLiveConnection(ws, req));
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function untilMessage(ws: WebSocket, timeoutMs = 1000, label = "socket message"): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
}

function untilClose(ws: WebSocket, timeoutMs = 1000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for socket close")), timeoutMs);
    ws.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
}

function hasMessageWithin(ws: WebSocket, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onMessage = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { ws.off("message", onMessage); resolve(false); }, timeoutMs);
    ws.once("message", onMessage);
  });
}

async function openConsole(orgId: string, cookie: string, scope?: ConsoleCase, label = "console setup"): Promise<WebSocket> {
  scope?.assertActive();
  const ws = new WebSocket(`${wsBase}/live?workspace=${encodeURIComponent(orgId)}`, { headers: { cookie, origin: `http://127.0.0.1:${new URL(base).port}` } });
  if (scope) { scope.own(ws); await scope.opened(ws, label); }
  else await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
}

async function openAgent(key: string, scope?: ConsoleCase, label = "agent setup"): Promise<WebSocket> {
  scope?.assertActive();
  const ws = new WebSocket(`${wsBase}/live?apiKey=${encodeURIComponent(key)}`);
  if (scope) { scope.own(ws); await scope.opened(ws, label); }
  else await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
}

async function expectProducerHint<T>(orgId: string, sockets: WebSocket[], type: string, produce: () => T | Promise<T>): Promise<T> {
  const after = listEvents(orgId, { latest: true, limit: 1 }).at(-1)?.seq ?? 0;
  const hints = Promise.all(sockets.map((socket) => untilMessage(socket, 1000, type)));
  try {
    const result = await produce();
    expect(listEvents(orgId, { after, types: [type] })).toHaveLength(1);
    expect(await hints).toEqual(sockets.map(() => ({ type: "workspace.changed" })));
    return result;
  } catch (error) {
    await hints.catch(() => {}); // settle bounded listeners even when a producer/assertion fails first
    throw error;
  }
}

async function expectNoProducerHint<T>(orgId: string, socket: WebSocket, produce: () => T | Promise<T>): Promise<T> {
  const after = listEvents(orgId, { latest: true, limit: 1 }).at(-1)?.seq ?? 0;
  const unexpected = hasMessageWithin(socket, 50);
  const result = await produce();
  flushConsoleLiveChanges();
  expect(listEvents(orgId, { after })).toEqual([]);
  expect(await unexpected).toBe(false);
  return result;
}

describe("workspace console live channel", () => {
  it("an oversized agent frame closes its connection without taking down the hub", async () => {
    const { orgId } = createOrganization("Oversized live frame");
    const agent = registerAgent(orgId, "Oversized");
    const ws = await openAgent(agent.apiKey);
    const closed = untilClose(ws);
    ws.send(Buffer.alloc(LIVE_MAX_PAYLOAD_BYTES + 1));
    expect([1006, 1009]).toContain(await closed);
    const healthy = await openAgent(agent.apiKey);
    try { expect(healthy.readyState).toBe(WebSocket.OPEN); }
    finally { healthy.terminate(); await vi.waitFor(() => expect(liveSocketCount()).toBe(0)); }
  });
  it("a malformed cookie closes only its socket and the next authenticated connection works", async () => {
    const ws = new WebSocket(`${wsBase}/live?workspace=missing`, {
      headers: { cookie: "oc_session=%", origin: base },
    });
    expect(await untilClose(ws)).toBe(4001);
    const { orgId } = createOrganization("After malformed live cookie");
    const agent = registerAgent(orgId, "Healthy");
    const healthy = await openAgent(agent.apiKey);
    try { expect(liveSocketCount(agent.agentId)).toBe(1); }
    finally { healthy.terminate(); await vi.waitFor(() => expect(liveSocketCount()).toBe(0)); }
  });
  it("keeps console hints separate from agent push and reports only generic committed workspace changes", async () => {
    const scope = new ConsoleCase();
    let detachUnrelated = () => {};
    const work = Promise.resolve().then(async () => {
      scope.assertActive();
      const { orgId } = createOrganization("Console live separation");
      const agent = registerAgent(orgId, "Requester");
      const { headers, personId } = await signInPerson(orgId, "Console owner");
      scope.assertActive();
      const cookie = headers.cookie!;
      const otherOrg = createOrganization("Unrelated console workspace");
      const otherPerson = await signInPerson(otherOrg.orgId, "Other workspace owner");
      scope.assertActive();
      const before = liveSocketCount();
      const consoleSocket = await openConsole(orgId, cookie, scope, "setup console tab 1");
      const secondTab = await openConsole(orgId, cookie, scope, "setup console tab 2");
      const agentSocket = await openAgent(agent.apiKey, scope, "setup directed agent");
      const unrelatedSocket = await openConsole(otherOrg.orgId, otherPerson.headers.cookie!, scope, "setup unrelated console");
      const unrelatedFrames: string[] = [];
      const recordUnrelated = (raw: { toString(): string }) => { unrelatedFrames.push(raw.toString()); };
      unrelatedSocket.on("message", recordUnrelated);
      detachUnrelated = () => { unrelatedSocket.off("message", recordUnrelated); };
      const pairedRequest = async (label: string, url: string, init: RequestInit) => {
        const result = await scope.hints(label, [consoleSocket, secondTab], (signal) => fetch(url, { ...init, signal }));
        expect(result.hints).toEqual([{ type: "workspace.changed" }, { type: "workspace.changed" }]);
        return result;
      };
      const readJson = <T>(label: string, response: Response) => scope.operation(label, async () => await response.json() as T);
      const readApproval = (label: string, id: string) => scope.operation(label, (signal) =>
        fetch(`${base}/v1/approvals/${id}`, { headers: { authorization: `Bearer ${agent.apiKey}` }, signal }));
      const baseline = liveSocketCount();
      expect(baseline).toBe(before + 1);

      const noPrivatePayload = scope.hasMessageWithin(consoleSocket, 40, "private push console tab 1 quiet");
      const noPrivatePayloadInSecondTab = scope.hasMessageWithin(secondTab, 40, "private push console tab 2 quiet");
      const pushed = await scope.hints("private directed push", [agentSocket], () => pushToAgent(agent.agentId, { type: "message", body: "private directed payload" }));
      expect(pushed.value).toBe(true);
      expect(pushed.hints).toEqual([{ type: "message", body: "private directed payload" }]);
      expect(liveSocketCount()).toBe(baseline);
      expect(await noPrivatePayload).toBe(false);
      expect(await noPrivatePayloadInSecondTab).toBe(false);

      const { value: request, hints: [hint] } = await pairedRequest("request delete", `${base}/v1/approvals`, {
        method: "POST", headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "delete temporary file", risk: "medium", category: "delete" }),
      });
      expect(request.status).toBe(201);
      const requested = await readJson<{ approval: { id: string } }>("request delete body", request);
      expect(hint).toEqual({ type: "workspace.changed" });
      expect(JSON.stringify(hint)).not.toContain(personId);
      expect(JSON.stringify(hint)).not.toContain(agent.agentId);
      expect(listEvents(orgId).some((event) => event.type === "approval.requested")).toBe(true);

      const { value: decided } = await pairedRequest("deny delete", `${base}/v1/approvals/${requested.approval.id}/decide`, {
        method: "POST", headers: headers,
        body: JSON.stringify({ decision: "deny" }),
      });
      expect(decided.status).toBe(200);
      const deniedRead = await readApproval("denied read", requested.approval.id);
      expect((await readJson<{ approval: { status: string } }>("denied body", deniedRead)).approval.status).toBe("denied");

      const { value: secondRequest } = await pairedRequest("request rotate", `${base}/v1/approvals`, {
        method: "POST", headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "rotate temporary key", risk: "medium", category: "rotate" }),
      });
      expect(secondRequest.status).toBe(201);
      const secondApproval = await readJson<{ approval: { id: string } }>("request rotate body", secondRequest);
      const auth = authenticateLiveRequest({
        url: `/live?workspace=${orgId}`,
        headers: { host: `127.0.0.1:${new URL(base).port}`, origin: `http://127.0.0.1:${new URL(base).port}`, cookie },
      } as unknown as IncomingMessage);
      if (!auth.ok || auth.kind !== "console") throw new Error("console principal setup failed");
      const failing = scope.own(new FakeConsoleSocket(0, true));
      const slow = scope.own(new FakeConsoleSocket(65 * 1024));
      registerConsoleSocket(failing as never, auth);
      registerConsoleSocket(slow as never, auth);
      const { value: approved } = await pairedRequest("approve rotate", `${base}/v1/approvals/${secondApproval.approval.id}/decide`, {
        method: "POST", headers,
        body: JSON.stringify({ decision: "approve", grantMinutes: 1 }),
      });
      expect(approved.status).toBe(200);
      expect(failing.attempts).toBe(1);
      expect(slow.attempts).toBe(0);
      const grantResult = await readJson<{ grant: { id: string } }>("approved grant body", approved);
      const approvedRead = await readApproval("approved read", secondApproval.approval.id);
      expect((await readJson<{ approval: { status: string } }>("approved body", approvedRead)).approval.status).toBe("approved");
      failing.close();
      slow.close();

      const { value: autoGrantRequest } = await pairedRequest("automatic grant", `${base}/v1/approvals`, {
        method: "POST", headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "rotate another temporary key", risk: "medium", category: "rotate" }),
      });
      expect(autoGrantRequest.status).toBe(201);
      const autoGranted = await readJson<{ approval: { id: string; status: string } }>("automatic grant body", autoGrantRequest);
      expect(autoGranted.approval.status).toBe("approved");

      const { value: revoked } = await pairedRequest("revoke grant", `${base}/v1/approval-grants/${grantResult.grant.id}`, { method: "DELETE", headers: { authorization: `Bearer ${agent.apiKey}` } });
      expect(revoked.status).toBe(200);

      const { value: noted } = await pairedRequest("notify only", `${base}/v1/approvals`, {
        method: "POST", headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "record informational check", notifyOnly: true }),
      });
      expect(noted.status).toBe(201);
      expect((await readJson<{ approval: { status: string } }>("notify only body", noted)).approval.status).toBe("noted");

      const { value: expiringRequest } = await pairedRequest("request expiry", `${base}/v1/approvals`, {
        method: "POST", headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "expire this request", risk: "low" }),
      });
      expect(expiringRequest.status).toBe(201);
      const expiring = await readJson<{ approval: { id: string } }>("request expiry body", expiringRequest);
      db.prepare(`UPDATE approvals SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), expiring.approval.id);
      const { value: expiredRead } = await pairedRequest("expire on read", `${base}/v1/approvals/${expiring.approval.id}`, { headers: { authorization: `Bearer ${agent.apiKey}` } });
      expect((await readJson<{ approval: { status: string } }>("expired body", expiredRead)).approval.status).toBe("expired");

      const noRollbackHint = scope.hasMessageWithin(consoleSocket, 100, "rollback console tab 1 quiet");
      const noRollbackHintTab = scope.hasMessageWithin(secondTab, 100, "rollback console tab 2 quiet");
      const rolledBack = dbRollbackProbe(orgId);
      const neighbor = db.transaction(() => emitEvent({ orgId, type: "memory.recorded", subjectType: "memory", subjectId: newId() }))();
      expect(neighbor.id).not.toBe(rolledBack.event.id);
      expect(neighbor.seq).toBe(rolledBack.event.seq);
      expect(rolledBack.absent).toBe(true);
      expect(await noRollbackHint).toBe(false);
      expect(await noRollbackHintTab).toBe(false);
      expect(await scope.hasMessageWithin(unrelatedSocket, 1, "unrelated workspace quiet")).toBe(false);

      const mixedRollback = dbRollbackProbe(orgId);
      const { value: eligibleNeighbor, hints: eligibleNeighborHints } = await scope.hints("committed neighbor", [consoleSocket], () =>
        db.transaction(() => emitEvent({ orgId, type: "approval.noted", subjectType: "approval", subjectId: newId() }))());
      expect(eligibleNeighbor.seq).toBe(mixedRollback.event.seq);
      expect(eligibleNeighbor.id).not.toBe(mixedRollback.event.id);
      expect(eligibleNeighborHints).toEqual([{ type: "workspace.changed" }]);
      expect(unrelatedFrames).toEqual([]);
    });
    // Vitest can start afterEach when its unchanged 5s deadline wins; cancel and drain that same work.
    cleanupSeparationCase = async () => {
      try { await scope.dispose(); }
      finally { detachUnrelated(); await work.catch(() => {}); }
    };
    try { await work; }
    finally { try { await scope.dispose(); } finally { detachUnrelated(); } }
  });

  it("invalidates both console tabs from real task lifecycle producers, not refused or repeated votes", async () => {
    const { orgId } = createOrganization("Console task producers", "internal");
    const worker = registerAgent(orgId, "Task worker");
    const first = registerAgent(orgId, "First reviewer");
    const second = registerAgent(orgId, "Second reviewer");
    const actor = (agent: typeof worker) => ({ id: agent.agentId, name: agent.agentName });
    const person = await signInPerson(orgId, "Task observer", "member");
    const sockets = await Promise.all([openConsole(orgId, person.headers.cookie!), openConsole(orgId, person.headers.cookie!)]);
    const otherOrg = createOrganization("Other task console", "internal");
    const otherPerson = await signInPerson(otherOrg.orgId, "Other task observer", "member");
    const otherSocket = await openConsole(otherOrg.orgId, otherPerson.headers.cookie!);
    const otherFrames: string[] = [];
    otherSocket.on("message", (raw) => otherFrames.push(raw.toString()));
    try {
      const changed = <T>(type: string, produce: () => T) => expectProducerHint(orgId, sockets, type, produce);
      const unchanged = <T>(produce: () => T) => expectNoProducerHint(orgId, sockets[0], produce);
      const task = await changed("task.created", () => createTask(orgId, actor(worker), { title: "Private task title", requiredReviews: 2 }));
      expect((await changed("task.claimed", () => claimTask(orgId, actor(worker), task.id))).ok).toBe(true);
      expect((await unchanged(() => claimTask(orgId, actor(first), task.id))).ok).toBe(false);
      expect((await unchanged(() => releaseTask(orgId, actor(first), task.id))).ok).toBe(false);
      expect((await changed("task.released", () => releaseTask(orgId, actor(worker), task.id))).ok).toBe(true);
      expect((await changed("task.claimed", () => claimTask(orgId, actor(worker), task.id))).ok).toBe(true);
      expect((await changed("task.completed", () => completeTask(orgId, actor(worker), task.id, "Private completion"))).ok).toBe(true);
      expect((await unchanged(() => acceptTask(orgId, actor(worker), task.id))).ok).toBe(false);
      const partial = await changed("task.review_recorded", () => acceptTask(orgId, actor(first), task.id));
      expect(partial).toMatchObject({ ok: true, task: { reviewed: 0, review_count: 1 } });
      expect((await unchanged(() => acceptTask(orgId, actor(first), task.id))).ok).toBe(true);
      expect(await changed("task.accepted", () => acceptTask(orgId, actor(second), task.id))).toMatchObject({ ok: true, task: { reviewed: 1, review_count: 2 } });
      expect((await unchanged(() => acceptTask(orgId, actor(second), task.id))).ok).toBe(false);

      const bounced = await changed("task.created", () => createTask(orgId, actor(worker), { title: "Needs correction" }));
      expect((await changed("task.claimed", () => claimTask(orgId, actor(worker), bounced.id))).ok).toBe(true);
      expect((await changed("task.completed", () => completeTask(orgId, actor(worker), bounced.id))).ok).toBe(true);
      expect((await changed("task.rejected", () => rejectTask(orgId, actor(first), bounced.id, "Private review note"))).ok).toBe(true);
      db.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), bounced.id);
      await changed("task.lease_expired", () => sweepExpiredLeases(orgId));
      await unchanged(() => sweepExpiredLeases(orgId));

      await changed("task.superseded", () => {
        const before = consoleLiveSnapshot().pendingRefs;
        const correction = supersedeTask(orgId, actor(first), bounced.id, { title: "Corrected task" });
        // Both synchronous producers must enqueue: task.created alone could otherwise mask a missing superseded hint.
        expect(consoleLiveSnapshot().pendingRefs - before).toBe(2);
        return correction;
      });
      expect(await hasMessageWithin(otherSocket, 30)).toBe(false);
      expect(otherFrames).toEqual([]);
    } finally {
      for (const socket of [...sockets, otherSocket]) socket.terminate();
    }
  });

  it("invalidates from real messages, ordinary replies, true question replies and escalation without private frames", async () => {
    const { orgId } = createOrganization("Console message producers", "internal");
    const sender = registerAgent(orgId, "Message sender");
    const receiver = registerAgent(orgId, "Message receiver");
    const from = { id: sender.agentId, name: sender.agentName };
    const to = { id: receiver.agentId, name: receiver.agentName };
    // A member (not operator) leaves escalation with no operator-mail sibling that could mask its own missing hint.
    const person = await signInPerson(orgId, "Unrelated message observer", "member");
    const socket = await openConsole(orgId, person.headers.cookie!);
    const agentSocket = await openAgent(receiver.apiKey);
    let pendingQuestion: ReturnType<typeof askClarification> | undefined;
    vi.stubEnv("OPENCADRE_ESCALATE_MINUTES", "10");
    try {
      const privatePush = untilMessage(agentSocket);
      const sent = await expectProducerHint(orgId, [socket], "message.sent", () => sendMessage(orgId, from, to.name, "Private ordinary message", "low"));
      if (!sent.ok) throw new Error(sent.error);
      expect(await privatePush).toMatchObject({ type: "message", body: "Private ordinary message", priority: "low" });
      expect(getMessages(orgId, person.decider.id, undefined, { peek: true })).toEqual([]);
      expect(getThreadStatus(orgId, person.decider.id, sent.threadId).ok).toBe(false);
      expect(await expectProducerHint(orgId, [socket], "question.answered", () => reply(orgId, to, sent.threadId, "Private ordinary reply"))).toEqual({ ok: true });

      const questionHint = untilMessage(socket);
      const questionPush = untilMessage(agentSocket);
      pendingQuestion = askClarification(orgId, from, to.name, "Private real question", 2);
      expect(await questionHint).toEqual({ type: "workspace.changed" });
      const pushedQuestion = await questionPush;
      expect(pushedQuestion).toMatchObject({ type: "question", body: "Private real question", awaitingReply: true });
      const question = getMessages(orgId, to.id, undefined, { peek: true }).find((row) => row.id === pushedQuestion.id)!;
      expect(question).toBeDefined();
      expect(question.awaiting_reply).toBe(1);
      expect(listEvents(orgId, { types: ["question.asked"] }).filter((event) => event.subject_id === question.id)).toHaveLength(1);
      expect(await expectProducerHint(orgId, [socket], "question.answered", () => reply(orgId, to, question.thread_id, "Private real answer"))).toEqual({ ok: true });
      expect(await pendingQuestion).toMatchObject({ ok: true, live: true, answer: "Private real answer" });
      expect((db.prepare(`SELECT awaiting_reply FROM messages WHERE id = ?`).get(question.id) as { awaiting_reply: number }).awaiting_reply).toBe(0);
      expect((await expectNoProducerHint(orgId, socket, () => reply(orgId, to, newId(), "Unknown thread"))).ok).toBe(false);

      const highPush = untilMessage(agentSocket);
      const high = await expectProducerHint(orgId, [socket], "message.sent", () => sendMessage(orgId, from, to.name, "Please investigate blocked work", "high"));
      if (!high.ok) throw new Error(high.error);
      await highPush;
      const row = db.prepare(`SELECT created_at FROM messages WHERE org_id = ? AND thread_id = ?`).get(orgId, high.threadId) as { created_at: string };
      const clock = new Date(Date.parse(`${row.created_at.replace(" ", "T")}Z`) + 11 * 60_000);
      await expectProducerHint(orgId, [socket], "message.escalated", () => sweepEscalations(clock));
      expect(JSON.parse(listEvents(orgId, { types: ["message.escalated"] })[0].payload)).toMatchObject({ operatorCount: 0, level: 1 });
      await expectNoProducerHint(orgId, socket, () => sweepEscalations(clock));
    } finally {
      vi.unstubAllEnvs();
      socket.terminate();
      agentSocket.terminate();
      if (pendingQuestion) await Promise.allSettled([pendingQuestion]);
    }
  });

  it("never invalidates from rolled-back real task and reply producers, then recovers on committed changes", async () => {
    const { orgId } = createOrganization("Console producer rollback", "internal");
    const sender = registerAgent(orgId, "Rollback sender");
    const receiver = registerAgent(orgId, "Rollback receiver");
    const from = { id: sender.agentId, name: sender.agentName };
    const to = { id: receiver.agentId, name: receiver.agentName };
    const person = await signInPerson(orgId, "Rollback observer", "member");
    const sent = await sendMessage(orgId, from, to.name, "Committed initial message");
    if (!sent.ok) throw new Error(sent.error);
    const socket = await openConsole(orgId, person.headers.cookie!);
    try {
      let rolledBackTask = "";
      await expectNoProducerHint(orgId, socket, () => {
        expect(() => db.transaction(() => {
          const task = createTask(orgId, from, { title: "Rolled-back task" });
          rolledBackTask = task.id;
          expect(claimTask(orgId, from, task.id).ok).toBe(true);
          expect(reply(orgId, to, sent.threadId, "Rolled-back reply").ok).toBe(true);
          throw new Error("rollback real producers");
        })()).toThrow("rollback real producers");
      });
      expect(db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(rolledBackTask)).toBeUndefined();
      const status = getThreadStatus(orgId, from.id, sent.threadId);
      if (!status.ok) throw new Error(status.error);
      expect(status.messages).toHaveLength(1);
      await expectProducerHint(orgId, [socket], "task.created", () => createTask(orgId, from, { title: "Committed task after rollback" }));
      expect(await expectProducerHint(orgId, [socket], "question.answered", () => reply(orgId, to, sent.threadId, "Committed reply after rollback"))).toEqual({ ok: true });
    } finally {
      socket.terminate();
    }
  });

  it("observes committed file-only and heartbeat presence changes without console traffic heartbeating workers", async () => {
    const { orgId } = createOrganization("Console live observer");
    const worker = registerAgent(orgId, "Observed worker");
    const { headers } = await signInPerson(orgId, "Observer console");
    const consoleSocket = await openConsole(orgId, headers.cookie!);
    const workerSocket = await openAgent(worker.apiKey);
    expect(isOnline((db.prepare(`SELECT last_heartbeat_at FROM agents WHERE id = ?`).get(worker.agentId) as { last_heartbeat_at: string }).last_heartbeat_at)).toBe(true);
    await sweepConsoleLive(); // first sample is the real online baseline

    const unchangedEvents = listEvents(orgId).length;
    setAgentStatus(orgId, worker.agentId, null, ["src/only-file-change.ts"]);
    expect(listEvents(orgId)).toHaveLength(unchangedEvents);
    const fileHint = untilMessage(consoleSocket, 1000, "file-only observer hint");
    await sweepConsoleLive();
    expect(await fileHint).toEqual({ type: "workspace.changed" });

    const lastWorkerBeat = (db.prepare(`SELECT last_heartbeat_at FROM agents WHERE id = ?`).get(worker.agentId) as { last_heartbeat_at: string }).last_heartbeat_at;
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 3 * 60_000);
    expect(isOnline(lastWorkerBeat)).toBe(false);
    const staleHint = untilMessage(consoleSocket, 1000, "stale-worker observer hint");
    const unchangedBeat = (db.prepare(`SELECT last_heartbeat_at FROM agents WHERE id = ?`).get(worker.agentId) as { last_heartbeat_at: string }).last_heartbeat_at;
    consoleSocket.send("console liveness only");
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect((db.prepare(`SELECT last_heartbeat_at FROM agents WHERE id = ?`).get(worker.agentId) as { last_heartbeat_at: string }).last_heartbeat_at).toBe(unchangedBeat);
    await sweepConsoleLive();
    expect(await staleHint).toEqual({ type: "workspace.changed" });
    const noRepeatedStaleHint = hasMessageWithin(consoleSocket, 50);
    await sweepConsoleLive();
    expect(await noRepeatedStaleHint).toBe(false);
    clock.mockRestore();

    // Separately force a persisted stale timestamp under the real clock; an actual server ping/pong must refresh it.
    const oldBeat = new Date(Date.now() - 3 * 60_000).toISOString().replace("T", " ").slice(0, 19);
    db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(oldBeat, worker.agentId);
    expect(isOnline(oldBeat)).toBe(false);
    const offlineHint = untilMessage(consoleSocket, 1000, "persisted-stale worker hint");
    await sweepConsoleLive();
    expect(await offlineHint).toEqual({ type: "workspace.changed" });

    const pingReceived = new Promise<void>((resolve) => workerSocket.once("ping", () => resolve()));
    sweepKeepalive(wss.clients);
    await pingReceived;
    const beatDeadline = Date.now() + 1000;
    while (Date.now() < beatDeadline) {
      const beat = (db.prepare(`SELECT last_heartbeat_at FROM agents WHERE id = ?`).get(worker.agentId) as { last_heartbeat_at: string }).last_heartbeat_at;
      if (Date.parse(`${beat}Z`) > Date.now() - 10_000) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(Date.parse(`${(db.prepare(`SELECT last_heartbeat_at FROM agents WHERE id = ?`).get(worker.agentId) as { last_heartbeat_at: string }).last_heartbeat_at}Z`)).toBeGreaterThan(Date.now() - 10_000);
    const onlineHint = untilMessage(consoleSocket, 1000, "heartbeat recovery observer hint");
    await sweepConsoleLive();
    expect(await onlineHint).toEqual({ type: "workspace.changed" });

    const device = createDevice(orgId, { id: worker.agentId, name: worker.agentName }, "Observer laptop", "codex");
    const redeemed = redeemDeviceCode(device.code);
    if (!redeemed.ok) throw new Error("device fixture failed to redeem");
    setProjectEnabled(orgId, { actor: { id: worker.agentId, name: worker.agentName }, name: worker.agentName, via: "operator" }, "local:ObserverRepo", true);
    const hints = { toolSessionId: "observer-tool-session", hostSessionId: "observer-host-session", client: "codex", project: "local:ObserverRepo", projectName: "ObserverRepo" };
    const processSession = resolveSessionAgent({ id: device.deviceId, orgId, client: "codex" }, hints);
    expect(processSession).toMatchObject({ ok: true, created: true });
    const processHint = untilMessage(consoleSocket, 1000, "new process-session observer hint");
    await sweepConsoleLive();
    expect(await processHint).toEqual({ type: "workspace.changed" });
    const sessionAgentId = processSession.ok ? processSession.agentId : "";
    expect((db.prepare(`SELECT liveness FROM agents WHERE id = ?`).get(sessionAgentId) as { liveness: string }).liveness).toBe("process");
    const chatHint = untilMessage(consoleSocket, 1000, "process-to-chat observer hint");
    const chatSession = resolveSessionAgent({ id: device.deviceId, orgId, client: "codex" }, { ...hints, chatProven: true });
    expect(chatSession).toMatchObject({ ok: true, created: false, agentId: sessionAgentId });
    expect((db.prepare(`SELECT liveness FROM agents WHERE id = ?`).get(sessionAgentId) as { liveness: string }).liveness).toBe("chat");
    await sweepConsoleLive();
    expect(await chatHint).toEqual({ type: "workspace.changed" });
    consoleSocket.close();
    workerSocket.close();
  });

  it("keeps the approval write durable when flush scheduling fails and retries on the existing keepalive path", async () => {
    const { orgId } = createOrganization("Console live scheduler failure");
    const agent = registerAgent(orgId, "Requester");
    const { headers } = await signInPerson(orgId, "Console owner");
    const socket = await openConsole(orgId, headers.cookie!);
    const hint = untilMessage(socket);
    vi.stubGlobal("setImmediate", (() => { throw new Error("injected scheduling failure"); }) as typeof setImmediate);
    let approval: Awaited<ReturnType<typeof requestApproval>>;
    try {
      approval = await requestApproval(orgId, { id: agent.agentId, name: agent.agentName }, { action: "durable request", risk: "low" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(approval.status).toBe("pending");
    expect((db.prepare(`SELECT status FROM approvals WHERE id = ?`).get(approval.id) as { status: string }).status).toBe("pending");
    await sweepConsoleLive();
    expect(await hint).toEqual({ type: "workspace.changed" });
    socket.close();
  });

  it("preserves a real person's approval decision when hint scheduling fails and recovers on keepalive", async () => {
    const { orgId } = createOrganization("Console live approval schedule failure");
    const agent = registerAgent(orgId, "Decision requester");
    const person = await signInPerson(orgId, "Decision owner");
    const socket = await openConsole(orgId, person.headers.cookie!);
    const requestedHint = untilMessage(socket);
    const approval = await requestApproval(orgId, { id: agent.agentId, name: agent.agentName }, { action: "approve durably", risk: "low" });
    expect(await requestedHint).toEqual({ type: "workspace.changed" });

    const decisionHint = untilMessage(socket);
    vi.stubGlobal("setImmediate", (() => { throw new Error("injected decision scheduling failure"); }) as typeof setImmediate);
    let decision: ReturnType<typeof decideApproval>;
    try {
      decision = decideApproval(orgId, person.decider, approval.id, "approve");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(decision).toMatchObject({ ok: true, approval: { status: "approved" } });
    expect((db.prepare(`SELECT status FROM approvals WHERE id = ?`).get(approval.id) as { status: string }).status).toBe("approved");
    expect(listEvents(orgId).some((event) => event.type === "approval.decided" && event.subject_id === approval.id)).toBe(true);
    await sweepConsoleLive();
    expect(await decisionHint).toEqual({ type: "workspace.changed" });
    socket.close();
  });

  it("bounds distinct queued event refs per workspace and emits one generic hint", async () => {
    const { orgId } = createOrganization("Console live queue bounds");
    const { headers } = await signInPerson(orgId, "Bounded console");
    const socket = await openConsole(orgId, headers.cookie!);
    const hint = untilMessage(socket);
    let queued = 0;
    db.transaction(() => {
      for (let index = 0; index < 20; index++) {
        emitEvent({ orgId, type: "approval.noted", subjectType: "approval", subjectId: newId() });
      }
      queued = consoleLiveSnapshot().pendingRefs;
    })();
    expect(queued).toBe(16);
    expect(await hint).toEqual({ type: "workspace.changed" });
    expect(consoleLiveSnapshot().pendingRefs).toBe(0);
    expect(await hasMessageWithin(socket, 50)).toBe(false);
    socket.close();
  });

  it("does not hint from 16 rolled-back refs when a committed 17th eligible ref overflows the queue", async () => {
    const { orgId } = createOrganization("Console live queue overflow fallback");
    const { headers } = await signInPerson(orgId, "Overflow console");
    const socket = await openConsole(orgId, headers.cookie!);
    const noInvalidHint = hasMessageWithin(socket, 80);
    let rolledBack: ReturnType<typeof emitEvent>[] = [];
    try {
      db.transaction(() => {
        rolledBack = Array.from({ length: 16 }, () => emitEvent({ orgId, type: "approval.noted", subjectType: "approval", subjectId: newId() }));
        expect(consoleLiveSnapshot().pendingRefs).toBe(16);
        throw new Error("overflow rollback");
      })();
    } catch (error) {
      expect((error as Error).message).toBe("overflow rollback");
    }
    const committedOverflow = db.transaction(() => emitEvent({ orgId, type: "approval.noted", subjectType: "approval", subjectId: newId() }))();
    expect(rolledBack).toHaveLength(16);
    expect(db.prepare(`SELECT 1 FROM events WHERE id = ? AND seq = ? AND org_id = ? AND type = ?`).get(
      committedOverflow.id, committedOverflow.seq, orgId, "approval.noted",
    )).toBeTruthy();
    expect(consoleLiveSnapshot().pendingRefs).toBe(16); // the 17th ref is dropped at the fixed cap
    await flushConsoleLiveChanges();
    expect(consoleLiveSnapshot().pendingRefs).toBe(0);
    expect(await noInvalidHint).toBe(false);
    socket.close();
  });

  it("caps pending and observed workspaces without capping persisted access revalidation", async () => {
    const baseline = consoleLiveSnapshot();
    const fakePrincipal = { kind: "console" as const, orgId: "", agentId: "", personId: "", sessionHash: "invalid-session", memberRole: "owner" };
    const sockets: FakeConsoleSocket[] = [];
    for (let index = 0; index < 129; index++) {
      const orgId = `cap-org-${index}`;
      const socket = new FakeConsoleSocket(0);
      sockets.push(socket);
      registerConsoleSocket(socket as never, { ...fakePrincipal, orgId });
      enqueueConsoleEvent({ id: `cap-event-${index}`, seq: 1, org_id: orgId, type: "approval.noted" });
    }
    expect(consoleLiveSnapshot()).toMatchObject({
      workspaces: baseline.workspaces + 129,
      listeners: baseline.listeners + 129,
      pendingRefs: baseline.pendingRefs + 128,
    });
    await sweepConsoleLive();
    // The 129th principal is beyond both 128-entry observer/queue caps, but auth rechecks are mandatory.
    expect(sockets[128].closeCode).toBe(4001);
    expect(sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
    expect(consoleLiveSnapshot()).toMatchObject({ workspaces: baseline.workspaces, listeners: baseline.listeners, pendingRefs: baseline.pendingRefs });
  });

  it("defers a scheduled flush held inside a transaction without spinning and recovers on keepalive", async () => {
    const { orgId } = createOrganization("Console live deferred flush");
    const { headers } = await signInPerson(orgId, "Deferred console");
    const socket = await openConsole(orgId, headers.cookie!);
    const noRollbackHint = hasMessageWithin(socket, 60);
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("setImmediate", ((callback: () => void) => { callbacks.push(callback); return 0; }) as typeof setImmediate);
    let rolledBack: ReturnType<typeof emitEvent> | undefined;
    try {
      db.transaction(() => {
        rolledBack = emitEvent({ orgId, type: "approval.noted", subjectType: "approval", subjectId: newId() });
        expect(callbacks).toHaveLength(1);
        callbacks[0](); // run the already-scheduled callback while SQLite still owns the transaction
        expect(callbacks).toHaveLength(1); // no immediate retry loop is created
        expect(consoleLiveSnapshot().pendingRefs).toBe(1);
        throw new Error("deferred rollback");
      })();
    } catch (error) {
      expect((error as Error).message).toBe("deferred rollback");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(rolledBack).toBeDefined();
    await sweepConsoleLive(); // existing keepalive path retries persisted-state validation
    expect(await noRollbackHint).toBe(false);
    expect(consoleLiveSnapshot().pendingRefs).toBe(0);

    const recoveredHint = untilMessage(socket);
    const committed = db.transaction(() => emitEvent({ orgId, type: "approval.noted", subjectType: "approval", subjectId: newId() }))();
    expect(committed.seq).toBe(rolledBack!.seq);
    expect(committed.id).not.toBe(rolledBack!.id);
    expect(await recoveredHint).toEqual({ type: "workspace.changed" });
    socket.close();
  });

  it("does not advance an observer digest from rolled-back state", async () => {
    const { orgId } = createOrganization("Console live observer rollback");
    const worker = registerAgent(orgId, "Rollback observed worker");
    const { headers } = await signInPerson(orgId, "Rollback observer");
    const socket = await openConsole(orgId, headers.cookie!);
    await sweepConsoleLive(); // baseline
    const noRollbackHint = hasMessageWithin(socket, 60);
    try {
      db.transaction(() => {
        db.prepare(`UPDATE agents SET current_task = ? WHERE id = ?`).run("uncommitted task", worker.agentId);
        void sweepConsoleLive(); // observes db.inTransaction and must not sample the uncommitted row
        throw new Error("observer rollback");
      })();
    } catch (error) {
      expect((error as Error).message).toBe("observer rollback");
    }
    await sweepConsoleLive();
    expect(await noRollbackHint).toBe(false);
    const committedHint = untilMessage(socket);
    db.prepare(`UPDATE agents SET current_task = ? WHERE id = ?`).run("committed task", worker.agentId);
    await sweepConsoleLive();
    expect(await committedHint).toEqual({ type: "workspace.changed" });
    socket.close();
  });

  it("closes only the current console for persisted role, removal, pause and session losses", async () => {
    const { orgId } = createOrganization("Console access closures");
    const first = await signInPerson(orgId, "First owner");
    const second = await signInPerson(orgId, "Second owner");
    const rollbackSocket = await openConsole(orgId, first.headers.cookie!);
    try {
      db.transaction(() => {
        changeRole(orgId, { id: "test-operator", name: "Test operator", memberRole: "owner" }, first.personId, "member");
        throw new Error("rollback role change");
      })();
    } catch (error) {
      expect((error as Error).message).toBe("rollback role change");
    }
    await sweepConsoleLive();
    expect(rollbackSocket.readyState).toBe(WebSocket.OPEN);
    expect((db.prepare(`SELECT role FROM workspace_members WHERE org_id = ? AND person_id = ?`).get(orgId, first.personId) as { role: string }).role).toBe("owner");
    rollbackSocket.close();

    const roleSocket = await openConsole(orgId, first.headers.cookie!);
    const roleClosed = untilClose(roleSocket);
    changeRole(orgId, { id: "test-operator", name: "Test operator", memberRole: "owner" }, first.personId, "member");
    expect(await roleClosed).toBe(4004);

    await signInPerson(orgId, "Keeper owner");
    const removeSocket = await openConsole(orgId, second.headers.cookie!);
    const removeClosed = untilClose(removeSocket);
    removeMember(orgId, { id: "test-operator", name: "Test operator", memberRole: "owner", personId: "test-operator" }, second.personId);
    expect(await removeClosed).toBe(4004);

    const third = await signInPerson(orgId, "Third member", "member");
    const pausedSocket = await openConsole(orgId, third.headers.cookie!);
    try {
      db.transaction(() => {
        pauseWorkspace(orgId, { id: "test-operator", name: "Test operator" });
        throw new Error("rollback pause");
      })();
    } catch (error) {
      expect((error as Error).message).toBe("rollback pause");
    }
    await sweepConsoleLive();
    expect(pausedSocket.readyState).toBe(WebSocket.OPEN);
    expect((db.prepare(`SELECT paused_at FROM organizations WHERE id = ?`).get(orgId) as { paused_at: string | null }).paused_at).toBeNull();
    const pausedClosed = untilClose(pausedSocket);
    pauseWorkspace(orgId, { id: "test-operator", name: "Test operator" });
    expect(await pausedClosed).toBe(4003);

    const fourth = await signInPerson(orgId, "Fourth owner");
    const sessionSocket = await openConsole(orgId, fourth.headers.cookie!);
    const sessionClosed = untilClose(sessionSocket);
    const token = fourth.headers.cookie!.split("=")[1];
    const session = db.prepare(`SELECT token_hash, expires_at FROM sessions WHERE person_id = ?`).get(fourth.personId) as { token_hash: string; expires_at: string };
    db.prepare(`UPDATE sessions SET last_used_at = ? WHERE token_hash = ?`).run(new Date(Date.now() - 2 * 86_400_000).toISOString(), session.token_hash);
    await sweepConsoleLive();
    expect((db.prepare(`SELECT expires_at FROM sessions WHERE token_hash = ?`).get(session.token_hash) as { expires_at: string }).expires_at).toBe(session.expires_at);
    try {
      db.transaction(() => {
        deleteSession(token);
        throw new Error("rollback session deletion");
      })();
    } catch (error) {
      expect((error as Error).message).toBe("rollback session deletion");
    }
    await sweepConsoleLive();
    expect(sessionSocket.readyState).toBe(WebSocket.OPEN);
    const signedOut = await fetch(`${base}/v1/auth/signout`, { method: "POST", headers: fourth.headers });
    expect(signedOut.status).toBe(200);
    expect(await sessionClosed).toBe(4001);
  });
});

/** Accepted bounded supplemental controls for the frozen console invalidation implementation. */
describe("accepted workspace console invalidation controls", () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const track = (socket: WebSocket) => {
    const frames: string[] = [];
    socket.on("message", (raw) => frames.push(raw.toString()));
    return frames;
  };
  async function expectOneHint(frames: string[], before: number): Promise<void> {
    const deadline = Date.now() + 1000;
    while (frames.length === before && Date.now() < deadline) await delay(5);
    expect(frames.slice(before)).toEqual([JSON.stringify({ type: "workspace.changed" })]);
    await delay(35);
    expect(frames.slice(before)).toEqual([JSON.stringify({ type: "workspace.changed" })]);
  }
  async function expectNoHint(frames: string[], before: number, ms = 70): Promise<void> {
    await delay(ms);
    expect(frames.slice(before)).toEqual([]);
  }

  it("hints from real task, phase, stale, suspended and resumed producers only after committed transitions", async () => {
    const { orgId } = createOrganization("Console C1 worker producers");
    const worker = registerAgent(orgId, "C1 observed worker");
    const { headers } = await signInPerson(orgId, "C1 console owner");
    const socket = await openConsole(orgId, headers.cookie!);
    const frames = track(socket);
    const workerEvents = () => listEvents(orgId).filter((event) => event.subject_id === worker.agentId);
    try {
      let before = frames.length;
      let eventOffset = workerEvents().length;
      setAgentStatus(orgId, worker.agentId, "C1 task only", []);
      await expectOneHint(frames, before);
      expect(workerEvents().slice(eventOffset).map((event) => event.type)).toEqual(["agent.task_changed"]);

      before = frames.length;
      eventOffset = workerEvents().length;
      setAgentStatus(orgId, worker.agentId, "C1 task only", [], "planning");
      await expectOneHint(frames, before);
      expect(workerEvents().slice(eventOffset).map((event) => event.type)).toEqual(["agent.phase_changed"]);

      const beforeNoopEvents = workerEvents().length;
      before = frames.length;
      setAgentStatus(orgId, worker.agentId, "C1 task only", [], "planning");
      expect(workerEvents()).toHaveLength(beforeNoopEvents);
      await expectNoHint(frames, before);

      const staleAt = Date.now() + staleAfterMs() + 1000;
      before = frames.length;
      expect(sweepStaleAgents(staleAt).suspended).toContain(worker.agentId);
      await expectOneHint(frames, before);
      expect(workerEvents().map((event) => event.type).filter((type) => type === "agent.stale" || type === "agent.suspended").sort())
        .toEqual(["agent.stale", "agent.suspended"]);

      const afterStaleEvents = workerEvents().length;
      before = frames.length;
      expect(sweepStaleAgents(staleAt + 1000).suspended).not.toContain(worker.agentId);
      expect(workerEvents()).toHaveLength(afterStaleEvents);
      await expectNoHint(frames, before);

      before = frames.length;
      heartbeat(orgId, worker.agentId);
      await expectOneHint(frames, before);
      expect(workerEvents().at(-1)?.type).toBe("agent.resumed");

      const afterResumeEvents = workerEvents().length;
      before = frames.length;
      heartbeat(orgId, worker.agentId);
      expect(workerEvents()).toHaveLength(afterResumeEvents);
      await expectNoHint(frames, before);

      let rolledBackRef: { id: string; seq: number } | undefined;
      const noRollbackFrame = frames.length;
      expect(() => db.transaction(() => {
        setAgentStatus(orgId, worker.agentId, "C1 rolled back task", [], "testing");
        rolledBackRef = db.prepare(`SELECT id, seq FROM events WHERE org_id = ? AND type = 'agent.task_changed' ORDER BY seq DESC LIMIT 1`)
          .get(orgId) as { id: string; seq: number };
        throw new Error("C1 outer rollback");
      })()).toThrow("C1 outer rollback");
      expect(rolledBackRef).toBeDefined();
      expect(db.prepare(`SELECT 1 FROM events WHERE id = ? AND seq = ? AND org_id = ? AND type = 'agent.task_changed'`)
        .get(rolledBackRef!.id, rolledBackRef!.seq, orgId)).toBeUndefined();
      await expectNoHint(frames, noRollbackFrame);

      before = frames.length;
      setAgentStatus(orgId, worker.agentId, "C1 committed neighbor", [], "reviewing");
      await expectOneHint(frames, before);
      const committedRef = db.prepare(`SELECT id, seq FROM events WHERE org_id = ? AND type = 'agent.task_changed' ORDER BY seq DESC LIMIT 1`)
        .get(orgId) as { id: string; seq: number };
      expect(committedRef.id).not.toBe(rolledBackRef!.id);
      expect(committedRef.seq).toBe(rolledBackRef!.seq);
    } finally {
      socket.close();
    }
  });

  it("links, unlinks and isolation transitions hint only after commit while real project-scoped messaging follows reach", async () => {
    const { orgId } = createOrganization("Console C2 project controls");
    const actor = { id: "C2 fixture operator", name: "C2 fixture operator" };
    const projectA = "local:console-invalidation-a";
    const projectB = "local:console-invalidation-b";
    const device = createDevice(orgId, actor, "C2 project PC", "codex");
    const redeemed = redeemDeviceCode(device.code);
    if (!redeemed.ok) throw new Error("C2 device fixture failed to redeem");
    setProjectEnabled(orgId, { actor: null, name: actor.name, via: "operator" }, projectA, true);
    setProjectEnabled(orgId, { actor: null, name: actor.name, via: "operator" }, projectB, true);
    const resolve = (toolSessionId: string, project: string) => {
      const projectName = project.slice("local:".length);
      const session = resolveSessionAgent({ id: device.deviceId, orgId, client: "codex" }, {
        toolSessionId, hostSessionId: `host-${toolSessionId}`, client: "codex", project, projectName,
      });
      if (!session.ok) throw new Error(`C2 session fixture refused: ${session.reason}`);
      return { agentId: session.agentId, agentName: session.agentName, toolSessionId, project, projectName };
    };
    const alpha = resolve("c2-alpha-session", projectA);
    const beta = resolve("c2-beta-session", projectB);
    const { headers } = await signInPerson(orgId, "C2 console owner");
    const socket = await openConsole(orgId, headers.cookie!);
    const frames = track(socket);
    const postMessage = (from: typeof alpha, body: string) => fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${redeemed.deviceCredential}`,
        "x-opencadre-session": from.toolSessionId,
        "x-opencadre-client": "codex",
        "x-opencadre-project": from.project,
        "x-opencadre-project-name": from.projectName,
        "content-type": "application/json",
      },
      body: JSON.stringify({ toAgent: beta.agentName, body }),
    });
    const expectHiddenTarget = async (from: typeof alpha, body: string) => {
      const response = await postMessage(from, body);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: `No agent found matching "${beta.agentName}"` });
    };
    const expectAcceptedMessage = async (body: string) => {
      const before = frames.length;
      expect((await postMessage(alpha, body)).status).toBe(201);
      // Successful sends now hint too; settle that producer before the next no-op/rollback silence cursor.
      await expectOneHint(frames, before);
    };
    const linkRows = () => db.prepare(`SELECT project_a, project_b FROM project_links WHERE org_id = ?`).all(orgId);
    try {
      expect((db.prepare(`SELECT project_isolation FROM organizations WHERE id = ?`).get(orgId) as { project_isolation: number }).project_isolation).toBe(1);
      await expectHiddenTarget(alpha, `C2 before link ${newId()}`);

      let before = frames.length;
      expect(() => db.transaction(() => {
        linkProjects(orgId, actor, projectA, projectB);
        throw new Error("C2 rollback link");
      })()).toThrow("C2 rollback link");
      await expectNoHint(frames, before);
      expect(linkRows()).toHaveLength(0);
      await expectHiddenTarget(alpha, `C2 after rolled back link ${newId()}`);

      before = frames.length;
      const linkHint = expectOneHint(frames, before);
      expect(linkProjects(orgId, actor, projectA, projectB).created).toBe(true);
      await linkHint;
      await expectAcceptedMessage(`C2 linked reach ${newId()}`);

      before = frames.length;
      expect(linkProjects(orgId, actor, projectA, projectB).created).toBe(false);
      await expectNoHint(frames, before);

      before = frames.length;
      expect(() => db.transaction(() => {
        expect(unlinkProjects(orgId, actor, projectA, projectB)).toBe(true);
        throw new Error("C2 rollback unlink");
      })()).toThrow("C2 rollback unlink");
      await expectNoHint(frames, before);
      expect(linkRows()).toHaveLength(1);
      await expectAcceptedMessage(`C2 after rolled back unlink ${newId()}`);

      before = frames.length;
      const unlinkHint = expectOneHint(frames, before);
      expect(unlinkProjects(orgId, actor, projectA, projectB)).toBe(true);
      await unlinkHint;
      await expectHiddenTarget(alpha, `C2 after committed unlink ${newId()}`);

      before = frames.length;
      const disabledHint = expectOneHint(frames, before);
      expect(setProjectIsolation(orgId, actor, false)).toMatchObject({ enabled: false, changed: true });
      await disabledHint;
      await expectAcceptedMessage(`C2 isolation disabled ${newId()}`);

      before = frames.length;
      expect(() => db.transaction(() => {
        setProjectIsolation(orgId, actor, true);
        throw new Error("C2 rollback isolation enable");
      })()).toThrow("C2 rollback isolation enable");
      await expectNoHint(frames, before);
      expect((db.prepare(`SELECT project_isolation FROM organizations WHERE id = ?`).get(orgId) as { project_isolation: number }).project_isolation).toBe(0);
      await expectAcceptedMessage(`C2 after rolled back isolation enable ${newId()}`);

      before = frames.length;
      const enabledHint = expectOneHint(frames, before);
      expect(setProjectIsolation(orgId, actor, true)).toMatchObject({ enabled: true, changed: true });
      await enabledHint;
      await expectHiddenTarget(alpha, `C2 isolation enabled ${newId()}`);
    } finally {
      socket.close();
    }
  });

  it("expires only matching cookie listeners across permitted workspaces without sliding the session", async () => {
    const firstOrg = createOrganization("Console C3 first workspace").orgId;
    const secondOrg = createOrganization("Console C3 second workspace").orgId;
    const personId = newId();
    const person = upsertPerson({
      id: personId, email: `${personId}@example.test`, emailVerified: true, name: "C3 shared person", avatarUrl: null,
    });
    for (const orgId of [firstOrg, secondOrg]) {
      const invite = createInvite(orgId, { id: "C3 fixture", name: "C3 fixture" }, "owner", null);
      acceptInvite(invite.token, person);
    }
    const { token } = createSession(personId);
    const cookie = `${SESSION_COOKIE}=${token}`;
    const worker = registerAgent(firstOrg, "C3 unrelated-listener worker");
    const distinct = await signInPerson(firstOrg, "C3 unrelated valid session");
    const firstSocket = await openConsole(firstOrg, cookie);
    const secondSocket = await openConsole(secondOrg, cookie);
    const distinctSocket = await openConsole(firstOrg, distinct.headers.cookie!);
    const distinctFrames = track(distinctSocket);
    try {
      const session = db.prepare(`SELECT token_hash, expires_at FROM sessions WHERE person_id = ?`).get(personId) as { token_hash: string; expires_at: string };
      const futureExpiry = new Date(Date.now() + 1500).toISOString();
      const oldLastUsed = new Date(Date.now() - 2 * 86_400_000).toISOString();
      db.prepare(`UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE token_hash = ?`).run(futureExpiry, oldLastUsed, session.token_hash);

      await sweepConsoleLive(); // before the persisted expiry, using real Date.now()
      expect(firstSocket.readyState).toBe(WebSocket.OPEN);
      expect(secondSocket.readyState).toBe(WebSocket.OPEN);
      expect(db.prepare(`SELECT expires_at, last_used_at FROM sessions WHERE token_hash = ?`).get(session.token_hash))
        .toEqual({ expires_at: futureExpiry, last_used_at: oldLastUsed });

      const expiryMs = Date.parse(futureExpiry);
      while (Date.now() <= expiryMs) await delay(Math.min(25, Math.max(1, expiryMs - Date.now() + 1)));
      expect(Date.now()).toBeGreaterThan(expiryMs);
      const firstClosed = untilClose(firstSocket);
      const secondClosed = untilClose(secondSocket);
      await sweepConsoleLive(); // real-clock expiry, no sessionPerson call and no fake clock
      expect(await firstClosed).toBe(4001);
      expect(await secondClosed).toBe(4001);
      expect(distinctSocket.readyState).toBe(WebSocket.OPEN);
      const distinctBefore = distinctFrames.length;
      setAgentStatus(firstOrg, worker.agentId, "C3 distinct session remains live", []);
      await expectOneHint(distinctFrames, distinctBefore);
      expect(distinctSocket.readyState).toBe(WebSocket.OPEN);
      expect(db.prepare(`SELECT expires_at, last_used_at FROM sessions WHERE token_hash = ?`).get(session.token_hash))
        .toEqual({ expires_at: futureExpiry, last_used_at: oldLastUsed });
    } finally {
      firstSocket.close();
      secondSocket.close();
      distinctSocket.close();
    }
  });

  it("continues real listener revalidation and durable member changes when close and terminate throw", async () => {
    const { orgId } = createOrganization("Console C4 close failure");
    const owner = await signInPerson(orgId, "C4 owner", "owner");
    const target = await signInPerson(orgId, "C4 target", "member");
    const url = `/live?workspace=${encodeURIComponent(orgId)}`;
    const port = new URL(base).port;
    const principal = authenticateLiveRequest({
      url,
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie: target.headers.cookie! },
    } as unknown as IncomingMessage);
    if (!principal.ok || principal.kind !== "console") throw new Error("C4 target console principal setup failed");
    const closeFallsBack = new FakeConsoleSocket(0, false, true);
    const bothMethodsFail = new FakeConsoleSocket(0, false, true, true);
    registerConsoleSocket(closeFallsBack as never, principal);
    registerConsoleSocket(bothMethodsFail as never, principal);
    // Register the healthy listener after both faults: its hint proves traversal continues past them.
    const ownerSocket = await openConsole(orgId, owner.headers.cookie!);
    const frames = track(ownerSocket);
    const nonFaultingBaseline = consoleLiveSnapshot().listeners - 2;
    try {
      const before = frames.length;
      const ownerHint = expectOneHint(frames, before);
      changeRole(orgId, { id: owner.decider.id, name: owner.decider.name, memberRole: "owner" }, target.personId, "admin");
      await ownerHint;

      expect(closeFallsBack.requestedCloseCode).toBe(4004);
      expect(closeFallsBack.closeAttempts).toBe(1);
      expect(closeFallsBack.terminateAttempts).toBe(1);
      expect(closeFallsBack.readyState).toBe(WebSocket.CLOSED);
      expect(bothMethodsFail.requestedCloseCode).toBe(4004);
      expect(bothMethodsFail.closeAttempts).toBe(1);
      expect(bothMethodsFail.terminateAttempts).toBe(1);
      // The injected double failure cannot prove physical closure; it must not prevent other listeners progressing.
      expect(bothMethodsFail.readyState).toBe(WebSocket.OPEN);
      expect(consoleLiveSnapshot().listeners).toBeLessThanOrEqual(nonFaultingBaseline);
      const closeAttemptsAfterRecheck = [closeFallsBack.closeAttempts, bothMethodsFail.closeAttempts];
      const terminateAttemptsAfterRecheck = [closeFallsBack.terminateAttempts, bothMethodsFail.terminateAttempts];
      await sweepConsoleLive(); // a listener removed after double failure is not retried on the next persisted recheck
      expect([closeFallsBack.closeAttempts, bothMethodsFail.closeAttempts]).toEqual(closeAttemptsAfterRecheck);
      expect([closeFallsBack.terminateAttempts, bothMethodsFail.terminateAttempts]).toEqual(terminateAttemptsAfterRecheck);
      expect(ownerSocket.readyState).toBe(WebSocket.OPEN);
      expect(frames.slice(before)).toEqual([JSON.stringify({ type: "workspace.changed" })]);
      expect(db.prepare(`SELECT role FROM workspace_members WHERE org_id = ? AND person_id = ?`).get(orgId, target.personId))
        .toEqual({ role: "admin" });
      expect(listEvents(orgId).some((event) => event.type === "member.role_changed" && event.subject_id === target.personId)).toBe(true);
    } finally {
      ownerSocket.close();
      closeFallsBack.readyState = WebSocket.CLOSED;
      closeFallsBack.emit("close");
      bothMethodsFail.readyState = WebSocket.CLOSED;
      bothMethodsFail.emit("close");
    }
  });

  it("skips partial observer hints over 1000 local roster rows but still revalidates expired sessions", async () => {
    const { orgId } = createOrganization("Console C5 observation boundary");
    const owner = await signInPerson(orgId, "C5 expiring owner");
    const other = await signInPerson(orgId, "C5 valid owner");
    const worker = registerAgent(orgId, "C5 file-only worker");
    // Local-only visible roster rows exercise the query sentinel; these rows are not external sessions or clients.
    const insertFixture = db.prepare(`INSERT INTO agents (id, org_id, name, url_key, api_key_hash, role, key_class, scope)
      VALUES (?, ?, ?, ?, ?, 'agent', 'agent', 'workspace')`);
    db.transaction(() => {
      for (let index = 0; index < 1000; index++) {
        const id = newId();
        const label = String(index).padStart(4, "0");
        insertFixture.run(id, orgId, `C5 local roster fixture ${label}`, `c5-roster-${label}-${id}`, `not-a-key-${id}`);
      }
    })();
    const rowCount = (db.prepare(`SELECT COUNT(*) AS count FROM agents WHERE org_id = ? AND removed_at IS NULL
      AND NOT (kind = 'session' AND ended_at IS NOT NULL)
      AND (key_class != 'human' OR id IN (SELECT agent_id FROM workspace_members WHERE org_id = ?))`).get(orgId, orgId) as { count: number }).count;
    expect(rowCount).toBeGreaterThan(1000);

    const ownerSocket = await openConsole(orgId, owner.headers.cookie!);
    const otherSocket = await openConsole(orgId, other.headers.cookie!);
    const ownerFrames = track(ownerSocket);
    const otherFrames = track(otherSocket);
    try {
      await sweepConsoleLive(); // oversized first observation is only a baseline
      const ownerBefore = ownerFrames.length;
      const otherBefore = otherFrames.length;
      const eventCount = listEvents(orgId).length;
      setAgentStatus(orgId, worker.agentId, null, ["src/c5-observer-only-file.ts"]);
      expect(listEvents(orgId)).toHaveLength(eventCount); // files-only producer emits no event
      await sweepConsoleLive();
      await expectNoHint(ownerFrames, ownerBefore);
      await expectNoHint(otherFrames, otherBefore);

      const session = db.prepare(`SELECT token_hash FROM sessions WHERE person_id = ?`).get(owner.personId) as { token_hash: string };
      expect(session.token_hash).toBeDefined();
      db.prepare(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`).run(new Date(Date.now() - 1000).toISOString(), session.token_hash);
      const expired = untilClose(ownerSocket);
      await sweepConsoleLive(); // mandatory persisted authorization recheck still runs beyond the optional row cap
      expect(await expired).toBe(4001);
      expect(otherSocket.readyState).toBe(WebSocket.OPEN);

      const countVisible = () => (db.prepare(`SELECT COUNT(*) AS count FROM agents WHERE org_id = ? AND removed_at IS NULL
        AND NOT (kind = 'session' AND ended_at IS NOT NULL)
        AND (key_class != 'human' OR id IN (SELECT agent_id FROM workspace_members WHERE org_id = ?))`).get(orgId, orgId) as { count: number }).count;
      const trimCount = countVisible() - 1000;
      expect(trimCount).toBeGreaterThanOrEqual(0);
      const fixturesToTrim = db.prepare(`SELECT id FROM agents WHERE org_id = ? AND url_key LIKE 'c5-roster-%' ORDER BY url_key DESC LIMIT ?`)
        .all(orgId, trimCount) as Array<{ id: string }>;
      expect(fixturesToTrim).toHaveLength(trimCount);
      db.transaction(() => {
        for (const fixture of fixturesToTrim) db.prepare(`DELETE FROM agents WHERE org_id = ? AND id = ?`).run(orgId, fixture.id);
      })();
      expect(countVisible()).toBe(1000);
      await sweepConsoleLive(); // at exactly 1000 rows, establish a complete observation baseline

      const positiveBefore = otherFrames.length;
      const positiveEventCount = listEvents(orgId).length;
      setAgentStatus(orgId, worker.agentId, null, ["src/c5-observer-boundary-positive.ts"]);
      expect(listEvents(orgId)).toHaveLength(positiveEventCount); // still a file-only observer change
      await sweepConsoleLive();
      await expectOneHint(otherFrames, positiveBefore);
    } finally {
      ownerSocket.close();
      otherSocket.close();
    }
  });
});
function dbRollbackProbe(orgId: string): { event: ReturnType<typeof emitEvent>; absent: boolean } {
  let event: ReturnType<typeof emitEvent> | undefined;
  try {
    db.transaction(() => {
      db.transaction(() => {
        event = emitEvent({ orgId, type: "approval.noted", subjectType: "approval", subjectId: newId() });
        expect(db.prepare(`SELECT 1 FROM events WHERE id = ? AND seq = ? AND org_id = ?`).get(event.id, event.seq, event.org_id)).toBeTruthy();
      })();
      throw new Error("rollback probe");
    })();
  } catch (error) {
    expect((error as Error).message).toBe("rollback probe");
  }
  if (!event) throw new Error("rollback probe did not write an event");
  return { event, absent: !db.prepare(`SELECT 1 FROM events WHERE id = ? AND seq = ? AND org_id = ?`).get(event.id, event.seq, event.org_id) };
}
