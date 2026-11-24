import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent, sweepStaleAgents } from "../src/service.js";
import { buildSessionName, clientLabel, sanitizeProject, sessionTool, sweepIdleSessions } from "../src/devices.js";
import { setProjectEnabled } from "../src/projects.js";
import { assignPlan, countLiveAgents, PLAN_LIMIT_CODE, workspaceBilling } from "../src/billing.js";
import { heldRequestCount } from "../src/revocation.js";
import { NAME_WORDS } from "../src/agent-names.js";
import { signInPerson } from "./helpers/person.js";

/** Per-session identity: one device credential, one agent per tool session (src/devices.ts). */

let server: http.Server;
let base: string;

beforeAll(async () => {
  // REST and MCP on one server, as src/index.ts wires them.
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
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  delete process.env.OPENCADRE_SESSION_TTL_HOURS;
  delete process.env.OPENCADRE_MAX_SESSIONS_PER_DEVICE;
});

interface Session {
  tool?: string;
  host?: string;
  client?: string;
  /** The project key header. Omitted: the enabled default project, sent as a current client does (with its name).
   * Given: sent alone, as a client from before remote keys did (a bare folder name). null: no project header at all. */
  project?: string | null;
  projectName?: string;
  resolveOnly?: boolean;
}

let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

const DEFAULT_PROJECT = { key: "local:SessTest", name: "SessTest" };

function projectHeadersFor(session?: Session): Record<string, string> {
  if (!session?.tool || session.project === null) return {};
  if (session.project === undefined) return { "x-opencadre-project": DEFAULT_PROJECT.key, "x-opencadre-project-name": DEFAULT_PROJECT.name };
  return { "x-opencadre-project": session.project, ...(session.projectName ? { "x-opencadre-project-name": session.projectName } : {}) };
}

