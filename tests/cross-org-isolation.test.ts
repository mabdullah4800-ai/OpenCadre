import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { authenticateAgentKey } from "../src/auth.js";
import { registerSocket } from "../src/live.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent, sendMessage, setAgentCapabilities, shareFile, heartbeat } from "../src/service.js";
import { acceptTask, claimTask, completeTask, createTask } from "../src/tasks.js";
import { createMemory } from "../src/memory.js";
import { setGoal } from "../src/goals.js";
import { requestApproval, decideApproval } from "../src/approvals.js";
import { emitEvent, listEvents } from "../src/events.js";
import { setClearancePolicy } from "../src/clearance-policy.js";
import { assignPlan } from "../src/billing.js";
import { setProjectEnabled } from "../src/projects.js";
import { effectiveWipCap } from "../src/project-settings.js";
import { signInPerson } from "./helpers/person.js";

/** Every route the REST app serves, read from the Express router itself, so a new route of any
 * kind (agent, operator, admin, public) fails the coverage test until it gets an isolation case
 * below or a stated reason why workspace isolation doesn't apply. */
type RouterLayer = { route?: { path: string; methods: Record<string, boolean> } };
const ROUTES = ((app as unknown as { router: { stack: RouterLayer[] } }).router.stack)
  .flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`) : []));

/** Routes with an isolation case in this file. */
const COVERED = new Set([
  "POST /v1/org/agents/:agentId/rotate-key",
  "DELETE /v1/org/agents/:agentId",
  "GET /v1/org/agents/:agentId/webhook",
  "PUT /v1/org/agents/:agentId/webhook",
  "POST /v1/org/agents/:agentId/webhook/test",
  "GET /v1/connect-codes/:code/status",
  "GET /v1/agents",
  "POST /v1/messages",
  "POST /v1/questions",
  "GET /v1/messages",
  "GET /v1/messages/search",
  "GET /v1/messages/wait",
  "POST /v1/messages/consume",
  "POST /v1/messages/:threadId/reply",
  "GET /v1/messages/:threadId/status",
  "GET /v1/events",
  "GET /v1/events/wait",
  "GET /v1/awareness",
  "GET /v1/deliveries",
  "POST /v1/events/:seq/ack",
  "POST /v1/files/share",
  "GET /v1/files/:fileId",
  "GET /v1/tasks",
  "GET /v1/tasks/:taskId",
  "GET /v1/goal",
  "POST /v1/tasks/:taskId/claim",
  "POST /v1/tasks/:taskId/lane",
  "POST /v1/tasks/:taskId/renew",
  "POST /v1/tasks/:taskId/release",
  "POST /v1/tasks/:taskId/complete",
  "POST /v1/tasks/:taskId/accept",
  "POST /v1/tasks/:taskId/reject",
  "POST /v1/tasks/:taskId/supersede",
  "POST /v1/approvals",
  "GET /v1/approvals",
  "GET /v1/approvals/:approvalId",
  "GET /v1/approvals/:approvalId/wait",
  "POST /v1/approvals/:approvalId/decide",
  "POST /v1/approvals/:approvalId/withdraw",
  "GET /v1/approval-grants",
  "DELETE /v1/approval-grants/:grantId",
  "GET /v1/clearance-policy",
  "GET /v1/clearance-policies",
  "PUT /v1/clearance-policy",
  "DELETE /v1/clearance-policy",
  "POST /v1/clearances/executed",
  "POST /v1/clearances/policy-pass",
  "POST /v1/org/pause",
  "POST /v1/org/resume",
  "GET /v1/workspaces/:orgId/members",
  "POST /v1/workspaces/:orgId/invites",
  "DELETE /v1/workspaces/:orgId/invites/:inviteId",
  "PATCH /v1/workspaces/:orgId/members/:personId",
  "DELETE /v1/workspaces/:orgId/members/:personId",
  "GET /v1/onboarding",
  "GET /v1/org/devices",
  "DELETE /v1/org/devices/:deviceId",
  "POST /v1/sessions/join",
  "POST /v1/sessions/leave",
  "GET /v1/org/sessions",
  "GET /v1/org/usage",
  "PATCH /v1/org/sessions/:agentId",
  "POST /v1/org/sessions/:agentId/keep-name",
  "POST /v1/devices/tools",
  "POST /v1/devices/connector-build",
  "PUT /v1/devices/projects/enable-current",
  "GET /v1/devices/projects",
  "GET /v1/devices/me",
  "GET /v1/org/projects",
  "PUT /v1/org/projects",
  "GET /v1/org/projects/:key/settings",
  "PUT /v1/org/projects/:key/settings",
  "GET /v1/memory",
  "GET /v1/memory/search",
  "GET /v1/memory/:id",
  "POST /v1/memory/:id/archive",
  "POST /v1/memory/:id/supersede",
  "POST /v1/resources/claim",
  "POST /v1/resources/renew",
  "POST /v1/resources/release",
  "GET /v1/resources",
  "POST /v1/facts",
  "GET /v1/facts",
  "GET /v1/facts/one",
  "POST /v1/facts/delete",
  "GET /v1/reliability",
  "GET /v1/reliability/all",
  "GET /v1/task-shape-stats",
]);

/** Routes where cross-workspace isolation doesn't apply, with the reason. */
const EXEMPT: Record<string, string> = {
  "POST /v1/orgs": "platform admin token creates a new workspace; reads no tenant data",
  "POST /v1/agents": "authenticated by the workspace's own bootstrap key; creates only in that workspace",
  "POST /v1/org/agents": "operator creates an agent in their own workspace; no workspace or resource id in the request",
  "POST /v1/connect-codes": "operator creates a code in their own workspace; no resource id in the request",
  "POST /v1/org/devices": "operator adds a device to their own workspace; no resource id in the request",
  "POST /v1/connect/redeem": "unauthenticated by design: the single-use code is the credential and names its workspace",
  "POST /v1/heartbeat": "acts only on the calling agent",
  "POST /v1/webhook": "acts only on the calling agent",
  "POST /v1/status": "acts only on the calling agent",
  "POST /v1/capabilities": "acts only on the calling agent",
  "GET /v1/capabilities": "reads only the calling agent's own capabilities",
  "POST /v1/round-budget": "acts only on the calling agent",
  "GET /v1/round-budget": "reads only the calling agent's own round budget",
  "POST /v1/usage": "acts only on the calling agent",
  "GET /v1/me": "reads only the calling agent",
  "POST /v1/decisions": "writes into the caller's workspace; takes no resource id",
  "POST /v1/tasks": "writes into the caller's workspace; takes no resource id",
  "POST /v1/memory": "writes into the caller's workspace; takes no resource id",
  "POST /v1/goal": "writes into the caller's workspace; takes no resource id",
  "GET /cli/opencadre-cli.tgz": "public CLI download",
  "GET /cli/manifest.json": "public CLI build identity: hashes and the package address, no tenant data or credential",
  "GET /cli/:stamp/opencadre-cli.tgz": "public CLI download at its content-addressed path; no tenant data",
  "GET /": "redirects to the console at /app/; no tenant data",
  "GET /health": "public liveness; no tenant data",
  "GET /v1/billing/client-config": "says whether this hub offers a checkout (always no here); no tenant data",
  "GET /favicon.ico": "public brand icon; no tenant data",
  "GET /v1/metrics": "metrics/admin token only; aggregate counts, no tenant data",
  "GET /v1/auth/config": "public; says which sign-in methods are on, no tenant data",
  "GET /.well-known/oauth-protected-resource/mcp": "public OAuth metadata (RFC 9728); names the hub, no tenant data",
  "GET /.well-known/oauth-protected-resource": "public OAuth metadata (RFC 9728); names the hub, no tenant data",
  "GET /.well-known/oauth-authorization-server": "public OAuth metadata (RFC 8414); names the hub's endpoints, no tenant data",
  "GET /oauth/authorize": "validates a client's request and shows the SIGNED-IN person's own consent page; it lists only workspaces that person may add agents to and takes no workspace id (tests/oauth-authorize-route.test.ts)",
  "POST /oauth/authorize": "answers the signed-in person's own consent (hash-keyed, CSRF bound to their session); the chosen workspace is re-checked against their LIVE membership and role before anything is created (tests/oauth-authorize-route.test.ts, tests/oauth-grants.test.ts)",
  "POST /oauth/token": "public OAuth token endpoint; the code or refresh token presented is the credential and names its own workspace and agent (tests/oauth-token.test.ts)",
  "POST /oauth/revoke": "public OAuth revocation (RFC 7009); revokes only the family of the token presented, which is its own credential (tests/oauth-revoke.test.ts)",
  "POST /oauth/register": "public OAuth client registration (RFC 7591); creates a client row that belongs to no workspace and reads no tenant data (tests/oauth-authorization.test.ts)",
  "GET /v1/auth/start": "public; starts a sign-in, no tenant data",
  "POST /v1/auth/email": "public; sends a sign-in link, no tenant data",
  "GET /v1/auth/callback": "public; finishes a sign-in for the person the provider vouched for",
  "POST /v1/auth/signout": "ends only the caller's own session",
  "GET /v1/auth/me": "lists only the signed-in person's own memberships (tests/accounts.test.ts)",
  "POST /v1/workspaces": "creates a new workspace; takes no workspace id",
  "GET /v1/invites/:token": "the single-use invite token is the credential and names its workspace (tests/accounts.test.ts)",
  "POST /v1/invites/:token/accept": "the single-use invite token is the credential and names its workspace (tests/accounts.test.ts)",
  "GET /v1/push/config": "public; only the hub's VAPID public key, no tenant data",
  "GET /v1/push/devices": "lists only the signed-in person's own devices (tests/push.test.ts)",
  "POST /v1/push/devices": "adds a device to the signed-in person only; no workspace is involved (tests/push.test.ts)",
  "DELETE /v1/push/devices": "removes only the caller's own device; another person's endpoint is a 404 (tests/push.test.ts)",
  "POST /v1/push/test": "notifies only the caller's own devices (tests/push.test.ts)",
  "GET /v1/org/project-links": "operator lists only their own workspace's links (tests/project-isolation.test.ts)",
  "POST /v1/org/project-links": "operator links projects of their own workspace; another workspace's project key is a 404 (tests/project-isolation.test.ts)",
  "DELETE /v1/org/project-links": "operator unlinks projects of their own workspace; another workspace's project key is a 404 (tests/project-isolation.test.ts)",
  "GET /v1/org/project-isolation": "operator reads only their own workspace's setting (tests/project-isolation.test.ts)",
  "PUT /v1/org/project-isolation": "operator switches only their own workspace's setting; takes no workspace id (tests/project-isolation.test.ts)",
};

let restServer: ReturnType<typeof app.listen>;
let restBaseUrl: string;
let wsBaseUrl: string;
let mcpServer: http.Server;
let mcpUrl: URL;

beforeAll(async () => {
  restServer = app.listen(0);
  await new Promise((r) => restServer.once("listening", r));
  const port = (restServer.address() as AddressInfo).port;
  restBaseUrl = `http://127.0.0.1:${port}`;
  wsBaseUrl = `ws://127.0.0.1:${port}`;

  // Mirrors the /live wiring in src/index.ts (an entrypoint script, not importable):
  // authenticate by ?apiKey= query param, then register the socket under the caller's agentId.
  const wss = new WebSocketServer({ server: restServer, path: "/live" });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const authed = authenticateAgentKey(url.searchParams.get("apiKey") ?? undefined);
    if (!authed) return void ws.close(4001, "invalid api key");
    registerSocket(authed.agentId, ws);
    heartbeat(authed.orgId, authed.agentId);
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

