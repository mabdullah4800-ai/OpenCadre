import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { createOrganization, getAgentCapabilities, getAgentRoundBudget, registerAgent, setAgentCapabilities, setAgentRoundBudget } from "../src/service.js";
import { acceptTask, claimTask, completeTask, createTask, getTaskById, listTasks, rejectTask, releaseTask, renewClaim } from "../src/tasks.js";

function setupOrg(name = "Tasks Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  const c = registerAgent(orgId, "Agent C");
  return {
    orgId,
    a: { id: a.agentId, name: "Agent A", key: a.apiKey },
    b: { id: b.agentId, name: "Agent B", key: b.apiKey },
    c: { id: c.agentId, name: "Agent C", key: c.apiKey },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createTask / listTasks", () => {
  it("creates an open, unclaimed task visible to the org", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "Add login", description: "OAuth flow" });
    expect(task.status).toBe("open");
    expect(task.claimed_by_agent_id).toBeNull();
    expect(listTasks(orgId).map((t) => t.id)).toContain(task.id);
  });

  it("never lists another org's tasks", () => {
    const one = setupOrg("Org One");
    const two = setupOrg("Org Two");
    const task = createTask(one.orgId, one.a, { title: "private" });
    expect(listTasks(two.orgId).map((t) => t.id)).not.toContain(task.id);
  });

  it("rejects an empty title", () => {
    const { orgId, a } = setupOrg();
    expect(() => createTask(orgId, a, { title: "  " })).toThrow(/title/);
  });
});

describe("getTaskById", () => {
  it("returns the full, untruncated task for any agent in the org, whether or not they hold it", () => {
    const { orgId, a, b } = setupOrg();
    const longDescription = "x".repeat(500);
    const task = createTask(orgId, a, { title: "Investigate", description: longDescription });
    const read = getTaskById(orgId, b, task.id);
    expect(read?.description).toBe(longDescription);
    expect(read?.status).toBe("open");
  });

  it("returns undefined for an id that doesn't exist", () => {
    const { orgId, a } = setupOrg();
    expect(getTaskById(orgId, a, "not-a-real-id")).toBeUndefined();
  });

  it("never leaks another org's task", () => {
    const one = setupOrg("GetTask Org One");
    const two = setupOrg("GetTask Org Two");
    const task = createTask(one.orgId, one.a, { title: "private", description: "secret" });
    expect(getTaskById(two.orgId, two.a, task.id)).toBeUndefined();
  });
});

describe("claimTask", () => {
  it("lets one agent claim and blocks a second agent while the lease is active", () => {
    const { orgId, a, b } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });

    const first = claimTask(orgId, a, task.id, 60);
    expect(first.ok).toBe(true);

    const second = claimTask(orgId, b, task.id, 60);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/Agent A/);

    const listed = listTasks(orgId).find((t) => t.id === task.id)!;
    expect(listed.status).toBe("claimed");
    expect(listed.claimed_by_agent_name).toBe("Agent A");
    expect(listed.lease_active).toBe(true);
  });

  it("is idempotent for the current holder", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    expect(claimTask(orgId, a, task.id, 60).ok).toBe(true);
    expect(claimTask(orgId, a, task.id, 60).ok).toBe(true);
  });

  it("lets another agent take over once the lease expires", async () => {
    const { orgId, a, b } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    expect(claimTask(orgId, a, task.id, 0.2).ok).toBe(true);
    await sleep(300);

    const stale = listTasks(orgId).find((t) => t.id === task.id)!;
    expect(stale.lease_active).toBe(false);

    const takeover = claimTask(orgId, b, task.id, 60);
    expect(takeover.ok).toBe(true);
    expect(listTasks(orgId).find((t) => t.id === task.id)!.claimed_by_agent_name).toBe("Agent B");
  });

  it("refuses to claim a completed task or a task from another org", () => {
    const { orgId, a } = setupOrg();
    const other = setupOrg("Other Org");
    const task = createTask(orgId, a, { title: "t" });
    claimTask(orgId, a, task.id, 60);
    completeTask(orgId, a, task.id, "shipped");
    expect(claimTask(orgId, a, task.id, 60).ok).toBe(false);
    expect(claimTask(other.orgId, other.a, task.id, 60).ok).toBe(false);
  });

  it("rejects out-of-range lease lengths", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    expect(claimTask(orgId, a, task.id, 0).ok).toBe(false);
    expect(claimTask(orgId, a, task.id, 7 * 24 * 3600).ok).toBe(false);
  });
});

