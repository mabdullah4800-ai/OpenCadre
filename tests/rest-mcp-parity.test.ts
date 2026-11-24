import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/mcp.js";
import { app } from "../src/rest.js";
import {
  createOrganization, getMessages, registerAgent, sendMessage, setAgentStatus,
} from "../src/service.js";
import { recordDecision } from "../src/events.js";
import { getAwareness } from "../src/awareness.js";
import { db } from "../src/db.js";

/** Inventory: MCP tools in src/mcp.ts ↔ REST routes in src/rest.ts */
export const MCP_REST_MAP = [
  { mcp: "send_message", rest: "POST /v1/messages" },
  { mcp: "broadcast_message", rest: "POST /v1/messages (toAgents|channel)" },
  { mcp: "ask_clarification", rest: "POST /v1/questions" },
  { mcp: "get_messages", rest: "GET /v1/messages" },
  { mcp: "wait_for_message", rest: "GET /v1/messages/wait" },
  { mcp: "reply", rest: "POST /v1/messages/:threadId/reply" },
  { mcp: "get_message_status", rest: "GET /v1/messages/:threadId/status" },
  { mcp: "search_messages", rest: "GET /v1/messages/search" },
  { mcp: "get_active_agents", rest: "GET /v1/agents" },
  { mcp: "set_status", rest: "POST /v1/status" },
  { mcp: "get_timeline", rest: "GET /v1/events" },
  { mcp: "wait_for_timeline", rest: "GET /v1/events/wait" },
  { mcp: "get_awareness", rest: "GET /v1/awareness" },
  { mcp: "pull_events", rest: "GET /v1/deliveries" },
  { mcp: "ack_event", rest: "POST /v1/events/:seq/ack" },
  { mcp: "record_decision", rest: "POST /v1/decisions" },
  { mcp: "create_task", rest: "POST /v1/tasks" },
  { mcp: "list_tasks", rest: "GET /v1/tasks" },
  { mcp: "claim_task", rest: "POST /v1/tasks/:taskId/claim" },
  { mcp: "renew_claim", rest: "POST /v1/tasks/:taskId/renew" },
  { mcp: "release_task", rest: "POST /v1/tasks/:taskId/release" },
  { mcp: "complete_task", rest: "POST /v1/tasks/:taskId/complete" },
  { mcp: "set_task_lane", rest: "POST /v1/tasks/:taskId/lane" },
  { mcp: "request_approval", rest: "POST /v1/approvals" },
  { mcp: "wait_for_approval", rest: "GET /v1/approvals/:approvalId/wait" },
  { mcp: "list_approvals", rest: "GET /v1/approvals" },
  { mcp: "decide_approval", rest: "POST /v1/approvals/:approvalId/decide" },
  { mcp: "withdraw_approval", rest: "POST /v1/approvals/:approvalId/withdraw" },
  { mcp: "list_approval_grants", rest: "GET /v1/approval-grants" },
  { mcp: "revoke_approval_grant", rest: "DELETE /v1/approval-grants/:grantId" },
  { mcp: "share_file", rest: "POST /v1/files/share" },
  { mcp: "download_file", rest: "GET /v1/files/:fileId" },
  { mcp: "register_webhook", rest: "POST /v1/webhook" },
  { mcp: "set_wip_cap", rest: "PUT /v1/org/projects/:key/settings" },
] as const;

/** REST-only agent routes (no MCP equivalent needed). */
export const REST_ONLY = [
  "POST /v1/heartbeat",
  "POST /v1/usage",
  "GET /v1/me",
  // Read by the clearance gate hook; changed by operators in the console.
  "GET /v1/clearance-policy",
  "GET /v1/clearance-policies",
  "PUT /v1/clearance-policy",
  "DELETE /v1/clearance-policy",
  // Read by agents and the console; set_wip_cap is the MCP twin of the PUT.
  "GET /v1/org/projects/:key/settings",
  // Posted by post-execution hooks.
  "POST /v1/clearances/executed",
  "POST /v1/orgs",
  "POST /v1/agents",
  "GET /health",
  "GET /v1/metrics",
];

let mcpServer: http.Server;
let mcpUrl: URL;
let restBaseUrl: string;
let restServer: ReturnType<typeof app.listen>;