function setupTwoOrgs() {
  const orgA = createOrganization("Isolation Org A");
  const orgB = createOrganization("Isolation Org B");
  const a1 = registerAgent(orgA.orgId, "A-One");
  const a2 = registerAgent(orgA.orgId, "A-Two");
  const aOp = registerAgent(orgA.orgId, "Operator", { role: "operator", system: true });
  const b1 = registerAgent(orgB.orgId, "B-One");
  const bOp = registerAgent(orgB.orgId, "Operator", { role: "operator", system: true });
  return {
    orgA: orgA.orgId, orgB: orgB.orgId,
    a1: { id: a1.agentId, name: "A-One", key: a1.apiKey },
    a2: { id: a2.agentId, name: "A-Two", key: a2.apiKey },
    aOp: { id: aOp.agentId, name: "Operator", key: aOp.apiKey },
    b1: { id: b1.agentId, name: "B-One", key: b1.apiKey },
    bOp: { id: bOp.agentId, name: "Operator", key: bOp.apiKey },
  };
}

async function call(method: string, path: string, key: string, body?: unknown) {
  return fetch(`${restBaseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const unreadFor = (agentId: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE to_agent_id = ? AND read_at IS NULL`).get(agentId) as { n: number }).n;

describe("coverage: every route has an isolation case or a stated exemption", () => {
  it("reads a realistic route list from the router", () => {
    expect(ROUTES).toContain("GET /v1/files/:fileId");
    expect(ROUTES.length).toBeGreaterThan(50);
  });

  it("no route is silently uncovered", () => {
    const missing = ROUTES.filter((r) => !COVERED.has(r) && !EXEMPT[r]);
    expect(missing, `add an isolation test (or an EXEMPT reason) for: ${missing.join(", ")}`).toEqual([]);
  });

  it("the lists name only routes that exist, and no route is both covered and exempt", () => {
    const known = new Set(ROUTES);
    expect([...COVERED, ...Object.keys(EXEMPT)].filter((r) => !known.has(r))).toEqual([]);
    expect([...COVERED].filter((r) => EXEMPT[r])).toEqual([]);
  });
});

