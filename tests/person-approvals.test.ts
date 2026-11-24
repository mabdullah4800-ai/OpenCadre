// A PERSON decides clearances (docs/superpowers/plans/2026-09-30-person-approvals.md, finding Codex-OpenCadre-049a).
//
// Before this, `approval.decide` was granted to every agent: agent B could clear agent A's risky command, and a grant B
// created then auto-approved A's later requests. Every non-notifyOnly clearance is now `decider_kind = 'person'`, and
// only a signed-in person (the console session path) may decide it. Each refusal case below has its accepting control,
// so a test that passes because NOTHING can decide would fail its control.
//
// No supervisor designation ships in this PR (plan §4.1, Codex's ruling): no code path creates a 'supervisor' row, and
// the tests here only prove that nothing can create or decide one.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { createOrganization, getMessages, registerAgent } from "../src/service.js";
import {
  decideApproval, getApprovalById, listApprovalGrants, listApprovals, PERSON_REQUIRED_REFUSAL, requestApproval,
  resolveAllApprovalWaiters, waitForApproval,
} from "../src/approvals.js";
import { listEvents, verifyEventChain } from "../src/events.js";
import { MIGRATIONS } from "../src/migrations.js";
import { createDevice, redeemDeviceCode } from "../src/devices.js";
import { mcpRequest, extractToolCallText } from "../scripts/mcp-smoke-test.mjs";
import { startHub } from "./helpers/device-hub.js";
import { signInPerson } from "./helpers/person.js";
import { removeMember } from "../src/accounts.js";
import * as fx from "./helpers/oauth-fixtures.js";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

let hub: Awaited<ReturnType<typeof startHub>>;
beforeAll(async () => { hub = await startHub(); });
afterAll(async () => { await hub.close(); });

function workspace(name: string) {
  const { orgId } = createOrganization(name);
  db.prepare(`UPDATE organizations SET plan = 'internal', trial_ends_at = NULL WHERE id = ?`).run(orgId);
  const coder = registerAgent(orgId, "Coder");
  const reviewer = registerAgent(orgId, "Reviewer");
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  return {
    orgId,
    coder: { id: coder.agentId, name: "Coder", key: coder.apiKey },
    reviewer: { id: reviewer.agentId, name: "Reviewer", key: reviewer.apiKey },
    operator: { id: operator.agentId, name: "Operator", key: operator.apiKey },
  };
}

const row = (id: string) => db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as Record<string, unknown>;