function call(method: string, path: string, { key, body, session, ip }: { key?: string; body?: unknown; session?: Session; ip?: string } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(session?.tool ? { "x-opencadre-session": session.tool } : {}),
      ...(session?.host ? { "x-opencadre-host-session": session.host } : {}),
      ...(session?.client ? { "x-opencadre-client": session.client } : {}),
      ...projectHeadersFor(session),
      ...(session?.resolveOnly ? { "x-opencadre-resolve-only": "1" } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Projects the tests in this file use, enabled in every workspace they create. */
const ENABLED_PROJECTS = [DEFAULT_PROJECT.key, "OpenCadre", "McpRepo", "Burst", "Repo"];

let orgCounter = 0;
function workspace() {
  // internal: uncapped and non-expiring, so a fixture that enables five projects is not stopped
  // part-way by the plan limit it is not testing (9d1f ruling). The suites that measure the REFUSAL
  // build a trial workspace deliberately -- see tests/billing.test.ts.
  const orgId = createOrganization(`Sessions Org ${++orgCounter}`, "internal").orgId;
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const coder = registerAgent(orgId, "Coder");
  for (const key of ENABLED_PROJECTS) setProjectEnabled(orgId, { actor: null, name: "test", via: "operator" }, key, true);
  return { orgId, operatorKey: operator.apiKey, coder: { id: coder.agentId, key: coder.apiKey } };
}

async function mintDevice(operatorKey: string, body: Record<string, unknown> = { name: "Claude Code on PC-2", client: "claude-code" }) {
  const res = await call("POST", "/v1/org/devices", { key: operatorKey, body });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function redeem(code: string) {
  const res = await call("POST", "/v1/connect/redeem", { body: { code }, ip: nextIp() });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function device(operatorKey: string, client = "claude-code") {
  const minted = await mintDevice(operatorKey, { name: `${client} device`, client });
  const redeemed = await redeem(minted.body.code);
  return { deviceId: minted.body.deviceId, credential: redeemed.body.deviceCredential };
}

async function join(credential: string, session: Session) {
  const res = await call("POST", "/v1/sessions/join", { key: credential, session });
  return { status: res.status, body: (await res.json()) as { agentId: string; agentName: string; created: boolean; error?: string } };
}

const agentRow = (agentId: string) =>
  db.prepare(`SELECT id, name, kind, device_id, seat_id, tool_session_id, project, ended_at, last_heartbeat_at, status FROM agents WHERE id = ?`).get(agentId) as {
    id: string; name: string; kind: string; device_id: string; seat_id: string | null; tool_session_id: string; project: string | null;
    ended_at: string | null; last_heartbeat_at: string | null; status: string;
  };
/** A session's auto name is one word from NAME_WORDS, or on collision two words or a word and a number (sessions PR1). */
const WORD_NAME = /^[A-Z][a-z]+(?: [A-Z][a-z]+| \d+)?$/;
/** What the name no longer encodes: the client and the project live on the session's row. */
const sessionFields = (orgId: string, name: string) =>
  db.prepare(`SELECT client, project, project_name FROM agents WHERE org_id = ? AND name = ? AND kind = 'session'`).get(orgId, name) as
    { client: string | null; project: string | null; project_name: string | null } | undefined;
/** get_active_agents as a keyed agent, over MCP: the roster lines other agents see. */
async function rosterAs(key: string): Promise<string> {
  const client = new Client({ name: "sessions-roster", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  try {
    return ((await client.callTool({ name: "get_active_agents", arguments: {} })) as { content: Array<{ text: string }> }).content[0].text;
  } finally {
    await client.close();
  }
}
const sessionCount = (deviceId: string) => (db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE device_id = ?`).get(deviceId) as { n: number }).n;

describe("device lifecycle", () => {
  it("an operator adds a device, its code redeems once, and the credential works only with a session header", async () => {
    const w = workspace();
    expect((await mintDevice(w.coder.key)).status).toBe(403);
    expect((await mintDevice(w.operatorKey, { name: "x", client: "notepad" })).status).toBe(400);
    expect((await mintDevice(w.operatorKey, { name: "", client: "codex" })).status).toBe(400);

    const minted = await mintDevice(w.operatorKey);
    expect(minted.status).toBe(201);
    expect(Object.keys(minted.body).sort()).toEqual(["code", "command", "deviceId", "expiresAt"]);
    expect(minted.body.code).toMatch(/^ocd_[A-HJ-NP-Z2-9]{10}$/);
    expect(minted.body.command).toMatch(/connect --hub \S+ --code ocd_[A-Z0-9]{10} --client claude-code$/);

    const waiting = (await (await call("GET", "/v1/org/devices", { key: w.operatorKey })).json()) as { devices: Array<Record<string, unknown>> };
    expect(waiting.devices).toMatchObject([{ deviceId: minted.body.deviceId, status: "waiting", sessionCount: 0 }]);

    const first = await redeem(minted.body.code);
    expect(first.status).toBe(201);
    expect(Object.keys(first.body).sort()).toEqual(["cliUrl", "client", "computerName", "deviceCredential", "deviceId", "hubUrl", "merged", "orgName"]);
    expect(first.body.merged).toBe(false);
    expect(first.body.deviceCredential).toMatch(/^dev_[0-9a-f]{48}$/);
    expect(first.body).toMatchObject({ deviceId: minted.body.deviceId, client: "claude-code" });
    expect((await redeem(minted.body.code)).status).toBe(410);
    expect((await redeem("ocd_ABCDEFGHJK")).status).toBe(404);

    // Only hashes are stored, and no hash is ever listed.
    const stored = JSON.stringify(db.prepare(`SELECT * FROM devices WHERE id = ?`).get(minted.body.deviceId));
    expect(stored).not.toContain(first.body.deviceCredential);
    expect(stored).not.toContain(minted.body.code);
    const listed = await (await call("GET", "/v1/org/devices", { key: w.operatorKey })).text();
    expect(listed).not.toMatch(/hash/i);
    expect(JSON.parse(listed).devices[0]).toMatchObject({ status: "connected" });

    const credential = first.body.deviceCredential;
    const bare = await call("GET", "/v1/me", { key: credential });
    expect(bare.status).toBe(401);
    expect(((await bare.json()) as { error: string }).error).toMatch(/session header required/);
    expect((await call("GET", "/v1/me", { key: credential, session: { tool: "has spaces" } })).status).toBe(401);

    const me = await call("GET", "/v1/me", { key: credential, session: { tool: "tool-1", project: "OpenCadre" } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { agentName: string };
    expect(meBody).toMatchObject({ role: "agent", agentName: expect.stringMatching(WORD_NAME) });
    expect(sessionFields(w.orgId, meBody.agentName)).toEqual({ client: "claude-code", project: "OpenCadre", project_name: "OpenCadre" });

    const forged = `dev_${"0".repeat(48)}`;
    const wrong = await call("GET", "/v1/me", { key: forged, session: { tool: "tool-1" } });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid device credential or session");
  });

  it("a device session is an ordinary agent, never an operator, and has no key to rotate", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    const joined = await join(credential, { tool: "not-an-operator" });
    expect((await call("GET", "/v1/org/devices", { key: credential, session: { tool: "not-an-operator" } })).status).toBe(403);
    expect((await call("POST", "/v1/org/agents", { key: credential, session: { tool: "not-an-operator" }, body: { name: "Sneaky" } })).status).toBe(403);
    expect((await call("POST", `/v1/org/agents/${joined.body.agentId}/rotate-key`, { key: w.operatorKey })).status).toBe(404);
  });

  it("join takes the session fields from a JSON body too, and an agent key can't join", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey, "codex");
    const res = await call("POST", "/v1/sessions/join", { key: credential, body: { toolSessionId: "body-tool", project: "Repo" } });
    expect(res.status).toBe(201);
    const joined = (await res.json()) as { agentName: string };
    expect(joined).toMatchObject({ created: true, agentName: expect.stringMatching(WORD_NAME) });
    expect(sessionFields(w.orgId, joined.agentName)).toEqual({ client: "codex", project: "Repo", project_name: "Repo" });
    expect((await call("POST", "/v1/sessions/join", { key: w.coder.key, body: { toolSessionId: "body-tool" } })).status).toBe(401);
  });
});

describe("one agent per session", () => {
  it("two sessions on one device are two agents with their own names and inboxes", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    const a = await join(credential, { tool: "session-a", project: "OpenCadre" });
    const b = await join(credential, { tool: "session-b", project: "OpenCadre" });
    expect(a.body.agentId).not.toBe(b.body.agentId);
    expect(a.body.agentName).not.toBe(b.body.agentName);

    const sent = await call("POST", "/v1/messages", { key: w.coder.key, body: { toAgent: a.body.agentName, body: "for session A only" } });
    expect(sent.status).toBe(201);
    const inboxB = (await (await call("GET", "/v1/messages?peek=true", { key: credential, session: { tool: "session-b", project: "OpenCadre" } })).json()) as { messages: Array<{ body: string }> };
    expect(inboxB.messages.map((m) => m.body)).not.toContain("for session A only");
    const inboxA = (await (await call("GET", "/v1/messages", { key: credential, session: { tool: "session-a", project: "OpenCadre" } })).json()) as { messages: Array<{ body: string }> };
    expect(inboxA.messages.map((m) => m.body)).toEqual(["for session A only"]);
  });

  it("the same seat on two devices of one workspace is two agents: a device resolves only its own sessions", async () => {
    const w = workspace();
    const one = await device(w.operatorKey);
    const two = await device(w.operatorKey);
    const a = await join(one.credential, { tool: "same-tool", host: "same-host" });
    const b = await join(two.credential, { tool: "same-tool", host: "same-host" });
    expect(a.body.agentId).not.toBe(b.body.agentId);
    expect(agentRow(a.body.agentId).device_id).toBe(one.deviceId);
    expect(agentRow(b.body.agentId).device_id).toBe(two.deviceId);
  });

  it("keeps the same agent across /clear (same host session, new tool session) and a new one for another host session", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    const before = await join(credential, { tool: "tool-before-clear", host: "window-1", project: "OpenCadre" });
    expect(before.body.created).toBe(true);

    const after = await join(credential, { tool: "tool-after-clear", host: "window-1", project: "OpenCadre" });
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ agentId: before.body.agentId, agentName: before.body.agentName, created: false });
    expect(agentRow(before.body.agentId)).toMatchObject({ seat_id: "window-1", tool_session_id: "tool-after-clear" });

    const otherWindow = await join(credential, { tool: "tool-after-clear", host: "window-2", project: "OpenCadre" });
    expect(otherWindow.body.agentId).not.toBe(before.body.agentId);

    // Without a host session id, the tool session id is the seat.
    const plain = await join(credential, { tool: "plain-1" });
    expect((await join(credential, { tool: "plain-1" })).body.agentId).toBe(plain.body.agentId);
    expect((await join(credential, { tool: "plain-2" })).body.agentId).not.toBe(plain.body.agentId);
  });

  it("10 concurrent first requests from one new session create exactly one agent", async () => {
    const w = workspace();
    const { credential, deviceId } = await device(w.operatorKey);
    const session = { tool: "burst-tool", host: "burst-host", project: "Burst" };
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      i % 2 ? join(credential, session) : call("GET", "/v1/me", { key: credential, session }).then(async (r) => ({ status: r.status, body: await r.json() })),
    ));
    expect(results.map((r) => r.status).every((s) => s === 200 || s === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.agentId)).size).toBe(1);
    expect(sessionCount(deviceId)).toBe(1);
  });

  it("a resolve-only request never creates or revives a session agent", async () => {
    const w = workspace();
    const { credential, deviceId } = await device(w.operatorKey);
    const unknown = { tool: "helper-tool", resolveOnly: true };
    for (const [method, path] of [["GET", "/v1/me"], ["POST", "/v1/sessions/join"], ["GET", "/v1/messages?peek=true"]] as const) {
      const res = await call(method, path, { key: credential, session: unknown, ...(method === "POST" ? { body: {} } : {}) });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("no OpenCadre session for this chat yet");
    }
    // The JSON body form of join.
    const viaBody = await call("POST", "/v1/sessions/join", { key: credential, body: { toolSessionId: "helper-tool", hostSessionId: "helper-host", resolveOnly: true } });
    expect(viaBody.status).toBe(401);
    // MCP too.
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "x-opencadre-session": "helper-tool", "x-opencadre-resolve-only": "1", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect(mcp.status).toBe(401);
    expect(sessionCount(deviceId)).toBe(0);

    // Once the session exists, resolve-only finds it; after it ends, resolve-only doesn't bring it back.
    const created = await join(credential, { tool: "real-tool", host: "real-host" });
    const found = await call("GET", "/v1/me", { key: credential, session: { tool: "real-tool", host: "real-host", resolveOnly: true } });
    expect(((await found.json()) as { agentId: string }).agentId).toBe(created.body.agentId);
    await call("POST", "/v1/sessions/leave", { key: credential, session: { tool: "real-tool", host: "real-host" } });
    expect((await call("GET", "/v1/me", { key: credential, session: { tool: "real-tool", host: "real-host", resolveOnly: true } })).status).toBe(401);
    expect(agentRow(created.body.agentId).ended_at).not.toBeNull();
    expect(sessionCount(deviceId)).toBe(1);
  });

  it("a request without a host session id resolves to the live agent holding its tool session id", async () => {
    const w = workspace();
    const { credential, deviceId } = await device(w.operatorKey);
    // The chat's MCP proxy: host H1, tool T1.
    const proxy = await join(credential, { tool: "T1", host: "H1", project: "OpenCadre" });
    expect(proxy.body.created).toBe(true);
    // A hook process without CLAUDE_CODE_HOST_SESSION_ID: tool T1 only, resolve-only or not.
    const hookOnly = await call("GET", "/v1/me", { key: credential, session: { tool: "T1", project: "OpenCadre", resolveOnly: true } });
    expect(hookOnly.status).toBe(200);
    expect(((await hookOnly.json()) as { agentId: string }).agentId).toBe(proxy.body.agentId);
    expect((await join(credential, { tool: "T1", project: "OpenCadre" })).body).toEqual({ agentId: proxy.body.agentId, agentName: proxy.body.agentName, created: false });
    expect(sessionCount(deviceId)).toBe(1);
    expect(agentRow(proxy.body.agentId).seat_id).toBe("H1");

    // Leave without the host id ends that same agent.
    expect(await (await call("POST", "/v1/sessions/leave", { key: credential, session: { tool: "T1", project: "OpenCadre" } })).json()).toEqual({ ok: true, ended: true });
    expect(agentRow(proxy.body.agentId).ended_at).not.toBeNull();
  });

  it("never guesses between two live agents holding the same tool session id", async () => {
    const w = workspace();
    const { credential, deviceId } = await device(w.operatorKey);
    await join(credential, { tool: "dup-tool", host: "window-a" });
    await join(credential, { tool: "dup-tool", host: "window-b" });
    expect((await call("GET", "/v1/me", { key: credential, session: { tool: "dup-tool", resolveOnly: true } })).status).toBe(401);
    expect(sessionCount(deviceId)).toBe(2);
  });

  it("caps live sessions per device", async () => {
    process.env.OPENCADRE_MAX_SESSIONS_PER_DEVICE = "2";
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    expect((await join(credential, { tool: "cap-1" })).status).toBe(201);
    expect((await join(credential, { tool: "cap-2" })).status).toBe(201);
    expect((await join(credential, { tool: "cap-3" })).status).toBe(429);
    expect((await join(credential, { tool: "cap-1" })).status).toBe(200);
  });
});

describe("MCP", () => {
  it("initialize and get_active_agents with a device credential and session header act as, and heartbeat, that session", async () => {
    const w = workspace();
    const { credential, deviceId } = await device(w.operatorKey);
    const session = { "x-opencadre-session": "mcp-tool", "x-opencadre-host-session": "mcp-host", "x-opencadre-project": "McpRepo" };
    const joined = await join(credential, { tool: "mcp-tool", host: "mcp-host", project: "McpRepo" });
    db.prepare(`UPDATE agents SET last_heartbeat_at = '2000-01-01 00:00:00' WHERE id = ?`).run(joined.body.agentId);

    const client = new Client({ name: "sessions-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${credential}`, ...session } },
    }));
    try {
      const result = (await client.callTool({ name: "get_active_agents", arguments: {} })) as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain(joined.body.agentName);
    } finally {
      await client.close();
    }
    expect(agentRow(joined.body.agentId).last_heartbeat_at).not.toBe("2000-01-01 00:00:00");
    expect(sessionCount(deviceId)).toBe(1);

    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    const noSession = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(init),
    });
    expect(noSession.status).toBe(401);
  });
});

