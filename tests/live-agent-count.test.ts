// The workspace's live-agent count on GET /v1/me (dashboard phase 2, item B; Codex-OpenCadre-049a ruling Q2, Policy M).
// One number, countLiveAgents, the set the plan's live-agent limit counts; one predicate, src/live-count.ts, deciding
// every surface it leaves the hub on: /v1/me, get_capabilities (which carries none) and every 402 PLAN_LIMIT for agents.
// A principal gets the SAME number on every surface it can reach, or null on all of them -- never a number on one and
// null on another. The count is an aggregate: no names, ids or projects ride along.
import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The real predicate, wrapped so one test can flip it: every surface must follow, which is what "one predicate" means.
vi.mock("../src/live-count.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/live-count.js")>();
  return { ...real, liveCountVisibleTo: vi.fn(real.liveCountVisibleTo) };
});

const { app } = await import("../src/rest.js");
const { handleMcpRequest } = await import("../src/mcp.js");
const { db } = await import("../src/db.js");
const { createOrganization, registerAgent, HEARTBEAT_TTL_MS } = await import("../src/service.js");
const { countLiveAgents, workspaceBilling } = await import("../src/billing.js");
const { createConnectCode } = await import("../src/connect.js");
const { createSession } = await import("../src/accounts.js");
const { approveConsent, createConsent } = await import("../src/oauth-authorize.js");
const { mcpResource } = await import("../src/oauth.js");
const liveCount = await import("../src/live-count.js");
const { addMember, dcrClient, person } = await import("./helpers/oauth-fixtures.js");

const predicate = vi.mocked(liveCount.liveCountVisibleTo);

let server: http.Server;
let base: string;
beforeAll(async () => {
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
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  predicate.mockReset();
  predicate.mockImplementation(() => true);
  vi.useRealTimers();
});

let ip = 0;
async function call(method: string, path: string, { key, cookie, orgId, body, headers = {} }:
  { key?: string; cookie?: string; orgId?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(cookie ? { cookie: `oc_session=${cookie}` } : {}),
      ...(orgId ? { "X-OpenCadre-Workspace": orgId } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-forwarded-for": `10.92.${Math.floor(++ip / 250)}.${ip % 250}`,
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* an HTML page */ }
  return { status: res.status, body: json, text };
}

const beat = (agentId: string, at = new Date().toISOString()) => db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(at, agentId);
const PROJECT = { "x-opencadre-client": "claude-code", "x-opencadre-project": "github.com/acme/live-count", "x-opencadre-project-name": "Live Count" };

/** One workspace with every principal class the count can reach, plus rows the limit must NOT count. */
async function fixture(name: string) {
  const owner = person("Owner");
  const { orgId, bootstrapKey } = createOrganization(name);
  addMember(orgId, owner, "owner");
  const admin = person("Admin");
  addMember(orgId, admin, "admin");
  const member = person("Member");
  addMember(orgId, member, "member");
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const agent = registerAgent(orgId, "Plain");
  // A computer and its first session, made while the workspace is under its limit (the session is a live agent).
  const minted = await call("POST", "/v1/org/devices", { key: operator.apiKey, body: { name: "Laptop" } });
  expect(minted.status).toBe(201);
  const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: minted.body.code } });
  expect(redeemed.status).toBe(201);
  const device = redeemed.body.deviceCredential as string;
  expect((await call("PUT", "/v1/devices/projects/enable-current", { key: device, headers: { ...PROJECT, "x-opencadre-session": "boot" } })).status).toBe(200);
  expect((await call("POST", "/v1/sessions/join", { key: device, headers: { ...PROJECT, "x-opencadre-session": "live-1" } })).status).toBe(201);
  // Rows the limit does not count, so neither may the field: removed, ended, and a heartbeat outside the TTL.
  const now = Date.now();
  const removed = registerAgent(orgId, "Removed");
  beat(removed.agentId);
  db.prepare(`UPDATE agents SET removed_at = ? WHERE id = ?`).run(new Date(now).toISOString(), removed.agentId);
  const ended = registerAgent(orgId, "Ended");
  beat(ended.agentId);
  db.prepare(`UPDATE agents SET ended_at = ? WHERE id = ?`).run(new Date(now).toISOString(), ended.agentId);
  beat(registerAgent(orgId, "Stale").agentId, new Date(now - HEARTBEAT_TTL_MS - 60_000).toISOString());
  const cookies = { owner: createSession(owner).token, admin: createSession(admin).token, member: createSession(member).token };
  const f = { orgId, owner, bootstrapKey, cookies, operatorKey: operator.apiKey, agentKey: agent.apiKey, device };
  // Every authenticated read beats its caller (src/rest.ts), so the viewer is in the count. Each reader beats once here,
  // so the reads under test cannot move the number they report.
  for (const read of Object.values(meReaders(f))) expect((await read()).status).toBe(200);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Fills the workspace with live agents up to exactly its live-agent allowance. */
