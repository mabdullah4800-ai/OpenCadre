import type { AddressInfo } from "node:net";
import http from "node:http";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { MIGRATIONS, runMigrations } from "../src/migrations.js";
import { projectKeyOf, projectNameFor } from "../src/projects.js";

/** Computer -> tools -> project -> sessions on the hub: a device is a computer running several tools, each session
 * records its tool and project, and projects are opt-in (docs/CLIENT-ONBOARDING.md, "Connect a computer"). */

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
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let ipCounter = 0;
const nextIp = () => `10.78.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function call(method: string, path: string, { key, body, headers = {} }: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-forwarded-for": nextIp(),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

let orgCounter = 0;
async function computer(client?: string) {
  const { orgId } = createOrganization(`Computer Org ${++orgCounter}`);
  const operatorKey = registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey;
  const coderKey = registerAgent(orgId, "Coder").apiKey;
  const minted = await call("POST", "/v1/org/devices", { key: operatorKey, body: { name: "Laptop", ...(client ? { client } : {}) } });
  expect(minted.status).toBe(201);
  const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: minted.body.code } });
  expect(redeemed.status).toBe(201);
  return { orgId, operatorKey, coderKey, deviceId: minted.body.deviceId as string, credential: redeemed.body.deviceCredential as string, client: redeemed.body.client as string };
}

const REPO = { key: "github.com/acme/widgets", name: "Widgets" };
const chat = (tool: string, project: { key: string; name?: string } | null = REPO, client = "claude-code", extra: Record<string, string> = {}) => ({
  "x-opencadre-session": tool,
  "x-opencadre-client": client,
  ...(project ? { "x-opencadre-project": project.key, ...(project.name ? { "x-opencadre-project-name": project.name } : {}) } : {}),
  ...extra,
});
const enable = (operatorKey: string, projectKey: string, enabled = true, name?: string) =>
  call("PUT", "/v1/org/projects", { key: operatorKey, body: { projectKey, enabled, ...(name ? { name } : {}) } });
const sessionAgents = (orgId: string) => (db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND kind = 'session'`).get(orgId) as { n: number }).n;
/** A session's auto name is one word (sessions PR1), or on collision two words or a word and a number: the client and
 * project it used to spell out are the session's tool and project fields. */
const WORD_NAME = /^[A-Z][a-z]+(?: [A-Z][a-z]+| \d+)?$/;
const liveSessions = async (operatorKey: string) => (await call("GET", "/v1/org/sessions", { key: operatorKey })).body.sessions as Array<Record<string, unknown>>;

describe("a device is a computer", () => {
  it("is created with client auto when none is given; a client is still accepted for older consoles", async () => {
    const c = await computer();
    expect(c.client).toBe("auto");
    const minted = await call("POST", "/v1/org/devices", { key: c.operatorKey, body: { name: "Old console", client: "claude-code" } });
    expect(minted.status).toBe(201);
    expect(minted.body.command).toMatch(/--client claude-code$/);
    expect((await call("POST", "/v1/org/devices", { key: c.operatorKey, body: { name: "Bad", client: "notepad" } })).status).toBe(400);
  });

  it("records the tools a connect run set up, unioned with the tools its sessions came from", async () => {
    const c = await computer();
    const tools = (body: unknown, key = c.credential) => call("POST", "/v1/devices/tools", { key, body });
    // The device credential alone: no session header on this one route.
    expect(await tools({ tools: ["codex"] })).toEqual({ status: 200, body: { ok: true, tools: ["codex"] } });
    expect((await tools({ tools: ["claude-code"] })).body.tools).toEqual(["claude-code", "codex"]);
    expect((await tools({ tools: ["notepad"] })).status).toBe(400);
    expect((await tools({ tools: "codex" })).status).toBe(400);
    expect((await tools({ tools: ["auto"] })).status).toBe(400);
    expect((await tools({ tools: ["codex"] }, `dev_${"0".repeat(48)}`)).status).toBe(401);
    expect((await tools({ tools: ["codex"] }, registerAgent(c.orgId, "Named").apiKey)).status).toBe(401);

    await enable(c.operatorKey, REPO.key);
    expect((await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("gem-1", REPO, "gemini") })).status).toBe(201);
    const [listed] = (await call("GET", "/v1/org/devices", { key: c.operatorKey })).body.devices as Array<{ tools: string[] }>;
    expect(listed.tools).toEqual(["claude-code", "codex", "gemini"]);
    expect(JSON.parse((db.prepare(`SELECT tools FROM devices WHERE id = ?`).get(c.deviceId) as { tools: string }).tools)).toEqual(["claude-code", "codex"]);
  });

  it("an older single-tool device lists its own tool", async () => {
    const c = await computer("claude-code");
    const [listed] = (await call("GET", "/v1/org/devices", { key: c.operatorKey })).body.devices as Array<{ tools: string[] }>;
    expect(listed.tools).toEqual(["claude-code"]);
  });
});

