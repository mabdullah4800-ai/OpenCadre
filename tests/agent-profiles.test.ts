// Agent names and operator-owned profiles (sessions PR1, board task 822803e1), against Codex-OpenCadre-049a's binding
// rulings of 2026-09-30 (B:\ai-work\temp\9d1f-ambient\codex-profile-ruling-20260930.md and the Q1-Q5 answers):
// a profile is unique per workspace; each chat stays its own immutable session with a permanent "<profile> #<n>" address;
// an address, once held by any agent, is never reassigned (a database guarantee); a rename changes display only.
// Everything runs through the real migrations, REST routes, MCP server and service calls.
import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent, removeAgent, sendMessage, reply as replyOnThread } from "../src/service.js";
import { buildSessionName, nameSession } from "../src/devices.js";
import { claimTask, createTask } from "../src/tasks.js";
import { setProjectEnabled } from "../src/projects.js";
import { requestApproval } from "../src/approvals.js";
import { LEGACY_SESSION_NAME, NAME_WORDS } from "../src/agent-names.js";
import { verifyEventChain } from "../src/events.js";
import { signInPerson } from "./helpers/person.js";

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

const PROJECT = { key: "local:ProfileTest", name: "ProfileTest" };
let ipCounter = 0;
const nextIp = () => `10.88.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function call(method: string, path: string, { key, headers = {}, body, tool }: { key?: string; headers?: Record<string, string>; body?: unknown; tool?: string } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(tool ? { "x-opencadre-session": tool, "x-opencadre-project": PROJECT.key, "x-opencadre-project-name": PROJECT.name } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

let orgCounter = 0;
async function workspace() {
  const orgId = createOrganization(`Profiles Org ${++orgCounter}`, "internal").orgId;
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  setProjectEnabled(orgId, { actor: null, name: "test", via: "operator" }, PROJECT.key, true);
  const person = await signInPerson(orgId, "Ada");
  const minted = (await (await call("POST", "/v1/org/devices", { key: operator.apiKey, body: { name: "PC", client: "claude-code" } })).json()) as { code: string };
  const redeemed = (await (await call("POST", "/v1/connect/redeem", { body: { code: minted.code }, headers: { "x-forwarded-for": nextIp() } })).json()) as { deviceCredential: string };
  return { orgId, operator, person, credential: redeemed.deviceCredential };
}

type W = Awaited<ReturnType<typeof workspace>>;

async function join(w: W, tool: string) {
  const res = await call("POST", "/v1/sessions/join", { key: w.credential, tool });
  return (await res.json()) as { agentId: string; agentName: string; created: boolean };
}

/** The fixture profile. Deliberately NOT a NAME_WORDS entry: sessions get random words from that list, so a profile named
 * like one ("Atlas") collides with a session that happened to draw it, and an assertion then measures that incidental
 * reserved address instead of the rule under test (review 049a on #675). Collisions are tested on purpose, separately. */
const P = "Kestrelmoor";

/** Name a session into a profile, and assert it worked: a later check must never run on a naming that silently failed. */
async function nameIt(w: W, agentId: string, name: string) {
  const res = await tryName(w, agentId, name);
  expect(res.status, `naming ${agentId} into ${name}`).toBe(200);
  return res;
}
/** The raw naming call, for the arms that expect a refusal. */
const tryName = (w: W, agentId: string, name: string) =>
  call("PATCH", `/v1/org/sessions/${agentId}`, { headers: w.person.headers, body: { name } });

/** A legacy "<Client>-<Project>-<4hex>" session: the shape every session had before names. */
function legacySession(w: W, name = "ClaudeCode-ProfileTest-1a2b") {
  const id = `legacy-${Math.random().toString(16).slice(2)}`;
  db.prepare(
    `INSERT INTO agents (id, org_id, name, url_key, api_key_hash, role, key_class, kind, project, project_name, client, scope, liveness)
     VALUES (?, ?, ?, ?, ?, 'agent', 'agent', 'session', ?, ?, 'claude-code', 'project', 'chat')`,
  ).run(id, w.orgId, name, `session-${id.slice(0, 8)}`, `session:${id}`, PROJECT.key, PROJECT.name);
  return id;
}

const agentRow = (id: string) => db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as Record<string, unknown>;

async function mcp(w: W, tool: string) {
  const client = new Client({ name: "profiles-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${w.credential}`, "x-opencadre-session": tool, "x-opencadre-project": PROJECT.key, "x-opencadre-project-name": PROJECT.name } },
  }));
  const text = async (name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0].text;
  return { client, text };
}

