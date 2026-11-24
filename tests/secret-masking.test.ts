import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db, newId } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { emitEvent, verifyEventChain } from "../src/events.js";
import { getAwareness } from "../src/awareness.js";
import { reportExecuted } from "../src/clearance-bypass.js";
import { MAX_APPROVAL_ACTION_CHARS, MAX_APPROVAL_DETAILS_CHARS } from "../src/approvals.js";
import { MIGRATIONS, runMigrations } from "../src/migrations.js";
import { listProjects, setProjectEnabled } from "../src/projects.js";
import { signInPerson } from "./helpers/person.js";

// Obviously fake secrets.
const AGENT_KEY = `agt_${"0".repeat(48)}`;
const GH_TOKEN = `ghp_${"0".repeat(36)}`;
const LEAKY = `ALPHA="${AGENT_KEY}" GITHUB_TOKEN=${GH_TOKEN} KEY=plainsecretvalue curl -H "AUTHORIZATION: raw-secret-abcdefgh" https://x`;
const MASKED = `ALPHA="agt_***" GITHUB_TOKEN=*** KEY=*** curl -H "AUTHORIZATION: ***" https://x`;
const LEAKY_DETAILS = `ran with --token hunter2 against https://user:hunter2@example.com/x`;
const MASKED_DETAILS = `ran with --token *** against https://user:***@example.com/x`;
const LEAK = /agt_0{10}|ghp_0{10}|hunter2|plainsecret|raw-secret/;

let restServer: http.Server;
let restUrl: string;
let mcpServer: http.Server;
let mcpUrl: URL;

