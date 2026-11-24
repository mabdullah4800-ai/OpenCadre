import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent, sendMessage, type MessageRecord } from "../src/service.js";
import { createSession, createWorkspace, upsertPerson } from "../src/accounts.js";
import { emitEvent } from "../src/events.js";
import { SYSTEM_SENDER, sweepEscalations } from "../src/escalation.js";
import { reportExecuted } from "../src/clearance-bypass.js";
import { approvalPushMessage } from "../src/push.js";
import { invalidateScopes } from "../src/scope.js";
import { classifySharedState, isUnclassifiedNamespace, MIGRATIONS, runMigrations, UNCLASSIFIED_NAMESPACE } from "../src/migrations.js";
import { createTask } from "../src/tasks.js";
import { PERSON_REQUIRED_REFUSAL } from "../src/approvals.js";
import { projectKeyOf } from "../src/projects.js";
import { assignPlan } from "../src/billing.js";
import { startFetchRecorder } from "./helpers/fetch-recorder.js";

/** Project isolation, enforcement (docs/design/PROJECT_ISOLATION.md §3.3, §3.4, §5, §7 item 3, §8). Modelled on
 * tests/cross-org-isolation.test.ts: every surface in §5, probed from five callers about a resource that belongs to an
 * agent (a1) in project Alpha:
 *   same       a2, a session in Alpha
 *   linked     g1, a session in Gamma, which is linked to Alpha
 *   unlinked   b1, a session in Beta
 *   workspace  Supervisor, a named agent with workspace scope
 *   person     the workspace's owner, signed in to the console
 * The whole matrix runs twice: with project_isolation on (the enforced expectations) and off (today's behaviour). */

// --- Servers -----------------------------------------------------------------------------------------------------------
let fixture: Awaited<ReturnType<typeof startFetchRecorder>> | undefined;
let base: string;

beforeAll(async () => {
  // Establish Fetch readiness before any isolation assertion. Only explicit bad-port rejection
  // rebinds (bounded by the shared helper); readiness traffic never reaches the MCP/REST dispatcher.
  fixture = await startFetchRecorder((req, res) => {
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
  base = fixture.url;
});
afterAll(async () => { await fixture?.close(); });

// --- Callers -----------------------------------------------------------------------------------------------------------
interface Project { key: string; name: string }
const ALPHA: Project = { key: "github.com/iso/alpha", name: "Alpha" };
const BETA: Project = { key: "github.com/iso/beta", name: "Beta" };
const GAMMA: Project = { key: "github.com/iso/gamma", name: "Gamma" };

type Caller =
  | { kind: "session"; id: string; name: string; credential: string; tool: string; project: Project }
  | { kind: "key"; id: string; name: string; key: string }
  | { kind: "person"; id: string; name: string; cookie: string; orgId: string };

let ipCounter = 0;
const nextIp = () => `10.93.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function headersOf(caller: Caller): Record<string, string> {
  if (caller.kind === "session") {
    return {
      authorization: `Bearer ${caller.credential}`, "x-opencadre-session": caller.tool, "x-opencadre-client": "claude-code",
      "x-opencadre-project": caller.project.key, "x-opencadre-project-name": caller.project.name,
    };
  }
  if (caller.kind === "key") return { authorization: `Bearer ${caller.key}` };
  return { cookie: caller.cookie, "x-opencadre-workspace": caller.orgId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(method: string, route: string, caller: Caller | null, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(caller ? headersOf(caller) : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-forwarded-for": nextIp(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function mcp<T>(caller: Caller, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "project-isolation-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: headersOf(caller) } }));
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}
const toolText = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0].text;

// --- A workspace with three projects ------------------------------------------------------------------------------------
const CALLERS = ["same", "linked", "unlinked", "workspace", "person"] as const;
type CallerName = (typeof CALLERS)[number];

interface World {
  orgId: string;
  operator: Caller & { kind: "key" };
  supervisor: Caller & { kind: "key" };
  person: Caller & { kind: "person" };
  a1: Caller & { kind: "session" };
  a2: Caller & { kind: "session" };
  g1: Caller & { kind: "session" };
  b1: Caller & { kind: "session" };
  callers: Record<CallerName, Caller>;
}

let worldCounter = 0;
async function world({ isolation = true }: { isolation?: boolean } = {}): Promise<World> {
  const n = ++worldCounter;
  const personRow = upsertPerson({ id: `iso-person-${n}`, email: null, emailVerified: false, name: "Pat Owner", avatarUrl: null } as Parameters<typeof upsertPerson>[0]);
  process.env.OPENCADRE_SIGNUP = "open";
  const orgId = (() => {
    try {
      return createWorkspace(personRow, `Isolation Matrix ${n}`).orgId;
    } finally {
      delete process.env.OPENCADRE_SIGNUP;
    }
  })();
  // internal: this suite drives the REAL sign-up path (createWorkspace), so it cannot choose its plan at
  // creation -- and it then enables several projects, so a trial org would be refused part-way by a limit
  // the suite is not testing (9d1f ruling). Promoted here, after creation, rather than by giving
  // createWorkspace a test-only parameter: that is product code and a fixture-shaped argument there would
  // be the wrong place for it.
  assignPlan(orgId, "internal");
  const personAgent = db.prepare(`SELECT a.id, a.name FROM workspace_members m JOIN agents a ON a.id = m.agent_id WHERE m.org_id = ?`).get(orgId) as { id: string; name: string };
  const person = { kind: "person" as const, id: personAgent.id, name: personAgent.name, cookie: `oc_session=${createSession(personRow.id).token}`, orgId };
  const op = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const operator = { kind: "key" as const, id: op.agentId, name: op.agentName, key: op.apiKey };
  const sup = registerAgent(orgId, "Supervisor");
  const supervisor = { kind: "key" as const, id: sup.agentId, name: sup.agentName, key: sup.apiKey };
  for (const p of [ALPHA, BETA, GAMMA]) {
    expect((await call("PUT", "/v1/org/projects", operator, { projectKey: p.key, name: p.name, enabled: true })).status).toBe(200);
  }
  // One computer per session, so no two sessions share a rate-limit bucket.
  const session = async (tool: string, project: Project) => {
    const minted = await call("POST", "/v1/org/devices", operator, { name: `PC ${tool}`, client: "claude-code" });
    const redeemed = await call("POST", "/v1/connect/redeem", null, { code: minted.body.code });
    expect(redeemed.status).toBe(201);
    const s = { kind: "session" as const, id: "", name: "", credential: redeemed.body.deviceCredential as string, tool: `${tool}-${n}`, project };
    const joined = await call("POST", "/v1/sessions/join", s);
    expect(joined.status).toBe(201);
    return { ...s, id: joined.body.agentId as string, name: joined.body.agentName as string };
  };
  const a1 = await session("a1", ALPHA);
  const a2 = await session("a2", ALPHA);
  const g1 = await session("g1", GAMMA);
  const b1 = await session("b1", BETA);
  expect((await call("POST", "/v1/org/project-links", operator, { projectA: ALPHA.key, projectB: GAMMA.key })).status).toBe(201);
  if (!isolation) expect((await call("PUT", "/v1/org/project-isolation", operator, { enabled: false })).body).toEqual({ enabled: false, changed: true, disconnectedConnections: 0 });
  return { orgId, operator, supervisor, person, a1, a2, g1, b1, callers: { same: a2, linked: g1, unlinked: b1, workspace: supervisor, person } };
}

/** Runs fn with isolation off, e.g. to set up a thread that couldn't be started with it on. */
async function isolationOffWhile<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const before = (db.prepare(`SELECT project_isolation FROM organizations WHERE id = ?`).get(orgId) as { project_isolation: number }).project_isolation;
  db.prepare(`UPDATE organizations SET project_isolation = 0 WHERE id = ?`).run(orgId);
  invalidateScopes();
  try {
    return await fn();
  } finally {
    db.prepare(`UPDATE organizations SET project_isolation = ? WHERE id = ?`).run(before, orgId);
    invalidateScopes();
  }
}

const lastSeq = (orgId: string) => (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE org_id = ?`).get(orgId) as { s: number }).s;
const asAgent = (c: Caller) => ({ id: c.id, name: c.name });

/** Denied is a specific status, never just "anything but success". */
function allowedOr(status: number, ok: number, denied: number): boolean {
  if (status === ok) return true;
  expect(status, `expected ${ok} (allowed) or ${denied} (denied)`).toBe(denied);
  return false;
}

async function a1Task(w: World, claim = false): Promise<string> {
  const created = await call("POST", "/v1/tasks", w.a1, { title: `alpha task ${++worldCounter}` });
  expect(created.status).toBe(201);
  if (claim) expect((await call("POST", `/v1/tasks/${created.body.task.id}/claim`, w.a1, {})).status).toBe(200);
  return created.body.task.id;
}

/** A fresh task, claimed and completed by a1, ready for a distinct agent to accept/reject. */
async function a1DoneTask(w: World): Promise<string> {
  const id = await a1Task(w, true);
  expect((await call("POST", `/v1/tasks/${id}/complete`, w.a1, { summary: "done" })).status).toBe(200);
  return id;
}

async function a1Approval(w: World, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call("POST", "/v1/approvals", w.a1, { action: `deploy alpha ${++worldCounter}`, waitSeconds: 0, ...extra });
  expect(created.status).toBe(201);
  return created.body.approval.id;
}

// --- The matrix ----------------------------------------------------------------------------------------------------------
type Row = [boolean, boolean, boolean, boolean, boolean];
interface Surface {
  /** The REST routes (and MCP tools) this surface covers. */
  routes: string[];
  tools?: string[];
  /** Allowed per caller with isolation on, in CALLERS order. With it off, `off` (default: everyone). */
  on: Row;
  off?: Row;
  probe: (w: World, caller: Caller) => Promise<boolean>;
}

const EVERYONE: Row = [true, true, true, true, true];