describe("names at creation", () => {
  it("a new session gets one pronounceable word, with no hex suffix and no client or project in it", async () => {
    const w = await workspace();
    const s = await join(w, "word-tool");
    expect(NAME_WORDS).toContain(s.agentName);
    expect(s.agentName).not.toMatch(/[0-9a-f]{4}$/);
    expect(LEGACY_SESSION_NAME.test(s.agentName)).toBe(false);
    expect(agentRow(s.agentId)).toMatchObject({ client: "claude-code", project_name: PROJECT.name });
  });

  it("a taken word is retried, then two words, then a word and a number; never a profile's name", () => {
    const orgId = createOrganization(`Profiles Words ${++orgCounter}`, "internal").orgId;
    registerAgent(orgId, "Atlas");
    expect(buildSessionName(orgId, (() => { const seq = ["Atlas", "Birch"]; return () => seq.shift() ?? "Birch"; })())).toBe("Birch");
    registerAgent(orgId, "Birch");
    const onlyTaken = ["Atlas", "Birch"];
    let i = 0;
    const cycling = () => onlyTaken[i++ % 2];
    expect(buildSessionName(orgId, cycling)).toMatch(/^(Atlas Birch|Birch Atlas)$/);
    db.prepare(`INSERT INTO agent_profiles (id, org_id, name, name_key) VALUES ('p-cedar', ?, 'Cedar', 'cedar')`).run(orgId);
    expect(buildSessionName(orgId, (() => { const seq = ["Cedar", "Cedar", "Dune"]; return () => seq.shift() ?? "Dune"; })())).toBe("Dune");
  });
});

