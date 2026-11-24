import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleMcpRequest } from "../src/mcp.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { decideApproval, listApprovals, PERSON_REQUIRED_REFUSAL, withdrawApproval } from "../src/approvals.js";
import { getMessages } from "../src/service.js";
import { mcpRequest, extractToolCallText } from "../scripts/mcp-smoke-test.mjs";
import { classifyCommand, execCommand, notExecutedReason, runShellTool, splitApprovers } from "../scripts/deepseek-shell-guard.mjs";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { operatorPerson } from "./helpers/person.js";

// Same routing as src/index.ts: MCP bypasses Express and parses its own body. Real hub logic end to
// end (approvals, task-board style tools), no mocking -- only TheHive itself is out of scope here.
let server: http.Server;
let mcpUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  mcpUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/mcp`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function makeCallHubTool(apiKey: string) {
  return async (name: string, args: Record<string, unknown>) => {
    const res = await mcpRequest(mcpUrl, apiKey, "tools/call", { name, arguments: args });
    if (!res.ok) throw new Error(`MCP ${name} failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    // As the bridge does (callHubToolStructured): the text AND the structured approval record run_shell checks.
    return { text: extractToolCallText(res.data ?? {}), structured: res.data?.result?.structuredContent ?? null };
  };
}

function setupOrg(name: string) {
  const { orgId } = createOrganization(name);
  const coder = registerAgent(orgId, "agent1");
  const reviewer = registerAgent(orgId, "Claude-Supervisor");
  return {
    orgId,
    coderKey: coder.apiKey,
    coder: { id: coder.agentId, name: "agent1" },
    reviewer: { id: reviewer.agentId, name: "Claude-Supervisor", key: reviewer.apiKey },
  };
}

/** A clearance is decided by a PERSON (migration 53). The reviewer agent is still the approver of record that the guard
 * names and notifies, but only the workspace's signed-in person can decide the request. */
async function personDecider(orgId: string) {
  return (await operatorPerson(orgId)).decider;
}