describe("messages", () => {
  it("org B can't reply into org A's thread", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();
    const sent = await sendMessage(orgA, { id: a1.id, name: a1.name }, a2.name, "hello");
    if (!sent.ok) throw new Error("setup failed");

    const res = await call("POST", `/v1/messages/${sent.threadId}/reply`, b1.key, { body: "nope" });
    expect(res.status).toBe(404);
  });

  it("org B never sees org A's messages via GET /v1/messages", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();
    await sendMessage(orgA, { id: a1.id, name: a1.name }, a2.name, "org A only");

    const res = await call("GET", "/v1/messages?peek=true", b1.key);
    const { messages } = (await res.json()) as { messages: Array<{ body: string }> };
    expect(messages.some((m) => m.body === "org A only")).toBe(false);
  });

  it("org B cannot search org A's mail while a party can", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();
    const canary = "private cross-org search canary";
    await sendMessage(orgA, { id: a1.id, name: a1.name }, a2.name, canary);
    const search = async (key: string) => {
      const res = await call("GET", "/v1/messages/search?q=cross-org%20search", key);
      expect(res.status).toBe(200);
      return ((await res.json()) as { messages: Array<{ body: string }> }).messages.map((message) => message.body);
    };
    expect(await search(b1.key)).not.toContain(canary);
    expect(await search(a2.key)).toContain(canary);
  });

  it("org B can't send, broadcast or ask a question to an org A agent, even by its exact name or id", async () => {
    const { a1, b1 } = setupTwoOrgs();
    for (const target of [a1.name, a1.id]) {
      expect((await call("POST", "/v1/messages", b1.key, { toAgent: target, body: "cross-org" })).ok).toBe(false);
      // A broadcast answers per recipient: the org A name resolves to nobody.
      const broadcast = (await (await call("POST", "/v1/messages", b1.key, { toAgents: [target], body: "cross-org" })).json()) as { deliveries: Array<{ ok: boolean }> };
      expect(broadcast.deliveries.map((d) => d.ok)).toEqual([false]);
      expect((await call("POST", "/v1/questions", b1.key, { toAgent: target, body: "cross-org?", timeoutSeconds: 1 })).ok).toBe(false);
    }
    expect(unreadFor(a1.id)).toBe(0);
  });

  it("org B's long-poll never returns org A's mail, and can't consume it or read its delivery status", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();
    const sent = await sendMessage(orgA, { id: a1.id, name: a1.name }, a2.name, "org A wait");
    if (!sent.ok) throw new Error("setup failed");
    const [{ id: messageId }] = db.prepare(`SELECT id FROM messages WHERE thread_id = ?`).all(sent.threadId) as Array<{ id: string }>;

    const waited = (await (await call("GET", "/v1/messages/wait?timeoutSeconds=1&peek=true", b1.key)).json()) as { messages: Array<{ body: string }> };
    expect(waited.messages.some((m) => m.body === "org A wait")).toBe(false);

    const consumed = (await (await call("POST", "/v1/messages/consume", b1.key, { messageIds: [messageId] })).json()) as { consumed: number };
    expect(consumed.consumed).toBe(0);
    expect(unreadFor(a2.id)).toBe(1);

    expect((await call("GET", `/v1/messages/${sent.threadId}/status`, b1.key)).status).toBe(404);
  });
});

describe("agents and operator routes", () => {
  it("org B's roster never includes org A's agents", async () => {
    const { b1 } = setupTwoOrgs();
    const res = await call("GET", "/v1/agents", b1.key);
    const { agents } = (await res.json()) as { agents: Array<{ name: string }> };
    expect(agents.some((a) => a.name === "A-One" || a.name === "A-Two")).toBe(false);
  });

  it("org B's operator can't rotate an org A agent's key, which keeps working", async () => {
    const { a1, bOp } = setupTwoOrgs();
    expect((await call("POST", `/v1/org/agents/${a1.id}/rotate-key`, bOp.key)).status).toBe(404);
    expect(authenticateAgentKey(a1.key)?.agentId).toBe(a1.id);
  });

  it("org B's operator can't remove an org A agent, which keeps working and stays on org A's roster", async () => {
    const { a1, a2, bOp } = setupTwoOrgs();
    expect((await call("DELETE", `/v1/org/agents/${a1.id}`, bOp.key)).status).toBe(404);
    expect(authenticateAgentKey(a1.key)?.agentId).toBe(a1.id);
    const { agents } = (await (await call("GET", "/v1/agents", a2.key)).json()) as { agents: Array<{ id: string }> };
    expect(agents.some((a) => a.id === a1.id)).toBe(true);
  });

  it("org B's operator can't read or set an org A agent's wake webhook", async () => {
    const { a1, bOp } = setupTwoOrgs();
    expect((await call("GET", `/v1/org/agents/${a1.id}/webhook`, bOp.key)).status).toBe(404);
    expect((await call("PUT", `/v1/org/agents/${a1.id}/webhook`, bOp.key, { url: "https://hooks.example.com/x" })).status).toBe(404);
    expect((await call("POST", `/v1/org/agents/${a1.id}/webhook/test`, bOp.key, {})).status).toBe(404);
    expect(db.prepare(`SELECT webhook_url FROM agents WHERE id = ?`).get(a1.id)).toEqual({ webhook_url: null });
  });

  it("org B's operator can't see the status of org A's connect code", async () => {
    const { aOp, bOp } = setupTwoOrgs();
    const created = await call("POST", "/v1/connect-codes", aOp.key, { agentName: "New-Agent", client: "claude-code" });
    const { code } = (await created.json()) as { code: string };
    expect((await call("GET", `/v1/connect-codes/${code}/status`, aOp.key)).status).toBe(200);
    expect((await call("GET", `/v1/connect-codes/${code}/status`, bOp.key)).status).toBe(404);
  });
});