describe("revoking a device", () => {
  it("ends its sessions and cuts off its requests at once, including a held long-poll", async () => {
    const w = workspace();
    const { credential, deviceId } = await device(w.operatorKey);
    const a = await join(credential, { tool: "revoke-a" });
    await join(credential, { tool: "revoke-b" });
    const wait = call("GET", "/v1/messages/wait?timeoutSeconds=30", { key: credential, session: { tool: "revoke-a" } });
    for (let i = 0; i < 200 && heldRequestCount(a.body.agentId) === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(heldRequestCount(a.body.agentId)).toBe(1);

    const started = Date.now();
    const revoked = await call("DELETE", `/v1/org/devices/${deviceId}`, { key: w.operatorKey });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ ok: true, endedSessions: 2, alreadyRevoked: false });
    expect((await wait).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(5000);

    expect((await call("GET", "/v1/me", { key: credential, session: { tool: "revoke-a" } })).status).toBe(401);
    expect((await join(credential, { tool: "brand-new" })).status).toBe(401);
    expect(sessionCount(deviceId)).toBe(2);
    const ended = (await (await call("GET", "/v1/org/sessions?status=ended", { key: w.operatorKey })).json()) as { sessions: Array<{ deviceId: string }> };
    expect(ended.sessions.filter((s) => s.deviceId === deviceId)).toHaveLength(2);
    const live = (await (await call("GET", "/v1/org/sessions", { key: w.operatorKey })).json()) as { sessions: unknown[] };
    expect(live.sessions).toEqual([]);

    const again = await call("DELETE", `/v1/org/devices/${deviceId}`, { key: w.operatorKey });
    expect(await again.json()).toMatchObject({ ok: true, alreadyRevoked: true, endedSessions: 0 });
    expect((await call("DELETE", "/v1/org/devices/no-such-device", { key: w.operatorKey })).status).toBe(404);
  });

  it("?since= limits ended sessions to those that ended at or after it (bug B2: the console sent every one, every poll)", async () => {
    const w = workspace();
    const { credential, deviceId } = await device(w.operatorKey);
    const recent = await join(credential, { tool: "since-recent" });
    const old = await join(credential, { tool: "since-old" });
    expect((await call("DELETE", `/v1/org/devices/${deviceId}`, { key: w.operatorKey })).status).toBe(200);
    // One of the two ended three days ago.
    db.prepare(`UPDATE agents SET ended_at = datetime('now', '-3 days') WHERE id = ?`).run(old.body.agentId);
    const ended = async (query: string) => ((await (await call("GET", `/v1/org/sessions?status=ended${query}`, { key: w.operatorKey })).json()) as { sessions: Array<{ agentId: string }> })
      .sessions.map((s) => s.agentId).filter((id) => id === recent.body.agentId || id === old.body.agentId).sort();
    const dayAgo = encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString());
    expect(await ended("")).toEqual([recent.body.agentId, old.body.agentId].sort());
    expect(await ended(`&since=${dayAgo}`)).toEqual([recent.body.agentId]);
    expect((await call("GET", "/v1/org/sessions?status=ended&since=yesterday-ish", { key: w.operatorKey })).status).toBe(400);
  });
});

