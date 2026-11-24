import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { createOrganization, getMessages, registerAgent } from "../src/service.js";
import {
  decideApproval, listApprovalGrants, listApprovals, requestApproval, revokeApprovalGrant, waitForApproval,
} from "../src/approvals.js";
import { signInPerson } from "./helpers/person.js";

// `operator` is an agent (the named approver that gets the notice); `person` is the signed-in person who decides.
// Since migration 53 a clearance is decided by a person only, so every decision below is the person's.
async function setupOrg(name = "Approvals Org") {
  const { orgId } = createOrganization(name);
  const agent = registerAgent(orgId, "Coder");
  const human = registerAgent(orgId, "Operator", { system: true });
  const signedIn = await signInPerson(orgId, "Operator");
  return {
    orgId,
    coder: { id: agent.agentId, name: "Coder", key: agent.apiKey },
    operator: { id: human.agentId, name: "Operator", key: human.apiKey },
    person: signedIn.decider,
    personHeaders: signedIn.headers,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("requestApproval / decideApproval", () => {
  it("creates a pending request that an approver can approve", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    const req = await requestApproval(orgId, coder, { action: "rm -rf dist", risk: "high" });
    expect(req.status).toBe("pending");
    expect(listApprovals(orgId, { status: "pending" }).map((a) => a.id)).toContain(req.id);

    const decided = decideApproval(orgId, person, req.id, "approve", "fine, it's a build dir");
    expect(decided.ok).toBe(true);
    if (decided.ok) {
      expect(decided.approval.status).toBe("approved");
      // The record names the person who decided (migration 53), and says it came from the console.
      expect(decided.approval.decided_by_person_name).toBe("Operator");
      expect(decided.approval.decided_via).toBe("console");
      expect(decided.approval.decision_note).toBe("fine, it's a build dir");
    }
  });

  it("forbids the requester from approving its own request (four-eyes)", async () => {
    const { orgId, coder } = await setupOrg();
    const req = await requestApproval(orgId, coder, { action: "deploy prod" });
    const self = decideApproval(orgId, coder, req.id, "approve");
    expect(self.ok).toBe(false);
  });

  it("cannot be decided twice, or from another org", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    const other = await setupOrg("Other Approvals Org");
    const req = await requestApproval(orgId, coder, { action: "drop table users" });
    expect(decideApproval(other.orgId, other.person, req.id, "approve").ok).toBe(false);
    expect(decideApproval(orgId, person, req.id, "deny", "no").ok).toBe(true);
    expect(decideApproval(orgId, person, req.id, "approve").ok).toBe(false);
  });

  it("rejects an empty action", async () => {
    const { orgId, coder } = await setupOrg();
    await expect(requestApproval(orgId, coder, { action: " " })).rejects.toThrow(/action/);
  });

  it("notifies a named approver with a high-priority message for a high-risk request", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    await requestApproval(orgId, coder, { action: "git push --force", approver: "Operator", risk: "high" });
    const inbox = getMessages(orgId, operator.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].priority).toBe("high");
    expect(inbox[0].body).toContain("git push --force");
  });

  // Attention-based routing (Stage 2 retro finding): urgency scales with risk instead of every
  // pending approval demanding the same "high" attention regardless of how routine it is.
  it("attention-based routing: message priority tracks risk instead of always paging as high", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    await requestApproval(orgId, coder, { action: "medium risk thing", approver: "Operator", risk: "medium" });
    await requestApproval(orgId, coder, { action: "low risk thing", approver: "Operator", risk: "low" });
    const inbox = getMessages(orgId, operator.id);
    expect(inbox).toHaveLength(2);
    expect(inbox.find((m) => m.body.includes("medium risk thing"))?.priority).toBe("medium");
    expect(inbox.find((m) => m.body.includes("low risk thing"))?.priority).toBe("low");
  });

  it("attention-based routing: a request with no explicit risk defaults to medium, not high", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    await requestApproval(orgId, coder, { action: "unscoped risk thing", approver: "Operator" });
    const inbox = getMessages(orgId, operator.id);
    expect(inbox[0].priority).toBe("medium");
  });
});

describe("notify-only requests", () => {
  it("are recorded as 'noted' for audit, never block, and can't be decided", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    const noted = await requestApproval(orgId, coder, { action: "rm -rf build", notifyOnly: true, approver: "Operator" });
    expect(noted.status).toBe("noted");
    expect(listApprovals(orgId, { status: "noted" }).map((a) => a.id)).toContain(noted.id);
    expect(decideApproval(orgId, person, noted.id, "deny").ok).toBe(false);
    const inbox = getMessages(orgId, operator.id);
    expect(inbox[0].priority).toBe("low");
    expect(inbox[0].body).toMatch(/FYI/);
  });
});

