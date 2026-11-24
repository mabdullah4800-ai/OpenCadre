import { describe, expect, it } from "vitest";
import { createOrganization, registerAgent } from "../src/service.js";
import { BlackboardInputError, deleteFact, getFact, listFacts, MAX_KEY_CHARS, MAX_VALUE_CHARS, setFact } from "../src/blackboard.js";

function setupOrg(name = "Blackboard Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return {
    orgId,
    a: { id: a.agentId, name: "Agent A" },
    b: { id: b.agentId, name: "Agent B" },
  };
}

describe("setFact / getFact", () => {
  it("has no fact until one is set", () => {
    const { orgId } = setupOrg();
    expect(getFact(orgId, "deploy.target")).toBeNull();
  });

  it("creates a new fact at version 1, visible to every agent in the org", () => {
    const { orgId, a } = setupOrg();
    const result = setFact(orgId, a, "deploy.target", "vps-prod-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fact).toMatchObject({ key: "deploy.target", value: "vps-prod-1", version: 1, set_by_agent_name: "Agent A" });
    expect(getFact(orgId, "deploy.target")?.value).toBe("vps-prod-1");
  });

  it("overwriting bumps the version and records the new setter, without expectedVersion", () => {
    const { orgId, a, b } = setupOrg();
    setFact(orgId, a, "k", "first");
    const second = setFact(orgId, b, "k", "second");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.fact).toMatchObject({ value: "second", version: 2, set_by_agent_name: "Agent B" });
  });

  it("rejects an empty key", () => {
    const { orgId, a } = setupOrg();
    expect(() => setFact(orgId, a, "   ", "v")).toThrow(BlackboardInputError);
  });

  it("rejects a key or value over the length limit", () => {
    const { orgId, a } = setupOrg();
    expect(() => setFact(orgId, a, "k".repeat(MAX_KEY_CHARS + 1), "v")).toThrow(BlackboardInputError);
    expect(() => setFact(orgId, a, "k", "v".repeat(MAX_VALUE_CHARS + 1))).toThrow(BlackboardInputError);
  });

  it("never leaks another org's fact", () => {
    const one = setupOrg("Org One");
    const two = setupOrg("Org Two");
    setFact(one.orgId, one.a, "shared-key", "org one's private value");
    expect(getFact(two.orgId, "shared-key")).toBeNull();
  });
});

describe("setFact: optimistic concurrency (the actual point of this feature -- a disputed fact can't be silently clobbered)", () => {
  it("succeeds when expectedVersion matches the current version", () => {
    const { orgId, a } = setupOrg();
    setFact(orgId, a, "k", "v1"); // version 1
    const result = setFact(orgId, a, "k", "v2", { expectedVersion: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fact.version).toBe(2);
  });

  it("fails when expectedVersion is stale, returning the CURRENT fact so the caller can see what changed", () => {
    const { orgId, a, b } = setupOrg();
    setFact(orgId, a, "k", "v1"); // version 1
    setFact(orgId, b, "k", "v2"); // version 2, by a different agent -- a wrote agent A never saw
    const stale = setFact(orgId, a, "k", "v3-would-clobber", { expectedVersion: 1 });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.current).toMatchObject({ value: "v2", version: 2 });
    // The stale write never applied -- the fact is still exactly what agent B set.
    expect(getFact(orgId, "k")?.value).toBe("v2");
  });

  it("fails when expectedVersion is given for a key that doesn't exist yet", () => {
    const { orgId, a } = setupOrg();
    const result = setFact(orgId, a, "never-set", "v", { expectedVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/doesn't exist/);
  });

  it("without expectedVersion, a write always wins regardless of the current version (last-write-wins)", () => {
    const { orgId, a, b } = setupOrg();
    setFact(orgId, a, "k", "v1");
    setFact(orgId, b, "k", "v2");
    const result = setFact(orgId, a, "k", "v3-no-expected-version");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fact).toMatchObject({ value: "v3-no-expected-version", version: 3 });
  });
});

describe("listFacts", () => {
  it("lists every fact in key order, and never another org's", () => {
    const { orgId, a } = setupOrg();
    const other = setupOrg("Other Org");
    setFact(orgId, a, "b-key", "1");
    setFact(orgId, a, "a-key", "2");
    setFact(other.orgId, other.a, "z-key", "should not appear");
    expect(listFacts(orgId).map((f) => f.key)).toEqual(["a-key", "b-key"]);
  });

  it("prefix filters to keys starting with that string, and treats it literally (no LIKE wildcard injection)", () => {
    const { orgId, a } = setupOrg();
    setFact(orgId, a, "deploy.target", "1");
    setFact(orgId, a, "deploy.branch", "2");
    setFact(orgId, a, "other", "3");
    expect(listFacts(orgId, { prefix: "deploy." }).map((f) => f.key).sort()).toEqual(["deploy.branch", "deploy.target"]);
    // A literal "%" in the prefix must not act as a SQL wildcard matching everything.
    setFact(orgId, a, "100%-done", "4");
    expect(listFacts(orgId, { prefix: "100%" }).map((f) => f.key)).toEqual(["100%-done"]);
  });
});

describe("deleteFact", () => {
  it("removes a fact so it reads back as gone", () => {
    const { orgId, a } = setupOrg();
    setFact(orgId, a, "k", "v");
    expect(deleteFact(orgId, a, "k").ok).toBe(true);
    expect(getFact(orgId, "k")).toBeNull();
  });

  it("fails for a key that doesn't exist", () => {
    const { orgId, a } = setupOrg();
    expect(deleteFact(orgId, a, "never-set").ok).toBe(false);
  });

  it("never deletes another org's fact of the same key", () => {
    const one = setupOrg("Delete Org One");
    const two = setupOrg("Delete Org Two");
    setFact(one.orgId, one.a, "k", "org one's value");
    expect(deleteFact(two.orgId, two.a, "k").ok).toBe(false);
    expect(getFact(one.orgId, "k")?.value).toBe("org one's value");
  });
});