/** decideApproval races the gate's own request_approval -- retries until the pending row exists. A person decides. */
async function decideOnce(orgId: string, decision: "approve" | "deny") {
  const person = await personDecider(orgId);
  for (let i = 0; i < 50; i++) {
    const pending = listApprovals(orgId, { status: "pending" });
    if (pending.length > 0) {
      const r = decideApproval(orgId, person, pending[0].id, decision, decision === "deny" ? "not now" : "go ahead");
      if (!r.ok) throw new Error(r.error);
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no pending approval appeared for the shell command");
}

// Every test here runs the real run_shell path, which now spawns a real POSIX shell (resolveShell,
// #301) and waits on a real approval round-trip, so the file needs the repo's spawn-heavy budget:
// vitest's 5000 ms default starved the approval wait under any other load. Matches the convention in
// approval-hook.test.ts, antigravity-hook.test.ts and the rest of the spawn-heavy files.
describe("run_shell integration (real hub, no TheHive)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("denies a cwd outside the allowlist without ever requesting approval", async () => {
    const { orgId, coderKey } = setupOrg("Shell Deny Path Org");
    const outside = mkdtempSync(path.join(tmpdir(), "shell-outside-"));
    const allowed = mkdtempSync(path.join(tmpdir(), "shell-allowed-"));

    const result = await runShellTool(makeCallHubTool(coderKey), { cwd: outside, command: "echo hi" }, { allowedPaths: [allowed] });
    expect(result).toMatch(/not in the allowed directory list/);
    expect(listApprovals(orgId, {}).length).toBe(0);
  });

  it("does not execute when the reviewer denies", async () => {
    const { orgId, coderKey, reviewer } = setupOrg("Shell Deny Org");
    const allowed = mkdtempSync(path.join(tmpdir(), "shell-allowed-"));

    const run = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "echo should-not-run > out.txt" }, {
      allowedPaths: [allowed], approver: reviewer.name, totalWaitMs: 5000,
    });
    await decideOnce(orgId, "deny");
    const result = await run;
    expect(result).toMatch(/^Not executed --/);
    expect(result).toContain("DENIED");
  });

  it("executes the real command only after the reviewer approves, and returns its actual output", async () => {
    const { orgId, coderKey, reviewer } = setupOrg("Shell Approve Org");
    const allowed = mkdtempSync(path.join(tmpdir(), "shell-allowed-"));

    // "env ... echo" (not a plain "echo") so classifyCommand puts this in "write", exercising the
    // approval-required path -- a plain "echo" is read-only and now auto-approves (see below).
    const run = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "env X=1 echo integration-test-output" }, {
      allowedPaths: [allowed], approver: reviewer.name, totalWaitMs: 5000,
    });
    await decideOnce(orgId, "approve");
    const result = await run;
    expect(result.trim()).toBe("integration-test-output");
  });

  it("the requester can never decide its own run_shell approval (no self-approve bypass)", async () => {
    const { orgId, coderKey, reviewer } = setupOrg("Shell Self-Decide Org");
    const allowed = mkdtempSync(path.join(tmpdir(), "shell-allowed-"));

    const run = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "env X=1 echo hi" }, {
      allowedPaths: [allowed], approver: reviewer.name, totalWaitMs: 3000,
    });
    for (let i = 0; i < 50 && listApprovals(orgId, { status: "pending" }).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const pending = listApprovals(orgId, { status: "pending" })[0];
    // The requester (agent1, the DeepSeek agent itself) trying to decide its own request must fail --
    // proves run_shell has no quiet self-approve path; it inherits decideApproval's own guarantee.
    const selfDecide = decideApproval(orgId, { id: pending.requested_by_agent_id, name: pending.requested_by_agent_name }, pending.id, "approve");
    expect(selfDecide.ok).toBe(false);

    expect(decideApproval(orgId, await personDecider(orgId), pending.id, "deny").ok).toBe(true);
    const result = await run;
    expect(result).toMatch(/^Not executed --/);
  });

  it("the approver AGENT cannot unblock it: its decide_approval is refused, and the command waits for a person", async () => {
    const { orgId, coderKey, reviewer } = setupOrg("Shell Agent Approver Org");
    const allowed = mkdtempSync(path.join(tmpdir(), "shell-allowed-"));
    const run = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "env X=1 echo must-not-run" }, {
      allowedPaths: [allowed], approver: reviewer.name, totalWaitMs: 5000,
    });
    for (let i = 0; i < 50 && listApprovals(orgId, { status: "pending" }).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const pending = listApprovals(orgId, { status: "pending" })[0];
    expect(pending).toBeDefined();
    // The named approver, over the same MCP surface the fleet uses, and in-process: both refused.
    const said = (await makeCallHubTool(reviewer.key)("decide_approval", { approvalId: pending.id, decision: "approve", note: "lgtm" })).text;
    expect(said).toContain(PERSON_REQUIRED_REFUSAL);
    expect(decideApproval(orgId, reviewer, pending.id, "approve").ok).toBe(false);
    // Still held: the agent's "approve" changed nothing. Only a person ends the wait (request_approval blocks up to
    // 270 s on its own), and here the person denies it, so the command never runs.
    expect(listApprovals(orgId, {}).find((a) => a.id === pending.id)!.status).toBe("pending");
    expect(decideApproval(orgId, await personDecider(orgId), pending.id, "deny", "a person said no").ok).toBe(true);
    const result = await run;
    expect(result).toMatch(/^Not executed --/);
    expect(result).toContain("DENIED");
    expect(result).toContain("a person said no");
  });

  // Codex launch blocker (P1, #653): the guard accepted an older hub's "[APPROVED]" text, and a harmless probe actually
  // executed with no person. It now runs a write only when the STRUCTURED record names a person -- on the first response
  // and on a polled one.
  describe("person provenance on the approval record", () => {
    const ID = "12345678-1234-1234-1234-1234567890ab";
    const marker = (dir: string) => path.join(dir, "marker.txt");
    /** A scripted hub: request_approval answers `first`; each wait_for_approval answers the next of `polls`. */
    const scripted = (first: unknown, polls: unknown[] = []) => async (name: string) => {
      if (name === "request_approval") return first;
      if (name === "wait_for_approval") return polls.shift() ?? first;
      return "";
    };
    const rec = (status: string, person: string | null) =>
      ({ text: `[${status.toUpperCase()}] run_shell: echo ran > marker.txt (medium risk, requested by agent1, id ${ID})`, structured: { approval: { id: ID, status, decided_by_person_id: person } } });
    const run = (callHubTool: unknown, dir: string) =>
      runShellTool(callHubTool, { cwd: dir, command: "echo ran > marker.txt" }, { allowedPaths: [dir], totalWaitMs: 3000 });
    const PERSONLESS = /did not report a person's approval/;

    it("an older hub's '[APPROVED]' text on the FIRST response does not run it", async () => {
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-oldhub-")));
      const result = await run(scripted(`[APPROVED] run_shell: echo ran > marker.txt (medium risk, requested by agent1, id ${ID}) by Reviewer`), dir);
      expect(result).toMatch(PERSONLESS);
      expect(existsSync(marker(dir))).toBe(false);
    });

    it("an older hub's '[APPROVED]' text on a POLLED response does not run it", async () => {
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-oldhub-poll-")));
      const result = await run(scripted(`[PENDING] run_shell: echo ran > marker.txt (medium risk, requested by agent1, id ${ID}) | expires soon`,
        [`[APPROVED] run_shell: echo ran > marker.txt (medium risk, requested by agent1, id ${ID}) by Reviewer`]), dir);
      expect(result).toMatch(PERSONLESS);
      expect(existsSync(marker(dir))).toBe(false);
    });

    it("a record that says approved with no person (first or polled) does not run it", async () => {
      const a = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-noperson-")));
      expect(await run(scripted(rec("approved", null)), a)).toMatch(PERSONLESS);
      const b = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-noperson-poll-")));
      expect(await run(scripted(rec("pending", null), [rec("approved", null)]), b)).toMatch(PERSONLESS);
      expect(existsSync(marker(a)) || existsSync(marker(b))).toBe(false);
    });

    it("control: a polled record naming a person runs it", async () => {
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-person-poll-")));
      await run(scripted(rec("pending", null), [rec("approved", "person-1")]), dir);
      expect(existsSync(marker(dir))).toBe(true);
    });

    it("real hub: a person's grant auto-approves the next write in its category, and that record carries the person", async () => {
      const { orgId, coderKey } = setupOrg("Shell Grant Org");
      const allowed = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-grant-")));
      const first = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "env X=1 echo first-write" }, { allowedPaths: [allowed], totalWaitMs: 5000 });
      for (let i = 0; i < 50 && listApprovals(orgId, { status: "pending" }).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      const pending = listApprovals(orgId, { status: "pending" })[0];
      expect(decideApproval(orgId, await personDecider(orgId), pending.id, "approve", null, { grantMinutes: 30 }).ok).toBe(true);
      expect(String(await first).trim()).toBe("first-write");
      // No decision this time: the grant answers request_approval directly (the FIRST response), with its person.
      const second = await runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "echo granted > marker.txt" }, { allowedPaths: [allowed], totalWaitMs: 3000 });
      expect(second).not.toMatch(/^Not executed/);
      expect(existsSync(marker(allowed))).toBe(true);
      const granted = listApprovals(orgId, {}).find((a) => a.action.includes("echo granted"))!;
      expect(granted).toMatchObject({ status: "approved", decided_via: "grant" });
    });
  });

  // Fleet coordination slice B: the gate and this guard give the same reason for a withdrawn request.
  it("real hub: a request the asking agent withdrew does not run, and says why", async () => {
    const { orgId, coderKey, coder } = setupOrg("Shell Withdrawn Org");
    const allowed = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-withdrawn-")));
    const run = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "echo ran > marker.txt" }, { allowedPaths: [allowed], totalWaitMs: 5000 });
    for (let i = 0; i < 50 && listApprovals(orgId, { status: "pending" }).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(withdrawApproval(orgId, coder, listApprovals(orgId, { status: "pending" })[0].id).ok).toBe(true);
    expect(await run).toBe("Not executed -- withdrawn by the agent that asked.");
    expect(existsSync(path.join(allowed, "marker.txt"))).toBe(false);
  });

  it("notExecutedReason names a withdrawal from the record, or from the text of a hub that sends none", () => {
    const id = "0123456789abcdef0123456789abcdef1234";
    expect(notExecutedReason({ text: `[WITHDRAWN] run_shell: x (medium risk, requested by agent1, id ${id})`, structured: { approval: { id, status: "withdrawn" } } }))
      .toBe("Not executed -- withdrawn by the agent that asked.");
    expect(notExecutedReason(`[WITHDRAWN] run_shell: x (medium risk, requested by agent1, id ${id})`)).toBe("Not executed -- withdrawn by the agent that asked.");
  });

  it("splits a comma-separated approver config into one formal approver and extras to notify", () => {
    expect(splitApprovers("Claude-Supervisor,Claude-LeadImplementer")).toEqual({
      primary: "Claude-Supervisor", extras: ["Claude-LeadImplementer"],
    });
    expect(splitApprovers(" Claude-Supervisor , Claude-LeadImplementer ")).toEqual({
      primary: "Claude-Supervisor", extras: ["Claude-LeadImplementer"],
    });
    expect(splitApprovers("Claude-Supervisor")).toEqual({ primary: "Claude-Supervisor", extras: [] });
    expect(splitApprovers(undefined)).toEqual({ primary: undefined, extras: [] });
    // G9 depends on this: the bridge's default is now `?? ""`, and an empty value must reach the hub as
    // NO approver (the operator route) rather than as an approver named "" -- which would be a name that
    // resolves to nobody, i.e. exactly the outage G9 removes.
    expect(splitApprovers("")).toEqual({ primary: undefined, extras: [] });
  });

  it("a comma-separated approver config actually creates a real, decidable approval request " +
    "(regression: request_approval takes exactly one agent name -- passing the raw compound " +
    "string made resolveAgent fail to find anyone, so every run_shell call silently errored)", async () => {
    const { orgId, coderKey, reviewer } = setupOrg("Shell Multi-Approver Org");
    const second = registerAgent(orgId, "Claude-LeadImplementer");
    const allowed = mkdtempSync(path.join(tmpdir(), "shell-allowed-"));

    const run = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "env X=1 echo multi-approver-ok" }, {
      allowedPaths: [allowed], approver: `${reviewer.name},Claude-LeadImplementer`, totalWaitMs: 5000,
    });
    await decideOnce(orgId, "approve");
    const result = await run;
    expect(result.trim()).toBe("multi-approver-ok");

    const notified = getMessages(orgId, second.agentId, undefined, { peek: true });
    expect(notified.some((m) => m.body.includes(reviewer.name))).toBe(true);
  });

  it("a read-only command executes immediately, with no approval ever created, plus a low-priority FYI to the approver", async () => {
    const { orgId, coderKey, reviewer } = setupOrg("Shell Readonly Auto-Approve Org");
    const allowed = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-allowed-")));

    await withNativeCwdLane(allowed, async (command) => {
      const result = await runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command }, {
        allowedPaths: [allowed], approver: reviewer.name, totalWaitMs: 5000,
      });
      // The executing shell reports its own native physical cwd; Node TEMP is not a mount oracle.
      // Full filesystem identity remains the positive assertion, not a basename or suffix match.
      expect(realpathSync(result.trim())).toBe(realpathSync(allowed));
      const siblingParent = mkdtempSync(path.join(tmpdir(), "shell-identity-sibling-"));
      const sibling = path.join(siblingParent, path.basename(allowed));
      mkdirSync(sibling);
      expect(path.basename(sibling)).toBe(path.basename(allowed));
      expect(realpathSync(result.trim())).not.toBe(realpathSync(sibling));
      expect(listApprovals(orgId, {}).length).toBe(0); // no request_approval call was ever made

      const notified = getMessages(orgId, reviewer.id, undefined, { peek: true });
      const fyi = notified.find((m) => m.body.includes("Auto-approved (read-only)"));
      expect(fyi).toBeTruthy();
      expect(fyi?.priority).toBe("low");
    });
  });

  it("a write-classified command still requires a real decision even when the requester tries to slip it through as read-only-shaped", async () => {
    const { orgId, coderKey, reviewer } = setupOrg("Shell Not Readonly Org");
    const allowed = mkdtempSync(path.join(tmpdir(), "shell-allowed-"));

    // Same shape as a legitimate read-only audit command, but with a git subcommand this classifier
    // doesn't recognize as read-only -- must NOT auto-approve.
    const run = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "git stash list" }, {
      allowedPaths: [allowed], approver: reviewer.name, totalWaitMs: 5000,
    });
    await decideOnce(orgId, "deny");
    const result = await run;
    expect(result).toMatch(/^Not executed --/);
  });

  it("read-only and write approval requests land in separate categories, so a grant on one never covers the other", async () => {
    const { orgId, coderKey, reviewer } = setupOrg("Shell Category Split Org");
    const allowed = mkdtempSync(path.join(tmpdir(), "shell-allowed-"));

    const writeRun = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "env X=1 echo write-path" }, {
      allowedPaths: [allowed], approver: reviewer.name, totalWaitMs: 5000,
    });
    await decideOnce(orgId, "approve");
    await writeRun;

    const mutateRun = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "git commit -am wip" }, {
      allowedPaths: [allowed], approver: reviewer.name, totalWaitMs: 5000,
    });
    for (let i = 0; i < 50 && listApprovals(orgId, { status: "pending" }).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const pending = listApprovals(orgId, { status: "pending" })[0];
    expect(pending.category).toBe("deepseek-shell-exec-git-mutate");
    expect(decideApproval(orgId, await personDecider(orgId), pending.id, "deny").ok).toBe(true);
    await mutateRun;

    const decided = listApprovals(orgId, {}).filter((a) => a.category === "deepseek-shell-exec-write");
    expect(decided.some((a) => a.status === "approved")).toBe(true);
  });
});