const decideRest = (id: string, headers: Record<string, string>, body: Record<string, unknown>) =>
  fetch(`${hub.url}/v1/approvals/${id}/decide`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

async function mcpTool(key: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await mcpRequest(`${hub.url}/mcp`, key, "tools/call", { name, arguments: args });
  expect(res.ok, res.text).toBe(true);
  return extractToolCallText(res.data ?? {});
}

describe("a clearance is person-required by default", () => {
  it("every new clearance is decider_kind 'person'", async () => {
    const w = workspace("PA Default");
    const a = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./src", risk: "high" });
    expect(a.decider_kind).toBe("person");
    expect(row(a.id).decider_kind).toBe("person");
  });

  it("nothing the requester sends can weaken it: extra REST body fields are ignored", async () => {
    const w = workspace("PA Weaken");
    const res = await fetch(`${hub.url}/v1/approvals`, {
      method: "POST", headers: { ...bearer(w.coder.key), "content-type": "application/json" },
      body: JSON.stringify({
        action: "git push --force origin main", category: "supervisor", approver: "Reviewer",
        decider_kind: "supervisor", deciderKind: "supervisor", supervisor: true, requiresPerson: false, origin: "supervisor",
      }),
    });
    expect(res.status).toBe(201);
    const { approval } = await res.json();
    expect(row(approval.id).decider_kind).toBe("person");
    // And the named approver, an agent, still cannot decide it.
    expect((await decideRest(approval.id, bearer(w.reviewer.key), { decision: "approve" })).status).toBe(403);
    expect(row(approval.id).status).toBe("pending");
  });

  it("nothing the requester sends can weaken it: extra arguments to requestApproval are ignored", async () => {
    const w = workspace("PA Weaken Direct");
    const a = await requestApproval(w.orgId, w.coder, { action: "npm publish", approver: "Reviewer", ...{ deciderKind: "supervisor", supervisor: true } } as never);
    expect(row(a.id).decider_kind).toBe("person");
  });

  it("the database refuses a 'supervisor' row, and refuses relabelling a row, while no designation exists", async () => {
    const w = workspace("PA Guard");
    const a = await requestApproval(w.orgId, w.coder, { action: "terraform destroy" });
    expect(() => db.prepare(
      `INSERT INTO approvals (id, org_id, requested_by_agent_id, requested_by_agent_name, action, risk, status, expires_at, decider_kind)
       VALUES ('sup-1', ?, ?, 'Coder', 'x', 'low', 'pending', '2999-01-01T00:00:00.000Z', 'supervisor')`,
    ).run(w.orgId, w.coder.id)).toThrow(/supervisor/);
    expect(() => db.prepare(`UPDATE approvals SET decider_kind = 'supervisor' WHERE id = ?`).run(a.id)).toThrow(/decider_kind/);
    expect(row(a.id).decider_kind).toBe("person");
  });

  it("the approver's notice says a person decides it in OpenCadre, not decide_approval", async () => {
    const w = workspace("PA Notice");
    await requestApproval(w.orgId, w.coder, { action: "kubectl delete ns prod", approver: "Reviewer" });
    const [notice] = getMessages(w.orgId, w.reviewer.id);
    expect(notice.body).not.toMatch(/decide with decide_approval/);
    expect(notice.body).toMatch(/a person decides/i);
  });
});

describe("only a signed-in person decides a person row", () => {
  it("REST: an agent key and an operator key are refused with 403; a person session decides it and is recorded", async () => {
    const w = workspace("PA REST");
    const a = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./build", risk: "high" });
    for (const key of [w.reviewer.key, w.operator.key]) {
      const refused = await decideRest(a.id, bearer(key), { decision: "approve" });
      expect(refused.status).toBe(403);
      expect((await refused.json()).error).toBe(PERSON_REQUIRED_REFUSAL);
      expect(row(a.id).status).toBe("pending");
    }
    // The requester itself: refused too.
    expect((await decideRest(a.id, bearer(w.coder.key), { decision: "approve" })).status).toBe(403);

    const ada = await signInPerson(w.orgId, "Ada");
    const ok = await decideRest(a.id, ada.headers, { decision: "approve", note: "fine" });
    expect(ok.status).toBe(200);
    const decided = row(a.id);
    expect(decided).toMatchObject({
      status: "approved", decided_by_person_id: ada.personId, decided_by_person_name: "Ada", decided_via: "console",
    });
    const event = listEvents(w.orgId).find((e) => e.type === "approval.decided" && e.subject_id === a.id)!;
    expect(JSON.parse(event.payload)).toMatchObject({ decision: "approve", byPerson: true });
    expect(event.payload).not.toContain(ada.personId);
  });

  it("MCP: decide_approval on a person row returns the refusal text and the row stays pending", async () => {
    const w = workspace("PA MCP");
    const a = await requestApproval(w.orgId, w.coder, { action: "git push --force", risk: "high" });
    for (const key of [w.reviewer.key, w.operator.key]) {
      const said = await mcpTool(key, "decide_approval", { approvalId: a.id, decision: "approve" });
      expect(said).toContain(PERSON_REQUIRED_REFUSAL);
      expect(row(a.id).status).toBe("pending");
    }
  });

  it("in-process: decideApproval with no person is refused; with the person it succeeds", async () => {
    const w = workspace("PA Direct");
    const a = await requestApproval(w.orgId, w.coder, { action: "drop table users" });
    const refused = decideApproval(w.orgId, w.operator, a.id, "approve");
    expect(refused).toMatchObject({ ok: false, error: PERSON_REQUIRED_REFUSAL });
    const ada = await signInPerson(w.orgId, "Ada");
    expect(decideApproval(w.orgId, ada.decider, a.id, "deny", "no").ok).toBe(true);
    expect(row(a.id)).toMatchObject({ status: "denied", decided_by_person_id: ada.personId });
  });

  it("in-process: a person claimed for a workspace they do not belong to is refused", async () => {
    const w = workspace("PA Foreign Direct");
    const other = workspace("PA Foreign Other");
    const stranger = await signInPerson(other.orgId, "Stranger");
    const a = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./x" });
    // The stranger's person, riding on an agent of this workspace: the membership does not match.
    const r = decideApproval(w.orgId, { ...w.operator, person: stranger.decider.person }, a.id, "approve");
    expect(r.ok).toBe(false);
    expect(row(a.id).status).toBe("pending");
  });

  it("a device (dev_) caller is refused; a person decides the same row", async () => {
    const w = workspace("PA Device");
    const key = "github.com/example/pa-device";
    db.prepare(`INSERT INTO projects (org_id, project_key, name, enabled, enabled_at) VALUES (?, ?, 'pa-device', 1, ?)`).run(w.orgId, key, new Date().toISOString());
    const { code } = createDevice(w.orgId, w.operator, "PA laptop", "claude-code");
    const redeemed = redeemDeviceCode(code);
    if (!redeemed.ok || !redeemed.deviceCredential) throw new Error("redeem failed");
    const dev = (session: string) => ({
      ...bearer(redeemed.deviceCredential!), "x-opencadre-session": session, "x-opencadre-project": key, "x-opencadre-project-name": "pa-device",
    });
    const created = await fetch(`${hub.url}/v1/approvals`, {
      method: "POST", headers: { ...dev("chat-requester"), "content-type": "application/json" }, body: JSON.stringify({ action: "rm -rf ./dist-prod" }),
    });
    expect(created.status).toBe(201);
    const { approval } = await created.json();
    const refused = await decideRest(approval.id, dev("chat-other"), { decision: "approve" });
    expect(refused.status).toBe(403);
    expect(row(approval.id).status).toBe("pending");
    const ada = await signInPerson(w.orgId, "Ada");
    expect((await decideRest(approval.id, ada.headers, { decision: "approve" })).status).toBe(200);
  });

  it("an OAuth connector token (model-driven, though a person approved the connection) is refused", async () => {
    const before = process.env.OPENCADRE_OAUTH;
    process.env.OPENCADRE_OAUTH = "on";
    try {
      const { issueTokenFamily, mcpResource } = await import("../src/oauth.js");
      const owner = fx.person("Owner");
      const orgId = fx.workspace(owner, { plan: "internal" });
      const coder = registerAgent(orgId, "Coder");
      const conn = registerAgent(orgId, "Connector");
      db.prepare(`INSERT INTO oauth_grants (grant_id, person_id, client_id, org_id, scope_key, agent_id, created_at) VALUES ('g-pa', ?, 'dcr_pa', ?, '*', ?, ?)`)
        .run(owner, orgId, conn.agentId, new Date().toISOString());
      const pair = issueTokenFamily({ clientId: "dcr_pa", orgId, agentId: conn.agentId, personId: owner, resource: mcpResource(), grantId: "g-pa" });
      const a = await requestApproval(orgId, { id: coder.agentId, name: "Coder" }, { action: "npm publish" });
      // Control: the token works on /mcp at all (a refusal for any other reason would prove nothing).
      expect(await mcpTool(pair.accessToken, "list_approvals", {})).toContain(a.id);
      const said = await mcpTool(pair.accessToken, "decide_approval", { approvalId: a.id, decision: "approve" });
      expect(said).toContain(PERSON_REQUIRED_REFUSAL);
      expect(row(a.id).status).toBe("pending");
    } finally {
      if (before === undefined) delete process.env.OPENCADRE_OAUTH; else process.env.OPENCADRE_OAUTH = before;
    }
  });

  it("a person from another workspace is refused (403 with this workspace's header, 404 with their own)", async () => {
    const w = workspace("PA Cross");
    const other = workspace("PA Cross Other");
    const stranger = await signInPerson(other.orgId, "Stranger");
    const a = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./y" });
    expect((await decideRest(a.id, { ...stranger.headers, "x-opencadre-workspace": w.orgId }, { decision: "approve" })).status).toBe(403);
    expect((await decideRest(a.id, stranger.headers, { decision: "approve" })).status).toBe(404);
    expect(row(a.id).status).toBe("pending");
  });

  // Precedence, pinned (security review of #653): a bearer always wins over a cookie (requireAgentAuth), so an agent that
  // also carries a person's cookie is still an agent, and a bad bearer is never "rescued" by a cookie.
  it("an agent bearer plus a person's cookie is the agent: 403, still pending; a garbage bearer plus a cookie is 401", async () => {
    const w = workspace("PA Bearer Wins");
    const ada = await signInPerson(w.orgId, "Ada");
    const a = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./mixed" });
    const both = await decideRest(a.id, { ...ada.headers, ...bearer(w.reviewer.key) }, { decision: "approve" });
    expect(both.status).toBe(403);
    expect((await both.json()).error).toBe(PERSON_REQUIRED_REFUSAL);
    expect(row(a.id).status).toBe("pending");
    const garbage = await decideRest(a.id, { ...ada.headers, authorization: "Bearer not-a-real-key" }, { decision: "approve" });
    expect(garbage.status).toBe(401);
    expect(row(a.id).status).toBe("pending");
    // Control: the cookie alone decides it.
    expect((await decideRest(a.id, ada.headers, { decision: "approve" })).status).toBe(200);
  });

  it("four eyes: a person cannot decide a request their own member agent made", async () => {
    const w = workspace("PA Four Eyes");
    const ada = await signInPerson(w.orgId, "Ada");
    const bob = await signInPerson(w.orgId, "Bob");
    const created = await fetch(`${hub.url}/v1/approvals`, { method: "POST", headers: ada.headers, body: JSON.stringify({ action: "rm -rf ./ada-asked" }) });
    expect(created.status).toBe(201);
    const { approval } = await created.json();
    expect(row(approval.id).requested_by_agent_id).toBe(ada.decider.id);
    const self = await decideRest(approval.id, ada.headers, { decision: "approve" });
    expect(self.status).toBe(409);
    expect((await self.json()).error).toBe("The requesting agent can't decide its own approval request");
    expect(decideApproval(w.orgId, ada.decider, approval.id, "approve")).toMatchObject({ ok: false, error: "The requesting agent can't decide its own approval request" });
    expect(row(approval.id).status).toBe("pending");
    // Control: another person decides it.
    expect((await decideRest(approval.id, bob.headers, { decision: "approve" })).status).toBe(200);
  });

  it("a stale or replayed decide on an already-decided row is refused and changes nothing", async () => {
    const w = workspace("PA Replay");
    const a = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./z" });
    const ada = await signInPerson(w.orgId, "Ada");
    const bob = await signInPerson(w.orgId, "Bob");
    expect((await decideRest(a.id, ada.headers, { decision: "deny", note: "no" })).status).toBe(200);
    const replay = await decideRest(a.id, ada.headers, { decision: "deny", note: "no" });
    expect(replay.status).toBe(409);
    const flip = await decideRest(a.id, bob.headers, { decision: "approve" });
    expect(flip.status).toBe(409);
    expect(row(a.id)).toMatchObject({ status: "denied", decided_by_person_id: ada.personId, decided_by_person_name: "Ada" });
    // The person columns are write-once in the database too.
    expect(() => db.prepare(`UPDATE approvals SET decided_by_person_id = ? WHERE id = ?`).run(bob.personId, a.id)).toThrow(/write-once/);
    // An expired row cannot be decided either.
    const late = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./late", expiresInSeconds: 0.05 });
    await new Promise((r) => setTimeout(r, 80));
    expect((await decideRest(late.id, ada.headers, { decision: "approve" })).status).toBe(409);
    expect(row(late.id).status).toBe("expired");
  });

  it("a lapsed workspace: a member-role person is refused on the billing read-only path, and so is an agent key", async () => {
    const w = workspace("PA Lapsed");
    const a = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./lapsed" });
    const member = await signInPerson(w.orgId, "Mem", "member");
    db.prepare(`UPDATE organizations SET plan = 'trial', trial_ends_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), w.orgId);
    const refused = await decideRest(a.id, member.headers, { decision: "approve" });
    expect(refused.status).toBe(402);
    expect((await decideRest(a.id, bearer(w.reviewer.key), { decision: "approve" })).status).toBe(402);
    expect(row(a.id).status).toBe("pending");
    // Control: the same person decides once the workspace is on a plan again.
    db.prepare(`UPDATE organizations SET plan = 'internal', trial_ends_at = NULL WHERE id = ?`).run(w.orgId);
    expect((await decideRest(a.id, member.headers, { decision: "approve" })).status).toBe(200);
  });

  // EXISTING POLICY, pinned here on purpose (accepted by Codex on #653): readOnlyRefusal exempts operator-role callers,
  // so an owner or admin PERSON can still decide in a lapsed workspace. What a lapsed bill must never do is let an AGENT
  // decide -- including an operator agent key, which the person rule refuses before billing is consulted.
  it("a lapsed workspace: an owner or admin person may still decide (operators are exempt from read-only); an operator agent key may not", async () => {
    const w = workspace("PA Lapsed Owner");
    const owner = await signInPerson(w.orgId, "Owner", "owner");
    const admin = await signInPerson(w.orgId, "Admin", "admin");
    const a = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./lapsed-owner" });
    const b = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./lapsed-admin" });
    db.prepare(`UPDATE organizations SET plan = 'trial', trial_ends_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), w.orgId);
    const operatorKey = await decideRest(a.id, bearer(w.operator.key), { decision: "approve" });
    expect(operatorKey.status).toBe(403);
    expect((await operatorKey.json()).error).toBe(PERSON_REQUIRED_REFUSAL);
    expect((await decideRest(a.id, owner.headers, { decision: "approve" })).status).toBe(200);
    expect((await decideRest(b.id, admin.headers, { decision: "deny" })).status).toBe(200);
    expect(row(a.id)).toMatchObject({ status: "approved", decided_by_person_id: owner.personId });
    expect(row(b.id)).toMatchObject({ status: "denied", decided_by_person_id: admin.personId });
  });
});

