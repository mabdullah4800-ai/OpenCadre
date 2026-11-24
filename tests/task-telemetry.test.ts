import { describe, expect, it } from "vitest";
import { createOrganization, registerAgent, setAgentCapabilities } from "../src/service.js";
import { acceptTask, claimTask, completeTask, createTask, rejectTask } from "../src/tasks.js";
import { getTaskShapeStats } from "../src/task-telemetry.js";

function setupOrg(name = "Telemetry Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  // Declared broadly so claimTask's capability gate (src/tasks.ts, an earlier feature) never blocks
  // these tests' capability-scoped tasks -- this suite is about shape telemetry, not that gate.
  setAgentCapabilities(orgId, a.agentId, ["shell", "git", "git-write", "gpu", "only-in-org-one", "distinctive-cap-marker"]);
  return {
    orgId,
    a: { id: a.agentId, name: "Agent A" },
    b: { id: b.agentId, name: "Agent B" },
  };
}

/** claimTask + completeTask, asserting both succeed -- a silent claim/complete failure (e.g. a
 * missing declared capability) must fail the test loudly, not quietly leave the task un-done and
 * make an assertion further down fail with a confusing "got []" instead of the real cause. */
function finishTask(orgId: string, agent: { id: string; name: string }, taskId: string) {
  const claimed = claimTask(orgId, agent, taskId, 60);
  if (!claimed.ok) throw new Error(`setup: claim failed for ${taskId}: ${claimed.error}`);
  const completed = completeTask(orgId, agent, taskId, "done");
  if (!completed.ok) throw new Error(`setup: complete failed for ${taskId}: ${completed.error}`);
}

describe("getTaskShapeStats", () => {
  it("is empty with no completed tasks", () => {
    const { orgId } = setupOrg();
    expect(getTaskShapeStats(orgId)).toEqual([]);
  });

  it("groups a task with no required capabilities under the empty shape", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    finishTask(orgId, a, task.id);
    const stats = getTaskShapeStats(orgId);
    expect(stats).toHaveLength(1);
    expect(stats[0].shape).toEqual([]);
    expect(stats[0].completedCount).toBe(1);
  });

  it("groups tasks with the same capability set together regardless of insertion order", () => {
    const { orgId, a } = setupOrg();
    const t1 = createTask(orgId, a, { title: "t1", requiredCapabilities: ["shell", "git"] });
    const t2 = createTask(orgId, a, { title: "t2", requiredCapabilities: ["git", "shell"] }); // same set, different order
    finishTask(orgId, a, t1.id);
    finishTask(orgId, a, t2.id);
    const stats = getTaskShapeStats(orgId);
    expect(stats).toHaveLength(1);
    expect(stats[0].shape).toEqual(["git", "shell"]); // sorted, canonical
    expect(stats[0].completedCount).toBe(2);
  });

  it("keeps different capability sets as distinct shapes", () => {
    const { orgId, a } = setupOrg();
    const t1 = createTask(orgId, a, { title: "t1", requiredCapabilities: ["shell"] });
    const t2 = createTask(orgId, a, { title: "t2", requiredCapabilities: ["git-write"] });
    finishTask(orgId, a, t1.id);
    finishTask(orgId, a, t2.id);
    expect(getTaskShapeStats(orgId)).toHaveLength(2);
  });

  it("never counts an open or claimed (not yet done) task", () => {
    const { orgId, a } = setupOrg();
    createTask(orgId, a, { title: "still open" });
    const claimed = createTask(orgId, a, { title: "claimed only" });
    expect(claimTask(orgId, a, claimed.id, 60).ok).toBe(true);
    expect(getTaskShapeStats(orgId)).toEqual([]);
  });

  it("computes accept/reject counts and rate for a shape, from real review events", () => {
    const { orgId, a, b } = setupOrg();
    const t1 = createTask(orgId, a, { title: "t1", requiredCapabilities: ["shell"] });
    finishTask(orgId, a, t1.id);
    expect(acceptTask(orgId, b, t1.id).ok).toBe(true);

    const t2 = createTask(orgId, a, { title: "t2", requiredCapabilities: ["shell"] });
    finishTask(orgId, a, t2.id);
    expect(rejectTask(orgId, b, t2.id, "not quite").ok).toBe(true);

    const stats = getTaskShapeStats(orgId);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ accepted: 1, rejected: 1, acceptRate: 0.5 });
  });

  it("acceptRate is null with no review history for a shape, distinct from 0", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    finishTask(orgId, a, task.id); // done, but never reviewed
    const stats = getTaskShapeStats(orgId);
    expect(stats[0].acceptRate).toBeNull();
  });

  it("sorts most-completed shape first", () => {
    const { orgId, a } = setupOrg();
    const popular = [createTask(orgId, a, { title: "p1", requiredCapabilities: ["shell"] }), createTask(orgId, a, { title: "p2", requiredCapabilities: ["shell"] })];
    const rare = createTask(orgId, a, { title: "r1", requiredCapabilities: ["gpu"] });
    for (const t of [...popular, rare]) finishTask(orgId, a, t.id);
    const stats = getTaskShapeStats(orgId);
    expect(stats[0].shape).toEqual(["shell"]);
    expect(stats[0].completedCount).toBe(2);
  });

  it("never leaks another org's completed tasks into this org's stats", () => {
    const one = setupOrg("Telemetry Org One");
    const two = setupOrg("Telemetry Org Two");
    const task = createTask(one.orgId, one.a, { title: "t", requiredCapabilities: ["only-in-org-one"] });
    finishTask(one.orgId, one.a, task.id);
    expect(getTaskShapeStats(two.orgId)).toEqual([]);
  });
});