const SURFACES: Record<string, Surface> = {
  "roster lists a1 (GET /v1/agents)": {
    routes: ["GET /v1/agents"], on: [true, true, false, true, true],
    probe: async (w, c) => {
      const res = await call("GET", "/v1/agents", c);
      expect(res.status).toBe(200);
      return res.body.agents.some((a: { id: string }) => a.id === w.a1.id);
    },
  },
  "get_active_agents lists a1 (MCP)": {
    routes: [], tools: ["get_active_agents"], on: [true, true, false, true, true],
    probe: async (w, c) => (c.kind === "person" ? true : mcp(c, async (client) => (await toolText(client, "get_active_agents")).includes(w.a1.name))),
  },
  "send_message to a1": {
    routes: ["POST /v1/messages"], tools: ["send_message"], on: [true, true, false, true, true],
    probe: async (w, c) => allowedOr((await call("POST", "/v1/messages", c, { toAgent: w.a1.name, body: "hello alpha" })).status, 201, 404),
  },
  "ask_clarification of a1": {
    routes: ["POST /v1/questions"], tools: ["ask_clarification"], on: [true, true, false, true, true],
    probe: async (w, c) => allowedOr((await call("POST", "/v1/questions", c, { toAgent: w.a1.id, body: "alpha?", timeoutSeconds: 1 })).status, 200, 404),
  },
  "share_file with a1": {
    routes: ["POST /v1/files/share"], tools: ["share_file"], on: [true, true, false, true, true],
    probe: async (w, c) => {
      const before = (db.prepare(`SELECT COUNT(*) AS n FROM files WHERE org_id = ?`).get(w.orgId) as { n: number }).n;
      const res = await call("POST", "/v1/files/share", c, {
        toAgent: w.a1.name, filename: "notes.md", mimeType: "text/markdown", contentBase64: Buffer.from("# notes").toString("base64"), message: "a file",
      });
      // The share route answers any failed share 400, an unknown recipient included, so an unreachable one reads the same.
      const allowed = allowedOr(res.status, 201, 400);
      // A refused share stores no file.
      if (!allowed) expect((db.prepare(`SELECT COUNT(*) AS n FROM files WHERE org_id = ?`).get(w.orgId) as { n: number }).n).toBe(before);
      return allowed;
    },
  },
  "reply on a thread a1 started": {
    routes: ["POST /v1/messages/:threadId/reply"], tools: ["reply"], on: [true, true, false, true, true],
    probe: async (w, c) => {
      const sent = await isolationOffWhile(w.orgId, () => sendMessage(w.orgId, asAgent(w.a1), c.id, "from alpha"));
      if (!sent.ok) throw new Error(sent.error);
      return allowedOr((await call("POST", `/v1/messages/${sent.threadId}/reply`, c, { body: "back to alpha" })).status, 200, 403);
    },
  },
  "broadcast channel org": {
    routes: [], tools: ["broadcast_message"], on: [false, false, false, true, true],
    probe: async (_w, c) => allowedOr((await call("POST", "/v1/messages", c, { channel: "org", body: "all hands" })).status, 201, 403),
  },
  "request_approval naming a1 as approver": {
    routes: ["POST /v1/approvals"], tools: ["request_approval"], on: [true, false, false, false, false],
    // A caller that can reach a1 (linked, workspace, person) is told a1 can't decide in its project (403); the unlinked
    // caller gets the answer an unknown approver gets (400), so a1's existence isn't confirmed.
    probe: async (w, c) => allowedOr((await call("POST", "/v1/approvals", c, { action: "deploy", approver: w.a1.name, waitSeconds: 0 })).status, 201, c.id === w.b1.id ? 400 : 403),
  },
  "clearance report naming a1 as approver": {
    routes: ["POST /v1/clearances/executed"], on: [true, true, false, true, true],
    probe: async (w, c) => allowedOr((await call("POST", "/v1/clearances/executed", c, { action: `rm -rf build ${++worldCounter}`, required: "record", approver: w.a1.name })).status, 200, 400),
  },
  "timeline shows a1's task (GET /v1/events)": {
    routes: ["GET /v1/events"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const after = lastSeq(w.orgId);
      await a1Task(w);
      const res = await call("GET", `/v1/events?after=${after}&types=task.created`, c);
      expect(res.status).toBe(200);
      return res.body.events.length === 1;
    },
  },
  "get_timeline shows a1's task (MCP)": {
    routes: [], tools: ["get_timeline"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      if (c.kind === "person") return true;
      const after = lastSeq(w.orgId);
      await a1Task(w);
      const seq = lastSeq(w.orgId);
      return mcp(c, async (client) => (await toolText(client, "get_timeline", { after, types: ["task.created"] })).includes(`#${seq} `));
    },
  },
  "events wait returns a1's task (GET /v1/events/wait)": {
    routes: ["GET /v1/events/wait"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const after = lastSeq(w.orgId);
      await a1Task(w);
      const res = await call("GET", `/v1/events/wait?after=${after}&types=task.created&timeoutSeconds=1`, c);
      expect(res.status).toBe(200);
      return res.body.events.length === 1;
    },
  },
  "wait_for_timeline returns a1's task (MCP)": {
    routes: [], tools: ["wait_for_timeline"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      if (c.kind === "person") return true;
      const after = lastSeq(w.orgId);
      await a1Task(w);
      const seq = lastSeq(w.orgId);
      return mcp(c, async (client) => (await toolText(client, "wait_for_timeline", { after, types: ["task.created"], timeoutSeconds: 1 })).includes(`#${seq} `));
    },
  },
  "awareness digest counts a1's decision": {
    routes: ["GET /v1/awareness"], tools: ["get_awareness"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const decided = await call("POST", "/v1/decisions", w.a1, { title: "alpha decision" });
      expect(decided.status).toBe(201);
      const res = await call("GET", `/v1/awareness?since=${decided.body.event.seq - 1}`, c);
      expect(res.status).toBe(200);
      return Boolean(res.body.background["decision.recorded"]) || res.body.items.some((i: { seq: number }) => i.seq === decided.body.event.seq);
    },
  },
  "deliveries: a1's message to the caller (reach)": {
    routes: ["GET /v1/deliveries"], tools: ["pull_events"], on: [true, true, false, true, true],
    probe: async (w, c) => {
      const sent = await isolationOffWhile(w.orgId, () => sendMessage(w.orgId, asAgent(w.a1), c.id, "mail from alpha"));
      if (!sent.ok) throw new Error(sent.error);
      const seq = lastSeq(w.orgId);
      const res = await call("GET", "/v1/deliveries", c);
      expect(res.status).toBe(200);
      return res.body.events.some((e: { seq: number }) => e.seq === seq);
    },
  },
  "deliveries: an Alpha task event directed at the caller (visible)": {
    routes: [], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const taskId = await a1Task(w);
      const event = emitEvent({ orgId: w.orgId, type: "task.lease_expired", subjectType: "task", subjectId: taskId, targetAgentId: c.id, payload: { title: "alpha" } });
      expect(event.project_key).toBe(ALPHA.key);
      const res = await call("GET", "/v1/deliveries", c);
      return res.body.events.some((e: { seq: number }) => e.seq === event.seq);
    },
  },
  "task board lists a1's task": {
    routes: ["GET /v1/tasks"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const taskId = await a1Task(w);
      return (await call("GET", "/v1/tasks", c)).body.tasks.some((t: { id: string }) => t.id === taskId);
    },
  },
  "list_tasks lists a1's task (MCP)": {
    routes: [], tools: ["list_tasks"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      if (c.kind === "person") return true;
      const taskId = await a1Task(w);
      return mcp(c, async (client) => (await toolText(client, "list_tasks", { limit: 200 })).includes(taskId));
    },
  },
  "get a1's task by id": {
    routes: ["GET /v1/tasks/:taskId"], tools: ["get_task"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const taskId = await a1Task(w);
      if (c.kind === "person") return allowedOr((await call("GET", `/v1/tasks/${taskId}`, c)).status, 200, 404);
      return mcp(c, async (client) => {
        const t = await toolText(client, "get_task", { taskId });
        if (!t.startsWith("Error:")) return true;
        expect(t, "expected success or a not-found error").toContain("No task found");
        return false;
      });
    },
  },
  "claim a1's task": {
    routes: ["POST /v1/tasks/:taskId/claim"], tools: ["claim_task"], on: [true, false, false, true, true],
    probe: async (w, c) => allowedOr((await call("POST", `/v1/tasks/${await a1Task(w)}/claim`, c, {})).status, 200, 404),
  },
  // The work board (fleet coordination slice D). Only the creator, the claimant or an admin may move a task, so a caller
  // that can see it is refused 403 (an owner person, an admin, may); one that can't see it gets 404, as if absent.
  "move a1's task to another lane reaches it (403 not permitted, 200 for an admin; 404 when not visible)": {
    routes: ["POST /v1/tasks/:taskId/lane"], tools: ["set_task_lane"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const res = await call("POST", `/v1/tasks/${await a1Task(w)}/lane`, c, { lane: "held", reason: "waiting for operator" });
      if (res.status === 404) return false;
      expect([200, 403], `status ${res.status}`).toContain(res.status);
      if (c.kind === "person") expect(res.status).toBe(200);
      return true;
    },
  },
  "renew a1's claim (409 when visible, 404 when not)": {
    routes: ["POST /v1/tasks/:taskId/renew"], tools: ["renew_claim"], on: [true, false, false, true, true],
    probe: async (w, c) => allowedOr((await call("POST", `/v1/tasks/${await a1Task(w, true)}/renew`, c, {})).status, 409, 404),
  },
  "release a1's claim (409 when visible, 404 when not)": {
    routes: ["POST /v1/tasks/:taskId/release"], tools: ["release_task"], on: [true, false, false, true, true],
    probe: async (w, c) => allowedOr((await call("POST", `/v1/tasks/${await a1Task(w, true)}/release`, c, {})).status, 409, 404),
  },
  "complete a1's claim (409 when visible, 404 when not)": {
    routes: ["POST /v1/tasks/:taskId/complete"], tools: ["complete_task"], on: [true, false, false, true, true],
    probe: async (w, c) => allowedOr((await call("POST", `/v1/tasks/${await a1Task(w, true)}/complete`, c, {})).status, 409, 404),
  },
  "accept a1's done task (200 when visible, 404 when not; none of these callers is a1, so self-review never fires)": {
    routes: ["POST /v1/tasks/:taskId/accept"], tools: ["accept_task"], on: [true, false, false, true, true],
    probe: async (w, c) => allowedOr((await call("POST", `/v1/tasks/${await a1DoneTask(w)}/accept`, c, {})).status, 200, 404),
  },
  "reject a1's done task (200 when visible, 404 when not)": {
    routes: ["POST /v1/tasks/:taskId/reject"], tools: ["reject_task"], on: [true, false, false, true, true],
    probe: async (w, c) => allowedOr((await call("POST", `/v1/tasks/${await a1DoneTask(w)}/reject`, c, { note: "x" })).status, 200, 404),
  },
  // 201, not 200, and 400, not 404 — both are the route's own shape, read from src/rest.ts rather
  // than copied from the siblings above. It is a CREATE plus a link, so it answers what
  // `POST /v1/tasks` answers; and an unreachable (including cross-project) target reaches
  // supersedeTask, whose org-scoped `getTask` returns nothing, so it throws the TaskInputError the
  // route maps to 400 — the same deliberate choice as every other TaskInputError, and NOT a 409
  // because nothing conflicts about state. The refusal is nonetheless a DENIAL: asserted below by
  // the row surviving with no superseded_by link, so "400" is never read as "it worked".
  "supersede a1's task (201 when visible, 400 when not)": {
    routes: ["POST /v1/tasks/:taskId/supersede"], tools: ["supersede_task"], on: [true, false, false, true, true],
    probe: async (w, c) => allowedOr((await call("POST", `/v1/tasks/${await a1Task(w)}/supersede`, c, { title: "correction" })).status, 201, 400),
  },
  "approvals list shows a1's request": {
    routes: ["GET /v1/approvals"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const id = await a1Approval(w);
      return (await call("GET", "/v1/approvals", c)).body.approvals.some((a: { id: string }) => a.id === id);
    },
  },
  "list_approvals shows a1's request (MCP)": {
    routes: [], tools: ["list_approvals"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      if (c.kind === "person") return true;
      const id = await a1Approval(w);
      return mcp(c, async (client) => (await toolText(client, "list_approvals", { limit: 200 })).includes(id));
    },
  },
  "get a1's approval": {
    routes: ["GET /v1/approvals/:approvalId"], on: [true, false, false, true, true],
    probe: async (w, c) => allowedOr((await call("GET", `/v1/approvals/${await a1Approval(w)}`, c)).status, 200, 404),
  },
  "wait on a1's approval": {
    routes: ["GET /v1/approvals/:approvalId/wait"], on: [true, false, false, true, true],
    probe: async (w, c) => allowedOr((await call("GET", `/v1/approvals/${await a1Approval(w, { notifyOnly: true })}/wait?timeoutSeconds=1`, c)).status, 200, 404),
  },
  "wait_for_approval on a1's approval (MCP)": {
    routes: [], tools: ["wait_for_approval"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      if (c.kind === "person") return true;
      const id = await a1Approval(w, { notifyOnly: true });
      return mcp(c, async (client) => !(await toolText(client, "wait_for_approval", { approvalId: id, waitSeconds: 1 })).startsWith("Error"));
    },
  },
  // A clearance is decided by a PERSON only (migration 53), so the old single row ("decide a1's approval", allowed for
  // same/workspace/person) is now two: whether a caller REACHES the request (project isolation: 404 when it can't see it;
  // an agent that can see it is refused 403 "a person has to decide"), and whether it can DECIDE it (the person only).
  "decide a1's approval reaches it (an agent that sees it: 403 person required; one that doesn't: 404)": {
    routes: ["POST /v1/approvals/:approvalId/decide"], tools: ["decide_approval"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const res = await call("POST", `/v1/approvals/${await a1Approval(w)}/decide`, c, { decision: "approve" });
      if (res.status === 403) {
        expect(c.kind).not.toBe("person");
        expect(res.body.error).toBe(PERSON_REQUIRED_REFUSAL);
        return true;
      }
      return allowedOr(res.status, 200, 404);
    },
  },
  "decide a1's approval (a person only, whatever the isolation setting)": {
    routes: ["POST /v1/approvals/:approvalId/decide"], on: [false, false, false, false, true], off: [false, false, false, false, true],
    probe: async (w, c) => (await call("POST", `/v1/approvals/${await a1Approval(w)}/decide`, c, { decision: "approve" })).status === 200,
  },
  // Only the agent that asked may withdraw (none of these callers is a1), so this row is about REACH, like decide's first
  // row: a caller that can see the request is refused 403 not_requester; one that can't gets 404, as if it did not exist.
  "withdraw a1's approval reaches it (one that sees it: 403 not the requester; one that doesn't: 404)": {
    routes: ["POST /v1/approvals/:approvalId/withdraw"], tools: ["withdraw_approval"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const res = await call("POST", `/v1/approvals/${await a1Approval(w)}/withdraw`, c, {});
      if (res.status === 403) {
        expect(res.body.code).toBe("not_requester");
        return true;
      }
      expect(res.status).toBe(404);
      return false;
    },
  },
  "grants list shows a1's grant": {
    routes: ["GET /v1/approval-grants"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      const grantId = await a1Grant(w);
      return (await call("GET", "/v1/approval-grants", c)).body.grants.some((g: { id: string }) => g.id === grantId);
    },
  },
  "list_approval_grants shows a1's grant (MCP)": {
    routes: [], tools: ["list_approval_grants"], on: [true, false, false, true, true],
    probe: async (w, c) => {
      if (c.kind === "person") return true;
      const grantId = await a1Grant(w);
      return mcp(c, async (client) => (await toolText(client, "list_approval_grants")).includes(grantId));
    },
  },
  "revoke a1's grant": {
    routes: ["DELETE /v1/approval-grants/:grantId"], tools: ["revoke_approval_grant"], on: [true, false, false, true, true],
    probe: async (w, c) => allowedOr((await call("DELETE", `/v1/approval-grants/${await a1Grant(w)}`, c)).status, 200, 404),
  },
  "download a file a1 shared with Supervisor (PR 1: parties and operators; operators need visible)": {
    routes: ["GET /v1/files/:fileId"], tools: ["download_file"], on: [false, false, false, true, true], off: [false, false, false, true, true],
    probe: async (w, c) => {
      const shared = await call("POST", "/v1/files/share", w.a1, {
        toAgent: w.supervisor.name, filename: "alpha.md", mimeType: "text/markdown", contentBase64: Buffer.from("# alpha").toString("base64"), message: "file",
      });
      expect(shared.status).toBe(201);
      return allowedOr((await call("GET", `/v1/files/${shared.body.fileId}`, c)).status, 200, 404);
    },
  },
  // The WIP cap (fleet coordination slice C). Reading one is scoped like any project data: outside the caller's visible
  // projects Alpha doesn't exist for it. Setting one is admin-only, so of these callers only the owner person can.
  "read Alpha's project settings (WIP cap)": {
    routes: ["GET /v1/org/projects/:key/settings"], on: [true, false, false, true, true],
    probe: async (_w, c) => allowedOr((await call("GET", `/v1/org/projects/${encodeURIComponent(ALPHA.key)}/settings`, c)).status, 200, 404),
  },
  "set Alpha's WIP cap (an admin only, whatever the isolation setting)": {
    routes: ["PUT /v1/org/projects/:key/settings"], tools: ["set_wip_cap"], on: [false, false, false, false, true], off: [false, false, false, false, true],
    probe: async (_w, c) => allowedOr((await call("PUT", `/v1/org/projects/${encodeURIComponent(ALPHA.key)}/settings`, c, { wipCap: 3 })).status, 200, 403),
  },
  "clearance policy read for ?project=alpha gets Alpha's mode": {
    routes: ["GET /v1/clearance-policy"], on: [true, false, false, true, true],
    probe: async (_w, c) => {
      const res = await call("GET", `/v1/clearance-policy?project=${encodeURIComponent(ALPHA.key)}`, c);
      expect(res.status).toBe(200);
      return res.body.policy.mode === "strict";
    },
  },
  "first-run checklist (whole-workspace names)": {
    routes: ["GET /v1/onboarding"], on: [false, false, false, true, true],
    probe: async (_w, c) => allowedOr((await call("GET", "/v1/onboarding", c)).status, 200, 403),
  },
};

