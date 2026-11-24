import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent, HEARTBEAT_TTL_MS } from "../src/service.js";
import { READ_ONLY_CODE, READ_TOOLS, assignPlan, workspaceBilling, planLimitRefusal, agentLimitRefusal, projectLimitRefusal, countLiveAgents, countEnabledProjects, PLAN_LIMIT_CODE, UNGATED_UNITS } from "../src/billing.js";

/** Billing Phase 1 (board 425a2e9f): a lapsed workspace is READ-ONLY, not paused.
 *
 * The distinction is the whole test file. The kill switch (tests/kill-switch.test.ts) refuses reads as
 * well as writes, because "nothing runs" is its actual promise. Trial expiry promises something else:
 * "nothing is deleted, reads keep working, writes resume when you pay". So the assertion that carries
 * the design is not the 402 -- it is the 200 on the SAME key, in the SAME workspace, at the SAME
 * instant. Without it this suite would pass just as green on a second pause gate under a new name.
 */

const DAY_MS = 86_400_000;

let restServer: ReturnType<typeof app.listen>;
let base: string;
let mcpServer: http.Server;
let mcpUrl: URL;

beforeAll(async () => {
  restServer = app.listen(0);
  await new Promise((r) => restServer.once("listening", r));
  base = `http://127.0.0.1:${(restServer.address() as AddressInfo).port}`;
  // Mirrors the MCP wiring in src/index.ts: MCP never passes through the Express app, which is why
  // its enforcement is a per-tool guard rather than a middleware (see src/mcp.ts).
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
    coder: { id: coder.agentId, key: coder.apiKey },
    operator: { id: operator.agentId, key: operator.apiKey },
  };
}

/** Move the workspace's clock. This column IS what the enforcement path reads (src/billing.ts), so
 * setting it is setting the subject of the test, not routing around it. */
function setTrialEnd(orgId: string, at: number | null) {
  db.prepare(`UPDATE organizations SET trial_ends_at = ? WHERE id = ?`)
    .run(at === null ? null : new Date(at).toISOString(), orgId);
}

const trialEndOf = (orgId: string) =>
  (db.prepare(`SELECT trial_ends_at FROM organizations WHERE id = ?`).get(orgId) as { trial_ends_at: string | null }).trial_ends_at;