// Codex launch blocker (P1, #653): MCP text is what models (and the DeepSeek guard, before) read. A person-less approved
// row must never be rendered as an actionable "[APPROVED]", and the structured record says who decided.
describe("MCP approval results: never an actionable APPROVED without a person", () => {
  it("a person-less approved row reads NOT CLEARED; a person-approved row reads APPROVED; both carry the structured record", async () => {
    const w = workspace("PA MCP Render");
    const legacy = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./legacy-row" });
    db.prepare(`UPDATE approvals SET status = 'approved', decided_by_agent_id = ?, decided_by_agent_name = 'Reviewer', decided_at = datetime('now') WHERE id = ?`)
      .run(w.reviewer.id, legacy.id);
    const cleared = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./person-row" });
    const ada = await signInPerson(w.orgId, "Ada");
    expect(decideApproval(w.orgId, ada.decider, cleared.id, "approve").ok).toBe(true);

    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await mcpRequest(`${hub.url}/mcp`, w.coder.key, "tools/call", { name, arguments: args });
      return { text: extractToolCallText(res.data ?? {}), structured: res.data?.result?.structuredContent };
    };
    const old = await call("wait_for_approval", { approvalId: legacy.id, waitSeconds: 1 });
    expect(old.text).toMatch(/^\[NOT CLEARED\]/);
    expect(old.text).not.toMatch(/\[APPROVED\]/);
    expect(old.structured.approval).toMatchObject({ id: legacy.id, status: "approved", decided_by_person_id: null, decider_kind: "person" });
    const ok = await call("wait_for_approval", { approvalId: cleared.id, waitSeconds: 1 });
    expect(ok.text).toMatch(/^\[APPROVED\] .* by Ada/);
    expect(ok.structured.approval).toMatchObject({ id: cleared.id, status: "approved", decided_by_person_id: ada.personId, decided_via: "console" });
    const listed = (await call("list_approvals", {})).text;
    expect(listed).toMatch(new RegExp(`\\[NOT CLEARED\\][^\\n]*${legacy.id}`));
    expect(listed).not.toMatch(new RegExp(`\\[APPROVED\\][^\\n]*${legacy.id}`));
    // request_approval's first response carries the record too (here: pending, no person).
    const fresh = await call("request_approval", { action: "rm -rf ./fresh", waitSeconds: 0 });
    expect(fresh.structured.approval).toMatchObject({ status: "pending", decided_by_person_id: null });
  });
});

