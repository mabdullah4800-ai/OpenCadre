import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { createOrganization, getMessages, registerAgent } from "../src/service.js";
import { claimTask, completeTask, createTask, listTasks, sweepExpiredLeases } from "../src/tasks.js";
import { isOnline, pushToAgent, registerSocket } from "../src/live.js";

// Reliability sprint R2: the failures strangers will actually hit, exercised end to end.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencadre-recovery-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("an agent dies mid-claim", () => {
  it("the lease lapses once, another agent takes over, and the dead agent's late completion is refused", async () => {
    const { orgId } = createOrganization("Crash Org");
    const deadReg = registerAgent(orgId, "Crashed-Builder");
    const liveReg = registerAgent(orgId, "Backup-Builder");
    const dead = { id: deadReg.agentId, name: "Crashed-Builder" };
    const live = { id: liveReg.agentId, name: "Backup-Builder" };
    const task = createTask(orgId, dead, { title: "migrate billing" });
    expect(claimTask(orgId, dead, task.id, 0.2).ok).toBe(true);

    await sleep(300); // the builder crashed: no renew
    sweepExpiredLeases(orgId);
    sweepExpiredLeases(orgId);
    const lapsed = listEvents(orgId, { types: ["task.lease_expired"] }).filter((e) => e.subject_id === task.id);
    expect(lapsed).toHaveLength(1);

    expect(claimTask(orgId, live, task.id, 60).ok).toBe(true);
    expect(completeTask(orgId, dead, task.id, "I was done").ok).toBe(false);
    expect(completeTask(orgId, live, task.id, "done by backup").ok).toBe(true);
    expect(listTasks(orgId).find((t) => t.id === task.id)).toMatchObject({ status: "done", claimed_by_agent_name: "Backup-Builder" });
  });
});

describe("a flaky network makes clients retry", () => {
  let base: string;
  let server: ReturnType<typeof app.listen>;
  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("a send retried five times (two at once) is delivered exactly once and read exactly once", async () => {
    const { orgId } = createOrganization("Flaky Org");
    const sender = registerAgent(orgId, "Flaky-Sender");
    const receiver = registerAgent(orgId, "Flaky-Receiver");
    const send = () =>
      fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${sender.apiKey}`, "content-type": "application/json", "idempotency-key": "flaky-send-0001" },
        body: JSON.stringify({ toAgent: "Flaky-Receiver", body: "deploy approved", priority: "high" }),
      });
    await send();
    await Promise.all([send(), send()]);
    await send();
    await send();
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE org_id = ?`).get(orgId) as { n: number };
    expect(rows.n).toBe(1);
    expect(getMessages(orgId, receiver.agentId).map((m) => m.body)).toEqual(["deploy approved"]);
    expect(getMessages(orgId, receiver.agentId)).toHaveLength(0);
  });
});

// A fake socket, same shape tests/live.test.ts uses -- lets us simulate a partition
// (the socket looks OPEN locally but nothing ever reaches the other side) without
// standing up a real network link.
function fakeSocket() {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
    on(event: string, cb: (...a: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
    },
    emit(event: string, ...args: unknown[]) {
      (listeners[event] ?? []).forEach((cb) => cb(...args));
    },
  };
}

describe("a network partition drops a receiver's live socket for a while", () => {
  let base: string;
  let server: ReturnType<typeof app.listen>;
  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("messages sent (with client retries) while the socket is down are all still delivered, exactly once, on reconnect", async () => {
    const { orgId } = createOrganization("Partition Org");
    const sender = registerAgent(orgId, "Partition-Sender");
    const receiver = registerAgent(orgId, "Partition-Receiver");

    // Receiver starts connected...
    const ws = fakeSocket();
    registerSocket(receiver.agentId, ws as never);
    expect(isOnline(receiver.agentId)).toBe(true);

    // ...then the link drops. The hub has no way to know why -- it just
    // observes the socket close, same as a real proxy would report it.
    ws.emit("close");
    expect(isOnline(receiver.agentId)).toBe(false);
    expect(pushToAgent(receiver.agentId, { type: "message" })).toBe(false);

    // While partitioned, three distinct messages are sent. Two of them are
    // retried (the sender's client never saw the ack cross the broken link),
    // exercising R1's idempotency keys under exactly this failure.
    const send = (idempotencyKey: string, body: string) =>
      fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${sender.apiKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ toAgent: "Partition-Receiver", body, priority: "high" }),
      });
    await send("partition-msg-1", "step 1 done");
    await send("partition-msg-1", "step 1 done"); // retry: same key, ack never arrived
    await send("partition-msg-2", "step 2 done");
    await send("partition-msg-3", "step 3 done");
    await send("partition-msg-3", "step 3 done"); // retry
    await send("partition-msg-2", "step 2 done"); // retry, out of order

    const stored = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE org_id = ?`).get(orgId) as { n: number };
    expect(stored.n).toBe(3); // three logical sends, not six

    // The link comes back (a fresh socket, same as a client reconnecting).
    const ws2 = fakeSocket();
    registerSocket(receiver.agentId, ws2 as never);
    expect(isOnline(receiver.agentId)).toBe(true);

    // Everything sent during the outage is there, in order, with no duplicates --
    // the WS push was never the delivery guarantee; persisted storage is.
    expect(getMessages(orgId, receiver.agentId).map((m) => m.body)).toEqual(["step 1 done", "step 2 done", "step 3 done"]);
    // A second read after consuming finds nothing left to redeliver.
    expect(getMessages(orgId, receiver.agentId)).toHaveLength(0);
  });
});

describe("the hub restarts", () => {
  const runWorker = (phase: "write" | "read", dbFile: string, stateFile: string) =>
    new Promise<string>((resolve, reject) => {
      const worker = path.join(__dirname, "helpers", "restart-worker.ts");
      const child = spawn(process.execPath, ["--import", "tsx", worker, phase, stateFile], {
        env: { ...process.env, OPENCADRE_DB_PATH: dbFile, OPENCADRE_LOG_LEVEL: "error" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
    });

  it("pending approvals, claims, unread mail and idempotency keys survive a real process restart", async () => {
    const dbFile = path.join(dir, "restart.db");
    const stateFile = path.join(dir, "restart-state.json");
    expect(await runWorker("write", dbFile, stateFile)).toBe("written");
    const after = JSON.parse(await runWorker("read", dbFile, stateFile));
    expect(after).toMatchObject({
      approvalPending: true,
      taskClaimedBy: "Restart-Builder",
      leaseActive: true,
      firstRead: ["review before restart"],
      secondRead: 0,
      replay: { state: "replay", status: 201, response: '{"ok":true,"threadId":"t-before"}' },
      decidedOk: true,
    });
  }, 60_000);
});