describe("paused workspace", () => {
  it("refuses device sessions with 423 and leaves agent-key behaviour exactly as before", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    const pending = await mintDevice(w.operatorKey);
    const session = { tool: "paused-tool" };
    await join(credential, session);

    expect((await call("GET", "/v1/me", { key: w.coder.key })).status).toBe(200);
    expect((await call("POST", "/v1/org/pause", { key: w.operatorKey })).status).toBe(200);

    expect((await call("GET", "/v1/me", { key: credential, session })).status).toBe(423);
    expect((await join(credential, session)).status).toBe(423);
    expect((await redeem(pending.body.code)).status).toBe(423);
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "x-opencadre-session": "paused-tool", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(mcp.status).toBe(423);
    // Agent keys: unchanged. A named agent gets 423, the operator keeps access.
    expect((await call("GET", "/v1/me", { key: w.coder.key })).status).toBe(423);
    expect((await call("GET", "/v1/me", { key: w.operatorKey })).status).toBe(200);

    expect((await call("POST", "/v1/org/resume", { key: w.operatorKey })).status).toBe(200);
    expect((await call("GET", "/v1/me", { key: credential, session })).status).toBe(200);
    expect((await call("GET", "/v1/me", { key: w.coder.key })).status).toBe(200);
    expect((await redeem(pending.body.code)).status).toBe(201);
  });
});