function fillToLimit(orgId: string) {
  const b = workspaceBilling(orgId);
  const allowed = b.limits.maxAgents! * b.seats;
  for (let i = countLiveAgents(orgId); i < allowed; i++) beat(registerAgent(orgId, `Filler ${i}`).agentId);
  expect(countLiveAgents(orgId), "fixture: the workspace is exactly at its limit").toBe(allowed);
  return allowed;
}

const meReaders = (f: { orgId: string; cookies: Record<"owner" | "admin" | "member", string>; operatorKey: string; agentKey: string }) => ({
  owner: () => call("GET", "/v1/me", { cookie: f.cookies.owner, orgId: f.orgId }),
  admin: () => call("GET", "/v1/me", { cookie: f.cookies.admin, orgId: f.orgId }),
  member: () => call("GET", "/v1/me", { cookie: f.cookies.member, orgId: f.orgId }),
  "operator key": () => call("GET", "/v1/me", { key: f.operatorKey }),
  "agent key": () => call("GET", "/v1/me", { key: f.agentKey }),
});

/** Every 402 surface for the live-agent limit, as the principal that reaches it, reduced to what it discloses. */
const refusals = (f: Fixture) => ({
  "owner: POST /v1/org/agents": async () => body402(await call("POST", "/v1/org/agents", { cookie: f.cookies.owner, orgId: f.orgId, body: { name: "Over-owner" } })),
  "admin: POST /v1/org/agents": async () => body402(await call("POST", "/v1/org/agents", { cookie: f.cookies.admin, orgId: f.orgId, body: { name: "Over-admin" } })),
  "operator key: POST /v1/org/agents": async () => body402(await call("POST", "/v1/org/agents", { key: f.operatorKey, body: { name: "Over-op" } })),
  "bootstrap key: POST /v1/agents": async () => body402(await call("POST", "/v1/agents", { key: f.bootstrapKey, body: { name: "Over-boot" } })),
  "device: POST /v1/sessions/join": async () => body402(await call("POST", "/v1/sessions/join", { key: f.device, headers: { ...PROJECT, "x-opencadre-session": `over-${++ip}` } })),
  "connect code: POST /v1/connect/redeem": async () => {
    const { code } = createConnectCode(f.orgId, { id: "hub" }, `Over-code-${++ip}`, "claude-code");
    return body402(await call("POST", "/v1/connect/redeem", { body: { code } }));
  },
  "oauth: approveConsent": async () => {
    const consentId = createConsent({ personId: f.owner, clientId: dcrClient(), redirectUri: "https://claude.ai/api/mcp/auth_callback", resource: mcpResource(),
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", state: `s-${++ip}` });
    const r = approveConsent({ consentId, personId: f.owner, orgId: f.orgId, projectKey: PROJECT["x-opencadre-project"], connectionName: `Over-oauth-${ip}` });
    expect(r).toMatchObject({ ok: false, reason: "plan_limit" });
    if (r.ok || r.reason !== "plan_limit") throw new Error("not a plan refusal");
    return { status: r.limit.status, used: r.limit.body.used, message: r.message };
  },
});
function body402(res: { status: number; body: any }) {
  expect(res.status).toBe(402);
  // connect-code redemption answers { error } only; the others carry the whole PLAN_LIMIT body.
  return { status: res.status, used: res.body.used, message: res.body.error as string };
}

describe("GET /v1/me billing.used.agents: the workspace's live-agent count (Policy M)", () => {
  it("every principal class of the workspace gets countLiveAgents, and nothing else rides with it", async () => {
    const f = await fixture("Live Count Readers");
    const expected = countLiveAgents(f.orgId);
    expect(expected, "fixture: the session, three people's sign-ins, the operator key and the plain key").toBe(6);
    for (const [who, read] of Object.entries(meReaders(f))) {
      const res = await read();
      expect(res.status, who).toBe(200);
      expect(res.body.billing.used, who).toEqual({ agents: expected });
      // An aggregate: no ids, names or projects anywhere in the block.
      expect(JSON.stringify(res.body.billing.used), who).toBe(`{"agents":${expected}}`);
    }
  });

  it("counts exactly what the limit counts: removed, ended and out-of-TTL rows are out, every key class is in", async () => {
    const f = await fixture("Live Count Population");
    // Every key class is in: people's sign-ins (human), operator and plain keys, a device session, and a watcher.
    beat(registerAgent(f.orgId, "Watcher", { keyClass: "watcher" }).agentId);
    const me = await call("GET", "/v1/me", { key: f.agentKey });
    expect(me.body.billing.used.agents).toBe(countLiveAgents(f.orgId));
    // Removed, Ended and Stale (fixture) are not: 6 + the watcher.
    expect(me.body.billing.used.agents).toBe(7);
  });

  it("flips at the same heartbeat as the refusal, either side of the TTL", async () => {
    const f = await fixture("Live Count TTL");
    const allowed = fillToLimit(f.orgId);
    // One edge row beat at t0, every other live row a minute later; the clock then sits either side of the edge's TTL.
    // The reads opt out of beating their caller (x-opencadre-probe), so only the clock moves the number.
    const t0 = Date.now();
    db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE org_id = ? AND removed_at IS NULL AND ended_at IS NULL AND name <> 'Stale'`)
      .run(new Date(t0 + 60_000).toISOString(), f.orgId);
    db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE org_id = ? AND name = 'Filler ${allowed - 1}'`).run(new Date(t0).toISOString(), f.orgId);
    const probe = { "x-opencadre-probe": "no-heartbeat" };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0 + HEARTBEAT_TTL_MS - 1_000);
    const inside = await call("GET", "/v1/me", { key: f.agentKey, headers: probe });
    expect(inside.body.billing.used.agents).toBe(allowed);
    const refusedInside = await call("POST", "/v1/agents", { key: f.bootstrapKey, body: { name: "TTL-inside" } });
    expect(refusedInside.status).toBe(402);
    expect(refusedInside.body.used).toBe(allowed);

    vi.setSystemTime(t0 + HEARTBEAT_TTL_MS + 1_000);
    const outside = await call("GET", "/v1/me", { key: f.agentKey, headers: probe });
    expect(outside.body.billing.used.agents).toBe(allowed - 1);
    expect((await call("POST", "/v1/agents", { key: f.bootstrapKey, body: { name: "TTL-outside" } })).status, "one slot freed, so the refusal lifts").toBe(201);
  });
});