describe("sessions carry their tool and project", () => {
  it("an auto computer labels each session from its client header, and the console gets tool, projectKey, projectName and deviceName", async () => {
    const c = await computer();
    await enable(c.operatorKey, REPO.key);
    const claude = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("cc-1") });
    const codex = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("codex-1", REPO, "codex") });
    expect(claude.body.agentName).toMatch(WORD_NAME);
    expect(codex.body.agentName).toMatch(WORD_NAME);

    const sessions = await liveSessions(c.operatorKey);
    expect(sessions.find((s) => s.agentId === codex.body.agentId)).toMatchObject({
      tool: "codex", projectKey: REPO.key, projectName: "Widgets", project: "Widgets", deviceId: c.deviceId, deviceName: "Laptop", client: "auto",
    });
    expect(sessions.find((s) => s.agentId === claude.body.agentId)).toMatchObject({ tool: "claude-code", projectKey: REPO.key, projectName: "Widgets" });
    expect(db.prepare(`SELECT client, project, project_name FROM agents WHERE id = ?`).get(codex.body.agentId)).toEqual({ client: "codex", project: REPO.key, project_name: "Widgets" });
  });

  it("normalizes the key like a git remote and keeps the project name sanitized", async () => {
    const c = await computer();
    await enable(c.operatorKey, "git@GitHub.com:Acme/Widgets.git");
    const joined = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("norm-1", { key: "https://github.com/acme/widgets", name: "Wid gets!" }) });
    expect(joined.status).toBe(201);
    expect(joined.body.agentName).toMatch(WORD_NAME);
    expect((await liveSessions(c.operatorKey))[0]).toMatchObject({ agentId: joined.body.agentId, tool: "claude-code", projectKey: "github.com/acme/widgets", projectName: "Wid-gets" });
  });

  it("validates project keys with the git remote rules, local:<folder>, or an old bare folder name", () => {
    expect(projectKeyOf("git@github.com:mabdullah4800-ai/OpenCadre.git")).toBe("github.com/mabdullah4800-ai/opencadre");
    expect(projectKeyOf("https://user:pw@gitlab.example.com:8443/team/app")).toBe("gitlab.example.com/team/app");
    expect(projectKeyOf("local:My Folder")).toBe("local:My-Folder");
    expect(projectKeyOf("OpenCadre")).toBe("OpenCadre");
    expect(projectKeyOf("a".repeat(201))).toBeNull();
    expect(projectKeyOf("github.com/../etc")).toBeNull();
    expect(projectKeyOf("C:\\Users\\x")).toBeNull();
    expect(projectKeyOf("local:")).toBeNull();
    expect(projectKeyOf("has space/repo")).toBeNull();
    expect(projectKeyOf(42)).toBeNull();
    expect(projectNameFor("github.com/acme/widgets")).toBe("widgets");
    expect(projectNameFor("local:Foo", "Bar")).toBe("Bar");
  });
});

