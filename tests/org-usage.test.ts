import { toSqliteTime } from "../src/timestamps.js";
import { describe, expect, it, vi } from "vitest";
import { createOrganization, heartbeat, registerAgent, sendMessage } from "../src/service.js";
import { emitEvent } from "../src/events.js";
import { acceptTask, claimTask, completeTask, createTask } from "../src/tasks.js";
import { decideApproval, requestApproval } from "../src/approvals.js";
import { signInPerson } from "./helpers/person.js";
import { db } from "../src/db.js";
import { DEFAULT_USAGE_WINDOW_DAYS, getOrgUsageSummary, OrgUsageInputError } from "../src/org-usage.js";

function setupOrg(name = "Usage Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return {
    orgId,
    a: { id: a.agentId, name: "Agent A" },
    b: { id: b.agentId, name: "Agent B" },
  };
}

describe("getOrgUsageSummary", () => {
  it("is all zero for a fresh org", () => {
    const { orgId } = setupOrg();
    const usage = getOrgUsageSummary(orgId);
    expect(usage).toMatchObject({ orgId, messagesSent: 0, tasksCompleted: 0, approvalsDecided: 0, sessionAgentHours: 0 });
  });

  it("counts a sent message", async () => {
    const { orgId, a } = setupOrg();
    const sent = await sendMessage(orgId, a, "Agent B", "hi");
    if (!sent.ok) throw new Error("setup: send failed");
    expect(getOrgUsageSummary(orgId).messagesSent).toBe(1);
  });

  // THE WINDOW BOUNDARY, on the meter billing reads. `created_at` is SQLite's `datetime('now')`
  // ("2026-09-19 14:30:00", space, no Z) but this function's `since` was `new Date().toISOString()`
  // ("...T14:30:00.000Z"). The strings differ at index 10, where ' ' sorts BELOW 'T', so the comparison
  // resolves there and never reaches the time: every row on the cutoff's calendar day is excluded
  // although it is inside the window, and usage under-counts by up to a day of activity.
  //
  // THE CLOCK IS PINNED, AND THAT IS WHAT MAKES THIS TEST BITE AT EVERY HOUR. The defect lives at
  // index 10 -- the date/time separator -- so it is only exercised when the row and the cutoff share a
  // CALENDAR DAY. Cross midnight and the date parts differ, the comparison is decided by the date, and
  // the two spellings AGREE: the test then passes on the BROKEN code. No fixed margin removes that,
  // because a margin M is blind whenever the cutoff is within M of midnight (larger margins are worse:
  // +2h was blind from 22:00, +1h from 23:00, +30min at 23:30). Pinning the clock to MIDDAY puts the
  // cutoff at noon, so the row is same-day at any sane margin and the window is REMOVED rather than
  // shrunk. `vi.useFakeTimers()` is this repo's idiom (console-connect-computer.test.ts).
  it("counts a row just inside the window, on the cutoff's own calendar day", async () => {
    vi.useFakeTimers();
    try {
      // Midday UTC: the cutoff is noon, so a row minutes later is unambiguously same-day.
      vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
      const { orgId, a } = setupOrg("Usage Boundary");
      emitEvent({ orgId, type: "message.sent", actor: a, subjectType: "agent", subjectId: a.id, payload: {} });
      const within = toSqliteTime(Date.now() - DEFAULT_USAGE_WINDOW_DAYS * 86_400_000 + 5 * 60_000);
      db.prepare(`UPDATE events SET created_at = ? WHERE org_id = ? AND type = 'message.sent'`).run(within, orgId);

      // Inside the window, so it MUST be counted.
      expect(getOrgUsageSummary(orgId).messagesSent).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a completed task", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    claimTask(orgId, a, task.id, 60);
    completeTask(orgId, a, task.id, "done");
    expect(getOrgUsageSummary(orgId).tasksCompleted).toBe(1);
  });

  it("counts a decided approval (accept or deny), not a merely-requested one", async () => {
    const { orgId, a, b } = setupOrg();
    await requestApproval(orgId, a, { action: "deploy", approver: b.name, waitSeconds: 0 });
    expect(getOrgUsageSummary(orgId).approvalsDecided).toBe(0); // pending, not yet decided

    const req = await requestApproval(orgId, a, { action: "deploy again", approver: b.name, waitSeconds: 0 });
    // A person decides a clearance (migration 53); b, an agent, is only the named approver.
    expect(decideApproval(orgId, (await signInPerson(orgId, "Ada")).decider, req.id, "approve").ok).toBe(true);
    expect(getOrgUsageSummary(orgId).approvalsDecided).toBe(1);
  });

  it("counts distinct agents with a recent heartbeat, not every agent that ever existed", () => {
    const { orgId, a } = setupOrg(); // b never heartbeats
    heartbeat(orgId, a.id);
    expect(getOrgUsageSummary(orgId).activeAgents).toBe(1);
  });

  it("rejects a non-positive or out-of-range sinceDays", () => {
    const { orgId } = setupOrg();
    expect(() => getOrgUsageSummary(orgId, { sinceDays: 0 })).toThrow(OrgUsageInputError);
    expect(() => getOrgUsageSummary(orgId, { sinceDays: -5 })).toThrow(OrgUsageInputError);
    expect(() => getOrgUsageSummary(orgId, { sinceDays: 9999 })).toThrow(OrgUsageInputError);
  });

  it("defaults to a 30-day window when sinceDays is omitted", () => {
    const { orgId } = setupOrg();
    const usage = getOrgUsageSummary(orgId);
    const days = (new Date(usage.until).getTime() - new Date(usage.since).getTime()) / (1000 * 60 * 60 * 24);
    expect(Math.round(days)).toBe(DEFAULT_USAGE_WINDOW_DAYS);
  });

  it("never counts another org's activity", async () => {
    const one = setupOrg("Usage Org One");
    const two = setupOrg("Usage Org Two");
    const sent = await sendMessage(one.orgId, one.a, "Agent B", "hi");
    if (!sent.ok) throw new Error("setup: send failed");
    expect(getOrgUsageSummary(two.orgId).messagesSent).toBe(0);
  });

  it("sums session-agent online time, clamped to the window, and excludes named/operator agents", () => {
    const { orgId } = setupOrg();
    const now = new Date();
    // The PRODUCTION format, deliberately: `created_at`/`ended_at` default to SQLite's
    // `datetime('now')` ("YYYY-MM-DD HH:MM:SS", space, no Z). An earlier version of this test wrote
    // `toISOString()` here, which agreed with the same mistake in src/org-usage.ts and so passed while
    // production excluded these rows -- the same dialect trap as the retention helper. The code now
    // matches the column, so the test must too.
    const sqliteAt = (ms: number) => toSqliteTime(ms);
    const sessionStart = sqliteAt(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
    const sessionEnd = sqliteAt(now.getTime() - 1 * 60 * 60 * 1000); // ended 1h ago -- a 1h session
    db.prepare(
      `INSERT INTO agents (id, org_id, name, url_key, api_key_hash, kind, created_at, ended_at) VALUES (?, ?, ?, ?, ?, 'session', ?, ?)`,
    ).run("sess-1", orgId, "ClaudeCode-Session", "sess-1", "session-hash-1", sessionStart, sessionEnd);

    const usage = getOrgUsageSummary(orgId);
    expect(usage.sessionAgentHours).toBeCloseTo(1, 1);

    // A named/operator agent's created_at->now "lifetime" is NOT counted as session time -- it has
    // no real session boundary, so counting it would wildly overstate usage for an always-on bot.
    const { orgId: orgId2 } = createOrganization("Usage Org Named");
    registerAgent(orgId2, "Always-On Bot", { role: "operator" });
    expect(getOrgUsageSummary(orgId2).sessionAgentHours).toBe(0);
  });
});