describe("claimTask: required capabilities (design retro -- catch the gap at claim time)", () => {
  it("refuses a claim missing a required capability, and names the missing one", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "audit -> fix -> commit", requiredCapabilities: ["shell", "git-write"] });
    const claim = claimTask(orgId, a, task.id, 60);
    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.error).toContain("shell");
    expect(claim.error).toContain("git-write");
    expect(listTasks(orgId).find((t) => t.id === task.id)!.status).toBe("open"); // no partial claim
  });

  it("allows a claim once the agent has declared every required capability", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "audit -> fix -> commit", requiredCapabilities: ["shell", "git-write"] });
    setAgentCapabilities(orgId, a.id, ["shell", "git-write", "file-write"]); // extra declared capabilities are fine
    expect(claimTask(orgId, a, task.id, 60).ok).toBe(true);
  });

  it("refuses a claim missing only one of several required capabilities", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t", requiredCapabilities: ["shell", "git-write"] });
    setAgentCapabilities(orgId, a.id, ["shell"]);
    const claim = claimTask(orgId, a, task.id, 60);
    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.error).toContain("git-write");
    expect(claim.error).not.toContain("shell"); // shell isn't listed as missing -- the agent already has it
  });

  it("a task with no required capabilities can be claimed by an agent with none declared -- every task before this feature keeps working", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    expect(getAgentCapabilities(orgId, a.id)).toEqual([]);
    expect(claimTask(orgId, a, task.id, 60).ok).toBe(true);
  });

  it("renewing your own existing claim never re-checks capabilities, even if you'd fail the check now", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t", requiredCapabilities: ["shell"] });
    setAgentCapabilities(orgId, a.id, ["shell"]);
    expect(claimTask(orgId, a, task.id, 60).ok).toBe(true);
    // Same holder re-claiming (renewal) must succeed even after losing the capability -- it's a
    // lease extension on work already legitimately claimed, not a fresh claim.
    setAgentCapabilities(orgId, a.id, []);
    expect(claimTask(orgId, a, task.id, 120).ok).toBe(true);
  });

  it("a takeover from a lapsed lease IS re-checked -- it's a fresh claim by a possibly-different agent", async () => {
    const { orgId, a, b } = setupOrg();
    const task = createTask(orgId, a, { title: "t", requiredCapabilities: ["shell"] });
    setAgentCapabilities(orgId, a.id, ["shell"]);
    expect(claimTask(orgId, a, task.id, 0.2).ok).toBe(true);
    await sleep(300);
    // Agent B never declared "shell" -- the takeover must be refused even though the lease lapsed.
    const takeover = claimTask(orgId, b, task.id, 60);
    expect(takeover.ok).toBe(false);
  });

  it("setAgentCapabilities replaces the whole list, not a merge", () => {
    const { orgId, a } = setupOrg();
    setAgentCapabilities(orgId, a.id, ["shell", "git-write"]);
    setAgentCapabilities(orgId, a.id, ["file-write"]);
    expect(getAgentCapabilities(orgId, a.id)).toEqual(["file-write"]);
  });
});

describe("createTask: minRoundBudget input validation", () => {
  it("rejects a non-positive or non-finite minRoundBudget", () => {
    const { orgId, a } = setupOrg();
    expect(() => createTask(orgId, a, { title: "t", minRoundBudget: 0 })).toThrow(/minRoundBudget/);
    expect(() => createTask(orgId, a, { title: "t", minRoundBudget: -5 })).toThrow(/minRoundBudget/);
    expect(() => createTask(orgId, a, { title: "t", minRoundBudget: NaN })).toThrow(/minRoundBudget/);
  });

  it("truncates a fractional minRoundBudget to an integer", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t", minRoundBudget: 12.9 });
    expect(task.min_round_budget).toBe(12);
  });
});

