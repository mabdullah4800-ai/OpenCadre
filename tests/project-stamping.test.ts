import type { AddressInfo } from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent, sendMessage, shareFile } from "../src/service.js";
import { createTask } from "../src/tasks.js";
import { decideApproval, requestApproval, revokeApprovalGrant } from "../src/approvals.js";
import { signInPerson } from "./helpers/person.js";
import { emitEvent, recordDecision, verifyEventChain } from "../src/events.js";
import { pauseWorkspace } from "../src/kill-switch.js";
import { createWorkspace, upsertPerson } from "../src/accounts.js";
import { backfillProjectStamps, MIGRATIONS, runMigrations, STAMP_COLUMNS, STAMPED_TABLES } from "../src/migrations.js";
import { formatPreflight, projectIsolationPreflight } from "../scripts/project-isolation-preflight.mjs";
import { linkProjects } from "../src/project-isolation.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { openFast } from "./helpers/sqlite.js";

/** Project isolation, stamping (docs/design/PROJECT_ISOLATION.md §3.1, §3.2, §4, §5.1, §7 item 3): aliases, agent scope,
 * seats bound to their project, write-once project stamps and their backfill, the wake script following a project change,
 * and the read-only pre-flight. Nothing here filters by project: that is enforcement, a later change. */

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let ipCounter = 0;
const nextIp = () => `10.91.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function call(method: string, route: string, { key, body, headers = {} }: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${route}`, {
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ALPHA = { key: "github.com/acme/alpha", name: "Alpha" };
const BETA = { key: "github.com/acme/beta", name: "Beta" };

let orgCounter = 0;
async function computer() {
  // internal: uncapped, so enabling projects part-way through is not refused by the plan limit this
  // suite is not testing (9d1f ruling).
  const { orgId } = createOrganization(`Stamping Org ${++orgCounter}`, "internal");
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const minted = await call("POST", "/v1/org/devices", { key: operator.apiKey, body: { name: "Laptop" } });
  const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: minted.body.code } });
  expect(redeemed.status).toBe(201);
  const enable = async (projectKey: string, enabled = true) =>
    expect((await call("PUT", "/v1/org/projects", { key: operator.apiKey, body: { projectKey, enabled } })).status).toBe(200);
  return { orgId, operator, credential: redeemed.body.deviceCredential as string, deviceId: minted.body.deviceId as string, enable };
}

const chat = (tool: string, project: { key: string; name?: string }, extra: Record<string, string> = {}) => ({
  "x-opencadre-session": tool,
  "x-opencadre-client": "claude-code",
  "x-opencadre-project": project.key,
  ...(project.name ? { "x-opencadre-project-name": project.name } : {}),
  ...extra,
});
const join = (credential: string, headers: Record<string, string>) => call("POST", "/v1/sessions/join", { key: credential, headers });
const agentRow = (id: string) => db.prepare(`SELECT name, project, project_name, client, home_project, scope, seat_id, ended_at FROM agents WHERE id = ?`).get(id) as {
  name: string; project: string | null; project_name: string | null; client: string | null; home_project: string | null; scope: string; seat_id: string | null; ended_at: string | null;
};
/** A session's auto name: one word (sessions PR1), or on collision two words or a word and a number. */
const WORD_NAME = /^[A-Z][a-z]+(?: [A-Z][a-z]+| \d+)?$/;
const stampOf = (table: string, id: string) => (db.prepare(`SELECT project_key FROM ${table} WHERE id = ?`).get(id) as { project_key: string | null }).project_key;
const lastEvent = (orgId: string, type: string) =>
  db.prepare(`SELECT * FROM events WHERE org_id = ? AND type = ? ORDER BY seq DESC LIMIT 1`).get(orgId, type) as { seq: number; payload: string; project_key: string | null; hash: string };

/** A session agent in `project` on a fresh computer, and a workspace-wide named agent next to it. */
async function sessionIn(project = ALPHA) {
  const c = await computer();
  await c.enable(project.key);
  const joined = await join(c.credential, chat(`tool-${project.name}`, project));
  expect(joined.status).toBe(201);
  const coder = registerAgent(c.orgId, "Coder");
  return { ...c, session: { id: joined.body.agentId as string, name: joined.body.agentName as string }, coder: { id: coder.agentId, name: coder.agentName } };
}