beforeAll(async () => {
  restServer = app.listen(0);
  await new Promise((r) => restServer.once("listening", r));
  restUrl = `http://127.0.0.1:${(restServer.address() as AddressInfo).port}`;
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

function workspace(name: string) {
  const { orgId } = createOrganization(name);
  const coder = registerAgent(orgId, "Coder");
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  return {
    orgId,
    coder: { id: coder.agentId, name: "Coder", key: coder.apiKey },
    operator: { id: operator.agentId, name: "Operator", key: operator.apiKey },
  };
}

const rest = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${restUrl}${path}`, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

async function mcpText(key: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const client = new Client({ name: "mask-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return result.content.map((c) => c.text).join("\n");
  } finally {
    await client.close();
  }
}

/** Every read an agent or the console has on approvals and the timeline, for one approval. */
async function everyRead(ws: ReturnType<typeof workspace>, approvalId: string) {
  return {
    one: (await rest(ws.operator.key, "GET", `/v1/approvals/${approvalId}`)).body.approval,
    list: (await rest(ws.operator.key, "GET", "/v1/approvals")).body.approvals.find((a: { id: string }) => a.id === approvalId),
    wait: (await rest(ws.operator.key, "GET", `/v1/approvals/${approvalId}/wait?timeoutSeconds=1`)).body.approval,
    events: JSON.stringify((await rest(ws.operator.key, "GET", "/v1/events?limit=200")).body.events),
    eventsWait: JSON.stringify((await rest(ws.operator.key, "GET", "/v1/events/wait?after=0&timeoutSeconds=1")).body.events),
    deliveries: JSON.stringify((await rest(ws.operator.key, "GET", "/v1/deliveries")).body.events),
    awareness: (await rest(ws.operator.key, "GET", "/v1/awareness?since=0")).body.text as string,
    mcpList: await mcpText(ws.operator.key, "list_approvals"),
    mcpTimeline: await mcpText(ws.operator.key, "get_timeline", { after: 0 }),
    mcpAwareness: await mcpText(ws.operator.key, "get_awareness", { since: 0 }),
  };
}

function expectAllMasked(reads: Awaited<ReturnType<typeof everyRead>>) {
  expect(reads.one.action).toBe(MASKED);
  expect(reads.one.details).toBe(MASKED_DETAILS);
  expect(reads.list.action).toBe(MASKED);
  expect(reads.wait.action).toBe(MASKED);
  expect(reads.events).toContain("agt_***");
  expect(reads.awareness).toContain(MASKED);
  expect(reads.mcpList).toContain(MASKED);
  expect(reads.mcpTimeline).toContain("agt_***");
  expect(reads.mcpAwareness).toContain(MASKED);
  for (const [where, text] of Object.entries(reads)) expect(JSON.stringify(text), where).not.toMatch(LEAK);
}

describe("secrets in clearance records", () => {
  it("an approval request stores masked text and every read returns it masked", async () => {
    const ws = workspace("Mask Write Org");
    const created = await rest(ws.coder.key, "POST", "/v1/approvals", { action: LEAKY, details: LEAKY_DETAILS, approver: "Operator", risk: "high" });
    expect(created.status).toBe(201);
    expect(created.body.approval.action).toBe(MASKED);

    // Stored masked: the approval row, its event payload and the approver's notice.
    const row = db.prepare(`SELECT action, details FROM approvals WHERE id = ?`).get(created.body.approval.id) as { action: string; details: string };
    expect(row).toEqual({ action: MASKED, details: MASKED_DETAILS });
    const stored = db.prepare(`SELECT payload FROM events WHERE org_id = ?`).all(ws.orgId) as Array<{ payload: string }>;
    expect(stored.some((e) => e.payload.includes("agt_***"))).toBe(true);
    expect(JSON.stringify(stored)).not.toMatch(LEAK);
    const notices = db.prepare(`SELECT body FROM messages WHERE org_id = ?`).all(ws.orgId) as Array<{ body: string }>;
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain(MASKED);
    expect(notices[0].body).not.toMatch(LEAK);

    expectAllMasked(await everyRead(ws, created.body.approval.id));
  });

  it("an old unmasked row and event, written before masking, are returned masked without touching the event chain", async () => {
    const ws = workspace("Mask Old Row Org");
    const id = newId();
    db.prepare(
      `INSERT INTO approvals (id, org_id, requested_by_agent_id, requested_by_agent_name, action, details, risk, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'high', 'pending', ?)`,
    ).run(id, ws.orgId, ws.coder.id, ws.coder.name, LEAKY, LEAKY_DETAILS, new Date(Date.now() + 600_000).toISOString());
    // emitEvent stores the payload as given, like every event written before masking.
    emitEvent({ orgId: ws.orgId, type: "approval.requested", actor: ws.coder, subjectType: "approval", subjectId: id, targetAgentId: ws.operator.id, payload: { action: LEAKY, risk: "high" } });

    expectAllMasked(await everyRead(ws, id));

    // Read-time only: the stored event keeps its payload, so the hash chain still verifies.
    const payload = (db.prepare(`SELECT payload FROM events WHERE org_id = ? AND subject_id = ?`).get(ws.orgId, id) as { payload: string }).payload;
    expect(payload).toContain(AGENT_KEY);
    expect(verifyEventChain(ws.orgId)).toEqual({ ok: true });
  });

  it("an old event whose action was cut inside a quoted secret (no closing quote) is returned masked", async () => {
    const ws = workspace("Mask Unterminated Org");
    const cut = `${"x".repeat(160)} && export AUDIT_SESSION_TOKEN="lgZfakefake`;
    emitEvent({ orgId: ws.orgId, type: "approval.requested", actor: ws.coder, subjectType: "approval", subjectId: newId(), targetAgentId: ws.operator.id, payload: { action: cut, risk: "high" } });

    const rows = (await rest(ws.operator.key, "GET", "/v1/events?limit=200")).body.events as Array<{ type: string; payload: string }>;
    const requested = rows.find((e) => e.type === "approval.requested")!;
    expect(JSON.parse(requested.payload).action).toBe(`${"x".repeat(160)} && export AUDIT_SESSION_TOKEN="***`);
    const events = JSON.stringify(rows);
    const timeline = await mcpText(ws.operator.key, "get_timeline", { after: 0 });
    const awareness = (await rest(ws.operator.key, "GET", "/v1/awareness?since=0")).body.text as string;
    expect(awareness).toContain('AUDIT_SESSION_TOKEN="***');
    for (const text of [events, timeline, awareness]) expect(text).not.toContain("lgZ");
    expect(verifyEventChain(ws.orgId)).toEqual({ ok: true });
  });

  it("a post-execution report masks the command before it is recorded or announced", async () => {
    const ws = workspace("Mask Report Org");
    expect((await reportExecuted(ws.orgId, ws.coder, { action: LEAKY, required: "record", category: "deploy" })).outcome).toBe("recorded");
    // The same command reported again matches the masked record rather than making a second one.
    expect((await reportExecuted(ws.orgId, ws.coder, { action: LEAKY, required: "record", category: "deploy" })).outcome).toBe("already_recorded");
    expect((await reportExecuted(ws.orgId, ws.coder, { action: `${LEAKY} --prod`, required: "approval", category: "deploy" })).outcome).toBe("bypassed");
    const stored = JSON.stringify([
      db.prepare(`SELECT action, details FROM approvals WHERE org_id = ?`).all(ws.orgId),
      db.prepare(`SELECT payload FROM events WHERE org_id = ?`).all(ws.orgId),
      db.prepare(`SELECT body FROM messages WHERE org_id = ?`).all(ws.orgId),
    ]);
    expect(stored).toContain("agt_***");
    expect(stored).not.toMatch(LEAK);
  });

  it("awareness text for an approval shows the masked command", async () => {
    const ws = workspace("Mask Awareness Org");
    await rest(ws.coder.key, "POST", "/v1/approvals", { action: LEAKY, approver: "Operator" });
    const digest = getAwareness(ws.orgId, ws.operator.id, { since: 0 });
    expect(digest.text).toContain(`needs your approval: ${MASKED}`);
    expect(digest.text).not.toMatch(LEAK);
  });

  it("caps stored action and details, masking a secret that straddles the cut", async () => {
    const ws = workspace("Mask Cap Org");
    const action = `${"a".repeat(MAX_APPROVAL_ACTION_CHARS - 10)} KEY=plainsecretvalue ${"b".repeat(50_000)}`;
    // " --token hunter2" runs past the cap; masked (" --token ***") it ends exactly at it.
    const details = `${"d".repeat(MAX_APPROVAL_DETAILS_CHARS - 12)} --token hunter2 ${"e".repeat(200_000)}`;
    const created = await rest(ws.coder.key, "POST", "/v1/approvals", { action, details, notifyOnly: true });
    expect(created.status).toBe(201);
    const row = db.prepare(`SELECT action, details FROM approvals WHERE id = ?`).get(created.body.approval.id) as { action: string; details: string };
    expect(row.action).toHaveLength(MAX_APPROVAL_ACTION_CHARS + 1);
    expect(row.action).toContain(" KEY=*** b");
    expect(row.action.endsWith("b…")).toBe(true);
    expect(row.details).toHaveLength(MAX_APPROVAL_DETAILS_CHARS + 1);
    expect(row.details.endsWith(" --token ***…")).toBe(true);
    expect(JSON.stringify(row)).not.toMatch(LEAK);
    // Short text is stored as sent, with no ellipsis.
    const short = await rest(ws.coder.key, "POST", "/v1/approvals", { action: "rm -rf ./x", details: "short", notifyOnly: true });
    expect(short.body.approval).toMatchObject({ action: "rm -rf ./x", details: "short" });
  });
});