/**
 * G9 (docs/ops/HUB-OPERATIONS.md §4, §7): `scripts/deepseek-agent-bridge.mjs` shipped
 * `DEEPSEEK_SHELL_APPROVER ?? "Claude-Supervisor,Claude-LeadImplementer"` -- the same two retired names
 * as the §4 incident -- and nothing on disk sets that variable, so the retired pair was the default
 * approver for every deepseek lane's run_shell.
 *
 * The gate (#277) survived a dead approver. The shell guard has no retry, and the hub refuses the
 * request at CREATION, so the failure is not a denial: no approval row is ever written. Nothing can be
 * decided, retried or escalated by anyone but the person who reads the source.
 */
describe("run_shell when the configured approver does not resolve (G9)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("MEASURED: a retired approver name blocks the command and leaves nothing an operator can decide", async () => {
    const { orgId, coderKey } = setupOrg("Shell Retired Approver Org");
    const allowed = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-retired-approver-")));

    // setupOrg registers a live "Claude-Supervisor", so use a name no agent holds -- otherwise this
    // would measure the healthy path.
    const result = String(
      await runShellTool(
        makeCallHubTool(coderKey),
        { cwd: allowed, command: "env X=1 echo should-not-be-reached" },
        { allowedPaths: [allowed], approver: "Claude-Supervisor-Retired", totalWaitMs: 2000, approverSource: "DEEPSEEK_SHELL_APPROVER" },
      ),
    );

    // Fail-closed, which is the half that was already correct...
    expect(result).not.toContain("should-not-be-reached");
    expect(result).toContain('No agent found matching approver "Claude-Supervisor-Retired"');
    // ...and the half that was not: the request was refused at creation, so there is no pending
    // approval on the Clearances page and no decision anyone can make. The lane is simply unable to
    // run the command, and the message it gets does not say which config to fix.
    expect(listApprovals(orgId, { status: "pending" })).toHaveLength(0);
    expect(result).toContain("DEEPSEEK_SHELL_APPROVER");
    expect(result).toMatch(/blocked, not denied/);
  });

  it("THE FIX: with no approver configured the request IS created, and an operator's approval runs the command", async () => {
    const { orgId, coderKey, reviewer } = setupOrg("Shell Operator Route Org");
    const allowed = mkdtempSync(path.join(tmpdir(), "shell-operators-"));

    // `approver: undefined` is exactly what the bridge now computes when DEEPSEEK_SHELL_APPROVER is
    // unset. An unset approver is a supported configuration, not a fault: the request is created with
    // no named approver and goes to the workspace's operators, who cannot be retired.
    const run = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "env X=1 echo operator-approved" }, {
      allowedPaths: [allowed], approver: undefined, totalWaitMs: 5000, approverSource: "DEEPSEEK_SHELL_APPROVER",
    });
    await decideOnce(orgId, "approve");
    expect(String(await run).trim()).toBe("operator-approved");
    expect(listApprovals(orgId, {}).some((a) => a.status === "approved")).toBe(true);
  });

  it("a real denial is never reported as an approver-config problem (the diagnostic cannot misfire)", async () => {
    // The dangerous direction for a diagnostic: telling someone their config is broken when a reviewer
    // simply said no. Same inputs as the MEASURED case above, except the approver is live.
    const { orgId, coderKey, reviewer } = setupOrg("Shell Denial Not Misattributed Org");
    const allowed = mkdtempSync(path.join(tmpdir(), "shell-denial-"));

    const run = runShellTool(makeCallHubTool(coderKey), { cwd: allowed, command: "env X=1 echo denied" }, {
      allowedPaths: [allowed], approver: reviewer.name, totalWaitMs: 5000, approverSource: "DEEPSEEK_SHELL_APPROVER",
    });
    await decideOnce(orgId, "deny");
    const result = String(await run);
    expect(result).toContain("DENIED");
    expect(result).not.toContain("DEEPSEEK_SHELL_APPROVER");
  });

  it("notExecutedReason stays silent unless the request was never created AND the refusal is about an approver", () => {
    const id = "0123456789abcdef0123456789abcdef1234";
    const refusal = 'No agent found matching approver "Ghost"';
    expect(notExecutedReason(refusal, { approver: "Ghost", approverSource: "DEEPSEEK_SHELL_APPROVER" })).toContain("DEEPSEEK_SHELL_APPROVER");
    // An approval id means a request existed and someone decided it -- say nothing about config.
    expect(notExecutedReason(`[DENIED] no (id ${id})`)).toBe(`Not executed -- [DENIED] no (id ${id})`);
    // No id, but nothing about an approver: a hub fault must not be reported as a config fault.
    expect(notExecutedReason("Error: tool not found")).toBe("Not executed -- Error: tool not found");
    // No approval id and no named config: still actionable, still does not invent a variable name.
    const noSource = notExecutedReason(refusal, { approver: "Ghost" });
    expect(noSource).toContain('"Ghost"');
    expect(noSource).not.toContain("undefined");
  });

  it("the bridge ships no default approver name, so this cannot rot back in", () => {
    // A source assertion, not a behavioural one, because it is the only option: the bridge runs its
    // whole message loop at import time (see deepseek-shell-guard.mjs's header), so importing it to read
    // the value it computed would start a real bridge and need a live TheHive key.
    const src = readFileSync(new URL("../scripts/deepseek-agent-bridge.mjs", import.meta.url), "utf8");
    const assignment = /const SHELL_APPROVER = [^;]*;/.exec(src);
    expect(assignment).not.toBeNull();
    const line = assignment![0];

    expect(line).toContain("process.env.DEEPSEEK_SHELL_APPROVER");
    // THE regression assertion: `?? "Claude-Supervisor,Claude-LeadImplementer"` fails this, and so would
    // any other substituted name. A fixed name here is a reference that dies with the agent holding it.
    expect(line).not.toMatch(/\?\?\s*["'][^"']+["']/);
    expect(line).toMatch(/\?\?\s*""/);
  });
});

