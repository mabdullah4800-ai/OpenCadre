import { toSqliteTime } from "../src/timestamps.js";
import { describe, expect, it } from "vitest";
import { computeAgentState, type StateSignals } from "../src/agent-state.js";
import { heartbeat, listActiveAgents, createOrganization, registerAgent, setAgentStatus, askClarification } from "../src/service.js";
import { requestApproval } from "../src/approvals.js";
import { db } from "../src/db.js";

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const sqlite = (msAgo: number) => toSqliteTime(NOW - msAgo);
const base: StateSignals = {
  online: true, status: "active", phase: null, statusUpdatedAt: null,
  usageLimited: false, usageResetsAt: null, pendingApprovals: 0, openQuestions: 0,
};
const stateOf = (over: Partial<StateSignals>) => computeAgentState({ ...base, ...over }, NOW).state;

describe("computeAgentState", () => {
  it.each<[string, Partial<StateSignals>, string]>([
    ["no heartbeat", { online: false, phase: "editing", statusUpdatedAt: sqlite(60_000) }, "offline"],
    ["auto-suspended", { status: "paused" }, "offline"],
    ["out of usage beats working", { usageLimited: true, phase: "editing", statusUpdatedAt: sqlite(60_000) }, "blocked"],
    ["a pending approval beats out of usage (a person must act)", { usageLimited: true, pendingApprovals: 1 }, "waiting"],
    ["pending approval", { pendingApprovals: 1, phase: "editing", statusUpdatedAt: sqlite(60_000) }, "waiting"],
    ["open question", { openQuestions: 2 }, "waiting"],
    ["reported waiting recently", { phase: "waiting", statusUpdatedAt: sqlite(60_000) }, "waiting"],
    ["fresh working phase", { phase: "testing", statusUpdatedAt: sqlite(29 * 60_000) }, "working"],
    ["stale working phase", { phase: "testing", statusUpdatedAt: sqlite(31 * 60_000) }, "idle"],
    ["stale waiting phase", { phase: "waiting", statusUpdatedAt: sqlite(31 * 60_000) }, "idle"],
    ["connected, never reported", {}, "online"],
    ["reported a task with no phase", { statusUpdatedAt: sqlite(60_000) }, "idle"],
  ])("%s → %s", (_label, over, expected) => expect(stateOf(over)).toBe(expected));

  // THE SAME RULE, ON AN ISO TIMESTAMP. `agents.status_updated_at` is written by `datetime('now')`
  // today, so this path is LATENT rather than live — but a reader that always appends `Z` returns
  // NaN for an ISO value, and `now - NaN <= WORK_STALE_MS` is FALSE, so a FRESH agent reads as
  // stale. Measured against that naive form: the first of these returned "online" for a working
  // agent. Both pass now because src/timestamps.ts's parseStamp guards on the input's own shape.
  it("treats an ISO status_updated_at as fresh, not as NaN", () => {
    expect(stateOf({ phase: "testing", statusUpdatedAt: new Date(NOW - 60_000).toISOString() })).toBe("working");
  });

  it("treats an ISO status_updated_at past the stale window as stale, for the right reason", () => {
    // The other half: NaN would make this stale by accident. Pin that a genuinely old ISO value
    // lands on "idle" (the stale path) rather than on "online" (the never-reported path).
    expect(stateOf({ phase: "testing", statusUpdatedAt: new Date(NOW - 31 * 60_000).toISOString() })).toBe("idle");
  });

  it("explains the state in plain words", () => {
    expect(computeAgentState({ ...base, usageLimited: true, usageResetsAt: "2026-09-14T17:00:00Z" }, NOW).reason).toBe("out of usage until 2026-09-14T17:00:00Z");
    expect(computeAgentState({ ...base, phase: "reviewing", statusUpdatedAt: sqlite(1000) }, NOW).reason).toBe("reviewing");
    expect(computeAgentState({ ...base, usageLimited: true, usageResetsAt: "17:00", pendingApprovals: 1 }, NOW).reason).toBe(
      "waiting on 1 approval request(s); also out of usage until 17:00",
    );
  });
});

describe("fleet listing", () => {
  it("returns each agent's state from live signals", async () => {
    const { orgId } = createOrganization("State Org");
    const builder = registerAgent(orgId, "State-Builder");
    const asker = registerAgent(orgId, "State-Asker");
    const quiet = registerAgent(orgId, "State-Quiet");
    const target = registerAgent(orgId, "State-Target");
    heartbeat(orgId, builder.agentId);
    heartbeat(orgId, asker.agentId);
    heartbeat(orgId, target.agentId);
    setAgentStatus(orgId, builder.agentId, "shipping R1.4", ["src/agent-state.ts"], "editing");
    await requestApproval(orgId, { id: asker.agentId, name: "State-Asker" }, { action: "git push --force" });
    await askClarification(orgId, { id: target.agentId, name: "State-Target" }, "State-Asker", "ok?", 0);

    const byName = Object.fromEntries(listActiveAgents(orgId).map((a) => [a.name, a]));
    expect(byName["State-Builder"]).toMatchObject({ state: "working", state_reason: "editing" });
    expect(byName["State-Asker"]).toMatchObject({ state: "waiting" });
    expect(byName["State-Asker"].state_reason).toContain("approval");
    expect(byName["State-Target"]).toMatchObject({ state: "waiting" });
    expect(byName["State-Quiet"]).toMatchObject({ state: "offline" });
  });

  it("stops counting a question as waiting after a day", async () => {
    const { orgId } = createOrganization("Old Question Org");
    const asker = registerAgent(orgId, "Old-Asker");
    registerAgent(orgId, "Old-Target");
    heartbeat(orgId, asker.agentId);
    await askClarification(orgId, { id: asker.agentId, name: "Old-Asker" }, "Old-Target", "still there?", 0);
    expect(listActiveAgents(orgId).find((a) => a.name === "Old-Asker")).toMatchObject({ state: "waiting" });
    db.prepare(`UPDATE messages SET created_at = datetime('now', '-2 days') WHERE org_id = ?`).run(orgId);
    expect(listActiveAgents(orgId).find((a) => a.name === "Old-Asker")).toMatchObject({ state: "online" });
  });
});
