import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { decideApproval, listApprovals, requestApproval } from "../src/approvals.js";
import { listEvents } from "../src/events.js";
import { setClearancePolicy } from "../src/clearance-policy.js";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { signInPerson } from "./helpers/person.js";

const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const scratch = () => mkdtempSync(path.join(tmpdir(), "bypass-"));

function workspace(name: string) {
  const { orgId } = createOrganization(name);
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const reviewer = registerAgent(orgId, "Reviewer");
  const codex = registerAgent(orgId, "Codex");
  return {
    orgId,
    operator: { id: operator.agentId, name: "Operator" },
    reviewerId: reviewer.agentId,
    codex: { id: codex.agentId, name: "Codex" },
    codexKey: codex.apiKey,
  };
}

const report = async (key: string, body: unknown) => {
  const res = await fetch(`${baseUrl}/v1/clearances/executed`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const bypassEvents = (orgId: string) => listEvents(orgId).filter((e) => e.type === "clearance.bypassed");
const notices = (agentId: string) =>
  (db.prepare(`SELECT body FROM messages WHERE to_agent_id = ? AND body LIKE 'CLEARANCE BYPASSED%'`).all(agentId) as Array<{ body: string }>).map((m) => m.body);

describe("POST /v1/clearances/executed", () => {
  it("records a notify-mode command once, whether or not a gate already did", async () => {
    const w = workspace("Report Record");
    expect((await report(w.codexKey, { action: "terraform destroy", required: "record", category: "terraform" })).body.outcome).toBe("recorded");
    expect((await report(w.codexKey, { action: "terraform destroy", required: "record", category: "terraform" })).body.outcome).toBe("already_recorded");
    expect(listApprovals(w.orgId).map((a) => [a.action, a.status])).toEqual([["terraform destroy", "noted"]]);
    expect(bypassEvents(w.orgId)).toEqual([]);
  });

  it("raises exactly one bypass event and one notice for a command that needed approval and had none", async () => {
    const w = workspace("Report Bypass");
    const first = await report(w.codexKey, { action: "git push --force origin main", required: "approval", category: "force-push" });
    expect(first).toEqual({ status: 200, body: { outcome: "bypassed" } });
    expect((await report(w.codexKey, { action: "git push --force origin main", required: "approval", category: "force-push" })).body.outcome).toBe("already_reported");

    const events = bypassEvents(w.orgId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_agent_name: "Codex", subject_type: "clearance" });
    expect(JSON.parse(events[0].payload)).toEqual({ action: "git push --force origin main", category: "force-push" });
    expect(notices(w.operator.id)).toEqual([
      "CLEARANCE BYPASSED: Codex ran a force-push command that needed approval, and no clearance was requested: git push --force origin main",
    ]);
    expect(notices(w.reviewerId)).toEqual([]);
  });

  it("is satisfied by an approval for the same command from the same agent", async () => {
    const w = workspace("Report Approved");
    const approval = await requestApproval(w.orgId, w.codex, { action: "npm publish", category: "publish" });
    // A person decides a clearance (migration 53); the operator's agent no longer can.
    const { decider } = await signInPerson(w.orgId);
    expect(decideApproval(w.orgId, decider, approval.id, "approve", null).ok).toBe(true);
    expect((await report(w.codexKey, { action: "npm publish", required: "approval" })).body).toEqual({ outcome: "approved", approvalId: approval.id });
    expect(bypassEvents(w.orgId)).toEqual([]);
  });

  // Codex launch blocker (P2): an approved row counts only when a PERSON is behind it.
  it("a legacy approved row no person decided counts as NOT approved, and raises the bypass", async () => {
    const w = workspace("Report Personless");
    const legacy = await requestApproval(w.orgId, w.codex, { action: "npm publish", category: "publish" });
    // Written the way a pre-migration-53 agent decision sits in the table: approved, an agent named, no person.
    db.prepare(`UPDATE approvals SET status = 'approved', decided_by_agent_id = ?, decided_by_agent_name = 'Operator', decided_at = datetime('now') WHERE id = ?`)
      .run(w.operator.id, legacy.id);
    expect((await report(w.codexKey, { action: "npm publish", required: "approval", category: "publish" })).body.outcome).toBe("bypassed");
    const events = bypassEvents(w.orgId);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({ approvalId: legacy.id, lastStatus: "approved_without_person" });
    expect(notices(w.operator.id)[0]).toContain("its clearance request was never approved by a person");
  });

  it("a person-approved row satisfies the report", async () => {
    const w = workspace("Report Person Approved");
    const approval = await requestApproval(w.orgId, w.codex, { action: "npm publish" });
    expect(decideApproval(w.orgId, (await signInPerson(w.orgId)).decider, approval.id, "approve", null).ok).toBe(true);
    expect((await report(w.codexKey, { action: "npm publish", required: "approval" })).body).toEqual({ outcome: "approved", approvalId: approval.id });
    expect(bypassEvents(w.orgId)).toEqual([]);
  });

  it("a row a person's grant auto-approved satisfies the report", async () => {
    const w = workspace("Report Grant Approved");
    const first = await requestApproval(w.orgId, w.codex, { action: "npm publish --tag a", category: "publish" });
    expect(decideApproval(w.orgId, (await signInPerson(w.orgId)).decider, first.id, "approve", null, { grantMinutes: 30 }).ok).toBe(true);
    const viaGrant = await requestApproval(w.orgId, w.codex, { action: "npm publish --tag b", category: "publish" });
    expect(viaGrant.status).toBe("approved");
    expect(viaGrant.decided_via).toBe("grant");
    expect((await report(w.codexKey, { action: "npm publish --tag b", required: "approval", category: "publish" })).body).toEqual({ outcome: "approved", approvalId: viaGrant.id });
    expect(bypassEvents(w.orgId)).toEqual([]);
  });

  it("does not count another agent's approval or a denied request", async () => {
    const w = workspace("Report Not Satisfied");
    const other = await requestApproval(w.orgId, { id: w.reviewerId, name: "Reviewer" }, { action: "npm publish" });
    const { decider } = await signInPerson(w.orgId);
    expect(decideApproval(w.orgId, decider, other.id, "approve", null).ok).toBe(true);
    const denied = await requestApproval(w.orgId, w.codex, { action: "npm publish" });
    expect(decideApproval(w.orgId, decider, denied.id, "deny", "not today").ok).toBe(true);

    expect((await report(w.codexKey, { action: "npm publish", required: "approval" })).body.outcome).toBe("bypassed");
    expect(JSON.parse(bypassEvents(w.orgId)[0].payload)).toMatchObject({ lastStatus: "denied", approvalId: denied.id });
    expect(notices(w.operator.id)[0]).toContain("its clearance request ended denied");
  });

  it("notifies the named approver instead of every operator", async () => {
    const w = workspace("Report Approver");
    await report(w.codexKey, { action: "kubectl delete ns prod", required: "approval", approver: "Reviewer" });
    expect(notices(w.reviewerId)).toHaveLength(1);
    expect(notices(w.operator.id)).toEqual([]);
    expect(bypassEvents(w.orgId)[0].target_agent_id).toBe(w.reviewerId);
  });

  it("rejects bad input", async () => {
    const w = workspace("Report Validation");
    expect((await report(w.codexKey, { required: "approval" })).status).toBe(400);
    expect((await report(w.codexKey, { action: "rm -rf /", required: "maybe" })).status).toBe(400);
    expect((await report(w.codexKey, { action: "rm -rf /", required: "approval", approver: "Nobody" })).status).toBe(400);
    expect(bypassEvents(w.orgId)).toEqual([]);
  });
});

function repo(): string {
  const dir = scratch();
  execFileSync("git", ["init", "-q", "-b", "feature-x"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: dir });
  return dir;
}

function runHook(args: string[], toolInput: unknown, env: Record<string, string>, cwd = repo()): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], {
      env: { ...process.env, ...GATE_TEST_ENV, HOME: cwd, USERPROFILE: cwd, OPENCADRE_HOOK_HOME: cwd, OPENCADRE_GATE_MODE: "", OPENCADRE_GATE_CONFIG: "", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: toolInput, cwd }));
  });
}