describe("devices and sessions", () => {
  const PROJECT = { "x-opencadre-project": "local:IsoRepo", "x-opencadre-project-name": "IsoRepo" };
  async function connectedDevice(operatorKey: string, ip: string, { enable = true } = {}) {
    const minted = (await (await call("POST", "/v1/org/devices", operatorKey, { name: "PC", client: "claude-code" })).json()) as { deviceId: string; code: string };
    const redeemed = await fetch(`${restBaseUrl}/v1/connect/redeem`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ code: minted.code }),
    });
    if (enable) expect((await call("PUT", "/v1/org/projects", operatorKey, { projectKey: PROJECT["x-opencadre-project"], enabled: true })).status).toBe(200);
    return { deviceId: minted.deviceId, credential: ((await redeemed.json()) as { deviceCredential: string }).deviceCredential };
  }
  const asSession = (method: string, path: string, credential: string, seat: { tool: string; host: string }) =>
    fetch(`${restBaseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, "x-opencadre-session": seat.tool, "x-opencadre-host-session": seat.host, ...PROJECT },
    });

  it("org B's device never resolves or ends org A's session, even with the same session ids", async () => {
    const { a1, aOp, bOp } = setupTwoOrgs();
    const deviceA = await connectedDevice(aOp.key, "10.99.0.1");
    const deviceB = await connectedDevice(bOp.key, "10.99.0.2");
    const seat = { tool: "shared-tool-id", host: "shared-host-id" };

    const joinedA = (await (await asSession("POST", "/v1/sessions/join", deviceA.credential, seat)).json()) as { agentId: string; agentName: string };
    const joinedB = (await (await asSession("POST", "/v1/sessions/join", deviceB.credential, seat)).json()) as { agentId: string; agentName: string };
    expect(joinedB.agentId).not.toBe(joinedA.agentId);
    const meB = (await (await asSession("GET", "/v1/me", deviceB.credential, seat)).json()) as { orgId: string; agentId: string };
    expect(meB.agentId).toBe(joinedB.agentId);
    expect(meB.orgId).not.toBe(a1.id);

    // Mail for A's session is invisible to B's, and B's leave doesn't end A's.
    await call("POST", "/v1/messages", a1.key, { toAgent: joinedA.agentName, body: "org A session only" });
    const inboxB = await (await asSession("GET", "/v1/messages?peek=true", deviceB.credential, seat)).text();
    expect(inboxB).not.toContain("org A session only");
    expect(await (await asSession("POST", "/v1/sessions/leave", deviceB.credential, seat)).json()).toEqual({ ok: true, ended: true });
    const liveA = (await (await call("GET", "/v1/org/sessions", aOp.key)).json()) as { sessions: Array<{ agentId: string }> };
    expect(liveA.sessions.map((s) => s.agentId)).toEqual([joinedA.agentId]);
  });

  it("org B's operator can't list, revoke or rename org A's devices and sessions", async () => {
    const { aOp, bOp, orgB } = setupTwoOrgs();
    const deviceA = await connectedDevice(aOp.key, "10.99.0.3");
    const seat = { tool: "a-tool", host: "a-host" };
    const joinedA = (await (await asSession("POST", "/v1/sessions/join", deviceA.credential, seat)).json()) as { agentId: string; agentName: string };

    expect(((await (await call("GET", "/v1/org/devices", bOp.key)).json()) as { devices: unknown[] }).devices).toEqual([]);
    expect(((await (await call("GET", "/v1/org/sessions", bOp.key)).json()) as { sessions: unknown[] }).sessions).toEqual([]);
    expect((await call("DELETE", `/v1/org/devices/${deviceA.deviceId}`, bOp.key)).status).toBe(404);
    // Naming is a signed-in person's act (sessions PR1): any key is refused first, and org B's own person finds nothing.
    expect((await call("PATCH", `/v1/org/sessions/${joinedA.agentId}`, bOp.key, { name: "Hijacked" })).status).toBe(403);
    const personB = await signInPerson(orgB, "Bea");
    const asPersonB = (method: string, path: string, body?: unknown) =>
      fetch(`${restBaseUrl}${path}`, { method, headers: personB.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await asPersonB("PATCH", `/v1/org/sessions/${joinedA.agentId}`, { name: "Hijacked" })).status).toBe(404);
    expect((await asPersonB("POST", `/v1/org/sessions/${joinedA.agentId}/keep-name`)).status).toBe(404);

    // Org A's device and session are untouched.
    expect((await asSession("GET", "/v1/me", deviceA.credential, seat)).status).toBe(200);
    const listed = (await (await call("GET", "/v1/org/sessions", aOp.key)).json()) as { sessions: Array<{ agentName: string }> };
    expect(listed.sessions.map((s) => s.agentName)).toEqual([joinedA.agentName]);
  });

  it("projects: org B's operator can't list, disable or rename org A's project, and enabling a key in B enables it only in B", async () => {
    const { aOp, bOp } = setupTwoOrgs();
    const deviceA = await connectedDevice(aOp.key, "10.99.0.4");
    const seat = { tool: "p-tool", host: "p-host" };
    expect((await asSession("POST", "/v1/sessions/join", deviceA.credential, seat)).status).toBe(201);

    const listB = (await (await call("GET", "/v1/org/projects", bOp.key)).json()) as { projects: unknown[] };
    expect(listB.projects).toEqual([]);
    // Org B doesn't have this project: disabling it is a 404, and org A's session keeps working.
    expect((await call("PUT", "/v1/org/projects", bOp.key, { projectKey: "local:IsoRepo", enabled: false })).status).toBe(404);
    expect((await asSession("GET", "/v1/me", deviceA.credential, seat)).status).toBe(200);
    // Enabling (and renaming) the same key in B creates B's own row; A's row keeps its name.
    expect((await call("PUT", "/v1/org/projects", bOp.key, { projectKey: "local:IsoRepo", enabled: true, name: "Hijacked" })).status).toBe(200);
    const listA = (await (await call("GET", "/v1/org/projects", aOp.key)).json()) as { projects: Array<{ projectKey: string; name: string; sessionCount: number }> };
    expect(listA.projects).toEqual([expect.objectContaining({ projectKey: "local:IsoRepo", name: "IsoRepo", sessionCount: 1 })]);
    const listB2 = (await (await call("GET", "/v1/org/projects", bOp.key)).json()) as { projects: Array<{ name: string; sessionCount: number }> };
    expect(listB2.projects).toEqual([expect.objectContaining({ name: "Hijacked", sessionCount: 0 })]);
  });

  it("a computer's own routes: org B's device records tools and enables projects only in org B", async () => {
    const { aOp, bOp } = setupTwoOrgs();
    const deviceA = await connectedDevice(aOp.key, "10.99.0.5", { enable: false });
    const deviceB = await connectedDevice(bOp.key, "10.99.0.6", { enable: false });
    const seat = { tool: "c-tool", host: "c-host" };

    const tools = await fetch(`${restBaseUrl}/v1/devices/tools`, {
      method: "POST", headers: { authorization: `Bearer ${deviceB.credential}`, "content-type": "application/json" }, body: JSON.stringify({ tools: ["codex"] }),
    });
    expect(tools.status).toBe(200);
    const devicesA = (await (await call("GET", "/v1/org/devices", aOp.key)).json()) as { devices: Array<{ deviceId: string; tools: string[] }> };
    expect(devicesA.devices.find((d) => d.deviceId === deviceA.deviceId)?.tools).toEqual(["claude-code"]);

    const build = { schema: 1, client: "codex", component: "proxy", installationId: "a".repeat(32), bundleId: "123456789abc", integrity: "unknown", helpers: null };
    expect((await call("POST", "/v1/devices/connector-build", deviceB.credential, build)).status).toBe(200);
    const reportsOf = (id: string) => (db.prepare(`SELECT connector_reports FROM devices WHERE id = ?`).get(id) as { connector_reports: string }).connector_reports;
    expect(reportsOf(deviceA.deviceId)).toBe("[]");
    expect(JSON.parse(reportsOf(deviceB.deviceId))).toHaveLength(1);
    expect((await call("POST", "/v1/devices/connector-build", deviceB.credential, { ...build, deviceId: deviceA.deviceId })).status).toBe(400);
    expect(reportsOf(deviceA.deviceId)).toBe("[]");

    const enabled = await fetch(`${restBaseUrl}/v1/devices/projects/enable-current`, { method: "PUT", headers: { authorization: `Bearer ${deviceB.credential}`, ...PROJECT } });
    expect(enabled.status).toBe(200);
    // Still not enabled in org A: its device is refused there and nothing is created.
    const refused = await asSession("POST", "/v1/sessions/join", deviceA.credential, seat);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "project_not_enabled", project: "local:IsoRepo" });
    expect(((await (await call("GET", "/v1/org/sessions", aOp.key)).json()) as { sessions: unknown[] }).sessions).toEqual([]);
    expect((await asSession("POST", "/v1/sessions/join", deviceB.credential, seat)).status).toBe(201);

    // GET /v1/devices/projects lists only the credential's own workspace: B enabled local:IsoRepo, A did not.
    const listOf = async (credential: string) => ((await (await fetch(`${restBaseUrl}/v1/devices/projects`, { headers: { authorization: `Bearer ${credential}` } })).json()) as { projects: string[] }).projects;
    expect(await listOf(deviceB.credential)).toContain("local:IsoRepo");
    expect(await listOf(deviceA.credential)).not.toContain("local:IsoRepo");

    // GET /v1/devices/me names only the credential's own computer.
    const meB = (await (await fetch(`${restBaseUrl}/v1/devices/me`, { headers: { authorization: `Bearer ${deviceB.credential}` } })).json()) as { deviceId: string };
    expect(meB.deviceId).toBe(deviceB.deviceId);
  });

  it("reconnect: org A's credential sent with an org B code never merges into, or takes over, a computer in either workspace", async () => {
    const { aOp, bOp } = setupTwoOrgs();
    const deviceA = await connectedDevice(aOp.key, "10.99.0.7", { enable: false });
    const rowOf = (id: string) => db.prepare(`SELECT org_id, client, tools, credential_hash, merged_into_device_id, revoked_at FROM devices WHERE id = ?`).get(id);
    const aBefore = rowOf(deviceA.deviceId);
    const mintedB = (await (await call("POST", "/v1/org/devices", bOp.key, { name: "B PC" })).json()) as { deviceId: string; code: string };

    const redeemed = await fetch(`${restBaseUrl}/v1/connect/redeem`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.99.0.8" },
      body: JSON.stringify({ code: mintedB.code, currentCredential: deviceA.credential }),
    });
    const body = (await redeemed.json()) as { merged: boolean; deviceId: string; deviceCredential: string | null };
    expect(redeemed.status).toBe(201);
    expect(body.merged).toBe(false);
    expect(body.deviceId).toBe(mintedB.deviceId);
    expect(body.deviceCredential).toMatch(/^dev_[0-9a-f]{48}$/);
    expect(rowOf(mintedB.deviceId)).toMatchObject({ merged_into_device_id: null, credential_hash: expect.any(String) });
    expect(rowOf(deviceA.deviceId)).toEqual(aBefore);
    const devicesB = (await (await call("GET", "/v1/org/devices", bOp.key)).json()) as { devices: Array<{ deviceId: string; status: string }> };
    expect(devicesB.devices.map((d) => [d.deviceId, d.status])).toEqual([[mintedB.deviceId, "connected"]]);
    const devicesA = (await (await call("GET", "/v1/org/devices", aOp.key)).json()) as { devices: Array<{ deviceId: string; status: string }> };
    expect(devicesA.devices.map((d) => [d.deviceId, d.status])).toEqual([[deviceA.deviceId, "connected"]]);
  });
});

describe("events", () => {
  it("org B can't ack an org A event even by guessing a real seq", async () => {
    const { orgA, a1, b1 } = setupTwoOrgs();
    const event = emitEvent({ orgId: orgA, type: "decision.recorded", actor: { id: a1.id, name: a1.name }, subjectType: "decision", subjectId: "x", targetAgentId: a1.id, payload: {} });

    const res = await call("POST", `/v1/events/${event.seq}/ack`, b1.key, { outcome: "acknowledged" });
    expect(res.status).toBe(404);
  });

  it("org B's timeline, timeline wait, awareness and deliveries never include org A's events", async () => {
    const { orgA, a1, b1 } = setupTwoOrgs();
    const secret = "org A secret decision";
    emitEvent({ orgId: orgA, type: "decision.recorded", actor: { id: a1.id, name: a1.name }, subjectType: "decision", subjectId: "y", payload: { title: secret } });
    emitEvent({ orgId: orgA, type: "decision.recorded", actor: { id: a1.id, name: a1.name }, subjectType: "decision", subjectId: "z", targetAgentId: a1.id, payload: { title: secret } });

    for (const path of ["/v1/events", "/v1/events/wait?after=0&timeoutSeconds=1", "/v1/awareness", "/v1/deliveries"]) {
      const res = await call("GET", path, b1.key);
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(await res.json()), path).not.toContain(secret);
    }
  });
});

describe("files", () => {
  it("org B can't download a file shared inside org A", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();
    const shared = await shareFile(orgA, { id: a1.id, name: a1.name }, a2.name, "notes.md", "text/markdown", Buffer.from("org A secret"), "here");
    if (!shared.ok) throw new Error("setup failed");

    const res = await call("GET", `/v1/files/${shared.fileId}`, b1.key);
    expect(res.status).toBe(404);
  });

  it("the owning org can still read its own file (sanity check)", async () => {
    const { orgA, a1, a2 } = setupTwoOrgs();
    const shared = await shareFile(orgA, { id: a1.id, name: a1.name }, a2.name, "notes.md", "text/markdown", Buffer.from("org A secret"), "here");
    if (!shared.ok) throw new Error("setup failed");

    const res = await call("GET", `/v1/files/${shared.fileId}`, a2.key);
    expect(res.status).toBe(200);
  });

  it("org B can't share a file to an org A agent", async () => {
    const { a1, b1 } = setupTwoOrgs();
    const res = await call("POST", "/v1/files/share", b1.key, {
      toAgent: a1.name, filename: "x.md", mimeType: "text/markdown", message: "for you",
      contentBase64: Buffer.from("cross-org").toString("base64"),
    });
    // The share route answers every failure with 400; what matters is that the org A name resolves to nobody.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/No agent found/);
    expect(unreadFor(a1.id)).toBe(0);
  });
});

describe("tasks", () => {
  it("org B can't claim, renew, release, or complete an org A task", async () => {
    const { orgA, a1, b1 } = setupTwoOrgs();
    const task = createTask(orgA, { id: a1.id, name: a1.name }, { title: "org A only task" });

    for (const [method, path] of [
      ["POST", `/v1/tasks/${task.id}/claim`],
      ["POST", `/v1/tasks/${task.id}/renew`],
      ["POST", `/v1/tasks/${task.id}/release`],
      ["POST", `/v1/tasks/${task.id}/complete`],
      ["POST", `/v1/tasks/${task.id}/lane`],
    ] as const) {
      const res = await call(method, path, b1.key);
      expect(res.status, `${method} ${path} should 404 across orgs`).toBe(404);
    }
  });

  it("org B's task list never includes org A's tasks", async () => {
    const { orgA, a1, b1 } = setupTwoOrgs();
    createTask(orgA, { id: a1.id, name: a1.name }, { title: "org A only task" });

    const res = await call("GET", "/v1/tasks", b1.key);
    const { tasks } = (await res.json()) as { tasks: Array<{ title: string }> };
    expect(tasks.some((t) => t.title === "org A only task")).toBe(false);
  });

  it("org B can't accept or reject a done org A task", async () => {
    const { orgA, a1, b1 } = setupTwoOrgs();
    const task = createTask(orgA, { id: a1.id, name: a1.name }, { title: "org A only task" });
    claimTask(orgA, { id: a1.id, name: a1.name }, task.id, 60);
    completeTask(orgA, { id: a1.id, name: a1.name }, task.id, "done");

    for (const [method, path] of [
      ["POST", `/v1/tasks/${task.id}/accept`],
      ["POST", `/v1/tasks/${task.id}/reject`],
    ] as const) {
      const res = await call(method, path, b1.key);
      expect(res.status, `${method} ${path} should 404 across orgs`).toBe(404);
    }

    // Untouched: still done and unreviewed from inside org A.
    const listed = await call("GET", "/v1/tasks?status=done", a1.key);
    const { tasks } = (await listed.json()) as { tasks: Array<{ id: string; reviewed: number }> };
    expect(tasks.find((t) => t.id === task.id)?.reviewed).toBeFalsy();
  });

  // 400, not the 404 its siblings above assert, and the difference is the route's own documented
  // choice rather than a leak: supersede reaches `supersedeTask`, whose org-scoped `getTask` returns
  // nothing across an org boundary, so it throws the TaskInputError the route maps to 400 ("a 400
  // like every other TaskInputError, NOT a 409"). A DENIAL THAT ANSWERS 400 MUST BE PROVEN TO BE ONE
  // — otherwise a later reader sees 400 and reads it as a validation complaint. So this asserts the
  // CONSEQUENCE: org A's row is untouched and the correction did not land in org B. A test that
  // stopped at the status code would pass if the write went through and the error were cosmetic.
  it("org B can't supersede an org A task, and no correction row lands in org B", async () => {
    const { orgA, orgB, a1, b1 } = setupTwoOrgs();
    const task = createTask(orgA, { id: a1.id, name: a1.name }, { title: "org A only task" });

    const res = await call("POST", `/v1/tasks/${task.id}/supersede`, b1.key, { title: "correction from org B" });
    expect(res.status, "POST supersede should be refused across orgs").toBe(400);

    // Org A's row is untouched: no link written.
    expect(
      (db.prepare(`SELECT superseded_by FROM tasks WHERE id = ?`).get(task.id) as { superseded_by: string | null }).superseded_by,
      "org A's task must not be marked superseded by an org B request",
    ).toBeNull();
    // And the correction did not silently materialize inside org B.
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ?`).get(orgB) as { n: number }).n,
      "no correction row may be created in org B",
    ).toBe(0);
  });
});

