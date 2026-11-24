import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { getAwareness } from "../src/awareness.js";
import {
  decideApproval, listApprovals, requestApproval, waitForApproval, withdrawApproval, WITHDRAW_NOT_REQUESTER,
} from "../src/approvals.js";
import { signInPerson } from "./helpers/person.js";

// Fleet coordination plan, slice B (docs/superpowers/plans/2026-11-07-fleet-coordination.md, failure 5): an agent could
// not take back an approval request it no longer needed, so a person was left deciding a request nobody was waiting on.
// Only the agent that asked may withdraw, and only while the request is still pending.

async function setupOrg(name: string) {
  const { orgId } = createOrganization(name);
  const coder = registerAgent(orgId, "Coder");
  const reviewer = registerAgent(orgId, "Reviewer");
  const signedIn = await signInPerson(orgId, "Operator");
  return {
    orgId,
    coder: { id: coder.agentId, name: "Coder", key: coder.apiKey },
    reviewer: { id: reviewer.agentId, name: "Reviewer", key: reviewer.apiKey },
    person: signedIn.decider,
    personHeaders: signedIn.headers,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = (id: string) => (db.prepare(`SELECT status FROM approvals WHERE id = ?`).get(id) as { status: string }).status;

describe("withdrawApproval", () => {
  it("the requester withdraws its own pending request", async () => {
    const { orgId, coder } = await setupOrg("Withdraw Own Org");
    const req = await requestApproval(orgId, coder, { action: "terraform apply", risk: "high" });
    const r = withdrawApproval(orgId, coder, req.id, "not needed after all");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.approval.status).toBe("withdrawn");
    expect(r.approval.decided_at).not.toBeNull();
    expect(r.approval.decision_note).toBe("not needed after all");
    // Nobody decided it: no decider is recorded, so nothing can read it as a person's decision.
    expect(r.approval.decided_by_person_id).toBeNull();
    expect(r.approval.decided_by_agent_id).toBeNull();
    expect(listApprovals(orgId, { status: "pending" }).map((a) => a.id)).not.toContain(req.id);
    expect(listApprovals(orgId, { status: "withdrawn" }).map((a) => a.id)).toEqual([req.id]);
  });

  it("another agent can't withdraw it, and is told who can", async () => {
    const { orgId, coder, reviewer } = await setupOrg("Withdraw Other Org");
    const req = await requestApproval(orgId, coder, { action: "npm publish" });
    expect(withdrawApproval(orgId, reviewer, req.id)).toEqual({ ok: false, error: WITHDRAW_NOT_REQUESTER, code: "not_requester" });
    expect(statusOf(req.id)).toBe("pending");
  });

  it("a person can't withdraw it either: they decide it instead", async () => {
    const { orgId, coder, person } = await setupOrg("Withdraw Person Org");
    const req = await requestApproval(orgId, coder, { action: "drop table users" });
    expect(withdrawApproval(orgId, person, req.id)).toEqual({ ok: false, error: WITHDRAW_NOT_REQUESTER, code: "not_requester" });
    expect(statusOf(req.id)).toBe("pending");
  });

  it("only while pending: a decided, expired or already withdrawn request stays as it is", async () => {
    const { orgId, coder, person } = await setupOrg("Withdraw Pending Org");
    const denied = await requestApproval(orgId, coder, { action: "deploy prod" });
    expect(decideApproval(orgId, person, denied.id, "deny").ok).toBe(true);
    expect(withdrawApproval(orgId, coder, denied.id)).toEqual({ ok: false, error: `Approval request "${denied.id}" is already denied`, code: "not_pending" });

    const approved = await requestApproval(orgId, coder, { action: "deploy staging" });
    expect(decideApproval(orgId, person, approved.id, "approve").ok).toBe(true);
    expect(withdrawApproval(orgId, coder, approved.id)).toMatchObject({ ok: false, code: "not_pending" });
    expect(statusOf(approved.id)).toBe("approved");

    const expired = await requestApproval(orgId, coder, { action: "slow", expiresInSeconds: 0.1 });
    await sleep(200);
    expect(withdrawApproval(orgId, coder, expired.id)).toEqual({ ok: false, error: `Approval request "${expired.id}" is already expired`, code: "not_pending" });

    const twice = await requestApproval(orgId, coder, { action: "once" });
    expect(withdrawApproval(orgId, coder, twice.id).ok).toBe(true);
    expect(withdrawApproval(orgId, coder, twice.id)).toMatchObject({ ok: false, code: "not_pending", error: `Approval request "${twice.id}" is already withdrawn` });

    const noted = await requestApproval(orgId, coder, { action: "fyi", notifyOnly: true });
    expect(withdrawApproval(orgId, coder, noted.id)).toMatchObject({ ok: false, code: "not_pending" });
  });

  it("an unknown id, or another workspace's request, is not found", async () => {
    const { orgId, coder } = await setupOrg("Withdraw Missing Org");
    const other = await setupOrg("Withdraw Missing Other Org");
    expect(withdrawApproval(orgId, coder, "no-such-id")).toEqual({ ok: false, error: 'No approval request found matching "no-such-id"', code: "not_found" });
    const theirs = await requestApproval(other.orgId, other.coder, { action: "theirs" });
    expect(withdrawApproval(orgId, coder, theirs.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(statusOf(theirs.id)).toBe("pending");
  });

  it("wakes a waiter at once, with the withdrawn status", async () => {
    const { orgId, coder } = await setupOrg("Withdraw Wake Org");
    const req = await requestApproval(orgId, coder, { action: "terraform destroy" });
    const waiting = waitForApproval(orgId, req.id, 5);
    await sleep(30);
    const start = Date.now();
    expect(withdrawApproval(orgId, coder, req.id).ok).toBe(true);
    expect((await waiting)?.status).toBe("withdrawn");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("a person can't approve (or deny) a withdrawn request", async () => {
    const { orgId, coder, person } = await setupOrg("Withdraw Decide Org");
    const req = await requestApproval(orgId, coder, { action: "rotate keys" });
    expect(withdrawApproval(orgId, coder, req.id).ok).toBe(true);
    expect(decideApproval(orgId, person, req.id, "approve")).toEqual({ ok: false, error: `Approval request "${req.id}" is already withdrawn` });
    expect(decideApproval(orgId, person, req.id, "deny").ok).toBe(false);
    expect(statusOf(req.id)).toBe("withdrawn");
  });

  it("emits approval.withdrawn to the named approver, and their digest says so", async () => {
    const { orgId, coder, reviewer } = await setupOrg("Withdraw Event Org");
    const req = await requestApproval(orgId, coder, { action: "kubectl delete ns staging", approver: "Reviewer" });
    getAwareness(orgId, reviewer.id); // past the request itself
    expect(withdrawApproval(orgId, coder, req.id, "fixed it another way").ok).toBe(true);
    const event = db.prepare(`SELECT * FROM events WHERE org_id = ? AND type = 'approval.withdrawn'`).get(orgId) as Record<string, string>;
    expect(event).toMatchObject({ subject_type: "approval", subject_id: req.id, actor_agent_id: coder.id, target_agent_id: reviewer.id });
    expect(JSON.parse(event.payload)).toEqual({ action: "kubectl delete ns staging", note: "fixed it another way" });
    const digest = getAwareness(orgId, reviewer.id);
    expect(digest.items.map((i) => i.summary)).toContain("Coder withdrew its approval request: kubectl delete ns staging (fixed it another way)");
  });

  it("with no named approver the event goes to nobody in particular", async () => {
    const { orgId, coder } = await setupOrg("Withdraw Untargeted Org");
    const req = await requestApproval(orgId, coder, { action: "rm -rf build" });
    expect(withdrawApproval(orgId, coder, req.id).ok).toBe(true);
    const event = db.prepare(`SELECT target_agent_id FROM events WHERE org_id = ? AND type = 'approval.withdrawn'`).get(orgId) as { target_agent_id: string | null };
    expect(event.target_agent_id).toBeNull();
  });
});

describe("REST POST /v1/approvals/:approvalId/withdraw and MCP withdraw_approval", () => {
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

  const call = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

  it("the requester withdraws over REST; another agent gets 403, a person 403, a repeat 409, an unknown id 404", async () => {
    const { coder, reviewer, personHeaders } = await setupOrg("REST Withdraw Org");
    const created = await call(bearer(coder.key), "POST", "/v1/approvals", { action: "git push --force", risk: "high" });
    const { approval } = (await created.json()) as { approval: { id: string } };

    const byOther = await call(bearer(reviewer.key), "POST", `/v1/approvals/${approval.id}/withdraw`, {});
    expect(byOther.status).toBe(403);
    expect(await byOther.json()).toEqual({ ok: false, error: WITHDRAW_NOT_REQUESTER, code: "not_requester" });
    const byPerson = await call(personHeaders, "POST", `/v1/approvals/${approval.id}/withdraw`, {});
    expect(byPerson.status).toBe(403);
    expect(((await byPerson.json()) as { error: string }).error).toBe(WITHDRAW_NOT_REQUESTER);

    const own = await call(bearer(coder.key), "POST", `/v1/approvals/${approval.id}/withdraw`, { note: "wrong branch" });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { approval: { status: string; decision_note: string } }).approval).toMatchObject({ status: "withdrawn", decision_note: "wrong branch" });

    expect((await call(bearer(coder.key), "POST", `/v1/approvals/${approval.id}/withdraw`, {})).status).toBe(409);
    expect((await call(bearer(coder.key), "POST", "/v1/approvals/no-such-id/withdraw", {})).status).toBe(404);

    // The person's stale card can't approve it now.
    const decide = await call(personHeaders, "POST", `/v1/approvals/${approval.id}/decide`, { decision: "approve" });
    expect(decide.status).toBe(409);
    // A client that knows the status says so (tests/approval-withdraw-legacy.test.ts: any other reads "denied").
    const waited = (await (await call({ ...bearer(coder.key), "x-opencadre-approval-statuses": "withdrawn" }, "GET", `/v1/approvals/${approval.id}/wait?timeoutSeconds=1`)).json()) as { approval: { status: string } };
    expect(waited.approval.status).toBe("withdrawn");
    const listed = (await (await call(bearer(reviewer.key), "GET", "/v1/approvals?status=withdrawn")).json()) as { approvals: Array<{ id: string }> };
    expect(listed.approvals.map((a) => a.id)).toEqual([approval.id]);
  });

  it("MCP withdraw_approval: the requester's call returns the WITHDRAWN record, another agent's is refused", async () => {
    const { orgId, coder, reviewer } = await setupOrg("MCP Withdraw Org");
    const req = await requestApproval(orgId, coder, { action: "terraform apply -auto-approve" });
    const connect = async (key: string) => {
      const client = new Client({ name: "withdraw-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: bearer(key) } }));
      return client;
    };
    const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");

    const other = await connect(reviewer.key);
    try {
      expect(text(await other.callTool({ name: "withdraw_approval", arguments: { approvalId: req.id } }))).toBe(`Error: ${WITHDRAW_NOT_REQUESTER}`);
    } finally {
      await other.close();
    }
    expect(statusOf(req.id)).toBe("pending");

    const own = await connect(coder.key);
    try {
      const result = await own.callTool({ name: "withdraw_approval", arguments: { approvalId: req.id, note: "done by hand" } }) as { structuredContent: { approval: { status: string } } };
      expect(text(result)).toMatch(/^\[WITHDRAWN\] terraform apply -auto-approve \(medium risk, requested by Coder, id /);
      expect(result.structuredContent.approval.status).toBe("withdrawn");
      expect(text(await own.callTool({ name: "list_approvals", arguments: { status: "withdrawn" } }))).toContain(req.id);
    } finally {
      await own.close();
    }
  });
});