describe("time-boxed approval grants", () => {
  it("approving with grantMinutes auto-approves the same agent + category until it expires", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    const first = await requestApproval(orgId, coder, { action: "git push --force origin feat-x", category: "force-push" });
    const decided = decideApproval(orgId, person, first.id, "approve", "ok for this session", { grantMinutes: 30 });
    expect(decided.ok).toBe(true);
    if (decided.ok) expect(decided.grant?.category).toBe("force-push");

    const second = await requestApproval(orgId, coder, { action: "git push --force origin feat-y", category: "force-push" });
    expect(second.status).toBe("approved");
    // Auto-approved by the person's grant: the row names that person.
    expect(second.decided_by_person_name).toBe("Operator");
    expect(second.decided_via).toBe("grant");
    expect(second.decision_note).toMatch(/grant/i);

    // Different category is not covered.
    const other = await requestApproval(orgId, coder, { action: "terraform destroy", category: "terraform" });
    expect(other.status).toBe("pending");
  });

  it("grants are per requesting agent, expire, and can be revoked", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    const third = registerAgent(orgId, "Another Coder");
    const req = await requestApproval(orgId, coder, { action: "rm -rf ./out", category: "rm-rf" });
    const decided = decideApproval(orgId, person, req.id, "approve", undefined, { grantMinutes: 0.005 });
    const grantId = decided.ok ? decided.grant!.id : "";

    const otherAgent = await requestApproval(orgId, { id: third.agentId, name: "Another Coder" }, { action: "rm -rf ./out", category: "rm-rf" });
    expect(otherAgent.status).toBe("pending");

    expect(listApprovalGrants(orgId).map((g) => g.id)).toContain(grantId);
    await sleep(400);
    const afterExpiry = await requestApproval(orgId, coder, { action: "rm -rf ./out", category: "rm-rf" });
    expect(afterExpiry.status).toBe("pending");

    const again = decideApproval(orgId, person, afterExpiry.id, "approve", undefined, { grantMinutes: 30 });
    const newGrant = again.ok ? again.grant!.id : "";
    expect(revokeApprovalGrant(orgId, newGrant)).toBe(true);
    expect((await requestApproval(orgId, coder, { action: "rm -rf ./out", category: "rm-rf" })).status).toBe("pending");
  });

  it("denials and requests without a category never create grants", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    const denied = await requestApproval(orgId, coder, { action: "drop table x", category: "sql-drop" });
    const d = decideApproval(orgId, person, denied.id, "deny", undefined, { grantMinutes: 30 });
    expect(d.ok && d.grant).toBeFalsy();
    const uncategorized = await requestApproval(orgId, coder, { action: "something" });
    const u = decideApproval(orgId, person, uncategorized.id, "approve", undefined, { grantMinutes: 30 });
    expect(u.ok && u.grant).toBeFalsy();
  });
});

describe("waiting for a decision (fail closed)", () => {
  it("wakes the waiting requester as soon as a decision lands", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    const req = await requestApproval(orgId, coder, { action: "terraform apply" });
    const waiting = waitForApproval(orgId, req.id, 5);
    await sleep(30);
    decideApproval(orgId, person, req.id, "approve");
    const start = Date.now();
    const result = await waiting;
    expect(result?.status).toBe("approved");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("requestApproval can block until decided in one call", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    const pending = requestApproval(orgId, coder, { action: "rotate keys", waitSeconds: 5 });
    await sleep(30);
    const id = listApprovals(orgId, { status: "pending" })[0].id;
    decideApproval(orgId, person, id, "deny", "not today");
    const result = await pending;
    expect(result.status).toBe("denied");
  });

  it("stays pending when the wait window ends before the request expires", async () => {
    const { orgId, coder } = await setupOrg();
    const result = await requestApproval(orgId, coder, { action: "slow human", waitSeconds: 0.2, expiresInSeconds: 60 });
    expect(result.status).toBe("pending");
  });

  it("expires (denied by default) once expiresInSeconds passes, and can't be approved after", async () => {
    const { orgId, coder, operator, person } = await setupOrg();
    const req = await requestApproval(orgId, coder, { action: "nobody answers", expiresInSeconds: 0.2 });
    await sleep(300);
    const waited = await waitForApproval(orgId, req.id, 1);
    expect(waited?.status).toBe("expired");
    expect(decideApproval(orgId, person, req.id, "approve").ok).toBe(false);
    expect(listApprovals(orgId, { status: "expired" }).map((a) => a.id)).toContain(req.id);
  });
});

describe("REST /v1/approvals", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = (key: string, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("request → list → decide → wait round-trip", async () => {
    const { coder, operator, personHeaders } = await setupOrg("REST Approvals Org");
    const created = await call(coder.key, "POST", "/v1/approvals", { action: "kubectl delete ns staging", risk: "high" });
    expect(created.status).toBe(201);
    const { approval } = (await created.json()) as { approval: { id: string; status: string } };
    expect(approval.status).toBe("pending");

    const pending = (await (await call(operator.key, "GET", "/v1/approvals?status=pending")).json()) as { approvals: Array<{ id: string }> };
    expect(pending.approvals.map((a) => a.id)).toContain(approval.id);

    // No agent key decides a clearance, the requester's (was 409, self-decide) or the operator's (was 200): 403, a person
    // has to (migration 53). The signed-in person's console session decides it.
    expect((await call(coder.key, "POST", `/v1/approvals/${approval.id}/decide`, { decision: "approve" })).status).toBe(403);
    expect((await call(operator.key, "POST", `/v1/approvals/${approval.id}/decide`, { decision: "approve" })).status).toBe(403);
    const byPerson = await fetch(`${baseUrl}/v1/approvals/${approval.id}/decide`, { method: "POST", headers: personHeaders, body: JSON.stringify({ decision: "approve" }) });
    expect(byPerson.status).toBe(200);

    const waited = (await (await call(coder.key, "GET", `/v1/approvals/${approval.id}/wait?timeoutSeconds=1`)).json()) as { approval: { status: string } };
    expect(waited.approval.status).toBe("approved");
  });

  it("validates input", async () => {
    const { coder, operator } = await setupOrg("REST Approvals Org 2");
    expect((await call(coder.key, "POST", "/v1/approvals", {})).status).toBe(400);
    const { approval } = (await (await call(coder.key, "POST", "/v1/approvals", { action: "x" })).json()) as { approval: { id: string } };
    expect((await call(operator.key, "POST", `/v1/approvals/${approval.id}/decide`, { decision: "maybe" })).status).toBe(400);
    expect((await call(operator.key, "GET", "/v1/approvals/does-not-exist/wait?timeoutSeconds=1")).status).toBe(404);
  });
});