async function a1Grant(w: World): Promise<string> {
  const id = await a1Approval(w, { category: `deploy-${++worldCounter}` });
  // A person creates the grant (migration 53): the operator's agent key would be refused.
  const decided = await call("POST", `/v1/approvals/${id}/decide`, w.person, { decision: "approve", grantMinutes: 30 });
  expect(decided.status).toBe(200);
  return decided.body.grant.id;
}

for (const isolation of [true, false]) {
  describe(`isolation matrix, project_isolation ${isolation ? "on" : "off"}`, () => {
    let w: World;
    beforeAll(async () => {
      w = await world({ isolation });
      // Alpha is strict, Beta notify, Gamma has no setting (falls back to the workspace default, off).
      for (const [project, mode] of [[ALPHA.key, "strict"], [BETA.key, "notify"]]) {
        // A signed-in owner sets policy (#653: an Operator key can only read it).
        expect((await call("PUT", "/v1/clearance-policy", w.person, { project, mode })).status).toBe(200);
      }
    }, 60_000);

    for (const [name, surface] of Object.entries(SURFACES)) {
      it(name, async () => {
        const expected = isolation ? surface.on : surface.off ?? EVERYONE;
        const actual: Record<string, boolean> = {};
        for (const caller of CALLERS) actual[caller] = await surface.probe(w, w.callers[caller]);
        expect(actual).toEqual(Object.fromEntries(CALLERS.map((c, i) => [c, expected[i]])));
      }, 30_000);
    }
  });
}