describe("grants are bounded and carry the person", () => {
  it("removing a person revokes their grants; historical orphan grants cannot approve either", async () => {
    const w = workspace("PA Removed Grant");
    const owner = await signInPerson(w.orgId, "Owner");
    const member = await signInPerson(w.orgId, "Member", "member");
    const ask = () => requestApproval(w.orgId, w.coder, { action: "docker system prune -af", category: "docker-prune" });
    const first = await ask();
    expect(decideApproval(w.orgId, member.decider, first.id, "approve", null, { grantMinutes: 30 }).ok).toBe(true);
    expect((await ask()).status).toBe("approved");
    removeMember(w.orgId, { id: owner.decider.id, name: owner.name, memberRole: "owner", personId: owner.personId }, member.personId);
    expect(listApprovalGrants(w.orgId)).toHaveLength(0);
    expect((await ask()).status).toBe("pending");
    // A stale row left by an older hub must not resurrect their authority.
    db.prepare(`INSERT INTO approval_grants (id, org_id, agent_id, agent_name, category, granted_by_agent_id,
      granted_by_agent_name, expires_at, project_key, granted_by_person_id, granted_by_person_name)
      VALUES ('orphan-grant', ?, ?, 'Coder', 'docker-prune', ?, 'Member', ?, NULL, ?, 'Member')`)
      .run(w.orgId, w.coder.id, member.decider.id, new Date(Date.now() + 60_000).toISOString(), member.personId);
    expect((await ask()).status).toBe("pending");
    const pending = await ask();
    expect(decideApproval(w.orgId, owner.decider, pending.id, "approve", null, { grantMinutes: 30 }).ok).toBe(true);
    expect((await ask()).status).toBe("approved");
  });
  it("a person's grant auto-approves only the same requester, project and category, before expiry", async () => {
    const w = workspace("PA Grant");
    const ada = await signInPerson(w.orgId, "Ada");
    const first = await requestApproval(w.orgId, w.coder, { action: "docker system prune -af", category: "docker-prune" });
    const decided = decideApproval(w.orgId, ada.decider, first.id, "approve", null, { grantMinutes: 30 });
    if (!decided.ok) throw new Error(decided.error);
    expect(decided.grant).toMatchObject({ granted_by_person_id: ada.personId, granted_by_person_name: "Ada" });

    const same = await requestApproval(w.orgId, w.coder, { action: "docker volume rm cache", category: "docker-prune" });
    expect(same.status).toBe("approved");
    expect(row(same.id)).toMatchObject({ decided_by_person_id: ada.personId, decided_by_person_name: "Ada", decided_via: "grant" });
    const viaGrant = listEvents(w.orgId).find((e) => e.type === "approval.decided" && e.subject_id === same.id)!;
    expect(JSON.parse(viaGrant.payload)).toMatchObject({ viaGrant: true, byPerson: true });

    expect((await requestApproval(w.orgId, w.coder, { action: "rm -rf ./a", category: "rm-rf" })).status).toBe("pending");
    expect((await requestApproval(w.orgId, w.reviewer, { action: "docker volume rm x", category: "docker-prune" })).status).toBe("pending");
    // Same agent and category, another project: not covered.
    db.prepare(`UPDATE agents SET project = 'github.com/example/elsewhere', home_project = 'github.com/example/elsewhere' WHERE id = ?`).run(w.coder.id);
    const elsewhere = await requestApproval(w.orgId, w.coder, { action: "docker volume rm y", category: "docker-prune" });
    expect(elsewhere.project_key).not.toBe(first.project_key);
    expect(elsewhere.status).toBe("pending");
    db.prepare(`UPDATE agents SET project = NULL, home_project = NULL WHERE id = ?`).run(w.coder.id);
    // Expired: not covered.
    db.prepare(`UPDATE approval_grants SET expires_at = ? WHERE org_id = ?`).run(new Date(Date.now() - 1000).toISOString(), w.orgId);
    expect((await requestApproval(w.orgId, w.coder, { action: "docker volume rm z", category: "docker-prune" })).status).toBe("pending");
  });

  it("a grant with no person provenance never auto-approves a person row", async () => {
    const w = workspace("PA Legacy Grant");
    db.prepare(
      `INSERT INTO approval_grants (id, org_id, agent_id, agent_name, category, granted_by_agent_id, granted_by_agent_name, expires_at, project_key)
       VALUES ('legacy-g', ?, ?, 'Coder', 'rm-rf', ?, 'Reviewer', ?, NULL)`,
    ).run(w.orgId, w.coder.id, w.reviewer.id, new Date(Date.now() + 3_600_000).toISOString());
    const a = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./old", category: "rm-rf" });
    expect(a.status).toBe("pending");
  });

  it("an agent cannot mint a grant: its decide with grantMinutes is refused and no grant appears", async () => {
    const w = workspace("PA Agent Grant");
    const a = await requestApproval(w.orgId, w.coder, { action: "terraform apply", category: "terraform" });
    expect((await decideRest(a.id, bearer(w.reviewer.key), { decision: "approve", grantMinutes: 60 })).status).toBe(403);
    expect(listApprovalGrants(w.orgId)).toEqual([]);
  });

  it("agents keep revoke: revoking only removes permission", async () => {
    const w = workspace("PA Revoke");
    const ada = await signInPerson(w.orgId, "Ada");
    const a = await requestApproval(w.orgId, w.coder, { action: "docker system prune", category: "docker-prune" });
    const d = decideApproval(w.orgId, ada.decider, a.id, "approve", null, { grantMinutes: 10 });
    if (!d.ok || !d.grant) throw new Error("no grant");
    const res = await fetch(`${hub.url}/v1/approval-grants/${d.grant.id}`, { method: "DELETE", headers: bearer(w.reviewer.key) });
    expect(res.status).toBe(200);
    expect(listApprovalGrants(w.orgId)).toEqual([]);
  });
});