describe("claimTask: cost-aware round-budget routing (Stage 1 retro finding)", () => {
  it("refuses a claim from an agent who never declared a round budget -- unknown fails closed, like undeclared capabilities", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "deep refactor", minRoundBudget: 40 });
    expect(getAgentRoundBudget(orgId, a.id)).toBeNull();
    const claim = claimTask(orgId, a, task.id, 60);
    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.error).toContain("40");
    expect(listTasks(orgId).find((t) => t.id === task.id)!.status).toBe("open");
  });

  it("refuses a claim whose declared budget is below the task's minimum, naming both numbers", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t", minRoundBudget: 40 });
    setAgentRoundBudget(orgId, a.id, 12);
    const claim = claimTask(orgId, a, task.id, 60);
    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.error).toContain("40");
    expect(claim.error).toContain("12");
  });

  it("allows a claim once the declared budget meets or exceeds the minimum", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t", minRoundBudget: 40 });
    setAgentRoundBudget(orgId, a.id, 40);
    expect(claimTask(orgId, a, task.id, 60).ok).toBe(true);
  });

  it("a task with no minRoundBudget can be claimed by an agent with none declared -- every task before this feature keeps working", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    expect(getAgentRoundBudget(orgId, a.id)).toBeNull();
    expect(claimTask(orgId, a, task.id, 60).ok).toBe(true);
  });

  it("renewing your own existing claim never re-checks round budget", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t", minRoundBudget: 40 });
    setAgentRoundBudget(orgId, a.id, 40);
    expect(claimTask(orgId, a, task.id, 60).ok).toBe(true);
    setAgentRoundBudget(orgId, a.id, 5); // budget drops mid-task
    expect(claimTask(orgId, a, task.id, 120).ok).toBe(true); // renewal still succeeds
  });

  it("a takeover from a lapsed lease IS re-checked against round budget", async () => {
    const { orgId, a, b } = setupOrg();
    const task = createTask(orgId, a, { title: "t", minRoundBudget: 40 });
    setAgentRoundBudget(orgId, a.id, 40);
    expect(claimTask(orgId, a, task.id, 0.2).ok).toBe(true);
    await sleep(300);
    const takeover = claimTask(orgId, b, task.id, 60); // Agent B never declared a budget
    expect(takeover.ok).toBe(false);
  });

  it("setAgentRoundBudget rejects a non-positive value but allows clearing to null", () => {
    const { orgId, a } = setupOrg();
    expect(setAgentRoundBudget(orgId, a.id, 0).ok).toBe(false);
    expect(setAgentRoundBudget(orgId, a.id, -3).ok).toBe(false);
    setAgentRoundBudget(orgId, a.id, 20);
    expect(getAgentRoundBudget(orgId, a.id)).toBe(20);
    const cleared = setAgentRoundBudget(orgId, a.id, null);
    expect(cleared.ok).toBe(true);
    expect(getAgentRoundBudget(orgId, a.id)).toBeNull();
  });
});

describe("renewClaim / releaseTask / completeTask", () => {
  it("renewal extends the lease only for the holder", async () => {
    const { orgId, a, b } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    claimTask(orgId, a, task.id, 0.3);
    expect(renewClaim(orgId, b, task.id, 60).ok).toBe(false);
    expect(renewClaim(orgId, a, task.id, 60).ok).toBe(true);
    await sleep(400);
    expect(listTasks(orgId).find((t) => t.id === task.id)!.lease_active).toBe(true);
  });

  it("the holder can still renew after expiry if nobody else took it", async () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    claimTask(orgId, a, task.id, 0.2);
    await sleep(300);
    expect(renewClaim(orgId, a, task.id, 60).ok).toBe(true);
  });

  it("release returns the task to open; only the holder may release", () => {
    const { orgId, a, b } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    claimTask(orgId, a, task.id, 60);
    expect(releaseTask(orgId, b, task.id).ok).toBe(false);
    expect(releaseTask(orgId, a, task.id).ok).toBe(true);
    const listed = listTasks(orgId).find((t) => t.id === task.id)!;
    expect(listed.status).toBe("open");
    expect(listed.claimed_by_agent_id).toBeNull();
    expect(claimTask(orgId, b, task.id, 60).ok).toBe(true);
  });

  it("completion requires holding the claim and records a summary", () => {
    const { orgId, a, b } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    expect(completeTask(orgId, a, task.id, "nope").ok).toBe(false);
    claimTask(orgId, a, task.id, 60);
    expect(completeTask(orgId, b, task.id, "not mine").ok).toBe(false);
    expect(completeTask(orgId, a, task.id, "merged PR #12").ok).toBe(true);
    const listed = listTasks(orgId).find((t) => t.id === task.id)!;
    expect(listed.status).toBe("done");
    expect(listed.completion_summary).toBe("merged PR #12");
    expect(listed.lease_active).toBe(false);
  });

  it("filters by status", () => {
    const { orgId, a } = setupOrg();
    const open = createTask(orgId, a, { title: "open one" });
    const done = createTask(orgId, a, { title: "done one" });
    claimTask(orgId, a, done.id, 60);
    completeTask(orgId, a, done.id, "ok");
    expect(listTasks(orgId, { status: "open" }).map((t) => t.id)).toEqual([open.id]);
    expect(listTasks(orgId, { status: "done" }).map((t) => t.id)).toEqual([done.id]);
  });
});

