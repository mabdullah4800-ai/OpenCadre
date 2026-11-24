import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/mcp.js";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { beginIdempotent, requestHash, sweepIdempotencyKeys } from "../src/idempotency.js";
import { READ_ONLY_CODE, assignPlan } from "../src/billing.js";
import { startFetchRecorder } from "./helpers/fetch-recorder.js";

let restBase: string;
let mcpUrl: URL;
let closeRest: (() => Promise<void>) | undefined;
let closeMcp: (() => Promise<void>) | undefined;

// Both servers are reached with Fetch (this file's `post`, and the MCP SDK's transport). A bare listen(0) can land on a
// port Fetch refuses ("bad port"; this PC's dynamic range starts at 1024), which failed this file in a full gate, so each
// starts through startFetchRecorder: 127.0.0.1, probed with Fetch, rebound only on that refusal, at most three attempts.
beforeAll(async () => {
  const rest = await startFetchRecorder((req, res) => app(req, res));
  closeRest = rest.close;
  restBase = rest.url;
  const mcp = await startFetchRecorder((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
  });
  closeMcp = mcp.close;
  mcpUrl = new URL(`${mcp.url}/mcp`);
});
afterAll(async () => {
  // Each close is set only once its server started, so a failed second start still closes the first.
  await closeRest?.();
  await closeMcp?.();
});

let n = 0;
function pair() {
  const { orgId } = createOrganization(`Idem Org ${++n}`);
  const sender = registerAgent(orgId, `Sender-${n}`);
  const receiver = registerAgent(orgId, `Receiver-${n}`);
  return { orgId, sender, receiver, receiverName: `Receiver-${n}` };
}
const messageCount = (orgId: string) => (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE org_id = ?`).get(orgId) as { c: number }).c;
const taskCount = (orgId: string) => (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE org_id = ?`).get(orgId) as { c: number }).c;
const post = (path: string, key: string, body: unknown, idem?: string) =>
  fetch(`${restBase}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(idem ? { "idempotency-key": idem } : {}) },
    body: JSON.stringify(body),
  });

describe("REST Idempotency-Key", () => {
  it("runs a send once and replays the first response to a retry", async () => {
    const { orgId, sender, receiverName } = pair();
    const first = await post("/v1/messages", sender.apiKey, { toAgent: receiverName, body: "deploy done" }, "retry-key-0001");
    const firstBody = await first.json();
    const retry = await post("/v1/messages", sender.apiKey, { toAgent: receiverName, body: "deploy done" }, "retry-key-0001");
    expect(retry.status).toBe(first.status);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await retry.json()).toEqual(firstBody);
    expect(messageCount(orgId)).toBe(1);
  });

  it("rejects a key reused for a different request, and a malformed key", async () => {
    const { sender, receiverName } = pair();
    await post("/v1/messages", sender.apiKey, { toAgent: receiverName, body: "one" }, "reused-key-0001");
    expect((await post("/v1/messages", sender.apiKey, { toAgent: receiverName, body: "two" }, "reused-key-0001")).status).toBe(422);
    expect((await post("/v1/messages", sender.apiKey, { toAgent: receiverName, body: "x" }, "bad key")).status).toBe(400);
  });

  it("scopes keys to the calling agent", async () => {
    const { orgId, sender, receiver, receiverName } = pair();
    await post("/v1/messages", sender.apiKey, { toAgent: receiverName, body: "hi" }, "shared-key-0001");
    const other = await post("/v1/messages", receiver.apiKey, { toAgent: `Sender-${n}`, body: "hi" }, "shared-key-0001");
    expect(other.headers.get("idempotent-replayed")).toBeNull();
    expect(messageCount(orgId)).toBe(2);
  });

  it("keeps working without a key exactly as before", async () => {
    const { orgId, sender, receiverName } = pair();
    await post("/v1/messages", sender.apiKey, { toAgent: receiverName, body: "a" });
    await post("/v1/messages", sender.apiKey, { toAgent: receiverName, body: "a" });
    expect(messageCount(orgId)).toBe(2);
  });

  it("delivers once when identical retries arrive at the same time", async () => {
    const { orgId, sender, receiverName } = pair();
    const burst = await Promise.all(
      Array.from({ length: 8 }, () => post("/v1/messages", sender.apiKey, { toAgent: receiverName, body: "burst" }, "burst-key-00001")),
    );
    expect(messageCount(orgId)).toBe(1);
    expect(burst.every((r) => [201, 409].includes(r.status))).toBe(true);
  });

  it("makes a retried claim safe: the retry gets the original success, not a conflict", async () => {
    const { sender } = pair();
    const task = await (await post("/v1/tasks", sender.apiKey, { title: "ship it" })).json();
    const id = task.task?.id ?? task.id;
    const first = await post(`/v1/tasks/${id}/claim`, sender.apiKey, {}, "claim-key-00001");
    const retry = await post(`/v1/tasks/${id}/claim`, sender.apiKey, {}, "claim-key-00001");
    expect(retry.status).toBe(first.status);
    expect(await retry.json()).toEqual(await first.json());
  });
});

describe("MCP requestId", () => {
  it("replays a send_message retry without delivering twice", async () => {
    const { orgId, sender, receiverName } = pair();
    const client = new Client({ name: "idem-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${sender.apiKey}` } } }));
    const call = () => client.callTool({ name: "send_message", arguments: { toAgent: receiverName, body: "via mcp", requestId: "mcp-retry-00001" } });
    const first = await call();
    const retry = await call();
    expect(retry).toEqual(first);
    expect(messageCount(orgId)).toBe(1);
    const conflict = await client.callTool({ name: "send_message", arguments: { toAgent: receiverName, body: "different", requestId: "mcp-retry-00001" } });
    expect(JSON.stringify(conflict)).toContain("already used for a different send_message request");
    await client.close();
  });
});