describe("projects are opt-in", () => {
  it("a session in a project that isn't enabled creates nothing, RECORDS nothing, and gets 403", async () => {
    const c = await computer();
    for (const [method, path] of [["POST", "/v1/sessions/join"], ["GET", "/v1/me"], ["GET", "/v1/messages?peek=true"]] as const) {
      const refused = await call(method, path, { key: c.credential, headers: chat("off-1"), ...(method === "POST" ? { body: {} } : {}) });
      expect(refused).toEqual({ status: 403, body: { error: "project_not_enabled", project: REPO.key } });
    }
    // Resolve-only (a current hook) gets the same 403, and so does MCP.
    expect((await call("GET", "/v1/me", { key: c.credential, headers: chat("off-1", REPO, "claude-code", { "x-opencadre-resolve-only": "1" }) })).status).toBe(403);
    const mcp = await call("POST", "/mcp", {
      key: c.credential,
      headers: { ...chat("off-1"), accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    });
    expect(mcp).toEqual({ status: 403, body: { error: "project_not_enabled", project: REPO.key } });
    expect(sessionAgents(c.orgId)).toBe(0);

    // No sightings: six refused requests from an unenabled folder leave no row, so neither the console nor anyone
    // reading the database learns that this computer had the folder open. Before the no-sightings change this row
    // existed (enabled = 0, first/last seen stamped) and the console listed it as "Seen on your computers".
    const { projects } = (await call("GET", "/v1/org/projects", { key: c.operatorKey })).body;
    expect(projects).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE org_id = ?`).get(c.orgId)).toEqual({ n: 0 });
  });

  it("GET /v1/devices/projects lists exactly the enabled keys, asked with the credential alone and recording nothing", async () => {
    const c = await computer();
    const list = (key = c.credential, headers: Record<string, string> = {}) => call("GET", "/v1/devices/projects", { key, headers });
    expect(await list()).toEqual({ status: 200, body: { projects: [] } });
    expect((await list(`dev_${"1".repeat(48)}`)).status).toBe(401);
    await enable(c.operatorKey, REPO.key);
    await enable(c.operatorKey, "github.com/acme/second");
    await enable(c.operatorKey, "github.com/acme/second", false);
    // Sent project headers change nothing: the answer is the workspace's list, and no header is ever recorded.
    const listed = await list(c.credential, { "x-opencadre-project": "github.com/acme/snooped", "x-opencadre-project-name": "Snooped" });
    expect(listed).toEqual({ status: 200, body: { projects: [REPO.key] } });
    const keys = (db.prepare(`SELECT project_key FROM projects WHERE org_id = ? ORDER BY project_key`).all(c.orgId) as Array<{ project_key: string }>).map((r) => r.project_key);
    expect(keys).toEqual(["github.com/acme/second", REPO.key].sort());
    // A paused workspace refuses every device request, this one included; the computer keeps its last snapshot.
    await call("POST", "/v1/org/pause", { key: c.operatorKey });
    expect((await list()).status).toBe(423);
  });

  it("a request with no project header counts as not enabled", async () => {
    const c = await computer();
    await enable(c.operatorKey, REPO.key);
    const refused = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("no-project", null) });
    expect(refused).toEqual({ status: 403, body: { error: "project_not_enabled", project: null } });
    expect(sessionAgents(c.orgId)).toBe(0);
  });

  it("enabling makes join work; disabling refuses the live session on its next request, which keeps its history", async () => {
    const c = await computer();
    expect((await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("toggle-1") })).status).toBe(403);
    const enabled = await enable(c.operatorKey, REPO.key);
    expect(enabled.status).toBe(200);
    expect(enabled.body.project).toMatchObject({ projectKey: REPO.key, enabled: true, enabledByAgentName: "Operator", enabledAt: expect.any(String) });

    const joined = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("toggle-1") });
    expect(joined.status).toBe(201);
    await call("POST", "/v1/messages", { key: c.coderKey, body: { toAgent: joined.body.agentName, body: "before disable" } });
    expect((await call("GET", "/v1/org/projects", { key: c.operatorKey })).body.projects[0]).toMatchObject({ enabled: true, sessionCount: 1 });

    expect((await enable(c.operatorKey, REPO.key, false)).body.project).toMatchObject({ enabled: false, enabledAt: null, enabledByAgentName: null });
    expect(await call("GET", "/v1/me", { key: c.credential, headers: chat("toggle-1") })).toEqual({ status: 403, body: { error: "project_not_enabled", project: REPO.key } });
    const row = db.prepare(`SELECT ended_at, removed_at FROM agents WHERE id = ?`).get(joined.body.agentId);
    expect(row).toEqual({ ended_at: null, removed_at: null });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE to_agent_id = ?`).get(joined.body.agentId) as { n: number }).n).toBe(1);

    // Enabled again: the same chat is the same agent, with its mail.
    await enable(c.operatorKey, REPO.key);
    const back = await call("GET", "/v1/messages?peek=true", { key: c.credential, headers: chat("toggle-1") });
    expect(back.body.messages.map((m: { body: string }) => m.body)).toEqual(["before disable"]);
    const types = (db.prepare(`SELECT type FROM events WHERE org_id = ? AND type LIKE 'project.%' ORDER BY seq`).all(c.orgId) as Array<{ type: string }>).map((e) => e.type);
    expect(types).toEqual(["project.enabled", "project.disabled", "project.enabled"]);
  });

  it("only operators manage projects; keys are validated; an operator can pre-enable a key never seen", async () => {
    const c = await computer();
    expect((await call("GET", "/v1/org/projects", { key: c.coderKey })).status).toBe(403);
    expect((await call("PUT", "/v1/org/projects", { key: c.coderKey, body: { projectKey: REPO.key, enabled: true } })).status).toBe(403);
    expect((await call("GET", "/v1/org/projects", { key: c.credential, headers: chat("dev-op") })).status).toBe(403);
    expect((await call("PUT", "/v1/org/projects", { key: c.operatorKey, body: { projectKey: "not a key/x y", enabled: true } })).status).toBe(400);
    expect((await call("PUT", "/v1/org/projects", { key: c.operatorKey, body: { projectKey: REPO.key, enabled: "yes" } })).status).toBe(400);
    expect((await call("PUT", "/v1/org/projects", { key: c.operatorKey, body: { projectKey: "local:Never", enabled: false } })).status).toBe(404);

    const pre = await enable(c.operatorKey, "github.com/acme/future", true, "Future");
    expect(pre.body.project).toMatchObject({ projectKey: "github.com/acme/future", name: "Future", enabled: true, firstSeenAt: null, lastSeenAt: null });
    const joined = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("future-1", { key: "github.com/acme/future", name: "future" }) });
    expect(joined.status).toBe(201);
    // The operator's name for it stays.
    expect((await call("GET", "/v1/org/projects", { key: c.operatorKey })).body.projects[0]).toMatchObject({ name: "Future", sessionCount: 1, firstSeenAt: expect.any(String) });
  });

  it("enable-current enables only the project its headers name, with the device credential alone", async () => {
    const c = await computer();
    const put = (headers: Record<string, string>, key = c.credential) => call("PUT", "/v1/devices/projects/enable-current", { key, headers });
    expect((await put({})).status).toBe(400);
    expect((await put({ "x-opencadre-project": REPO.key }, `dev_${"1".repeat(48)}`)).status).toBe(401);
    const done = await put({ "x-opencadre-project": REPO.key, "x-opencadre-project-name": REPO.name });
    expect(done).toMatchObject({ status: 200, body: { ok: true, project: { projectKey: REPO.key, name: "Widgets", enabled: true, enabledByAgentName: "Laptop" } } });
    expect((await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("cur-1") })).status).toBe(201);
    expect((await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("other-1", { key: "github.com/acme/other", name: "Other" }) })).status).toBe(403);
    const { projects } = (await call("GET", "/v1/org/projects", { key: c.operatorKey })).body;
    // The refused join in acme/other left no row: only the project connect enabled is listed.
    expect(projects.map((p: { projectKey: string; enabled: boolean }) => [p.projectKey, p.enabled])).toEqual([[REPO.key, true]]);

    await call("POST", "/v1/org/pause", { key: c.operatorKey });
    expect((await put({ "x-opencadre-project": "github.com/acme/other" })).status).toBe(423);
    expect((await call("POST", "/v1/devices/tools", { key: c.credential, body: { tools: ["codex"] } })).status).toBe(423);
  });

  it("stays quiet for clients from before opt-in projects: a hook hears 'no session', a proxy gets an empty server", async () => {
    const c = await computer("claude-code");
    // An old client sends the folder name as the project and no project name.
    const legacy = { key: "Sidecar" };
    const oldHook = chat("old-1", legacy, "claude-code", { "x-opencadre-resolve-only": "1" });
    const hook = await call("GET", "/v1/messages?peek=true", { key: c.credential, headers: oldHook });
    expect(hook).toEqual({ status: 401, body: { error: "no OpenCadre session for this chat yet" } });
    // An old approval gate reads "no policy" rather than falling back to a cached ask or strict mode.
    const policy = await call("GET", "/v1/clearance-policy?project=github.com/acme/sidecar", { key: c.credential, headers: oldHook });
    expect(policy).toEqual({ status: 200, body: { policy: { project: "github.com/acme/sidecar", mode: "off", source: "default", updatedBy: null, updatedAt: null } } });
    // A current gate gets the plain 403.
    expect((await call("GET", "/v1/clearance-policy?project=github.com/acme/sidecar", { key: c.credential, headers: chat("old-1", { key: "github.com/acme/sidecar", name: "sidecar" }, "claude-code", { "x-opencadre-resolve-only": "1" }) })).status).toBe(403);

    const rpc = (body: unknown) => call("POST", "/mcp", { key: c.credential, headers: { ...chat("old-1", legacy), accept: "application/json, text/event-stream" }, body });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, instructions: "OpenCadre isn't enabled for this project." } });
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect((await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_messages" } })).body.error.code).toBe(-32601);
    // A create request over REST still says why.
    expect((await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("old-1", legacy) })).status).toBe(403);
    expect(sessionAgents(c.orgId)).toBe(0);

    // Its project enabled, the old client works exactly as before.
    await enable(c.operatorKey, "Sidecar");
    const joined = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("old-1", legacy) });
    expect(joined.status).toBe(201);
    expect(joined.body.agentName).toMatch(WORD_NAME);
    expect((await liveSessions(c.operatorKey)).find((s) => s.agentId === joined.body.agentId)).toMatchObject({ tool: "claude-code", projectName: "Sidecar" });
  });

  it("a live session follows its chat to the remote key once the computer reconnects with a current CLI", async () => {
    const c = await computer("claude-code");
    await enable(c.operatorKey, "OpenCadre");
    await enable(c.operatorKey, "github.com/mabdullah4800-ai/opencadre");
    const old = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("follow-1", { key: "OpenCadre" }, "claude-code", { "x-opencadre-host-session": "follow-host" }) });
    expect((await liveSessions(c.operatorKey))[0]).toMatchObject({ projectKey: "OpenCadre", project: "OpenCadre", tool: "claude-code" });
    const now = await call("GET", "/v1/me", { key: c.credential, headers: chat("follow-2", { key: "github.com/mabdullah4800-ai/opencadre", name: "OpenCadre" }, "claude-code", { "x-opencadre-host-session": "follow-host" }) });
    expect(now.body.agentId).toBe(old.body.agentId);
    expect((await liveSessions(c.operatorKey))[0]).toMatchObject({ projectKey: "github.com/mabdullah4800-ai/opencadre", projectName: "OpenCadre" });
  });
});

