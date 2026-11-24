import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { GRACE_DAYS, applySubscriptionEvent, assignPlan, graceEndsAt, workspaceBilling } from "../src/billing.js";

/** PRICING.md §8 item 5, the lapse half, and §4's promise in the customer's own words:
 *
 *   "Payment fails | Stripe retries automatically and emails them; EVERYTHING KEEPS WORKING FOR 7 DAYS"
 *
 * Before this, `workspaceBilling` decided read-only from `subscription_status` alone, so a `past_due`
 * that arrived on a Tuesday locked the workspace on Tuesday -- the seven days the site sells did not
 * exist in the code at all. The tests below pin the seven days and every edge of them.
 *
 * They also pin the NEGATIVE, which is the half that protects the business: a TRIAL that simply ends
 * gets no grace. §4 separates the two clauses deliberately ("Payment fails" vs "trial ends without a
 * plan"), and conflating them would hand every abandoned trial a free extra week.
 */

const DAY_MS = 86_400_000;

function setupOrg(name: string) {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  return { orgId, a: { id: a.agentId, name: "Agent A" } };
}

/** Puts a workspace on a real plan and then records a provider lapse, the way the webhook does. */
function lapsedWorkspace(name: string, status = "past_due", atMs = Date.now()) {
  const { orgId, a } = setupOrg(name);
  assignPlan(orgId, "pro", atMs); // a paid plan: no trial clock to confuse the lapse with
  applySubscriptionEvent(orgId, "pro", status, new Date(atMs).toISOString());
  return { orgId, a, atMs };
}

describe("the seven-day payment grace", () => {
  it("keeps a past_due workspace fully writable for the whole grace window", () => {
    const { orgId } = lapsedWorkspace("Grace Writable");
    const b = workspaceBilling(orgId);
    expect(b.readOnly, "immediately after the lapse -- this is the 7 days §4 sells").toBe(false);
    expect(b.subscriptionStatus).toBe("past_due");
  });

  it("holds the boundary at the last millisecond of grace and flips on the next one", () => {
    const { orgId, atMs } = lapsedWorkspace("Grace Boundary");
    const endsAt = atMs + GRACE_DAYS * DAY_MS;
    expect(workspaceBilling(orgId, endsAt - 1).readOnly, "1 ms before the grace ends").toBe(false);
    expect(workspaceBilling(orgId, endsAt).readOnly, "exactly at the end").toBe(true);
    expect(workspaceBilling(orgId, endsAt + 1).readOnly, "1 ms after").toBe(true);
  });

  // THE CLOCK STARTS ONCE, which is the assertion that makes the whole feature safe rather than generous.
  //
  // A provider does not report `past_due` once: Stripe re-sends it on every retry, and a workspace that
  // stays unpaid keeps producing events. If each one re-stamped `lapsed_at`, the deadline would slide
  // forward on every delivery and a customer who never pays would keep a writable workspace FOREVER --
  // the grace would be a permanent free tier with no failure and no alarm. COALESCE(lapsed_at, ?) in the
  // UPDATE is the whole of the defence, and it is one clause.
  //
  // This test exists because that clause was REMOVED during review and the rest of this file stayed
  // 10/10 green -- every other test stamps the first lapse and never sends a second event, so none of
  // them can see it. A repeated status is the only input that distinguishes "starts once" from
  // "restarts every time", and nothing was asserting it.
  it("does not restart the clock when the provider repeats the same lapse", () => {
    const { orgId, atMs } = lapsedWorkspace("Grace Repeat"); // past_due at t0
    // ...and again three days later, which is what a retrying provider actually does.
    applySubscriptionEvent(orgId, "pro", "past_due", new Date(atMs + 3 * DAY_MS).toISOString());

    // The window still ends 7 days after the FIRST lapse, not 10 days after the second.
    expect(workspaceBilling(orgId, atMs + GRACE_DAYS * DAY_MS - 1).readOnly, "just inside the original window").toBe(false);
    expect(workspaceBilling(orgId, atMs + GRACE_DAYS * DAY_MS).readOnly, "the original window has closed").toBe(true);
    // And the stamp itself did not move -- asserted on the row, so this cannot pass on a workspace that
    // merely happened to lapse for an unrelated reason.
    expect(graceEndsAt(orgId, atMs + DAY_MS)).toBe(new Date(atMs + GRACE_DAYS * DAY_MS).toISOString());
  });

  it("reports the grace end on the billing shape, so the console can show a countdown", () => {
    const { orgId, atMs } = lapsedWorkspace("Grace Countdown");
    expect(graceEndsAt(orgId)).toBe(new Date(atMs + GRACE_DAYS * DAY_MS).toISOString());
    // And it is absent for an entitled workspace, so the UI cannot render a countdown that means nothing.
    const { orgId: ok } = setupOrg("Grace Not Lapsed");
    assignPlan(ok, "pro");
    expect(graceEndsAt(ok)).toBeNull();
  });

  it("reads the status from the row and not from any cached identity, so a mid-session lapse is seen", () => {
    // workspaceBilling's doc comment claims "one primary-key lookup per call is the price of the state
    // being true". This asserts the consequence: the SAME orgId answers differently once the row moves.
    const { orgId } = setupOrg("Grace Fresh Read");
    assignPlan(orgId, "pro");
    expect(workspaceBilling(orgId).readOnly).toBe(false);
    applySubscriptionEvent(orgId, "pro", "unpaid", new Date().toISOString());
    const endsAt = Date.now() + GRACE_DAYS * DAY_MS;
    expect(workspaceBilling(orgId, endsAt).readOnly).toBe(true);
  });
});