// Every summary of agent text is masked BEFORE it is cut. Cut first, and a key sliced below its minimum length
// (agt_ + 10 characters) no longer looks like a key, so no later masking can find it. The key below is placed so each
// limit cuts it to exactly that fragment.
describe("truncation order: mask, then cut", () => {
  const FRAGMENT = /agt_0{10}/;
  /** Text whose agt_ key starts `limit - 14` characters in, so a plain cut at `limit` keeps agt_ + 10 zeros. */
  const keyAt = (limit: number) => `${"x ".repeat((limit - 14) / 2)}agt_${"0".repeat(48)} tail`;
  const storedPayloads = (orgId: string) => JSON.stringify(db.prepare(`SELECT type, payload FROM events WHERE org_id = ?`).all(orgId));

  it("approval summaries, decision notes, notices and the push text", async () => {
    const ws = workspace("Cut Order Approvals Org");
    const created = await rest(ws.coder.key, "POST", "/v1/approvals", { action: keyAt(200), approver: "Operator" });
    // A person decides a clearance (migration 53): the note arrives through the console session, not an agent key.
    const { headers } = await signInPerson(ws.orgId);
    const res = await fetch(`${restUrl}/v1/approvals/${created.body.approval.id}/decide`, { method: "POST", headers, body: JSON.stringify({ decision: "deny", note: keyAt(200) }) });
    const decided = { status: res.status, body: await res.json() };
    expect(decided.status).toBe(200);
    expect(decided.body.approval.decision_note).toContain("agt_***");
    const stored = storedPayloads(ws.orgId);
    expect(stored).toContain("agt_***");
    expect(stored).not.toMatch(FRAGMENT);
    expect(JSON.stringify(db.prepare(`SELECT action, decision_note FROM approvals WHERE org_id = ?`).all(ws.orgId))).not.toMatch(FRAGMENT);

    const { approvalPushMessage } = await import("../src/push.js");
    const push = approvalPushMessage({ id: "a1", org_id: ws.orgId, action: keyAt(140), risk: "high", requested_by_agent_name: "Coder" }, "W");
    expect(push.body).toContain("agt_***");
    expect(push.body).not.toMatch(FRAGMENT);

    // The approver's notice cuts details at 4000 characters.
    const noticed = workspace("Cut Order Notice Org");
    await rest(noticed.coder.key, "POST", "/v1/approvals", { action: "deploy", details: keyAt(4000), approver: "Operator" });
    const notices = JSON.stringify(db.prepare(`SELECT body FROM messages WHERE org_id = ?`).all(noticed.orgId));
    expect(notices).toContain("agt_***");
    expect(notices).not.toMatch(FRAGMENT);
  });

  it("clearance bypass notices, task completion summaries and recorded decisions", async () => {
    const ws = workspace("Cut Order Other Org");
    expect((await reportExecuted(ws.orgId, ws.coder, { action: keyAt(300), required: "approval", approver: "Operator" })).outcome).toBe("bypassed");
    const notices = JSON.stringify(db.prepare(`SELECT body FROM messages WHERE org_id = ?`).all(ws.orgId));
    expect(notices).not.toMatch(FRAGMENT);

    const { claimTask, completeTask, createTask } = await import("../src/tasks.js");
    const task = createTask(ws.orgId, ws.coder, { title: "ship it" });
    expect(claimTask(ws.orgId, ws.coder, task.id).ok).toBe(true);
    expect(completeTask(ws.orgId, ws.coder, task.id, keyAt(200)).ok).toBe(true);

    const { recordDecision } = await import("../src/events.js");
    recordDecision(ws.orgId, ws.coder, { title: keyAt(200), rationale: keyAt(2000), scope: keyAt(500) });

    const stored = storedPayloads(ws.orgId);
    expect(stored).toContain("task.completed");
    expect(stored).toContain("decision.recorded");
    expect(stored).toContain("agt_***");
    expect(stored).not.toMatch(FRAGMENT);
  });
});

