import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { claimTask, completeTask, createTask, releaseTask, renewClaim } from "../src/tasks.js";
import { assignPlan } from "../src/billing.js";
import { setProjectEnabled } from "../src/projects.js";
import { invalidateScopes } from "../src/scope.js";
import { getAwareness } from "../src/awareness.js";
import { effectiveWipCap, setWipCap, WIP_CAP_ERROR, WIP_CAP_LOOSEN_REFUSAL } from "../src/project-settings.js";
import { signInPerson } from "./helpers/person.js";

// Fleet coordination plan, slice C (docs/superpowers/plans/2026-11-07-fleet-coordination.md, failure 3): owners claimed
// 5-7 items at once. A per-project WIP cap refuses a NEW claim once the claimant already holds that many live claims.

const ALPHA = "github.com/wip/alpha";
const BETA = "github.com/wip/beta";

function setupOrg(name: string) {
  const { orgId } = createOrganization(name);
  assignPlan(orgId, "internal");
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const op = { id: operator.agentId, name: "Operator", key: operator.apiKey };
  for (const key of [ALPHA, BETA]) setProjectEnabled(orgId, { actor: op, name: op.name, via: "operator" }, key, true);
  const a = registerAgent(orgId, "Worker");
  return { orgId, op, a: { id: a.agentId, name: "Worker", key: a.apiKey } };
}

/** Puts an agent in a project, as a session in that repository would be. */
describe("an Operator key may only tighten the cap; a person may set any value", () => {
  it("a key sets a cap where none applies, lowers one, or repeats one; it can't raise or lift one", () => {
    const { orgId, op } = setupOrg("WIP Tighten Org");
    expect(setWipCap(orgId, byKey(op), "", 3).wipCap).toBe(3);
    expect(setWipCap(orgId, byKey(op), "", 2).wipCap).toBe(2);
    expect(setWipCap(orgId, byKey(op), "", 2).wipCap).toBe(2);
    for (const [project, cap] of [["", 4], ["", null], [ALPHA, null], [ALPHA, 5]] as const) {
      expect(() => setWipCap(orgId, byKey(op), project, cap), `${project || "workspace"} -> ${cap}`).toThrow(WIP_CAP_LOOSEN_REFUSAL);
    }
    // ALPHA has no row of its own: the workspace's 2 applies, so 1 tightens and 2 changes nothing.
    expect(setWipCap(orgId, byKey(op), ALPHA, 1).wipCap).toBe(1);
    expect(setWipCap(orgId, byKey(op), BETA, 2).wipCap).toBe(2);
    expect(effectiveWipCap(orgId, null)).toBe(2);
    expect(effectiveWipCap(orgId, ALPHA)).toBe(1);

    // A person loosens.
    expect(setWipCap(orgId, byPerson(op), "", 10).wipCap).toBe(10);
    expect(setWipCap(orgId, byPerson(op), ALPHA, null).wipCap).toBeNull();
    expect(effectiveWipCap(orgId, ALPHA)).toBeNull();
  });
});

function homeIn(agentId: string, project: string) {
  db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(project, agentId);
  invalidateScopes();
}

/** A signed-in person's change (any value); an Operator key's is { agent, personId: null }, which may only tighten. */
const byPerson = (agent: { id: string; name: string }) => ({ agent, personId: "person-under-test" });
const byKey = (agent: { id: string; name: string }) => ({ agent, personId: null });