describe("a refused call is not recorded under the caller's requestId", () => {
  /** Billing Phase 1 (src/billing.ts) meets idempotency (src/idempotency.ts), and the two are correct
   * in exactly one order. `withBillingGuard` (src/mcp.ts) runs the read-only check BEFORE
   * `idempotentTool`, so a refusal never touches the key. Recording it first would let a request that
   * did no work CLAIM the caller's id, and every consequence of that runs against the caller: the
   * retry they sent after the workspace was restored would replay the stored refusal instead of doing
   * the work, so the write they asked for would never happen on a workspace that is by then perfectly
   * willing to accept it, and their own retry key is what stopped it.
   *
   * The assertion that carries this is the LAST one, not the refusals: a refusal is trivially
   * producible. What has to be true is that the SAME id still works once the workspace is writable,
   * and that the work happened exactly once. Guarding inside the runner -- wrapping it in a closure
   * that checks billing and returns early, a change that reads as equivalent to this one because both
   * refuse every call on a lapsed workspace -- turns this test red and no other in the file.
   */
  it("refuses twice on a lapsed workspace, then runs once when the same id is retried after restore", async () => {
    const { orgId, sender } = pair();
    db.prepare(`UPDATE organizations SET trial_ends_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), orgId);
    const client = new Client({ name: "idem-lapsed", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${sender.apiKey}` } } }));
    const attempt = () => client.callTool({ name: "create_task", arguments: { title: "written after the plan lapsed", requestId: "lapsed-idem-00001" } });
    const textOf = (r: Awaited<ReturnType<typeof attempt>>) => (r.content as Array<{ type: string; text: string }>)[0].text;

    const first = await attempt();
    expect(first.isError).toBe(true);
    expect(textOf(first)).toContain(READ_ONLY_CODE);
    // Neither direction: not held ("in_progress") and not spent ("already used"). The key is untouched.
    expect(textOf(first)).not.toContain("still running");

    const second = await attempt();
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain(READ_ONLY_CODE);
    expect(taskCount(orgId), "two refusals must not have written anything").toBe(0);

    // The workspace is put back on a plan and the SAME id is retried. If the refusal had been stored
    // under the key, this replays the refusal and the caller never gets their task.
    assignPlan(orgId, "pro");
    const after = await attempt();
    expect(after.isError ?? false, "the same id must work once the workspace is writable again").toBe(false);
    expect(taskCount(orgId), "the retry did the work exactly once").toBe(1);
    await client.close();
  });
});

describe("idempotency keys store", () => {
  it("never lets a slow original overwrite or release a key a retry has reclaimed", async () => {
    const { orgId, sender } = pair();
    const { completeIdempotent, releaseIdempotent } = await import("../src/idempotency.js");
    const hash = requestHash("scope", { b: 2 });
    const t0 = Date.now();
    const original = beginIdempotent(orgId, sender.agentId, "slow-key-00001", "scope", hash, t0);
    const retry = beginIdempotent(orgId, sender.agentId, "slow-key-00001", "scope", hash, t0 + 3 * 60_000);
    if (original.state !== "new" || retry.state !== "new") throw new Error("expected two claims");
    completeIdempotent(orgId, sender.agentId, "slow-key-00001", retry.claimedAt, 201, '{"by":"retry"}');
    completeIdempotent(orgId, sender.agentId, "slow-key-00001", original.claimedAt, 201, '{"by":"original"}');
    releaseIdempotent(orgId, sender.agentId, "slow-key-00001", original.claimedAt);
    expect(beginIdempotent(orgId, sender.agentId, "slow-key-00001", "scope", hash)).toMatchObject({ state: "replay", response: '{"by":"retry"}' });
  });

  it("lets a retry reclaim a key whose first request died mid-write", () => {
    const { orgId, sender } = pair();
    const hash = requestHash("scope", { a: 1 });
    const t0 = Date.now();
    expect(beginIdempotent(orgId, sender.agentId, "died-key-00001", "scope", hash, t0).state).toBe("new");
    expect(beginIdempotent(orgId, sender.agentId, "died-key-00001", "scope", hash, t0 + 30_000).state).toBe("in_progress");
    expect(beginIdempotent(orgId, sender.agentId, "died-key-00001", "scope", hash, t0 + 3 * 60_000).state).toBe("new");
  });

  it("hashes requests independent of key order", () => {
    expect(requestHash("s", { a: 1, b: { c: 2, d: 3 } })).toBe(requestHash("s", { b: { d: 3, c: 2 }, a: 1 }));
    expect(requestHash("s", { a: 1 })).not.toBe(requestHash("t", { a: 1 }));
  });

  it("expires keys after 24 hours", () => {
    const { orgId, sender } = pair();
    beginIdempotent(orgId, sender.agentId, "old-key-000001", "scope", "h", Date.now() - 25 * 60 * 60 * 1000);
    expect(sweepIdempotencyKeys()).toBeGreaterThanOrEqual(1);
    expect(beginIdempotent(orgId, sender.agentId, "old-key-000001", "scope", "h2").state).toBe("new");
  });
});
