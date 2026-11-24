import { describe, expect, it } from "vitest";
import { createOrganization, registerAgent } from "../src/service.js";
import { acceptTask, claimTask, completeTask, createTask, rejectTask } from "../src/tasks.js";
import { getAgentReliability, listAgentReliability } from "../src/reliability.js";

function setupOrg(name = "Reliability Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return {
    orgId,
    a: { id: a.agentId, name: "Agent A" },
    b: { id: b.agentId, name: "Agent B" },
  };
}

function completeAndReview(orgId: string, claimant: { id: string; name: string }, reviewer: { id: string; name: string }, outcome: "accept" | "reject") {
  const task = createTask(orgId, claimant, { title: `t-${Math.random()}` });
  claimTask(orgId, claimant, task.id, 60);
  completeTask(orgId, claimant, task.id, "done");
  return outcome === "accept" ? acceptTask(orgId, reviewer, task.id) : rejectTask(orgId, reviewer, task.id, "not quite");
}

describe("getAgentReliability", () => {
  it("is 0/0/null for an agent with no reviewed tasks yet -- no history is distinct from 0% reliable", () => {
    const { orgId, a } = setupOrg();
    expect(getAgentReliability(orgId, a.id)).toMatchObject({ accepted: 0, rejected: 0, total: 0, accept_rate: null });
  });

  it("counts an accepted task", () => {
    const { orgId, a, b } = setupOrg();
    completeAndReview(orgId, a, b, "accept");
    expect(getAgentReliability(orgId, a.id)).toMatchObject({ accepted: 1, rejected: 0, total: 1, accept_rate: 1 });
  });

  it("counts a rejected task, and the accept_rate reflects the mix", () => {
    const { orgId, a, b } = setupOrg();
    completeAndReview(orgId, a, b, "accept");
    completeAndReview(orgId, a, b, "reject");
    // rejectTask bounces the task back to "claimed" -- accept it now so this round is done too.
    const result = getAgentReliability(orgId, a.id);
    expect(result).toMatchObject({ accepted: 1, rejected: 1, total: 2, accept_rate: 0.5 });
  });

  it("never counts another org's task outcomes", () => {
    const one = setupOrg("Reliability Org One");
    const two = setupOrg("Reliability Org Two");
    completeAndReview(one.orgId, one.a, one.b, "accept");
    expect(getAgentReliability(two.orgId, one.a.id)).toMatchObject({ accepted: 0, rejected: 0, total: 0 });
  });

  it("returns the id itself as the name when the agent row can't be found (e.g. a stale/removed id)", () => {
    const { orgId } = setupOrg();
    expect(getAgentReliability(orgId, "not-a-real-agent-id").agent_name).toBe("not-a-real-agent-id");
  });
});

describe("listAgentReliability", () => {
  it("omits agents with no reviewed history rather than zero-filling them", () => {
    const { orgId, a, b } = setupOrg();
    completeAndReview(orgId, a, b, "accept");
    const list = listAgentReliability(orgId);
    expect(list.map((r) => r.agent_id)).toEqual([a.id]); // b never had a task reviewed as its own outcome
  });

  it("sorts most-reliable first, breaking ties on more total history", () => {
    const { orgId, a, b } = setupOrg();
    // Agent A: 1/1 (100%, small sample). Agent B: 3/3 (100%, larger sample) -- B should rank above A.
    completeAndReview(orgId, a, b, "accept");
    completeAndReview(orgId, b, a, "accept");
    completeAndReview(orgId, b, a, "accept");
    completeAndReview(orgId, b, a, "accept");
    const list = listAgentReliability(orgId);
    expect(list.map((r) => r.agent_id)).toEqual([b.id, a.id]);
  });

  it("never leaks another org's agents", () => {
    const one = setupOrg("List Reliability One");
    const two = setupOrg("List Reliability Two");
    completeAndReview(one.orgId, one.a, one.b, "accept");
    expect(listAgentReliability(two.orgId)).toEqual([]);
  });
});
