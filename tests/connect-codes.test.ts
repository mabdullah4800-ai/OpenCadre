import { toSqliteTime } from "../src/timestamps.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";

// These tests assert the exact command text, so pin "no built CLI package": whether dist/cli exists on this checkout
// must not change the result (tests/cli-url-stamp.test.ts covers the ?v= stamp itself).
process.env.OPENCADRE_CLI_TARBALL = "__no_cli_package_in_this_test__.tgz";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  delete process.env.OPENCADRE_PUBLIC_HUB_URL;
});

// Each test redeems from its own address (the app trusts loopback proxies), so the per-IP limit stays per test.
let ipCounter = 0;
const nextIp = () => `203.0.113.${++ipCounter}`;

const call = (method: string, path: string, { key, body, ip }: { key?: string; body?: unknown; ip?: string } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

let orgCounter = 0;
function orgWithOperator() {
  const orgName = `Connect Org ${++orgCounter}`;
  const { orgId } = createOrganization(orgName);
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const coder = registerAgent(orgId, "Coder");
  return { orgId, orgName, operator, coder };
}

async function createCode(key: string, body: Record<string, unknown>) {
  const res = await call("POST", "/v1/connect-codes", { key, body });
  return { status: res.status, body: await res.json() };
}

const redeem = (code: string, ip = nextIp()) => call("POST", "/v1/connect/redeem", { body: { code }, ip });

describe("POST /v1/connect-codes", () => {
  it("requires an agent key and the operator role", async () => {
    const { coder } = orgWithOperator();
    expect((await call("POST", "/v1/connect-codes", { body: { agentName: "New" } })).status).toBe(401);
    const forbidden = await call("POST", "/v1/connect-codes", { key: coder.apiKey, body: { agentName: "New" } });
    expect(forbidden.status).toBe(403);
  });

  it("returns a code, its expiry and the server-built command", async () => {
    const { operator } = orgWithOperator();
    const before = Date.now();
    const { status, body } = await createCode(operator.apiKey, { agentName: "Codex-7F3K", client: "codex" });
    expect(status).toBe(201);
    expect(Object.keys(body).sort()).toEqual(["code", "command", "expiresAt"]);
    expect(body.code).toMatch(/^oc_[A-HJ-NP-Z2-9]{10}$/);
    const ttl = new Date(body.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 1000);
    expect(body.command).toBe(
      `npx -y https://hub.opencadre.example/cli/opencadre-cli.tgz connect --hub https://hub.opencadre.example --code ${body.code} --client codex`,
    );
  });

  it("omits --client for auto, the default, and uses OPENCADRE_PUBLIC_HUB_URL", async () => {
    const { operator } = orgWithOperator();
    process.env.OPENCADRE_PUBLIC_HUB_URL = "https://hub.example.test/";
    const { body } = await createCode(operator.apiKey, { agentName: "Auto-1" });
    expect(body.command).toBe(`npx -y https://hub.example.test/cli/opencadre-cli.tgz connect --hub https://hub.example.test --code ${body.code}`);
    const explicit = await createCode(operator.apiKey, { agentName: "Auto-2", client: "auto" });
    expect(explicit.body.command).not.toContain("--client");
  });

  // The console runs on app.opencadre.example but agents must reach MCP on the hub host, so the console's "Connect an app"
  // links and commands take the hub from /v1/me rather than from the page's own origin.
  it("GET /v1/me names the public hub, the same one the commands use", async () => {
    const { operator } = orgWithOperator();
    expect((await (await call("GET", "/v1/me", { key: operator.apiKey })).json()).hubUrl).toBe("https://hub.opencadre.example");
    process.env.OPENCADRE_PUBLIC_HUB_URL = "https://hub.example.test/";
    expect((await (await call("GET", "/v1/me", { key: operator.apiKey })).json()).hubUrl).toBe("https://hub.example.test");
  });

  it("rejects bad names (400), taken names (409) and unknown clients (400)", async () => {
    const { operator } = orgWithOperator();
    expect((await createCode(operator.apiKey, {})).status).toBe(400);
    expect((await createCode(operator.apiKey, { agentName: "bad\nname" })).status).toBe(400);
    const dup = await createCode(operator.apiKey, { agentName: " coder " });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already exists/);
    expect((await createCode(operator.apiKey, { agentName: "Fine", client: "vim" })).status).toBe(400);
  });

  it("stores only a hash of the code", async () => {
    const { orgId, operator } = orgWithOperator();
    const { body } = await createCode(operator.apiKey, { agentName: "Hashed" });
    const rows = db.prepare(`SELECT * FROM connect_codes WHERE org_id = ?`).all(orgId);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(body.code);
    expect(JSON.stringify(rows)).not.toContain(body.code.slice(3));
  });
});