describe("idle sweep and rejoining", () => {
  it("ends a session idle past the TTL, leaves named agents to their own sweep, and revives a seat that ended within the TTL", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    const idle = await join(credential, { tool: "idle-tool", host: "idle-host" });
    const busy = await join(credential, { tool: "busy-tool" });
    db.prepare(`UPDATE agents SET last_heartbeat_at = datetime('now', '-13 hours') WHERE id = ?`).run(idle.body.agentId);

    // The named-agent sweep never touches sessions.
    sweepStaleAgents(Date.now() + 24 * 3_600_000);
    expect(agentRow(idle.body.agentId).status).toBe("active");

    const swept = sweepIdleSessions();
    expect(swept.ended).toContain(idle.body.agentId);
    expect(swept.ended).not.toContain(busy.body.agentId);
    expect(agentRow(idle.body.agentId).ended_at).not.toBeNull();
    const roster = (await (await call("GET", "/v1/agents", { key: w.coder.key })).json()) as { agents: Array<{ id: string }> };
    expect(roster.agents.map((a) => a.id)).not.toContain(idle.body.agentId);
    expect(roster.agents.map((a) => a.id)).toContain(busy.body.agentId);
    expect(sweepIdleSessions().ended).not.toContain(idle.body.agentId);

    // Ended moments ago: the same seat comes back as the same agent, with its name and inbox.
    const back = await join(credential, { tool: "idle-tool-2", host: "idle-host" });
    expect(back.body).toEqual({ agentId: idle.body.agentId, agentName: idle.body.agentName, created: false });
    expect(agentRow(idle.body.agentId).ended_at).toBeNull();
  });

  it("gives a seat that ended longer ago than the TTL to a new agent, keeping the old one's history", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    const old = await join(credential, { tool: "old-tool", host: "old-host" });
    db.prepare(`UPDATE agents SET ended_at = datetime('now', '-13 hours') WHERE id = ?`).run(old.body.agentId);

    const fresh = await join(credential, { tool: "new-tool", host: "old-host" });
    expect(fresh.body.created).toBe(true);
    expect(fresh.body.agentId).not.toBe(old.body.agentId);
    expect(fresh.body.agentName).not.toBe(old.body.agentName);
    expect(agentRow(old.body.agentId)).toMatchObject({ seat_id: null, ended_at: expect.any(String) });
    expect(agentRow(fresh.body.agentId).seat_id).toBe("old-host");
  });

  it("a CHAT-PROVEN seat comes back as the same agent even days after it ended, with its name and inbox", async () => {
    // Measured: one Codex chat (same thread UUID, same credential) was renamed after a ~3-day idle gap, orphaning every
    // thread addressed to its old name. The seat is the chat's own id, so it names one chat, however long ago it ended.
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    const chat = await join(credential, { tool: "chat-tool", host: "chat-host" });
    // liveness = 'chat' is what the product sets on a seat's first tools/call (promoteToChat).
    db.prepare(`UPDATE agents SET liveness = 'chat', ended_at = datetime('now', '-72 hours') WHERE id = ?`).run(chat.body.agentId);

    const back = await join(credential, { tool: "chat-tool-2", host: "chat-host" });
    expect(back.body).toEqual({ agentId: chat.body.agentId, agentName: chat.body.agentName, created: false });
    expect(agentRow(chat.body.agentId)).toMatchObject({ seat_id: "chat-host", ended_at: null });
  });

  it("a chat-proven revival is still a create: the device's session cap refuses it, and the row stays ended", async () => {
    process.env.OPENCADRE_MAX_SESSIONS_PER_DEVICE = "1";
    const w = workspace();
    const { credential, deviceId } = await device(w.operatorKey);
    const chat = await join(credential, { tool: "cap-chat-tool", host: "cap-chat-host" });
    db.prepare(`UPDATE agents SET liveness = 'chat', ended_at = datetime('now', '-72 hours') WHERE id = ?`).run(chat.body.agentId);
    const ended = agentRow(chat.body.agentId).ended_at;
    expect((await join(credential, { tool: "cap-other-tool" })).status).toBe(201);

    expect((await join(credential, { tool: "cap-chat-tool-2", host: "cap-chat-host" })).status).toBe(429);
    expect(agentRow(chat.body.agentId)).toMatchObject({ seat_id: "cap-chat-host", ended_at: ended });
    expect(sessionCount(deviceId)).toBe(2);
  });

  it("a chat-proven revival is still a create: the plan's live-agent limit refuses it (plan_limit), and the row stays ended", async () => {
    const w = workspace();
    const { credential, deviceId } = await device(w.operatorKey);
    const chat = await join(credential, { tool: "limit-chat-tool", host: "limit-chat-host" });
    db.prepare(`UPDATE agents SET liveness = 'chat', ended_at = datetime('now', '-72 hours') WHERE id = ?`).run(chat.body.agentId);
    const ended = agentRow(chat.body.agentId).ended_at;
    // A capped plan, filled to exactly its limit with live agents (the ended session is not one of them).
    assignPlan(w.orgId, "pro");
    const billing = workspaceBilling(w.orgId);
    const allowed = billing.limits.maxAgents! * billing.seats;
    for (let i = countLiveAgents(w.orgId); i < allowed; i++) {
      db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(new Date().toISOString(), registerAgent(w.orgId, `Filler ${i}`).agentId);
    }
    expect(countLiveAgents(w.orgId), "fixture: the workspace is exactly at its limit").toBe(allowed);

    const revived = await join(credential, { tool: "limit-chat-tool-2", host: "limit-chat-host" });
    expect(revived.status).toBe(402);
    expect((revived.body as unknown as { code: string }).code).toBe(PLAN_LIMIT_CODE);
    expect(agentRow(chat.body.agentId)).toMatchObject({ seat_id: "limit-chat-host", ended_at: ended });
    expect(sessionCount(deviceId)).toBe(1);
  });

  it("honours OPENCADRE_SESSION_TTL_HOURS", async () => {
    process.env.OPENCADRE_SESSION_TTL_HOURS = "1";
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    const s = await join(credential, { tool: "ttl-tool" });
    db.prepare(`UPDATE agents SET last_heartbeat_at = datetime('now', '-2 hours') WHERE id = ?`).run(s.body.agentId);
    expect(sweepIdleSessions().ended).toContain(s.body.agentId);
  });
});

