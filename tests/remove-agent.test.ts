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
import { authenticateAgentKey, hashKey } from "../src/auth.js";
import { heldRequestCount } from "../src/revocation.js";
import { db } from "../src/db.js";
import { createOrganization, heartbeat, registerAgent, sweepStaleAgents } from "../src/service.js";
import { createSession, createWorkspace, getMembership, upsertPerson } from "../src/accounts.js";
import { signInPerson } from "./helpers/person.js";

/** Removing an agent (DELETE /v1/org/agents/:agentId) is revocation: its key, its held requests and its live socket
 * stop at once, it leaves every roster, and its history stays readable. Real app over HTTP, REST + MCP + /live. */

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

afterAll(() => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
}));

let orgCounter = 0;
function workspace() {
  const { orgId } = createOrganization(`Remove Org ${++orgCounter}`);
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const coder = registerAgent(orgId, "Coder");
  const other = registerAgent(orgId, "Other");
  return {
    orgId,
    operator: { id: operator.agentId, key: operator.apiKey },
    coder: { id: coder.agentId, key: coder.apiKey },
    other: { id: other.agentId, key: other.apiKey },
  };
}

type Headers = Record<string, string>;
function call(method: string, path: string, { key, body, headers = {} }: { key?: string; body?: unknown; headers?: Headers } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const remove = (agentId: string, key: string) => call("DELETE", `/v1/org/agents/${agentId}`, { key });

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function mcpClient(key: string, headers: Headers = {}) {
  const client = new Client({ name: "remove-agent-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}`, ...headers } } }));
  return client;
}

const agentRow = (agentId: string) =>
  db.prepare(`SELECT api_key_hash, removed_at, removed_by_agent_name, ended_at FROM agents WHERE id = ?`).get(agentId) as {
    api_key_hash: string; removed_at: string | null; removed_by_agent_name: string | null; ended_at: string | null;
  };

describe("removing an agent revokes it at once", () => {
  it("refuses its key, ends its held long-poll with 401 and closes its live socket; everyone else keeps working", async () => {
    const w = workspace();
    const socket = new WebSocket(`${wsBase}/live?apiKey=${w.coder.key}`);
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    const otherWait = call("GET", "/v1/messages/wait?timeoutSeconds=30", { key: w.other.key });
    const wait = call("GET", "/v1/messages/wait?timeoutSeconds=30", { key: w.coder.key });
    await until(() => heldRequestCount(w.coder.id) === 1 && heldRequestCount(w.other.id) === 1, "the long-polls to be held");

    const started = Date.now();
    const res = await remove(w.coder.id, w.operator.key);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, agentId: w.coder.id, agentName: "Coder" });

    const ended = await wait;
    expect(ended.status).toBe(401);
    expect(((await ended.json()) as { error: string }).error).toMatch(/removed/);
    expect(await closed).toBe(4001);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(heldRequestCount(w.coder.id)).toBe(0);

    expect(authenticateAgentKey(w.coder.key)).toBeNull();
    expect((await call("GET", "/v1/me", { key: w.coder.key })).status).toBe(401);
    await expect(mcpClient(w.coder.key)).rejects.toThrow(/401|invalid/i);
    const reopened = new WebSocket(`${wsBase}/live?apiKey=${w.coder.key}`);
    expect(await new Promise<number>((resolve) => reopened.once("close", (code) => resolve(code)))).toBe(4001);

    // Only the identity is retired: the row stays, with an unmatchable key hash and who removed it.
    const row = agentRow(w.coder.id);
    expect(row.api_key_hash).not.toBe(hashKey(w.coder.key));
    expect(row.api_key_hash).not.toMatch(/^[0-9a-f]{64}$/);
    expect(row.removed_at).toBeTruthy();
    expect(row.removed_by_agent_name).toBe("Operator");
    const event = db.prepare(`SELECT actor_agent_name, subject_id, payload FROM events WHERE org_id = ? AND type = 'agent.removed'`).get(w.orgId) as
      { actor_agent_name: string; subject_id: string; payload: string };
    expect(event).toMatchObject({ actor_agent_name: "Operator", subject_id: w.coder.id });
    expect(JSON.parse(event.payload)).toEqual({ agentName: "Coder" });

    // The other agent's held wait was untouched and its key still works.
    expect(heldRequestCount(w.other.id)).toBe(1);
    await call("POST", "/v1/messages", { key: w.operator.key, body: { toAgent: "Other", body: "still here" } });
    const otherResult = await otherWait;
    expect(otherResult.status).toBe(200);
    expect(JSON.stringify(await otherResult.json())).toContain("still here");
    expect((await call("GET", "/v1/me", { key: w.other.key })).status).toBe(200);

    // A removed agent's key can't be brought back by rotating it, and a wait still finishing in the background doesn't revive its liveness.
    expect((await call("POST", `/v1/org/agents/${w.coder.id}/rotate-key`, { key: w.operator.key })).status).toBe(404);
    const before = db.prepare(`SELECT last_heartbeat_at, status FROM agents WHERE id = ?`).get(w.coder.id);
    heartbeat(w.orgId, w.coder.id);
    expect(db.prepare(`SELECT last_heartbeat_at, status FROM agents WHERE id = ?`).get(w.coder.id)).toEqual(before);
  });

  it("leaves every roster and name lookup, keeps its history readable, and frees its name", async () => {
    const w = workspace();
    const sent = (await (await call("POST", "/v1/messages", { key: w.coder.key, body: { toAgent: "Other", body: "hello from Coder" } })).json()) as { threadId: string };
    expect((await remove(w.coder.id, w.operator.key)).status).toBe(200);

    const { agents } = (await (await call("GET", "/v1/agents", { key: w.other.key })).json()) as { agents: Array<{ id: string; name: string }> };
    expect(agents.map((a) => a.name).sort()).toEqual(["Operator", "Other"]);

    const client = await mcpClient(w.other.key);
    try {
      const result = (await client.callTool({ name: "get_active_agents", arguments: {} })) as { content: Array<{ text: string }> };
      const text = result.content.map((c) => c.text).join("\n");
      expect(text).toContain("Other");
      expect(text).not.toContain("Coder");
    } finally {
      await client.close();
    }

    for (const toAgent of ["Coder", w.coder.id]) {
      const res = await call("POST", "/v1/messages", { key: w.other.key, body: { toAgent, body: "anyone there?" } });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toMatch(/No agent found/);
    }

    // The other party still reads what the removed agent sent, under its name.
    const inbox = (await (await call("GET", "/v1/messages", { key: w.other.key })).json()) as { messages: Array<{ from_agent_id: string; from_agent_name: string; body: string }> };
    expect(inbox.messages).toMatchObject([{ from_agent_id: w.coder.id, from_agent_name: "Coder", body: "hello from Coder" }]);
    const status = await call("GET", `/v1/messages/${sent.threadId}/status`, { key: w.other.key });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ messages: [{ from: "Coder", to: "Other" }] });

    // Its name is never handed to anyone else (sessions PR1, Codex's ruling: an address, once held, is never reassigned),
    // so a late message, or a config still naming Coder, can't reach a new agent. Set up again, it takes a new name.
    expect((await call("POST", "/v1/org/agents", { key: w.operator.key, body: { name: "Coder" } })).status).toBe(409);
    const again = await call("POST", "/v1/org/agents", { key: w.operator.key, body: { name: "Coder Two" } });
    expect(again.status).toBe(201);
    const fresh = (await again.json()) as { agentId: string };
    expect(fresh.agentId).not.toBe(w.coder.id);
    expect((await call("POST", "/v1/messages", { key: w.other.key, body: { toAgent: "Coder", body: "welcome back" } })).status).not.toBe(201);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE org_id = ? AND body = 'welcome back'`).get(w.orgId)).toEqual({ n: 0 });
  });

  it("refuses a removed row's key even if its hash still matched (the two layers are independent)", () => {
    const w = workspace();
    db.prepare(`UPDATE agents SET removed_at = datetime('now') WHERE id = ?`).run(w.coder.id);
    expect(authenticateAgentKey(w.coder.key)).toBeNull();
    expect(authenticateAgentKey(w.other.key)?.agentId).toBe(w.other.id);
  });

  it("drops out of the stale-agent sweep", async () => {
    const w = workspace();
    db.prepare(`UPDATE agents SET last_heartbeat_at = datetime('now', '-2 days') WHERE org_id = ?`).run(w.orgId);
    expect((await remove(w.coder.id, w.operator.key)).status).toBe(200);
    const { suspended } = sweepStaleAgents();
    expect(suspended).toContain(w.other.id);
    expect(suspended).not.toContain(w.coder.id);
  });
});

describe("what can't be removed, and who can remove", () => {
  it("refuses yourself (400), an unknown id (404), a repeat (404) and a non-operator (403)", async () => {
    const w = workspace();
    const self = await remove(w.operator.id, w.operator.key);
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({ error: "you can't remove yourself" });

    const notOperator = await remove(w.other.id, w.coder.key);
    expect(notOperator.status).toBe(403);
    expect(authenticateAgentKey(w.other.key)?.agentId).toBe(w.other.id);

    expect((await remove("00000000-0000-4000-8000-000000000000", w.operator.key)).status).toBe(404);
    expect((await remove(w.coder.id, w.operator.key)).status).toBe(200);
    expect((await remove(w.coder.id, w.operator.key)).status).toBe(404);
  });

  it("refuses a person's member agent, and lets a signed-in owner remove an agent", async () => {
    process.env.OPENCADRE_SIGNUP = "open";
    // The cardless trial mode, pinned for the create: this is about removing agents from a WORKING workspace. Under the
    // card-required default a new workspace is "No plan yet" and refuses every product write, removal included
    // (tests/card-trial.test.ts).
    process.env.OPENCADRE_TRIAL_MODE = "cardless";
    const person = upsertPerson({ id: "remove-owner", email: "remove-owner@example.com", emailVerified: true, name: "Olive", avatarUrl: null });
    const { orgId } = createWorkspace(person, "Remove Members Co");
    delete process.env.OPENCADRE_SIGNUP;
    delete process.env.OPENCADRE_TRIAL_MODE;
    const memberAgentId = getMembership(orgId, person.id)!.agent_id;
    const owner = { cookie: `oc_session=${createSession(person.id).token}`, "x-opencadre-workspace": orgId };
    const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
    const coder = registerAgent(orgId, "Coder");

    const member = await remove(memberAgentId, operator.apiKey);
    expect(member.status).toBe(400);
    expect(await member.json()).toEqual({ error: "remove the person under Settings → Members instead" });

    // A member agent whose person already left is still a person's row, not an agent to remove here.
    db.prepare(`UPDATE agents SET key_class = 'human' WHERE id = ?`).run(coder.agentId);
    expect((await remove(coder.agentId, operator.apiKey)).status).toBe(400);
    db.prepare(`UPDATE agents SET key_class = 'agent' WHERE id = ?`).run(coder.agentId);

    const ownSelf = await call("DELETE", `/v1/org/agents/${memberAgentId}`, { headers: owner });
    expect(ownSelf.status).toBe(400);
    const byOwner = await call("DELETE", `/v1/org/agents/${coder.agentId}`, { headers: owner });
    expect(byOwner.status).toBe(200);
    expect(authenticateAgentKey(coder.apiKey)).toBeNull();
    expect(agentRow(coder.agentId).removed_by_agent_name).toBe("Olive");
  });
});

describe("removing a session agent", () => {
  it("ends the session, cuts its held request, and that chat can't come back as a new agent", async () => {
    const w = workspace();
    const minted = (await (await call("POST", "/v1/org/devices", { key: w.operator.key, body: { name: "PC-9", client: "claude-code" } })).json()) as { code: string; deviceId: string };
    const { deviceCredential } = (await (await call("POST", "/v1/connect/redeem", { body: { code: minted.code } })).json()) as { deviceCredential: string };
    const project = { "x-opencadre-project": "local:RemoveRepo", "x-opencadre-project-name": "RemoveRepo" };
    expect((await call("PUT", "/v1/org/projects", { key: w.operator.key, body: { projectKey: project["x-opencadre-project"], enabled: true } })).status).toBe(200);
    const chat = { "x-opencadre-session": "remove-tool", "x-opencadre-host-session": "remove-host", ...project };
    const joined = (await (await call("POST", "/v1/sessions/join", { key: deviceCredential, headers: chat })).json()) as { agentId: string; agentName: string };

    const wait = call("GET", "/v1/messages/wait?timeoutSeconds=30", { key: deviceCredential, headers: chat });
    await until(() => heldRequestCount(joined.agentId) === 1, "the session's long-poll to be held");
    const res = await remove(joined.agentId, w.operator.key);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, agentId: joined.agentId, agentName: joined.agentName });
    expect((await wait).status).toBe(401);
    expect(agentRow(joined.agentId).ended_at).toBeTruthy();

    for (const status of ["live", "ended"]) {
      const { sessions } = (await (await call("GET", `/v1/org/sessions?status=${status}`, { key: w.operator.key })).json()) as { sessions: Array<{ agentId: string }> };
      expect(sessions.some((s) => s.agentId === joined.agentId)).toBe(false);
    }
    // Naming is a signed-in person's act (sessions PR1): a key is refused before the lookup, and the person finds nothing.
    expect((await call("PATCH", `/v1/org/sessions/${joined.agentId}`, { key: w.operator.key, body: { name: "Back" } })).status).toBe(403);
    const person = await signInPerson(w.orgId, "Ada");
    expect((await call("PATCH", `/v1/org/sessions/${joined.agentId}`, { headers: person.headers, body: { name: "Back" } })).status).toBe(404);

    // The same chat, even after /clear (new tool session id, same host session) or without its host id, is refused.
    const sessionAgents = () => (db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE device_id = ?`).get(minted.deviceId) as { n: number }).n;
    for (const headers of [chat, { ...chat, "x-opencadre-session": "remove-tool-2" }, { "x-opencadre-session": "remove-tool", ...project }]) {
      const again = await call("GET", "/v1/me", { key: deviceCredential, headers });
      expect(again.status).toBe(401);
      expect(((await again.json()) as { error: string }).error).toMatch(/removed this session/);
    }
    expect(sessionAgents()).toBe(1);

    // A new chat on the same machine joins as usual.
    const fresh = await call("POST", "/v1/sessions/join", { key: deviceCredential, headers: { "x-opencadre-session": "new-tool", "x-opencadre-host-session": "new-host", ...project } });
    expect(fresh.status).toBe(201);
    expect(sessionAgents()).toBe(2);
  });
});