describe("one predicate decides every surface", () => {
  it("Policy M: every principal gets the SAME number on /v1/me and on every 402 it can reach", async () => {
    const f = await fixture("Live Count Consistency");
    const allowed = fillToLimit(f.orgId);
    for (const [who, read] of Object.entries(meReaders(f))) expect((await read()).body.billing.used.agents, who).toBe(allowed);
    for (const [surface, refuse] of Object.entries(refusals(f))) {
      const r = await refuse();
      if (r.used !== undefined) expect(r.used, surface).toBe(allowed);
      expect(r.message, surface).toContain(`${allowed} in use`);
    }
    expect(countLiveAgents(f.orgId), "no refusal created an agent").toBe(allowed);
    // Every surface asked the predicate, and nothing else decided.
    expect(predicate).toHaveBeenCalled();
  });

  it("withheld is null on /v1/me AND on every 402, with no count in any message, and the refusal still refuses", async () => {
    const f = await fixture("Live Count Withheld");
    const allowed = fillToLimit(f.orgId);
    predicate.mockImplementation(() => false);
    for (const [who, read] of Object.entries(meReaders(f))) {
      const res = await read();
      expect(res.status, who).toBe(200);
      expect(res.body.billing.used, who).toEqual({ agents: null });
    }
    for (const [surface, refuse] of Object.entries(refusals(f))) {
      const r = await refuse();
      expect(r.status, surface).toBe(402);
      if (r.used !== undefined) expect(r.used, surface).toBeNull();
      expect(r.message, surface).toMatch(/plan's limit on agents/);
      expect(r.message, surface).not.toContain("in use");
      expect(r.message, surface).toContain(`limit on agents: the ${workspaceBilling(f.orgId).planName} plan allows ${allowed}.`);
    }
    expect(countLiveAgents(f.orgId), "withholding the number never admitted anyone").toBe(allowed);
  });

  it("get_capabilities carries no count under either answer of the predicate", async () => {
    const f = await fixture("Live Count Capabilities");
    const allowed = fillToLimit(f.orgId);
    for (const visible of [true, false]) {
      predicate.mockImplementation(() => visible);
      const client = new Client({ name: "live-count-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${f.agentKey}` } } }));
      const result = (await client.callTool({ name: "get_capabilities", arguments: {} })) as { content: Array<{ text: string }> };
      await client.close();
      const text = result.content.map((c) => c.text).join(" ");
      expect(text).toBe("(none declared)");
      expect(text).not.toContain(String(allowed));
    }
  });

  it("the real predicate (Policy M) admits every principal class", async () => {
    const real = await vi.importActual<typeof import("../src/live-count.js")>("../src/live-count.js");
    for (const viewer of ["member", "agent", "bootstrap", "device", "connect_code", "oauth"] as const) expect(real.liveCountVisibleTo(viewer), viewer).toBe(true);
  });
});