describe("GET /v1/connect-codes/:code/status stages", () => {
  const stageOf = async (key: string, code: string) =>
    (await (await call("GET", `/v1/connect-codes/${code}/status`, { key })).json()) as { stage: string; state: string; agentOnline: boolean; client: string; expiresAt: string; redeemedAt: string | null; lastSeenAt: string | null };
  const sqliteTime = (ms: number) => toSqliteTime(ms);

  it("walks waiting → installed → online → offline, telling the CLI's own check-in apart from the client's", async () => {
    const { orgId, operator } = orgWithOperator();
    const { body } = await createCode(operator.apiKey, { agentName: "Stage-Walker", client: "codex" });
    const waiting = await stageOf(operator.apiKey, body.code);
    expect(waiting).toMatchObject({ stage: "waiting", state: "pending", client: "codex", redeemedAt: null, lastSeenAt: null });
    expect(Date.parse(waiting.expiresAt)).toBeGreaterThan(Date.now());

    const { agentId, apiKey } = await (await redeem(body.code)).json();
    // The CLI's smoke test checks in right after redeeming: that alone isn't the client running.
    await call("GET", "/v1/me", { key: apiKey });
    expect(await stageOf(operator.apiKey, body.code)).toMatchObject({ stage: "installed", state: "redeemed", agentOnline: true });

    // The client starts later and checks in.
    const redeemedAt = Date.parse((await stageOf(operator.apiKey, body.code)).redeemedAt!);
    db.prepare(`UPDATE connect_codes SET redeemed_at = ? WHERE org_id = ?`).run(new Date(redeemedAt - 5 * 60_000).toISOString(), orgId);
    db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(sqliteTime(Date.now() - 5_000), agentId);
    expect((await stageOf(operator.apiKey, body.code)).stage).toBe("online");

    db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(sqliteTime(Date.now() - 3 * 60_000), agentId);
    const offline = await stageOf(operator.apiKey, body.code);
    expect(offline).toMatchObject({ stage: "offline", agentOnline: false });
    expect(offline.lastSeenAt).toMatch(/Z$/);
  });

  it("flags a client that never checked in 10 minutes after install, and an expired code", async () => {
    const { orgId, operator } = orgWithOperator();
    const { body } = await createCode(operator.apiKey, { agentName: "Never-Started" });
    await redeem(body.code);
    db.prepare(`UPDATE connect_codes SET redeemed_at = ? WHERE org_id = ?`).run(new Date(Date.now() - 11 * 60_000).toISOString(), orgId);
    expect((await stageOf(operator.apiKey, body.code)).stage).toBe("not_started");

    const { body: late } = await createCode(operator.apiKey, { agentName: "Too-Late" });
    db.prepare(`UPDATE connect_codes SET expires_at = ? WHERE org_id = ? AND redeemed_at IS NULL`).run(new Date(Date.now() - 1000).toISOString(), orgId);
    expect(await stageOf(operator.apiKey, late.code)).toMatchObject({ stage: "expired", state: "expired" });
  });
});

describe("POST /v1/connect/redeem", () => {
  it("registers the agent and returns a working key", async () => {
    const { orgId, orgName, operator } = orgWithOperator();
    process.env.OPENCADRE_PUBLIC_HUB_URL = "https://hub.example.test";
    const { body: created } = await createCode(operator.apiKey, { agentName: "Cursor-Mac", client: "cursor" });
    const res = await redeem(created.code);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["agentId", "agentName", "apiKey", "cliUrl", "client", "hubUrl", "orgName"]);
    expect(body).toMatchObject({ agentName: "Cursor-Mac", client: "cursor", orgName, hubUrl: "https://hub.example.test" });

    const me = await (await call("GET", "/v1/me", { key: body.apiKey })).json();
    expect(me).toMatchObject({ agentId: body.agentId, agentName: "Cursor-Mac", orgId, role: "agent" });
  });

  it("is single use: a second redeem is 410", async () => {
    const { operator } = orgWithOperator();
    const { body } = await createCode(operator.apiKey, { agentName: "Once" });
    expect((await redeem(body.code)).status).toBe(201);
    const again = await redeem(body.code);
    expect(again.status).toBe(410);
    expect((await again.json()).error).toMatch(/already used/);
  });

  it("returns 410 for an expired code and 404 for an unknown or malformed one", async () => {
    const { orgId, operator } = orgWithOperator();
    const { body } = await createCode(operator.apiKey, { agentName: "Late" });
    db.prepare(`UPDATE connect_codes SET expires_at = ? WHERE org_id = ?`).run(new Date(Date.now() - 1000).toISOString(), orgId);
    const expired = await redeem(body.code);
    expect(expired.status).toBe(410);
    expect((await expired.json()).error).toMatch(/expired/);
    expect((await redeem("oc_ABCDEFGHJK")).status).toBe(404);
    expect((await redeem("not-a-code")).status).toBe(404);
  });

  it("returns 409 when the name was taken between create and redeem, leaving the code unused", async () => {
    const { orgId, operator } = orgWithOperator();
    const { body } = await createCode(operator.apiKey, { agentName: "Racer" });
    registerAgent(orgId, "racer");
    expect((await redeem(body.code)).status).toBe(409);
    const status = await (await call("GET", `/v1/connect-codes/${body.code}/status`, { key: operator.apiKey })).json();
    expect(status.state).toBe("pending");
  });

  it("rate-limits redeem attempts per IP", async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await redeem("oc_ABCDEFGHJK", ip)).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await redeem("oc_ABCDEFGHJK", nextIp())).status).toBe(404);
  });

  it("emits agent.connected with neither the key nor the code in the payload", async () => {
    const { orgId, operator } = orgWithOperator();
    const { body: created } = await createCode(operator.apiKey, { agentName: "Evented", client: "gemini" });
    const body = await (await redeem(created.code)).json();
    const events = db.prepare(`SELECT * FROM events WHERE org_id = ? AND type = 'agent.connected'`).all(orgId) as Array<{ payload: string; subject_id: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].subject_id).toBe(body.agentId);
    expect(JSON.parse(events[0].payload)).toMatchObject({ agentName: "Evented", client: "gemini" });
    for (const secret of [body.apiKey, created.code, created.code.slice(3), "agt_", "oc_"]) expect(events[0].payload).not.toContain(secret);
  });
});

