import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { authenticateLiveRequest } from "../src/live-auth.js";
import { registerSocket } from "../src/live.js";
import { heldRequestCount } from "../src/revocation.js";
import { createOrganization, listActiveAgents, registerAgent, setAgentWebhook } from "../src/service.js";
import { setProjectEnabled, PROJECT_NOT_ENABLED } from "../src/projects.js";
import { requestApproval } from "../src/approvals.js";
import { setProjectIsolation } from "../src/project-isolation.js";
import { db } from "../src/db.js";

/** PR 1 of project isolation (docs/design/PROJECT_ISOLATION.md §7 item 1): leak fixes that need no new data model. */

let server: http.Server;
let base: string;
let wsBase: string;

beforeAll(async () => {
  // REST, MCP and /live on one server, as src/index.ts wires them.
  server = http.createServer((req, res) => {
    if (req.url === "/mcp" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
        void handleMcpRequest(req, res);
      });
      return;
    }
    app(req, res);
  });
  const wss = new WebSocketServer({ server, path: "/live" });
  wss.on("connection", (ws, req) => {
    const authed = authenticateLiveRequest(req);
    if (!authed.ok) return void ws.close(authed.code, authed.reason);
    registerSocket(authed.agentId, ws);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const PROJECT_A = "local:IsoProjectA";
const PROJECT_B = "local:IsoProjectB";

interface Session { credential: string; tool: string; project: string }

const sessionHeaders = (s: Session) => ({
  authorization: `Bearer ${s.credential}`,
  "x-opencadre-session": s.tool,
  "x-opencadre-client": "claude-code",
  "x-opencadre-project": s.project,
  "x-opencadre-project-name": s.project.slice("local:".length),
});

let ipCounter = 0;
const nextIp = () => `10.91.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function call(method: string, path: string, auth: string | Session, body?: unknown) {
  const headers: Record<string, string> = typeof auth === "string" ? { authorization: `Bearer ${auth}` } : sessionHeaders(auth);
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

let orgCounter = 0;
function workspace() {
  const orgId = createOrganization(`Isolation Leaks ${++orgCounter}`).orgId;
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const coder = registerAgent(orgId, "Coder");
  const reviewer = registerAgent(orgId, "Reviewer");
  const bystander = registerAgent(orgId, "Bystander");
  for (const key of [PROJECT_A, PROJECT_B]) setProjectEnabled(orgId, { actor: null, name: "test", via: "operator" }, key, true);
  return {
    orgId,
    operator: { id: operator.agentId, name: "Operator", key: operator.apiKey },
    coder: { id: coder.agentId, name: "Coder", key: coder.apiKey },
    reviewer: { id: reviewer.agentId, name: "Reviewer", key: reviewer.apiKey },
    bystander: { id: bystander.agentId, name: "Bystander", key: bystander.apiKey },
  };
}

async function device(operatorKey: string) {
  const minted = await call("POST", "/v1/org/devices", operatorKey, { name: "Isolation test PC", client: "claude-code" });
  expect(minted.status).toBe(201);
  const { deviceId, code } = (await minted.json()) as { deviceId: string; code: string };
  const redeemed = await fetch(`${base}/v1/connect/redeem`, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": nextIp() }, body: JSON.stringify({ code }),
  });
  expect(redeemed.status).toBe(201);
  return { deviceId, credential: ((await redeemed.json()) as { deviceCredential: string }).deviceCredential };
}

async function join(credential: string, tool: string, project: string) {
  const session: Session = { credential, tool, project };
  const res = await call("POST", "/v1/sessions/join", session);
  expect(res.status).toBeLessThan(300);
  const { agentId, agentName } = (await res.json()) as { agentId: string; agentName: string };
  return { ...session, id: agentId, name: agentName };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const conflictTargets = (orgId: string, actorId: string) =>
  (db.prepare(`SELECT target_agent_id FROM events WHERE org_id = ? AND type = 'conflict.detected' AND actor_agent_id = ?`).all(orgId, actorId) as Array<{ target_agent_id: string }>)
    .map((r) => r.target_agent_id);

type RosterRow = Record<string, unknown> & { id: string };

describe("roster fields", () => {
  it("another agent's row has no webhook_url or device_id; the caller's own row keeps its own", async () => {
    const w = workspace();
    setAgentWebhook(w.orgId, w.coder.id, "https://hooks.example.test/coder-fake-token", "Bearer fake-coder-auth");
    setAgentWebhook(w.orgId, w.reviewer.id, "https://hooks.example.test/reviewer-fake-token", "Bearer fake-reviewer-auth");
    const { deviceId, credential } = await device(w.operator.key);
    const session = await join(credential, "roster-tool", PROJECT_A);

    const asCoder = (await (await call("GET", "/v1/agents", w.coder.key)).json()) as { agents: RosterRow[] };
    const coderSelf = asCoder.agents.find((a) => a.id === w.coder.id)!;
    expect(coderSelf.webhook_url).toBe("https://hooks.example.test/coder-fake-token");
    for (const other of asCoder.agents.filter((a) => a.id !== w.coder.id)) {
      expect(other, other.id).not.toHaveProperty("webhook_url");
      expect(other, other.id).not.toHaveProperty("device_id");
    }
    expect(asCoder.agents.find((a) => a.id === session.id)).toMatchObject({ project: PROJECT_A });
    const raw = JSON.stringify(asCoder);
    expect(raw).not.toContain("reviewer-fake-token");
    expect(raw).not.toContain(deviceId);
    expect(raw).not.toContain("fake-coder-auth"); // the auth header never left, even on the own row

    const asSession = (await (await call("GET", "/v1/agents", session)).json()) as { agents: RosterRow[] };
    expect(asSession.agents.find((a) => a.id === session.id)).toMatchObject({ device_id: deviceId });
    expect(JSON.stringify(asSession.agents.filter((a) => a.id !== session.id))).not.toMatch(/fake-token|"device_id"/);

    // webhook_url is a credential (most providers embed a bearer secret in it): it appears in no other agent's view.
    const bystanderViews = await Promise.all(["/v1/agents", "/v1/events?limit=200", "/v1/awareness?since=0", "/v1/deliveries"].map(async (path) => {
      const res = await call("GET", path, w.bystander.key);
      expect(res.status, path).toBe(200);
      return JSON.stringify(await res.json());
    }));
    for (const view of bystanderViews) expect(view).not.toMatch(/fake-token|fake-coder-auth|fake-reviewer-auth/);
    const mcp = new Client({ name: "isolation-roster-test", version: "0.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${w.bystander.key}` } } }));
    try {
      for (const name of ["get_active_agents", "get_timeline", "get_awareness"]) {
        const result = (await mcp.callTool({ name, arguments: {} })) as { content: Array<{ text?: string }> };
        expect(result.content.map((c) => c.text ?? "").join(" "), name).not.toMatch(/fake-token|fake-coder-auth|fake-reviewer-auth/);
      }
    } finally {
      await mcp.close();
    }

    // An internal read with no viewer carries neither field on any row.
    for (const row of listActiveAgents(w.orgId)) {
      expect(row).not.toHaveProperty("webhook_url");
      expect(row).not.toHaveProperty("device_id");
    }
  });
});

