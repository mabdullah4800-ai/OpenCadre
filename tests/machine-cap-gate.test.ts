import { describe, it, expect } from "vitest";
import { createOrganization, registerAgent } from "../src/service.js";
import { assignPlan, workspaceBilling, machineLimitRefusal, countDevices, PLAN_LIMIT_CODE } from "../src/billing.js";
import { createDevice, revokeDevice } from "../src/devices.js";
import { db } from "../src/db.js";

/**
 * THE MACHINE CAP IS ENFORCED AT THE DEVICE GATE.
 *
 * Goal 5 item 2 (`docs/planning/PRICING.md:107`): *"Connecting a 4th machine, or an 11th live agent (Pro)"*
 * is a **written promise that a 4th machine on Pro is refused**, and until this change nothing enforced it.
 * `planLimitRefusal` has read the `machines` value since migration 40 (`billing.ts:412`) and had exactly
 * two callers -- `agents` and `projects` -- so machines were **enforceable-but-uncalled**, with no declared
 * reason: `UNGATED_UNITS` (`billing.ts:342`) holds `{"workspaces"}` alone, and that one carries a reason and
 * a ruling. The module says "deliberately not enforced" about exactly one unit and was SILENT about this one.
 *
 * WHY THE GATE IS AT `createDevice` AND NOT ELSEWHERE. `createDevice` has ONE caller --
 * `POST /v1/org/devices` (`rest.ts:866`, `requireAgentAuth` + `requirePermission("devices.manage")`), an
 * authenticated operator route. That is the clean case, and the OPPOSITE of `registerAgent`, where
 * `billing.ts:518-520` records that three callers exist and two must NOT be gated (waitlist and accounts
 * create the first agent of a workspace that has no plan yet).
 *
 * NOT `setAgentWebhook`, AND THE DISTINCTION IS THE POINT. `max_webhooks` is left unenforced because
 * `webhook_url` is a COLUMN ON `agents` (`migrations.ts:40`), so the number of webhooks is bounded by the
 * number of agents -- which is already gated. Gating that column against `max_webhooks` would enforce ONE
 * URL PER AGENT while the cap names N WEBHOOKS PER WORKSPACE: a different property wearing the cap's name,
 * which would pass a test and close the row. `rest.ts:783`'s `webhookLimiter` is the same shape one level
 * up -- a RATE limiter on HTTP requests, not a count of registered webhooks.
 */

/** A workspace on `plan`, with one agent standing in as the operator who adds devices. */
function workspace(name: string, plan: "trial" | "pro" | "team" | "business" = "pro") {
  const { orgId } = createOrganization(name);
  const operator = registerAgent(orgId, "Operator", { system: true });
  assignPlan(orgId, plan);
  const actor = { id: operator.agentId, name: "Operator" };
  return { orgId, operator, actor };
}

/** Add a device the way `POST /v1/org/devices` does, and redeem it so it becomes a real machine. */
function addMachine(orgId: string, actor: { id: string; name: string }, name: string): string {
  const { deviceId, code } = createDevice(orgId, actor, name, "claude-code");
  db.prepare(`UPDATE devices SET code_redeemed_at = ?, credential_hash = ? WHERE id = ?`).run(
    new Date().toISOString(),
    `hash_${deviceId}`,
    deviceId,
  );
  void code;
  return deviceId;
}

describe("the machine cap is enforced at the device gate", () => {
  it("countDevices counts a redeemed, unrevoked, unmerged device", () => {
    const w = workspace("Machine Count");
    expect(countDevices(w.orgId), "a new workspace holds no machines").toBe(0);
    addMachine(w.orgId, w.actor, "laptop");
    expect(countDevices(w.orgId), "one redeemed device is one machine").toBe(1);
  });

  it("REFUSES a machine past the plan's cap -- this is the promise PRICING.md:107 makes", () => {
    const w = workspace("Machine Cap");
    const cap = workspaceBilling(w.orgId).limits.maxMachines;
    expect(cap, "Pro must carry a machine cap for this test to mean anything").toBe(3);

    for (let i = 0; i < cap!; i++) addMachine(w.orgId, w.actor, `machine-${i}`);
    expect(countDevices(w.orgId)).toBe(cap);

    const refusal = machineLimitRefusal(w.orgId);
    expect(refusal, "a Pro workspace at its machine cap must be refused the next one").not.toBeNull();
    expect(refusal!.status).toBe(402);
    expect(refusal!.body.code).toBe(PLAN_LIMIT_CODE);
    expect(refusal!.body.limit, "the refusal names the unit it refused").toBe("machines");
    expect(refusal!.body.allowed).toBe(cap);
    expect(refusal!.body.used).toBe(cap);
  });

  it("ALLOWS a machine below the cap -- the refusal must not be unconditional", () => {
    const w = workspace("Machine Under Cap");
    addMachine(w.orgId, w.actor, "only-one");
    expect(machineLimitRefusal(w.orgId), "one machine on a three-machine plan is fine").toBeNull();
  });

  it("an UNLIMITED plan is never refused", () => {
    const w = workspace("Machine Unlimited", "business");
    expect(workspaceBilling(w.orgId).limits.maxMachines, "business is unlimited on machines").toBeNull();
    for (let i = 0; i < 5; i++) addMachine(w.orgId, w.actor, `m-${i}`);
    expect(machineLimitRefusal(w.orgId)).toBeNull();
  });

  /**
   * THE REMEDY MUST WORK, and this is the rule that decides the whole counting predicate.
   * `UNGATED_UNITS`' own comment (`billing.ts:333-338`) says a refusal must name a remedy the caller can
   * ACT ON -- it is the stated reason `workspaces` is not gated. So a revoked machine must FREE A SLOT, or
   * the refusal would be one the user cannot clear.
   */
  it("REVOKING a machine frees its slot -- otherwise the refusal is one the user cannot clear", () => {
    const w = workspace("Machine Revoke");
    const cap = workspaceBilling(w.orgId).limits.maxMachines!;
    const ids = Array.from({ length: cap }, (_, i) => addMachine(w.orgId, w.actor, `m-${i}`));
    expect(machineLimitRefusal(w.orgId), "at the cap").not.toBeNull();

    revokeDevice(w.orgId, w.actor, ids[0]);
    expect(countDevices(w.orgId), "a revoked device is not a machine the workspace holds").toBe(cap - 1);
    expect(machineLimitRefusal(w.orgId), "and the slot it held is now available").toBeNull();
  });

  /**
   * AN ABANDONED CONNECT MUST NOT CONSUME A SLOT, and this is the subtlest rule here.
   * `createDevice` INSERTs a row and its code expires; NOTHING reaps those rows (measured: no DELETE and no
   * reap path in src/devices.ts), and a later `connect` INSERTs a NEW row rather than reusing the old one.
   * So counting unredeemed codes would let a user accumulate permanent, invisible slot consumption by
   * running `connect` and abandoning it -- a machine they cannot see on the roster and cannot free.
   * The count is therefore devices that BECAME machines, which is `code_redeemed_at IS NOT NULL`.
   */
  it("an UNREDEEMED code does not consume a slot -- nothing reaps them and no user can free them", () => {
    const w = workspace("Machine Abandoned");
    const cap = workspaceBilling(w.orgId).limits.maxMachines!;
    for (let i = 0; i < cap * 2; i++) createDevice(w.orgId, w.actor, `abandoned-${i}`, "claude-code");
    expect(countDevices(w.orgId), "codes that were never redeemed are not machines").toBe(0);
    expect(machineLimitRefusal(w.orgId), "and they must not refuse a real connect").toBeNull();
  });
});