beforeAll(async () => {
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
  const mcpAddr = mcpServer.address();
  mcpUrl = new URL(`http://127.0.0.1:${typeof mcpAddr === "object" && mcpAddr ? mcpAddr.port : 0}/mcp`);

  restServer = app.listen(0);
  await new Promise((r) => restServer.once("listening", r));
  restBaseUrl = `http://127.0.0.1:${(restServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
  await new Promise<void>((resolve) => restServer.close(() => resolve()));
});

async function connect(apiKey: string) {
  const client = new Client({ name: "parity-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");

function setupPair() {
  const { orgId } = createOrganization("Parity Org");
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return {
    orgId,
    a: { id: a.agentId, name: "Agent A", key: a.apiKey },
    b: { id: b.agentId, name: "Agent B", key: b.apiKey },
  };
}

describe("REST/MCP inventory", () => {
  it("documents every MCP tool with a REST counterpart", () => {
    expect(MCP_REST_MAP).toHaveLength(34);
    expect(REST_ONLY).toContain("GET /v1/me");
  });

  it("MCP tools/list includes wait_for_timeline (REST /v1/events/wait parity)", async () => {
    const { a } = setupPair();
    const client = await connect(a.key);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("wait_for_timeline");
    await client.close();
  });
});

describe("afterId cursor parity (MCP ↔ REST)", () => {
  it("MCP get_messages afterId matches REST GET /v1/messages?afterId=", async () => {
    const { orgId, a, b } = setupPair();
    await sendMessage(orgId, { id: a.id, name: a.name }, "Agent B", "first");
    const [first] = getMessages(orgId, b.id, undefined, { peek: true });
    await sendMessage(orgId, { id: a.id, name: a.name }, "Agent B", "second");

    const client = await connect(b.key);
    const mcpText = text(await client.callTool({ name: "get_messages", arguments: { peek: true, afterId: first.id } }));
    expect(mcpText).toContain("second");
    expect(mcpText).not.toContain("first");

    const restRes = await fetch(`${restBaseUrl}/v1/messages?peek=true&afterId=${first.id}`, {
      headers: { authorization: `Bearer ${b.key}` },
    });
    const { messages } = (await restRes.json()) as { messages: Array<{ body: string }> };
    expect(messages.map((m) => m.body)).toEqual(["second"]);
    await client.close();
  });

  it("MCP wait_for_message afterId matches REST GET /v1/messages/wait?afterId=", async () => {
    const { orgId, a, b } = setupPair();
    await sendMessage(orgId, { id: a.id, name: a.name }, "Agent B", "seen");
    const [seen] = getMessages(orgId, b.id, undefined, { peek: true });

    const client = await connect(b.key);
    const waitPromise = client.callTool({
      name: "wait_for_message",
      arguments: { timeoutSeconds: 5, peek: true, afterId: seen.id },
    });
    await new Promise((r) => setTimeout(r, 100));
    await sendMessage(orgId, { id: a.id, name: a.name }, "Agent B", "fresh");
    const mcpText = text(await waitPromise);
    expect(mcpText).toContain("fresh");

    await sendMessage(orgId, { id: a.id, name: a.name }, "Agent B", "rest-fresh");
    const [cursor] = getMessages(orgId, b.id, undefined, { peek: true, afterId: seen.id });
    const restRes = await fetch(`${restBaseUrl}/v1/messages/wait?timeoutSeconds=2&peek=true&afterId=${cursor.id}`, {
      headers: { authorization: `Bearer ${b.key}` },
    });
    const { messages } = (await restRes.json()) as { messages: Array<{ body: string }> };
    expect(messages.some((m) => m.body === "rest-fresh")).toBe(true);
    await client.close();
  });
});

describe("get_awareness since parity (MCP ↔ REST)", () => {
  it("MCP get_awareness(since) matches REST GET /v1/awareness?since=", async () => {
    const { orgId, a, b } = setupPair();
    setAgentStatus(orgId, a.id, "baseline", []);
    const baseline = getAwareness(orgId, b.id).cursor;

    await sendMessage(orgId, { id: a.id, name: a.name }, "Agent B", "after baseline", "high");

    const client = await connect(b.key);
    const mcpText = text(await client.callTool({ name: "get_awareness", arguments: { since: baseline } }));
    expect(mcpText).toMatch(/OpenCadre awareness/);
    expect(mcpText).toContain("Agent A sent you a message");

    const restRes = await fetch(`${restBaseUrl}/v1/awareness?since=${baseline}`, {
      headers: { authorization: `Bearer ${b.key}` },
    });
    const restBody = (await restRes.json()) as { text: string };
    expect(restBody.text).toContain("Agent A sent you a message");
    await client.close();
  });
});

describe("wait_for_timeline parity (MCP ↔ REST)", () => {
  it("MCP wait_for_timeline matches REST GET /v1/events/wait", async () => {
    const { orgId, a } = setupPair();
    const client = await connect(a.key);

    const cursorRes = await fetch(`${restBaseUrl}/v1/events`, { headers: { authorization: `Bearer ${a.key}` } });
    const { nextAfter } = (await cursorRes.json()) as { nextAfter: number };

    const mcpWait = client.callTool({ name: "wait_for_timeline", arguments: { after: nextAfter, timeoutSeconds: 3 } });
    const restWait = fetch(`${restBaseUrl}/v1/events/wait?after=${nextAfter}&timeoutSeconds=3`, {
      headers: { authorization: `Bearer ${a.key}` },
    });

    await new Promise((r) => setTimeout(r, 100));
    recordDecision(orgId, { id: a.id, name: a.name }, { title: "Parity test decision", scope: "tests" });

    const mcpText = text(await mcpWait);
    const restBody = (await restWait) as Response;
    const restJson = (await restBody.json()) as { events: Array<{ type: string }> };

    expect(mcpText).toContain("decision.recorded");
    expect(restJson.events.some((e) => e.type === "decision.recorded")).toBe(true);
    await client.close();
  });
});

describe("search_messages parity (MCP ↔ REST)", () => {
  it("MCP search_messages finds a read message, and REST GET /v1/messages/search matches", async () => {
    const { orgId, a, b } = setupPair();
    await sendMessage(orgId, { id: a.id, name: a.name }, "Agent B", "the migration is blocked");
    // Consume it first: this is the case get_messages can no longer serve.
    expect(getMessages(orgId, b.id)).toHaveLength(1);

    const client = await connect(b.key);
    const mcpText = text(await client.callTool({ name: "search_messages", arguments: { query: "migration" } }));
    expect(mcpText).toContain("the migration is blocked");

    const restRes = await fetch(`${restBaseUrl}/v1/messages/search?q=migration`, {
      headers: { authorization: `Bearer ${b.key}` },
    });
    expect(restRes.status).toBe(200);
    const { messages } = (await restRes.json()) as { messages: Array<{ body: string }> };
    expect(messages.map((m) => m.body)).toEqual(["the migration is blocked"]);
    await client.close();
  });

  it("GET /v1/messages/search is not swallowed by the /:threadId route", async () => {
    const { b } = setupPair();
    // If the literal route were registered after /v1/messages/:threadId/status, Express would treat
    // "search" as a threadId and this would be a 404. It must be 200 (with an empty result).
    const res = await fetch(`${restBaseUrl}/v1/messages/search?q=nothing`, {
      headers: { authorization: `Bearer ${b.key}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });

  it("rejects an MCP search with no filter, so it cannot dump the whole history", async () => {
    const { b } = setupPair();
    const client = await connect(b.key);
    const mcpText = text(await client.callTool({ name: "search_messages", arguments: {} }));
    expect(mcpText).toMatch(/give at least one/i);
    await client.close();
  });
});

