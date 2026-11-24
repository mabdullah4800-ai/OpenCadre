import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { authenticateAgentKey } from "../src/auth.js";
import { registerSocket } from "../src/live.js";
import { heldRequestCount } from "../src/revocation.js";
import { createOrganization, registerAgent, sendMessage } from "../src/service.js";
import { requestApproval } from "../src/approvals.js";
import { emitEvent } from "../src/events.js";

/** R3: revoking a key ends everything it holds open (sockets, long-polls, MCP tool calls) within 5 s. */
const REVOKE_BUDGET_MS = 5000;

let restServer: ReturnType<typeof app.listen>;
let base: string;
let wsBase: string;
let mcpServer: http.Server;
let mcpUrl: URL;

beforeAll(async () => {
  restServer = app.listen(0);
  await new Promise((r) => restServer.once("listening", r));
  const port = (restServer.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  // Mirrors the /live wiring in src/index.ts.
  const wss = new WebSocketServer({ server: restServer, path: "/live" });
  wss.on("connection", (ws, req) => {
    const authed = authenticateAgentKey(new URL(req.url ?? "", "http://localhost").searchParams.get("apiKey") ?? undefined);
    if (!authed) return void ws.close(4001, "invalid api key");
    registerSocket(authed.agentId, ws);
  });

  mcpServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, resolve));
  mcpUrl = new URL(`http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => restServer.close(() => resolve()));
  await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
});

function workspace(name: string) {
  const { orgId } = createOrganization(name);
  const coder = registerAgent(orgId, "Coder");
  const other = registerAgent(orgId, "Other");
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  return {
    orgId,
    coder: { id: coder.agentId, name: "Coder", key: coder.apiKey },
    other: { id: other.agentId, name: "Other", key: other.apiKey },
    operatorKey: operator.apiKey,
    operator: { id: operator.agentId, name: "Operator" },
  };
}

const get = (path: string, key: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });

async function rotate(operatorKey: string, agentId: string): Promise<string> {
  const res = await fetch(`${base}/v1/org/agents/${agentId}/rotate-key`, { method: "POST", headers: { authorization: `Bearer ${operatorKey}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { apiKey: string }).apiKey;
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settle = () => new Promise((r) => setTimeout(r, 150));

describe("rotating a key", () => {
  it("ends that key's REST long-polls within 5 s, and leaves other agents' waits alone", async () => {
    const w = workspace("Revoke REST");
    const approval = await requestApproval(w.orgId, w.other, { action: "npm publish" });
    const latest = emitEvent({ orgId: w.orgId, type: "decision.recorded", actor: w.other, subjectType: "decision", subjectId: "start", payload: {} }).seq;
    const waits = [
      get("/v1/messages/wait?timeoutSeconds=60", w.coder.key),
      get(`/v1/events/wait?after=${latest}&types=task.created&timeoutSeconds=60`, w.coder.key),
      get(`/v1/approvals/${approval.id}/wait?timeoutSeconds=60`, w.coder.key),
    ];
    const otherWait = get("/v1/messages/wait?timeoutSeconds=60", w.other.key);
    await until(() => heldRequestCount(w.coder.id) === 3 && heldRequestCount(w.other.id) === 1, "the long-polls to be held");

    const started = Date.now();
    const newKey = await rotate(w.operatorKey, w.coder.id);
    const results = await Promise.all(waits);
    const elapsed = Date.now() - started;

    expect(results.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(elapsed).toBeLessThan(REVOKE_BUDGET_MS);
    expect(((await results[0].json()) as { error: string }).error).toContain("no longer works");
    expect(heldRequestCount(w.coder.id)).toBe(0);

    // The waiters behind the ended requests still resolve later: nothing reaches the old client and nothing throws.
    await sendMessage(w.orgId, w.other, "Coder", "after rotation");
    emitEvent({ orgId: w.orgId, type: "decision.recorded", actor: w.other, subjectType: "decision", subjectId: "d", payload: {} });
    await sendMessage(w.orgId, w.coder, "Other", "for the other agent");
    const other = await otherWait;
    expect(other.status).toBe(200);
    expect(JSON.stringify(await other.json())).toContain("for the other agent");
    await settle();

    expect((await get("/v1/me", w.coder.key)).status).toBe(401);
    expect((await get("/v1/me", newKey)).status).toBe(200);
  });

  it("cuts an MCP wait_for_message call at once, so mail sent afterwards never reaches the old client", async () => {
    const w = workspace("Revoke MCP");
    const client = new Client({ name: "revocation-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${w.coder.key}` } } }));
    try {
      let outcome: "pending" | "result" | "error" = "pending";
      let delivered = "";
      void client.callTool({ name: "wait_for_message", arguments: { timeoutSeconds: 60 } }).then(
        (result) => { outcome = "result"; delivered = JSON.stringify(result); },
        () => { outcome = "error"; },
      );
      await until(() => heldRequestCount(w.coder.id) >= 1, "the MCP call to be held");

      await rotate(w.operatorKey, w.coder.id);
      // The tool call streams its response, so its headers are already out: the hub cuts the
      // connection instead of answering 401. How fast a client notices is up to the client.
      expect(heldRequestCount(w.coder.id)).toBe(0);

      await sendMessage(w.orgId, w.other, "Coder", "after rotation");
      await settle();
      expect(outcome).not.toBe("result");
      expect(delivered).not.toContain("after rotation");

      // Every new call with the old key is refused.
      await expect(client.callTool({ name: "get_messages", arguments: {} })).rejects.toThrow(/401|invalid/i);
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("closes every live socket the agent has open, not only the newest", async () => {
    const w = workspace("Revoke Sockets");
    const open = async () => {
      const ws = new WebSocket(`${wsBase}/live?apiKey=${w.coder.key}`);
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      return ws;
    };
    const sockets = [await open(), await open()];
    const closed = sockets.map((ws) => new Promise<number>((resolve) => ws.once("close", (code) => resolve(code))));

    const started = Date.now();
    await rotate(w.operatorKey, w.coder.id);
    expect(await Promise.all(closed)).toEqual([4001, 4001]);
    expect(Date.now() - started).toBeLessThan(REVOKE_BUDGET_MS);
  });

  it("does not cut retry-safe writes: a send retried with the new key replays its original result", async () => {
    const w = workspace("Revoke Writes");
    const send = (key: string) => fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": "send-once-0001" },
      body: JSON.stringify({ toAgent: "Other", body: "exactly once" }),
    });
    const first = await send(w.coder.key);
    expect(first.status).toBe(201);
    const newKey = await rotate(w.operatorKey, w.coder.id);
    const retry = await send(newKey);
    expect(retry.status).toBe(201);
    expect((await retry.json()).threadId).toBe((await first.json()).threadId);
  });
});