describe("memory", () => {
  it("org B can't fetch, archive, or supersede an org A memory entry", async () => {
    const { orgA, a1, b1 } = setupTwoOrgs();
    const entry = createMemory(orgA, { id: a1.id, name: a1.name }, { title: "org A only note", body: "cross-org isolation probe" });

    expect((await call("GET", `/v1/memory/${entry.id}`, b1.key)).status).toBe(404);
    expect((await call("POST", `/v1/memory/${entry.id}/archive`, b1.key)).status).toBe(404);
    expect((await call("POST", `/v1/memory/${entry.id}/supersede`, b1.key, { title: "t", body: "b" })).status).toBe(404);
  });

  it("org B's list and search never include org A's memory entries, even with identical text", async () => {
    const { orgA, orgB, a1, b1 } = setupTwoOrgs();
    createMemory(orgA, { id: a1.id, name: a1.name }, { title: "collision title", body: "collision body shared across orgs" });
    createMemory(orgB, { id: b1.id, name: b1.name }, { title: "collision title", body: "collision body shared across orgs" });

    const list = await call("GET", "/v1/memory", b1.key);
    const { entries } = (await list.json()) as { entries: Array<{ body: string; created_by_agent_id: string }> };
    expect(entries.every((e) => e.created_by_agent_id !== a1.id)).toBe(true);

    const search = await call("GET", "/v1/memory/search?q=collision", b1.key);
    const { entries: found } = (await search.json()) as { entries: Array<{ created_by_agent_id: string }> };
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((e) => e.created_by_agent_id !== a1.id)).toBe(true);
  });
});

