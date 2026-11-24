import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { authenticateAgentKey } from "../src/auth.js";
import { AgentNameError, createOrganization, registerAgent, rotateAgentKey } from "../src/service.js";
import { approveWaitlist, joinWaitlist, listWaitlist } from "../src/waitlist.js";
import { registerSocket } from "../src/live.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const call = (method: string, path: string, key?: string, body?: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

let orgCounter = 0;
function orgWithOperator() {
  const { orgId, bootstrapKey } = createOrganization(`Keys Org ${++orgCounter}`);
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const coder = registerAgent(orgId, "Coder");
  return { orgId, bootstrapKey, operator, coder };
}

describe("agent roles", () => {
  it("gives a waitlist-approved Operator the operator role and a normal agent the agent role", () => {
    joinWaitlist({ email: "roles@example.com", name: "Roles Co" }, null);
    const entry = listWaitlist().find((w) => w.email === "roles@example.com")!;
    const approved = approveWaitlist(entry.id);
    if (!approved.ok) throw new Error(approved.error);
    expect(authenticateAgentKey(approved.operatorKey)?.role).toBe("operator");
    expect(authenticateAgentKey(registerAgent(approved.orgId, "Plain").apiKey)?.role).toBe("agent");
  });

  it("includes the role on GET /v1/me", async () => {
    const { operator, coder } = orgWithOperator();
    expect((await (await call("GET", "/v1/me", operator.apiKey)).json()).role).toBe("operator");
    expect((await (await call("GET", "/v1/me", coder.apiKey)).json()).role).toBe("agent");
  });
});

describe("unique agent names", () => {
  it("rejects a duplicate name in the same org, ignoring case and surrounding whitespace", () => {
    const { orgId } = orgWithOperator();
    for (const dup of ["Coder", "coder", "  CODER  "]) {
      expect(() => registerAgent(orgId, dup)).toThrow(AgentNameError);
    }
    expect(() => registerAgent(createOrganization("Other").orgId, "Coder")).not.toThrow();
  });

  it("rejects empty, over-long and control-character names", () => {
    const { orgId } = orgWithOperator();
    for (const bad of ["", "   ", "x".repeat(81), "bad\nname", "tab\tname"]) {
      expect(() => registerAgent(orgId, bad)).toThrow(AgentNameError);
    }
    expect(() => registerAgent(orgId, "y".repeat(80))).not.toThrow();
  });

  it("stores the trimmed name", () => {
    const { orgId } = orgWithOperator();
    const { agentId } = registerAgent(orgId, "  Spaced  ");
    expect((db.prepare(`SELECT name FROM agents WHERE id = ?`).get(agentId) as { name: string }).name).toBe("Spaced");
  });

  it("gives distinct names whose url slugs clash distinct url keys instead of failing", () => {
    const { orgId } = orgWithOperator();
    const a = registerAgent(orgId, "Agent A");
    // Two distinct names whose slugs clash: a slug keeps only a-z and 0-9, so "Agent Ae" with an acute e is "agent-a"
    // too. ("Agent-A" and "Agent A!" are one name with "Agent A": separators, punctuation and signs are skipped.)
    const b = registerAgent(orgId, "Agent A\u00e9");
    expect(a.urlKey).not.toBe(b.urlKey);
  });

  it("returns 409 from POST /v1/agents for a duplicate", async () => {
    const { bootstrapKey } = orgWithOperator();
    const res = await call("POST", "/v1/agents", bootstrapKey, { name: " coder " });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "an agent named coder already exists" });
  });
});

describe("POST /v1/org/agents", () => {
  it("requires an agent key and the operator role", async () => {
    const { coder } = orgWithOperator();
    expect((await call("POST", "/v1/org/agents", undefined, { name: "New" })).status).toBe(401);
    const forbidden = await call("POST", "/v1/org/agents", coder.apiKey, { name: "New" });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "operator role required" });
  });

  it("creates an agent whose key authenticates, storing only the hash", async () => {
    const { orgId, operator } = orgWithOperator();
    const res = await call("POST", "/v1/org/agents", operator.apiKey, { name: "Codex-7F3K" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["agentId", "agentName", "apiKey"]);
    expect(body.apiKey).toMatch(/^agt_[0-9a-f]{48}$/);

    const me = await (await call("GET", "/v1/me", body.apiKey)).json();
    expect(me).toMatchObject({ agentId: body.agentId, agentName: "Codex-7F3K", orgId, role: "agent" });

    const rows = db.prepare(`SELECT * FROM agents`).all();
    expect(JSON.stringify(rows)).not.toContain(body.apiKey);
  });

  it("returns 409 for a duplicate and 400 for a missing name", async () => {
    const { operator } = orgWithOperator();
    const dup = await call("POST", "/v1/org/agents", operator.apiKey, { name: "CODER" });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe("an agent named CODER already exists");
    expect((await call("POST", "/v1/org/agents", operator.apiKey, {})).status).toBe(400);
  });
});

