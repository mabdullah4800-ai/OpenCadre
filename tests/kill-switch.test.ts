import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { authenticateAgentKey, isPausedWorkspaceKey } from "../src/auth.js";
import { registerSocket } from "../src/live.js";
import { heldRequestCount } from "../src/revocation.js";
import { PAUSED_SOCKET_CODE } from "../src/kill-switch.js";
import { createOrganization, registerAgent, sendMessage } from "../src/service.js";
import { listEvents } from "../src/events.js";

/** R3: one operator action stops every agent in the workspace within 5 s; resume restores the same keys. */
const BUDGET_MS = 5000;

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
    const apiKey = new URL(req.url ?? "", "http://localhost").searchParams.get("apiKey") ?? undefined;
    const authed = authenticateAgentKey(apiKey);
    if (!authed) return void ws.close(isPausedWorkspaceKey(apiKey) ? PAUSED_SOCKET_CODE : 4001, "refused");
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
  const reviewer = registerAgent(orgId, "Reviewer");
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  return {
    orgId,
    coder: { id: coder.agentId, name: "Coder", key: coder.apiKey },
    reviewer: { id: reviewer.agentId, name: "Reviewer", key: reviewer.apiKey },
    operator: { id: operator.agentId, name: "Operator", key: operator.apiKey },
  };
}

const call = (method: string, path: string, key: string) =>
  fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}` } });

async function openSocket(key: string) {
  const ws = new WebSocket(`${wsBase}/live?apiKey=${key}`);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("workspace kill switch", () => {
  it("stops every agent within 5 s: sockets close, waits end, new calls are refused; operators keep access", async () => {
    const w = workspace("Kill Switch Pause");
    const sockets = [await openSocket(w.coder.key), await openSocket(w.reviewer.key)];
    const closed = sockets.map((ws) => new Promise<number>((resolve) => ws.once("close", (code) => resolve(code))));
    const waits = [
      call("GET", "/v1/messages/wait?timeoutSeconds=60", w.coder.key),
      call("GET", "/v1/messages/wait?timeoutSeconds=60", w.reviewer.key),
    ];
    await until(() => heldRequestCount(w.coder.id) === 1 && heldRequestCount(w.reviewer.id) === 1, "both waits to be held");

    const started = Date.now();
    const paused = await call("POST", "/v1/org/pause", w.operator.key);
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ paused: true, pausedBy: "Operator", changed: true, agentsCutOff: 2, requestsEnded: 2 });

    expect(await Promise.all(closed)).toEqual([PAUSED_SOCKET_CODE, PAUSED_SOCKET_CODE]);
    const ended = await Promise.all(waits);
    expect(ended.map((r) => r.status)).toEqual([423, 423]);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);

    // New calls on every surface are refused with a reason, not a misleading "invalid key".
    const refused = await call("GET", "/v1/me", w.coder.key);
    expect(refused.status).toBe(423);
    expect(((await refused.json()) as { error: string }).error).toContain("paused by an operator");
    const lateSocket = new WebSocket(`${wsBase}/live?apiKey=${w.coder.key}`);
    expect(await new Promise<number>((resolve) => lateSocket.once("close", (code) => resolve(code)))).toBe(PAUSED_SOCKET_CODE);
    const mcp = new Client({ name: "kill-switch-test", version: "0.0.0" });
    await expect(mcp.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${w.coder.key}` } } })))
      .rejects.toThrow(/423|paused/i);

    // The operator still sees the workspace and can message the paused agents' inboxes.
    const me = await call("GET", "/v1/me", w.operator.key);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { workspace: { paused: boolean } }).workspace.paused).toBe(true);
    expect((await sendMessage(w.orgId, w.operator, "Coder", "read this when you're back")).ok).toBe(true);

    // Waiters behind the ended requests resolve into silenced responses without throwing.
    await new Promise((r) => setTimeout(r, 150));
  });

  it("resuming restores the same keys, and each change is on the timeline once", async () => {
    const w = workspace("Kill Switch Resume");
    await call("POST", "/v1/org/pause", w.operator.key);
    const again = await call("POST", "/v1/org/pause", w.operator.key);
    expect(await again.json()).toMatchObject({ paused: true, changed: false, agentsCutOff: 0 });

    const resumed = await call("POST", "/v1/org/resume", w.operator.key);
    expect(await resumed.json()).toMatchObject({ paused: false, pausedAt: null, changed: true });
    expect((await call("GET", "/v1/me", w.coder.key)).status).toBe(200);
    const socket = await openSocket(w.coder.key);
    socket.close();
    expect(((await (await call("POST", "/v1/org/resume", w.operator.key)).json()) as { changed: boolean }).changed).toBe(false);

    const changes = listEvents(w.orgId).filter((e) => e.type.startsWith("workspace.")).map((e) => [e.type, e.actor_agent_name]);
    expect(changes).toEqual([["workspace.paused", "Operator"], ["workspace.resumed", "Operator"]]);
  });

  it("adds no agents while paused: bootstrap registration and connect codes are refused, and the code stays usable", async () => {
    const { orgId, bootstrapKey } = createOrganization("Kill Switch Provisioning");
    const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
    const created = await fetch(`${base}/v1/connect-codes`, {
      method: "POST", headers: { authorization: `Bearer ${operator.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ agentName: "Late-Agent", client: "cursor" }),
    });
    const { code } = (await created.json()) as { code: string };
    await call("POST", "/v1/org/pause", operator.apiKey);

    const register = await fetch(`${base}/v1/agents`, {
      method: "POST", headers: { authorization: `Bearer ${bootstrapKey}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Sneaky" }),
    });
    expect(register.status).toBe(423);
    const redeem = () => fetch(`${base}/v1/connect/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const refused = await redeem();
    expect(refused.status).toBe(423);
    expect(((await refused.json()) as { error: string }).error).toContain("paused by an operator");

    await call("POST", "/v1/org/resume", operator.apiKey);
    expect((await redeem()).status).toBe(201);
  });

  it("only an operator can pause or resume", async () => {
    const w = workspace("Kill Switch Roles");
    expect((await call("POST", "/v1/org/pause", w.coder.key)).status).toBe(403);
    expect((await call("POST", "/v1/org/resume", w.coder.key)).status).toBe(403);
    expect((await call("GET", "/v1/me", w.reviewer.key)).status).toBe(200);
  });

  it("an unknown key is still a plain 401, never a pause notice", async () => {
    expect(isPausedWorkspaceKey("agt_not_a_real_key")).toBe(false);
    expect((await call("GET", "/v1/me", "agt_not_a_real_key")).status).toBe(401);
  });
});