describe("search_messages parity (MCP <-> REST)", () => {
  it("MCP search_messages returns the same matches as REST GET /v1/messages/search", async () => {
    const { orgId, a, b } = setupPair();
    await sendMessage(orgId, { id: a.id, name: a.name }, "Agent B", "the rollback plan is in the wiki");
    // Consume it, so this is a case only search can answer.
    getMessages(orgId, b.id);

    const client = await connect(b.key);
    const mcpText = text(await client.callTool({ name: "search_messages", arguments: { query: "rollback" } }));
    expect(mcpText).toContain("rollback plan");

    const restRes = await fetch(`${restBaseUrl}/v1/messages/search?q=rollback`, {
      headers: { authorization: `Bearer ${b.key}` },
    });
    expect(restRes.status).toBe(200);
    const { messages } = (await restRes.json()) as { messages: Array<{ body: string }> };
    expect(messages.map((m) => m.body)).toEqual(["the rollback plan is in the wiki"]);
    await client.close();
  });

  it("REST GET /v1/messages/search is not shadowed by GET /v1/messages/:threadId/status", async () => {
    const { b } = setupPair();
    // Without the literal route registered first, "search" would be read as a threadId and 404.
    const res = await fetch(`${restBaseUrl}/v1/messages/search?q=anything`, {
      headers: { authorization: `Bearer ${b.key}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("messages");
  });

  it("search_messages refuses an empty filter set instead of returning the whole history", async () => {
    const { a } = setupPair();
    const client = await connect(a.key);
    const out = text(await client.callTool({ name: "search_messages", arguments: {} }));
    expect(out).toMatch(/at least one of query, from or threadId/);
    await client.close();
  });
});

describe("register_webhook auth header parity (MCP ↔ REST)", () => {
  it("MCP register_webhook refuses the header REST POST /v1/webhook refuses, with the same error, and stores nothing", async () => {
    const { a } = setupPair();
    const url = "https://hooks.example.com/opencadre";
    const stored = () => db.prepare(`SELECT webhook_url, webhook_auth_header FROM agents WHERE id = ?`).get(a.id);
    const client = await connect(a.key);
    for (const authHeader of ["Bearer a\r\nX-Injected: 1", "Bearer a\u0000", "Bearer\ta", `Bearer ${"a".repeat(2042)}`]) {
      const rest = await fetch(`${restBaseUrl}/v1/webhook`, {
        method: "POST", headers: { authorization: `Bearer ${a.key}`, "content-type": "application/json" }, body: JSON.stringify({ url, authHeader }),
      });
      expect(rest.status).toBe(400);
      const { error } = (await rest.json()) as { error: string };
      expect(error).toMatch(/control characters/);
      expect(text(await client.callTool({ name: "register_webhook", arguments: { url, authHeader } }))).toBe(`Error: ${error}`);
      expect(stored()).toEqual({ webhook_url: null, webhook_auth_header: null });
    }
    const longest = `Bearer ${"a".repeat(2041)}`;
    expect(text(await client.callTool({ name: "register_webhook", arguments: { url, authHeader: longest } }))).toBe(`Webhook registered: ${url}`);
    expect(stored()).toEqual({ webhook_url: url, webhook_auth_header: longest });
    await client.close();
  });
});