describe("ended sessions", () => {
  it("leave ends the seat, mail to it is refused, and it leaves the roster", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    const s = await join(credential, { tool: "leaving-tool", host: "leaving-host" });

    const left = await call("POST", "/v1/sessions/leave", { key: credential, session: { tool: "leaving-tool", host: "leaving-host" } });
    expect(await left.json()).toEqual({ ok: true, ended: true });
    const twice = await call("POST", "/v1/sessions/leave", { key: credential, body: { toolSessionId: "leaving-tool", hostSessionId: "leaving-host" } });
    expect(await twice.json()).toEqual({ ok: true, ended: false });
    // Leaving a seat that never existed creates nothing.
    const before = db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number };
    expect(await (await call("POST", "/v1/sessions/leave", { key: credential, session: { tool: "never-joined" } })).json()).toEqual({ ok: true, ended: false });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agents`).get()).toEqual(before);

    const refused = await call("POST", "/v1/messages", { key: w.coder.key, body: { toAgent: s.body.agentName, body: "anyone there?" } });
    expect(refused.status).toBe(410);
    expect(((await refused.json()) as { error: string }).error).toBe("that session has ended");
    expect((await call("POST", "/v1/questions", { key: w.coder.key, body: { toAgent: s.body.agentId, body: "?" } })).status).toBe(410);
    const roster = (await (await call("GET", "/v1/agents", { key: w.coder.key })).json()) as { agents: Array<{ id: string }> };
    expect(roster.agents.map((a) => a.id)).not.toContain(s.body.agentId);
  });
});

describe("naming", () => {
  it("reduces the project to a safe folder name", () => {
    expect(sanitizeProject("OpenCadre")).toBe("OpenCadre");
    expect(sanitizeProject("C:\\Users\\someone\\My Project!")).toBe("My-Project");
    expect(sanitizeProject("/home/someone/repos/.dotfiles/")).toBe("dotfiles");
    expect(sanitizeProject("a".repeat(60))).toHaveLength(40);
    expect(sanitizeProject("日本語")).toBeNull();
    expect(sanitizeProject("")).toBeNull();
    expect(sanitizeProject(undefined)).toBeNull();
  });

  it("labels the client from the device, or from the header for an auto device", () => {
    expect(clientLabel("claude-code")).toBe("ClaudeCode");
    expect(clientLabel("claude-code", "codex")).toBe("ClaudeCode");
    expect(clientLabel("auto", "cursor")).toBe("Cursor");
    expect(clientLabel("auto", "Antigravity")).toBe("Antigravity");
    expect(clientLabel("auto")).toBe("Agent");
    // DeepSeek Harness. Measured against the live hub from inside a DSH session: with no entry here the
    // label fell through to "Agent" and a DSH chat was named `Agent-OpenCadre-e4f2`. The same map decides
    // `sessionTool`, so the absence also left the session with no tool.
    expect(clientLabel("auto", "dsh")).toBe("DSH");
    expect(clientLabel("dsh")).toBe("DSH");
    expect(sessionTool("auto", "dsh")).toBe("dsh");
    // OpenCode, the same gap found the same way (2026-09-23): a live OpenCode chat joined as `Agent-OpenCadre-efc1`
    // with tool null. Its proxy sends the client header `opencode`; the label and the recorded tool follow it.
    expect(clientLabel("auto", "opencode")).toBe("OpenCode");
    expect(clientLabel("opencode")).toBe("OpenCode");
    expect(sessionTool("auto", "opencode")).toBe("opencode");
    // The fallback still applies to a client the hub genuinely does not know.
    expect(clientLabel("auto", "notepad")).toBe("Agent");
    expect(sessionTool("auto", "notepad")).toBeNull();
  });

  it("labels a DeepSeek Harness session DSH, not Agent, on its row and in the roster; its name is just a word", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey, "dsh");
    const joined = (await join(credential, { tool: "named-project" })).body;
    // The name no longer carries the client (sessions PR1): the row and the roster line do.
    expect(joined.agentName).toMatch(WORD_NAME);
    expect(sessionFields(w.orgId, joined.agentName)).toMatchObject({ client: "dsh", project_name: "SessTest" });
    const roster = await rosterAs(w.coder.key);
    expect(roster).toContain(`${joined.agentName} (DSH in SessTest) — `);
    expect(roster).not.toContain("(Agent in ");
  });

  it("accepts DeepSeek Harness as a connectable client, where it used to be rejected outright", async () => {
    const w = workspace();
    // Before `dsh` joined CONNECT_CLIENTS the hub answered 400 for it, so `opencadre connect --client dsh`
    // could not mint the computer's tool at all — the capability was unreachable, not merely unlabelled.
    expect((await mintDevice(w.operatorKey, { name: "DeepSeek Harness on PC-2", client: "dsh" })).status).toBe(201);
    expect((await mintDevice(w.operatorKey, { name: "x", client: "notepad" })).status).toBe(400);
  });

  it("names a session with one word, keeps its project's display name on the row, and retries a taken word, then two words, then a number", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey, "gemini");
    const joined = (await join(credential, { tool: "named-project" })).body;
    expect(NAME_WORDS).toContain(joined.agentName);
    expect(sessionFields(w.orgId, joined.agentName)).toEqual({ client: "gemini", project: DEFAULT_PROJECT.key, project_name: "SessTest" });

    // In a workspace of its own, so the word the join drew above can't collide with the words injected here.
    const v = workspace();
    expect(buildSessionName(v.orgId, () => "Birch")).toBe("Birch");
    // A taken word (ignoring case) is retried with another word.
    registerAgent(v.orgId, "birch");
    const words = ["Birch", "Birch", "Wren"];
    expect(buildSessionName(v.orgId, () => words.shift()!)).toBe("Wren");
    // Twenty draws all taken: two words.
    const pairs = [...Array<string>(20).fill("Birch"), "Birch", "Wren"];
    expect(buildSessionName(v.orgId, () => pairs.shift()!)).toBe("Birch Wren");
    // A pair of one word twice is never used, so with only a taken word to draw from: a word and a number.
    expect(buildSessionName(v.orgId, () => "Birch")).toBe("Birch 2");
  });

  it("only a signed-in person can name a session, into a profile (Reviewer #1), and it keeps resolving to the same agent", async () => {
    const w = workspace();
    const { credential } = await device(w.operatorKey);
    const s = await join(credential, { tool: "rename-tool" });
    const path = `/v1/org/sessions/${s.body.agentId}`;
    // Naming is person-only: an agent key and the Operator key are both refused.
    expect((await call("PATCH", path, { key: w.coder.key, body: { name: "Reviewer" } })).status).toBe(403);
    expect((await call("PATCH", path, { key: w.operatorKey, body: { name: "Reviewer" } })).status).toBe(403);
    const person = await signInPerson(w.orgId);
    const name = (route: string, profile: string) =>
      fetch(`${base}${route}`, { method: "PATCH", headers: person.headers, body: JSON.stringify({ name: profile }) });
    expect((await name(path, "Coder")).status).toBe(409);
    expect((await name(`/v1/org/sessions/${w.coder.id}`, "Reviewer")).status).toBe(404);
    const renamed = await name(path, "Reviewer");
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({
      agentId: s.body.agentId, agentName: "Reviewer #1", previousName: s.body.agentName,
      profile: { id: expect.any(String), name: "Reviewer" }, note: expect.stringContaining("Reviewer #1"),
    });
    // Already a chat of that profile, in any case: refused, and the address stays.
    expect((await name(path, "REVIEWER")).status).toBe(409);
    expect((await join(credential, { tool: "rename-tool" })).body).toMatchObject({ agentId: s.body.agentId, agentName: "Reviewer #1" });

    const listed = (await (await call("GET", "/v1/org/sessions?status=live", { key: w.operatorKey })).json()) as { sessions: Array<Record<string, unknown>> };
    expect(listed.sessions).toEqual([expect.objectContaining({ agentId: s.body.agentId, agentName: "Reviewer #1", profileName: "Reviewer", client: "claude-code", online: true, endedAt: null })]);
    expect(JSON.stringify(listed)).not.toContain("rename-tool");
    expect((await call("GET", "/v1/org/sessions?status=gone", { key: w.operatorKey })).status).toBe(400);

    // A second chat: the first one's old name is still held (never reassigned), and naming it Reviewer numbers it #2.
    const t = await join(credential, { tool: "rename-tool-2" });
    const second = `/v1/org/sessions/${t.body.agentId}`;
    expect((await name(second, s.body.agentName)).status).toBe(409);
    expect(await (await name(second, "Reviewer")).json()).toMatchObject({ agentId: t.body.agentId, agentName: "Reviewer #2" });
  });
});