const call = (method: string, path: string, key: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const mcp = (key: string) => {
  const client = new Client({ name: "billing-test", version: "0.0.0" });
  return client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${key}` } } })).then(() => client);
};

describe("trial expiry boundary", () => {
  it("lapses at the instant the trial ends and not a millisecond before, with the length coming from the plan row", () => {
    const before = Date.now();
    const w = workspace("Billing Boundary");
    const after = Date.now();
    const endsAt = Date.parse(trialEndOf(w.orgId)!);

    // The trial length is the published one read from plans.trial_days, not a constant in the code --
    // changing the trial is a row update, which is the point of the table. This assertion now READS
    // that row instead of pinning a literal: it was written with 14 hard-coded, and when the operator
    // ruled the trial back to 7 days (migration 35) the test failed for a length that was correct,
    // which is the same defect one layer down -- a test that has its own copy of the number is just
    // another place the number can drift. The BOUNDARY behaviour below is what this test is for.
    const trialDays = (db.prepare(`SELECT trial_days FROM plans WHERE key = 'trial'`).get() as { trial_days: number }).trial_days;
    expect(endsAt).toBeGreaterThanOrEqual(before + trialDays * DAY_MS);
    expect(endsAt).toBeLessThanOrEqual(after + trialDays * DAY_MS);

    expect(workspaceBilling(w.orgId, endsAt - 1).readOnly, "1 ms before the end").toBe(false);
    expect(workspaceBilling(w.orgId, endsAt).readOnly, "exactly at the end").toBe(true);
    expect(workspaceBilling(w.orgId, endsAt + 1).readOnly, "1 ms after the end").toBe(true);
    expect(workspaceBilling(w.orgId, endsAt).reason).toContain(trialEndOf(w.orgId)!.slice(0, 10));
  });

  it("keeps serving reads on the same key while refusing writes -- the thing that makes this expiry and not a pause", async () => {
    const w = workspace("Billing Read Only");
    setTrialEnd(w.orgId, Date.now() - 1000);

    // Reads: 200, on the same key, at the same instant the write below is refused.
    const me = await call("GET", "/v1/me", w.coder.key);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { billing: { readOnly: boolean; plan: string; trialEndsAt: string | null } };
    expect(body.billing.readOnly).toBe(true);
    expect(body.billing.plan).toBe("trial");
    expect(body.billing.trialEndsAt).toBe(trialEndOf(w.orgId));
    expect((await call("GET", "/v1/tasks", w.coder.key)).status).toBe(200);
    expect((await call("GET", "/v1/messages", w.coder.key)).status).toBe(200);

    // Writes: refused with a body an agent can act on, not a bare 403.
    const refused = await call("POST", "/v1/messages", w.coder.key, { toAgent: "Operator", body: "still there?" });
    expect(refused.status).toBe(402);
    const error = (await refused.json()) as { error: string; code: string; readOnly: boolean };
    expect(error.code).toBe(READ_ONLY_CODE);
    expect(error.readOnly).toBe(true);
    expect(error.error).toContain("read-only");
    expect(error.error).toContain(trialEndOf(w.orgId)!.slice(0, 10));
    expect((await call("POST", "/v1/tasks", w.coder.key, { title: "late work" })).status).toBe(402);

    // The control that stops "always refuse" from passing this file: the same write SUCCEEDS while
    // the clock has not run out. Same workspace, same key, same route.
    const live = workspace("Billing Still Live");
    expect((await call("POST", "/v1/messages", live.coder.key, { toAgent: "Operator", body: "hello" })).status).toBe(201);
  });

  it("refuses a lapsed workspace's writes on the MCP path too, and keeps its reads working there", async () => {
    const w = workspace("Billing Mcp");
    setTrialEnd(w.orgId, Date.now() - 1000);
    const client = await mcp(w.coder.key);

    const read = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(read.isError ?? false).toBe(false);
    const write = await client.callTool({ name: "create_task", arguments: { title: "late work" } });
    expect(write.isError).toBe(true);
    const text = (write.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain(READ_ONLY_CODE);
    expect(text).toContain(trialEndOf(w.orgId)!.slice(0, 10));

    await client.close();
  });

  it("counts every registered tool as a read or leaves it refused -- no read tool name is a typo", async () => {
    const w = workspace("Billing Tool Names");
    const client = await mcp(w.coder.key);
    const { tools } = await client.listTools();
    const registered = new Set(tools.map((t) => t.name));
    // The predicate is deny-by-default, so a misspelled entry in READ_TOOLS costs a read tool
    // silently: it would just be refused on a lapsed workspace and nothing would say why. This is
    // that guard. It does not check the writes -- those are refused by design -- only that every
    // name claimed as a read is a tool that actually exists.
    expect([...READ_TOOLS].filter((name) => !registered.has(name))).toEqual([]);
    expect(registered.size).toBeGreaterThan(50);
    await client.close();
  });

  it("exempts an operator, so the person who has to put the workspace back on a plan can act", async () => {
    const w = workspace("Billing Operator");
    setTrialEnd(w.orgId, Date.now() - 1000);
    expect((await call("GET", "/v1/me", w.operator.key)).status).toBe(200);
    expect((await call("POST", "/v1/messages", w.operator.key, { toAgent: "Coder", body: "read this" })).status).toBe(201);
    // An agent in the same workspace at the same instant is still refused -- the exemption is the
    // operator's, not the workspace's.
    expect((await call("POST", "/v1/messages", w.coder.key, { toAgent: "Operator", body: "hi" })).status).toBe(402);
  });
});

describe("plans without a clock", () => {
  it("stays writable on a plan that has no trial, even with an expired date sitting on the row", () => {
    const w = workspace("Billing Non Expiring");
    // Both halves matter. The plan has no trial_days, so there is no clock; the date is deliberately
    // left EXPIRED to prove the predicate reads the plan and not the date. This is the structural
    // protection 9d1f ruled for: a later migration that expires rows by date cannot reach a workspace
    // on this plan, so the fleet's own workspace cannot be taken read-only by one.
    db.prepare(`UPDATE organizations SET plan = 'internal', trial_ends_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 30 * DAY_MS).toISOString(), w.orgId);
    expect(workspaceBilling(w.orgId).readOnly, "on day 30 of a plan with no trial").toBe(false);
  });

  it("stays writable at the API surface well past the trial length, on the same key", async () => {
    const w = workspace("Billing Non Expiring Api");
    db.prepare(`UPDATE organizations SET plan = 'internal', trial_ends_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 30 * DAY_MS).toISOString(), w.orgId);
    expect((await call("GET", "/v1/me", w.coder.key)).status).toBe(200);
    expect((await call("POST", "/v1/messages", w.coder.key, { toAgent: "Operator", body: "day 30" })).status).toBe(201);
  });

  it("reverses completely when the workspace is put back on a plan, keeping the same key", async () => {
    const w = workspace("Billing Reversal");
    setTrialEnd(w.orgId, Date.now() - 1000);
    expect((await call("POST", "/v1/messages", w.coder.key, { toAgent: "Operator", body: "refused" })).status).toBe(402);

    assignPlan(w.orgId, "pro");
    expect(trialEndOf(w.orgId)).toBeNull();
    expect(workspaceBilling(w.orgId).readOnly).toBe(false);
    expect((await call("POST", "/v1/messages", w.coder.key, { toAgent: "Operator", body: "resumed" })).status).toBe(201);
    // Nothing was deleted while it was read-only: the earlier reads and the timeline are still there.
    expect((await call("GET", "/v1/messages", w.coder.key)).status).toBe(200);
  });

  it("lapses a workspace whose subscription is no longer entitled, without a trial date to blame", () => {
    const w = workspace("Billing Lapsed Sub");
    setTrialEnd(w.orgId, null);
    db.prepare(`UPDATE organizations SET subscription_status = 'past_due' WHERE id = ?`).run(w.orgId);
    const billing = workspaceBilling(w.orgId);
    expect(billing.readOnly).toBe(true);
    expect(billing.reason).toContain("past_due");
  });
});

describe("a lapsed workspace adds no agents", () => {
  it("refuses bootstrap registration and device/agent connect codes, and leaves both usable", async () => {
    const { orgId, bootstrapKey } = createOrganization("Billing Provisioning");
    const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
    const created = await fetch(`${base}/v1/connect-codes`, {
      method: "POST", headers: { authorization: `Bearer ${operator.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ agentName: "Late-Agent", client: "cursor" }),
    });
    const { code } = (await created.json()) as { code: string };
    setTrialEnd(orgId, Date.now() - 1000);

    const register = await fetch(`${base}/v1/agents`, {
      method: "POST", headers: { authorization: `Bearer ${bootstrapKey}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Sneaky" }),
    });
    expect(register.status).toBe(402);

    const redeem = () => fetch(`${base}/v1/connect/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const refused = await redeem();
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: string }).error).toContain("read-only");

    // The code was not spent, so the exact same command works once a plan is added back.
    assignPlan(orgId, "pro");
    expect((await redeem()).status).toBe(201);
  });
});