describe("paying again restores everything instantly", () => {
  it("clears the lapse so the workspace is writable again with no restore step", () => {
    const { orgId, atMs } = lapsedWorkspace("Restore Paid");
    const afterGrace = atMs + (GRACE_DAYS + 1) * DAY_MS;
    expect(workspaceBilling(orgId, afterGrace).readOnly).toBe(true);

    // Pay: the plan is assigned again, which is what the payment path calls.
    applySubscriptionEvent(orgId, "pro", "active", new Date(afterGrace).toISOString());
    expect(workspaceBilling(orgId, afterGrace).readOnly, "same instant, now paid").toBe(false);
    expect(graceEndsAt(orgId), "and no grace window is left hanging").toBeNull();
  });

  it("assignPlan also clears it, so the operator path cannot leave a stale lapse behind", () => {
    // assignPlan is the operator putting a workspace back on a plan. If it left `lapsed_at` set, a
    // workspace that is entitled would carry a grace window -- the contradiction the column's comment
    // says must be impossible.
    const { orgId, atMs } = lapsedWorkspace("Restore By Operator");
    assignPlan(orgId, "team", atMs + DAY_MS);
    expect(db.prepare(`SELECT lapsed_at FROM organizations WHERE id = ?`).get(orgId)).toEqual({ lapsed_at: null });
    expect(workspaceBilling(orgId).readOnly).toBe(false);
  });
});

describe("a trial that ends gets NO grace, which is the clause that protects the business", () => {
  it("lapses a trial immediately on expiry, exactly as before this change", () => {
    const { orgId } = setupOrg("Trial No Grace");
    assignPlan(orgId, "trial"); // the trial plan HAS a clock (trial_days), unlike pro
    const endsAt = new Date(Date.now() + 14 * DAY_MS).toISOString();
    db.prepare(`UPDATE organizations SET trial_ends_at = ? WHERE id = ?`).run(endsAt, orgId);
    const endMs = Date.parse(endsAt);

    expect(workspaceBilling(orgId, endMs - 1).readOnly).toBe(false);
    expect(workspaceBilling(orgId, endMs).readOnly, "trial expiry is immediate -- §4 says so").toBe(true);
    // The distinguishing assertion: no grace window exists for a trial, so the console cannot offer one.
    expect(graceEndsAt(orgId)).toBeNull();
  });
});

describe("fail-closed, and the corrupt-row direction", () => {
  it("lapses an unknown status immediately rather than granting grace for a status it does not know", () => {
    // ENTITLED_STATUSES is a whitelist, so an unrecognised status means "not entitled". The question this
    // pins is whether it also means "grace": it must NOT, or a provider inventing a status would buy every
    // affected workspace a free week. Only a status the hub RECOGNISES as a lapse starts the clock.
    const { orgId, atMs } = lapsedWorkspace("Unknown Status", "some_new_stripe_status");
    expect(workspaceBilling(orgId, atMs).readOnly, "unknown status lapses at once").toBe(true);
    expect(graceEndsAt(orgId), "and it gets no grace").toBeNull();
  });

  it("treats an unparseable grace timestamp as already expired, not as seven free days", () => {
    // The two possible failure directions are not symmetric. Reading a corrupt value as "no grace" lapses
    // the workspace, which is the status quo, is recoverable by an operator, and costs the customer
    // nothing they were promised. Reading it as "grace starts now" hands away a week per corrupt row.
    // Fail-closed is the only defensible direction, and it is asserted rather than assumed.
    const { orgId, atMs } = lapsedWorkspace("Corrupt Lapse");
    db.prepare(`UPDATE organizations SET lapsed_at = ? WHERE id = ?`).run("not-a-date", orgId);
    expect(workspaceBilling(orgId, atMs).readOnly).toBe(true);
  });

  it("is still writable while the provider is retrying, because retries are not a lapse", () => {
    // "active" is entitled; this is the control that keeps the grace machinery from firing on a healthy
    // workspace. Without it, everything above would pass on a predicate that lapsed unconditionally.
    const { orgId } = setupOrg("Grace Healthy");
    assignPlan(orgId, "pro");
    expect(workspaceBilling(orgId).readOnly).toBe(false);
    expect(workspaceBilling(orgId).reason).toBeNull();
    expect(graceEndsAt(orgId)).toBeNull();
  });
});