describe("naming a session into a profile (ruling Q1: naming metadata, never an attach)", () => {
  it("only a signed-in person names a session; an agent or Operator key is refused", async () => {
    const w = await workspace();
    const s = await join(w, "auth-tool");
    expect((await call("PATCH", `/v1/org/sessions/${s.agentId}`, { key: w.operator.apiKey, body: { name: P } })).status).toBe(403);
    expect((await call("PATCH", `/v1/org/sessions/${s.agentId}`, { key: w.credential, tool: "auth-tool", body: { name: P } })).status).toBe(403);
    expect(agentRow(s.agentId).name).toBe(s.agentName);
    const named = await nameIt(w, s.agentId, P);
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ agentId: s.agentId, agentName: `${P} #1`, previousName: s.agentName, profile: { name: P } });
  });

  it("concurrent chats under one profile are distinct sessions with permanent, never-reused addresses", async () => {
    const w = await workspace();
    const [a, b, c] = [await join(w, "c-a"), await join(w, "c-b"), await join(w, "c-c")];
    expect((await (await nameIt(w, a.agentId, P)).json()).agentName).toBe(`${P} #1`);
    expect((await (await nameIt(w, b.agentId, P.toLowerCase())).json()).agentName).toBe(`${P} #2`); // same profile, case ignored
    // Session b moves to another profile: its "#2" address stays its own, and the next chat of this profile is #3, never #2.
    expect((await (await nameIt(w, b.agentId, "Birchwood")).json()).agentName).toBe("Birchwood #1");
    expect((await (await nameIt(w, c.agentId, P)).json()).agentName).toBe(`${P} #3`);
    const ids = new Set([a, b, c].map((s) => s.agentId));
    expect(ids.size).toBe(3);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agent_profiles WHERE org_id = ? AND name_key = ?`).get(w.orgId, P.toLowerCase())).toEqual({ n: 1 });
    // The profile's counter holds on its own, not only through the address registry: even with "#2"'s address
    // row deleted (as a cleanup might), the next chat of this profile is #4, never #2 again.
    db.prepare(`DELETE FROM agent_addresses WHERE org_id = ? AND name = ?`).run(w.orgId, `${P} #2`);
    const d = await join(w, "c-d");
    expect((await (await nameIt(w, d.agentId, P)).json()).agentName).toBe(`${P} #4`);
    expect(db.prepare(`SELECT next_ordinal FROM agent_profiles WHERE org_id = ? AND name_key = ?`).get(w.orgId, P.toLowerCase())).toEqual({ next_ordinal: 5 });
  });

  it("(Q2a) naming creates, joins and changes no other session, and changes nothing but the name on this one", async () => {
    const w = await workspace();
    const a = await join(w, "q2-a");
    const b = await join(w, "q2-b");
    const before = db.prepare(`SELECT * FROM agents WHERE org_id = ? ORDER BY id`).all(w.orgId) as Array<Record<string, unknown>>;
    await nameIt(w, a.agentId, P);
    const after = db.prepare(`SELECT * FROM agents WHERE org_id = ? ORDER BY id`).all(w.orgId) as Array<Record<string, unknown>>;
    expect(after.length).toBe(before.length);
    for (const row of before) {
      const now = after.find((r) => r.id === row.id)!;
      // The naming person's own member agent heartbeats by making the request; every other row is untouched.
      if (row.id === w.person.decider.id) continue;
      if (row.id !== a.agentId) expect(now).toEqual(row);
      else {
        const { name: _n1, profile_id: _p1, name_prompt_done_at: _d1, ...rest0 } = row;
        const { name: _n2, profile_id: _p2, name_prompt_done_at: _d2, ...rest1 } = now;
        expect(rest1).toEqual(rest0); // key hash, seat, device, project, role, scope, liveness: all untouched
      }
    }
    expect(agentRow(b.agentId).name).toBe(b.agentName);
  });

  it("(Q2b) the session resolver still never joins a distinct concurrent chat to a live row, named or not", async () => {
    const w = await workspace();
    const a = await join(w, "q2b-a");
    await nameIt(w, a.agentId, P);
    const again = await join(w, "q2b-a");
    const other = await join(w, "q2b-b");
    expect(again).toMatchObject({ agentId: a.agentId, agentName: `${P} #1`, created: false });
    expect(other.agentId).not.toBe(a.agentId);
    expect(other.agentName).not.toMatch(new RegExp(`^${P}`));
  });

  it("(Q3) a profile name is unique ignoring case; it may not be an agent's address; and it has no '#'", async () => {
    const w = await workspace();
    const [a, b] = [await join(w, "q3-a"), await join(w, "q3-b")];
    await nameIt(w, a.agentId, P);
    await nameIt(w, b.agentId, P.toUpperCase());
    expect(db.prepare(`SELECT name FROM agent_profiles WHERE org_id = ?`).pluck().all(w.orgId)).toEqual([P]);
    expect(() => db.prepare(`INSERT INTO agent_profiles (id, org_id, name, name_key) VALUES ('dup', ?, ?, ?)`).run(w.orgId, P.toLowerCase(), P.toLowerCase())).toThrow(/UNIQUE/);
    registerAgent(w.orgId, "Coder");
    expect((await tryName(w, a.agentId, "coder")).status).toBe(409);
    expect((await tryName(w, a.agentId, `${P} #9`)).status).toBe(400);
    expect((await tryName(w, a.agentId, P)).status).toBe(409); // already a chat of this profile
    // and a keyed agent can't take a profile's name
    expect(() => registerAgent(w.orgId, P.toLowerCase())).toThrow(/profile/);
  });
});

describe("a profile name that a session already holds as its word (the collision, on purpose)", () => {
  it("the fixture profile can never be drawn as a session word", () => {
    expect(NAME_WORDS).not.toContain(P);
  });

  it("naming into a profile whose name is a live session's word is refused, and nothing is created", async () => {
    const w = await workspace();
    legacySession(w, "Atlas"); // a session that drew the word "Atlas"
    const a = await join(w, "collide-a");
    expect((await tryName(w, a.agentId, "Atlas")).status).toBe(409);
    expect(db.prepare(`SELECT COUNT(*) FROM agent_profiles WHERE org_id = ?`).pluck().get(w.orgId)).toBe(0);
  });
});