/** Process-local test override only. Sequential tests; never change the operator's client config. */
async function withTestShellOverride<T>(bin: string | null, run: () => Promise<T>): Promise<T> {
  if (bin === null) return run();
  const previous = process.env.OPENCADRE_SHELL_BIN;
  process.env.OPENCADRE_SHELL_BIN = bin;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OPENCADRE_SHELL_BIN;
    else process.env.OPENCADRE_SHELL_BIN = previous;
  }
}

/** Git Bash's builtin pwd -W converts its OWN physical cwd, rather than guessing from Node TEMP.
 * Vendor implementation read 2026-10-10:
 * https://raw.githubusercontent.com/git-for-windows/MSYS2-packages/master/bash/0006-bash-4.3-add-pwd-W-option.patch
 * This Windows test lane deliberately qualifies Git Bash, not every production sh/dash/zsh override.
 * Missing Git Bash or missing -W capability fails explicitly; there is no blanket skip/fallback. */
async function withNativeCwdLane<T>(cwd: string, run: (command: string) => Promise<T>): Promise<T> {
  let bin: string | null = null;
  if (process.platform === "win32") {
    bin = ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find((candidate) => {
      try { return statSync(candidate).isFile(); } catch { return false; }
    }) ?? null;
    if (bin === null) throw new Error("Native cwd test lane requires Git for Windows bash.exe at a standard install path.");
  }
  return withTestShellOverride(bin, async () => {
    const command = process.platform === "win32" ? "pwd -W" : "pwd -P";
    expect(classifyCommand(command)).toBe("read-only");
    const nativeCwd = String(await execCommand(cwd, command, { timeoutMs: 5000 })).trim();
    if (!path.isAbsolute(nativeCwd)) throw new Error(`Native cwd capability check failed for ${command}: ${nativeCwd}`);
    expect(realpathSync(nativeCwd)).toBe(realpathSync(cwd));
    return run(command);
  });
}

