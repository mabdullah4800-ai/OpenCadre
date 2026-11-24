import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest, sweepIdleMcpSessions } from "../src/mcp.js";
import { createOrganization, registerAgent } from "../src/service.js";

// Same routing as src/index.ts: MCP bypasses Express and parses its own body.
let server: http.Server;
let mcpUrl: URL;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  mcpUrl = new URL(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/mcp`);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function setupOrg(name = "MCP Session Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return { orgId, a, b };
}

/** A raw JSON-RPC POST, bypassing the SDK client entirely -- for controlling headers precisely
 * (a specific mcp-session-id, a mismatched bearer token) that the real Client wouldn't let us send. */
async function rawPost(apiKey: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), body: text };
}

async function rawDelete(apiKey: string, sessionId: string) {
  const res = await fetch(mcpUrl, {
    method: "DELETE",
    headers: { authorization: `Bearer ${apiKey}`, "mcp-session-id": sessionId },
  });
  return { status: res.status };
}

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

describe("MCP session reuse", () => {
  it("a real SDK client connects once and makes multiple tool calls over the same session", async () => {
    const { orgId, a } = setupOrg();
    const client = new Client({ name: "session-reuse-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${a.apiKey}` } } }));

    const first = await client.callTool({ name: "get_active_agents", arguments: {} });
    const second = await client.callTool({ name: "get_active_agents", arguments: {} });
    expect((first as { content: unknown[] }).content).toBeDefined();
    expect((second as { content: unknown[] }).content).toBeDefined();
    void orgId;
    await client.close();
  });

  // A real finding while writing this test: the SDK client's plain close() does NOT send the DELETE
  // termination request -- it only aborts the local connection and fires the client-side onclose
  // callback (confirmed by reading @modelcontextprotocol/sdk/client/streamableHttp.js: close() has
  // no call to terminateSession()). A client must call transport.terminateSession() explicitly to
  // notify the server. Most real clients likely never do, which is exactly why the idle sweep
  // (sweepIdleMcpSessions) is the actual, load-bearing cleanup mechanism -- DELETE support is a
  // genuine improvement for the clients that DO call it, not a replacement for the sweep.
  it("the SDK client's explicit terminateSession() reaches the server and actually tears the session down", async () => {
    const { a } = setupOrg();
    const transport = new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${a.apiKey}` } } });
    const client = new Client({ name: "session-reuse-test", version: "0.0.0" });
    await client.connect(transport);
    await client.callTool({ name: "get_active_agents", arguments: {} });

    const sessionId = transport.sessionId;
    expect(sessionId).toBeTruthy();
    await transport.terminateSession();

    const afterTerminate = await rawPost(a.apiKey, { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }, { "mcp-session-id": sessionId! });
    expect(afterTerminate.status).toBe(404);
  });

  it("a plain close() (no explicit terminateSession()) leaves the session for the idle sweep, as documented -- it is not itself torn down", async () => {
    const { a } = setupOrg();
    const transport = new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${a.apiKey}` } } });
    const client = new Client({ name: "session-reuse-test", version: "0.0.0" });
    await client.connect(transport);
    await client.callTool({ name: "get_active_agents", arguments: {} });
    const sessionId = transport.sessionId;
    await client.close();

    const stillThere = await rawPost(a.apiKey, { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }, { "mcp-session-id": sessionId! });
    expect(stillThere.status).toBe(200); // still live -- close() alone never told the server
    sweepIdleMcpSessions(Date.now() + 31 * 60 * 1000); // clean it up so it doesn't linger past this test
  });

  it("initialize mints a real mcp-session-id, and a later request reusing it succeeds without re-initializing", async () => {
    const { a } = setupOrg();
    const init = await rawPost(a.apiKey, INITIALIZE);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const listed = await rawPost(a.apiKey, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": init.sessionId! });
    expect(listed.status).toBe(200);
    expect(listed.body).toContain("get_active_agents");
  });

  it("rejects a session id whose bearer token belongs to a different agent -- a session id is not a credential", async () => {
    const { a, b } = setupOrg();
    const init = await rawPost(a.apiKey, INITIALIZE);
    expect(init.sessionId).toBeTruthy();

    const hijacked = await rawPost(b.apiKey, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": init.sessionId! });
    expect(hijacked.status).toBe(401);
  });

  it("rejects a session id whose bearer token belongs to a different ORG entirely", async () => {
    const one = setupOrg("Session Isolation Org One");
    const two = setupOrg("Session Isolation Org Two");
    const init = await rawPost(one.a.apiKey, INITIALIZE);
    expect(init.sessionId).toBeTruthy();

    const crossOrg = await rawPost(two.a.apiKey, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": init.sessionId! });
    expect(crossOrg.status).toBe(401);
  });

  it("an unrecognized or expired session id is a 404, not a silent fallback to a fresh server", async () => {
    const { a } = setupOrg();
    const res = await rawPost(a.apiKey, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "mcp-session-id": "not-a-real-session-id" });
    expect(res.status).toBe(404);
  });

  it("sweepIdleMcpSessions evicts a session past the idle timeout, and it then reads back as gone (404)", async () => {
    const { a } = setupOrg();
    const init = await rawPost(a.apiKey, INITIALIZE);
    expect(init.sessionId).toBeTruthy();

    // Confirm it's live before sweeping.
    const beforeSweep = await rawPost(a.apiKey, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": init.sessionId! });
    expect(beforeSweep.status).toBe(200);

    const closed = sweepIdleMcpSessions(Date.now() + 31 * 60 * 1000); // past the 30-minute idle window
    expect(closed).toBeGreaterThanOrEqual(1);

    const afterSweep = await rawPost(a.apiKey, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, { "mcp-session-id": init.sessionId! });
    expect(afterSweep.status).toBe(404);
  });

  it("sweepIdleMcpSessions leaves a recently-used session alone", async () => {
    const { a } = setupOrg();
    const init = await rawPost(a.apiKey, INITIALIZE);
    sweepIdleMcpSessions(Date.now()); // "now" -- nothing is idle yet
    const stillThere = await rawPost(a.apiKey, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": init.sessionId! });
    expect(stillThere.status).toBe(200);
  });

  it("a bare tools/call with no session id and no initialize (our own bridge scripts' pattern) still works, unchanged", async () => {
    const { a } = setupOrg();
    const res = await rawPost(a.apiKey, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_active_agents", arguments: {} } });
    expect(res.status).toBe(200);
    expect(res.sessionId).toBeNull(); // no session negotiated -- exactly the old one-shot behavior
  });

  it("DELETE explicitly terminates a session -- it's gone at once, not just eventually via the idle sweep", async () => {
    const { a } = setupOrg();
    const init = await rawPost(a.apiKey, INITIALIZE);
    expect(init.sessionId).toBeTruthy();

    const del = await rawDelete(a.apiKey, init.sessionId!);
    expect(del.status).toBe(200);

    const afterDelete = await rawPost(a.apiKey, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": init.sessionId! });
    expect(afterDelete.status).toBe(404); // gone immediately, no 30-minute wait
  });

  it("DELETE with someone else's session id is refused, same identity check as reusing it", async () => {
    const { a, b } = setupOrg();
    const init = await rawPost(a.apiKey, INITIALIZE);
    expect(init.sessionId).toBeTruthy();

    const hijackedDelete = await rawDelete(b.apiKey, init.sessionId!);
    expect(hijackedDelete.status).toBe(401);

    // Untouched: a's session is still live after the refused attempt.
    const stillThere = await rawPost(a.apiKey, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": init.sessionId! });
    expect(stillThere.status).toBe(200);
  });
});