describe("migration 10: existing sessions", () => {
  it("enables only the OpenCadre repository, only where a live session already uses it", () => {
    const legacy = new Database(":memory:");
    runMigrations(legacy, MIGRATIONS.filter((m) => m.version < 10));
    legacy.exec(`
      INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Operator PC', 'h'), ('o2', 'Other', 'h'), ('o3', 'Ended', 'h');
      INSERT INTO agents (id, org_id, name, url_key, api_key_hash, kind, device_id, seat_id, project) VALUES
        ('s1', 'o1', 'ClaudeCode-OpenCadre-a347', 's1', 'x', 'session', 'd1', 'seat1', 'OpenCadre'),
        ('s2', 'o1', 'ClaudeCode-OpenCadre-6ac9', 's2', 'x', 'session', 'd1', 'seat2', 'OpenCadre'),
        ('s3', 'o1', 'ClaudeCode-Job-1111', 's3', 'x', 'session', 'd1', 'seat3', 'Job'),
        ('s4', 'o2', 'ClaudeCode-Storefront-2222', 's4', 'x', 'session', 'd2', 'seat4', 'Storefront'),
        ('s5', 'o3', 'ClaudeCode-OpenCadre-3333', 's5', 'x', 'session', 'd3', 'seat5', 'OpenCadre');
      UPDATE agents SET ended_at = '2026-09-01 00:00:00' WHERE id = 's5';
    `);
    expect(runMigrations(legacy).applied).toEqual(MIGRATIONS.filter((m) => m.version >= 10).map((m) => m.version));
    const rows = legacy.prepare(`SELECT org_id, project_key, name, enabled, enabled_by_agent_name FROM projects ORDER BY org_id, project_key`).all();
    expect(rows).toEqual([
      { org_id: "o1", project_key: "OpenCadre", name: "OpenCadre", enabled: 1, enabled_by_agent_name: "migration" },
      { org_id: "o1", project_key: "github.com/mabdullah4800-ai/opencadre", name: "OpenCadre", enabled: 1, enabled_by_agent_name: "migration" },
    ]);
    expect(legacy.prepare(`SELECT client, project_name FROM agents WHERE id = 's1'`).get()).toEqual({ client: null, project_name: null });
  });
});