describe("acceptTask / rejectTask (second pair of eyes)", () => {
  function doneTask(orgId: string, claimant: { id: string; name: string }, title = "t") {
    const task = createTask(orgId, claimant, { title });
    claimTask(orgId, claimant, task.id, 60);
    completeTask(orgId, claimant, task.id, "shipped");
    return task.id;
  }

  it("a distinct agent accepts a done task, setting reviewed and recording who", () => {
    const { orgId, a, b } = setupOrg();
    const taskId = doneTask(orgId, a);

    const result = acceptTask(orgId, b, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.reviewed).toBeTruthy();
    expect(result.task.reviewed_by_agent_name).toBe("Agent B");
    expect(result.task.status).toBe("done");

    const listed = listTasks(orgId).find((t) => t.id === taskId)!;
    expect(listed.reviewed).toBeTruthy();
  });

  it("accept is terminal: accepting an already-accepted task fails", () => {
    const { orgId, a, b, c } = setupOrg();
    const taskId = doneTask(orgId, a);
    expect(acceptTask(orgId, b, taskId).ok).toBe(true);
    const second = acceptTask(orgId, c, taskId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already been accepted/);
  });

  it("rejects a done task back to claimed with a note, and clears reviewed", () => {
    const { orgId, a, b } = setupOrg();
    const taskId = doneTask(orgId, a);

    const result = rejectTask(orgId, b, taskId, "tests are missing");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe("claimed");
    expect(result.task.reviewed).toBeFalsy();
    expect(result.task.review_note).toBe("tests are missing");
    // The claimant keeps their slot: lease restored, same claimant, re-completable without reclaiming.
    expect(result.task.claimed_by_agent_id).toBe(a.id);
    expect(result.task.lease_active).toBe(true);

    // The claimant can fix and re-complete without an explicit claim_task call -- the lease was restored, not dropped.
    const recompleted = completeTask(orgId, a, taskId, "fixed, tests added");
    expect(recompleted.ok).toBe(true);
    if (!recompleted.ok) return;
    expect(recompleted.task.status).toBe("done");
    // A fresh completion clears the old rejection note -- it doesn't linger once superseded.
    expect(recompleted.task.review_note).toBeNull();
    expect(recompleted.task.reviewed).toBeFalsy();
  });

  it("rejecting without a note still moves the task back to claimed", () => {
    const { orgId, a, b } = setupOrg();
    const taskId = doneTask(orgId, a);
    const result = rejectTask(orgId, b, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe("claimed");
    expect(result.task.review_note).toBeNull();
  });

  it("self-review is refused: the claimant cannot accept or reject their own completed task", () => {
    const { orgId, a } = setupOrg();
    const taskId = doneTask(orgId, a);

    const acceptSelf = acceptTask(orgId, a, taskId);
    expect(acceptSelf.ok).toBe(false);
    if (!acceptSelf.ok) expect(acceptSelf.error).toMatch(/yourself/);

    const rejectSelf = rejectTask(orgId, a, taskId, "not good enough");
    expect(rejectSelf.ok).toBe(false);
    if (!rejectSelf.ok) expect(rejectSelf.error).toMatch(/yourself/);

    // Neither refused call should have changed anything.
    const listed = listTasks(orgId).find((t) => t.id === taskId)!;
    expect(listed.status).toBe("done");
    expect(listed.reviewed).toBeFalsy();
  });

  it("refuses to review a task that isn't done yet", () => {
    const { orgId, a, b } = setupOrg();
    const task = createTask(orgId, a, { title: "still open" });
    const result = acceptTask(orgId, b, task.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not done yet/);
  });

  it("never lets an agent in another org accept or reject a task", () => {
    const { orgId, a } = setupOrg("Review Org One");
    const other = setupOrg("Review Org Two");
    const taskId = doneTask(orgId, a);

    const acceptCross = acceptTask(other.orgId, other.b, taskId);
    expect(acceptCross.ok).toBe(false);
    if (!acceptCross.ok) expect(acceptCross.error).toMatch(/No task found/);

    const rejectCross = rejectTask(other.orgId, other.b, taskId, "nope");
    expect(rejectCross.ok).toBe(false);
    if (!rejectCross.ok) expect(rejectCross.error).toMatch(/No task found/);

    // The task is untouched in its real org.
    const listed = listTasks(orgId).find((t) => t.id === taskId)!;
    expect(listed.status).toBe("done");
    expect(listed.reviewed).toBeFalsy();
  });
});

describe("acceptTask: redundant adversarial verification (requiredReviews > 1)", () => {
  function doneTaskWithReviews(orgId: string, claimant: { id: string; name: string }, requiredReviews: number) {
    const task = createTask(orgId, claimant, { title: "load-bearing claim", requiredReviews });
    claimTask(orgId, claimant, task.id, 60);
    completeTask(orgId, claimant, task.id, "shipped");
    return task.id;
  }

  it("defaults required_reviews to 1 -- every task predating this feature behaves exactly as before", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    expect(task.required_reviews).toBe(1);
  });

  it("rejects a non-positive or non-integer requiredReviews", () => {
    const { orgId, a } = setupOrg();
    expect(() => createTask(orgId, a, { title: "t", requiredReviews: 0 })).toThrow(/requiredReviews/);
    expect(() => createTask(orgId, a, { title: "t", requiredReviews: -1 })).toThrow(/requiredReviews/);
    expect(() => createTask(orgId, a, { title: "t", requiredReviews: NaN })).toThrow(/requiredReviews/);
  });

  it("a single accept on a requiredReviews=2 task records the vote but does NOT finalize", () => {
    const { orgId, a, b } = setupOrg();
    const taskId = doneTaskWithReviews(orgId, a, 2);

    const result = acceptTask(orgId, b, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.reviewed).toBeFalsy(); // NOT finalized -- only 1 of 2 required
    expect(result.task.review_count).toBe(1);
    expect(result.task.required_reviews).toBe(2);
    expect(result.task.status).toBe("done"); // still done, just not yet reviewed

    // Not yet claimable/re-doable -- it's still correctly "done", awaiting the second review.
    const listed = listTasks(orgId).find((t) => t.id === taskId)!;
    expect(listed.reviewed).toBeFalsy();
  });

  it("a second, DISTINCT reviewer's accept finalizes it", () => {
    const { orgId, a, b, c } = setupOrg();
    const taskId = doneTaskWithReviews(orgId, a, 2);
    acceptTask(orgId, b, taskId);
    const result = acceptTask(orgId, c, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.reviewed).toBeTruthy();
    expect(result.task.reviewed_by_agent_name).toBe("Agent C"); // the vote that tipped it over
    expect(result.task.review_count).toBe(2);
  });

  it("the SAME reviewer accepting twice counts once, not twice -- redundancy means independent agents", () => {
    const { orgId, a, b } = setupOrg();
    const taskId = doneTaskWithReviews(orgId, a, 2);
    acceptTask(orgId, b, taskId);
    const second = acceptTask(orgId, b, taskId); // same reviewer, same task, same round
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.task.review_count).toBe(1); // still 1, not 2
    expect(second.task.reviewed).toBeFalsy(); // still short of the 2 required
  });

  it("a single reject bounces the task back immediately, even with a vote already cast toward requiredReviews", () => {
    const { orgId, a, b, c } = setupOrg();
    const taskId = doneTaskWithReviews(orgId, a, 2);
    acceptTask(orgId, b, taskId); // 1 of 2 votes cast
    const rejected = rejectTask(orgId, c, taskId, "found a real problem");
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.task.status).toBe("claimed"); // bounced back, no consensus needed to reject

    // The next completion round starts with a clean slate -- b's earlier vote does NOT carry over.
    completeTask(orgId, a, taskId, "fixed");
    const fresh = getTaskById(orgId, a, taskId)!;
    expect(fresh.review_count).toBe(0);
    const bAcceptsAgain = acceptTask(orgId, b, taskId);
    expect(bAcceptsAgain.ok).toBe(true);
    if (!bAcceptsAgain.ok) return;
    expect(bAcceptsAgain.task.review_count).toBe(1); // fresh round, fresh count
    expect(bAcceptsAgain.task.reviewed).toBeFalsy(); // still needs a second, independent accept
  });

  it("never leaks another org's review votes toward this task's threshold", () => {
    const { orgId, a } = setupOrg("Adversarial Review Org One");
    const other = setupOrg("Adversarial Review Org Two");
    const taskId = doneTaskWithReviews(orgId, a, 2);
    // Cross-org accept is refused entirely (same as the existing cross-org test above) -- confirming
    // it can't even partially record a vote against a task it can't see.
    const crossAccept = acceptTask(other.orgId, other.b, taskId);
    expect(crossAccept.ok).toBe(false);
    const stillZero = getTaskById(orgId, a, taskId)!;
    expect(stillZero.review_count).toBe(0);
  });
});