// Each test here starts the gate as a child process.
describe("gate --report (post-execution hook)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("reports a Codex command that ran under an ask policy as a bypass, silently", async () => {
    const w = workspace("Hook Report Ask");
    setClearancePolicy(w.orgId, w.operator, "github.com/acme/app", "ask");
    const r = await runHook(["--report", "--client", "codex"], { command: ["bash", "-lc", "rm -rf ./data"] }, { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: w.codexKey });
    expect(r).toEqual({ code: 0, out: "" });
    expect(bypassEvents(w.orgId).map((e) => JSON.parse(e.payload))).toEqual([{ action: "bash -lc rm -rf ./data", category: "rm-rf" }]);
    expect(notices(w.operator.id)).toHaveLength(1);
  });

  it("records a risky command under notify, and ignores safe commands", async () => {
    const w = workspace("Hook Report Notify");
    const env = { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: w.codexKey, OPENCADRE_GATE_MODE: "notify" };
    expect(await runHook(["--report"], { command: "git status" }, env)).toEqual({ code: 0, out: "" });
    expect(await runHook(["--report"], { command: "npm publish" }, env)).toEqual({ code: 0, out: "" });
    expect(listApprovals(w.orgId).map((a) => [a.action, a.status])).toEqual([["npm publish", "noted"]]);
    expect(bypassEvents(w.orgId)).toEqual([]);
  });

  it("never prints a decision, even when the hub rejects the key or answers garbage", async () => {
    expect(await runHook(["--report"], { command: "rm -rf ./data" }, { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: "agt_revoked", OPENCADRE_GATE_MODE: "ask" }))
      .toEqual({ code: 0, out: "" });
    const garbage = http.createServer((_req, res) => res.writeHead(200).end("<html>proxy</html>"));
    await new Promise<void>((resolve) => garbage.listen(0, resolve));
    const addr = garbage.address();
    try {
      const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      expect(await runHook(["--report"], { command: "rm -rf ./data" }, { OPENCADRE_URL: url, OPENCADRE_KEY: "agt_x", OPENCADRE_GATE_MODE: "ask" }))
        .toEqual({ code: 0, out: "" });
    } finally {
      garbage.close();
    }
  });

  // F7 / Q1f (flipped; Codex ruling correction 1): the pre-hook used to print an allow AND report the command as
  // executed (a bypass) before it ran. A pre-hook cannot know that: it now says no opinion and records a POLICY PASS.
  // A bypass is raised only by the post-execution report, when the command is observed to have run.
  it("an ask gate whose onTimeout is \"allow\" hands the command back and records a policy pass, not a bypass", async () => {
    const w = workspace("Hook Timeout Allow");
    const cwd = repo();
    const lenient = path.join(cwd, "lenient.json");
    writeFileSync(lenient, JSON.stringify({ mode: "ask", onTimeout: "allow", waitSeconds: 1 }));
    const r = await runHook([], { command: "terraform apply" }, { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: w.codexKey, OPENCADRE_GATE_CONFIG: lenient }, cwd);
    expect(r.out).toBe("");
    expect(bypassEvents(w.orgId)).toEqual([]);
    const passes = listEvents(w.orgId).filter((e) => e.type === "clearance.policy_pass").map((e) => JSON.parse(e.payload));
    expect(passes).toMatchObject([{ reason: "timeout", outcome: "handed_back", handedBackTo: "client_permission_settings", action: "terraform apply", category: "terraform", delivery: "live" }]);
    expect(passes[0]).not.toHaveProperty("byPerson");
    // The command then RAN (Codex's own settings let it): only the post-execution report says so, and that is a bypass.
    await runHook(["--report"], { command: "terraform apply" }, { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: w.codexKey, OPENCADRE_GATE_CONFIG: lenient }, cwd);
    expect(bypassEvents(w.orgId).map((e) => JSON.parse(e.payload))).toMatchObject([{ action: "terraform apply", category: "terraform", lastStatus: "expired" }]);
  });
});