describe("an address, once held, is never reassigned (database-enforced)", () => {
  it("an old address answers to nobody: direct mail to it fails closed, while its threads keep working", async () => {
    const w = await workspace();
    const a = await join(w, "addr-a");
    const coder = registerAgent(w.orgId, "Coder");
    const sent = await sendMessage(w.orgId, { id: coder.agentId, name: "Coder" }, a.agentName, "before the rename");
    if (!sent.ok) throw new Error(sent.error);
    const oldName = a.agentName;
    await nameIt(w, a.agentId, P);
    expect(await sendMessage(w.orgId, { id: coder.agentId, name: "Coder" }, oldName, "to the old name")).toMatchObject({ ok: false, error: expect.stringMatching(/No agent found/) });
    expect(await sendMessage(w.orgId, { id: coder.agentId, name: "Coder" }, `${P} #1`, "to the new name")).toMatchObject({ ok: true });
    // A reply on the thread opened before the rename still reaches the same agent, and the thread still names it by id.
    expect(replyOnThread(w.orgId, { id: a.agentId, name: `${P} #1` }, sent.threadId, "still here")).toMatchObject({ ok: true });
    expect(db.prepare(`SELECT from_agent_id FROM messages WHERE thread_id = ? AND body = 'still here'`).get(sent.threadId)).toEqual({ from_agent_id: a.agentId });
  });

  it("nobody can take an old address or a removed agent's name, even by writing the database directly", async () => {
    const w = await workspace();
    const a = await join(w, "addr-b");
    const oldName = a.agentName;
    await nameIt(w, a.agentId, P);
    expect(() => registerAgent(w.orgId, oldName)).toThrow(/already exists/);
    const gone = registerAgent(w.orgId, "Leaver");
    removeAgent(w.orgId, { id: w.operator.agentId, name: "Operator" }, gone.agentId);
    expect(() => registerAgent(w.orgId, "Leaver")).toThrow(/already exists/);
    // The trigger holds without the service: a raw insert or rename onto a held address is aborted.
    expect(() => legacySession(w, oldName)).toThrow(/address already held/);
    const b = await join(w, "addr-c");
    expect(() => db.prepare(`UPDATE agents SET name = ? WHERE id = ?`).run("leaver", b.agentId)).toThrow(/address already held/);
    expect(agentRow(b.agentId).name).toBe(b.agentName);
  });

  it("the agent keeps its own past addresses: it may be named back into a name it held", async () => {
    const w = await workspace();
    const a = await join(w, "addr-d");
    await nameIt(w, a.agentId, P);
    await nameIt(w, a.agentId, "Birchwood");
    const rows = db.prepare(`SELECT name, released_at IS NOT NULL AS released FROM agent_addresses WHERE agent_id = ? ORDER BY created_at, name`).all(a.agentId);
    expect(rows).toEqual(expect.arrayContaining([
      { name: a.agentName, released: 1 }, { name: `${P} #1`, released: 1 }, { name: "Birchwood #1", released: 0 },
    ]));
  });
});

describe("a rename never changes authority (ruling Q4)", () => {
  it("role, key, claims, pending approvals and mail stay with the immutable id", async () => {
    const w = await workspace();
    const a = await join(w, "auth-a");
    const me = { id: a.agentId, name: a.agentName };
    const task = createTask(w.orgId, me, { title: "keep me" });
    expect(claimTask(w.orgId, me, task.id).ok).toBe(true);
    const approval = await requestApproval(w.orgId, me, { action: "rm -rf ./x", risk: "high", category: "rm-rf" });
    const before = agentRow(a.agentId);
    await nameIt(w, a.agentId, P);
    const after = agentRow(a.agentId);
    for (const field of ["role", "key_class", "api_key_hash", "scope", "device_id", "seat_id", "kind", "home_project"]) expect(after[field]).toEqual(before[field]);
    expect(db.prepare(`SELECT claimed_by_agent_id FROM tasks WHERE id = ?`).get(task.id)).toEqual({ claimed_by_agent_id: a.agentId });
    expect(db.prepare(`SELECT requested_by_agent_id, status FROM approvals WHERE id = ?`).get((approval as { id: string }).id)).toEqual({ requested_by_agent_id: a.agentId, status: "pending" });
    // The same device credential and session header still act as the same agent, now under its new name.
    expect(await join(w, "auth-a")).toMatchObject({ agentId: a.agentId, agentName: `${P} #1` });
  });

  it("no session can read another's mail or claims, two chats of one profile included", async () => {
    const w = await workspace();
    const [a, b] = [await join(w, "iso-a"), await join(w, "iso-b")];
    await nameIt(w, a.agentId, P);
    await nameIt(w, b.agentId, P);
    const coder = registerAgent(w.orgId, "Coder");
    await sendMessage(w.orgId, { id: coder.agentId, name: "Coder" }, `${P} #1`, "for #1 only");
    const task = createTask(w.orgId, { id: a.agentId, name: `${P} #1` }, { title: "#1's work" });
    claimTask(w.orgId, { id: a.agentId, name: `${P} #1` }, task.id);
    const two = await mcp(w, "iso-b");
    try {
      expect(await two.text("get_messages")).not.toContain("for #1 only");
      expect(await two.text("release_task", { taskId: task.id })).toMatch(new RegExp(`is claimed by ${P} #1|don't hold a claim`));
      expect(await two.text("complete_task", { taskId: task.id, summary: "not mine" })).toMatch(/claim|not/i);
    } finally {
      await two.client.close();
    }
    const one = await mcp(w, "iso-a");
    try {
      expect(await one.text("get_messages")).toContain("for #1 only");
    } finally {
      await one.client.close();
    }
  });
});