describe("notifications are not clearances", () => {
  it("notifyOnly still yields 'noted', and a noted row never releases a waiting clearance", async () => {
    const w = workspace("PA Noted");
    const pending = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./keep", category: "rm-rf", expiresInSeconds: 60 });
    const waiting = waitForApproval(w.orgId, pending.id, 1);
    const noted = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./keep", category: "rm-rf", notifyOnly: true });
    expect(noted.status).toBe("noted");
    // A noted row is not decidable, by anyone.
    const ada = await signInPerson(w.orgId, "Ada");
    expect(decideApproval(w.orgId, ada.decider, noted.id, "approve").ok).toBe(false);
    expect((await waiting)!.status).toBe("pending");
    expect(getApprovalById(w.orgId, pending.id)!.status).toBe("pending");
  });
});

describe("migration 53", () => {
  it("leaves pending rows person-required and revokes every grant with no person provenance, on the timeline", async () => {
    const w = workspace("PA Migration");
    const a = await requestApproval(w.orgId, w.coder, { action: "rm -rf ./m", category: "rm-rf" });
    const ada = await signInPerson(w.orgId, "Ada");
    const b = await requestApproval(w.orgId, w.coder, { action: "docker system prune", category: "docker-prune" });
    const kept = decideApproval(w.orgId, ada.decider, b.id, "approve", null, { grantMinutes: 30 });
    if (!kept.ok || !kept.grant) throw new Error("no grant");
    for (const id of ["m-legacy-1", "m-legacy-2"]) {
      db.prepare(
        `INSERT INTO approval_grants (id, org_id, agent_id, agent_name, category, granted_by_agent_id, granted_by_agent_name, expires_at, project_key)
         VALUES (?, ?, ?, 'Coder', 'rm-rf', ?, 'Reviewer', ?, NULL)`,
      ).run(id, w.orgId, w.coder.id, w.reviewer.id, new Date(Date.now() + 3_600_000).toISOString());
    }
    const migration = MIGRATIONS.find((m) => m.version === 53)!;
    expect(migration).toBeDefined();
    migration.up(db);
    migration.up(db); // idempotent

    expect(row(a.id)).toMatchObject({ status: "pending", decider_kind: "person" });
    expect(listApprovalGrants(w.orgId).map((g) => g.id)).toEqual([kept.grant.id]);
    const revoked = listEvents(w.orgId).filter((e) => e.type === "approval.grant_revoked").map((e) => e.subject_id).sort();
    expect(revoked).toEqual(["m-legacy-1", "m-legacy-2"]);
    const event = listEvents(w.orgId).find((e) => e.subject_id === "m-legacy-1")!;
    expect(event.target_agent_id).toBe(w.coder.id);
    expect(verifyEventChain(w.orgId)).toEqual({ ok: true });
  });
});