describe("aliases (§3.1)", () => {
  it("a legacy-key session and a remote-key session of one repository get the same home project", async () => {
    const c = await computer();
    await c.enable("OpenCadre");
    await c.enable("github.com/mabdullah4800-ai/opencadre");
    // An old client sends the bare folder name and no project name; a current one sends the remote key.
    const legacy = await join(c.credential, chat("legacy-chat", { key: "OpenCadre" }));
    const current = await join(c.credential, chat("current-chat", { key: "github.com/mabdullah4800-ai/opencadre", name: "OpenCadre" }));
    expect(legacy.status).toBe(201);
    expect(current.status).toBe(201);
    expect(agentRow(legacy.body.agentId)).toMatchObject({ project: "OpenCadre", home_project: "github.com/mabdullah4800-ai/opencadre", scope: "project" });
    expect(agentRow(current.body.agentId)).toMatchObject({ project: "github.com/mabdullah4800-ai/opencadre", home_project: "github.com/mabdullah4800-ai/opencadre" });
    expect(db.prepare(`SELECT alias_key, project_key FROM project_aliases WHERE org_id = ?`).all(c.orgId)).toEqual([
      { alias_key: "OpenCadre", project_key: "github.com/mabdullah4800-ai/opencadre" },
    ]);
    // The legacy projects row stays: an old client may still send that key.
    expect(db.prepare(`SELECT enabled FROM projects WHERE org_id = ? AND project_key = 'OpenCadre'`).get(c.orgId)).toEqual({ enabled: 1 });
  });

  it("no alias when the name matches no enabled remote key, or more than one", async () => {
    const c = await computer();
    await c.enable("Widgets");
    await c.enable("github.com/one/widgets");
    await c.enable("github.com/two/widgets");
    await c.enable("Solo");
    const ambiguous = await join(c.credential, chat("amb-chat", { key: "Widgets" }));
    const alone = await join(c.credential, chat("solo-chat", { key: "Solo" }));
    expect(agentRow(ambiguous.body.agentId).home_project).toBe("Widgets");
    expect(agentRow(alone.body.agentId).home_project).toBe("Solo");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM project_aliases WHERE org_id = ?`).get(c.orgId)).toEqual({ n: 0 });
  });
});

describe("migration 15: aliases and agent scope", () => {
  it("aliases legacy keys by the listProjects rule, homes sessions in the resolved project, and makes named agents and people workspace-wide", () => {
    const legacy = new Database(":memory:");
    runMigrations(legacy, MIGRATIONS.filter((m) => m.version < 15));
    legacy.exec(`
      INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'One', 'h'), ('o2', 'Two', 'h');
      INSERT INTO projects (org_id, project_key, name, enabled) VALUES
        ('o1', 'OpenCadre', 'OpenCadre', 1), ('o1', 'github.com/mabdullah4800-ai/opencadre', 'opencadre', 1),
        ('o1', 'Job', 'Job', 1), ('o1', 'github.com/a/job', 'job', 1), ('o1', 'github.com/b/job', 'Job', 1),
        ('o1', 'Off', 'Off', 1), ('o1', 'github.com/a/off', 'off', 0),
        ('o1', 'local:Scratch', 'Scratch', 1), ('o1', 'github.com/a/scratch', 'Scratch', 1),
        ('o2', 'OpenCadre', 'OpenCadre', 1);
      INSERT INTO agents (id, org_id, name, url_key, api_key_hash, kind, device_id, seat_id, project, key_class) VALUES
        ('s1', 'o1', 'ClaudeCode-OpenCadre-a347', 's1', 'x', 'session', 'd1', 'seat1', 'OpenCadre', 'agent'),
        ('s2', 'o1', 'Codex-Job-1111', 's2', 'x', 'session', 'd1', 'seat2', 'Job', 'agent'),
        ('s3', 'o2', 'ClaudeCode-OpenCadre-2222', 's3', 'x', 'session', 'd2', 'seat3', 'OpenCadre', 'agent'),
        ('n1', 'o1', 'Supervisor', 'supervisor', 'x', 'named', NULL, NULL, NULL, 'agent'),
        ('h1', 'o1', 'Pat', 'member-h1', 'x', 'named', NULL, NULL, NULL, 'human');
    `);
    expect(runMigrations(legacy).applied).toEqual(MIGRATIONS.filter((m) => m.version >= 15).map((m) => m.version));
    // Only OpenCadre in o1: Job matches two remote keys, Off's remote key is disabled, local: keys are never aliased,
    // and o2 has no remote key.
    expect(legacy.prepare(`SELECT org_id, alias_key, project_key FROM project_aliases`).all()).toEqual([
      { org_id: "o1", alias_key: "OpenCadre", project_key: "github.com/mabdullah4800-ai/opencadre" },
    ]);
    expect((legacy.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n).toBe(10);
    const agents = legacy.prepare(`SELECT id, home_project, scope FROM agents ORDER BY id`).all();
    expect(agents).toEqual([
      { id: "h1", home_project: null, scope: "workspace" },
      { id: "n1", home_project: null, scope: "workspace" },
      { id: "s1", home_project: "github.com/mabdullah4800-ai/opencadre", scope: "project" },
      { id: "s2", home_project: "Job", scope: "project" },
      { id: "s3", home_project: "OpenCadre", scope: "project" },
    ]);
  });

  it("a named agent or a person created now is workspace-wide too", () => {
    const { orgId } = createOrganization("Scope Org");
    const named = registerAgent(orgId, "Reviewer");
    expect(agentRow(named.agentId)).toMatchObject({ home_project: null, scope: "workspace" });
    const person = upsertPerson({ id: "person-scope-1", email: null, emailVerified: false, name: "Pat", avatarUrl: null } as Parameters<typeof upsertPerson>[0]);
    process.env.OPENCADRE_SIGNUP = "open";
    try {
      const ws = createWorkspace(person, "Pat's Workspace");
      expect(db.prepare(`SELECT scope, home_project FROM agents WHERE org_id = ? AND key_class = 'human'`).all(ws.orgId)).toEqual([{ scope: "workspace", home_project: null }]);
    } finally {
      delete process.env.OPENCADRE_SIGNUP;
    }
  });
});

describe("seats bound to their project (§3.2)", () => {
  it("the same chat in another project is a separate agent; coming back gives the first agent again; /clear keeps each", async () => {
    const c = await computer();
    await c.enable(ALPHA.key);
    await c.enable(BETA.key);
    const host = { "x-opencadre-host-session": "window-1" };
    const inAlpha = await join(c.credential, chat("tool-1", ALPHA, host));
    expect(inAlpha.body).toMatchObject({ created: true, agentName: expect.stringMatching(WORD_NAME) });

    // The user cd's into another repository: same chat (host session), another project.
    const inBeta = await join(c.credential, chat("tool-1", BETA, host));
    expect(inBeta.body).toMatchObject({ created: true, agentName: expect.stringMatching(WORD_NAME) });
    expect(inBeta.body.agentId).not.toBe(inAlpha.body.agentId);
    // The first agent didn't follow the folder. Each row names its own project (the name no longer does).
    expect(agentRow(inAlpha.body.agentId)).toMatchObject({ project: ALPHA.key, project_name: "Alpha", client: "claude-code", home_project: ALPHA.key, ended_at: null });
    expect(agentRow(inBeta.body.agentId)).toMatchObject({ project: BETA.key, project_name: "Beta", client: "claude-code", home_project: BETA.key, scope: "project" });

    // Back in the first repository, after a /clear (new tool session, same host session): the first agent.
    const back = await call("GET", "/v1/me", { key: c.credential, headers: chat("tool-2", ALPHA, host) });
    expect(back.body.agentId).toBe(inAlpha.body.agentId);
    const againBeta = await join(c.credential, chat("tool-3", BETA, host));
    expect(againBeta.body).toEqual({ agentId: inBeta.body.agentId, agentName: inBeta.body.agentName, created: false });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE device_id = ? AND kind = 'session'`).get(c.deviceId) as { n: number }).n).toBe(2);
  });

  it("a hook without the host session id finds the agent of its own project", async () => {
    const c = await computer();
    await c.enable(ALPHA.key);
    await c.enable(BETA.key);
    const host = { "x-opencadre-host-session": "window-h" };
    const a = await join(c.credential, chat("shared-tool", ALPHA, host));
    const b = await join(c.credential, chat("shared-tool", BETA, host));
    const hook = (project: typeof ALPHA) => call("GET", "/v1/me", { key: c.credential, headers: chat("shared-tool", project, { "x-opencadre-resolve-only": "1" }) });
    expect((await hook(ALPHA)).body.agentId).toBe(a.body.agentId);
    expect((await hook(BETA)).body.agentId).toBe(b.body.agentId);
    // Leave names its project too, and ends only that agent.
    expect((await call("POST", "/v1/sessions/leave", { key: c.credential, headers: chat("shared-tool", BETA, host) })).body).toEqual({ ok: true, ended: true });
    expect(agentRow(b.body.agentId).ended_at).not.toBeNull();
    expect(agentRow(a.body.agentId).ended_at).toBeNull();
  });

  it("concurrent first requests in a second project converge on one agent", async () => {
    const c = await computer();
    await c.enable(ALPHA.key);
    await c.enable(BETA.key);
    const host = { "x-opencadre-host-session": "burst-host" };
    await join(c.credential, chat("burst-tool", ALPHA, host));
    const results = await Promise.all(Array.from({ length: 8 }, () => join(c.credential, chat("burst-tool", BETA, host))));
    expect(new Set(results.map((r) => r.body.agentId)).size).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE device_id = ? AND kind = 'session'`).get(c.deviceId) as { n: number }).n).toBe(2);
  });

  it("removing a chat's agent in one project refuses that project only", async () => {
    const c = await computer();
    await c.enable(ALPHA.key);
    await c.enable(BETA.key);
    const host = { "x-opencadre-host-session": "window-r" };
    const a = await join(c.credential, chat("rm-tool", ALPHA, host));
    const b = await join(c.credential, chat("rm-tool", BETA, host));
    expect((await call("DELETE", `/v1/org/agents/${b.body.agentId}`, { key: c.operator.apiKey })).status).toBe(200);
    expect((await join(c.credential, chat("rm-tool-2", BETA, host))).status).toBe(401);
    expect((await join(c.credential, chat("rm-tool-2", ALPHA, host))).body.agentId).toBe(a.body.agentId);
  });
});

describe("stamping rows at write time (§4)", () => {
  it("stamps messages, tasks, approvals, grants, files and events with the acting agent's home project", async () => {
    const w = await sessionIn(ALPHA);
    const me = w.session;

    await sendMessage(w.orgId, me, w.coder.name, "hello from alpha");
    const message = db.prepare(`SELECT id, project_key, to_project_key FROM messages WHERE from_agent_id = ?`).get(me.id);
    expect(message).toMatchObject({ project_key: ALPHA.key, to_project_key: null });

    const task = createTask(w.orgId, me, { title: "stamp me" });
    expect(task.project_key).toBe(ALPHA.key);

    const approval = await requestApproval(w.orgId, me, { action: "git push --force", category: "force-push" });
    expect(approval.project_key).toBe(ALPHA.key);
    // A person decides a clearance (migration 53), through their member agent; the operator agent no longer can.
    const { decider } = await signInPerson(w.orgId);
    const decided = decideApproval(w.orgId, decider, approval.id, "approve", null, { grantMinutes: 5 });
    expect(decided.ok && decided.grant?.project_key).toBe(ALPHA.key);

    const shared = await shareFile(w.orgId, me, w.coder.name, "notes.md", "text/markdown", Buffer.from("# notes"), "see file");
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(stampOf("files", shared.fileId)).toBe(ALPHA.key);

    recordDecision(w.orgId, me, { title: "use sqlite" });

    // Events: the column, and the same key inside the (hashed) payload.
    for (const type of ["session.joined", "message.sent", "task.created", "approval.requested", "approval.decided", "approval.grant_created", "decision.recorded"]) {
      const event = lastEvent(w.orgId, type);
      expect(event.project_key, type).toBe(ALPHA.key);
      expect(JSON.parse(event.payload).project_key, type).toBe(ALPHA.key);
    }
    // A grant is deleted before its revoke event: the stamp still comes through.
    // Agents keep revoke (it only removes permission): the operator agent revokes the person's grant.
    expect(revokeApprovalGrant(w.orgId, decided.ok ? decided.grant!.id : "", { id: w.operator.agentId, name: "Operator" })).toBe(true);
    expect(lastEvent(w.orgId, "approval.grant_revoked").project_key).toBe(ALPHA.key);
    expect(verifyEventChain(w.orgId)).toEqual({ ok: true });
  });

  it("a workspace-wide agent's rows are workspace-level (null), and org events carry no project", async () => {
    const w = await sessionIn(ALPHA);
    await sendMessage(w.orgId, w.coder, w.session.name, "from a named agent");
    const message = db.prepare(`SELECT project_key, to_project_key FROM messages WHERE from_agent_id = ?`).get(w.coder.id);
    expect(message).toEqual({ project_key: null, to_project_key: ALPHA.key });
    expect(createTask(w.orgId, w.coder, { title: "workspace task" }).project_key).toBeNull();
    pauseWorkspace(w.orgId, { id: w.operator.agentId, name: "Operator" });
    const paused = lastEvent(w.orgId, "workspace.paused");
    expect(paused.project_key).toBeNull();
    expect(JSON.parse(paused.payload)).not.toHaveProperty("project_key");
  });

  it("a workspace-wide agent names a task's project; a session's task is always its own project's", async () => {
    const w = await sessionIn(ALPHA);
    const coderKey = registerAgent(w.orgId, "Planner").apiKey;
    const named = await call("POST", "/v1/tasks", { key: coderKey, body: { title: "for alpha", project: ALPHA.key } });
    expect(named).toMatchObject({ status: 201, body: { task: { project_key: ALPHA.key } } });
    expect((await call("POST", "/v1/tasks", { key: coderKey, body: { title: "unknown", project: "github.com/acme/nowhere" } })).status).toBe(400);
    expect((await call("POST", "/v1/tasks", { key: coderKey, body: { title: "bad", project: "not a key/x y" } })).status).toBe(400);
    const fromSession = await call("POST", "/v1/tasks", { key: w.credential, headers: chat(`tool-${ALPHA.name}`, ALPHA), body: { title: "mine", project: BETA.key } });
    expect(fromSession).toMatchObject({ status: 201, body: { task: { project_key: ALPHA.key } } });
  });

  it("a cross-project message is stamped with both ends: project_key and to_project_key", async () => {
    const c = await computer();
    await c.enable(ALPHA.key);
    await c.enable(BETA.key);
    // A new workspace enforces project isolation, so a message between two projects needs a link (PROJECT_ISOLATION.md §3.4).
    linkProjects(c.orgId, { id: c.operator.agentId, name: "Operator" }, ALPHA.key, BETA.key);
    const a = await join(c.credential, chat("x-alpha", ALPHA));
    const b = await join(c.credential, chat("x-beta", BETA));
    const sent = await sendMessage(c.orgId, { id: a.body.agentId, name: a.body.agentName }, b.body.agentName, "across");
    expect(sent.ok).toBe(true);
    expect(db.prepare(`SELECT project_key, to_project_key FROM messages WHERE from_agent_id = ?`).get(a.body.agentId)).toEqual({ project_key: ALPHA.key, to_project_key: BETA.key });
  });
});

describe("write-once stamps", () => {
  it("refuses to re-stamp a row on every stamped table; a NULL stamp can still be filled", async () => {
    const w = await sessionIn(ALPHA);
    await sendMessage(w.orgId, w.session, w.coder.name, "stamped");
    createTask(w.orgId, w.session, { title: "stamped" });
    const approval = await requestApproval(w.orgId, w.session, { action: "rm -rf build", category: "rm-rf" });
    expect(decideApproval(w.orgId, (await signInPerson(w.orgId)).decider, approval.id, "approve", null, { grantMinutes: 5 }).ok).toBe(true);
    await shareFile(w.orgId, w.session, w.coder.name, "a.md", "text/markdown", Buffer.from("a"), "file");
    await sendMessage(w.orgId, w.coder, w.session.name, "to a session");

    for (const [table, column] of STAMP_COLUMNS) {
      const row = db.prepare(`SELECT rowid AS rid FROM ${table} WHERE org_id = ? AND ${column} IS NOT NULL LIMIT 1`).get(w.orgId) as { rid: number } | undefined;
      expect(row, `${table}.${column} has a stamped row`).toBeDefined();
      expect(() => db.prepare(`UPDATE ${table} SET ${column} = 'github.com/evil/repo' WHERE rowid = ?`).run(row!.rid), `${table}.${column}`).toThrow(/write-once/);
      expect(() => db.prepare(`UPDATE ${table} SET ${column} = NULL WHERE rowid = ?`).run(row!.rid), `${table}.${column} cleared`).toThrow(/write-once/);
    }
    // The named agent's message has a NULL project_key: filling it is allowed (that is what the backfill does).
    const unstamped = db.prepare(`SELECT id FROM messages WHERE from_agent_id = ? AND project_key IS NULL`).get(w.coder.id) as { id: string };
    db.prepare(`UPDATE messages SET project_key = ? WHERE id = ?`).run(BETA.key, unstamped.id);
    expect(stampOf("messages", unstamped.id)).toBe(BETA.key);
    expect(STAMP_COLUMNS.map(([t, c]) => `${t}.${c}`)).toEqual([...STAMPED_TABLES.map((t) => `${t}.project_key`), "messages.to_project_key"]);
  });
});

describe("backfill (migration 16)", () => {
  it("stamps old rows from their writer's agents.project through the aliases, leaves the rest NULL, and is idempotent", () => {
    const legacy = new Database(":memory:");
    runMigrations(legacy, MIGRATIONS.filter((m) => m.version < 15));
    legacy.exec(`
      INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'One', 'h');
      INSERT INTO projects (org_id, project_key, name, enabled) VALUES ('o1', 'OpenCadre', 'OpenCadre', 1), ('o1', 'github.com/mabdullah4800-ai/opencadre', 'OpenCadre', 1), ('o1', 'github.com/acme/job', 'job', 1);
      INSERT INTO agents (id, org_id, name, url_key, api_key_hash, kind, device_id, seat_id, project) VALUES
        ('s1', 'o1', 'ClaudeCode-OpenCadre-a347', 's1', 'x', 'session', 'd1', 'seat1', 'OpenCadre'),
        ('s2', 'o1', 'Codex-job-1111', 's2', 'x', 'session', 'd1', 'seat2', 'github.com/acme/job'),
        ('n1', 'o1', 'Supervisor', 'supervisor', 'x', 'named', NULL, NULL, NULL);
      INSERT INTO messages (id, org_id, thread_id, from_agent_id, from_agent_name, to_agent_id, to_agent_name, body) VALUES
        ('m1', 'o1', 't1', 's1', 'a', 's2', 'b', 'x'), ('m2', 'o1', 't2', 'n1', 'n', 's1', 'a', 'x'), ('m3', 'o1', 't3', 'gone', 'g', 'n1', 'n', 'x');
      INSERT INTO tasks (id, org_id, title, created_by_agent_id, created_by_agent_name) VALUES ('t1', 'o1', 'x', 's2', 'b'), ('t2', 'o1', 'x', 'n1', 'n');
      INSERT INTO approvals (id, org_id, requested_by_agent_id, requested_by_agent_name, action, expires_at) VALUES ('a1', 'o1', 's1', 'a', 'x', '2030-01-01');
      -- g1 is already expired: migration 53 expires every still-active grant no person made and puts that on the
      -- timeline, which would add an event this backfill snapshot is not about (tests/person-approvals.test.ts has it).
      INSERT INTO approval_grants (id, org_id, agent_id, agent_name, category, granted_by_agent_id, granted_by_agent_name, expires_at) VALUES ('g1', 'o1', 's1', 'a', 'c', 'n1', 'n', '2020-01-01');
      INSERT INTO files (id, org_id, uploaded_by_agent_id, uploaded_by_agent_name, filename, mime_type, size_bytes, content) VALUES ('f1', 'o1', 's2', 'b', 'a.md', 'text/markdown', 1, x'41');
      INSERT INTO events (id, org_id, type, actor_agent_id, subject_type, subject_id, payload) VALUES
        ('e1', 'o1', 'message.sent', 's1', 'message', 'm1', '{}'),
        ('e2', 'o1', 'task.created', 'n1', 'task', 't1', '{}'),
        ('e3', 'o1', 'approval.requested', 's1', 'approval', 'a1', '{}'),
        ('e4', 'o1', 'approval.grant_created', 'n1', 'grant', 'g1', '{}'),
        ('e5', 'o1', 'session.joined', 's2', 'agent', 's2', '{}'),
        ('e6', 'o1', 'decision.recorded', 's1', 'decision', 'd-1', '{}'),
        ('e7', 'o1', 'conflict.detected', 'n1', 'conflict', 'c-1', '{}'),
        ('e8', 'o1', 'clearance.policy_changed', 'n1', 'clearance', 'OpenCadre', '{}'),
        ('e9', 'o1', 'clearance.policy_changed', 'n1', 'clearance', 'workspace', '{}'),
        ('e10', 'o1', 'project.enabled', 'n1', 'project', 'github.com/acme/job', '{}'),
        ('e11', 'o1', 'workspace.paused', 'n1', 'workspace', 'o1', '{}'),
        ('e12', 'o1', 'clearance.bypassed', 's2', 'clearance', 's2', '{}');
    `);
    runMigrations(legacy);
    const stamps = (table: string, extra = "") => Object.fromEntries((legacy.prepare(`SELECT id, project_key${extra} FROM ${table} ORDER BY rowid`).all() as Array<Record<string, string | null>>)
      .map((r) => [r.id, extra ? [r.project_key, r.to_project_key] : r.project_key]));
    const OC = "github.com/mabdullah4800-ai/opencadre";
    const JOB = "github.com/acme/job";
    const expected = {
      messages: { m1: [OC, JOB], m2: [null, OC], m3: [null, null] },
      tasks: { t1: JOB, t2: null },
      approvals: { a1: OC },
      approval_grants: { g1: OC },
      files: { f1: JOB },
      events: { e1: OC, e2: JOB, e3: OC, e4: OC, e5: JOB, e6: OC, e7: null, e8: OC, e9: null, e10: JOB, e11: null, e12: JOB },
    };
    const snapshot = () => ({
      messages: stamps("messages", ", to_project_key"), tasks: stamps("tasks"), approvals: stamps("approvals"),
      approval_grants: stamps("approval_grants"), files: stamps("files"), events: stamps("events"),
    });
    expect(snapshot()).toEqual(expected);
    // Payloads are never rewritten by the backfill.
    expect(legacy.prepare(`SELECT DISTINCT payload FROM events`).all()).toEqual([{ payload: "{}" }]);

    // Idempotent: a second run changes nothing, even after an agent's project changes (stamps are write-once).
    legacy.exec(`UPDATE agents SET project = 'github.com/acme/other' WHERE id = 's1'`);
    backfillProjectStamps(legacy);
    expect(snapshot()).toEqual(expected);
  });

  it("the event chain still verifies after backfilling events written before stamping", async () => {
    const { orgId } = createOrganization("Chain Backfill Org");
    const old = registerAgent(orgId, "Old");
    const peer = registerAgent(orgId, "Peer");
    const actor = { id: old.agentId, name: "Old" };
    // Written as a pre-stamping build would: the writer had no home, so every stamp is NULL and no payload names a project.
    recordDecision(orgId, actor, { title: "before stamping" });
    createTask(orgId, actor, { title: "old task" });
    await sendMessage(orgId, actor, "Peer", "old message");
    emitEvent({ orgId, type: "agent.task_changed", actor, subjectType: "agent", subjectId: old.agentId, payload: { from: null, to: "x" } });
    const before = db.prepare(`SELECT seq, payload, hash, project_key FROM events WHERE org_id = ? ORDER BY seq`).all(orgId) as Array<{ seq: number; payload: string; hash: string; project_key: string | null }>;
    expect(before.every((e) => e.project_key === null)).toBe(true);
    expect(verifyEventChain(orgId)).toEqual({ ok: true });

    // The agent's project as the backfill finds it: a legacy key with an alias.
    db.prepare(`INSERT INTO project_aliases (org_id, alias_key, project_key, created_at) VALUES (?, 'OpenCadre', 'github.com/mabdullah4800-ai/opencadre', ?)`).run(orgId, new Date().toISOString());
    db.prepare(`UPDATE agents SET project = 'OpenCadre' WHERE id = ?`).run(old.agentId);
    backfillProjectStamps(db);

    const after = db.prepare(`SELECT seq, payload, hash, project_key FROM events WHERE org_id = ? ORDER BY seq`).all(orgId) as typeof before;
    expect(after.map((e) => e.project_key)).toEqual(before.map(() => "github.com/mabdullah4800-ai/opencadre"));
    expect(after.map(({ payload, hash }) => ({ payload, hash }))).toEqual(before.map(({ payload, hash }) => ({ payload, hash })));
    expect(verifyEventChain(orgId)).toEqual({ ok: true });
    // New events keep chaining on top, and a second backfill is a no-op.
    recordDecision(orgId, { id: peer.agentId, name: "Peer" }, { title: "after" });
    backfillProjectStamps(db);
    expect(verifyEventChain(orgId)).toEqual({ ok: true });
    // The payload copy makes a new event's stamp tamper-evident: editing the payload breaks the chain.
    const w = await sessionIn(BETA);
    const joined = lastEvent(w.orgId, "session.joined");
    expect(verifyEventChain(w.orgId)).toEqual({ ok: true });
    db.prepare(`UPDATE events SET payload = ? WHERE seq = ?`).run(JSON.stringify({ ...JSON.parse(joined.payload), project_key: ALPHA.key }), joined.seq);
    expect(verifyEventChain(w.orgId)).toEqual({ ok: false, brokenAtSeq: joined.seq });
  });
});

describe("wake script (§5.1)", () => {
  it("re-resolves its identity when the folder's project changes between polls, and wakes the new project's agent", async () => {
    const c = await computer();
    await c.enable(ALPHA.key);
    await c.enable(BETA.key);
    const repo = path.join(mkdtempSync(path.join(tmpdir(), "oc-stamp-wake-")), "work");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    const setRemote = (remote: string) => writeFileSync(path.join(repo, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n`);
    setRemote("https://github.com/acme/alpha.git");
    const a = await join(c.credential, chat("wake-switch", ALPHA));
    const b = await join(c.credential, chat("wake-switch", BETA));
    expect(b.body.agentId).not.toBe(a.body.agentId);

    const home = mkdtempSync(path.join(tmpdir(), "oc-stamp-wake-home-"));
    mkdirSync(path.join(home, ".opencadre"));
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ devices: { "claude-code": { hub: base, credential: c.credential } } }));
    const running = new Promise<{ exited: boolean; code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "opencadre-wake.mjs"), "--rewake", "--client", "claude-code"], {
        env: {
          ...process.env, OPENCADRE_URL: "", OPENCADRE_KEY: "", CLAUDE_CODE_SESSION_ID: "", CLAUDE_CODE_HOST_SESSION_ID: "",
          OPENCADRE_HOOK_HOME: home, OPENCADRE_WAKE_STATE_DIR: mkdtempSync(path.join(tmpdir(), "oc-stamp-wake-state-")), OPENCADRE_WAIT_SECONDS: "1",
        },
      });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "wake-switch", cwd: repo }));
      const timer = setTimeout(() => { child.kill(); resolve({ exited: false, code: null, err }); }, 12_000);
      child.on("exit", (code) => { clearTimeout(timer); resolve({ exited: true, code, err }); });
    });
    await new Promise((r) => setTimeout(r, 1500));
    setRemote("git@github.com:acme/beta.git");
    await new Promise((r) => setTimeout(r, 3000));
    await sendMessage(c.orgId, { id: registerAgent(c.orgId, "Pinger").agentId, name: "Pinger" }, b.body.agentName, "mail for the beta agent");
    const result = await running;
    expect(result).toMatchObject({ exited: true, code: 2 });
    expect(result.err).toContain("mail for the beta agent");
    expect(result.err).not.toContain(c.credential);
  }, 20_000);
});

