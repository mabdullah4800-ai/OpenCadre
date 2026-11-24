import { describe, expect, it } from "vitest";
import { createOrganization, registerAgent, removeAgent, resolveAgent } from "../src/service.js";

/**
 * G7 of the hub-ops survey (docs/ops/HUB-OPERATIONS.md §7): a config on `main` once named two
 * retired agents as its `approver` and silently disabled the approval gate (#277). The open
 * question was *where else* a name is the key, and what a retired agent does to it.
 *
 * These tests used to pin a hazard: an agent name was a **recyclable alias**. removeAgent freed it
 * and the next agent could take it, so a reference naming a retired agent silently followed the
 * name to whoever held it next, which is worse than failing, because a control meant for a
 * departed agent quietly addressed a live one instead.
 *
 * Migration 55 closed it (sessions PR1, Codex-OpenCadre-049a's ruling of 2026-09-30): an address,
 * once held by any agent, removed ones included, is never reassigned (agent_addresses, written by
 * triggers on every insert and rename). A name is now a reference that fails closed for good.
 */
describe("an agent name is never recycled: a retired name fails closed for good", () => {
  function org() {
    const { orgId } = createOrganization("Stale Reference Org");
    const coder = registerAgent(orgId, "Coder");
    const gate = registerAgent(orgId, "Gate");
    return { orgId, actor: { id: coder.agentId, name: "Coder" }, gate };
  }

  it("fails closed once retired: a retired name resolves to nobody", () => {
    const { orgId, actor, gate } = org();
    expect(removeAgent(orgId, actor, gate.agentId).ok).toBe(true);

    expect(resolveAgent(orgId, "Gate")).toBeNull();
  });

  it("never rebinds: the name can't be given to a new agent, so the reference keeps failing closed", () => {
    const { orgId, actor, gate } = org();
    expect(removeAgent(orgId, actor, gate.agentId).ok).toBe(true);

    // Refused in the service, in any case, and by the database whatever path writes it.
    expect(() => registerAgent(orgId, "Gate")).toThrow(/already exists/);
    expect(() => registerAgent(orgId, "gate")).toThrow(/already exists/);
    expect(resolveAgent(orgId, "Gate")).toBeNull();
  });

  it("a url_key with the same spelling does not rebind either: the retired agent's key stays retired", () => {
    const { orgId, actor, gate } = org();
    const key = resolveAgent(orgId, "Gate")?.url_key;
    expect(key).toBe("gate");
    expect(removeAgent(orgId, actor, gate.agentId).ok).toBe(true);

    const replacement = registerAgent(orgId, "Gate Two");
    expect(replacement.urlKey).not.toBe(key);
    expect(resolveAgent(orgId, key!)).toBeNull();
  });
});