// --- Plan limits (PRICING.md section 8 item 2) ----------------------------------------------------
//
// THE SUBJECT OF THESE TESTS IS A MECHANISM, NOT THE NUMBERS, and that distinction is the point of the
// shape rather than a caveat on it. `pro` and `team` carry NO caps today -- deliberately, because the
// live site sells them as "Unlimited agents" (see migration 32's comment) -- so a test that exercised
// "the Pro limit" would be exercising a NULL and would pass for the vacuous reason that nothing is
// capped. Every limits case below therefore reads plans that carry real numbers.
//
// What that proves: the mechanism engages when a plan carries numbers, and refuses with the right code,
// message and remedy. What it does NOT prove: that any particular number is correct. The numbers are the
// operator's pending decision (#430b), and a suite passing against a number the operator has not ruled on
// is not an argument for that number.
describe("plan limits refuse a new arrival with 402 and a remedy, and never touch what is running", () => {
  const trialLimits = () => workspaceBilling(workspace("Limits Probe").orgId).limits;

  it("treats a NULL limit as UNLIMITED and never refuses", () => {
    // The convention every limit column shares, and the one that would be catastrophic to invert: NULL is
    // not "unset" and not "zero", it is "no ceiling". Pro and Team are NULL on every unit today, so this
    // is also the assertion that proves those plans refuse nobody.
    const limits = trialLimits();
    const unlimited = { ...limits, key: "pro", name: "Pro", maxAgents: null, maxMachines: null, maxProjects: null, maxWorkspaces: null, maxWebhooks: null };
    for (const unit of ["machines", "agents", "projects", "workspaces", "webhooks"] as const) {
      expect(planLimitRefusal(unlimited, unit, 9_999, "https://app.example/app/")).toBeNull();
    }
  });

  it("refuses at the limit, not one past it", () => {
    // `>=`, not `>`: the caller is a new arrival asking to be added, and the count already includes
    // everyone present. A `>` would admit one over the cap on every plan.
    const limits = { ...trialLimits(), maxAgents: 10 };
    expect(planLimitRefusal(limits, "agents", 9, "u")).toBeNull();
    const at = planLimitRefusal(limits, "agents", 10, "u");
    expect(at).not.toBeNull();
    expect(at!.status).toBe(402);
    expect(at!.body.code).toBe(PLAN_LIMIT_CODE);
    expect(at!.body.limit).toBe("agents");
    expect(at!.body.allowed).toBe(10);
    expect(at!.body.used).toBe(10);
  });

  it("names the unit, the numbers and the remedy in the message an agent reads", () => {
    const limits = { ...trialLimits(), key: "pro", name: "Pro", maxProjects: 5 };
    const refusal = planLimitRefusal(limits, "projects", 5, "https://app.example/app/#upgrade")!;
    // The code is stable and machine-readable; the message is for the agent and must say what to do.
    expect(refusal.body.code).toBe("PLAN_LIMIT");
    expect(refusal.body.error).toContain("projects");
    expect(refusal.body.error).toContain("5");
    expect(refusal.body.error).toContain("Pro");
    expect(refusal.body.error).toContain("https://app.example/app/#upgrade");
    // The reassurance is load-bearing: this refuses a NEW arrival and nothing else, and an agent reading
    // only the code would otherwise assume its fleet is about to be cut.
    expect(refusal.body.error).toMatch(/nothing already running/i);
  });

  it("multiplies PER-SEAT limits by the seat count, and never by zero", () => {
    // Team stores 5 machines / 25 agents PER SEAT and pools them (PRICING.md section 2). A single-seat
    // plan is the same arithmetic with a multiplier of 1 -- unless the seat count comes back 0, which
    // must not zero the allowance and refuse everybody.
    const team = { ...trialLimits(), key: "team", name: "Team", maxAgents: 25, maxMachines: 5 };
    // AT one seat, 25 in use IS the cap -- refused, because the caller is a new arrival and the count
    // already includes the 25 present. This is the same ">= vs >" rule as the case above, and the
    // first version of this test got it WRONG by asserting null here; the code was right.
    expect(planLimitRefusal(team, "agents", 24, "u", 1)).toBeNull();
    expect(planLimitRefusal(team, "agents", 25, "u", 1)!.body.allowed).toBe(25);
    // TWO seats double the allowance, so the SAME 25 that was refused is now admitted: that is the
    // pooled-per-seat property, and nothing else in the suite demonstrates it.
    expect(planLimitRefusal(team, "agents", 25, "u", 2)).toBeNull();
    expect(planLimitRefusal(team, "agents", 50, "u", 2)!.body.allowed).toBe(50);
    const atThreeSeats = planLimitRefusal(team, "agents", 75, "u", 3);
    expect(atThreeSeats!.body.allowed).toBe(75);
    // A zero or nonsense seat count is floored at 1, not multiplied through.
    expect(planLimitRefusal(team, "agents", 25, "u", 0)!.body.allowed).toBe(25);
    expect(planLimitRefusal(team, "agents", 25, "u", -3)!.body.allowed).toBe(25);
    // A NON-per-seat limit is not multiplied, whatever the seats. Uses PROJECTS rather than workspaces,
    // because workspaces is in UNGATED_UNITS and would return null before reaching the multiplication --
    // the unit was chosen for being non-per-seat, and it has to be a GATED one to test that.
    const biz = { ...trialLimits(), key: "business", name: "Business", maxProjects: 7 };
    expect(planLimitRefusal(biz, "projects", 7, "u", 9)!.body.allowed).toBe(7);
  });

  it("counts LIVE agents and NOT the retired ones -- the rule that stops a drift nobody can clear", () => {
    // A LIMIT MUST NOT COUNT ROWS THE USER ALREADY RETIRED. `checkAgentName` lets a removed agent give up
    // its name, so the same chat can be re-registered -- a NEW id, with the retired row still present. A
    // counter that included removed rows would inflate forever and eventually refuse a workspace for
    // agents it cannot see, cannot use, and already removed.
    const { orgId } = createOrganization("Limits Retired");
    const a = registerAgent(orgId, "Live One");
    registerAgent(orgId, "Live Two");
    db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(new Date().toISOString(), a.agentId);
    expect(countLiveAgents(orgId)).toBe(1); // only the heartbeated one is live

    db.prepare(`UPDATE agents SET removed_at = ? WHERE id = ?`).run(new Date().toISOString(), a.agentId);
    expect(countLiveAgents(orgId)).toBe(0); // retired, so it stops counting even though it beat
  });

  it("does not count an agent whose heartbeat is OUTSIDE the presence window", () => {
    // PRICING.md section 2: "counts agents with a heartbeat in the last few minutes, not every agent ever
    // created" -- NOT org-usage's 30-day window. The boundary is the SAME constant the roster uses, so
    // the count and the screen cannot disagree.
    const { orgId } = createOrganization("Limits Window");
    const a = registerAgent(orgId, "Fresh");
    const b = registerAgent(orgId, "Stale");
    const now = Date.now();
    db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(new Date(now - 30_000).toISOString(), a.agentId);
    db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(new Date(now - HEARTBEAT_TTL_MS - 60_000).toISOString(), b.agentId);
    expect(countLiveAgents(orgId, now)).toBe(1);
    // A stopped agent is not live either: ended_at means the session is over, whatever its last beat was.
    db.prepare(`UPDATE agents SET ended_at = ? WHERE id = ?`).run(new Date().toISOString(), a.agentId);
    expect(countLiveAgents(orgId, now)).toBe(0);
  });

  it("counts ENABLED projects only, so the number matches what the console shows", () => {
    // Same rule, second unit: a disabled project is one the operator acted on, and its sessions are
    // already refused. Counting it would refuse a workspace for a project it cannot use and cannot clear.
    const { orgId } = createOrganization("Limits Projects");
    const insert = db.prepare(`INSERT INTO projects (org_id, project_key, name, enabled) VALUES (?, ?, ?, ?)`);
    insert.run(orgId, "alpha", "Alpha", 1);
    insert.run(orgId, "beta", "Beta", 1);
    insert.run(orgId, "gamma", "Gamma", 0);
    expect(countEnabledProjects(orgId)).toBe(2);
    db.prepare(`UPDATE projects SET enabled = 0 WHERE org_id = ? AND project_key = 'beta'`).run(orgId);
    expect(countEnabledProjects(orgId)).toBe(1);
    db.prepare(`UPDATE projects SET enabled = 1 WHERE org_id = ? AND project_key = 'gamma'`).run(orgId);
    expect(countEnabledProjects(orgId)).toBe(2);
  });

  // THE GUARD FIRED, AND THIS IS THE PR IT WAS WRITTEN FOR. It was added in the gates PR asserting pro and
  // team were UNCAPPED, with the comment "if a later PR fills those caps in, this test goes red and the
  // author has to read migration 32's comment about the live site before deciding what to do about it."
  // Migration 35 is that PR, and the guard did exactly its job: it stopped this from landing quietly.
  //
  // The decision it forced was taken by the operator (9d1f's ruling): the site publishes the limits, so the
  // caps are enforced. The test now asserts the opposite, keeping the history because the history is what a
  // future reader needs -- a cap is legitimate only while the page names it.
  it("ENFORCES pro and team's caps now that the pricing page publishes them", () => {
    // Per plan, because the two differ in exactly one unit and a shared loop would have hidden that:
    // Team's PROJECTS are unlimited (PRICING.md section 2), Pro's are capped at 5.
    const units: Record<string, readonly ("agents" | "projects" | "machines" | "webhooks")[]> = {
      pro: ["agents", "projects", "machines", "webhooks"],
      team: ["agents", "machines", "webhooks"], // no projects: unlimited on Team, asserted below
    };
    for (const plan of ["pro", "team"] as const) {
      const w = workspace(`Limits Capped ${plan}`);
      assignPlan(w.orgId, plan);
      const limits = workspaceBilling(w.orgId).limits;
      expect(limits.key).toBe(plan);
      // Every unit that now carries a number refuses at a large count. `machines` and `webhooks` have no
      // gate SITE yet, so nothing calls this for them in production today -- asserted here so that "no
      // caller yet" cannot be mistaken for "unlimited" when their gate lands.
      for (const unit of units[plan]) {
        expect(planLimitRefusal(limits, unit, 10_000, "u"), `${plan}/${unit}`).not.toBeNull();
      }
    }
    // Team's PROJECTS are genuinely UNLIMITED (NULL) -- the NULL-means-unlimited convention surviving
    // beside real caps, and the reason the loop above is per-plan rather than shared.
    const team = workspace("Limits Team Null");
    assignPlan(team.orgId, "team");
    expect(planLimitRefusal(workspaceBilling(team.orgId).limits, "projects", 10_000, "u")).toBeNull();
    // ...and Pro's are NOT unlimited, which is the contrast that makes the line above meaningful rather
    // than a coincidence of both plans being NULL.
    const pro = workspace("Limits Pro Capped");
    assignPlan(pro.orgId, "pro");
    expect(planLimitRefusal(workspaceBilling(pro.orgId).limits, "projects", 10_000, "u")).not.toBeNull();
  });
});

  // --- The GATES, on a CAPPED org (9d1f's ruling: enforce the trial caps) -----------------------------
  //
  // The cases above test the RULE with numbers handed in. These test that the rule is WIRED to the real
  // counts and the real plan row -- i.e. that a fresh workspace on the trial plan is actually refused at
  // its 11th live agent. Without these, `planLimitRefusal` could be correct and never called.
  describe("a workspace on a capped plan is refused at its limit, and the refusal is the one a caller can act on", () => {
    /** A fresh workspace, which is on the TRIAL plan -- the plan every real signup starts on, and the
     * only one that carries numbers today (pro/team/business are NULL by design). */
    const trialWorkspace = (name: string) => createOrganization(name);

    it("refuses the 11th agent and admits the 10th, using the real count and the real plan row", () => {
      const { orgId } = trialWorkspace("Gate Agents");
      // Trial allows 10 live agents (migration 32). Register 10 and keep them live by heartbeating each.
      const now = new Date().toISOString();
      for (let i = 1; i <= 10; i++) {
        const a = registerAgent(orgId, `Gate Agent ${i}`);
        db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(now, a.agentId);
      }
      expect(countLiveAgents(orgId)).toBe(10);
      expect(agentLimitRefusal(orgId, null), "10 of 10 is AT the limit, so the 11th is refused").not.toBeNull();
      const refused = agentLimitRefusal(orgId, null)!;
      expect(refused.status).toBe(402);
      expect(refused.body.code).toBe("PLAN_LIMIT");
      expect(refused.body.limit).toBe("agents");
      expect(refused.body.allowed).toBe(10);
      expect(refused.body.used).toBe(10);
      expect(refused.body.plan).toBe("trial");

      // Retiring one frees a slot -- which is the rule "a limit must not count rows the user retired",
      // proven through the GATE rather than the counter: the user does the thing the message implies and
      // the refusal goes away.
      db.prepare(`UPDATE agents SET removed_at = ? WHERE id = (SELECT id FROM agents WHERE org_id = ? AND removed_at IS NULL LIMIT 1)`).run(now, orgId);
      expect(countLiveAgents(orgId)).toBe(9);
      expect(agentLimitRefusal(orgId, null)).toBeNull();
    });

    it("does NOT refuse a workspace whose agents have stopped beating -- presence, not history", () => {
      // The counter's whole point: PRICING.md section 2 says "a heartbeat in the last few minutes, not
      // every agent ever created". Twelve agents that each beat a week ago are twelve ROWS and zero LIVE
      // agents, and this must not refuse. org-usage's 30-day window would say 12 and refuse.
      const { orgId } = trialWorkspace("Gate Stale");
      const longAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      for (let i = 1; i <= 12; i++) {
        const a = registerAgent(orgId, `Gate Stale ${i}`);
        db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(longAgo, a.agentId);
      }
      db.prepare(`UPDATE agents SET ended_at = ? WHERE org_id = ?`).run(new Date().toISOString(), orgId);
      expect(countLiveAgents(orgId)).toBe(0);
      expect(agentLimitRefusal(orgId, null)).toBeNull();
    });

    it("refuses the 4th project and admits the 3rd -- and a DISABLED project frees a slot", () => {
      const { orgId } = trialWorkspace("Gate Projects");
      const insert = db.prepare(`INSERT INTO projects (org_id, project_key, name, enabled) VALUES (?, ?, ?, ?)`);
      insert.run(orgId, "p1", "P1", 1);
      insert.run(orgId, "p2", "P2", 1);
      expect(projectLimitRefusal(orgId, null), "2 of 3").toBeNull();
      insert.run(orgId, "p3", "P3", 1);
      expect(countEnabledProjects(orgId)).toBe(3);
      expect(projectLimitRefusal(orgId, null), "3 of 3 is AT the limit").not.toBeNull();

      // The remedy in the message is real: disabling a project reduces the count, exactly as
      // PUT /v1/org/projects with enabled:false would.
      db.prepare(`UPDATE projects SET enabled = 0 WHERE org_id = ? AND project_key = 'p2'`).run(orgId);
      expect(countEnabledProjects(orgId)).toBe(2);
      expect(projectLimitRefusal(orgId, null), "disabling one frees a slot").toBeNull();
      // ...and a DISABLED project is not counted even though its row is still there -- retiring, not
      // deleting. Counting it would refuse a workspace for a project it cannot use or clear.
      insert.run(orgId, "p4", "P4", 1);
      expect(countEnabledProjects(orgId)).toBe(3);
      expect(projectLimitRefusal(orgId, null)).not.toBeNull();
    });

    it("refuses NOBODY on the internal plan, which is what every fixture and the fleet itself runs on", () => {
      // The regression guard for the ruling: `internal` is uncapped and non-expiring by design, so a
      // fixture promoted to it (as connect-cli now is) can never be refused by a limit.
      const { orgId } = trialWorkspace("Gate Internal");
      assignPlan(orgId, "internal");
      const now = new Date().toISOString();
      for (let i = 1; i <= 15; i++) {
        const a = registerAgent(orgId, `Internal Agent ${i}`);
        db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(now, a.agentId);
      }
      expect(countLiveAgents(orgId)).toBe(15);
      expect(agentLimitRefusal(orgId, null)).toBeNull();
      expect(projectLimitRefusal(orgId, null)).toBeNull();
    });

    it("refuses NOTHING for a unit in UNGATED_UNITS, even when its limit is ZERO", () => {
      // 1101's review note: UNGATED_UNITS was declared and never read, so the set DOCUMENTED the workspace
      // exclusion while the refusal path ignored it -- the first caller for `workspaces` would have enforced
      // it regardless. A constant that is written and not read is a comment with a type.
      //
      // maxWorkspaces = 0 is the strongest possible case: a cap that no workspace can satisfy, and on any
      // other unit it refuses at the first arrival. If the UNGATED_UNITS guard is removed this test fails
      // for every plan, which is what makes it a test of the guard rather than of the number.
      expect(UNGATED_UNITS.has("workspaces"), "workspaces is the unit this asserts about").toBe(true);
      const limits = { ...workspaceBilling(trialWorkspace("Ungated Probe").orgId).limits, maxWorkspaces: 0 };
      const refusal = planLimitRefusal(limits, "workspaces", 1, "u");
      expect(refusal, "an ungated unit must refuse nothing, whatever its stored limit").toBeNull();
      // The CONTROL, so the assertion above cannot pass for the vacuous reason that planLimitRefusal
      // refuses nothing at all: the same limits DO refuse a unit that is gated, at the same count.
      expect(planLimitRefusal({ ...limits, maxAgents: 0 }, "agents", 1, "u")).not.toBeNull();
    });

    it("does not refuse a GATED unit whose limit is NULL -- unlimited is not ungated", () => {
      // The other half, and the distinction worth keeping: exclusion-by-policy (UNGATED_UNITS) and
      // unlimited-by-value (NULL) are different reasons for the same outcome, and conflating them is how a
      // future change makes an ungated unit start refusing. `team`'s projects are NULL; they must stay
      // refusing nothing even if team's other units are capped.
      const limits = { ...workspaceBilling(trialWorkspace("Null Probe").orgId).limits, key: "team", name: "Team", maxProjects: null, maxAgents: 25 };
      expect(planLimitRefusal(limits, "projects", 10_000, "u")).toBeNull();
      expect(planLimitRefusal(limits, "agents", 10_000, "u")).not.toBeNull();
    });

    it("REFUSES the 4th project OVER THE REAL ROUTE -- PUT /v1/org/projects", async () => {
      // 1101 caught that projectLimitRefusal had six test references and ZERO production call sites: the
      // refusal existed, was tested, and nothing called it. So every test above, which calls the function
      // directly, would have stayed green with the feature completely unwired.
      //
      // THIS ONE GOES OVER HTTP, because that is the property the others cannot check: it fails if the gate
      // is removed from src/projects.ts even though all of them still pass.
      const { operator } = workspace("Gate Project Route");
      const enable = (projectKey: string) => call("PUT", "/v1/org/projects", operator.key, { projectKey, enabled: true });
      // Trial allows 3 enabled projects. Three succeed...
      expect((await enable("proj/a")).status).toBe(200);
      expect((await enable("proj/b")).status).toBe(200);
      expect((await enable("proj/c")).status).toBe(200);
      // ...the fourth is refused with 402 and a message naming the unit, not a bare 403 or a 500.
      const refused = await enable("proj/d");
      expect(refused.status).toBe(402);
      expect(((await refused.json()) as { error: string }).error).toContain("projects");
      // THE REMEDY WORKS over the same route: disabling one frees the slot and the same call succeeds.
      // That is what makes the message honest rather than merely polite.
      expect((await call("PUT", "/v1/org/projects", operator.key, { projectKey: "proj/b", enabled: false })).status).toBe(200);
      expect((await enable("proj/d")).status).toBe(200);
    });

    it("does NOT refuse a FIRST-SIGHT project -- a seen folder is not a project the workspace has", () => {
      // The other half of the placement, and the reason the gate is on the ENABLE path rather than on the
      // seen path: touchProject records a folder a chat was in with enabled = 0. That row is not counted by
      // countEnabledProjects, so gating it would refuse a machine for connecting with folders on it, against
      // a number the refusal never measured.
      const { orgId } = workspace("Gate Seen Projects");
      const insert = db.prepare(`INSERT INTO projects (org_id, project_key, name, enabled) VALUES (?, ?, ?, 0)`);
      for (let i = 0; i < 6; i++) insert.run(orgId, `seen/${i}`, `Seen ${i}`);
      expect(countEnabledProjects(orgId)).toBe(0);
      expect(projectLimitRefusal(orgId, null), "six SEEN projects consume no allowance").toBeNull();
    });

    it("names the remedy in the message when a URL is available, and names the operator when it is not", () => {
      // Two shapes, both real: a route has publicAppUrl(req); connect-code redemption has no request and
      // falls back to the configured env var, which is unset in tests. The message must never end in a
      // dangling clause pointing at nothing.
      const { orgId } = trialWorkspace("Gate Message");
      const now = new Date().toISOString();
      for (let i = 1; i <= 10; i++) {
        const a = registerAgent(orgId, `Msg Agent ${i}`);
        db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(now, a.agentId);
      }
      const withUrl = agentLimitRefusal(orgId, "https://app.example/app/#upgrade")!;
      expect(withUrl.body.error).toContain("https://app.example/app/#upgrade");
      const withoutUrl = agentLimitRefusal(orgId, null)!;
      expect(withoutUrl.body.error).not.toContain(": .");
      expect(withoutUrl.body.error).toMatch(/Ask the workspace operator/);
      expect(withoutUrl.body.upgradeUrl).toBeNull();
    });
  });