describe("pre-flight report (§7 item 3)", () => {
  function workspaceDb() {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "oc-preflight-")), "hub.db");
    // A file under tmpdir() -- on B: for this box -- migrated and then bulk-inserted. Without the
    // pragmas this one fixture is the whole cost of the file: measured FAIL at 5690-8900 ms against
    // vitest's unchosen 5000 ms default, PASS at 25-27 ms with them, 4/4 paired. See helpers/sqlite.ts.
    const hub = openFast(file);
    runMigrations(hub);
    hub.exec(`
      INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Operator PC', 'h');
      INSERT INTO projects (org_id, project_key, name, enabled) VALUES
        ('o1', 'OpenCadre', 'OpenCadre', 1), ('o1', 'github.com/mabdullah4800-ai/opencadre', 'OpenCadre', 1), ('o1', 'github.com/acme/job', 'job', 1), ('o1', 'github.com/acme/off', 'off', 0);
      INSERT INTO agents (id, org_id, name, url_key, api_key_hash, kind, device_id, seat_id, project, home_project, scope) VALUES
        ('s1', 'o1', 'ClaudeCode-OpenCadre-a347', 's1', 'x1', 'session', 'd1', 'seat1', 'OpenCadre', 'OpenCadre', 'project'),
        ('s2', 'o1', 'ClaudeCode-opencadre-6ac9', 's2', 'x2', 'session', 'd1', 'seat2', 'github.com/mabdullah4800-ai/opencadre', 'github.com/mabdullah4800-ai/opencadre', 'project'),
        ('s3', 'o1', 'Codex-job-1111', 's3', 'x3', 'session', 'd1', 'seat3', 'github.com/acme/job', 'github.com/acme/job', 'project'),
        ('s4', 'o1', 'Codex-job-2222', 's4', 'x4', 'session', 'd1', 'seat4', 'github.com/acme/job', 'github.com/acme/job', 'project'),
        ('n1', 'o1', 'Supervisor', 'supervisor', 'x5', 'named', NULL, NULL, NULL, NULL, 'workspace');
      UPDATE agents SET ended_at = '2026-09-01 00:00:00' WHERE id = 's4';
      INSERT INTO tasks (id, org_id, title, created_by_agent_id, created_by_agent_name, project_key) VALUES
        ('t1', 'o1', 'x', 's3', 'c', 'github.com/acme/job'), ('t2', 'o1', 'x', 'n1', 'n', NULL);
    `);
    return { hub, file };
  }

  it("lists enabled projects with live agents and stamped counts, and flags a repository split across keys", () => {
    const { hub } = workspaceDb();
    const report = projectIsolationPreflight(hub);
    expect(report.flagged).toBe(true);
    const [ws] = report.workspaces;
    expect(ws.projects.map((p: { projectKey: string }) => p.projectKey)).toEqual(["github.com/acme/job", "github.com/mabdullah4800-ai/opencadre", "OpenCadre"]);
    expect(ws.projects[0]).toMatchObject({ liveAgents: [{ name: "Codex-job-1111", kind: "session", scope: "project" }], stampedRows: { tasks: 1, messages: 0 } });
    expect(ws.workspaceLevel).toMatchObject({ liveAgents: [{ name: "Supervisor", kind: "named", scope: "workspace" }], stampedRows: { tasks: 1 } });
    expect(ws.splits).toEqual([{
      name: "opencadre",
      keys: [
        { projectKey: "github.com/mabdullah4800-ai/opencadre", liveAgents: ["ClaudeCode-opencadre-6ac9"] },
        { projectKey: "OpenCadre", liveAgents: ["ClaudeCode-OpenCadre-a347"] },
      ],
    }]);
    expect(formatPreflight(report)).toContain("SPLIT");

    // With the alias in place both sessions resolve to one key: nothing is flagged, and the alias is listed.
    hub.prepare(`INSERT INTO project_aliases (org_id, alias_key, project_key, created_at) VALUES ('o1', 'OpenCadre', 'github.com/mabdullah4800-ai/opencadre', 'now')`).run();
    const fixed = projectIsolationPreflight(hub);
    expect(fixed.flagged).toBe(false);
    expect(fixed.workspaces[0].projects.find((p: { projectKey: string }) => p.projectKey === "github.com/mabdullah4800-ai/opencadre")).toMatchObject({
      aliases: ["OpenCadre"], liveAgents: [{ name: "ClaudeCode-OpenCadre-a347" }, { name: "ClaudeCode-opencadre-6ac9" }],
    });
    expect(formatPreflight(fixed)).toContain("Pre-flight passed. Nothing was changed.");
  });

  it("the script opens the database read-only, changes nothing, and exits 2 on a split", async () => {
    const { hub, file } = workspaceDb();
    hub.close();
    const before = readFileSync(file);
    const mtime = statSync(file).mtimeMs;
    const run = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "project-isolation-preflight.mjs"), "--db", file]);
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("exit", (code) => resolve({ code, out }));
    });
    expect(run.code).toBe(2);
    expect(run.out).toContain("Workspace Operator PC (o1)");
    expect(run.out).toContain("SPLIT");
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(mtime);
  }, SPAWN_TEST_TIMEOUT_MS); // starts the script as a child process
});