describe("POST /v1/org/agents/:agentId/rotate-key", () => {
  it("replaces the key so the old one stops working immediately", async () => {
    const { operator, coder } = orgWithOperator();
    const res = await call("POST", `/v1/org/agents/${coder.agentId}/rotate-key`, operator.apiKey);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ agentId: coder.agentId, agentName: "Coder", ownKey: false });
    expect(body.apiKey).not.toBe(coder.apiKey);
    expect((await call("GET", "/v1/me", coder.apiKey)).status).toBe(401);
    expect((await call("GET", "/v1/me", body.apiKey)).status).toBe(200);
  });

  it("lets an operator rotate its own key and says the session must switch", async () => {
    const { operator } = orgWithOperator();
    const body = await (await call("POST", `/v1/org/agents/${operator.agentId}/rotate-key`, operator.apiKey)).json();
    expect(body.ownKey).toBe(true);
    expect(body.note).toMatch(/new key/i);
    expect((await call("GET", "/v1/me", operator.apiKey)).status).toBe(401);
    expect((await (await call("GET", "/v1/me", body.apiKey)).json()).role).toBe("operator");
  });

  it("is scoped to the caller's org and requires the operator role", async () => {
    const mine = orgWithOperator();
    const theirs = orgWithOperator();
    expect((await call("POST", `/v1/org/agents/${theirs.coder.agentId}/rotate-key`, mine.operator.apiKey)).status).toBe(404);
    expect((await call("GET", "/v1/me", theirs.coder.apiKey)).status).toBe(200);
    expect((await call("POST", `/v1/org/agents/${mine.operator.agentId}/rotate-key`, mine.coder.apiKey)).status).toBe(403);
    expect((await call("POST", `/v1/org/agents/${mine.coder.agentId}/rotate-key`)).status).toBe(401);
  });

  it("records a timeline event with no key material", async () => {
    const { orgId, operator, coder } = orgWithOperator();
    const body = await (await call("POST", `/v1/org/agents/${coder.agentId}/rotate-key`, operator.apiKey)).json();
    const events = db.prepare(`SELECT * FROM events WHERE org_id = ?`).all(orgId) as Array<{ type: string; payload: string; subject_id: string }>;
    const rotated = events.find((e) => e.type === "agent.key_rotated");
    expect(rotated?.subject_id).toBe(coder.agentId);
    const hash = (db.prepare(`SELECT api_key_hash FROM agents WHERE id = ?`).get(coder.agentId) as { api_key_hash: string }).api_key_hash;
    for (const e of events) {
      for (const secret of [body.apiKey, coder.apiKey, hash, "agt_"]) expect(e.payload).not.toContain(secret);
    }
  });

  it("closes a live socket opened with the old key", () => {
    const { orgId, operator, coder } = orgWithOperator();
    const ws = { readyState: 1, OPEN: 1, on: vi.fn(), send: vi.fn(), close: vi.fn() };
    registerSocket(coder.agentId, ws as never);
    rotateAgentKey(orgId, { id: operator.agentId, name: "Operator" }, coder.agentId);
    expect(ws.close).toHaveBeenCalledWith(4001, expect.any(String));
  });
});

describe("GET /v1/agents", () => {
  it("includes each agent's role and never exposes key hashes or webhook secrets", async () => {
    const { orgId, operator } = orgWithOperator();
    db.prepare(`UPDATE agents SET webhook_url = 'https://example.com/hook', webhook_auth_header = 'Bearer secret' WHERE org_id = ?`).run(orgId);
    const { agents } = await (await call("GET", "/v1/agents", operator.apiKey)).json();
    expect(agents.map((a: { name: string; role: string }) => [a.name, a.role])).toEqual([["Coder", "agent"], ["Operator", "operator"]]);
    for (const a of agents) {
      expect(a).not.toHaveProperty("api_key_hash");
      expect(a).not.toHaveProperty("webhook_auth_header");
    }
    expect(JSON.stringify(agents)).not.toContain("secret");
  });
});

// A webhook secret is write-only: even its owner can only learn whether one is set,
// so a leaked agent key never also leaks the agent's webhook credential.
describe("GET /v1/me webhook fields", () => {
  it("reports webhook_url and webhook_auth_set but never the secret itself", async () => {
    const { orgId, operator } = orgWithOperator();
    const res0 = await (await call("GET", "/v1/me", operator.apiKey)).json();
    expect(res0).toMatchObject({ webhook_url: null, webhook_auth_set: false });

    db.prepare(`UPDATE agents SET webhook_url = 'https://example.com/hook', webhook_auth_header = 'Bearer secret' WHERE org_id = ? AND name = 'Operator'`).run(orgId);
    const res = await call("GET", "/v1/me", operator.apiKey);
    const me = await res.json();
    expect(me).toMatchObject({ webhook_url: "https://example.com/hook", webhook_auth_set: true });
    expect(JSON.stringify(me)).not.toContain("secret");
  });
});