describe("shared files", () => {
  it("the uploader, the thread's recipient and an operator can download it; an unrelated agent in the same org gets 404", async () => {
    const w = workspace();
    const shared = await call("POST", "/v1/files/share", w.coder.key, {
      toAgent: "Reviewer", filename: "plan.md", mimeType: "text/markdown", contentBase64: Buffer.from("isolation file body").toString("base64"), message: "have a look",
    });
    expect(shared.status).toBe(201);
    const { fileId } = (await shared.json()) as { fileId: string };

    for (const key of [w.coder.key, w.reviewer.key, w.operator.key]) {
      const res = await call("GET", `/v1/files/${fileId}`, key);
      expect(res.status).toBe(200);
      expect(Buffer.from(((await res.json()) as { contentBase64: string }).contentBase64, "base64").toString()).toBe("isolation file body");
    }

    // The id is public inside the workspace (the message.sent event carries it), so knowing it must grant nothing.
    const timeline = (await (await call("GET", "/v1/events?types=message.sent", w.bystander.key)).json()) as { events: Array<{ type: string; payload: unknown }> };
    const sent = timeline.events.find((e) => JSON.stringify(e.payload).includes(fileId));
    expect(sent?.type).toBe("message.sent");

    const denied = await call("GET", `/v1/files/${fileId}`, w.bystander.key);
    const missing = await call("GET", `/v1/files/not-a-real-file-id`, w.bystander.key);
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(await denied.json())).not.toContain("isolation file body");

    const mcp = new Client({ name: "isolation-leaks-test", version: "0.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${w.bystander.key}` } } }));
    try {
      const result = (await mcp.callTool({ name: "download_file", arguments: { fileId } })) as { content: Array<{ text?: string }> };
      const text = result.content.map((c) => c.text ?? "").join(" ");
      expect(text).toContain("no file found");
      expect(text).not.toContain(Buffer.from("isolation file body").toString("base64"));
    } finally {
      await mcp.close();
    }
  });
});

describe("cross-repo false alarms", () => {
  it("two agents in different projects editing src/index.ts produce no conflict; the same project still does", async () => {
    const w = workspace();
    const { credential } = await device(w.operator.key);
    const a1 = await join(credential, "conflict-a1", PROJECT_A);
    const a2 = await join(credential, "conflict-a2", PROJECT_A);
    const b1 = await join(credential, "conflict-b1", PROJECT_B);

    expect(((await (await call("POST", "/v1/status", b1, { task: "b work", files: ["src/index.ts"] })).json()) as { collisions: unknown[] }).collisions).toEqual([]);
    const a1Status = (await (await call("POST", "/v1/status", a1, { task: "a work", files: ["src/index.ts"] })).json()) as { collisions: Array<{ agentName: string }> };
    expect(a1Status.collisions).toEqual([]);
    expect(conflictTargets(w.orgId, a1.id)).toEqual([]);

    const a2Status = (await (await call("POST", "/v1/status", a2, { task: "a work too", files: ["src/index.ts"] })).json()) as { collisions: Array<{ agentName: string }> };
    expect(a2Status.collisions.map((c) => c.agentName)).toEqual([a1.name]);
    expect(conflictTargets(w.orgId, a2.id)).toEqual([a1.id]);

    // A named agent has no project, so it keeps comparing with everyone.
    const named = (await (await call("POST", "/v1/status", w.coder.key, { task: "named work", files: ["src/index.ts"] })).json()) as { collisions: Array<{ agentName: string }> };
    expect(named.collisions.map((c) => c.agentName).sort()).toEqual([a1.name, a2.name, b1.name].sort());
  });

  it("a decision in project A scoped to src/index.ts is not P2 for an agent in project B", async () => {
    const w = workspace();
    const { credential } = await device(w.operator.key);
    const a1 = await join(credential, "decision-a1", PROJECT_A);
    const a2 = await join(credential, "decision-a2", PROJECT_A);
    const b1 = await join(credential, "decision-b1", PROJECT_B);
    for (const viewer of [a2, b1, w.reviewer.key]) {
      expect((await call("POST", "/v1/status", viewer, { task: "editing", files: ["src/index.ts"] })).status).toBe(200);
    }
    const recorded = await call("POST", "/v1/decisions", a1, { title: "Keep the entry point thin", scope: "src/index.ts" });
    expect(recorded.status).toBe(201);
    const { event } = (await recorded.json()) as { event: { seq: number } };

    type Awareness = { items: Array<{ seq: number; priority: number }>; background: Record<string, number> };
    const awarenessOf = async (auth: string | Session) => (await (await call("GET", `/v1/awareness?since=${event.seq - 1}`, auth)).json()) as Awareness;

    // With project isolation on (a new workspace), project B doesn't see project A's decision at all.
    const isolated = await awarenessOf(b1);
    expect(isolated.items.find((i) => i.seq === event.seq)).toBeUndefined();
    expect(isolated.background["decision.recorded"]).toBeUndefined();
    // With it off, B sees it, but only as background: relevance is still compared within one project.
    setProjectIsolation(w.orgId, { id: w.operator.id, name: w.operator.name }, false);
    const other = await awarenessOf(b1);
    expect(other.items.find((i) => i.seq === event.seq)).toBeUndefined();
    expect(other.background["decision.recorded"]).toBe(1);

    expect((await awarenessOf(a2)).items.find((i) => i.seq === event.seq)?.priority).toBe(2);
    // A named agent has no project, so it keeps today's relevance.
    expect((await awarenessOf(w.reviewer.key)).items.find((i) => i.seq === event.seq)?.priority).toBe(2);
  });
});

describe("disabling a project", () => {
  it("closes the project's live sockets and ends its held waits; other projects and named agents keep theirs", async () => {
    const w = workspace();
    const { credential } = await device(w.operator.key);
    const a = await join(credential, "disable-a", PROJECT_A);
    const b = await join(credential, "disable-b", PROJECT_B);
    // The session's own request: with project isolation on, a session can wait only on an approval in its own project.
    const approval = await requestApproval(w.orgId, { id: a.id, name: a.name }, { action: "deploy the isolation fixture" });
    expect(approval.status).toBe("pending");

    const socket = new WebSocket(`${wsBase}/live`, { headers: sessionHeaders(a) });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    const waits = [
      call("GET", "/v1/messages/wait?timeoutSeconds=30", a),
      call("GET", "/v1/events/wait?after=999999999&timeoutSeconds=30", a),
      call("GET", `/v1/approvals/${approval.id}/wait?timeoutSeconds=30`, a),
    ];
    const bystanderWaits = [call("GET", "/v1/messages/wait?timeoutSeconds=2", b), call("GET", "/v1/messages/wait?timeoutSeconds=2", w.reviewer.key)];
    await until(() => heldRequestCount(a.id) === 3 && heldRequestCount(b.id) === 1 && heldRequestCount(w.reviewer.id) === 1, "the waits to be held");

    const started = Date.now();
    const disabled = await call("PUT", "/v1/org/projects", w.operator.key, { projectKey: PROJECT_A, enabled: false });
    expect(disabled.status).toBe(200);

    expect(await closed).toBe(4001);
    const ended = await Promise.all(waits);
    expect(ended.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(await ended[0].json()).toEqual({ error: PROJECT_NOT_ENABLED });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(heldRequestCount(a.id)).toBe(0);

    // The other project's session and the named agent were not cut off: their waits run to their own timeout.
    expect(heldRequestCount(b.id)).toBe(1);
    expect(heldRequestCount(w.reviewer.id)).toBe(1);
    expect((await Promise.all(bystanderWaits)).map((r) => r.status)).toEqual([200, 200]);

    // The next request is refused, as before this change.
    expect((await call("GET", "/v1/me", a)).status).toBe(403);
    // Waiters behind the ended requests resolve into silenced responses without throwing.
    await new Promise((r) => setTimeout(r, 150));
  });
});

// Codex-OpenCadre-f46c on 6ad905a: GET /v1/resources returned every lock in the workspace, so a session in project A
// saw project B's file paths, notes and holder names although the roster keeps the projects apart. A lock is now
// visible when its holder is (isReachable), on REST and MCP alike.
describe("resource locks follow the roster's reach", () => {
  it("a session in project A doesn't see project B's locks; the holder and a workspace-scope operator do", async () => {
    const w = workspace();
    const { credential } = await device(w.operator.key);
    const inA = await join(credential, "locks-a", PROJECT_A);
    const inB = await join(credential, "locks-b", PROJECT_B);
    const claimed = await call("POST", "/v1/resources/claim", inB, { resourceKey: "src/billing-secret-plan.ts", note: "B's private work" });
    expect(claimed.status).toBeLessThan(300);

    const keys = async (auth: string | Session) =>
      ((await (await call("GET", "/v1/resources", auth)).json()) as { locks: Array<{ resource_key: string }> }).locks.map((l) => l.resource_key);
    expect(await keys(inA), "project A must not learn B's paths").not.toContain("src/billing-secret-plan.ts");
    expect(await keys(inB), "the holder sees its own lock").toContain("src/billing-secret-plan.ts");
    expect(await keys(w.operator.key), "a workspace-scope operator sees everything").toContain("src/billing-secret-plan.ts");

    const mcp = new Client({ name: "isolation-locks-test", version: "0.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: sessionHeaders(inA) } }));
    try {
      const listed = (await mcp.callTool({ name: "list_resource_locks", arguments: {} })) as { content: Array<{ text: string }> };
      expect(listed.content.map((c) => c.text).join("\n")).not.toContain("billing-secret-plan");
    } finally {
      await mcp.close();
    }
  });
});