describe("GET /v1/connect-codes/:code/status", () => {
  it("moves pending -> redeemed -> agentOnline after the agent's first call", async () => {
    const { operator } = orgWithOperator();
    const { body: created } = await createCode(operator.apiKey, { agentName: "Watched" });
    const status = async () => (await call("GET", `/v1/connect-codes/${created.code}/status`, { key: operator.apiKey })).json();

    expect(await status()).toMatchObject({ state: "pending", stage: "waiting", agentOnline: false, agentName: "Watched" });
    const { apiKey } = await (await redeem(created.code)).json();
    expect(await status()).toMatchObject({ state: "redeemed", stage: "installed", agentOnline: false, agentName: "Watched" });
    await call("POST", "/v1/heartbeat", { key: apiKey });
    expect(await status()).toMatchObject({ state: "redeemed", agentOnline: true, agentName: "Watched" });
  });

  it("reports expired codes", async () => {
    const { orgId, operator } = orgWithOperator();
    const { body } = await createCode(operator.apiKey, { agentName: "Expiring" });
    db.prepare(`UPDATE connect_codes SET expires_at = ? WHERE org_id = ?`).run(new Date(Date.now() - 1000).toISOString(), orgId);
    const status = await (await call("GET", `/v1/connect-codes/${body.code}/status`, { key: operator.apiKey })).json();
    expect(status.state).toBe("expired");
  });

  // THE OTHER SPELLING OF THE SAME COLUMN, pinned so the ISO-only assumption is not load-bearing.
  //
  // NOT A CATCHER, measured: a bare `Date.parse` also returns a valid epoch for the SQLite spelling
  // on Node/v8, so this passes with or without src/timestamps.ts's guarded reader. I asserted in a
  // first draft that the bare form gave NaN here and that is FALSE — it must not be cited as
  // evidence of a defect. It is kept because it pins the property that matters going forward: the
  // route must not depend on `expires_at` being ISO, which it is today only because this file
  // writes it that way (createConnectCode, above).
  it("reports a SQLite-spelled expires_at as expired too, not as pending", async () => {
    const { orgId, operator } = orgWithOperator();
    const { body } = await createCode(operator.apiKey, { agentName: "Old-Spelling" });
    db.prepare(`UPDATE connect_codes SET expires_at = ? WHERE org_id = ?`).run(toSqliteTime(Date.now() - 1000), orgId);
    const status = await (await call("GET", `/v1/connect-codes/${body.code}/status`, { key: operator.apiKey })).json();
    expect(status.state).toBe("expired");
  });

  it("is 404 for another org's code and operator-only", async () => {
    const mine = orgWithOperator();
    const theirs = orgWithOperator();
    const { body } = await createCode(theirs.operator.apiKey, { agentName: "Theirs" });
    expect((await call("GET", `/v1/connect-codes/${body.code}/status`, { key: mine.operator.apiKey })).status).toBe(404);
    expect((await call("GET", `/v1/connect-codes/${body.code}/status`, { key: theirs.coder.apiKey })).status).toBe(403);
    expect((await call("GET", `/v1/connect-codes/${body.code}/status`)).status).toBe(401);
  });
});