describe("the agent sees its new name", () => {
  it("through /v1/me, get_awareness and its very next MCP write, without reconnecting", async () => {
    const w = await workspace();
    const a = await join(w, "see-a");
    const session = await mcp(w, "see-a");
    try {
      expect(await session.text("get_awareness")).toMatch(new RegExp(`^You are ${a.agentName}\\.`));
      await nameIt(w, a.agentId, P);
      const coder = registerAgent(w.orgId, "Coder");
      await session.text("send_message", { toAgent: "Coder", body: "hello after rename" });
      const written = db.prepare(`SELECT from_agent_id, from_agent_name FROM messages WHERE org_id = ? AND body = 'hello after rename'`).get(w.orgId);
      expect(written).toEqual({ from_agent_id: a.agentId, from_agent_name: `${P} #1` });
      const awareness = await session.text("get_awareness");
      expect(awareness).toMatch(new RegExp(`^You are ${P} #1\\.`));
      expect(awareness).toContain(`renamed you from ${a.agentName} to ${P} #1`);
      void coder;
    } finally {
      await session.client.close();
    }
    const me = (await (await call("GET", "/v1/me", { key: w.credential, tool: "see-a" })).json()) as { agentName: string; agentId: string };
    expect(me).toMatchObject({ agentId: a.agentId, agentName: `${P} #1` });
  });
});

describe("the one-time naming prompt (ruling Q5: sessions only)", () => {
  it("is due once for a legacy session name, and never for a keyed agent or a new word-named session", async () => {
    const w = await workspace();
    const legacy = legacySession(w);
    const fresh = await join(w, "prompt-fresh");
    registerAgent(w.orgId, "Codex-Repo-abcd"); // a keyed agent whose name happens to match the old shape
    const listed = async () => ((await (await call("GET", "/v1/org/sessions?status=live", { headers: w.person.headers })).json()) as { sessions: Array<{ agentId: string; namePromptDue: boolean }> }).sessions;
    const due = (rows: Array<{ agentId: string; namePromptDue: boolean }>) => rows.filter((s) => s.namePromptDue).map((s) => s.agentId);
    expect(due(await listed())).toEqual([legacy]);
    expect((await listed()).some((s) => s.agentId === fresh.agentId && !s.namePromptDue)).toBe(true);
    // "Keep this name" answers it for good, and changes nothing else.
    expect((await call("POST", `/v1/org/sessions/${legacy}/keep-name`, { key: w.operator.apiKey })).status).toBe(403);
    const kept = await call("POST", `/v1/org/sessions/${legacy}/keep-name`, { headers: w.person.headers });
    expect(await kept.json()).toEqual({ agentId: legacy, agentName: "ClaudeCode-ProfileTest-1a2b" });
    expect(due(await listed())).toEqual([]);
  });
});

describe("save_task", () => {
  it("files an open, unclaimed side request linked to the current task, and leaves the caller's claim and status alone", async () => {
    const w = await workspace();
    const a = await join(w, "save-a");
    const me = { id: a.agentId, name: a.agentName };
    const current = createTask(w.orgId, me, { title: "current work" });
    claimTask(w.orgId, me, current.id);
    const before = db.prepare(`SELECT status, claimed_by_agent_id, lease_expires_at, revision FROM tasks WHERE id = ?`).get(current.id);
    const statusBefore = db.prepare(`SELECT current_task, status_updated_at FROM agents WHERE id = ?`).get(a.agentId);
    const session = await mcp(w, "save-a");
    try {
      const saved = await session.text("save_task", { title: "user asked: fix the footer", description: "later" });
      expect(saved).toContain("Saved for later");
      expect(saved).toContain(`side request of ${current.id}`);
    } finally {
      await session.client.close();
    }
    const side = db.prepare(`SELECT status, claimed_by_agent_id, parent_task_id, side_request_of FROM tasks WHERE org_id = ? AND title = 'user asked: fix the footer'`).get(w.orgId);
    expect(side).toEqual({ status: "open", claimed_by_agent_id: null, parent_task_id: null, side_request_of: current.id });
    expect(db.prepare(`SELECT status, claimed_by_agent_id, lease_expires_at, revision FROM tasks WHERE id = ?`).get(current.id)).toEqual(before);
    expect(db.prepare(`SELECT current_task, status_updated_at FROM agents WHERE id = ?`).get(a.agentId)).toEqual(statusBefore);
  });
});