// --- Completeness: every route and every MCP tool is classified -----------------------------------------------------------
type RouterLayer = { route?: { path: string; methods: Record<string, boolean> } };
const ROUTES = ((app as unknown as { router: { stack: RouterLayer[] } }).router.stack)
  .flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`) : []));

/** Routes checked by a focused test below instead of a matrix row. */
const FOCUSED: Record<string, string> = {
  "GET /v1/org/project-links": "links: list",
  "POST /v1/org/project-links": "links: link",
  "DELETE /v1/org/project-links": "links: unlink removes reach at once and closes replies",
  "GET /v1/org/project-isolation": "the setting: read",
  "PUT /v1/org/project-isolation": "the setting: pre-flight refusal, toggle restores behaviour",
  "GET /v1/goal": "shared state: each project reads its own goal plus the workspace goal",
  "POST /v1/goal": "shared state: a project agent sets its own project's goal",
  "POST /v1/memory": "shared state: memory is written into the writer's project",
  "GET /v1/memory": "shared state: memory lists only the reader's projects plus shared",
  "GET /v1/memory/search": "shared state: memory search sees only the reader's projects plus shared",
  "GET /v1/memory/:id": "shared state: another project's memory entry reads as not found",
  "POST /v1/memory/:id/archive": "shared state: another project's entry can't be archived; a shared one only by a workspace-wide actor",
  "POST /v1/memory/:id/supersede": "shared state: same rule as archive",
  "POST /v1/resources/claim": "shared state: locks are per project, so a key can't be probed or taken over across projects",
  "POST /v1/resources/renew": "shared state: locks are per project",
  "POST /v1/resources/release": "shared state: locks are per project",
  "GET /v1/resources": "shared state: the list shows only the reader's projects plus shared",
  "POST /v1/facts": "shared state: a project agent sets its own project's facts",
  "GET /v1/facts": "shared state: facts list only the reader's projects plus shared",
  "GET /v1/facts/one": "shared state: another project's fact reads as absent",
  "POST /v1/facts/delete": "shared state: only the deleter's own project's fact",
  "GET /v1/reliability": "shared state: an unreachable agent reads like an id with no history",
  "GET /v1/reliability/all": "shared state: only reachable agents are listed",
  "GET /v1/task-shape-stats": "shared state: only the reader's own projects' tasks count",
};

/** Routes project isolation doesn't apply to, with the reason. */
const EXEMPT: Record<string, string> = {
  "POST /v1/clearances/policy-pass": "records an event about the caller itself (actor and subject are the caller, stamped with its own project); names no other agent and reads nothing",
  "POST /v1/orgs": "platform admin creates a workspace",
  "POST /v1/agents": "bootstrap key creates a workspace-wide named agent",
  "POST /v1/org/agents": "operator (workspace-wide) manages agents",
  "POST /v1/org/agents/:agentId/rotate-key": "operator (workspace-wide) manages agents",
  "DELETE /v1/org/agents/:agentId": "operator (workspace-wide) manages agents",
  "GET /v1/org/agents/:agentId/webhook": "operator (workspace-wide) manages agents",
  "PUT /v1/org/agents/:agentId/webhook": "operator (workspace-wide) manages agents",
  "POST /v1/org/agents/:agentId/webhook/test": "operator (workspace-wide) manages agents",
  "POST /v1/org/pause": "operator: the kill switch stops every project",
  "POST /v1/org/resume": "operator: the kill switch stops every project",
  "POST /v1/connect-codes": "operator onboarding",
  "GET /v1/connect-codes/:code/status": "operator onboarding",
  "POST /v1/connect/redeem": "single-use code; no project data",
  "POST /v1/org/devices": "operator manages computers, which span projects",
  "GET /v1/org/devices": "operator manages computers, which span projects",
  "DELETE /v1/org/devices/:deviceId": "operator manages computers, which span projects",
  "POST /v1/sessions/join": "the session's own identity",
  "POST /v1/sessions/leave": "the session's own identity",
  "GET /v1/devices/me": "the computer's own record",
  "POST /v1/devices/tools": "the computer's own record",
  "POST /v1/devices/connector-build": "optional computer inventory from its own bearer only; no session or project headers are read (tests/connector-build-api.test.ts)",
  "GET /v1/devices/projects": "the workspace's enabled project keys, for the computer's local allowlist; names no folder",
  "PUT /v1/devices/projects/enable-current": "enables the computer's current project; opt-in projects, not isolation",
  "GET /v1/org/projects": "operator manages projects",
  "PUT /v1/org/projects": "operator manages projects",
  "GET /v1/org/sessions": "operator (workspace-wide) console listing",
  "GET /v1/org/usage": "operator (workspace-wide) usage report, spans every project the org runs",
  "PATCH /v1/org/sessions/:agentId": "operator (workspace-wide) console action",
  "POST /v1/org/sessions/:agentId/keep-name": "operator (workspace-wide) console action",
  "GET /v1/clearance-policies": "operator (workspace-wide) sets clearance modes",
  "PUT /v1/clearance-policy": "a signed-in owner/admin person (workspace-wide) sets clearance modes",
  "DELETE /v1/clearance-policy": "a signed-in owner/admin person (workspace-wide) sets clearance modes",
  "POST /v1/heartbeat": "acts only on the caller",
  "POST /v1/webhook": "acts only on the caller",
  "POST /v1/status": "acts only on the caller; conflict detection compares within one project (tests/project-isolation-leaks.test.ts)",
  "POST /v1/capabilities": "acts only on the caller",
  "GET /v1/capabilities": "reads only the caller's own capabilities",
  "POST /v1/round-budget": "acts only on the caller",
  "GET /v1/round-budget": "reads only the caller's own round budget",
  "POST /v1/usage": "acts only on the caller",
  "GET /v1/me": "reads only the caller",
  "GET /v1/messages": "the caller's own inbox: mail was checked when it was sent",
  "GET /v1/messages/search": "the caller's own sent and received mail, across projects like the inbox",
  "GET /v1/messages/wait": "the caller's own inbox: mail was checked when it was sent",
  "POST /v1/messages/consume": "the caller's own inbox",
  "GET /v1/messages/:threadId/status": "thread parties only (tests/delivery-status.test.ts)",
  "POST /v1/events/:seq/ack": "acts only on the caller's own delivery rows",
  "POST /v1/decisions": "writes, stamped with the caller's home project",
  "POST /v1/tasks": "writes, stamped with the caller's home project (tests/project-stamping.test.ts)",
  "GET /v1/workspaces/:orgId/members": "people administration (owners and admins)",
  "POST /v1/workspaces/:orgId/invites": "people administration (owners and admins)",
  "DELETE /v1/workspaces/:orgId/invites/:inviteId": "people administration (owners and admins)",
  "PATCH /v1/workspaces/:orgId/members/:personId": "people administration (owners and admins)",
  "DELETE /v1/workspaces/:orgId/members/:personId": "people administration (owners and admins)",
  "GET /cli/opencadre-cli.tgz": "public",
  "GET /cli/manifest.json": "public",
  "GET /cli/:stamp/opencadre-cli.tgz": "public",
  "GET /": "public redirect to the console",
  "GET /health": "public",
  "GET /v1/billing/client-config": "says whether this hub offers a checkout (always no here); no workspace",
  "GET /favicon.ico": "public",
  "GET /v1/metrics": "metrics token; hub-wide counts",
  "GET /v1/auth/config": "sign-in; no workspace",
  "GET /.well-known/oauth-protected-resource/mcp": "public OAuth metadata; no workspace",
  "GET /.well-known/oauth-protected-resource": "public OAuth metadata; no workspace",
  "GET /.well-known/oauth-authorization-server": "public OAuth metadata; no workspace",
  "GET /oauth/authorize": "the signed-in person's consent page; people are workspace scope, and the project picker lists only enabled projects",
  "POST /oauth/authorize": "creates a connector agent scoped to the ONE enabled project the person picks when the workspace keeps projects apart (tests/oauth-grants.test.ts)",
  "POST /oauth/token": "exchanges a code or refresh token for the connector agent it was issued to; the agent's scope was fixed at consent",
  "POST /oauth/revoke": "revokes only the presented token's family; reads no project data",
  "POST /oauth/register": "public OAuth client registration; the client belongs to no workspace or project",
  "GET /v1/auth/start": "sign-in; no workspace",
  "POST /v1/auth/email": "sign-in; no workspace",
  "GET /v1/auth/callback": "sign-in; no workspace",
  "POST /v1/auth/signout": "sign-in; no workspace",
  "GET /v1/auth/me": "the person's own memberships",
  "POST /v1/workspaces": "creates a workspace",
  "GET /v1/invites/:token": "the invite token names its workspace",
  "POST /v1/invites/:token/accept": "the invite token names its workspace",
  "GET /v1/push/config": "public",
  "GET /v1/push/devices": "the person's own devices",
  "POST /v1/push/devices": "the person's own devices",
  "DELETE /v1/push/devices": "the person's own devices",
  "POST /v1/push/test": "the person's own devices",
};

/** MCP tools project isolation doesn't apply to (each is the same call as an exempt route above). */
const EXEMPT_TOOLS: Record<string, string> = {
  get_messages: "the caller's own inbox",
  search_messages: "the caller's own sent and received mail, across projects like the inbox",
  wait_for_message: "the caller's own inbox",
  consume_messages: "the caller's own inbox",
  get_message_status: "thread parties only",
  set_status: "acts only on the caller",
  ack_event: "the caller's own delivery rows",
  record_decision: "writes, stamped with the caller's home project",
  create_task: "writes, stamped with the caller's home project",
  save_task: "writes, stamped with the caller's home project; its side-request link is refused for a task the caller can't see (src/tasks.ts createTask)",
  register_webhook: "acts only on the caller",
  remember: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  recall: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  search_memory: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  get_memory: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  archive_memory: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  supersede_memory: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  set_goal: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  get_goal: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  set_capabilities: "acts only on the caller",
  get_capabilities: "reads only the caller's own capabilities",
  set_round_budget: "acts only on the caller",
  get_round_budget: "reads only the caller's own round budget",
  claim_resource: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  renew_resource_lock: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  release_resource: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  list_resource_locks: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  set_fact: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  get_fact: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  list_facts: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  delete_fact: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  get_agent_reliability: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  list_agent_reliability: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
  get_task_shape_stats: "namespaced shared state, not the matrix: covered by the focused 'shared state kept apart' tests (src/scope.ts namespacesOf)",
};

describe("completeness: every route and MCP tool is classified", () => {
  const matrixRoutes = new Set(Object.values(SURFACES).flatMap((s) => s.routes));
  const matrixTools = new Set(Object.values(SURFACES).flatMap((s) => s.tools ?? []));

  it("no route is silently unclassified", () => {
    expect(ROUTES.length).toBeGreaterThan(50);
    const missing = ROUTES.filter((r) => !matrixRoutes.has(r) && !FOCUSED[r] && !EXEMPT[r]);
    expect(missing, `add a matrix surface, a focused test or an EXEMPT reason for: ${missing.join(", ")}`).toEqual([]);
    const unknown = [...matrixRoutes, ...Object.keys(FOCUSED), ...Object.keys(EXEMPT)].filter((r) => !ROUTES.includes(r));
    expect(unknown).toEqual([]);
    expect([...matrixRoutes].filter((r) => EXEMPT[r] || FOCUSED[r])).toEqual([]);
  });

  it("no MCP tool is silently unclassified", async () => {
    const w = await world();
    const tools = await mcp(w.a1, async (client) => (await client.listTools()).tools.map((t) => t.name));
    expect(tools.length).toBeGreaterThan(25);
    const missing = tools.filter((t) => !matrixTools.has(t) && !EXEMPT_TOOLS[t]);
    expect(missing, `add a matrix surface or an EXEMPT_TOOLS reason for: ${missing.join(", ")}`).toEqual([]);
    expect([...matrixTools, ...Object.keys(EXEMPT_TOOLS)].filter((t) => !tools.includes(t))).toEqual([]);
  }, 60_000);
});

// --- Focused tests ------------------------------------------------------------------------------------------------------
describe("waiters (review #173)", () => {
  it("a project waiter isn't returned by another project's event and still gets its own; a workspace waiter wakes for every project", async () => {
    const w = await world();
    const after = lastSeq(w.orgId);
    const started = Date.now();
    const alphaWait = call("GET", `/v1/events/wait?after=${after}&types=task.created&timeoutSeconds=10`, w.a2);
    const supervisorWait = call("GET", `/v1/events/wait?after=${after}&types=task.created&timeoutSeconds=10`, w.supervisor);
    let alphaDone = false;
    void alphaWait.then(() => (alphaDone = true));
    await new Promise((r) => setTimeout(r, 200));

    // Beta's task wakes every waiter; the Alpha waiter sees nothing it may read and goes back to waiting.
    const betaTask = await call("POST", "/v1/tasks", w.b1, { title: "beta work" });
    const supervisorSaw = await supervisorWait;
    expect(supervisorSaw.body.events.map((e: { subject_id: string }) => e.subject_id)).toEqual([betaTask.body.task.id]);
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise((r) => setTimeout(r, 300));
    expect(alphaDone).toBe(false);

    // Alpha's own task then ends its wait, long before the timeout: the waiter wasn't starved.
    const alphaTask = await call("POST", "/v1/tasks", w.a1, { title: "alpha work" });
    const alphaSaw = await alphaWait;
    expect(alphaSaw.body.events.map((e: { subject_id: string }) => e.subject_id)).toEqual([alphaTask.body.task.id]);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);
});

describe("links (§3.4)", () => {
  it("a message from a linked project is delivered through deliveries and awareness, and stamped with both ends", async () => {
    const w = await world();
    const sent = await call("POST", "/v1/messages", w.g1, { toAgent: w.a1.name, body: "from gamma", priority: "high" });
    expect(sent.status).toBe(201);
    const row = db.prepare(`SELECT id, project_key, to_project_key FROM messages WHERE thread_id = ?`).get(sent.body.threadId) as { id: string; project_key: string; to_project_key: string };
    expect(row).toMatchObject({ project_key: GAMMA.key, to_project_key: ALPHA.key });
    const event = db.prepare(`SELECT seq, project_key FROM events WHERE subject_id = ?`).get(row.id) as { seq: number; project_key: string };
    expect(event.project_key).toBe(GAMMA.key);

    const pulled = await call("GET", "/v1/deliveries", w.a1);
    expect(pulled.body.events.map((e: { seq: number }) => e.seq)).toContain(event.seq);
    const awareness = await call("GET", `/v1/awareness?since=${event.seq - 1}`, w.a1);
    expect(awareness.body.items.map((i: { seq: number }) => i.seq)).toContain(event.seq);
    // The recipient's own timeline shows mail addressed to it; nobody else in Alpha sees Gamma's traffic.
    expect((await call("GET", `/v1/events?after=${event.seq - 1}`, w.a1)).body.events.map((e: { seq: number }) => e.seq)).toContain(event.seq);
    expect((await call("GET", `/v1/events?after=${event.seq - 1}`, w.a2)).body.events.map((e: { seq: number }) => e.seq)).not.toContain(event.seq);
  }, 30_000);

  it("unlinking removes reach at once: the roster, new messages, replies and deliveries between the projects all stop", async () => {
    const w = await world();
    const sent = await call("POST", "/v1/messages", w.a1, { toAgent: w.g1.name, body: "before unlink" });
    expect(sent.status).toBe(201);
    expect((await call("POST", `/v1/messages/${sent.body.threadId}/reply`, w.g1, { body: "still linked" })).status).toBe(200);
    const eventSeq = lastSeq(w.orgId);

    const unlinked = await call("DELETE", "/v1/org/project-links", w.operator, { projectA: GAMMA.key, projectB: ALPHA.key });
    expect(unlinked).toMatchObject({ status: 200, body: { ok: true } });

    const reply = await call("POST", `/v1/messages/${sent.body.threadId}/reply`, w.g1, { body: "after unlink" });
    expect(reply).toMatchObject({ status: 403, body: { ok: false, code: "NOT_REACHABLE" } });
    expect(reply.body.error).toBe(`${w.a1.name} is in project Alpha, which isn't linked to Gamma. An admin can link the projects in Settings → Projects.`);
    expect((await call("POST", "/v1/messages", w.a1, { toAgent: w.g1.name, body: "after unlink" })).status).toBe(404);
    expect((await call("GET", "/v1/agents", w.a1)).body.agents.map((a: { id: string }) => a.id)).not.toContain(w.g1.id);
    expect((await call("GET", "/v1/deliveries", w.a1)).body.events.map((e: { seq: number }) => e.seq)).not.toContain(eventSeq);

    // Linking again restores it, in either order of the pair.
    const relinked = await call("POST", "/v1/org/project-links", w.operator, { projectA: GAMMA.key, projectB: ALPHA.key });
    expect(relinked).toMatchObject({ status: 201, body: { created: true, link: { projectA: ALPHA.key, projectB: GAMMA.key, nameA: "Alpha", nameB: "Gamma", createdBy: "Operator" } } });
    expect((await call("POST", `/v1/messages/${sent.body.threadId}/reply`, w.g1, { body: "linked again" })).status).toBe(200);
  }, 30_000);

  it("links are operator-only, validated, idempotent, per workspace, and on the timeline", async () => {
    const w = await world();
    expect((await call("GET", "/v1/org/project-links", w.a1)).status).toBe(403);
    expect((await call("POST", "/v1/org/project-links", w.supervisor, { projectA: ALPHA.key, projectB: BETA.key })).status).toBe(403);
    expect((await call("POST", "/v1/org/project-links", w.operator, { projectA: ALPHA.key, projectB: ALPHA.key })).status).toBe(400);
    expect((await call("POST", "/v1/org/project-links", w.operator, { projectA: ALPHA.key, projectB: "not a key/x y" })).status).toBe(400);
    expect((await call("POST", "/v1/org/project-links", w.operator, { projectA: ALPHA.key, projectB: "github.com/iso/nowhere" })).status).toBe(404);
    expect((await call("POST", "/v1/org/project-links", w.operator, { projectA: ALPHA.key, projectB: GAMMA.key })).body).toMatchObject({ created: false });
    expect((await call("DELETE", "/v1/org/project-links", w.operator, { projectA: ALPHA.key, projectB: BETA.key })).status).toBe(404);
    // The person (an owner) manages links too.
    expect((await call("POST", "/v1/org/project-links", w.person, { projectA: BETA.key, projectB: ALPHA.key })).status).toBe(201);
    const listed = await call("GET", "/v1/org/project-links", w.operator);
    expect(listed.body.links.map((l: { projectA: string; projectB: string }) => `${l.projectA} ${l.projectB}`)).toEqual([`${ALPHA.key} ${BETA.key}`, `${ALPHA.key} ${GAMMA.key}`]);

    // Another workspace's operator sees none of them and can't touch them: the keys aren't projects there.
    const other = createOrganization("Isolation Links Other", "internal");
    const otherOp = registerAgent(other.orgId, "Operator", { role: "operator", system: true });
    const otherCaller = { kind: "key" as const, id: otherOp.agentId, name: "Operator", key: otherOp.apiKey };
    expect((await call("GET", "/v1/org/project-links", otherCaller)).body).toEqual({ links: [] });
    expect((await call("DELETE", "/v1/org/project-links", otherCaller, { projectA: ALPHA.key, projectB: GAMMA.key })).status).toBe(404);

    const types = (db.prepare(`SELECT type, project_key, payload FROM events WHERE org_id = ? AND type LIKE 'project.%link%' ORDER BY seq`).all(w.orgId) as Array<{ type: string; project_key: string | null; payload: string }>);
    expect(types.map((t) => [t.type, t.project_key])).toEqual([["project.linked", null], ["project.linked", null]]);
    expect(JSON.parse(types[1].payload)).toEqual({ projectA: ALPHA.key, projectB: BETA.key, nameA: "Alpha", nameB: "Beta" });
  }, 30_000);
});