describe("goal", () => {
  it("org B's goal is never org A's goal", async () => {
    const { orgA, a1, b1 } = setupTwoOrgs();
    setGoal(orgA, { id: a1.id, name: a1.name }, "org A only goal");

    const res = await call("GET", "/v1/goal", b1.key);
    const { goal } = (await res.json()) as { goal: { text: string } | null };
    expect(goal).toBeNull();
  });
});

describe("resource locks", () => {
  it("org B never sees, renews, or releases org A's resource lock, and claiming the same key in org B doesn't collide with org A's", async () => {
    const { orgA, a1, b1 } = setupTwoOrgs();
    const claimed = await call("POST", "/v1/resources/claim", a1.key, { resourceKey: "/Users/shared/repo" });
    expect(claimed.status).toBe(200);

    // Org B claiming the exact same resourceKey string must succeed -- it's a different org's
    // namespace entirely, not a real collision with org A's lock on that string.
    const bClaim = await call("POST", "/v1/resources/claim", b1.key, { resourceKey: "/Users/shared/repo" });
    expect(bClaim.status).toBe(200);

    // Org B's list never includes org A's lock, even though both orgs now hold a lock under the
    // identical resourceKey string.
    const list = await call("GET", "/v1/resources", b1.key);
    const { locks } = (await list.json()) as { locks: Array<{ holder_agent_id: string }> };
    expect(locks.every((l) => l.holder_agent_id !== a1.id)).toBe(true);

    // A renew/release under org B's key only ever touches org B's own row for that resourceKey
    // (already claimed by b1 above) -- it can never reach across into org A's row of the same name.
    expect((await call("POST", "/v1/resources/renew", b1.key, { resourceKey: "/Users/shared/repo" })).status).toBe(200);

    const orgAList = await call("GET", "/v1/resources", a1.key);
    const { locks: aLocks } = (await orgAList.json()) as { locks: Array<{ holder_agent_id: string }> };
    expect(aLocks.some((l) => l.holder_agent_id === a1.id)).toBe(true);
    expect(aLocks.every((l) => l.holder_agent_id !== b1.id)).toBe(true);
  });
});

describe("blackboard facts", () => {
  it("org B never reads, lists, or deletes org A's fact, and setting the same key in org B doesn't collide with org A's", async () => {
    const { orgA, a1, b1 } = setupTwoOrgs();
    const setA = await call("POST", "/v1/facts", a1.key, { key: "deploy.target", value: "org-a-only-value" });
    expect(setA.status).toBe(200);

    // Org B reading the exact same key string must come back empty -- it's a different org's
    // namespace entirely, not a real collision with org A's fact under that key.
    const getB = await call("GET", "/v1/facts/one?key=deploy.target", b1.key);
    expect(getB.status).toBe(404);

    const listB = await call("GET", "/v1/facts", b1.key);
    const { facts: bFacts } = (await listB.json()) as { facts: Array<{ key: string; value: string }> };
    expect(bFacts.every((f) => f.value !== "org-a-only-value")).toBe(true);

    // Org B setting the identical key succeeds independently and never touches org A's row.
    const setB = await call("POST", "/v1/facts", b1.key, { key: "deploy.target", value: "org-b-only-value" });
    expect(setB.status).toBe(200);
    const getA = await call("GET", "/v1/facts/one?key=deploy.target", a1.key);
    const { fact: aFact } = (await getA.json()) as { fact: { value: string } };
    expect(aFact.value).toBe("org-a-only-value");

    // Org B deleting the key it doesn't hold in org A's namespace is a 404, and org A's fact survives.
    const delB = await call("POST", "/v1/facts/delete", b1.key, { key: "nonexistent-in-b" });
    expect(delB.status).toBe(404);
    expect((await call("GET", "/v1/facts/one?key=deploy.target", a1.key)).status).toBe(200);
  });
});

describe("agent reliability", () => {
  it("org B never sees org A's accepted-task history for the same agent id, and its own history stays 0/0", async () => {
    const { orgA, a1, a2 } = setupTwoOrgs();
    const task = createTask(orgA, { id: a1.id, name: a1.name }, { title: "t" });
    claimTask(orgA, { id: a1.id, name: a1.name }, task.id, 60);
    completeTask(orgA, { id: a1.id, name: a1.name }, task.id, "done");
    acceptTask(orgA, { id: a2.id, name: a2.name }, task.id);

    const ownRead = await call("GET", "/v1/reliability", a1.key);
    const { reliability } = (await ownRead.json()) as { reliability: { accepted: number; rejected: number } };
    expect(reliability).toMatchObject({ accepted: 1, rejected: 0 });

    // A second org's org-scoped query never crosses into org A's events table, even when asked by
    // the exact same agent id (org B has no agent with a1's id, but the query itself must be
    // org-scoped, not just id-scoped, or a colliding id elsewhere would leak history).
    const orgB = createOrganization("Reliability Org B");
    const bAgent = registerAgent(orgB.orgId, "B-Reliability-Agent");
    const crossRead = await call("GET", `/v1/reliability?agentId=${a1.id}`, bAgent.apiKey);
    const { reliability: crossReliability } = (await crossRead.json()) as { reliability: { accepted: number; rejected: number } };
    expect(crossReliability).toMatchObject({ accepted: 0, rejected: 0 });

    const listAll = await call("GET", "/v1/reliability/all", bAgent.apiKey);
    const { reliability: bList } = (await listAll.json()) as { reliability: Array<{ agent_id: string }> };
    expect(bList.every((r) => r.agent_id !== a1.id)).toBe(true);
  });
});

