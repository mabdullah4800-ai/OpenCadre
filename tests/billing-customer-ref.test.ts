import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { createOrganization } from "../src/service.js";
import {
  billingCustomerRef,
  readOnlyRefusal,
  setBillingCustomerRef,
  workspaceBilling,
  workspaceForBillingCustomerRef,
} from "../src/billing.js";

/** Billing Phase 2 increment 2 (board bce5de80): the provider customer reference.
 *
 * The reference is a POINTER, never a permission. It says "this workspace is the one the provider's
 * customer `cus_...` belongs to" and nothing else -- in particular it does not say the workspace is
 * entitled to anything. Entitlement is decided in exactly one place (`workspaceBilling` /
 * `readOnlyRefusal`), from the plan and the subscription status, and the test that carries this file is
 * the last one: a workspace holding a reference on a lapsed trial is still refused.
 *
 * That direction matters because of what arrives next. Increment 4's webhook resolves a workspace BY
 * this string, and the tempting shortcut there is to treat a resolved reference as a paid customer. It
 * is not: the webhook carries a STATUS, and the status is what the predicate reads. Pinning that here
 * -- before any webhook exists -- is what makes the shortcut fail loudly when someone reaches for it.
 */

const LAPSED_MS = Date.now() - 1000;

function workspace(name: string) {
  const { orgId } = createOrganization(name);
  return orgId;
}

/** Move the workspace's clock. This column is what the enforcement path reads (src/billing.ts), so
 * setting it is setting the subject of the test rather than routing around it. */
function lapse(orgId: string) {
  db.prepare(`UPDATE organizations SET trial_ends_at = ? WHERE id = ?`).run(new Date(LAPSED_MS).toISOString(), orgId);
}

describe("the provider customer reference", () => {
  it("starts absent and round-trips through the accessors", () => {
    const orgId = workspace("Ref Round Trip");
    expect(billingCustomerRef(orgId), "a workspace that never checked out has no reference").toBeNull();

    setBillingCustomerRef(orgId, "cus_round_trip_0001");
    expect(billingCustomerRef(orgId)).toBe("cus_round_trip_0001");
  });

  it("can be cleared back to absent, so a re-checkout is not stuck on the old customer", () => {
    const orgId = workspace("Ref Cleared");
    setBillingCustomerRef(orgId, "cus_old_0001");
    setBillingCustomerRef(orgId, null);
    expect(billingCustomerRef(orgId)).toBeNull();
  });

  it("resolves the workspace from the reference -- the lookup the webhook will need", () => {
    const orgId = workspace("Ref Resolves");
    setBillingCustomerRef(orgId, "cus_resolves_0001");
    expect(workspaceForBillingCustomerRef("cus_resolves_0001")).toBe(orgId);
  });

  it("resolves nothing for a reference no workspace holds, rather than guessing", () => {
    // NULL and not a throw: the caller is a webhook handler receiving arbitrary external input
    // (increment 4), and an unknown reference is an ordinary thing for it to be sent -- it must be
    // answerable without a 500, and it must never fall back to some other workspace.
    expect(workspaceForBillingCustomerRef("cus_never_seen_0001")).toBeNull();
  });

  it("rejects a second workspace claiming a reference another workspace already holds", () => {
    const first = workspace("Ref Holder");
    setBillingCustomerRef(first, "cus_contested_0001");
    const second = workspace("Ref Claimant");
    // The DB index is the enforcement, so the failure surfaces as a constraint violation rather than a
    // soft pre-check that could race with the writer it is checking against.
    expect(() => setBillingCustomerRef(second, "cus_contested_0001")).toThrow(/UNIQUE constraint failed/);
    expect(billingCustomerRef(second), "the failed write changed nothing").toBeNull();
    expect(workspaceForBillingCustomerRef("cus_contested_0001")).toBe(first);
  });
});

describe("a customer reference is not an entitlement", () => {
  it("leaves a lapsed workspace read-only even though it holds a reference", () => {
    const orgId = workspace("Ref Lapsed");
    setBillingCustomerRef(orgId, "cus_lapsed_0001");
    lapse(orgId);

    const billing = workspaceBilling(orgId);
    expect(billing.readOnly, "holding a reference does not make a workspace entitled").toBe(true);

    // The same decision, at the predicate every surface routes through: one verb, one answer.
    const refusal = readOnlyRefusal(orgId, "create_task");
    expect(refusal, "a write is refused while the workspace is lapsed").not.toBeNull();
    expect(refusal?.body.code).toBe("TRIAL_EXPIRED");

    // The control that stops "refuse everything" from passing this test: the SAME workspace, at the
    // SAME instant, still serves reads -- which is what makes the refusal above about entitlement
    // rather than about the reference existing.
    expect(readOnlyRefusal(orgId, "list_tasks"), "reads keep working on a lapsed workspace").toBeNull();
  });

  it("does not lapse a workspace just because a reference is written to it", () => {
    // The other direction, and the reason this is a test rather than a comment: writing the reference
    // must not touch the plan, the clock or the status. A workspace mid-trial that checks out is still
    // on its trial row until the webhook says otherwise.
    const orgId = workspace("Ref Live");
    const before = workspaceBilling(orgId);
    setBillingCustomerRef(orgId, "cus_live_0001");
    const after = workspaceBilling(orgId);
    expect(after).toEqual(before);
    expect(after.readOnly).toBe(false);
  });
});