// The approval gate hook. A clearance passes only on a PERSON's decision: an "approved" row with no person (decided by an
// agent before migration 53, or sent by a hub older than the hook -- a rollback or a mixed-version fleet) FAILS CLOSED on
// every client dialect, and is never called "approved". `byPerson` (Cursor turns a byPerson allow into its own
// permission) is true only for a person's decision. Each client has both arms: a person-approved row passes, a
// person-less approved row blocks.
describe("approval gate: only a person's approval lets a held command run", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");
  type Client = "claude-code" | "codex" | "cursor";
  const CLIENTS: Client[] = ["claude-code", "codex", "cursor"];

  function runGate(client: Client, command: string, env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
    const cwd = mkdtempSync(path.join(tmpdir(), "pa-gate-"));
    const args = client === "claude-code" ? [HOOK] : [HOOK, "--client", client];
    const payload = client === "cursor"
      ? { hook_event_name: "beforeShellExecution", conversation_id: "pa-conv", command, cwd, workspace_roots: [cwd] }
      : client === "codex"
        ? { hook_event_name: "PreToolUse", tool_name: "exec_command", tool_input: { cmd: command }, session_id: "pa-codex", cwd }
        : { tool_name: "Bash", tool_input: { command }, cwd };
    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        env: { ...process.env, ...GATE_TEST_ENV, HOME: cwd, USERPROFILE: cwd, OPENCADRE_HOOK_HOME: cwd, OPENCADRE_GATE_MODE: "ask", OPENCADRE_APPROVAL_WAIT: "20", ...env },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
      child.stdin.end(JSON.stringify(payload));
    });
  }
  /** The client's verdict and the text it shows, from each dialect's own shape. */
  function verdict(client: Client, out: string): { decision: string; text: string } {
    const o = JSON.parse(out);
    if (client === "cursor") return { decision: o.permission ?? "no opinion", text: `${o.user_message ?? ""} ${o.agent_message ?? ""}` };
    return { decision: o.hookSpecificOutput.permissionDecision, text: o.hookSpecificOutput.permissionDecisionReason ?? "" };
  }
  async function pendingIn(orgId: string) {
    for (let i = 0; i < 200; i++) {
      const [p] = listApprovals(orgId, { status: "pending" });
      if (p) return p;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the gate never asked");
  }
  const PERSONLESS = /did not come from a person, or your OpenCadre hub is older than this hook/;

  for (const client of CLIENTS) {
    it(`${client}: a person's approval lets it run, naming the person`, async () => {
      const w = workspace(`PA Gate Person ${client}`);
      const run = runGate(client, "rm -rf ./src", { OPENCADRE_URL: hub.url, OPENCADRE_KEY: w.coder.key });
      const p = await pendingIn(w.orgId);
      const ada = await signInPerson(w.orgId, "Ada");
      expect(decideApproval(w.orgId, ada.decider, p.id, "approve", "ok").ok).toBe(true);
      const r = await run;
      expect(verdict(client, r.out)).toEqual({ decision: "allow", text: expect.stringMatching(/Approved in OpenCadre by Ada: ok/) });
    });

    it(`${client}: an approved row no person decided (legacy or agent decision) is DENIED, never called approved`, async () => {
      const w = workspace(`PA Gate Agent ${client}`);
      const run = runGate(client, "rm -rf ./src", { OPENCADRE_URL: hub.url, OPENCADRE_KEY: w.coder.key });
      const p = await pendingIn(w.orgId);
      // Written the way a pre-migration agent decision sits in the table: approved, an agent named, no person.
      db.prepare(`UPDATE approvals SET status = 'approved', decided_by_agent_id = ?, decided_by_agent_name = 'Reviewer', decided_at = datetime('now') WHERE id = ?`)
        .run(w.reviewer.id, p.id);
      resolveAllApprovalWaiters();
      const r = await run;
      const v = verdict(client, r.out);
      expect(v.decision).toBe("deny");
      expect(v.text).toMatch(PERSONLESS);
      expect(`${r.out} ${r.err}`).not.toMatch(/approved in OpenCadre/i);
    });

    it(`${client}: a hub older than the hook (an approved answer with no person fields at all) is DENIED`, async () => {
      const old = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          const at = (req.url ?? "").split("?")[0];
          res.setHeader("content-type", "application/json");
          if (at === "/v1/clearance-policy") return res.end(JSON.stringify({ policy: { mode: "ask" } }));
          if (at === "/v1/approvals") {
            return res.writeHead(201).end(JSON.stringify({ approval: { id: "old-1", status: "approved", decided_by_agent_name: "Reviewer", decision_note: null } }));
          }
          res.end("{}");
        });
      });
      await new Promise<void>((resolve) => old.listen(0, resolve));
      try {
        const url = `http://127.0.0.1:${(old.address() as { port: number }).port}`;
        for (const mode of ["ask", "strict"]) {
          const r = await runGate(client, "rm -rf ./src", { OPENCADRE_URL: url, OPENCADRE_KEY: "test-key", OPENCADRE_GATE_MODE: mode });
          const v = verdict(client, r.out);
          expect(v.decision, mode).toBe("deny");
          expect(v.text, mode).toMatch(PERSONLESS);
          expect(`${r.out} ${r.err}`, mode).not.toMatch(/approved in OpenCadre/i);
        }
      } finally {
        await new Promise<void>((resolve) => old.close(() => resolve()));
      }
    });
  }

  it("claude-code: a person's grant auto-approval carries the person, so the next command in its category runs", async () => {
    const w = workspace("PA Gate Grant");
    const env = { OPENCADRE_URL: hub.url, OPENCADRE_KEY: w.coder.key };
    const first = runGate("claude-code", "docker system prune -af", env);
    const ada = await signInPerson(w.orgId, "Ada");
    expect(decideApproval(w.orgId, ada.decider, (await pendingIn(w.orgId)).id, "approve", null, { grantMinutes: 30 }).ok).toBe(true);
    expect(verdict("claude-code", (await first).out).decision).toBe("allow");
    const second = await runGate("claude-code", "docker volume rm cache", env);
    // F7 / Q1f (Codex ruling correction 4): a grant is person-issued but not a decision on THIS command, and the gate
    // says so, instead of reading as "Approved in OpenCadre by Ada".
    expect(verdict("claude-code", second.out)).toEqual({ decision: "allow", text: expect.stringMatching(/^Allowed in OpenCadre by Ada's standing "docker-prune" grant \(not a new decision on this command\)$/) });
  });
});