describe("task shape telemetry", () => {
  it("org B's task-shape stats never include org A's completed tasks", async () => {
    const { orgA, a1, a2 } = setupTwoOrgs();
    setAgentCapabilities(orgA, a1.id, ["distinctive-cap-marker"]);
    const task = createTask(orgA, { id: a1.id, name: a1.name }, { title: "org a only", requiredCapabilities: ["distinctive-cap-marker"] });
    const claimed = claimTask(orgA, { id: a1.id, name: a1.name }, task.id, 60);
    if (!claimed.ok) throw new Error(`setup: claim failed: ${claimed.error}`);
    const completed = completeTask(orgA, { id: a1.id, name: a1.name }, task.id, "done");
    if (!completed.ok) throw new Error(`setup: complete failed: ${completed.error}`);
    acceptTask(orgA, { id: a2.id, name: a2.name }, task.id);

    const orgB = createOrganization("Task Shape Org B");
    const bAgent = registerAgent(orgB.orgId, "B-Shape-Agent");
    const res = await call("GET", "/v1/task-shape-stats", bAgent.apiKey);
    const { shapes } = (await res.json()) as { shapes: Array<{ shape: string[] }> };
    expect(shapes.every((s) => !s.shape.includes("distinctive-cap-marker"))).toBe(true);
  });
});

describe("org usage", () => {
  it("org B's usage report never counts org A's activity", async () => {
    const { orgA, orgB, a1, bOp } = setupTwoOrgs();
    await sendMessage(orgA, { id: a1.id, name: a1.name }, "A-Two", "hi from org A");

    const res = await call("GET", "/v1/org/usage", bOp.key);
    expect(res.status).toBe(200);
    const { usage } = (await res.json()) as { usage: { messagesSent: number; orgId: string } };
    expect(usage.orgId).toBe(orgB); // org B's own report, scoped to org B
    expect(usage.messagesSent).toBe(0); // org A's message never counted
  });

  it("is operator-only", async () => {
    const { b1 } = setupTwoOrgs();
    expect((await call("GET", "/v1/org/usage", b1.key)).status).toBe(403);
  });
});

describe("approvals", () => {
  it("org B can't decide or wait on an org A approval", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();
    const approval = await requestApproval(orgA, { id: a1.id, name: a1.name }, { action: "rm -rf /", risk: "high" });

    const decideRes = await call("POST", `/v1/approvals/${approval.id}/decide`, b1.key, { decision: "approve" });
    expect(decideRes.status).toBe(404);

    const waitRes = await call("GET", `/v1/approvals/${approval.id}/wait?timeoutSeconds=1`, b1.key);
    expect(waitRes.status).toBe(404);

    const withdrawRes = await call("POST", `/v1/approvals/${approval.id}/withdraw`, b1.key, {});
    expect(withdrawRes.status).toBe(404);

    const readRes = await call("GET", `/v1/approvals/${approval.id}`, b1.key);
    expect(readRes.status).toBe(404);
    const ownRead = await call("GET", `/v1/approvals/${approval.id}`, a2.key);
    expect(((await ownRead.json()) as { approval: { id: string; status: string } }).approval).toMatchObject({ id: approval.id, status: "pending" });

    // Sanity: org A can decide it -- a person of org A, since a clearance is person-decided (migration 53).
    const own = decideApproval(orgA, (await signInPerson(orgA)).decider, approval.id, "deny");
    expect(own.ok).toBe(true);
  });

  it("org B's approval list never includes org A's requests", async () => {
    const { orgA, a1, b1 } = setupTwoOrgs();
    await requestApproval(orgA, { id: a1.id, name: a1.name }, { action: "terraform destroy", risk: "high" });

    const res = await call("GET", "/v1/approvals", b1.key);
    const { approvals } = (await res.json()) as { approvals: Array<{ action: string }> };
    expect(approvals.some((ap) => ap.action === "terraform destroy")).toBe(false);
  });

  it("org B can't name an org A agent as its approver", async () => {
    const { a1, b1 } = setupTwoOrgs();
    const res = await call("POST", "/v1/approvals", b1.key, { action: "npm publish", approver: a1.name });
    expect(res.status).toBe(400);
    expect(unreadFor(a1.id)).toBe(0);
  });
});

describe("project settings (WIP cap)", () => {
  it("org B's operator can't read or set org A's project cap: the project doesn't exist for it (404)", async () => {
    const { orgA, aOp, bOp } = setupTwoOrgs();
    assignPlan(orgA, "internal");
    const key = "github.com/acme/wip-only-in-a";
    setProjectEnabled(orgA, { actor: { id: aOp.id, name: aOp.name }, name: aOp.name, via: "operator" }, key, true);
    const path = `/v1/org/projects/${encodeURIComponent(key)}/settings`;
    expect((await call("PUT", path, bOp.key, { wipCap: 1 })).status).toBe(404);
    expect((await call("GET", path, bOp.key)).status).toBe(404);
    expect(effectiveWipCap(orgA, key)).toBeNull();
    // Sanity: org A's own operator sets it.
    expect((await call("PUT", path, aOp.key, { wipCap: 1 })).status).toBe(200);
    expect(effectiveWipCap(orgA, key)).toBe(1);
  });
});

describe("approval grants", () => {
  it("org B can't revoke a grant created inside org A, and never sees it listed", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();
    const approval = await requestApproval(orgA, { id: a1.id, name: a1.name }, { action: "deploy prod", risk: "high", category: "deploy" });
    const decided = decideApproval(orgA, (await signInPerson(orgA)).decider, approval.id, "approve", null, { grantMinutes: 30 });
    if (!decided.ok || !decided.grant) throw new Error("setup failed to create a grant");

    const listRes = await call("GET", "/v1/approval-grants", b1.key);
    const { grants } = (await listRes.json()) as { grants: Array<{ id: string }> };
    expect(grants.some((g) => g.id === decided.grant!.id)).toBe(false);

    const revokeRes = await call("DELETE", `/v1/approval-grants/${decided.grant.id}`, b1.key);
    expect(revokeRes.status).toBe(404);
  });
});

describe("clearances", () => {
  it("org B's operator can't read, list, change or remove org A's clearance policy", async () => {
    const { orgA, orgB, aOp, a1, b1, bOp } = setupTwoOrgs();
    setClearancePolicy(orgA, { id: aOp.id, name: aOp.name }, "github.com/acme/app", "strict");

    const read = (await (await call("GET", "/v1/clearance-policy?project=github.com/acme/app", b1.key)).json()) as { policy: { mode: string } };
    expect(read.policy.mode).toBe("off");
    expect(((await (await call("GET", "/v1/clearance-policies", bOp.key)).json()) as { policies: unknown[] }).policies).toEqual([]);
    // Since #653 an Operator key cannot write policy at all (403); a signed-in person of org B writes.
    expect((await call("DELETE", "/v1/clearance-policy?project=github.com/acme/app", bOp.key)).status).toBe(403);
    const bOwner = (await signInPerson(orgB, "Owner B", "owner")).headers;
    const asOwner = (method: string, route: string, body?: unknown) => fetch(`${restBaseUrl}${route}`, { method, headers: bOwner, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await asOwner("DELETE", "/v1/clearance-policy?project=github.com/acme/app")).status).toBe(404);
    // Writing the same project key only ever lands in org B's own workspace.
    expect((await asOwner("PUT", "/v1/clearance-policy", { project: "github.com/acme/app", mode: "off" })).status).toBe(200);

    const own = (await (await call("GET", "/v1/clearance-policy?project=github.com/acme/app", a1.key)).json()) as { policy: { mode: string } };
    expect(own.policy.mode).toBe("strict");
  });

  it("org B can't satisfy a bypass report with org A's approval or notify org A's agents", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();
    const approval = await requestApproval(orgA, { id: a1.id, name: a1.name }, { action: "npm publish" });
    expect(decideApproval(orgA, (await signInPerson(orgA)).decider, approval.id, "approve", null).ok).toBe(true);

    expect((await call("POST", "/v1/clearances/executed", b1.key, { action: "npm publish", required: "approval", approver: a2.name })).status).toBe(400);
    const res = await call("POST", "/v1/clearances/executed", b1.key, { action: "npm publish", required: "approval" });
    expect(((await res.json()) as { outcome: string }).outcome).toBe("bypassed");
    expect(unreadFor(a2.id)).toBe(0);
  });
});