describe("REST /v1/tasks", () => {
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

  it("create → claim → conflict → complete round-trip", async () => {
    const { a, b } = setupOrg("REST Tasks Org");

    const created = await call(a.key, "POST", "/v1/tasks", { title: "Wire dashboard" });
    expect(created.status).toBe(201);
    const { task } = (await created.json()) as { task: { id: string } };

    expect((await call(a.key, "POST", `/v1/tasks/${task.id}/claim`, { leaseSeconds: 120 })).status).toBe(200);
    const conflict = await call(b.key, "POST", `/v1/tasks/${task.id}/claim`, {});
    expect(conflict.status).toBe(409);

    const listed = (await (await call(b.key, "GET", "/v1/tasks?status=claimed")).json()) as { tasks: Array<{ id: string }> };
    expect(listed.tasks.map((t) => t.id)).toContain(task.id);

    expect((await call(a.key, "POST", `/v1/tasks/${task.id}/complete`, { summary: "done" })).status).toBe(200);
  });

  it("requires a title", async () => {
    const { a } = setupOrg("REST Tasks Org 2");
    expect((await call(a.key, "POST", "/v1/tasks", {})).status).toBe(400);
  });

  it("GET /v1/tasks/:taskId returns the full task, 404 for an unknown id or another org's task", async () => {
    const { a, b } = setupOrg("REST Get Task Org");
    const other = setupOrg("REST Get Task Org Other");
    const longDescription = "y".repeat(500);
    const created = await call(a.key, "POST", "/v1/tasks", { title: "Full read test", description: longDescription });
    const { task } = (await created.json()) as { task: { id: string } };

    const got = await call(b.key, "GET", `/v1/tasks/${task.id}`);
    expect(got.status).toBe(200);
    const { task: full } = (await got.json()) as { task: { description: string } };
    expect(full.description).toBe(longDescription);

    expect((await call(a.key, "GET", "/v1/tasks/not-a-real-id")).status).toBe(404);
    expect((await call(other.a.key, "GET", `/v1/tasks/${task.id}`)).status).toBe(404);
  });

  it("accept → reject round-trip: self-review refused (409), a distinct agent's reject sends it back to claimed", async () => {
    const { a, b } = setupOrg("REST Review Org");

    const created = await call(a.key, "POST", "/v1/tasks", { title: "Ship review feature" });
    const { task } = (await created.json()) as { task: { id: string } };
    expect((await call(a.key, "POST", `/v1/tasks/${task.id}/claim`, {})).status).toBe(200);
    expect((await call(a.key, "POST", `/v1/tasks/${task.id}/complete`, { summary: "done" })).status).toBe(200);

    // The claimant reviewing their own work is refused, not silently allowed.
    const selfAccept = await call(a.key, "POST", `/v1/tasks/${task.id}/accept`, {});
    expect(selfAccept.status).toBe(409);

    const rejected = await call(b.key, "POST", `/v1/tasks/${task.id}/reject`, { note: "missing tests" });
    expect(rejected.status).toBe(200);
    const { task: rejectedTask } = (await rejected.json()) as { task: { status: string; review_note: string; reviewed: number } };
    expect(rejectedTask.status).toBe("claimed");
    expect(rejectedTask.review_note).toBe("missing tests");
    expect(rejectedTask.reviewed).toBeFalsy();

    // Fix and re-complete, then a distinct agent accepts it for real.
    expect((await call(a.key, "POST", `/v1/tasks/${task.id}/complete`, { summary: "fixed" })).status).toBe(200);
    const accepted = await call(b.key, "POST", `/v1/tasks/${task.id}/accept`, {});
    expect(accepted.status).toBe(200);
    const { task: acceptedTask } = (await accepted.json()) as { task: { reviewed: number } };
    expect(acceptedTask.reviewed).toBeTruthy();
  });

  it("never lets another org's agent accept or reject a task (404, not a cross-tenant 409)", async () => {
    const { a } = setupOrg("REST Isolation Org One");
    const other = setupOrg("REST Isolation Org Two");

    const created = await call(a.key, "POST", "/v1/tasks", { title: "private work" });
    const { task } = (await created.json()) as { task: { id: string } };
    await call(a.key, "POST", `/v1/tasks/${task.id}/claim`, {});
    await call(a.key, "POST", `/v1/tasks/${task.id}/complete`, { summary: "done" });

    expect((await call(other.a.key, "POST", `/v1/tasks/${task.id}/accept`, {})).status).toBe(404);
    expect((await call(other.a.key, "POST", `/v1/tasks/${task.id}/reject`, { note: "x" })).status).toBe(404);

    // Untouched from inside its real org.
    const listed = (await (await call(a.key, "GET", "/v1/tasks?status=done")).json()) as { tasks: Array<{ id: string; reviewed: number }> };
    expect(listed.tasks.find((t) => t.id === task.id)?.reviewed).toBeFalsy();
  });
});

