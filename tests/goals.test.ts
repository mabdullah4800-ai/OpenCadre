import { describe, expect, it } from "vitest";
import { createOrganization, registerAgent } from "../src/service.js";
import { getGoal, setGoal } from "../src/goals.js";

function setupOrg(name = "Goals Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return {
    orgId,
    a: { id: a.agentId, name: "Agent A" },
    b: { id: b.agentId, name: "Agent B" },
  };
}

describe("getGoal / setGoal", () => {
  it("has no goal until one is set", () => {
    const { orgId } = setupOrg();
    expect(getGoal(orgId)).toBeNull();
  });

  it("lets any agent set the goal, visible to every other agent", () => {
    const { orgId, a } = setupOrg();
    const goal = setGoal(orgId, a, "Ship the EGFR benchmark fix");
    expect(goal.text).toBe("Ship the EGFR benchmark fix");
    expect(goal.set_by_agent_name).toBe("Agent A");
    expect(getGoal(orgId)?.text).toBe("Ship the EGFR benchmark fix");
  });

  it("replaces the previous goal rather than accumulating a list", () => {
    const { orgId, a, b } = setupOrg();
    setGoal(orgId, a, "First goal");
    const second = setGoal(orgId, b, "Second goal");
    expect(second.text).toBe("Second goal");
    expect(second.set_by_agent_name).toBe("Agent B");
    const current = getGoal(orgId);
    expect(current?.text).toBe("Second goal");
    expect(current?.set_by_agent_name).toBe("Agent B");
  });

  it("rejects an empty goal", () => {
    const { orgId, a } = setupOrg();
    expect(() => setGoal(orgId, a, "   ")).toThrow(/text/);
  });

  it("never leaks another org's goal", () => {
    const one = setupOrg("Org One");
    const two = setupOrg("Org Two");
    setGoal(one.orgId, one.a, "Org one's private goal");
    expect(getGoal(two.orgId)).toBeNull();
  });
});
