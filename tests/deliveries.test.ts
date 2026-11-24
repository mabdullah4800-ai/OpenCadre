import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent, sendMessage } from "../src/service.js";
import { createTask } from "../src/tasks.js";
import { ackEvent, getDelivery, pullEvents } from "../src/deliveries.js";
import { listEvents } from "../src/events.js";

function setup(name = "Deliveries Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Claude-A");
  const b = registerAgent(orgId, "Codex-B");
  return {
    orgId,
    a: { id: a.agentId, name: "Claude-A", key: a.apiKey },
    b: { id: b.agentId, name: "Codex-B", key: b.apiKey },
  };
}

async function directedSeq(orgId: string, from: { id: string; name: string }, to: string) {
  await sendMessage(orgId, from, to, "hello");
  return listEvents(orgId).at(-1)!.seq;
}

describe("delivery records", () => {
  it("queues a delivery for the target of a directed event only", async () => {
    const { orgId, a, b } = setup();
    createTask(orgId, a, { title: "not directed" });
    const seq = await directedSeq(orgId, a, "Codex-B");

    expect(getDelivery(orgId, b.id, seq)?.state).toBe("queued");
    expect(getDelivery(orgId, a.id, seq)).toBeNull();
    const taskSeq = listEvents(orgId, { types: ["task.created"] })[0].seq;
    expect(getDelivery(orgId, a.id, taskSeq)).toBeNull();
  });
});

describe("pullEvents", () => {
  it("returns the agent's open directed events and marks queued ones delivered once", async () => {
    const { orgId, a, b } = setup();
    const seq = await directedSeq(orgId, a, "Codex-B");

    const first = pullEvents(orgId, b.id);
    expect(first.map((e) => e.seq)).toEqual([seq]);
    expect(first[0].delivery_state).toBe("delivered");
    const deliveredAt = getDelivery(orgId, b.id, seq)!.delivered_at;
    expect(deliveredAt).toBeTruthy();

    const again = pullEvents(orgId, b.id);
    expect(again.map((e) => e.seq)).toEqual([seq]);
    expect(getDelivery(orgId, b.id, seq)!.delivered_at).toBe(deliveredAt);
    expect(pullEvents(orgId, a.id)).toHaveLength(0);
  });

  it("drops events once the agent has acknowledged or resolved them", async () => {
    const { orgId, a, b } = setup();
    const s1 = await directedSeq(orgId, a, "Codex-B");
    const s2 = await directedSeq(orgId, a, "Codex-B");
    pullEvents(orgId, b.id);
    ackEvent(orgId, b.id, s1, "acknowledged");
    expect(pullEvents(orgId, b.id).map((e) => e.seq)).toEqual([s2]);
  });
});

describe("ackEvent", () => {
  it("moves forward through acknowledged to acted, and resolved states are final", async () => {
    const { orgId, a, b } = setup();
    const seq = await directedSeq(orgId, a, "Codex-B");
    pullEvents(orgId, b.id);

    const acked = ackEvent(orgId, b.id, seq, "acknowledged");
    expect(acked.ok && acked.delivery.state).toBe("acknowledged");
    expect(getDelivery(orgId, b.id, seq)!.acknowledged_at).toBeTruthy();

    expect(ackEvent(orgId, b.id, seq, "acknowledged").ok).toBe(true);
    const acted = ackEvent(orgId, b.id, seq, "acted");
    expect(acted.ok && acted.delivery.state).toBe("acted");
    expect(getDelivery(orgId, b.id, seq)!.resolved_at).toBeTruthy();

    expect(ackEvent(orgId, b.id, seq, "acknowledged").ok).toBe(false);
    expect(ackEvent(orgId, b.id, seq, "dismissed").ok).toBe(false);
  });

  it("acking straight from queued also records delivery and acknowledgement time", async () => {
    const { orgId, a, b } = setup();
    const seq = await directedSeq(orgId, a, "Codex-B");
    const result = ackEvent(orgId, b.id, seq, "dismissed");
    expect(result.ok && result.delivery.state).toBe("dismissed");
    const row = getDelivery(orgId, b.id, seq)!;
    expect(row.delivered_at).toBeTruthy();
    expect(row.acknowledged_at).toBeTruthy();
    expect(row.resolved_at).toBeTruthy();
  });

  it("only the target can ack, only for its own org, and only known outcomes", async () => {
    const { orgId, a, b } = setup();
    const other = setup("Other Deliveries Org");
    const seq = await directedSeq(orgId, a, "Codex-B");
    expect(ackEvent(orgId, a.id, seq, "acknowledged").ok).toBe(false);
    expect(ackEvent(other.orgId, other.b.id, seq, "acknowledged").ok).toBe(false);
    expect(ackEvent(orgId, b.id, 999_999_999, "acknowledged").ok).toBe(false);
    expect(ackEvent(orgId, b.id, seq, "maybe" as never).ok).toBe(false);
  });
});

describe("REST deliveries", () => {
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

  it("pulls and acks over HTTP", async () => {
    const { orgId, a, b } = setup("REST Deliveries Org");
    const seq = await directedSeq(orgId, a, "Codex-B");

    const pulled = (await (await call(b.key, "GET", "/v1/deliveries")).json()) as { events: Array<{ seq: number; delivery_state: string }> };
    expect(pulled.events.map((e) => [e.seq, e.delivery_state])).toEqual([[seq, "delivered"]]);

    expect((await call(b.key, "POST", `/v1/events/${seq}/ack`, { outcome: "nope" })).status).toBe(400);
    expect((await call(a.key, "POST", `/v1/events/${seq}/ack`, { outcome: "acknowledged" })).status).toBe(404);
    const acked = await call(b.key, "POST", `/v1/events/${seq}/ack`, { outcome: "acted" });
    expect(acked.status).toBe(200);
    expect(((await acked.json()) as { delivery: { state: string } }).delivery.state).toBe("acted");
    expect((await call(b.key, "POST", `/v1/events/${seq}/ack`, { outcome: "acknowledged" })).status).toBe(409);
  });
});