describe("the project_isolation setting (§7 item 3)", () => {
  it("existing workspaces keep it off after the migration; a new workspace starts with it on", () => {
    const legacy = new Database(":memory:");
    runMigrations(legacy, MIGRATIONS.filter((m) => m.version < 17));
    legacy.exec(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Old', 'h')`);
    runMigrations(legacy);
    expect(legacy.prepare(`SELECT project_isolation FROM organizations WHERE id = 'o1'`).get()).toEqual({ project_isolation: 0 });
    expect(legacy.prepare(`SELECT name FROM sqlite_master WHERE name = 'project_links'`).get()).toEqual({ name: "project_links" });
    // internal: uncapped, so this suite is not stopped by a plan limit it is not testing (9d1f ruling).
    const fresh = createOrganization("Isolation Fresh", "internal");
    expect(db.prepare(`SELECT project_isolation FROM organizations WHERE id = ?`).get(fresh.orgId)).toEqual({ project_isolation: 1 });
  });

  it("switching it off restores today's behaviour in one step, and on again enforces again; each switch is an event", async () => {
    const w = await world();
    const send = () => call("POST", "/v1/messages", w.b1, { toAgent: w.a1.name, body: "beta to alpha" });
    expect((await send()).status).toBe(404);
    expect((await call("GET", "/v1/org/project-isolation", w.operator)).body).toEqual({ enabled: true });
    expect((await call("PUT", "/v1/org/project-isolation", w.a1, { enabled: false })).status).toBe(403);
    expect((await call("PUT", "/v1/org/project-isolation", w.operator, { enabled: "no" })).status).toBe(400);

    expect((await call("PUT", "/v1/org/project-isolation", w.operator, { enabled: false })).body).toEqual({ enabled: false, changed: true, disconnectedConnections: 0 });
    expect((await send()).status).toBe(201);
    expect((await call("GET", "/v1/agents", w.b1)).body.agents.map((a: { id: string }) => a.id)).toContain(w.a1.id);
    expect((await call("POST", "/v1/messages", w.a2, { channel: "org", body: "everyone" })).status).toBe(201);

    expect((await call("PUT", "/v1/org/project-isolation", w.operator, { enabled: true })).body).toEqual({ enabled: true, changed: true, disconnectedConnections: 0 });
    expect((await send()).status).toBe(404);
    expect((await call("PUT", "/v1/org/project-isolation", w.operator, { enabled: true })).body).toEqual({ enabled: true, changed: false, disconnectedConnections: 0 });
    const events = db.prepare(`SELECT type, actor_agent_name, project_key FROM events WHERE org_id = ? AND type LIKE 'workspace.isolation_%' ORDER BY seq`).all(w.orgId);
    expect(events).toEqual([
      { type: "workspace.isolation_disabled", actor_agent_name: "Operator", project_key: null },
      { type: "workspace.isolation_enabled", actor_agent_name: "Operator", project_key: null },
    ]);
  }, 30_000);

  it("the pre-flight refuses to switch it on while a repository is split across project keys, with the report", async () => {
    const w = await world({ isolation: false });
    const DELTA_LOCAL: Project = { key: "local:Delta", name: "Delta" };
    const DELTA_REMOTE: Project = { key: "github.com/iso/delta", name: "Delta" };
    for (const p of [DELTA_LOCAL, DELTA_REMOTE]) expect((await call("PUT", "/v1/org/projects", w.operator, { projectKey: p.key, name: p.name, enabled: true })).status).toBe(200);
    // Which session sits in which key: the name is one word now (sessions PR1), so it can't say which project it's in.
    const nameIn = new Map<string, string>();
    for (const [tool, p] of [["split-local", DELTA_LOCAL], ["split-remote", DELTA_REMOTE]] as const) {
      const minted = await call("POST", "/v1/org/devices", w.operator, { name: tool, client: "claude-code" });
      const redeemed = await call("POST", "/v1/connect/redeem", null, { code: minted.body.code });
      const joined = await call("POST", "/v1/sessions/join", { kind: "session", id: "", name: "", credential: redeemed.body.deviceCredential, tool, project: p });
      expect(joined.status).toBe(201);
      nameIn.set(p.key, joined.body.agentName);
    }
    const refused = await call("PUT", "/v1/org/project-isolation", w.operator, { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("more than one project key");
    expect(refused.body.report.orgId).toBe(w.orgId);
    expect(refused.body.report.splits).toEqual([{
      name: "delta",
      keys: [
        { projectKey: "github.com/iso/delta", liveAgents: [nameIn.get(DELTA_REMOTE.key)] },
        { projectKey: "local:Delta", liveAgents: [nameIn.get(DELTA_LOCAL.key)] },
      ],
    }]);
    expect((await call("GET", "/v1/org/project-isolation", w.operator)).body).toEqual({ enabled: false });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND type = 'workspace.isolation_enabled'`).get(w.orgId)).toEqual({ n: 0 });
  }, 30_000);
});

describe("refusals name what happened (§5, §5.1)", () => {
  // An agent in one project must not be able to confirm another project's agent names by guessing (session names carry
  // their project): an unreachable target reads exactly like an unknown name, status and body. Operators, who can link
  // projects, are still told why.
  it("to a non-operator, an unreachable agent is indistinguishable from an unknown one", async () => {
    const w = await world();
    const unknown = await call("POST", "/v1/messages", w.b1, { toAgent: "Nobody-Here", body: "hi" });
    const toSession = await call("POST", "/v1/messages", w.b1, { toAgent: w.a1.name, body: "hi" });
    expect(unknown).toMatchObject({ status: 404, body: { ok: false, error: 'No agent found matching "Nobody-Here"' } });
    expect(toSession.status).toBe(unknown.status);
    expect(toSession.body).toEqual({ ok: false, error: `No agent found matching "${w.a1.name}"` });

    const hermit = registerAgent(w.orgId, "Hermit");
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(BETA.key, hermit.agentId);
    invalidateScopes();
    const toNamed = await call("POST", "/v1/questions", w.a1, { toAgent: "Hermit", body: "there?", timeoutSeconds: 1 });
    const toNobody = await call("POST", "/v1/questions", w.a1, { toAgent: "Nobody-Here", body: "there?", timeoutSeconds: 1 });
    expect(toNamed.status).toBe(toNobody.status);
    expect(JSON.stringify(toNamed.body).replace("Hermit", "X")).toBe(JSON.stringify(toNobody.body).replace("Nobody-Here", "X"));
    const viaMcp = await mcp(w.a1, (client) => toolText(client, "send_message", { toAgent: "Hermit", body: "hi" }));
    const viaMcpNobody = await mcp(w.a1, (client) => toolText(client, "send_message", { toAgent: "Nobody-Here", body: "hi" }));
    expect(viaMcp.replace("Hermit", "X")).toBe(viaMcpNobody.replace("Nobody-Here", "X"));
  }, 30_000);

  it("an operator agent in a project is told why: the target's project, and that an admin can link them", async () => {
    const w = await world();
    const op = registerAgent(w.orgId, "Beta-Operator", { role: "operator", system: true });
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(BETA.key, op.agentId);
    invalidateScopes();
    const caller = { kind: "key" as const, id: op.agentId, name: op.agentName, key: op.apiKey };
    const refused = await call("POST", "/v1/messages", caller, { toAgent: w.a1.name, body: "hi" });
    expect(refused).toMatchObject({ status: 403, body: { ok: false, code: "NOT_REACHABLE" } });
    expect(refused.body.error).toBe(`${w.a1.name} is in project Alpha, which isn't linked to Beta. An admin can link the projects in Settings → Projects.`);
  }, 30_000);
});

describe("shared state kept apart: goal, facts, locks, memory, stats (src/scope.ts namespacesOf)", () => {
  // Before migration 44 these were workspace-wide, so an agent in Beta read Alpha's goal, facts and memory. Each test
  // pairs the refused read with the permitted one, so a filter that hid everything would fail too.
  it("goal: each project has its own; the workspace goal is shared; a link doesn't widen it", async () => {
    const w = await world();
    expect((await call("POST", "/v1/goal", w.a1, { text: "ship alpha" })).status).toBe(201);
    expect((await call("GET", "/v1/goal", w.a2)).body.goal).toMatchObject({ text: "ship alpha", scope_key: ALPHA.key });
    expect((await call("GET", "/v1/goal", w.b1)).body).toEqual({ goal: null });
    expect((await call("GET", "/v1/goal", w.g1)).body).toEqual({ goal: null });

    expect((await call("POST", "/v1/goal", w.supervisor, { text: "launch" })).status).toBe(201);
    expect((await call("GET", "/v1/goal", w.b1)).body).toMatchObject({ goal: { text: "launch", scope_key: "" } });
    const alpha = (await call("GET", "/v1/goal", w.a1)).body;
    expect(alpha).toMatchObject({ goal: { text: "ship alpha" }, workspaceGoal: { text: "launch" } });
    const viaMcp = await mcp(w.b1, (client) => toolText(client, "get_goal", {}));
    expect(viaMcp).toContain("launch");
    expect(viaMcp).not.toContain("ship alpha");
  }, 30_000);

  it("facts: a project reads its own and the shared ones, and sets or deletes only its own", async () => {
    const w = await world();
    expect((await call("POST", "/v1/facts", w.a1, { key: "deploy", value: "alpha-v1" })).status).toBe(200);
    expect((await call("GET", "/v1/facts/one?key=deploy", w.a2)).body.fact).toMatchObject({ value: "alpha-v1" });
    expect((await call("GET", "/v1/facts/one?key=deploy", w.b1)).status).toBe(404);
    expect((await call("GET", "/v1/facts", w.b1)).body.facts).toEqual([]);

    // The same key in Beta is Beta's own, and deleting it touches only Beta's.
    expect((await call("POST", "/v1/facts", w.b1, { key: "deploy", value: "beta-v9" })).status).toBe(200);
    expect((await call("GET", "/v1/facts/one?key=deploy", w.b1)).body.fact).toMatchObject({ value: "beta-v9" });
    expect((await call("POST", "/v1/facts/delete", w.b1, { key: "deploy" })).status).toBe(200);
    expect((await call("GET", "/v1/facts/one?key=deploy", w.a1)).body.fact).toMatchObject({ value: "alpha-v1" });

    // A shared fact reaches every project, and a project agent can't delete it.
    expect((await call("POST", "/v1/facts", w.supervisor, { key: "region", value: "eu" })).status).toBe(200);
    expect((await call("GET", "/v1/facts/one?key=region", w.b1)).body.fact).toMatchObject({ value: "eu", scope_key: "" });
    expect((await call("POST", "/v1/facts/delete", w.b1, { key: "region" })).status).toBe(404);
    expect((await call("GET", "/v1/facts/one?key=region", w.a1)).status).toBe(200);
  }, 30_000);

  it("locks: a key is per project, so another project can neither see nor probe it", async () => {
    const w = await world();
    expect((await call("POST", "/v1/resources/claim", w.a1, { resourceKey: "src/app.ts", note: "alpha refactor" })).status).toBe(200);
    expect((await call("POST", "/v1/resources/claim", w.a2, { resourceKey: "src/app.ts" })).status).toBe(409);
    const beta = await call("POST", "/v1/resources/claim", w.b1, { resourceKey: "src/app.ts" });
    expect(beta.status).toBe(200);
    expect(JSON.stringify(beta.body)).not.toContain(w.a1.name);
    expect((await call("GET", "/v1/resources", w.b1)).body.locks.map((l: { holder_agent_name: string }) => l.holder_agent_name)).toEqual([w.b1.name]);
    expect((await call("POST", "/v1/resources/release", w.b1, { resourceKey: "src/app.ts" })).status).toBe(200);
    expect((await call("POST", "/v1/resources/claim", w.a2, { resourceKey: "src/app.ts" })).status).toBe(409);
  }, 30_000);

  it("memory: another project's entries can't be listed, searched, read or archived", async () => {
    const w = await world();
    const made = await call("POST", "/v1/memory", w.a1, { title: "alpha gotcha", body: "the build needs node 22" });
    expect(made.status).toBe(201);
    const id = made.body.entry.id;
    expect((await call("GET", "/v1/memory", w.a2)).body.entries.map((e: { id: string }) => e.id)).toContain(id);
    expect((await call("GET", "/v1/memory", w.b1)).body.entries).toEqual([]);
    expect((await call("GET", "/v1/memory/search?q=node", w.b1)).body.entries).toEqual([]);
    expect((await call("GET", `/v1/memory/${id}`, w.b1)).status).toBe(404);
    expect((await call("POST", `/v1/memory/${id}/archive`, w.b1, { reason: "mine now" })).status).toBe(404);
    expect((await call("GET", `/v1/memory/${id}`, w.a1)).body.entry).toMatchObject({ status: "active" });
  }, 30_000);

  it("reliability and task-shape stats: an unreachable agent and another project's tasks aren't counted", async () => {
    const w = await world();
    emitEvent({ orgId: w.orgId, type: "task.accepted", subjectType: "task", subjectId: "t-alpha", targetAgentId: w.a1.id, payload: {} });
    expect((await call("GET", "/v1/reliability/all", w.a2)).body.reliability.map((r: { agent_id: string }) => r.agent_id)).toContain(w.a1.id);
    expect((await call("GET", "/v1/reliability/all", w.b1)).body.reliability).toEqual([]);
    expect((await call("GET", `/v1/reliability?agentId=${w.a1.id}`, w.b1)).body.reliability)
      .toEqual({ agent_id: w.a1.id, agent_name: w.a1.id, accepted: 0, rejected: 0, total: 0, accept_rate: null });

    const task = createTask(w.orgId, { id: w.a1.id, name: w.a1.name }, { title: "alpha task", requiredCapabilities: ["shell"] });
    db.prepare(`UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ?`).run(task.id);
    const count = async (c: Caller) => ((await call("GET", "/v1/task-shape-stats", c)).body.shapes as Array<{ completedCount: number }>).reduce((n, s) => n + s.completedCount, 0);
    expect(await count(w.a2)).toBe(1);
    expect(await count(w.b1)).toBe(0);
  }, 30_000);

  it("isolation off shows every namespace again, and on hides them again, without moving anything", async () => {
    const w = await world();
    await call("POST", "/v1/facts", w.a1, { key: "deploy", value: "alpha-v1" });
    expect((await call("GET", "/v1/facts/one?key=deploy", w.b1)).status).toBe(404);
    await call("PUT", "/v1/org/project-isolation", w.operator, { enabled: false });
    expect((await call("GET", "/v1/facts/one?key=deploy", w.b1)).body.fact).toMatchObject({ value: "alpha-v1" });
    await call("PUT", "/v1/org/project-isolation", w.operator, { enabled: true });
    expect((await call("GET", "/v1/facts/one?key=deploy", w.b1)).status).toBe(404);
  }, 30_000);

  it("existing shared rows are classified by their writer: a project agent's move home, a workspace writer's stay shared, an unknown writer's leave every project's sight", async () => {
    const w = await world();
    const legacy = (table: string, cols: string, values: unknown[]) =>
      db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${values.map(() => "?").join(", ")})`).run(...values);
    legacy("goals_ns", "org_id, scope_key, text, set_by_agent_id, set_by_agent_name, set_at, updated_at", [w.orgId, "", "the old alpha goal", w.a1.id, w.a1.name, "2026-01-01", "2026-01-01"]);
    legacy("blackboard_facts_ns", "org_id, scope_key, key, value, set_by_agent_id, set_by_agent_name", [w.orgId, "", "by-supervisor", "shared", w.supervisor.id, w.supervisor.name]);
    legacy("blackboard_facts_ns", "org_id, scope_key, key, value, set_by_agent_id, set_by_agent_name", [w.orgId, "", "by-ghost", "orphan", "ghost-agent", "Ghost"]);
    classifySharedState(db, w.orgId);
    expect((await call("GET", "/v1/goal", w.b1)).body).toEqual({ goal: null });
    expect((await call("GET", "/v1/goal", w.a2)).body.goal).toMatchObject({ text: "the old alpha goal", scope_key: ALPHA.key });
    expect((await call("GET", "/v1/facts/one?key=by-supervisor", w.b1)).body.fact).toMatchObject({ scope_key: "" });
    expect((await call("GET", "/v1/facts/one?key=by-ghost", w.b1)).status).toBe(404);
    expect((await call("GET", "/v1/facts/one?key=by-ghost", w.a1)).status).toBe(404);
    expect((await call("GET", "/v1/facts/one?key=by-ghost", w.supervisor)).body.fact.scope_key).toSatisfy(isUnclassifiedNamespace);
  }, 30_000);
});

describe("follow-ups to the shared-state fix (#618 known limits)", () => {
  // Naming an approver is naming an agent: an unreachable one must read exactly like an unknown one, or the approver
  // field becomes the enumeration oracle the message routes no longer are.
  it("an approver in an unlinked project reads like an unknown approver, on both approval routes", async () => {
    const w = await world();
    const ask = (approver: string) => call("POST", "/v1/approvals", w.b1, { action: "deploy", approver, waitSeconds: 0 });
    const [unknown, unreachable] = [await ask("Nobody-Here"), await ask(w.a1.name)];
    expect(unreachable.status).toBe(unknown.status);
    expect(JSON.stringify(unreachable.body).replace(w.a1.name, "X")).toBe(JSON.stringify(unknown.body).replace("Nobody-Here", "X"));

    const report = (approver: string) => call("POST", "/v1/clearances/executed", w.b1, { action: "rm -rf build", required: "approval", approver });
    const [unknownR, unreachableR] = [await report("Nobody-Here"), await report(w.a1.name)];
    expect(unreachableR.status).toBe(unknownR.status);
    expect(JSON.stringify(unreachableR.body).replace(w.a1.name, "X")).toBe(JSON.stringify(unknownR.body).replace("Nobody-Here", "X"));
  }, 30_000);

  it("an operator agent naming an unreachable approver is still told why", async () => {
    const w = await world();
    const op = registerAgent(w.orgId, "Beta-Operator-2", { role: "operator", system: true });
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(BETA.key, op.agentId);
    invalidateScopes();
    const caller = { kind: "key" as const, id: op.agentId, name: op.agentName, key: op.apiKey };
    const refused = await call("POST", "/v1/approvals", caller, { action: "deploy", approver: w.a1.name, waitSeconds: 0 });
    expect(refused).toMatchObject({ status: 403, body: { code: "NOT_REACHABLE" } });
    expect(refused.body.error).toContain("isn't linked to Beta");
  }, 30_000);

  it("a project agent can't archive or supersede a shared memory entry; a workspace-wide agent can", async () => {
    const w = await world();
    const shared = await call("POST", "/v1/memory", w.supervisor, { title: "house rule", body: "never force-push main" });
    expect(shared.status).toBe(201);
    const id = shared.body.entry.id;
    expect((await call("GET", `/v1/memory/${id}`, w.b1)).body.entry).toMatchObject({ scope_key: "" });
    expect((await call("POST", `/v1/memory/${id}/archive`, w.b1, { reason: "disagree" })).status).not.toBe(200);
    expect((await call("POST", `/v1/memory/${id}/supersede`, w.b1, { title: "x", body: "y" })).status).not.toBe(200);
    expect((await call("GET", `/v1/memory/${id}`, w.b1)).body.entry).toMatchObject({ status: "active" });
    expect((await call("POST", `/v1/memory/${id}/archive`, w.supervisor, { reason: "retired" })).status).toBe(200);
  }, 30_000);
});

describe("#618 review findings (Codex-OpenCadre-8160)", () => {
  it("a multi-project agent's shared row with a stale home outside its chosen projects is parked, not handed to the stale home", async () => {
    const w = await world();
    const multi = registerAgent(w.orgId, "Multi");
    db.prepare(`UPDATE agents SET scope = 'projects', home_project = ? WHERE id = ?`).run(ALPHA.key, multi.agentId);
    db.prepare(`INSERT INTO agent_projects (agent_id, project_key) VALUES (?, ?)`).run(multi.agentId, BETA.key);
    invalidateScopes();
    db.prepare(`INSERT INTO blackboard_facts_ns (org_id, scope_key, key, value, set_by_agent_id, set_by_agent_name) VALUES (?, '', 'multi-fact', 'beta work', ?, 'Multi')`)
      .run(w.orgId, multi.agentId);
    classifySharedState(db, w.orgId);
    // Not in Alpha (the stale home the agent no longer belongs to), and not claimed for Beta either: it is ambiguous.
    expect((await call("GET", "/v1/facts/one?key=multi-fact", w.a1)).status).toBe(404);
    expect((await call("GET", "/v1/facts/one?key=multi-fact", w.b1)).status).toBe(404);
    expect((await call("GET", "/v1/facts/one?key=multi-fact", w.supervisor)).body.fact.scope_key).toSatisfy(isUnclassifiedNamespace);
  }, 30_000);

  it("a second orphan with a key already parked is parked too, never left shared (isolation off, then on again)", async () => {
    const w = await world();
    const orphan = (value: string) =>
      db.prepare(`INSERT INTO blackboard_facts_ns (org_id, scope_key, key, value, set_by_agent_id, set_by_agent_name) VALUES (?, '', 'K', ?, 'ghost-agent', 'Ghost')`).run(w.orgId, value);
    orphan("first");
    classifySharedState(db, w.orgId);
    // Isolation off: a new shared K appears (its writer later gone), then isolation on classifies again.
    await call("PUT", "/v1/org/project-isolation", w.operator, { enabled: false });
    orphan("second");
    await call("PUT", "/v1/org/project-isolation", w.operator, { enabled: true });
    const shared = db.prepare(`SELECT COUNT(*) AS n FROM blackboard_facts_ns WHERE org_id = ? AND key = 'K' AND scope_key = ''`).get(w.orgId) as { n: number };
    expect(shared.n).toBe(0);
    for (const c of [w.a1, w.b1, w.g1]) expect((await call("GET", "/v1/facts/one?key=K", c)).status).toBe(404);
    const parked = (await call("GET", "/v1/facts", w.supervisor)).body.facts.filter((f: { key: string }) => f.key === "K");
    expect(parked.map((f: { value: string }) => f.value).sort()).toEqual(["first", "second"]);
    expect(parked.every((f: { scope_key: string }) => isUnclassifiedNamespace(f.scope_key))).toBe(true);
  }, 30_000);

  it("a legacy project literally named 'unclassified' can't read the orphaned rows", async () => {
    const w = await world();
    expect(projectKeyOf("unclassified")).toBe("unclassified");
    expect(projectKeyOf(UNCLASSIFIED_NAMESPACE)).not.toBe(UNCLASSIFIED_NAMESPACE);
    const named = registerAgent(w.orgId, "Named-Unclassified");
    db.prepare(`UPDATE agents SET scope = 'project', home_project = 'unclassified' WHERE id = ?`).run(named.agentId);
    invalidateScopes();
    db.prepare(`INSERT INTO blackboard_facts_ns (org_id, scope_key, key, value, set_by_agent_id, set_by_agent_name) VALUES (?, '', 'orphan', 'x', 'ghost-agent', 'Ghost')`).run(w.orgId);
    classifySharedState(db, w.orgId);
    const caller = { kind: "key" as const, id: named.agentId, name: named.agentName, key: named.apiKey };
    expect((await call("GET", "/v1/facts/one?key=orphan", caller)).status).toBe(404);
    expect((await call("GET", "/v1/facts/one?key=orphan", w.supervisor)).status).toBe(200);
  }, 30_000);
});

describe("roster and broadcast (§5)", () => {
  it("each row names its project; people are listed for everyone, workspace-wide agents too", async () => {
    const w = await world();
    const rows = (await call("GET", "/v1/agents", w.b1)).body.agents as Array<{ id: string; project_key: string | null; scope: string }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(w.b1.id)).toMatchObject({ project_key: BETA.key, scope: "project" });
    expect(byId.get(w.person.id)).toMatchObject({ project_key: null, scope: "workspace" });
    expect(byId.get(w.supervisor.id)).toMatchObject({ project_key: null, scope: "workspace" });
    expect(byId.has(w.a1.id)).toBe(false);
    expect((await call("GET", "/v1/agents", w.a1)).body.agents.find((r: { id: string }) => r.id === w.g1.id)).toMatchObject({ project_key: GAMMA.key });
    const text = await mcp(w.a1, (client) => toolText(client, "get_active_agents"));
    // A session's line says which tool and project the chat is in, since its name no longer does (sessions PR1).
    expect(text).toContain(`${w.g1.name} (ClaudeCode in Gamma) — `);
    expect(text).toContain("project: Gamma");
  }, 30_000);

  it("broadcast_message defaults to channel project: only the sender's own project, not links, people or workspace-wide agents", async () => {
    const w = await world();
    const text = await mcp(w.a1, (client) => toolText(client, "broadcast_message", { body: "alpha standup" }));
    expect(text).toContain("Broadcast sent to 1 agent(s).");
    expect(text).toContain(`${w.a2.name}: `);
    const rest = await call("POST", "/v1/messages", w.a2, { channel: "project", body: "alpha again" });
    expect(rest.status).toBe(201);
    expect(rest.body.deliveries.map((d: { toAgent: string }) => d.toAgent)).toEqual([w.a1.name]);
    // A workspace-wide agent has no project of its own.
    expect((await call("POST", "/v1/messages", w.supervisor, { channel: "project", body: "x" })).status).toBe(400);
    const org = await call("POST", "/v1/messages", w.a1, { channel: "org", body: "everyone" });
    expect(org.body.error).toContain('channel "org" reaches every project');
  }, 30_000);
});

describe("files and operators (§5)", () => {
  it("an operator agent reads a file only in a project it can see; a party to the thread always can", async () => {
    const w = await world();
    const shared = await call("POST", "/v1/files/share", w.a1, {
      toAgent: w.g1.name, filename: "spec.md", mimeType: "text/markdown", contentBase64: Buffer.from("# spec").toString("base64"), message: "linked file",
    });
    expect(shared.status).toBe(201);
    const opAlpha = registerAgent(w.orgId, "Operator-Alpha", { role: "operator", system: true });
    const opBeta = registerAgent(w.orgId, "Operator-Beta", { role: "operator", system: true });
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(ALPHA.key, opAlpha.agentId);
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(BETA.key, opBeta.agentId);
    invalidateScopes();
    const get = (key: string) => call("GET", `/v1/files/${shared.body.fileId}`, { kind: "key", id: "", name: "", key });
    expect((await get(opAlpha.apiKey)).status).toBe(200);
    expect((await get(opBeta.apiKey)).status).toBe(404);
    expect((await call("GET", `/v1/files/${shared.body.fileId}`, w.g1)).status).toBe(200);
  }, 30_000);
});

describe("escalations, bypass notices and phone push (§5)", () => {
  async function withProjectOperators() {
    const w = await world();
    const opAlpha = registerAgent(w.orgId, "Operator-Alpha", { role: "operator", system: true });
    const opBeta = registerAgent(w.orgId, "Operator-Beta", { role: "operator", system: true });
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(ALPHA.key, opAlpha.agentId);
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(BETA.key, opBeta.agentId);
    invalidateScopes();
    return { w, opAlpha: opAlpha.agentId, opBeta: opBeta.agentId };
  }
  const noticesTo = (orgId: string, prefix: string) =>
    db.prepare(`SELECT to_agent_id, body FROM messages WHERE org_id = ? AND body LIKE ? ORDER BY rowid`).all(orgId, `${prefix}%`) as Array<{ to_agent_id: string; body: string }>;

  it("an escalation goes to operator people and to operator agents that can see the recipient's project, and names it", async () => {
    const { w, opAlpha, opBeta } = await withProjectOperators();
    const sent = await sendMessage(w.orgId, asAgent(w.supervisor), w.b1.name, "beta, please look", "high");
    if (!sent.ok) throw new Error(sent.error);
    const m = db.prepare(`SELECT * FROM messages WHERE thread_id = ?`).get(sent.threadId) as MessageRecord;
    await sweepEscalations(new Date(Date.parse(`${m.created_at.replace(" ", "T")}Z`) + 11 * 60_000));
    const notices = noticesTo(w.orgId, "ESCALATION");
    const recipients = notices.map((n) => n.to_agent_id);
    // Assert membership, not an exact roster. The workspace has one more workspace-wide operator agent
    // than it used to: self-serve open sign-up mints a first key (docs/design/SELF-SERVE-BACKEND.md
    // §4.2), and that agent is operator-tier, so an escalation legitimately reaches it as well. Pinning
    // the exact set here would make every future operator agent a false failure, which is not what this
    // test is about -- it is about project visibility deciding who is told.
    expect(recipients).toContain(w.person.id);
    expect(recipients).toContain(w.operator.id);
    expect(recipients).toContain(opBeta);
    expect(recipients).not.toContain(opAlpha);
    for (const n of notices) expect(n.body.startsWith(`ESCALATION (project Beta): ${w.b1.name} has not read 1 high-priority message(s)`)).toBe(true);
    expect(notices.every((n) => db.prepare(`SELECT 1 FROM messages WHERE org_id = ? AND from_agent_id = ? AND to_agent_id = ?`).get(w.orgId, SYSTEM_SENDER.id, n.to_agent_id))).toBe(true);
  }, 30_000);

  it("a clearance bypass notice goes to operator people and to operator agents that can see the agent's project, and names it", async () => {
    const { w, opAlpha, opBeta } = await withProjectOperators();
    const outcome = await reportExecuted(w.orgId, asAgent(w.a1), { action: "git push --force origin main", required: "approval", category: "force-push" });
    expect(outcome.outcome).toBe("bypassed");
    const notices = noticesTo(w.orgId, "CLEARANCE BYPASSED");
    const recipients = notices.map((n) => n.to_agent_id);
    // Membership, not an exact roster -- see the note on the escalation test above: self-serve open
    // sign-up adds one workspace-wide operator agent, which legitimately receives these too.
    expect(recipients).toContain(w.person.id);
    expect(recipients).toContain(w.operator.id);
    expect(recipients).toContain(opAlpha);
    expect(recipients).not.toContain(opBeta);
    for (const n of notices) expect(n.body.startsWith(`CLEARANCE BYPASSED (project Alpha): ${w.a1.name} ran a force-push command`)).toBe(true);
  }, 30_000);

  it("a phone notification names the requester's project", () => {
    const message = approvalPushMessage({ id: "apr-1", org_id: "org-1", action: "deploy", risk: "high", requested_by_agent_name: "ClaudeCode-Alpha-1a2b", project_name: "Alpha" }, "Acme");
    expect(message.body).toBe("ClaudeCode-Alpha-1a2b in Alpha wants to run: deploy");
    expect(approvalPushMessage({ id: "apr-2", org_id: "org-1", action: "deploy", risk: "high", requested_by_agent_name: "Coder" }, "Acme").body).toBe("Coder wants to run: deploy");
  });
});