describe("native cwd test oracle controls", () => {
  it("CONSTRUCTED: Node TEMP reconstruction duplicates a segment when the shell mount is its parent", () => {
    // Hypothetical mapping, NOT a captured cause or reproduction of either historical full-gate failure.
    const shellMount = "C:\\oracle-root";
    const nodeTemp = path.win32.join(shellMount, "private");
    const printed = "/tmp/private/shell-allowed-X";
    const oldReconstruction = path.win32.join(nodeTemp, printed.slice("/tmp/".length));
    const actualInThisConstruction = path.win32.join(shellMount, "private", "shell-allowed-X");
    expect(oldReconstruction).toBe("C:\\oracle-root\\private\\private\\shell-allowed-X");
    expect(oldReconstruction).not.toBe(actualInThisConstruction);
  });

  it("both native cwd commands retain the existing read-only classification", () => {
    expect(classifyCommand("pwd -W")).toBe("read-only");
    expect(classifyCommand("pwd -P")).toBe("read-only");
  });

  it("restores both unset and set test-shell overrides after success and capability failure", async () => {
    const original = process.env.OPENCADRE_SHELL_BIN;
    try {
      for (const previous of [undefined, "previous-test-shell"]) {
        if (previous === undefined) delete process.env.OPENCADRE_SHELL_BIN;
        else process.env.OPENCADRE_SHELL_BIN = previous;
        await withTestShellOverride("selected-test-shell", async () => {
          expect(process.env.OPENCADRE_SHELL_BIN).toBe("selected-test-shell");
        });
        expect(process.env.OPENCADRE_SHELL_BIN).toBe(previous);
        await expect(withTestShellOverride("selected-test-shell", async () => {
          throw new Error("simulated capability failure");
        })).rejects.toThrow("simulated capability failure");
        expect(process.env.OPENCADRE_SHELL_BIN).toBe(previous);
      }
    } finally {
      if (original === undefined) delete process.env.OPENCADRE_SHELL_BIN;
      else process.env.OPENCADRE_SHELL_BIN = original;
    }
  });
});
