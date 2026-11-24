import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db } from "../src/db.js";
import { authenticateAgentKey, hashKey, isPausedWorkspaceKey } from "../src/auth.js";
import { createOrganization, registerAgent, rotateAgentKey } from "../src/service.js";
import { getMembership, removeMember, sessionPerson } from "../src/accounts.js";
import { signInPerson } from "./helpers/person.js";

// Isolated throwaway workspace fixtures only. Keys stay in memory; assertions never print them or their hashes.
let server: http.Server, base: string, serial = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/mcp" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        (req as typeof req & { body: unknown }).body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        void handleMcpRequest(req, res);
      });
    } else app(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
async function fixture(role: "owner" | "admin" | "member" = "member") {
  const { orgId } = createOrganization(`Member bearer ${++serial}`);
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const owner = await signInPerson(orgId, "Owner", "owner");
  const member = await signInPerson(orgId, "Person", role);
  return { orgId, operator, owner, member, target: getMembership(orgId, member.personId)!.agent_id };
}
const row = (id: string) => db.prepare("SELECT id, name, key_class, api_key_hash, removed_at FROM agents WHERE id = ?").get(id) as {
  id: string; name: string; key_class: string; api_key_hash: string; removed_at: string | null;
};
function legacyBearer(id: string) {
  const key = randomBytes(32).toString("hex");
  db.prepare("UPDATE agents SET api_key_hash = ? WHERE id = ?").run(hashKey(key), id);
  return key;
}
const bearerHeaders = (key: string) => ({ authorization: `Bearer ${key}` });
const actor = (f: Awaited<ReturnType<typeof fixture>>) => ({ id: f.owner.decider.id, name: f.owner.name, personId: f.owner.personId, memberRole: "owner" as const });

describe("person rows have no API bearer authority", () => {
  it.each(["owner", "admin", "member"] as const)("owner cannot rotate/issue a %s row key", async role => {
    const f = await fixture(role), before = row(f.target).api_key_hash;
    const rotated = rotateAgentKey(f.orgId, actor(f), f.target);
    expect(rotated === null).toBe(true);
    expect(row(f.target).api_key_hash === before).toBe(true);
    const response = await fetch(`${base}/v1/org/agents/${f.target}/rotate-key`, { method: "POST", headers: f.owner.headers });
    expect(response.status).toBe(404);
    const body = await response.json(); expect(typeof body.apiKey === "string").toBe(false);
  });
  it("also refuses an active member relation if the row class has legacy drift", async () => {
    const f = await fixture(); db.prepare("UPDATE agents SET key_class = 'agent' WHERE id = ?").run(f.target);
    const key = legacyBearer(f.target);
    expect(rotateAgentKey(f.orgId, actor(f), f.target) === null).toBe(true);
    expect(authenticateAgentKey(key) === null).toBe(true);
  });
  it.each(["owner", "admin", "member"] as const)("refuses historical %s bearer on fresh REST and MCP requests", async role => {
    const f = await fixture(role), key = legacyBearer(f.target);
    expect(authenticateAgentKey(key) === null).toBe(true);
    expect((await fetch(`${base}/v1/me`, { headers: bearerHeaders(key) })).status).toBe(401);
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { ...bearerHeaders(key), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_active_agents", arguments: {} } }) });
    expect(response.status).toBe(401);
    expect((await fetch(`${base}/v1/me`, { headers: f.member.headers })).status).toBe(200);
  });
  it("a retired human row without a remaining membership still cannot authenticate", async () => {
    const f = await fixture(), key = legacyBearer(f.target);
    db.prepare("DELETE FROM workspace_members WHERE org_id = ? AND person_id = ?").run(f.orgId, f.member.personId);
    expect(authenticateAgentKey(key) === null).toBe(true);
    expect(rotateAgentKey(f.orgId, actor(f), f.target) === null).toBe(true);
  });
  it("does not reveal paused-workspace classification for a refused human bearer", async () => {
    const f = await fixture(), key = legacyBearer(f.target);
    db.prepare("UPDATE organizations SET paused_at = datetime('now') WHERE id = ?").run(f.orgId);
    expect(authenticateAgentKey(key) === null).toBe(true);
    expect(isPausedWorkspaceKey(key)).toBe(false);
  });
});

describe("membership removal invalidates historical bearer but preserves person history", () => {
  it("invalidates the hash atomically and retains person session, agent and attributed history", async () => {
    const f = await fixture(), key = legacyBearer(f.target), before = row(f.target);
    const history = () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND actor_agent_id = ?").get(f.orgId, f.target) as { n: number }).n;
    const beforeHistory = history(); expect(beforeHistory > 0).toBe(true);
    removeMember(f.orgId, actor(f), f.member.personId);
    expect(getMembership(f.orgId, f.member.personId) === undefined).toBe(true);
    const after = row(f.target);
    expect(after.api_key_hash === hashKey(key)).toBe(false);
    expect({ id: after.id, name: after.name, key_class: after.key_class, removed_at: after.removed_at })
      .toEqual({ id: before.id, name: before.name, key_class: "human", removed_at: null });
    expect(history()).toBe(beforeHistory);
    const cookie = f.member.headers.cookie.split("=")[1];
    expect(sessionPerson(cookie)?.id).toBe(f.member.personId);
    expect((await fetch(`${base}/v1/me`, { headers: f.member.headers })).status === 200).toBe(false);
    expect((await fetch(`${base}/v1/me`, { headers: f.owner.headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/me`, { headers: bearerHeaders(key) })).status).toBe(401);
  });
  it("removal invalidation stands independently of human-class bearer refusal", async () => {
    const f = await fixture(), key = legacyBearer(f.target);
    db.prepare("UPDATE agents SET key_class = 'agent' WHERE id = ?").run(f.target);
    removeMember(f.orgId, actor(f), f.member.personId);
    expect(row(f.target).api_key_hash === hashKey(key)).toBe(false);
    expect(authenticateAgentKey(key) === null).toBe(true);
  });
  it("wrong workspace removal/rotation cannot affect the member or credential state", async () => {
    const f = await fixture(), other = await fixture(), before = row(f.target).api_key_hash;
    expect(rotateAgentKey(other.orgId, actor(other), f.target) === null).toBe(true);
    expect(() => removeMember(other.orgId, actor(other), f.member.personId)).toThrow();
    expect(row(f.target).api_key_hash === before).toBe(true);
    expect(Boolean(getMembership(f.orgId, f.member.personId))).toBe(true);
  });
});

describe("ordinary named agents and installed connection restrictions are preserved", () => {
  it("named-agent rotation revokes old bearer and authenticates new bearer", async () => {
    const f = await fixture(), named = registerAgent(f.orgId, "Named Agent");
    const rotated = rotateAgentKey(f.orgId, actor(f), named.agentId);
    expect(rotated !== null).toBe(true);
    if (!rotated) throw new Error("named-agent positive control refused");
    expect(authenticateAgentKey(named.apiKey) === null).toBe(true);
    expect(authenticateAgentKey(rotated.apiKey)?.agentId).toBe(named.agentId);
    expect((await fetch(`${base}/v1/me`, { headers: bearerHeaders(rotated.apiKey) })).status).toBe(200);
  });
  it.each(["session", "connector"])("still refuses rotating %s rows", async kind => {
    const f = await fixture(), named = registerAgent(f.orgId, `Installed ${kind}`);
    db.prepare("UPDATE agents SET kind = ? WHERE id = ?").run(kind, named.agentId);
    expect(rotateAgentKey(f.orgId, actor(f), named.agentId) === null).toBe(true);
  });
});