describe("migration 12 (mask_approval_secrets)", () => {
  it("masks the action and details of existing approvals in place and leaves events alone", () => {
    const old = new Database(":memory:");
    try {
      runMigrations(old, MIGRATIONS.filter((m) => m.version < 12));
      old.exec(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Old Org', 'h')`);
      const insert = old.prepare(
        `INSERT INTO approvals (id, org_id, requested_by_agent_id, requested_by_agent_name, action, details, risk, status, expires_at)
         VALUES (?, 'o1', 'a1', 'Coder', ?, ?, 'high', 'noted', '2026-01-01T00:00:00.000Z')`,
      );
      insert.run("leaky", LEAKY, LEAKY_DETAILS);
      insert.run("clean", "rm -rf ./build", null);
      old.prepare(`INSERT INTO events (id, org_id, type, subject_type, subject_id, payload) VALUES ('e1', 'o1', 'approval.noted', 'approval', 'leaky', ?)`)
        .run(JSON.stringify({ action: LEAKY }));

      const upTo12 = MIGRATIONS.filter((m) => m.version <= 12);
      expect(runMigrations(old, upTo12).applied).toEqual([12]);
      expect(runMigrations(old, upTo12).applied).toEqual([]);
      const rows = old.prepare(`SELECT id, action, details FROM approvals ORDER BY id`).all();
      expect(rows).toEqual([
        { id: "clean", action: "rm -rf ./build", details: null },
        { id: "leaky", action: MASKED, details: MASKED_DETAILS },
      ]);
      expect((old.prepare(`SELECT payload FROM events WHERE id = 'e1'`).get() as { payload: string }).payload).toContain(AGENT_KEY);
    } finally {
      old.close();
    }
  });
});

describe("secrets in task text", () => {
  const TASK_TITLE = `rotate ${AGENT_KEY}`;
  const TASK_TITLE_MASKED = "rotate agt_***";

  it("create and complete store masked text, and every task read returns it masked", async () => {
    const ws = workspace("Mask Tasks Org");
    const created = await rest(ws.coder.key, "POST", "/v1/tasks", { title: TASK_TITLE, description: LEAKY });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({ title: TASK_TITLE_MASKED, description: MASKED });
    const id = created.body.task.id as string;
    expect((await rest(ws.coder.key, "POST", `/v1/tasks/${id}/claim`, {})).body.task.title).toBe(TASK_TITLE_MASKED);
    const done = await rest(ws.coder.key, "POST", `/v1/tasks/${id}/complete`, { summary: LEAKY_DETAILS });
    expect(done.body.task.completion_summary).toBe(MASKED_DETAILS);

    // Stored masked.
    expect(db.prepare(`SELECT title, description, completion_summary FROM tasks WHERE id = ?`).get(id))
      .toEqual({ title: TASK_TITLE_MASKED, description: MASKED, completion_summary: MASKED_DETAILS });
    expect(JSON.stringify(db.prepare(`SELECT payload FROM events WHERE org_id = ?`).all(ws.orgId))).not.toMatch(LEAK);

    // Served masked: REST list, MCP list_tasks, error text naming the task, the timeline.
    const list = (await rest(ws.operator.key, "GET", "/v1/tasks")).body.tasks;
    expect(list[0]).toMatchObject({ title: TASK_TITLE_MASKED, description: MASKED, completion_summary: MASKED_DETAILS });
    const mcpList = await mcpText(ws.operator.key, "list_tasks");
    expect(mcpList).toContain(TASK_TITLE_MASKED);
    const again = await rest(ws.operator.key, "POST", `/v1/tasks/${id}/claim`, {});
    expect(again.body.error).toContain(TASK_TITLE_MASKED);
    const timeline = await mcpText(ws.operator.key, "get_timeline", { after: 0 });
    for (const text of [JSON.stringify(list), mcpList, JSON.stringify(again.body), timeline]) expect(text).not.toMatch(LEAK);
  });

  it("an old unmasked task row is returned masked everywhere", async () => {
    const ws = workspace("Mask Old Task Org");
    const id = newId();
    db.prepare(
      `INSERT INTO tasks (id, org_id, title, description, status, created_by_agent_id, created_by_agent_name, claimed_by_agent_id, claimed_by_agent_name, lease_expires_at, completion_summary)
       VALUES (?, ?, ?, ?, 'claimed', ?, 'Coder', ?, 'Coder', ?, ?)`,
    ).run(id, ws.orgId, TASK_TITLE, LEAKY, ws.coder.id, ws.coder.id, new Date(Date.now() + 600_000).toISOString(), LEAKY_DETAILS);

    const list = (await rest(ws.operator.key, "GET", "/v1/tasks")).body.tasks;
    expect(list[0]).toMatchObject({ title: TASK_TITLE_MASKED, description: MASKED, completion_summary: MASKED_DETAILS });
    const mcpList = await mcpText(ws.operator.key, "list_tasks");
    const mcpClaim = await mcpText(ws.operator.key, "claim_task", { taskId: id });
    const done = await mcpText(ws.coder.key, "complete_task", { taskId: id });
    expect(mcpClaim).toContain(TASK_TITLE_MASKED);
    const timeline = await mcpText(ws.operator.key, "get_timeline", { after: 0 });
    for (const text of [JSON.stringify(list), mcpList, mcpClaim, done, timeline]) expect(text).not.toMatch(LEAK);
  });
});

describe("migration 13 (mask_task_secrets)", () => {
  it("masks existing task text and approval notes in place", () => {
    const old = new Database(":memory:");
    try {
      runMigrations(old, MIGRATIONS.filter((m) => m.version < 13));
      old.exec(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Old Org', 'h')`);
      const insertTask = old.prepare(
        `INSERT INTO tasks (id, org_id, title, description, completion_summary, created_by_agent_id, created_by_agent_name) VALUES (?, 'o1', ?, ?, ?, 'a1', 'Coder')`,
      );
      insertTask.run("leaky", `rotate ${AGENT_KEY}`, LEAKY, 'done, AUDIT_SESSION_TOKEN="fakefake');
      insertTask.run("clean", "write docs", null, null);
      old.prepare(
        `INSERT INTO approvals (id, org_id, requested_by_agent_id, requested_by_agent_name, action, risk, status, decision_note, expires_at)
         VALUES ('ap', 'o1', 'a1', 'Coder', 'deploy', 'high', 'denied', ?, '2026-01-01T00:00:00.000Z')`,
      ).run(`no: KEY=plainsecretvalue`);

      const upTo13 = MIGRATIONS.filter((m) => m.version <= 13);
      expect(runMigrations(old, upTo13).applied).toEqual([13]);
      expect(runMigrations(old, upTo13).applied).toEqual([]);
      expect(old.prepare(`SELECT id, title, description, completion_summary FROM tasks ORDER BY id`).all()).toEqual([
        { id: "clean", title: "write docs", description: null, completion_summary: null },
        { id: "leaky", title: "rotate agt_***", description: MASKED, completion_summary: 'done, AUDIT_SESSION_TOKEN="***' },
      ]);
      expect(old.prepare(`SELECT decision_note FROM approvals WHERE id = 'ap'`).get()).toEqual({ decision_note: "no: KEY=***" });
    } finally {
      old.close();
    }
  });
});

describe("migration 14 (mask_free_text_secrets)", () => {
  it("masks existing agent status, message bodies and shared file names in place", () => {
    const old = new Database(":memory:");
    try {
      runMigrations(old, MIGRATIONS.filter((m) => m.version < 14));
      old.exec(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Old Org', 'h')`);
      old.prepare(
        `INSERT INTO agents (id, org_id, name, url_key, api_key_hash, current_task) VALUES ('a1', 'o1', 'Coder', 'coder', 'h', ?)`,
      ).run(LEAKY);
      old.prepare(
        `INSERT INTO agents (id, org_id, name, url_key, api_key_hash) VALUES ('a2', 'o1', 'Idle', 'idle', 'h')`,
      ).run();
      old.prepare(
        `INSERT INTO messages (id, org_id, thread_id, from_agent_id, from_agent_name, to_agent_id, to_agent_name, body, kind)
         VALUES ('m1', 'o1', 't1', 'a1', 'Coder', 'a2', 'Idle', ?, 'message')`,
      ).run(LEAKY);
      old.prepare(
        `INSERT INTO files (id, org_id, uploaded_by_agent_id, uploaded_by_agent_name, filename, mime_type, size_bytes, content)
         VALUES ('f1', 'o1', 'a1', 'Coder', ?, 'text/markdown', 4, X'11223344')`,
      ).run(`notes-${AGENT_KEY}.md`);

      const upTo14 = MIGRATIONS.filter((m) => m.version <= 14);
      expect(runMigrations(old, upTo14).applied).toEqual([14]);
      expect(runMigrations(old, upTo14).applied).toEqual([]); // idempotent: a second run touches nothing
      expect(old.prepare(`SELECT id, current_task FROM agents ORDER BY id`).all()).toEqual([
        { id: "a1", current_task: MASKED },
        { id: "a2", current_task: null },
      ]);
      expect(old.prepare(`SELECT body FROM messages WHERE id = 'm1'`).get()).toEqual({ body: MASKED });
      expect(old.prepare(`SELECT filename, content FROM files WHERE id = 'f1'`).get())
        .toEqual({ filename: "notes-agt_***.md", content: Buffer.from([0x11, 0x22, 0x33, 0x44]) }); // content untouched
    } finally {
      old.close();
    }
  });
});

describe("secrets in agent status, messages and shared files (phase 3, docs/decisions #1789)", () => {
  it("set_status masks the task text on write and on every read, but never touches editing_files (collision detection stays exact)", async () => {
    const ws = workspace("Mask Status Org");
    const posted = await rest(ws.coder.key, "POST", "/v1/status", { task: LEAKY, files: ["src/secrets.ts"] });
    expect(posted.status).toBe(200);

    expect(db.prepare(`SELECT current_task, editing_files FROM agents WHERE id = ?`).get(ws.coder.id))
      .toEqual({ current_task: MASKED, editing_files: JSON.stringify(["src/secrets.ts"]) });

    const list = (await rest(ws.operator.key, "GET", "/v1/agents")).body.agents;
    const mine = list.find((a: { id: string }) => a.id === ws.coder.id);
    expect(mine.current_task).toBe(MASKED);
    expect(mine.editing_files_parsed).toEqual(["src/secrets.ts"]); // untouched: a real file path, not agent free text

    // A second agent editing the SAME real file is still a real, exact collision -- masking editing_files would
    // risk hiding this by comparing a masked list against the raw incoming one.
    const other = registerAgent(ws.orgId, "OtherCoder");
    const collided = await rest(other.apiKey, "POST", "/v1/status", { task: "also touching it", files: ["src/secrets.ts"] });
    expect(collided.body.collisions).toEqual([{ agentName: "Coder", files: ["src/secrets.ts"] }]);

    expect(JSON.stringify(db.prepare(`SELECT payload FROM events WHERE org_id = ? AND type = 'agent.task_changed'`).all(ws.orgId))).not.toMatch(LEAK);
  });

  it("send_message, ask_clarification and reply all mask the body on write; get_messages masks again on read", async () => {
    const ws = workspace("Mask Messages Org");
    const sent = await rest(ws.coder.key, "POST", "/v1/messages", { toAgent: "Operator", body: LEAKY });
    expect(sent.status).toBe(201);
    const threadId = sent.body.threadId as string;

    expect(db.prepare(`SELECT body FROM messages WHERE thread_id = ?`).all(threadId)).toEqual([{ body: MASKED }]);

    const inbox = (await rest(ws.operator.key, "GET", "/v1/messages")).body.messages;
    expect(inbox[0].body).toBe(MASKED);

    const question = await rest(ws.coder.key, "POST", "/v1/questions", { toAgent: "Operator", body: LEAKY, timeoutSeconds: 1 });
    expect(question.status).toBe(200);
    const replied = await rest(ws.operator.key, "POST", `/v1/messages/${question.body.threadId}/reply`, { body: LEAKY_DETAILS });
    expect(replied.status).toBe(200);
    expect(db.prepare(`SELECT body FROM messages WHERE thread_id = ? ORDER BY created_at`).all(question.body.threadId))
      .toEqual([{ body: MASKED }, { body: MASKED_DETAILS }]);

    const mcpSent = await mcpText(ws.coder.key, "send_message", { toAgent: "Operator", body: LEAKY });
    expect(mcpSent).not.toMatch(LEAK);
    const mcpInbox = await mcpText(ws.operator.key, "get_messages", {});
    expect(mcpInbox).toContain(MASKED);
    expect(mcpInbox).not.toMatch(LEAK);
  });

  it("an old unmasked message row is returned masked by get_messages", async () => {
    const ws = workspace("Mask Old Message Org");
    const id = newId();
    db.prepare(
      `INSERT INTO messages (id, org_id, thread_id, from_agent_id, from_agent_name, to_agent_id, to_agent_name, body, kind)
       VALUES (?, ?, 't1', ?, 'Coder', ?, 'Operator', ?, 'message')`,
    ).run(id, ws.orgId, ws.coder.id, ws.operator.id, LEAKY);
    const inbox = (await rest(ws.operator.key, "GET", "/v1/messages")).body.messages;
    expect(inbox[0].body).toBe(MASKED);
  });

  it("share_file and its REST counterpart mask the filename on write and on every read; file content is untouched", async () => {
    const ws = workspace("Mask Files Org");
    const contentBase64 = Buffer.from("real payload, not a secret").toString("base64");
    const shared = await rest(ws.coder.key, "POST", "/v1/files/share", {
      toAgent: "Operator", filename: `secrets-${AGENT_KEY}.md`, mimeType: "text/markdown", contentBase64, message: "see attached",
    });
    expect(shared.status).toBe(201);
    const fileId = shared.body.fileId as string;

    expect(db.prepare(`SELECT filename FROM files WHERE id = ?`).get(fileId)).toEqual({ filename: "secrets-agt_***.md" });
    const fetched = await rest(ws.operator.key, "GET", `/v1/files/${fileId}`);
    expect(fetched.body.filename).toBe("secrets-agt_***.md");
    expect(Buffer.from(fetched.body.contentBase64, "base64").toString()).toBe("real payload, not a secret"); // content untouched

    const mcpShared = await mcpText(ws.coder.key, "share_file", {
      toAgent: "Operator", filename: `notes-${AGENT_KEY}.md`, mimeType: "text/markdown", contentBase64, message: "see attached",
    });
    expect(mcpShared).toContain("notes-agt_***.md");
    expect(mcpShared).not.toMatch(LEAK);
    const idMatch = mcpShared.match(/File: (\S+),/);
    const mcpDownload = await mcpText(ws.operator.key, "download_file", { fileId: idMatch![1] });
    expect(mcpDownload).toContain("filename: notes-agt_***.md");
    expect(mcpDownload).not.toMatch(LEAK);
  });

  it("the operator escalation preview masks the stuck message, cutting after masking so a secret can never be shown half-visible", async () => {
    const ws = workspace("Mask Escalation Org");
    // A secret placed right at the escalation preview's cut point (120 chars): a plain .slice() would show
    // the unmasked front half of it. Insert the message directly (bypassing send's own masking) to simulate
    // an old unmasked row still sitting in the table when escalation reads it.
    // 80 x's + a space leaves 39 chars of AGENT_KEY (agt_ + 35 zeros) inside the 120-char cut point --
    // enough zeros for LEAK's `agt_0{10}` to fire on an unmasked slice, and still a straddling cut (13 zeros short of the full 48).
    const padding = "x".repeat(80);
    const straddling = `${padding} ${AGENT_KEY} more text after the cut point that must never be shown unmasked either`;
    const id = newId();
    // sweepEscalations only escalates messages STUCK with a non-operator recipient (it then notifies
    // operators about them) -- so the recipient here must be the coder, not the operator.
    db.prepare(
      `INSERT INTO messages (id, org_id, thread_id, from_agent_id, from_agent_name, to_agent_id, to_agent_name, body, kind, priority, awaiting_reply, created_at)
       VALUES (?, ?, 't1', ?, 'Operator', ?, 'Coder', ?, 'message', 'high', 0, datetime('now', '-15 minutes'))`,
    ).run(id, ws.orgId, ws.operator.id, ws.coder.id, straddling);
    const { sweepEscalations } = await import("../src/escalation.js");
    await sweepEscalations(new Date());
    const notice = (db.prepare(`SELECT body FROM messages WHERE org_id = ? AND from_agent_id = 'opencadre-system' ORDER BY created_at DESC LIMIT 1`).get(ws.orgId) as { body: string } | undefined)?.body ?? "";
    expect(notice).toContain("ESCALATION");
    expect(notice).not.toMatch(LEAK);
  });
});

describe("GET /v1/org/projects: one row per project", () => {
  const operator = { actor: null, name: "test", via: "operator" as const };
  const liveSession = (orgId: string, project: string) =>
    db.prepare(`INSERT INTO agents (id, org_id, name, url_key, api_key_hash, kind, project) VALUES (?, ?, ?, ?, ?, 'session', ?)`)
      .run(newId(), orgId, `s-${newId()}`, `s-${newId()}`, `session:${newId()}`, project);
  const keys = (orgId: string) => listProjects(orgId).map((p) => p.projectKey).sort();

  it("hides a legacy folder key with no live sessions when an enabled remote key has the same name", async () => {
    const ws = workspace("Projects Dup Org");
    setProjectEnabled(ws.orgId, operator, "OpenCadre", true);
    setProjectEnabled(ws.orgId, operator, "github.com/mabdullah4800-ai/opencadre", true);
    expect(keys(ws.orgId)).toEqual(["github.com/mabdullah4800-ai/opencadre"]);
    // The row stays: old clients still send that key, and it is still enabled for them.
    expect(db.prepare(`SELECT enabled FROM projects WHERE org_id = ? AND project_key = 'OpenCadre'`).get(ws.orgId)).toEqual({ enabled: 1 });
    const res = await rest(ws.operator.key, "GET", "/v1/org/projects");
    expect(res.body.projects.map((p: { projectKey: string }) => p.projectKey)).toEqual(["github.com/mabdullah4800-ai/opencadre"]);
  });

  it("keeps the legacy key when any condition doesn't hold", () => {
    // The remote key isn't enabled.
    const disabled = workspace("Projects Disabled Remote Org");
    setProjectEnabled(disabled.orgId, operator, "OpenCadre", true);
    setProjectEnabled(disabled.orgId, operator, "github.com/mabdullah4800-ai/opencadre", true);
    setProjectEnabled(disabled.orgId, operator, "github.com/mabdullah4800-ai/opencadre", false);
    expect(keys(disabled.orgId)).toEqual(["OpenCadre", "github.com/mabdullah4800-ai/opencadre"]);

    // The legacy key still has a live session.
    const live = workspace("Projects Live Legacy Org");
    setProjectEnabled(live.orgId, operator, "OpenCadre", true);
    setProjectEnabled(live.orgId, operator, "github.com/mabdullah4800-ai/opencadre", true);
    liveSession(live.orgId, "OpenCadre");
    expect(keys(live.orgId)).toEqual(["OpenCadre", "github.com/mabdullah4800-ai/opencadre"]);

    // Different names.
    const other = workspace("Projects Other Name Org");
    setProjectEnabled(other.orgId, operator, "OpenCadre", true);
    setProjectEnabled(other.orgId, operator, "github.com/mabdullah4800-ai/website", true);
    expect(keys(other.orgId)).toEqual(["OpenCadre", "github.com/mabdullah4800-ai/website"]);

    // A local:<folder> key is a project of its own, not a legacy key.
    const local = workspace("Projects Local Org");
    setProjectEnabled(local.orgId, operator, "local:OpenCadre", true);
    setProjectEnabled(local.orgId, operator, "github.com/mabdullah4800-ai/opencadre", true);
    expect(keys(local.orgId)).toEqual(["github.com/mabdullah4800-ai/opencadre", "local:OpenCadre"]);

    // The matching remote key is in another workspace.
    const a = workspace("Projects Org A");
    const b = workspace("Projects Org B");
    setProjectEnabled(a.orgId, operator, "OpenCadre", true);
    setProjectEnabled(b.orgId, operator, "github.com/mabdullah4800-ai/opencadre", true);
    expect(keys(a.orgId)).toEqual(["OpenCadre"]);
  });
});