describe("migration 55 preserves history", () => {
  it("no existing row changes, old names stay where they were written, and the event chain verifies", async () => {
    const w = await workspace();
    const a = await join(w, "hist-a");
    const coder = registerAgent(w.orgId, "Coder");
    await sendMessage(w.orgId, { id: a.agentId, name: a.agentName }, "Coder", "written under the old name");
    const oldName = a.agentName;
    await nameIt(w, a.agentId, P);
    expect(db.prepare(`SELECT from_agent_name FROM messages WHERE body = 'written under the old name'`).get()).toEqual({ from_agent_name: oldName });
    const renamed = db.prepare(`SELECT actor_agent_name, payload FROM events WHERE org_id = ? AND type = 'agent.renamed'`).get(w.orgId) as { actor_agent_name: string; payload: string };
    expect(JSON.parse(renamed.payload)).toMatchObject({ from: oldName, to: `${P} #1`, profile: P, byPerson: true });
    expect(verifyEventChain(w.orgId).ok).toBe(true);
    void coder;
  });
});

describe("a saved side request stays linked on ordinary reads (review 049a)", () => {
  it("shows the current-task link when another agent later reads the saved task", async () => {
    const w = await workspace();
    const a = await join(w, "review-save-author");
    const current = createTask(w.orgId, { id: a.agentId, name: a.agentName }, { title: "review current work" });
    claimTask(w.orgId, { id: a.agentId, name: a.agentName }, current.id);
    const author = await mcp(w, "review-save-author");
    try {
      await author.text("save_task", { title: "review saved side request" });
    } finally { await author.client.close(); }
    const side = db.prepare(`SELECT id, side_request_of FROM tasks WHERE org_id = ? AND title = 'review saved side request'`).get(w.orgId) as { id: string; side_request_of: string };
    expect(side.side_request_of).toBe(current.id);
    const reader = await mcp(w, "review-save-reader");
    try {
      const detail = await reader.text("get_task", { taskId: side.id });
      const list = await reader.text("list_tasks", { limit: 20 });
      expect(detail).toContain(`side request of ${current.id}`);
      expect(list).toContain(`side request of ${current.id}`);
    } finally { await reader.client.close(); }
  });
});

describe("migration 55 on a populated version-54 database (review 049a)", () => {
  it("upgrades populated version 54, preserving values and reserving removed names", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { MIGRATIONS, runMigrations } = await import("../src/migrations.js");
    const fixture = new Database(":memory:");
    try {
      runMigrations(fixture, MIGRATIONS.filter((m) => m.version <= 54));
      fixture.prepare(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('review-org', 'Review', 'placeholder')`).run();
      const insert = fixture.prepare(`INSERT INTO agents (id, org_id, name, url_key, api_key_hash, removed_at) VALUES (?, 'review-org', ?, ?, ?, ?)`);
      insert.run("review-gone", "Reserved", "gone", "unusable-gone", "2026-09-29 00:00:00");
      insert.run("review-live", "reserved", "live", "unusable-live", null);
      const tables = (fixture.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'`).all() as {name:string}[]).map(r => r.name);
      const snapshots = tables.map(table => {
        const columns = (fixture.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(r => r.name).join(",");
        return { table, columns, rows: fixture.prepare(`SELECT ${columns} FROM ${table}`).all() };
      });
      expect(runMigrations(fixture, MIGRATIONS.filter((m) => m.version <= 55)).applied).toEqual([55]);
      for (const {table,columns,rows} of snapshots) expect(fixture.prepare(`SELECT ${columns} FROM ${table}`).all(), table).toEqual(rows);
      expect(fixture.prepare(`SELECT agent_id FROM agent_addresses WHERE org_id = 'review-org' AND name_key = 'reserved'`).get()).toEqual({agent_id:"review-live"});
      expect(() => insert.run("review-intruder", "Reserved", "intruder", "unusable-intruder", null)).toThrow(/address already held/);
      expect(runMigrations(fixture, MIGRATIONS.filter((m) => m.version <= 55)).applied).toEqual([]);
    } finally { fixture.close(); }
  });
});