// F7 / Q1f: a policy pass is recorded in the caller's own workspace only, and its receipt dedupe is per workspace and
// agent: org B reusing a receipt id org A recorded neither suppresses its own record nor touches org A's timeline.
describe("policy passes", () => {
  it("org B's policy pass lands in org B only, and org A's receipt id cannot silence it", async () => {
    const { orgA, orgB, a1, b1 } = setupTwoOrgs();
    const body = { receiptId: "11111111-2222-3333-4444-555555555555", reason: "timeout", action: "terraform apply", category: "terraform", occurredAt: new Date().toISOString(), delivery: "live" };
    expect((await call("POST", "/v1/clearances/policy-pass", a1.key, body)).status).toBe(200);
    const res = await call("POST", "/v1/clearances/policy-pass", b1.key, body);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("recorded");
    const passes = (org: string) => listEvents(org).filter((e) => e.type === "clearance.policy_pass");
    expect(passes(orgA).map((e) => e.actor_agent_id)).toEqual([a1.id]);
    expect(passes(orgB).map((e) => e.actor_agent_id)).toEqual([b1.id]);
  });
});

describe("workspace members and invites", () => {
  it("org B's operator can't list, invite into, or change org A's members", async () => {
    const { orgA, bOp } = setupTwoOrgs();
    for (const [method, path, body] of [
      ["GET", `/v1/workspaces/${orgA}/members`, undefined],
      ["POST", `/v1/workspaces/${orgA}/invites`, { role: "owner" }],
      ["DELETE", `/v1/workspaces/${orgA}/invites/some-invite`, undefined],
      ["PATCH", `/v1/workspaces/${orgA}/members/some-person`, { role: "owner" }],
      ["DELETE", `/v1/workspaces/${orgA}/members/some-person`, undefined],
    ] as const) {
      expect((await call(method, path, bOp.key, body)).status, `${method} ${path}`).toBe(404);
    }
  });
});

describe("first-run checklist", () => {
  it("org B's checklist reflects only org B", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();
    await sendMessage(orgA, { id: a1.id, name: a1.name }, a2.name, "counts for A only");
    await requestApproval(orgA, { id: a1.id, name: a1.name }, { action: "rm -rf /tmp/x", notifyOnly: true });
    const b = (await (await call("GET", "/v1/onboarding", b1.key)).json()) as { steps: Array<{ id: string; done: boolean; detail: string | null }> };
    expect(b.steps.map((s) => [s.id, s.done])).toEqual([["first_agent", true], ["second_agent", false], ["first_message", false], ["first_clearance", false]]);
    expect(JSON.stringify(b)).not.toContain("A-One");
  });
});

describe("kill switch", () => {
  it("org B's operator pausing its workspace leaves org A's agents running", async () => {
    const { a1, b1, bOp } = setupTwoOrgs();
    expect((await call("POST", "/v1/org/pause", bOp.key)).status).toBe(200);
    expect((await call("GET", "/v1/me", b1.key)).status).toBe(423);
    expect((await call("GET", "/v1/me", a1.key)).status).toBe(200);
    expect((await call("POST", "/v1/org/resume", bOp.key)).status).toBe(200);
  });
});

describe("MCP tools", () => {
  it("org B's MCP session can't reach org A's threads, files, tasks or approvals", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();
    const sent = await sendMessage(orgA, { id: a1.id, name: a1.name }, a2.name, "mcp secret");
    const shared = await shareFile(orgA, { id: a1.id, name: a1.name }, a2.name, "s.md", "text/markdown", Buffer.from("mcp file secret"), "here");
    if (!sent.ok || !shared.ok) throw new Error("setup failed");
    const task = createTask(orgA, { id: a1.id, name: a1.name }, { title: "mcp task" });
    const approval = await requestApproval(orgA, { id: a1.id, name: a1.name }, { action: "mcp risky" });

    const client = new Client({ name: "isolation-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${b1.key}` } } }));
    try {
      const attempts: Array<[string, Record<string, unknown>]> = [
        ["reply", { threadId: sent.threadId, body: "nope" }],
        ["get_message_status", { threadId: sent.threadId }],
        ["download_file", { fileId: shared.fileId }],
        ["claim_task", { taskId: task.id }],
        ["set_task_lane", { taskId: task.id, lane: "held", reason: "x" }],
        ["get_task", { taskId: task.id }],
        ["decide_approval", { approvalId: approval.id, decision: "approve" }],
        ["withdraw_approval", { approvalId: approval.id }],
        ["send_message", { toAgent: a2.name, body: "cross-org" }],
      ];
      for (const [name, args] of attempts) {
        const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
        const text = result.content.map((c) => c.text ?? "").join(" ");
        expect(text, name).not.toContain("mcp file secret");
        expect(text, name).not.toContain("mcp secret");
        expect(result.isError || /no |not found|isn't|not part/i.test(text), `${name}: ${text}`).toBeTruthy();
      }
    } finally {
      await client.close();
    }
    // Org A's own state is untouched: both deliveries still unread, the approval still undecided.
    expect(unreadFor(a2.id)).toBe(2);
    expect(decideApproval(orgA, (await signInPerson(orgA)).decider, approval.id, "deny").ok).toBe(true);
  });
});

describe("WebSocket /live push", () => {
  it("org B's socket never receives a push meant for an org A agent", async () => {
    const { orgA, a1, a2, b1 } = setupTwoOrgs();

    const bSocket = new WebSocket(`${wsBaseUrl}/live?apiKey=${b1.key}`);
    await new Promise((resolve, reject) => {
      bSocket.once("open", resolve);
      bSocket.once("error", reject);
    });
    const bReceived: unknown[] = [];
    bSocket.on("message", (raw) => bReceived.push(JSON.parse(raw.toString())));

    const aSocket = new WebSocket(`${wsBaseUrl}/live?apiKey=${a2.key}`);
    await new Promise((resolve, reject) => {
      aSocket.once("open", resolve);
      aSocket.once("error", reject);
    });
    const aReceived: unknown[] = [];
    aSocket.on("message", (raw) => aReceived.push(JSON.parse(raw.toString())));

    await sendMessage(orgA, { id: a1.id, name: a1.name }, a2.name, "push me live");
    await new Promise((r) => setTimeout(r, 200));

    expect(aReceived.some((m) => (m as { body?: string }).body === "push me live")).toBe(true);
    expect(bReceived).toHaveLength(0);

    aSocket.close();
    bSocket.close();
  });
});