const tasks = (orgId: string, agent: { id: string; name: string }, ...titles: string[]) => titles.map((title) => createTask(orgId, agent, { title }).id);
const expireLease = (taskId: string) => db.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ?`).run("2000-01-01T00:00:00.000Z", taskId);
const statusOf = (taskId: string) => (db.prepare(`SELECT status, claimed_by_agent_id FROM tasks WHERE id = ?`).get(taskId) as { status: string; claimed_by_agent_id: string | null });

describe("claimTask under a WIP cap", () => {
  it("no cap means unlimited, as before", () => {
    const { orgId, a } = setupOrg("WIP None Org");
    for (const id of tasks(orgId, a, "one", "two", "three", "four", "five", "six")) expect(claimTask(orgId, a, id).ok).toBe(true);
    expect(effectiveWipCap(orgId, null)).toBeNull();
  });

  it("a workspace cap refuses the next claim and names the tasks held", () => {
    const { orgId, op, a } = setupOrg("WIP Workspace Org");
    setWipCap(orgId, byPerson(op), "", 3);
    const [t1, t2, t3, t4] = tasks(orgId, a, "Fix login", "Ship billing", "Write docs", "One too many");
    for (const id of [t1, t2, t3]) expect(claimTask(orgId, a, id).ok).toBe(true);
    expect(claimTask(orgId, a, t4)).toEqual({
      ok: false,
      error: 'You hold 3 tasks (cap 3): "Fix login", "Ship billing", "Write docs". Finish or release one first.',
    });
    expect(statusOf(t4)).toEqual({ status: "open", claimed_by_agent_id: null });
    // Releasing one frees a slot; completing one does too.
    expect(releaseTask(orgId, a, t1).ok).toBe(true);
    expect(claimTask(orgId, a, t4).ok).toBe(true);
    expect(claimTask(orgId, a, t1).ok).toBe(false);
    expect(completeTask(orgId, a, t2, "done").ok).toBe(true);
    expect(claimTask(orgId, a, t1).ok).toBe(true);
  });

  it("a cap of 1 says so in the singular", () => {
    const { orgId, op, a } = setupOrg("WIP One Org");
    setWipCap(orgId, byPerson(op), "", 1);
    const [t1, t2] = tasks(orgId, a, "Only this", "Not this");
    expect(claimTask(orgId, a, t1).ok).toBe(true);
    expect(claimTask(orgId, a, t2)).toEqual({ ok: false, error: 'You hold 1 task (cap 1): "Only this". Finish or release it first.' });
  });

  it("clips each held title in the refusal to 80 characters", () => {
    const { orgId, op, a } = setupOrg("WIP Clip Org");
    setWipCap(orgId, byPerson(op), "", 1);
    const long = "x".repeat(120);
    const [t1, t2] = tasks(orgId, a, long, "next");
    expect(claimTask(orgId, a, t1).ok).toBe(true);
    expect(claimTask(orgId, a, t2)).toEqual({ ok: false, error: `You hold 1 task (cap 1): "${"x".repeat(80)}…". Finish or release it first.` });
  });

  it("the claimant's project cap overrides the workspace cap, either way", () => {
    const { orgId, op, a } = setupOrg("WIP Project Org");
    homeIn(a.id, ALPHA);
    setWipCap(orgId, byPerson(op), "", 3);
    setWipCap(orgId, byPerson(op), ALPHA, 1);
    expect(effectiveWipCap(orgId, ALPHA)).toBe(1);
    expect(effectiveWipCap(orgId, BETA)).toBe(3);
    const [t1, t2, t3, t4] = tasks(orgId, a, "a1", "a2", "a3", "a4");
    expect(claimTask(orgId, a, t1).ok).toBe(true);
    expect(claimTask(orgId, a, t2).ok).toBe(false);

    // A project row with no cap overrides a workspace cap too: that project is unlimited.
    setWipCap(orgId, byPerson(op), ALPHA, null);
    expect(effectiveWipCap(orgId, ALPHA)).toBeNull();
    for (const id of [t2, t3, t4]) expect(claimTask(orgId, a, id).ok).toBe(true);
  });

  it("renewing a claim you hold is exempt, at the cap and after its lease lapsed", () => {
    const { orgId, op, a } = setupOrg("WIP Renew Org");
    const [t1, t2, t3] = tasks(orgId, a, "r1", "r2", "r3");
    expect(claimTask(orgId, a, t1).ok).toBe(true);
    expect(claimTask(orgId, a, t2).ok).toBe(true);
    // The cap arrives while the agent already holds more than it allows: nothing it holds is taken away.
    setWipCap(orgId, byPerson(op), "", 1);
    expect(renewClaim(orgId, a, t1).ok).toBe(true);
    // Re-claiming your own claim is a renewal (claimTask's isOwnRenewal): a lapsed lease stays status 'claimed' and
    // yours, so taking it back is exempt even though t1 alone already fills the cap.
    expect(claimTask(orgId, a, t1).ok).toBe(true);
    expireLease(t2);
    expect(claimTask(orgId, a, t2).ok).toBe(true);
    expect(claimTask(orgId, a, t3).ok).toBe(false);
  });

  it("a claim whose lease lapsed doesn't count toward the cap", () => {
    const { orgId, op, a } = setupOrg("WIP Lapsed Org");
    setWipCap(orgId, byPerson(op), "", 1);
    const [t1, t2] = tasks(orgId, a, "stale", "fresh");
    expect(claimTask(orgId, a, t1).ok).toBe(true);
    expect(claimTask(orgId, a, t2).ok).toBe(false);
    expireLease(t1);
    expect(claimTask(orgId, a, t2).ok).toBe(true);
  });

  it("counts only the claimant's own claims", () => {
    const { orgId, op, a } = setupOrg("WIP Own Org");
    const other = registerAgent(orgId, "Other");
    const b = { id: other.agentId, name: "Other" };
    setWipCap(orgId, byPerson(op), "", 1);
    const [t1, t2] = tasks(orgId, a, "mine", "theirs");
    expect(claimTask(orgId, a, t1).ok).toBe(true);
    expect(claimTask(orgId, b, t2).ok).toBe(true);
  });

  it("validates the cap: an integer from 1 to 50, or null", () => {
    const { orgId, op } = setupOrg("WIP Validate Org");
    for (const bad of [0, 51, 2.5, -1, "3", true, Number.NaN]) {
      expect(() => setWipCap(orgId, byPerson(op), "", bad as never)).toThrow(WIP_CAP_ERROR);
    }
    expect(setWipCap(orgId, byPerson(op), "", 50).wipCap).toBe(50);
    expect(setWipCap(orgId, byPerson(op), "", 1).wipCap).toBe(1);
    expect(setWipCap(orgId, byPerson(op), "", null).wipCap).toBeNull();
    expect(() => setWipCap(orgId, byPerson(op), "github.com/wip/unknown", 2)).toThrow(/No project/);
  });

  it("emits project.settings_changed with the old and new cap, only on a change", () => {
    const { orgId, op } = setupOrg("WIP Event Org");
    setWipCap(orgId, byPerson(op), ALPHA, 2);
    setWipCap(orgId, byPerson(op), ALPHA, 2);
    setWipCap(orgId, byPerson(op), ALPHA, 4);
    setWipCap(orgId, byPerson(op), "", 5);
    const events = db.prepare(`SELECT * FROM events WHERE org_id = ? AND type = 'project.settings_changed' ORDER BY seq`).all(orgId) as Array<Record<string, string | null>>;
    expect(events.map((e) => JSON.parse(e.payload!) as Record<string, unknown>)).toEqual([
      { project: ALPHA, previous: null, wipCap: 2, project_key: ALPHA },
      { project: ALPHA, previous: 2, wipCap: 4, project_key: ALPHA },
      { project: "", previous: null, wipCap: 5 },
    ]);
    expect(events.map((e) => [e.actor_agent_id, e.subject_type, e.project_key])).toEqual([[op.id, "project", ALPHA], [op.id, "project", ALPHA], [op.id, "project", null]]);
  });
});

describe("awareness shows the held count against the cap", () => {
  it("says 'You hold N of CAP' when a cap is set, and nothing when none is", () => {
    const { orgId, op, a } = setupOrg("WIP Awareness Org");
    const [t1, t2] = tasks(orgId, a, "x", "y");
    claimTask(orgId, a, t1);
    claimTask(orgId, a, t2);
    expect(getAwareness(orgId, a.id).wip).toBeNull();
    expect(getAwareness(orgId, a.id, { since: 0, board: true }).board!.text).not.toContain("You hold");

    setWipCap(orgId, byPerson(op), "", 3);
    const digest = getAwareness(orgId, a.id, { since: 0, board: true });
    expect(digest.wip).toEqual({ held: 2, cap: 3 });
    // Slice D moved the line into the board block.
    expect(digest.board!.text).toContain("You hold 2 of 3 tasks (WIP cap).");
    expect(digest.text).not.toContain("You hold");
    // The change itself is background (P3) for the agent, never an item that would wake it.
    expect(digest.items.map((i) => i.type)).not.toContain("project.settings_changed");
    expect(digest.background["project.settings_changed"]).toBe(1);
  });
});

describe("REST /v1/org/projects/:key/settings, claims over REST and MCP, and MCP set_wip_cap", () => {
  let restServer: http.Server;
  let mcpServer: http.Server;
  let base: string;
  let mcpUrl: URL;
  beforeAll(async () => {
    restServer = http.createServer(app);
    await new Promise<void>((r) => restServer.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(restServer.address() as AddressInfo).port}`;
    mcpServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
        void handleMcpRequest(req, res);
      });
    });
    await new Promise<void>((r) => mcpServer.listen(0, "127.0.0.1", r));
    mcpUrl = new URL(`http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`);
  });
  afterAll(async () => {
    await new Promise<void>((r) => restServer.close(() => r()));
    await new Promise<void>((r) => mcpServer.close(() => r()));
  });

  const bearer = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
  const call = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const settingsPath = (key: string) => `/v1/org/projects/${encodeURIComponent(key)}/settings`;
  const connect = async (key: string) => {
    const client = new Client({ name: "wip-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    return client;
  };
  const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");

  it("an admin sets and reads the cap; a member and an agent are refused 403", async () => {
    const { orgId, op, a } = setupOrg("REST WIP Org");
    const admin = await signInPerson(orgId, "Ada", "admin");
    const member = await signInPerson(orgId, "Mo", "member");

    const set = await call(admin.headers, "PUT", settingsPath(ALPHA), { wipCap: 2 });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ settings: { project: ALPHA, wipCap: 2, effectiveWipCap: 2, source: "project" } });
    const row = db.prepare(`SELECT updated_by_person_id FROM project_settings WHERE org_id = ? AND project_key = ?`).get(orgId, ALPHA) as { updated_by_person_id: string };
    expect(row.updated_by_person_id).toBe(admin.personId);
    // An Operator key is owner-equivalent (roleFor), so it is an admin here; the row then names no person.
    expect((await call(bearer(op.key), "PUT", settingsPath("*"), { wipCap: 4 })).status).toBe(200);

    for (const headers of [member.headers, bearer(a.key)]) {
      const refused = await call(headers, "PUT", settingsPath(ALPHA), { wipCap: 9 });
      expect(refused.status).toBe(403);
    }
    expect((await (await call(bearer(a.key), "GET", settingsPath(ALPHA))).json())).toEqual({ settings: { project: ALPHA, wipCap: 2, effectiveWipCap: 2, source: "project" } });
    expect((await (await call(bearer(a.key), "GET", settingsPath(BETA))).json())).toEqual({ settings: { project: BETA, wipCap: null, effectiveWipCap: 4, source: "workspace" } });
    const workspace = { settings: { project: "", wipCap: 4, effectiveWipCap: 4, source: "workspace" } };
    expect((await (await call(bearer(a.key), "GET", "/v1/org/projects/*/settings")).json())).toEqual(workspace);
    expect((await (await call(bearer(a.key), "GET", "/v1/org/projects/%2A/settings")).json())).toEqual(workspace);
    // "_workspace" is an ordinary (legacy folder-name) project key now, so it can't shadow a project of that name.
    expect((await call(bearer(a.key), "GET", settingsPath("_workspace"))).status).toBe(404);

    // An Operator key may only tighten: raising or lifting a cap takes a person, who may.
    for (const [path, wipCap] of [[settingsPath(ALPHA), 3], [settingsPath(ALPHA), null], [settingsPath("*"), 5]] as const) {
      const refused = await call(bearer(op.key), "PUT", path, { wipCap });
      expect(refused.status, `${path} -> ${wipCap}`).toBe(403);
      expect(await refused.json()).toEqual({ error: WIP_CAP_LOOSEN_REFUSAL });
    }
    expect((await call(bearer(op.key), "PUT", settingsPath(ALPHA), { wipCap: 1 })).status).toBe(200);
    expect((await call(admin.headers, "PUT", settingsPath(ALPHA), { wipCap: 6 })).status).toBe(200);
    expect(effectiveWipCap(orgId, ALPHA)).toBe(6);
    expect((await call(admin.headers, "PUT", "/v1/org/projects/%2A/settings", { wipCap: null })).status).toBe(200);
    expect(effectiveWipCap(orgId, null)).toBeNull();
  });

  it("validates the body and the project", async () => {
    const { orgId } = setupOrg("REST WIP Validate Org");
    const admin = await signInPerson(orgId, "Ada", "admin");
    for (const wipCap of [0, 51, 1.5, "2", true, undefined]) {
      const res = await call(admin.headers, "PUT", settingsPath(ALPHA), wipCap === undefined ? {} : { wipCap });
      expect(res.status, `wipCap ${String(wipCap)}`).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(WIP_CAP_ERROR);
    }
    expect((await call(admin.headers, "PUT", settingsPath(ALPHA), { wipCap: null })).status).toBe(200);
    expect((await call(admin.headers, "PUT", settingsPath("github.com/wip/unknown"), { wipCap: 2 })).status).toBe(404);
    expect((await call(admin.headers, "GET", settingsPath("github.com/wip/unknown"))).status).toBe(404);
    expect((await call(admin.headers, "PUT", settingsPath("not a key!"), { wipCap: 2 })).status).toBe(400);
  });

  it("a refused claim is a clear 409 over REST and an Error over MCP, never a 500", async () => {
    const { orgId, op, a } = setupOrg("REST WIP Claim Org");
    setWipCap(orgId, byPerson(op), "", 1);
    const [t1, t2] = tasks(orgId, a, "held", "wanted");
    expect((await call(bearer(a.key), "POST", `/v1/tasks/${t1}/claim`, {})).status).toBe(200);
    const refused = await call(bearer(a.key), "POST", `/v1/tasks/${t2}/claim`, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, error: 'You hold 1 task (cap 1): "held". Finish or release it first.' });

    const client = await connect(a.key);
    try {
      expect(text(await client.callTool({ name: "claim_task", arguments: { taskId: t2 } }))).toBe('Error: You hold 1 task (cap 1): "held". Finish or release it first.');
    } finally {
      await client.close();
    }
  });

  it("MCP set_wip_cap: an admin key sets it (no project = the workspace default); an agent is refused", async () => {
    const { orgId, op, a } = setupOrg("MCP WIP Org");
    const agent = await connect(a.key);
    try {
      expect(text(await agent.callTool({ name: "set_wip_cap", arguments: { cap: 2 } }))).toBe("Error: not permitted");
    } finally {
      await agent.close();
    }
    expect(effectiveWipCap(orgId, null)).toBeNull();

    const admin = await connect(op.key);
    try {
      expect(text(await admin.callTool({ name: "set_wip_cap", arguments: { cap: 2 } }))).toBe("WIP cap for the workspace default: 2 (was none).");
      expect(text(await admin.callTool({ name: "set_wip_cap", arguments: { project: ALPHA, cap: 1 } }))).toBe(`WIP cap for ${ALPHA}: 1 (was none).`);
      // MCP carries no person, so every admin there is a key: it may only tighten.
      expect(text(await admin.callTool({ name: "set_wip_cap", arguments: { project: ALPHA, cap: null } }))).toBe(`Error: ${WIP_CAP_LOOSEN_REFUSAL}`);
      expect(text(await admin.callTool({ name: "set_wip_cap", arguments: { project: "*", cap: 3 } }))).toBe(`Error: ${WIP_CAP_LOOSEN_REFUSAL}`);
      expect(text(await admin.callTool({ name: "set_wip_cap", arguments: { project: "*", cap: 1 } }))).toBe("WIP cap for the workspace default: 1 (was 2).");
      expect(text(await admin.callTool({ name: "set_wip_cap", arguments: { cap: 99 } }))).toBe(`Error: ${WIP_CAP_ERROR}`);
    } finally {
      await admin.close();
    }
    expect(effectiveWipCap(orgId, null)).toBe(1);
    expect(effectiveWipCap(orgId, ALPHA)).toBe(1);
  });

  it("project scope: an admin agent in Beta can't read or set Alpha's cap (404), or the workspace default (403)", async () => {
    const { orgId } = setupOrg("REST WIP Scope Org");
    db.prepare(`UPDATE organizations SET project_isolation = 1 WHERE id = ?`).run(orgId);
    const betaOp = registerAgent(orgId, "Beta-Operator", { role: "operator", system: true });
    homeIn(betaOp.agentId, BETA);
    expect((await call(bearer(betaOp.apiKey), "PUT", settingsPath(ALPHA), { wipCap: 2 })).status).toBe(404);
    expect((await call(bearer(betaOp.apiKey), "GET", settingsPath(ALPHA))).status).toBe(404);
    expect((await call(bearer(betaOp.apiKey), "PUT", settingsPath("*"), { wipCap: 2 })).status).toBe(403);
    expect((await call(bearer(betaOp.apiKey), "PUT", settingsPath(BETA), { wipCap: 2 })).status).toBe(200);
    expect(effectiveWipCap(orgId, ALPHA)).toBeNull();
    expect(effectiveWipCap(orgId, BETA)).toBe(2);
  });
});