describe("task hierarchy: plan -> execute -> verify -> synthesize (subtasks)", () => {
  it("a task with no parentTaskId is top-level, exactly as before this feature -- parent_task_id null, no subtasks", () => {
    const { orgId, a } = setupOrg();
    const task = createTask(orgId, a, { title: "t" });
    expect(task.parent_task_id).toBeNull();
    expect(task.subtask_count).toBe(0);
    expect(task.subtasks_done).toBe(0);
  });

  it("creating a subtask stamps parent_task_id, and the parent's subtask_count reflects it", () => {
    const { orgId, a } = setupOrg();
    const parent = createTask(orgId, a, { title: "parent plan" });
    const child = createTask(orgId, a, { title: "step 1", parentTaskId: parent.id });
    expect(child.parent_task_id).toBe(parent.id);

    const reread = getTaskById(orgId, a, parent.id)!;
    expect(reread.subtask_count).toBe(1);
    expect(reread.subtasks_done).toBe(0);
  });

  it("rejects a parentTaskId that doesn't exist", () => {
    const { orgId, a } = setupOrg();
    expect(() => createTask(orgId, a, { title: "t", parentTaskId: "not-a-real-id" })).toThrow(/parentTaskId/);
  });

  it("never lets a task adopt another org's task as its parent", () => {
    const { orgId, a } = setupOrg("Hierarchy Org One");
    const other = setupOrg("Hierarchy Org Two");
    const foreignParent = createTask(other.orgId, other.a, { title: "not yours" });
    expect(() => createTask(orgId, a, { title: "t", parentTaskId: foreignParent.id })).toThrow(/parentTaskId/);
  });

  it("blocks the parent's completeTask while a subtask is still open/claimed (not done)", () => {
    const { orgId, a } = setupOrg();
    const parent = createTask(orgId, a, { title: "parent" });
    createTask(orgId, a, { title: "child", parentTaskId: parent.id }); // still open, never claimed
    claimTask(orgId, a, parent.id, 60);
    const result = completeTask(orgId, a, parent.id, "done");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/subtask/);
  });

  it("blocks the parent's completeTask while a subtask is done but NOT yet reviewed -- execute isn't verify", () => {
    const { orgId, a } = setupOrg();
    const parent = createTask(orgId, a, { title: "parent" });
    const child = createTask(orgId, a, { title: "child", parentTaskId: parent.id });
    claimTask(orgId, a, child.id, 60);
    completeTask(orgId, a, child.id, "shipped"); // done, but nobody has accepted it yet
    claimTask(orgId, a, parent.id, 60);
    const result = completeTask(orgId, a, parent.id, "done");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/subtask/);
  });

  it("allows the parent's completeTask once every subtask is done AND accepted -- synthesize only after execute+verify", () => {
    const { orgId, a, b } = setupOrg();
    const parent = createTask(orgId, a, { title: "parent" });
    const child = createTask(orgId, a, { title: "real child", parentTaskId: parent.id });
    claimTask(orgId, a, child.id, 60);
    completeTask(orgId, a, child.id, "shipped");
    acceptTask(orgId, b, child.id);

    claimTask(orgId, a, parent.id, 60);
    const result = completeTask(orgId, a, parent.id, "all steps done");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe("done");
    expect(result.task.subtask_count).toBe(1);
    expect(result.task.subtasks_done).toBe(1);
  });

  it("requires EVERY subtask done+accepted, not just some of them", () => {
    const { orgId, a, b, c } = setupOrg();
    const parent = createTask(orgId, a, { title: "parent" });
    const child1 = createTask(orgId, a, { title: "step 1", parentTaskId: parent.id });
    const child2 = createTask(orgId, a, { title: "step 2", parentTaskId: parent.id });
    claimTask(orgId, a, child1.id, 60);
    completeTask(orgId, a, child1.id, "done 1");
    acceptTask(orgId, b, child1.id); // only child1 finished

    claimTask(orgId, a, parent.id, 60);
    const tooEarly = completeTask(orgId, a, parent.id, "premature");
    expect(tooEarly.ok).toBe(false);
    if (!tooEarly.ok) expect(tooEarly.error).toContain("1 subtask");

    claimTask(orgId, a, child2.id, 60);
    completeTask(orgId, a, child2.id, "done 2");
    acceptTask(orgId, c, child2.id); // now both finished

    const now = completeTask(orgId, a, parent.id, "all done");
    expect(now.ok).toBe(true);
  });

  it("a subtask can itself have subtasks -- nesting has no depth limit", () => {
    const { orgId, a, b } = setupOrg();
    const grandparent = createTask(orgId, a, { title: "grandparent" });
    const parent = createTask(orgId, a, { title: "parent", parentTaskId: grandparent.id });
    const child = createTask(orgId, a, { title: "child", parentTaskId: parent.id });

    // The parent itself can't complete until ITS child (the grandchild of the top) is done+accepted.
    claimTask(orgId, a, parent.id, 60);
    expect(completeTask(orgId, a, parent.id, "too early").ok).toBe(false);

    claimTask(orgId, a, child.id, 60);
    completeTask(orgId, a, child.id, "leaf done");
    acceptTask(orgId, b, child.id);
    expect(completeTask(orgId, a, parent.id, "now ready").ok).toBe(true);

    // The grandparent, in turn, can't complete until the parent (already done above) is ALSO accepted.
    claimTask(orgId, a, grandparent.id, 60);
    const stillBlocked = completeTask(orgId, a, grandparent.id, "too early too");
    expect(stillBlocked.ok).toBe(false);
    acceptTask(orgId, b, parent.id);
    expect(completeTask(orgId, a, grandparent.id, "whole plan done").ok).toBe(true);
  });
});
