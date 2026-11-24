import { db } from "./db.js";
import type { AgentRole } from "./auth.js";
import { HEARTBEAT_TTL_MS } from "./service.js";
import { liveCountVisibleTo, type LiveCountViewer } from "./live-count.js";
import { parseStamp as parseStampShared, preciseInstant, preciseInstantSql } from "./timestamps.js";

/** Billing Phase 1 (docs/research/PRICING-AND-METERING.md §3.2): where a workspace's plan and trial
 * live, and the ONE place that decides whether a request may change anything.
 *
 * The plan's numbers are ROWS (migration 29), never constants in this file. PRICING-AND-METERING
 * rule 5 is "publish the limits", and a limit that lives in code is one nobody can read off the
 * product -- the first real cap has to be a data edit, not a deploy. The limits that are NULL today
 * are NULL on purpose: the published pricing page promises "unlimited agents" on Pro and says
 * nothing about history retention, so there is no number to invent.
 *
 * Enforcement shape, identical on every surface (see readOnlyRefusal):
 *   - a READ always works. A lapsed workspace keeps every message, task, event and file readable,
 *     which is the "a lapsed plan never turns into unreadable data" rule §3.2 copies from AgentCouch
 *     and Agent Relay.
 *   - a WRITE is refused with 402 and a body naming the date it lapsed, so a refused agent has
 *     something it can act on instead of a generic 403.
 *   - putting the workspace back on a plan reverses it completely (assignPlan). Nothing is deleted,
 *     and no code path here ever deletes anything.
 *   - an OPERATOR is exempt from the write refusal entirely -- every verb, not only the ones that fix
 *     the payment. The kill switch draws the same line for the same reason (src/kill-switch.ts): the
 *     person who has to put a lapsed workspace back on a plan has to be able to act inside it. This
 *     bullet names the exception because the three above read as a complete statement of the shape
 *     and an operator is not in them; readOnlyRefusal is the only place it is implemented.
 */

/** The plan a workspace is grandfathered onto: no trial clock, so it never lapses. The fleet's own
 * workspace rides this -- as DATA, because migration 29 puts every workspace that predates billing
 * on it. Nothing in this file, or in its callers, compares an org NAME: a hardcoded name is the
 * defect class the fleet keeps paying for, and "which workspace is grandfathered" is a fact about a
 * row, which is also the only form that survives a rename. */
export const NON_EXPIRING_PLAN = "internal";

/** The plan a workspace created by createOrganization starts on. */
export const DEFAULT_PLAN = "trial";

/** "No plan yet" (migration 49): where a workspace created under the CARD-REQUIRED trial waits until its the payment provider trial
 * starts. Every enforced limit on the row is 0, so the gates that already exist -- agent keys (agentLimitRefusal),
 * computers (machineLimitRefusal), projects (projectLimitRefusal) and connect-code redemption (readOnlyRefusal, which
 * this plan also trips) -- refuse it for everyone, operators included, until a subscription is trialing or active. No
 * parallel gate exists for it: it is a plan, read like any other. An operator can still sign in, read, and check out. */
export const PENDING_PLAN = "pending";

/** The card-required trial's length (operator decision 2026-09-29). It lives on the the payment provider trial PRICES
 * (`trial_period { interval: day, frequency: 7, requires_payment_method: true }`); checkout refuses a trial price whose
 * `trial_period` says anything else, so the promise on the page and the price the payment provider bills cannot drift apart. */
export const CARD_TRIAL_DAYS = 7;

/** How a new workspace starts: `card` (the launch behaviour) -- in PENDING_PLAN, until a 7-day card-required trial is
 * started through the payment provider checkout; or `cardless` -- today's hub-side trial clock, with no card (for tests and
 * emergencies). An ops control, not copy: OPENCADRE_TRIAL_MODE. */
export type TrialMode = "card" | "cardless";
export const TRIAL_MODE_VAR = "OPENCADRE_TRIAL_MODE";

/** The configured trial mode. Unset means `card`. A value that is neither word also means `card` -- the launch
 * behaviour, which never grants free days nobody chose -- and `trialModeProblem` makes the typo loud at boot. */
export function trialMode(env: NodeJS.ProcessEnv = process.env): TrialMode {
  return (env[TRIAL_MODE_VAR] ?? "").trim().toLowerCase() === "cardless" ? "cardless" : "card";
}

/** Why OPENCADRE_TRIAL_MODE is unusable, or null. Names the variable, never echoes the value. */
export function trialModeProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[TRIAL_MODE_VAR] ?? "").trim().toLowerCase();
  return raw === "" || raw === "card" || raw === "cardless" ? null
    : `${TRIAL_MODE_VAR} must be "card" or "cardless"; it is set to something else, so the hub uses "card" (the card-required trial).`;
}

/** Whether this hub sells plans. OFF unless OPENCADRE_BILLING is "on": this repository ships no payment provider, so a
 * hub that started workspaces on a trial would lapse them to read-only with no way to pay. With billing off, every new
 * workspace starts on NON_EXPIRING_PLAN. With it on, the plans, trials and limits below apply as written, and whoever
 * runs the hub supplies the provider that writes subscriptions through applySubscriptionEvent. */
export const BILLING_VAR = "OPENCADRE_BILLING";
export function billingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[BILLING_VAR] ?? "").trim().toLowerCase() === "on";
}

/** The plan createOrganization starts a workspace on: DEFAULT_PLAN when this hub sells plans, else the non-expiring one. */
export function defaultPlan(env: NodeJS.ProcessEnv = process.env): string {
  return billingEnabled(env) ? DEFAULT_PLAN : NON_EXPIRING_PLAN;
}

/** The plan a SELF-SERVE sign-up's workspace is created on, for the trial mode in force. */
export function signupPlan(env: NodeJS.ProcessEnv = process.env): string {
  if (!billingEnabled(env)) return NON_EXPIRING_PLAN;
  return trialMode(env) === "card" ? PENDING_PLAN : DEFAULT_PLAN;
}

/** Statuses a subscription can be in and still mean "paid up". Anything else lapses the workspace,
 * so a payment provider that starts reporting a new status fails closed rather than granting access. */
const ENTITLED_STATUSES = new Set(["active", "trialing"]);

/** How long a workspace keeps working after a payment lapses, before it goes read-only.
 * PRICING.md §4, in the customer's words: "Payment fails | the payment provider retries automatically and emails
 * them; everything keeps working for 7 days". Not a free allowance and not a trial -- it is the window
 * in which a failed card can be fixed, which is why it is days rather than hours. */
export const GRACE_DAYS = 7;

/** Statuses that mean "the subscription is no longer paid for": the transition into one stamps `lapsed_at` (the start
 * of the lapse, which the lapse emails key on) and a recovery clears it. DELIBERATELY NARROWER than "not entitled":
 * `ENTITLED_STATUSES` is a whitelist that fails closed on anything unrecognised, and that is right for ACCESS; this
 * list only names the lapses the hub recognises. */
const LAPSE_STATUSES = new Set(["past_due", "unpaid", "canceled", "incomplete_expired"]);

/** The lapses that get the GRACE window -- a failed payment the customer can still fix. NOT `canceled`: operator rule
 * (2026-09-28), a cancellation revokes the moment the subscription's status IS canceled, with no grace. That is safe
 * for a customer who cancels at period end, because the payment provider keeps the status `active` (with a `scheduled_change`) until
 * the period is over and only then reports `canceled` -- so "immediately" means "when the paid period ends", never
 * early. `paused` is in neither list: it is read-only at once, as before.
 *
 * Grace is money, and a provider inventing a new status must not buy every affected workspace a free week -- so only
 * the statuses listed here start the clock. An unknown status still lapses the workspace (fail-closed on access), it
 * just does so at once. */
const GRACE_STATUSES = new Set(["past_due", "unpaid", "incomplete_expired"]);

/** Whether a provider status starts the grace clock -- the same whitelist the predicate reads, exposed as a question
 * so a caller (the lapse email, src/emails.ts) cannot keep a second copy of the list that drifts from this one. */
export const startsGrace = (status: string): boolean => GRACE_STATUSES.has(status);

/** Whether a provider status is a recognised lapse (graced or not), i.e. one that stamps `lapsed_at`. */
export const recordsLapse = (status: string): boolean => LAPSE_STATUSES.has(status);

/** Whether the payment grace window is WITHHELD: the workspace used a the payment provider trial (`trial_used_at`) and has never
 * completed a payment (`first_paid_at`). Scoped to the trial on purpose: every other way to a subscription (an ordinary
 * price) takes a completed payment at checkout, so "used a trial and never paid" IS "has never paid" for any
 * subscription the payment provider can put in past_due -- and a workspace that has paid before, or never trialed, keeps its grace. */
export function graceWithheld(row: { trial_used_at: string | null; first_paid_at: string | null }): boolean {
  return row.trial_used_at !== null && row.first_paid_at === null;
}

const readPaymentMarkersStmt = db.prepare(`SELECT trial_used_at, first_paid_at FROM organizations WHERE id = ?`);

/** graceWithheld for a workspace by id (false for an unknown one). For the lapse email, so it cannot keep a second copy of
 * the rule. */
export function paymentGraceWithheld(orgId: string): boolean {
  const row = readPaymentMarkersStmt.get(orgId) as { trial_used_at: string | null; first_paid_at: string | null } | undefined;
  return row ? graceWithheld(row) : false;
}

const markFirstPaymentStmt = db.prepare(`UPDATE organizations SET first_paid_at = COALESCE(first_paid_at, ?) WHERE id = ?`);

/** Records that this workspace has COMPLETED a payment (first write wins). Grants nothing by itself: it only decides
 * whether a later failed payment gets the grace window. */
export function markFirstPayment(orgId: string, at: string): void {
  markFirstPaymentStmt.run(requirePreciseInstant(at), orgId);
}

const readTrialEligibilityStmt = db.prepare(
  `SELECT plan, trial_used_at, provider_subscription_id FROM organizations WHERE id = ?`,
);
/** Whether any OWNER of this workspace owns a workspace (this one or another) whose the payment provider trial was used. */
const ownerUsedTrialStmt = db.prepare(
  `SELECT 1 AS used FROM workspace_members me
     JOIN workspace_members other ON other.person_id = me.person_id AND other.role = 'owner'
     JOIN organizations o ON o.id = other.org_id
    WHERE me.org_id = ? AND me.role = 'owner' AND o.trial_used_at IS NOT NULL
    LIMIT 1`,
);
/** Whether a PERSON tied to this workspace -- a current owner, its creator -- has used their trial (migration 50). The
 * person-level marker is durable: stepping down as owner, or leaving, does not clear it. */
const personUsedTrialStmt = db.prepare(
  `SELECT 1 AS used FROM people p
    WHERE p.trial_used_at IS NOT NULL AND (
      p.id IN (SELECT person_id FROM workspace_members WHERE org_id = ? AND role = 'owner')
      OR p.id = (SELECT created_by_person_id FROM organizations WHERE id = ?))
    LIMIT 1`,
);
const readPersonTrialStmt = db.prepare(`SELECT trial_used_at FROM people WHERE id = ?`);
const readOrgTrialUsedStmt = db.prepare(`SELECT trial_used_at FROM organizations WHERE id = ?`);
/** Stamps the person-level trial marker (first write wins) on everyone a starting trial belongs to: every current owner,
 * the workspace's creator, and whoever started one of its live checkouts (open, or the one that completed). */
const stampPeopleTrialStmt = db.prepare(
  `UPDATE people SET trial_used_at = COALESCE(trial_used_at, ?)
    WHERE id IN (SELECT person_id FROM workspace_members WHERE org_id = ? AND role = 'owner')
       OR id = (SELECT created_by_person_id FROM organizations WHERE id = ?)
       OR id IN (SELECT person_id FROM billing_checkouts WHERE org_id = ? AND person_id IS NOT NULL
                   AND (outcome IS NULL OR outcome = 'completed'))`,
);

/** Whether this workspace's checkout is sold the TRIAL prices: ONE TRIAL PER WORKSPACE AND PER PERSON, and only from
 * "No plan yet". A workspace that ever held a provider subscription (in any environment), that already started a the payment provider
 * trial, or that is on any other plan (the cardless hub trial, a paid plan, `internal`) gets the ordinary prices -- and
 * so does a workspace whose owner already used a the payment provider trial on ANY workspace they own (operator policy 2026-09-29:
 * trial eligibility is per owner). Derived from the rows, never from a flag the browser sends. */
export function trialEligible(orgId: string, personId: string | null = null): boolean {
  const row = readTrialEligibilityStmt.get(orgId) as { plan: string; trial_used_at: string | null; provider_subscription_id: string | null } | undefined;
  if (!row || row.plan !== PENDING_PLAN || row.trial_used_at !== null || row.provider_subscription_id !== null) return false;
  if (ownerUsedTrialStmt.get(orgId) || personUsedTrialStmt.get(orgId, orgId)) return false;
  // The person asking (the one about to check out) must not have had a trial either, owner or not.
  if (personId && (readPersonTrialStmt.get(personId) as { trial_used_at: string | null } | undefined)?.trial_used_at) return false;
  return true;
}

/** The status stored when a subscription the payment provider calls active (or trialing, or past_due) is on a price no plan on this
 * hub maps to. It is not in ENTITLED_STATUSES or GRACE_STATUSES, so the workspace is read-only (operators stay exempt,
 * as always) until a later event or a reconcile brings a mapped price. See `grantsAccess` in src/billing-reconcile.ts
 * for why this fails closed. It IS a live subscription for checkout purposes (LIVE_SUBSCRIPTION_STATUSES), so the
 * customer is sent to manage it, never to buy a second one. */
export const PRICE_UNMAPPED_STATUS = "price_unmapped";

export interface PlanLimits {
  key: string;
  name: string;
  /** NULL = unlimited. */
  maxAgents: number | null;
  /** NULL = history is kept for as long as the workspace exists. */
  retentionDays: number | null;
  /** NULL = this plan has no trial clock, so a workspace on it never lapses. */
  trialDays: number | null;
  /** NULL = unlimited. Machines connected to this workspace (PRICING.md §8 item 2, build item 2). */
  maxMachines: number | null;
  /** NULL = unlimited. */
  maxProjects: number | null;
  /** NULL = unlimited. */
  maxWorkspaces: number | null;
  /** NULL = unlimited. */
  maxWebhooks: number | null;
}

/** The limits that are counted PER SEAT and pooled across the workspace's seats (PRICING.md §2:
 * "5 per seat, pooled" / "25 per seat, pooled"). On every plan with one seat these are the stored
 * value unchanged, so reading them against a per-seat plan is not a special case -- it is the same
 * arithmetic with a multiplier of 1. Kept as a named list rather than an inline condition at any call
 * site, because the property "this limit is per seat" is a fact about the PLAN MODEL, and a call site
 * that forgot it would enforce a Team workspace's 3-seat allowance as if it had one seat. */
/** The limits that are counted PER SEAT and pooled across the workspace's seats (PRICING.md §2:
 * "5 per seat, pooled" / "25 per seat, pooled"). Keyed by the UNIT a caller names ("machines",
 * "agents") rather than by the property it is stored in, because every caller of the enforcement path
 * speaks in units -- the refusal message names the unit, and the checkout and the console name the unit.
 *
 * A SET RATHER THAN A LIST, and a `Set<LimitedUnit>` rather than a bare array, because the array version
 * of this shipped a dead branch: it held PROPERTY names ("maxAgents") while every caller passes a UNIT
 * ("agents"), so `includes` could never be true and the per-seat multiplier silently never applied. A
 * `Set<LimitedUnit>` makes the two vocabularies the same type, so the compiler refuses the mistake that
 * the test had to catch. */
export const PER_SEAT_LIMITS: ReadonlySet<LimitedUnit> = new Set(["machines", "agents"]);

/** The fewest seats a plan is ever billed for (PRICING.md: Team minimum 2, Business minimum 5). Checkout bills
 * max(human members, this floor) (src/billing-checkout.ts billableSeatCount), so the floor is ALWAYS paid for.
 * One copy, read by checkout, by proration and by enforcement: before this, checkout billed a Team workspace for
 * two seats while enforcement multiplied its per-seat limits by one, granting half of what was paid. */
export const PLAN_SEAT_FLOOR: Readonly<Record<string, number>> = { team: 2, business: 5 };

/** The seats enforcement counts for a plan while it is being paid for (workspaceBilling uses 1 once the workspace
 * is read-only): max(the subscription's billed quantity, the plan's floor) on a seat-priced plan, 1 on any other.
 *
 * The quantity is `provider_quantity` (migration 47): the billed quantity of the plan's price, written by the SAME
 * `billing_event_at`-guarded statement as the plan and status (writeProviderSubscription), from every subscription
 * webhook and from the reconcile path -- so a late or replayed event cannot move it backwards, and it always
 * describes the same subscription state as the plan it multiplies. It is what the payment provider BILLS, never the member count:
 * counting members could grant more than is paid for.
 *
 * The floor is always billed, so a missing quantity (a workspace bound before the mirror existed, or an operator-
 * assigned plan) or one below it counts the floor. A plan with no floor (Pro) is not seat-priced and stays at 1
 * whatever quantity the payment provider reports. */
export function enforcedSeats(planKey: string, quantity: number | null = null): number {
  const floor = PLAN_SEAT_FLOOR[planKey];
  if (floor === undefined) return 1;
  return quantity !== null && Number.isInteger(quantity) && quantity > floor ? quantity : floor;
}

export interface WorkspaceBilling {
  plan: string;
  planName: string;
  subscriptionStatus: string;
  /** ISO-8601 instant this workspace's clock runs out, or null when it is on no clock at all. */
  trialEndsAt: string | null;
  /** True when reads keep working and writes are refused. */
  readOnly: boolean;
  /** Why it is read-only, as a clause ("its trial ended on 2026-09-12"); null while it is writable. */
  reason: string | null;
  /** The instant the payment grace window closes, or null when there is none. Non-null only while a
   * lapsed subscription is still inside its grace days (PRICING.md §4), so the console can tell the
   * customer the date instead of letting them discover the lock-out. */
  graceEndsAt: string | null;
  /** The seats the per-seat limits (PER_SEAT_LIMITS) are multiplied by: enforcedSeats(plan, quantity). A reader showing an
   * allowance multiplies by this, or it shows a Team workspace half of what it may use. */
  seats: number;
  limits: PlanLimits;
  /** True while the workspace is on PENDING_PLAN: created under the card-required trial, and no trial started yet. */
  awaitingPlan: boolean;
  /** While the the payment provider subscription is `trialing`: the instant the trial converts and the payment provider first charges the card
   * (mirrored `next_billed_at`). Null otherwise. */
  trialConvertsAt: string | null;
  /** True only while the workspace is "No plan yet" AND its checkout would start the free trial (trialEligible: one
   * trial per workspace and per owner). A returning owner's new workspace is awaitingPlan with this false: choosing a
   * plan charges at once, and nothing may promise a trial. */
  trialOffered: boolean;
}

// SQLite's own `datetime('now')` writes "YYYY-MM-DD HH:MM:SS" with no zone; every value this hub
// writes is `new Date().toISOString()`. src/timestamps.ts accepts both and reads a zone-less one as
// UTC, which is what SQLite's 'now' is — this file's local copy is gone, and so are the three
// prose cross-references between it, connect.ts's heartbeatMs and usage.ts's isPresenceLive.
const parseStamp = parseStampShared;

const readBilling = db.prepare(
  `SELECT o.plan, o.trial_ends_at, o.subscription_status, o.lapsed_at,
          o.trial_used_at, o.first_paid_at, o.provider_next_billed_at, o.provider_quantity,
          p.name AS plan_name, p.max_agents, p.retention_days, p.trial_days,
          p.max_machines, p.max_projects, p.max_workspaces, p.max_webhooks
   FROM organizations o LEFT JOIN plans p ON p.key = o.plan
   WHERE o.id = ?`,
);

type BillingRow = {
  plan: string;
  trial_ends_at: string | null;
  subscription_status: string;
  lapsed_at: string | null;
  trial_used_at: string | null;
  first_paid_at: string | null;
  provider_next_billed_at: string | null;
  provider_quantity: number | null;
  plan_name: string | null;
  max_agents: number | null;
  retention_days: number | null;
  trial_days: number | null;
  max_machines: number | null;
  max_projects: number | null;
  max_workspaces: number | null;
  max_webhooks: number | null;
};

const readPlanRow = db.prepare(
  `SELECT name, max_agents, retention_days, trial_days, max_machines, max_projects, max_workspaces, max_webhooks
     FROM plans WHERE key = ?`,
);

/** The whole of a workspace's billing state, read fresh. Deliberately NOT carried on the
 * authenticated identity: an MCP session is built once and reused for its life (src/mcp.ts), so a
 * snapshot taken at authentication would let a workspace that lapses mid-session keep writing.
 * One primary-key lookup per call is the price of the state being true.
 *
 * A workspace that isn't in the table is reported writable. Enforcement must never lock a workspace
 * out because of a lookup problem -- the refusal has to be a fact about a row, not the absence of one. */
export function workspaceBilling(orgId: string, nowMs = Date.now()): WorkspaceBilling {
  const row = readBilling.get(orgId) as BillingRow | undefined;
  if (!row) {
    return {
      plan: "unknown", planName: "unknown", subscriptionStatus: "active", trialEndsAt: null,
      readOnly: false, reason: null, graceEndsAt: null, seats: 1, awaitingPlan: false, trialConvertsAt: null, trialOffered: false,
      limits: {
        key: "unknown", name: "unknown", maxAgents: null, retentionDays: null, trialDays: null,
        maxMachines: null, maxProjects: null, maxWorkspaces: null, maxWebhooks: null,
      },
    };
  }
  const trialEndsAt = row.trial_ends_at;
  // The PLAN decides whether there is a clock at all; the date only says when it runs out. A plan with
  // no trial_days has no clock, so a stale date on the row cannot lapse it -- which is what makes the
  // non-expiring plan structural rather than a convention this file has to remember. Concretely: a
  // later migration that sets trial_ends_at by date CANNOT take the fleet's own workspace read-only,
  // because the plan it is on has no trial_days for the date to mean anything against.
  const trialEnded = row.trial_days !== null && trialEndsAt !== null && parseStamp(trialEndsAt) <= nowMs;
  const subscriptionLapsed = !ENTITLED_STATUSES.has(row.subscription_status);
  // THE GRACE WINDOW (PRICING.md §4). A subscription that lapsed keeps working for GRACE_DAYS before it
  // goes read-only, which is the "everything keeps working for 7 days" the site sells. Two things this
  // deliberately does NOT do:
  //
  //   It does not give grace to a TRIAL expiry. §4 lists them as separate clauses -- "Payment fails" vs
  //   "trial ends without a plan" -- and the second is immediate. Reading grace broadly would hand every
  //   abandoned trial a free extra week, which is a pricing decision, not an implementation detail.
  //
  //   It does not give grace to a status the hub cannot classify. Only GRACE_STATUSES starts a clock, so
  //   an unrecognised status lapses at once. That keeps ENTITLED_STATUSES' fail-closed promise intact:
  //   an unknown status is never entitled AND never granted time.
  //
  // A missing or unparseable `lapsed_at` on a lapsed subscription reads as ALREADY EXPIRED rather than
  // as "grace starts now". The directions are not symmetric: expiring is the status quo, is recoverable
  // by an operator, and costs the customer nothing they were promised; the other direction hands away a
  // week per corrupt row. Fail-closed, in the same spirit as everything else in this file.
  //
  // NO GRACE FOR A TRIAL THAT HAS NEVER BEEN PAID FOR (graceWithheld). A card-required trial converts by charging the
  // card; if that FIRST charge fails, a 7-day grace would turn the 7-day free trial into 14 free days. So a workspace that
  // used a the payment provider trial and has never completed a payment is read-only from the failure until the payment goes through.
  // One that has paid before keeps the 7-day grace, exactly as the site promises for a failed renewal.
  const withheld = graceWithheld(row);
  const graceEndsAtMs = !withheld && row.lapsed_at !== null && GRACE_STATUSES.has(row.subscription_status) ? parseStamp(row.lapsed_at) + GRACE_DAYS * 86_400_000 : null;
  const inGrace = graceEndsAtMs !== null && Number.isFinite(graceEndsAtMs) && nowMs < graceEndsAtMs;
  const lapsed = subscriptionLapsed && !inGrace;
  // A PENDING workspace has no subscription and no clock: it has simply not started. It is read-only (reads work, every
  // non-operator write is refused) and its plan limits are all 0, so nothing can be added until the trial starts.
  const awaitingPlan = row.plan === PENDING_PLAN;
  // Only a workspace whose checkout WOULD start the trial is told about one (a returning owner's is not).
  const trialOffered = awaitingPlan && trialEligible(orgId);
  const reason = awaitingPlan
    ? trialOffered ? `it has no plan yet: choosing a plan starts its ${CARD_TRIAL_DAYS}-day free trial` : "it has no plan yet: choosing a plan starts it"
    : trialEnded
    ? `its trial ended on ${trialEndsAt!.slice(0, 10)}`
    : lapsed
      ? withheld && GRACE_STATUSES.has(row.subscription_status)
        ? "the first payment after its free trial has not gone through"
        : `its subscription is ${row.subscription_status}`
      : null;
  return {
    plan: row.plan,
    planName: row.plan_name ?? row.plan,
    // The billed seats (enforcedSeats: max of the mirrored quantity and the floor) only while the workspace is being
    // paid for. Read-only (a trial that ended, or a lapse past its grace)
    // counts one seat: an operator keeps access there for billing recovery (readOnlyRefusal exempts operators), and
    // that access must not include a second seat's machines on a subscription nobody is paying (Codex-OpenCadre-f46c
    // on 0344dba). Inside the grace window the allowance holds: "everything keeps working" is what grace promises.
    seats: reason === null ? enforcedSeats(row.plan, row.provider_quantity) : 1,
    subscriptionStatus: row.subscription_status,
    trialEndsAt,
    readOnly: reason !== null,
    reason,
    /** When the grace window closes, or null when there is none. Handed to the console so the customer
     * is told a date rather than discovering the lock-out. Null while entitled AND null for a trial
     * expiry, so the UI cannot render a countdown that means nothing. */
    graceEndsAt: inGrace ? new Date(graceEndsAtMs).toISOString() : null,
    awaitingPlan,
    trialOffered,
    trialConvertsAt: row.subscription_status === "trialing" ? row.provider_next_billed_at : null,
    limits: {
      key: row.plan,
      name: row.plan_name ?? row.plan,
      maxAgents: row.max_agents,
      retentionDays: row.retention_days,
      trialDays: row.trial_days,
      maxMachines: row.max_machines,
      maxProjects: row.max_projects,
      maxWorkspaces: row.max_workspaces,
      maxWebhooks: row.max_webhooks,
    },
  };
}

/** The refusal an agent actually reads. It names the date the workspace lapsed, says what still
 * works, and says who can undo it: an agent-facing product owes a refused agent a reason it can act
 * on (§3.2 derived rule 3), not a bare 403.
 *
 * Phase 2 replaces the last sentence with the checkout URL. There is no self-serve payment page yet
 * -- checkout is operator-gated on the payment provider account -- and a link to a page that doesn't exist is
 * worse for an agent than naming the one party who can act. */
export function readOnlyMessage(billing: WorkspaceBilling): string {
  if (billing.awaitingPlan) {
    const starts = billing.trialOffered ? `, which starts the ${CARD_TRIAL_DAYS}-day free trial` : " to start it";
    return `This workspace has not started a plan yet, so nothing can be added to it. Reads work. The workspace owner can choose a plan in the console${starts}.`;
  }
  return `This workspace is read-only: ${billing.reason}. Everything is kept and reads still work, and writes resume as soon as it is put back on a plan. Ask the workspace operator to add one.`;
}

/** HTTP methods that cannot change state, so a read-only workspace keeps serving them. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** MCP tools that return data, or that change only the caller's own read bookkeeping -- which rows
 * the caller has already seen. That bookkeeping deletes nothing and alters nothing another agent
 * reads, so it does not make a lapsed workspace's data any less intact; refusing it would take away
 * the two tools agents read their mail with and make read-only mean "unusable" instead of "read-only".
 *
 * Everything not in this set is a write, INCLUDING any tool added later: the guard is applied where
 * tools are registered (src/mcp.ts), so an unlisted tool is refused by default rather than allowed
 * by default. The direction of that default is the whole point -- a missing entry costs a read tool
 * until someone lists it, and never silently permits a write.
 *
 * `ack_event` belongs here for the reason above and not by analogy: every reader of event_deliveries is
 * scoped to the caller's OWN rows (src/deliveries.ts:59/71/94), so acking changes which of the caller's
 * own events it has already seen. Leaving it out did not just cost a tool. `get_awareness` tells the
 * agent "Ack what you've handled with ack_event(seq, outcome)" and then the tool answers TRIAL_EXPIRED,
 * and a directed event whose subject has no read-based closure -- SUBJECT_STILL_OPEN is type-gated
 * (src/deliveries.ts:31), so task.accepted, approval.*, task.rejected and the rest all qualify -- comes
 * back at every checkpoint forever with its state stuck at "delivered". */
export const READ_TOOLS = new Set([
  "get_messages", "wait_for_message", "consume_messages", "get_message_status", "search_messages",
  "get_active_agents", "get_timeline", "wait_for_timeline", "get_awareness", "pull_events",
  "ack_event",
  "get_capabilities", "get_round_budget",
  "list_tasks", "get_task",
  "list_resource_locks",
  "get_fact", "list_facts",
  "get_agent_reliability", "list_agent_reliability", "get_task_shape_stats",
  "recall", "search_memory", "get_memory",
  "get_goal",
  "wait_for_approval", "list_approvals", "list_approval_grants",
  "download_file",
]);

/** WRITES a read-only workspace still allows, named one by one: each MCP tool name, and its REST twin as
 * "METHOD /route/pattern" (src/rest.ts passes billingVerb(), which yields that key for exactly these routes).
 * They stay writes everywhere else (tests/billing-classification-completeness.test.ts keeps them in WRITE_TOOLS);
 * only the lapse refusal skips them. An entry belongs here only if the write can only REDUCE risk, so refusing it
 * makes a lapsed workspace less safe, not more.
 *
 * - withdraw_approval: the agent that asked takes back its own pending approval request. It only cancels a risky
 *   action; it can't start one, decide one or grant anything. Refusing it would leave the request open for a person
 *   to approve by mistake while the workspace waits on its bill. Asking (request_approval) stays refused. */
export const LAPSE_EXEMPT_WRITES = new Set([
  "withdraw_approval",
  "POST /v1/approvals/:approvalId/withdraw",
]);

/** The verb src/rest.ts hands readOnlyRefusal: the method, except for a LAPSE_EXEMPT_WRITES route, which is named by
 * its full key so the exemption is that exact route and never a method-wide or prefix match. */
export function billingVerb(method: string, routePath: string | undefined): string {
  const key = `${method} ${routePath ?? ""}`;
  return LAPSE_EXEMPT_WRITES.has(key) ? key : method;
}

export interface ReadOnlyRefusal {
  status: number;
  body: {
    error: string;
    /** Stable, machine-readable, and safe for an agent to branch on. */
    code: typeof READ_ONLY_CODE;
    plan: string;
    trialEndsAt: string | null;
    subscriptionStatus: string;
    readOnly: true;
  };
}

export const READ_ONLY_CODE = "TRIAL_EXPIRED";

/** THE predicate. One verb, one decision, every surface: `verb` is an HTTP method for a REST call or
 * an MCP tool name for a tool call, and the two vocabularies cannot collide. `null` means go ahead.
 *
 * An OPERATOR is not refused on a LAPSED workspace. The kill switch already draws the line there -- an
 * operator keeps access while the workspace is paused (src/kill-switch.ts) -- and the reason carries
 * over exactly: the person who has to put a lapsed workspace back on a plan must be able to act inside
 * it. Agents are refused.
 *
 * EXCEPT ON "NO PLAN YET" (PENDING_PLAN). That workspace has never been paid for or trialed, so there is
 * nothing to "put back"; exempting its owner (whose console session maps to an operator) would make the
 * card-required trial a paywall its own owner walks through -- messages, tasks, memory, all of it. There
 * an operator is refused product writes like everyone else, and is let through only for `setup`: the
 * caller's statement that this request is one of the few writes needed to START (checkout, the billing
 * portal, inviting the team the seats are billed for). The caller decides which requests those are
 * (src/rest.ts PENDING_SETUP_ROUTES); this predicate decides everything else. */
export function readOnlyRefusal(
  orgId: string,
  verb: string,
  actor: { role?: AgentRole; setup?: boolean } = {},
  nowMs = Date.now(),
): ReadOnlyRefusal | null {
  if (SAFE_METHODS.has(verb) || READ_TOOLS.has(verb) || LAPSE_EXEMPT_WRITES.has(verb)) return null;
  const billing = workspaceBilling(orgId, nowMs);
  if (actor.role === "operator" && (!billing.awaitingPlan || actor.setup)) return null;
  if (!billing.readOnly) return null;
  return refusalFor(billing);
}

function refusalFor(billing: WorkspaceBilling): ReadOnlyRefusal {
  return {
    status: 402,
    body: {
      error: readOnlyMessage(billing),
      code: READ_ONLY_CODE,
      plan: billing.plan,
      trialEndsAt: billing.trialEndsAt,
      subscriptionStatus: billing.subscriptionStatus,
      readOnly: true,
    },
  };
}

/** When a workspace created on `planKey` right now runs out of clock, or null when that plan has no
 * clock -- which is how the non-expiring plan is expressed, as data. */
export function trialEndsAtFor(planKey: string, nowMs = Date.now()): string | null {
  const plan = readPlanRow.get(planKey) as { trial_days: number | null } | undefined;
  if (!plan?.trial_days) return null;
  return new Date(nowMs + plan.trial_days * 86_400_000).toISOString();
}

// --- Plan limits (PRICING.md section 8 item 2) ---------------------------------------------------
//
// A limit is refused with 402 and a code an agent can branch on, exactly like the read-only refusal,
// and for the same reason: the caller is a PROGRAM, and it owes it a remedy it can act on rather than a
// bare 403. `PLAN_LIMIT` is distinct from `TRIAL_EXPIRED` because the remedies are different -- one is
// "pay", the other is "use less or buy more of this one thing" -- and a caller that could not tell them
// apart would show the wrong prompt.
export const PLAN_LIMIT_CODE = "PLAN_LIMIT";

/** Which unit ran out. Also the word that appears in the message, so the code and the sentence cannot
 * drift apart. */
export const LIMITED_UNITS = ["machines", "agents", "projects", "workspaces", "webhooks"] as const;
export type LimitedUnit = (typeof LIMITED_UNITS)[number];

/** Units this build deliberately does NOT enforce yet, with the reason. Kept as data rather than as an
 * omission so a reader can tell "not built" from "forgotten".
 *
 *   workspaces  A refusal must name a remedy the caller can ACT ON, and there is no user-reachable route
 *               to change plan yet -- the plan lives in the table and only an operator or a webhook
 *               writes it. Enforcing `max_workspaces` today would refuse a second workspace with a
 *               message pointing at a page that cannot un-refuse it, which is the failure this module's
 *               own comment warns about (see readOnlyMessage). It becomes enforceable when the console
 *               ships the upgrade path; the count and the limit column already exist, so gating it is
 *               one call site, not new machinery. Ruled by 9d1f. */
export const UNGATED_UNITS: ReadonlySet<LimitedUnit> = new Set(["workspaces"]);

export interface PlanLimitRefusal {
  status: number;
  body: {
    error: string;
    code: typeof PLAN_LIMIT_CODE;
    plan: string;
    planName: string;
    /** The unit that is full: "agents", "projects", ... Never a number, so a caller can log it. */
    limit: LimitedUnit;
    /** What the plan allows, or null for unlimited (which is never refused). */
    allowed: number | null;
    /** What is in use right now, counted the way the limit is enforced. Null only for the live-agent count, when
     * liveCountVisibleTo (src/live-count.ts) withholds it from this caller. */
    used: number | null;
    /** Where the workspace goes to fix it. A hub URL, because it must never be a provider round-trip on
     * a refusal path (see readOnlyMessage's docstring for the same reasoning).
     *
     * NULL when this hub has no public app URL configured (`configuredAppUrl`). The message then NAMES the
     * operator instead of linking -- a refusal that says "go here" with nothing after it is worse than one
     * that names a person, and a placeholder URL is worse still because an agent will follow it. */
    upgradeUrl: string | null;
  };
}

/** Renders the refusal an agent reads. Names the unit, the numbers, and the remedy -- an agent-facing
 * product owes a refused agent a reason it can act on, which here means the name of the thing it hit
 * and where its operator buys more.
 *
 * "Already running keeps working" is stated because it is TRUE and it is the thing a refused agent most
 * needs to know: this refuses a NEW arrival, never a running one (the gates are at create and revive
 * only). An agent that reads only the code would otherwise assume the fleet is about to be cut. */
export function planLimitMessage(refusal: Omit<PlanLimitRefusal, "status">["body"]): string {
  // PENDING_PLAN allows 0 of everything: the remedy is not "use less" but "start the trial".
  if (refusal.plan === PENDING_PLAN) {
    const where = refusal.upgradeUrl ? ` in the console: ${refusal.upgradeUrl}` : " in the console";
    // No trial is promised here: this pure renderer cannot know whether the workspace's owner is still owed one.
    return `This workspace has not started a plan yet, so it cannot add ${refusal.limit}. The workspace owner can choose a plan to start it${where}.`;
  }
  const limit = refusal.allowed === null ? "unlimited" : `${refusal.allowed}`;
  // No URL configured => NAME the party who can act rather than link nowhere (readOnlyMessage makes the
  // same choice for the same reason). An unconfigured hub is the ordinary case in development and in
  // tests, and a remedy clause with an empty target reads as a truncated message.
  const remedy = refusal.upgradeUrl
    ? `To raise it, the workspace operator can change plan or add more of this unit: ${refusal.upgradeUrl}`
    : "Ask the workspace operator to change the plan or add more of this unit.";
  const inUse = refusal.used === null ? "" : ` ${refusal.used} in use and`;
  return `This workspace has reached its plan's limit on ${refusal.limit}:${inUse} the ${refusal.planName} plan allows ${limit}. Nothing already running is affected. ${remedy}`;
}

/** Builds the refusal for a unit that is full, or null when it is not.
 *
 * PURE on purpose: the caller passes the numbers, so the decision is unit-testable without a database,
 * an HTTP request or a provider -- and so the day the counting changes, the thing being tested is the
 * rule rather than the query. `allowed === null` is unlimited and NEVER refuses, which is the whole
 * point of the NULL convention: a plan with no ceiling must not be refused by a missing number.
 *
 * `used` is compared with `>=`, not `>`: the caller is a NEW arrival asking "may I be added", and it may
 * not, because the count already includes everyone already here. A `>` here would admit one over the
 * limit on every plan, which is the off-by-one that turns a published cap into a published lie. */
export function planLimitRefusal(
  limits: PlanLimits,
  unit: LimitedUnit,
  used: number,
  upgradeUrl: string | null,
  seats = 1,
): PlanLimitRefusal | null {
  // EVER-UNGATED UNITS ARE EXCLUDED HERE, and putting it in the DECISION rather than at each call site is
  // deliberate: a caller that forgot to check would silently enforce a limit the product cannot offer a
  // remedy for. `workspaces` is the one such unit today -- see UNGATED_UNITS for why (no user-reachable
  // upgrade route, so a refusal would point at a page that cannot un-refuse it).
  //
  // This line is the difference between RECORDING an exclusion and ENFORCING one. 1101's review note
  // caught that UNGATED_UNITS was declared and never read: the set documented the decision while the
  // refusal path ignored it, so the first call site for `workspaces` would have enforced it regardless.
  // A constant that is written and not read is a comment with a type.
  if (UNGATED_UNITS.has(unit)) return null;
  const stored = { machines: limits.maxMachines, agents: limits.maxAgents, projects: limits.maxProjects, workspaces: limits.maxWorkspaces, webhooks: limits.maxWebhooks }[unit];
  if (stored === null) return null;
  // Per-seat limits are pooled: the plan stores the PER SEAT figure (PRICING.md section 2, "5 per seat,
  // pooled"), so the allowance is the stored number times the seats. A single-seat plan is the same
  // arithmetic with a multiplier of 1, which is why this is not a special case. `seats` is floored at 1
  // so a miscount can never reduce an allowance to zero and refuse everyone.
  const allowed = PER_SEAT_LIMITS.has(unit) ? stored * Math.max(1, Math.floor(seats)) : stored;
  if (used < allowed) return null;
  const body: Omit<PlanLimitRefusal, "status">["body"] = {
    error: "",
    code: PLAN_LIMIT_CODE,
    plan: limits.key,
    planName: limits.name,
    limit: unit,
    allowed,
    used,
    upgradeUrl,
  };
  return { status: 402, body: { ...body, error: planLimitMessage(body) } };
}

/** How many LIVE agents a workspace has, counted the way the limit is enforced.
 *
 * THE RULE, and it is the reason this is two clauses rather than one: A LIMIT MUST NOT COUNT ROWS THE
 * USER HAS ALREADY RETIRED.
 *
 *   `removed_at IS NULL`      A removed agent is one the operator acted on. `checkAgentName` excludes
 *                             removed rows, so a removed agent GIVES UP ITS NAME and the same chat can
 *                             be set up again under it -- a new id, and the retired row stays. Counting
 *                             the retired row would inflate the total forever with identities the
 *                             workspace already retired, so the count would drift toward a limit it
 *                             never actually reached, and the refusal would name a remedy that does
 *                             not reduce the number. The user does exactly what we told them and is
 *                             refused again, which is the worst version of this failure.
 *
 *   `isOnline(...)`           LIVE, not "ever created": PRICING.md section 2 is explicit -- "counts
 *                             agents with a heartbeat in the last few minutes, not every agent ever
 *                             created" -- and it goes through the SAME `isOnline`/`HEARTBEAT_TTL_MS`
 *                             predicate `get_active_agents` uses, so the limit and the roster CANNOT
 *                             disagree about who is live. That is the property worth the indirection;
 *                             a second, separately-chosen window here would eventually drift from the
 *                             roster and refuse a workspace whose own roster said it was fine.
 *
 * NOT `src/org-usage.ts`'s counter. That one is a 30-DAY usage window and is a STAT, not a limit --
 * merging the two is how a workspace with twelve agents that each heartbeated last week reads as
 * "12 live" and gets refused while it is idle.
 *
 * Counted in JS rather than SQL because `isOnline` parses and compares instants (and accepts both the
 * ISO and the SQLite `datetime()` shapes); the row set is one workspace's live agents, which is small
 * by construction -- it is capped by the number being counted. */
export function countLiveAgents(orgId: string, nowMs = Date.now()): number {
  const rows = db.prepare(
    `SELECT last_heartbeat_at FROM agents WHERE org_id = ? AND removed_at IS NULL AND ended_at IS NULL`,
  ).all(orgId) as Array<{ last_heartbeat_at: string | null }>;
  return rows.filter((r) => isPresenceLive(r.last_heartbeat_at, nowMs)).length;
}

/** The presence predicate, over the SAME window and the same shapes as src/service.ts's `isOnline`.
 *
 * `isOnline` takes no clock and reads `Date.now()` inside, and src/service.ts already imports from this
 * module (`trialEndsAtFor`), so calling it here would be an import cycle. Rather than duplicate the WINDOW
 * -- which is the number that must not drift -- the window is `HEARTBEAT_TTL_MS`, now exported from
 * src/service.ts and imported here, and only the arithmetic is local.
 *
 * Both stored shapes are accepted by src/timestamps.ts's parseStamp. A value that does not parse
 * reads as OFFLINE, which is the direction that under-counts rather than refusing a live workspace. */
function isPresenceLive(lastHeartbeatAt: string | null, nowMs: number): boolean {
  if (!lastHeartbeatAt) return false;
  const t = parseStamp(lastHeartbeatAt);
  return Number.isFinite(t) && t > nowMs - HEARTBEAT_TTL_MS;
}

/** How many projects a workspace has, counted the way the limit is enforced.
 *
 * `enabled = 1`, for the same rule as above: a disabled project is one the operator acted on, and a
 * disabled project's sessions are already refused (src/projects.ts). Counting it would refuse a
 * workspace for a project it cannot use and cannot clear -- the row is still there either way, because
 * disabling is not deleting. This matches what `listProjects` surfaces as actionable, so the number a
 * user sees in the console equals the number enforced.
 *
 * A database whose `projects` rows predate the `enabled` column would have the column defaulted rather
 * than NULL (migration 15 adds it with a default), so `= 1` is the safe comparison in both directions. */
export function countEnabledProjects(orgId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE org_id = ? AND enabled = 1`).get(orgId) as { n: number }).n;
}

/** The machines a workspace HOLDS, which is what `max_machines` caps.
 *
 * A "machine" is a device that became one. All three conditions are load-bearing, and each excludes a
 * state that would otherwise consume a slot the user cannot account for:
 *
 *  - `code_redeemed_at IS NOT NULL` -- an UNREDEEMED code is an abandoned `connect`. Nothing reaps those
 *    rows (no DELETE and no reap path exists in src/devices.ts) and a later connect INSERTs a NEW row
 *    rather than reusing the old one, so counting them would let a user accumulate permanent, invisible
 *    slot consumption by running `connect` and walking away -- a machine absent from the roster and
 *    impossible to free. The same reasoning excludes anything past `code_expires_at`: it never became one.
 *  - `revoked_at IS NULL` -- a revoked device is gone, and it must FREE A SLOT, because the refusal this
 *    count produces has to name a remedy the caller can ACT ON (`UNGATED_UNITS`' comment, and the stated
 *    reason `workspaces` is not gated). A cap that cannot be cleared downward is not enforceable.
 *  - `merged_into_device_id IS NULL` -- a merged device is not a machine anymore; it folded into another
 *    one, and `listDevices` reports it as `merged` rather than as a device the workspace holds.
 *
 * Counted without the presence window `countLiveAgents` uses: a machine that is switched off is still a
 * machine, and the alternative would let a user exceed the cap by closing their laptop.
 *
 * NOTE this is deliberately NOT a count of `max_webhooks`-style surfaces -- see the module's own note on
 * `webhookLimiter` and the `setAgentWebhook` column for why webhooks have no independent population. */
export function countDevices(orgId: string): number {
  return (
    db.prepare(
      `SELECT COUNT(*) AS n FROM devices
        WHERE org_id = ? AND code_redeemed_at IS NOT NULL
          AND revoked_at IS NULL AND merged_into_device_id IS NULL`,
    ).get(orgId) as { n: number }
  ).n;
}

/** The workspace's upgrade surface, as a URL, for a refusal produced OUTSIDE an HTTP request.
 *
 * A route has `publicAppUrl(req)` (src/rest.ts) which falls back to the request's own host in
 * development. A CONNECT-CODE REDEMPTION has no request to ask, so it reads the same environment
 * variable that function reads -- one name for one fact, rather than a second source of truth for the
 * hub's own address.
 *
 * null when nothing is configured, and the message then falls back to naming the party who can act
 * instead of linking nowhere. That is the same choice src/billing.ts's readOnlyMessage documents: "a
 * link to a page that does not exist is worse for an agent than naming the one party who can act." A
 * placeholder URL is worse than no URL, because an agent will follow it. */
export function configuredAppUrl(): string | null {
  const configured = (process.env.OPENCADRE_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  return configured || null;
}

/** The refusal for adding ONE MORE agent, or null when the workspace may.
 *
 * WHY THIS LIVES HERE AND IS CALLED AT THE GATES RATHER THAN INSIDE `registerAgent`: `registerAgent` has
 * three callers and two of them must NOT be gated. `src/waitlist.ts` and `src/accounts.ts` create the
 * workspace's FIRST agent as part of approval and sign-up -- an operator-provisioned or self-serve
 * provision that is not "the user is adding an agent", and refusing it would deny a workspace the right
 * to have any agent at all, which is not what `max_agents` means. A block inside `registerAgent` would be
 * invisible to those call sites and would refuse them. So the question "may this workspace add an agent"
 * is asked where that is the actual question: the agent-create ROUTE (src/rest.ts) and the connect-code
 * redemption (src/connect.ts).
 *
 * A limit refusal is checked BEFORE the write and never after, so nothing is half-created -- and it is
 * checked on a TRANSITION TO LIVE only, never against agents already running: an agent that is live is
 * never cut, and `countLiveAgents`'s window is what makes "live" the same word the roster uses.
 *
 * `seats` is `workspaceBilling(...).seats` (`enforcedSeats`): the subscription's billed quantity, floored at the plan's
 * minimum -- what is paid for, never the member count.
 *
 * `upgradeUrl` may be null (see `configuredAppUrl`), and the message then names the operator instead of
 * linking. */
export function agentLimitRefusal(orgId: string, upgradeUrl: string | null = configuredAppUrl(), viewer?: LiveCountViewer): PlanLimitRefusal | null {
  const billing = workspaceBilling(orgId);
  const refusal = planLimitRefusal(billing.limits, "agents", countLiveAgents(orgId), upgradeUrl, billing.seats);
  // The DECISION always counts; only what the caller is TOLD goes through the disclosure predicate (src/live-count.ts).
  if (!refusal || liveCountVisibleTo(viewer)) return refusal;
  const body = { ...refusal.body, used: null };
  return { status: refusal.status, body: { ...body, error: planLimitMessage(body) } };
}

/** The live-agent count as `viewer` may see it: countLiveAgents (the set the limit counts), or null when
 * liveCountVisibleTo withholds it. GET /v1/me's `billing.used.agents`, under the same predicate as every 402. */
export function liveAgentsFor(orgId: string, viewer: LiveCountViewer, nowMs = Date.now()): number | null {
  return liveCountVisibleTo(viewer) ? countLiveAgents(orgId, nowMs) : null;
}

/** The refusal for ENABLING one more project, or null when the workspace may.
 *
 * Same reasoning as the agent limit, and the same counting rule: only ENABLED projects count, so the
 * number matches what the console shows and the user can clear a slot by disabling one. The remedy in
 * the message is therefore real -- `PUT /v1/org/projects` with `enabled: false` reduces this count. */
export function projectLimitRefusal(orgId: string, upgradeUrl: string | null = configuredAppUrl()): PlanLimitRefusal | null {
  const billing = workspaceBilling(orgId);
  return planLimitRefusal(billing.limits, "projects", countEnabledProjects(orgId), upgradeUrl, billing.seats);
}

/** The refusal for connecting ONE MORE machine, or null when the workspace may.
 *
 * THIS IS THE PROMISE `docs/planning/PRICING.md:107` ALREADY MAKES -- *"Connecting a 4th machine, or an
 * 11th live agent (Pro)"* is offered an add-on or Team -- and until this it had no enforcement behind it.
 * `planLimitRefusal` has read the `machines` value since migration 40, so this is one call site and no new
 * machinery, which is exactly what `UNGATED_UNITS`' comment says a gated unit costs.
 *
 * CALLED FROM `createDevice`, WHICH HAS ONE CALLER: `POST /v1/org/devices` (`rest.ts:866`), an
 * authenticated operator route guarded by `requirePermission("devices.manage")`. That is the clean case.
 * It is deliberately NOT called from inside `createDevice` itself for the reason recorded at
 * `registerAgent`'s guard (`:518-520`): the function is the right level for a gate only while every caller
 * should be gated, and a future caller (an operator console path, an admin import) may not be. Keeping the
 * gate at the route makes that decision visible at each call site instead of implicit in the function.
 *
 * The count is `countDevices` -- machines the workspace HOLDS. See its comment for why an abandoned
 * `connect` and a revoked device are both excluded; the short version is that a refusal has to name a
 * remedy the caller can act on. */
export function machineLimitRefusal(orgId: string, upgradeUrl: string | null = configuredAppUrl()): PlanLimitRefusal | null {
  const billing = workspaceBilling(orgId);
  return planLimitRefusal(billing.limits, "machines", countDevices(orgId), upgradeUrl, billing.seats);
}


/** Puts a workspace on a plan. This is the mechanism Phase 2's payment webhook calls, and it is what
 * makes "paying again reverses it" true by construction rather than by a special case: a plan with a
 * clock sets one, a plan without one clears the clock, and either way the workspace is entitled. */
export function assignPlan(orgId: string, planKey: string, nowMs = Date.now()): void {
  // `lapsed_at` is cleared, not left alone. It means "currently non-entitled" (migration 34), so an
  // entitled workspace carrying one would be a contradiction the billing predicate had to special-case.
  //
  // `provider_quantity` is cleared in the SAME write (Codex review of #654): it is the seats a provider subscription
  // BILLS, and a manual assignment is not a bill. Left alone, a canceled 10-seat Team put back on `team` by hand -- or a
  // Business quantity of 8 carried onto a manual Team -- would be writable at seats nobody pays for. Cleared, the
  // workspace counts the plan's floor (enforcedSeats) until a real provider write supplies a quantity again. The
  // subscription and customer refs and `billing_event_at` are deliberately kept: they address and order that
  // subscription, and the next provider write needs both.
  db.prepare(`UPDATE organizations SET plan = ?, trial_ends_at = ?, subscription_status = 'active', lapsed_at = NULL, provider_quantity = NULL WHERE id = ?`)
    .run(planKey, trialEndsAtFor(planKey, nowMs), orgId);
}


/** The shape a provider-reported status is allowed to have before it is stored.
 *
 * Bounded because of WHERE it lands: `subscription_status` is the column `workspaceBilling` branches
 * on, so this is the one field of an inbound, unauthenticated-shaped request that reaches the single
 * decision that matters. A cap does not make a value trustworthy -- `ENTITLED_STATUSES` does that, by
 * failing closed on everything it does not recognise -- but it does mean the predicate can only ever
 * be handed something that looks like a status rather than 4KB of whatever arrived. */
export const SUBSCRIPTION_STATUS_SHAPE = /^[a-z_]{1,32}$/;

/** Writes what the provider says about a subscription, AND the handle it came from, behind ONE ordering
 * guard.
 *
 * WHY THE HANDLE IS WRITTEN HERE RATHER THAN IN ITS OWN `UPDATE`. The ref and the status describe the
 * SAME subscription, so a guard that orders one and not the other lets them come from DIFFERENT events:
 * `created(subB)` followed by a late `deleted(subA)` would order the status correctly (A is older, so
 * this statement's guard refuses it) while an unguarded ref write flipped the handle back to A --
 * leaving the row saying "this workspace's subscription is B, and B is canceled", which is not a state
 * either event ever described. A proration caller reads the ref to choose WHAT to update and the status
 * to decide WHETHER it may; the two disagreeing means it updates the wrong subscription.
 *
 * ONE STATEMENT, ONE GUARD, both columns -- so they cannot diverge, rather than two guards that must be
 * kept in step by hand. That is also why there is no second, separate ref-writing statement in this
 * module: an unused one would be a second place for the guard to be forgotten.
 *
 * `COALESCE(?, ...)` on the ref means a caller with no handle to record (an absent or non-string id)
 * leaves the stored one ALONE rather than clearing it: the truthful record of "this event did not name a
 * subscription" is the previous handle, not NULL, and a provider omitting the field on some event type
 * must not un-address the workspace. */
const applySubscriptionEventWithRefStmt = db.prepare(
  `UPDATE organizations
      SET plan = COALESCE(?, plan), trial_ends_at = NULL, subscription_status = ?, billing_event_at = ?,
          billing_subscription_ref = COALESCE(?, billing_subscription_ref),
          lapsed_at = CASE WHEN ? THEN COALESCE(lapsed_at, ?) ELSE NULL END
    WHERE id = ? AND (billing_event_at IS NULL OR ${preciseInstantSql("billing_event_at")} <= ?)`,
);

/** Records what the payment provider says about a subscription -- the OTHER way entitlement is
 * written, alongside assignPlan, and the one a webhook calls.
 *
 * It differs from assignPlan in exactly one respect and that difference is the point: it stores the
 * status it is GIVEN rather than hard-setting 'active'. assignPlan is an operator putting a workspace
 * back on a plan, so 'active' is the only truthful thing for it to write. A provider reports what
 * actually happened -- including the statuses that mean NOT entitled -- and those are the ones that
 * matter most. Entitlement is still decided in exactly one place: ENTITLED_STATUSES in
 * workspaceBilling, which lapses on anything it does not recognise.
 *
 * `planKey` is nullable, and null means "leave the plan alone". That is not a convenience: a provider
 * event is authentic and about a workspace we can name while its PRICE is something this hub may have
 * no plan configured for, and the status is known independently of the price. Refusing to write the
 * status because the plan could not be derived would mean ignoring a real cancellation over a
 * configuration gap -- failing OPEN on the one input that decides access.
 *
 * THE LOCAL TRIAL CLOCK IS CLEARED UNCONDITIONALLY, which is a security decision rather than
 * tidiness. workspaceBilling prefers `trialEnded` over `lapsed` when it builds its reason, so a
 * surviving past `trial_ends_at` would report a PAYING workspace as read-only and name a trial date
 * that has nothing to do with why. Once a subscription exists the provider owns the clock, and the
 * local one must not be able to reach the workspace through that precedence.
 *
 * ORDERED, so a late event cannot undo a newer one. Providers do not promise delivery order and do
 * retry, so an `updated` carrying `active` can arrive after the `deleted` that superseded it. The
 * guard lives in the WHERE clause rather than in a read-then-write here or in the caller, because
 * only the database can make the comparison and the write indivisible -- a check in this file would
 * race the writer it is checking against.
 *
 * Returns true when the event was accepted, false when a STRICTLY NEWER event had already been
 * applied. Both are ordinary outcomes; a caller must not read false as an error.
 *
 * Strictly newer, and not "at least as new", because the comparison is `<=`: an event bearing the
 * SAME instant as the one already stored is applied rather than dropped. That is deliberate. The
 * provider's `created` has one-second granularity, and an `updated` and the `deleted` that supersedes
 * it routinely share a second; `<` would silently discard the cancellation, so the tie is resolved in
 * the direction that records rather than the one that ignores.
 *
 * The honest limit of this guard, stated here because a reader who trusts the paragraph above will
 * otherwise believe it is total: WITHIN a single second it does not order anything, and arrival order
 * decides. That residual belongs to the provider's timestamp resolution, not to this clause, and it
 * cannot be closed from here -- there is no finer instant in the payload to compare. */
export function applySubscriptionEvent(
  orgId: string,
  planKey: string | null,
  status: string,
  eventAt: string,
  subscriptionRef: string | null = null,
): boolean {
  // `lapsed_at` starts the grace clock on the transition INTO a lapse, and is cleared on any recovery.
  //
  // IT IS STAMPED WITH THE EVENT'S OWN TIME, not with the wall clock at the moment we processed it. The
  // provider is the authority on when the subscription lapsed, and a webhook can arrive late (a retry
  // after an outage) -- dating the grace from our receipt would hand out extra days for a delivery lag,
  // and would silently disagree with every other time on the row, which all come from the provider.
  // Stamping from `eventAt` also keeps the value consistent for callers that pin a clock.
  //
  // COALESCE(lapsed_at, ?) is what makes the clock START-ONCE rather than restart on every event: a
  // provider sends `past_due` and then reminders, and re-stamping on each would slide the deadline
  // forever, so a workspace that never pays would stay writable indefinitely. The first observation of
  // the lapse wins. The CASE is driven by LAPSE_STATUSES; the predicate grants grace only to its GRACE_STATUSES
  // subset, so a status can never start a grace clock here that the predicate would not honour.
  //
  // A RECOVERY CLEARS IT (the ELSE NULL arm): `lapsed_at` means "currently non-entitled" by contract, so
  // leaving it set on an active subscription would be the contradiction migration 34 exists to prevent.
  //
  // PARAMETER ORDER IS POSITIONAL AND TWO CONCERNS LAND IN ONE UPDATE, so it is spelled out here: the
  // statement's SET clause takes (plan, status, eventAt, subscriptionRef, startsLapse, lapseStamp) and
  // its WHERE takes (orgId, eventAt). The two branches' additions are independent -- e617's
  // subscription handle and this branch's grace stamp touch different columns -- so the union is safe
  // only because each is written as its own assignment. A merge that dropped either one would still
  // compile and still pass most tests, which is why the conflict was resolved by hand rather than by
  // taking a side.
  const startsLapse = LAPSE_STATUSES.has(status);
  const at = requirePreciseInstant(eventAt);
  return applySubscriptionEventWithRefStmt.run(planKey, status, at, subscriptionRef, startsLapse ? 1 : 0, at, orgId, at).changes > 0;
}

/** The instant a lapsed workspace's grace window closes, or null when it has none.
 *
 * Reads through `workspaceBilling` rather than querying the row again, so this can never disagree with
 * the predicate that actually refuses writes -- two decisions about one window is how they drift apart. */
export function graceEndsAt(orgId: string, nowMs = Date.now()): string | null {
  return workspaceBilling(orgId, nowMs).graceEndsAt;
}

const readCustomerRef = db.prepare(`SELECT billing_customer_ref FROM organizations WHERE id = ?`);
const readCustomerRefByRef = db.prepare(`SELECT id FROM organizations WHERE billing_customer_ref = ?`);

/** The provider's customer reference for a workspace (migration 30), or null when it has never been
 * through a checkout. Null is the ordinary answer, not a missing one: most workspaces have never paid. */
export function billingCustomerRef(orgId: string): string | null {
  const row = readCustomerRef.get(orgId) as { billing_customer_ref: string | null } | undefined;
  return row?.billing_customer_ref ?? null;
}

/** Writes the provider's customer reference. One column moves.
 *
 * It deliberately touches no plan, no clock and no status, because a reference is a POINTER and not an
 * entitlement -- it records which provider customer this workspace IS, and says nothing about what it
 * has paid for. That distinction is the one a later webhook is most likely to blur (it resolves a
 * workspace by this string and would love to stop there), so the write that creates the pointer is
 * kept structurally incapable of granting anything.
 *
 * A reference another workspace already holds fails on the index in migration 30 rather than on a
 * pre-check here: a pre-check would have to race the writer it is checking against, and a constraint
 * cannot. */
export function setBillingCustomerRef(orgId: string, ref: string | null): void {
  db.prepare(`UPDATE organizations SET billing_customer_ref = ? WHERE id = ?`).run(ref, orgId);
}

/** THERE IS DELIBERATELY NO `setBillingSubscriptionRef`, and its absence is the fix rather than an
 * omission. One existed and wrote the handle with a bare `UPDATE`, which is an UNGUARDED door to a
 * column whose sibling is ordered: `created(subB)` followed by a late `deleted(subA)` would be refused
 * for the status by the `billing_event_at` guard while the bare write flipped the handle back to A, so
 * the row would claim a subscription is B while saying B is canceled. Proration reads the ref to choose
 * WHAT to update and the status to decide WHETHER it may -- disagreeing, it updates the wrong one.
 *
 * The handle is therefore written ONLY by `applySubscriptionEvent`'s guarded statement, in the same
 * `UPDATE` as the status it describes. A second, unguarded writer is not a convenience; it is the bug,
 * and the way to keep it from being reintroduced is to leave no function that does it.
 *
 * The column itself (migration 33) is documented here because a reader arriving from the schema will
 * look for the writer: it is an EFFECT HANDLE, not a lookup key, which is why it has no UNIQUE index
 * where `billing_customer_ref` has one (that column resolves a workspace FROM a webhook; this one
 * addresses a subscription TO the provider). NULL is the ordinary value -- most workspaces never
 * checked out -- and it means "this hub was never told", NOT "not paid": the `status` column is the only
 * thing that answers whether a workspace is paid, and a canceled subscription still has a handle. */


/** Which workspace the provider's customer belongs to -- the reverse lookup, and the only caller that
 * earns the reference its uniqueness. A webhook arrives carrying this string and nothing else, so two
 * workspaces holding it would make the lookup ambiguous, and an ambiguous lookup grants the wrong
 * workspace's plan.
 *
 * An unknown reference answers null rather than throwing: the caller is a handler for input this
 * system did not author, and "we have never seen this customer" is an ordinary thing for it to be
 * sent. It must be answerable, and it must never fall back to a workspace that happens to exist. */
export function workspaceForBillingCustomerRef(ref: string): string | null {
  const row = readCustomerRefByRef.get(ref) as { id: string } | undefined;
  return row?.id ?? null;
}

// --- the payment provider billing (migrations 46, 47): provider refs, billing mirror, checkout records, webhook idempotency --------
//
// The Stripe-era `billing_customer_ref` / `billing_subscription_ref` above are no longer read by any live route. The
// provider refs below are always read TOGETHER WITH `billing_provider`, the provider-and-environment tag they were
// written under ("paddle-sandbox" / "paddle-live"); a ref under a different tag is treated as absent. That is the
// guard that keeps sandbox and live apart, since a the payment provider webhook payload names no environment.

/** Every instant this module writes to `billing_event_at` / `lapsed_at` goes through here, so the column holds ONE
 * spelling (src/timestamps.ts `preciseInstant`). A value that is not an instant is a caller bug, not provider input:
 * provider input is normalised (and refused) before it reaches this module. */
function requirePreciseInstant(value: string): string {
  const precise = preciseInstant(value);
  if (!precise) throw new Error(`billing: not an RFC 3339 instant: ${JSON.stringify(value).slice(0, 60)}`);
  return precise;
}

/** Writes what the provider says about a subscription AND which subscription, customer and environment it was, and the
 * mirror of what is billed (price, quantity, scheduled change), behind ONE `billing_event_at` ordering guard -- one
 * statement, one guard, every column, so the handle, the status and the mirror can never come from different events.
 *
 * `planKey` null leaves the plan alone (an unmapped price must not stop a cancellation being recorded; the caller
 * decides what an unmapped price may do to ACCESS, src/billing-reconcile.ts). The local trial clock is cleared (the
 * provider owns the clock once a subscription exists), and `lapsed_at` starts once on the transition into a lapse
 * status and clears on recovery -- all exactly as `applySubscriptionEvent`.
 *
 * THE GUARD HAS TWO STRENGTHS. A webhook EVENT must be strictly newer than what is stored (`<`): two different states
 * bearing the same instant cannot be ordered by either of them, so neither is allowed to overwrite the other and the
 * caller settles the tie by asking the payment provider. A SNAPSHOT fetched from the payment provider's API is the provider's current answer, so it
 * also wins a tie (`<=`). Both compare at full precision (microseconds, src/timestamps.ts); the stored side is read
 * through `preciseInstantSql` so a value written at millisecond precision before this change still orders correctly. */
const providerWriteSql = (comparison: "<" | "<=") =>
  `UPDATE organizations
      SET plan = COALESCE(?, plan), trial_ends_at = NULL, subscription_status = ?, billing_event_at = ?,
          billing_provider = ?, provider_subscription_id = ?, provider_customer_id = COALESCE(?, provider_customer_id),
          provider_price_id = ?, provider_quantity = ?, scheduled_change_action = ?, scheduled_change_at = ?,
          provider_customer_email = COALESCE(?, provider_customer_email),
          provider_customer_email_error_at = CASE WHEN ? IS NULL THEN provider_customer_email_error_at ELSE NULL END,
          provider_next_billed_at = ?,
          trial_used_at = CASE WHEN ? THEN COALESCE(trial_used_at, ?) ELSE trial_used_at END,
          first_paid_at = CASE WHEN ? THEN COALESCE(first_paid_at, ?) ELSE first_paid_at END,
          lapsed_at = CASE WHEN ? THEN COALESCE(lapsed_at, ?) ELSE NULL END
    WHERE id = ? AND (billing_event_at IS NULL OR ${preciseInstantSql("billing_event_at")} ${comparison} ?)`;
const applyProviderEventStmt = db.prepare(providerWriteSql("<"));
const applyProviderSnapshotStmt = db.prepare(providerWriteSql("<="));
const readEventAtStmt = db.prepare(`SELECT ${preciseInstantSql("billing_event_at")} AS at FROM organizations WHERE id = ?`);

export interface ProviderSubscriptionWrite {
  planKey: string | null;
  status: string;
  /** The provider's instant for this state, RFC 3339 (stored at full precision). */
  eventAt: string;
  providerTag: string;
  subscriptionId: string;
  customerId: string | null;
  /** The price being billed (the one the plan was read from, else the first item), or null. */
  priceId?: string | null;
  /** The billed quantity of that price (seats), or null. */
  quantity?: number | null;
  /** A pending cancel/pause, or null when none is scheduled (which CLEARS a stored one). */
  scheduledChange?: { action: string; effectiveAt: string | null } | null;
  /** The customer's email read from the payment provider alongside the subscription (first binding). Null leaves the stored one. */
  customerEmail?: string | null;
  /** the payment provider's `next_billed_at` (for a trialing subscription: when the trial converts). Null clears the mirror. */
  nextBilledAt?: string | null;
  /** This state is (or came from) a the payment provider trial: stamps `trial_used_at` once, which uses up the workspace's trial. */
  trial?: boolean;
  /** This state proves a payment was completed (active after a first bill): stamps `first_paid_at` once. */
  paid?: boolean;
}

/** "written"; "stale" (a strictly newer state was already applied: an ordinary outcome); or "tie" (an EVENT with the
 * very instant already stored -- nothing was written, and only the provider can say which of the two is current). */
export type ProviderWriteOutcome = "written" | "stale" | "tie";

/** The one the payment provider entitlement write. `source` is "event" for a webhook payload and "snapshot" for a subscription read
 * from the payment provider's API; see the guard's two strengths above. */
export function writeProviderSubscription(orgId: string, write: ProviderSubscriptionWrite, source: "event" | "snapshot"): ProviderWriteOutcome {
  const at = requirePreciseInstant(write.eventAt);
  const scheduledAt = write.scheduledChange?.effectiveAt ? preciseInstant(write.scheduledChange.effectiveAt) : null;
  const nextBilledAt = write.nextBilledAt ? preciseInstant(write.nextBilledAt) : null;
  const startsLapse = LAPSE_STATUSES.has(write.status);
  return db.transaction((): ProviderWriteOutcome => {
    // Read inside the same transaction as the write (SQLite serialises writers), so "was the workspace's trial already
    // used?" and the write below cannot interleave with another event's.
    const trialAlreadyUsed = (readOrgTrialUsedStmt.get(orgId) as { trial_used_at: string | null } | undefined)?.trial_used_at != null;
    const run = (source === "event" ? applyProviderEventStmt : applyProviderSnapshotStmt).run(
      write.planKey, write.status, at,
      write.providerTag, write.subscriptionId, write.customerId,
      write.priceId ?? null, write.quantity ?? null, write.scheduledChange?.action ?? null, scheduledAt,
      write.customerEmail ?? null, write.customerEmail ?? null,
      nextBilledAt,
      write.trial ? 1 : 0, at,
      write.paid ? 1 : 0, at,
      startsLapse ? 1 : 0, at,
      orgId, at,
    );
    const changed = run.changes > 0;
    // A trial STARTING uses up the trial of every PERSON it belongs to (migration 50), in the same transaction -- and only
    // then: on the one write that moves the workspace's own trial_used_at from NULL to set. `write.trial` is also true
    // for every later update of a subscription on a trial price (an active renewal, a seat change), and stamping on
    // those would charge a trial to someone invited as owner long after the trial ended; a replayed or duplicate
    // trialing event must not re-stamp either. The people present when it started are the ones it belongs to.
    if (changed && write.trial && !trialAlreadyUsed) stampPeopleTrialStmt.run(at, orgId, orgId, orgId);
    if (changed) return "written";
    const stored = readEventAtStmt.get(orgId) as { at: string | null } | undefined;
    return source === "event" && stored?.at === at ? "tie" : "stale";
  })();
}

/** True when written, false when not. A SNAPSHOT-strength write (ties are applied): what an operator tool or a test
 * that states "the provider says" means. Webhook events go through `writeProviderSubscription(..., "event")`. */
export function applyProviderSubscription(orgId: string, write: ProviderSubscriptionWrite): boolean {
  return writeProviderSubscription(orgId, write, "snapshot") === "written";
}

const readCustomerEmailTargets = db.prepare(`SELECT id FROM organizations WHERE provider_customer_id = ? AND billing_provider = ?`);
const writeCustomerEmailStmt = db.prepare(
  `UPDATE organizations SET provider_customer_email = ?, provider_customer_email_error_at = NULL
    WHERE provider_customer_id = ? AND billing_provider = ?`,
);
const markCustomerEmailUnresolvedStmt = db.prepare(
  `UPDATE organizations SET provider_customer_email_error_at = ? WHERE id = ? AND billing_provider = ? AND provider_customer_email IS NULL`,
);
const readCustomerEmailStateStmt = db.prepare(
  `SELECT provider_customer_id, provider_customer_email, provider_customer_email_error_at FROM organizations
    WHERE id = ? AND billing_provider = ?`,
);

/** THE DURABLE SIGNAL that a customer's email could not be read (migration 48): stamped when the read at binding (or
 * a reconcile retry) fails, cleared by any write of the email. The email is contact data, not entitlement, so a failed
 * read never fails a binding -- but it must not vanish into a log line either: this column is what an operator can
 * query, and `customerEmailToHeal` is what the reconcile path reads to retry. */
export function markCustomerEmailUnresolved(orgId: string, providerTag: string, nowMs = Date.now()): void {
  markCustomerEmailUnresolvedStmt.run(new Date(nowMs).toISOString(), orgId, providerTag);
}

/** The workspace's the payment provider customer id when it is bound under `providerTag` and its email is still unknown -- the case
 * the reconcile path heals (a customer.created that arrived before the binding, or a failed read at binding). */
export function customerEmailToHeal(orgId: string, providerTag: string): { customerId: string; errorAt: string | null } | null {
  const row = readCustomerEmailStateStmt.get(orgId, providerTag) as
    | { provider_customer_id: string | null; provider_customer_email: string | null; provider_customer_email_error_at: string | null }
    | undefined;
  if (!row || !row.provider_customer_id || row.provider_customer_email !== null) return null;
  return { customerId: row.provider_customer_id, errorAt: row.provider_customer_email_error_at };
}

/** Mirrors a the payment provider customer's email onto every workspace that holds that customer under this environment tag (one
 * the payment provider customer per email, so one owner paying for two workspaces is one customer on both). Returns the workspaces
 * written; none is an ordinary answer -- the customer may not have bound a subscription here yet -- and nothing is ever
 * created for it. Grants nothing: it is contact data, not an entitlement. */
export function upsertProviderCustomerEmail(providerTag: string, customerId: string, email: string | null): string[] {
  return db.transaction(() => {
    const ids = (readCustomerEmailTargets.all(customerId, providerTag) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length) writeCustomerEmailStmt.run(email, customerId, providerTag);
    return ids;
  })();
}

const readProviderRefs = db.prepare(
  `SELECT billing_provider, provider_customer_id, provider_subscription_id, subscription_status FROM organizations WHERE id = ?`,
);

export interface ProviderRefs {
  customerId: string | null;
  subscriptionId: string | null;
  /** The status last written for that subscription. */
  status: string;
}

/** This workspace's provider refs under `providerTag`, or nulls when it has none there (never paid, or paid in the
 * other environment). */
export function providerRefs(orgId: string, providerTag: string): ProviderRefs {
  const row = readProviderRefs.get(orgId) as
    | { billing_provider: string | null; provider_customer_id: string | null; provider_subscription_id: string | null; subscription_status: string }
    | undefined;
  if (!row || row.billing_provider !== providerTag) return { customerId: null, subscriptionId: null, status: row?.subscription_status ?? "active" };
  return { customerId: row.provider_customer_id, subscriptionId: row.provider_subscription_id, status: row.subscription_status };
}

const readBySubscription = db.prepare(
  `SELECT id FROM organizations WHERE provider_subscription_id = ? AND billing_provider = ? LIMIT 2`,
);

/** The workspace holding this subscription under this tag, or null -- including when two rows claim it, because an
 * ambiguous lookup would grant the wrong workspace's plan. */
export function workspaceForProviderSubscription(providerTag: string, subscriptionId: string): string | null {
  const rows = readBySubscription.all(subscriptionId, providerTag) as Array<{ id: string }>;
  return rows.length === 1 ? rows[0].id : null;
}

/** Statuses under which a workspace already HAS a subscription it should manage rather than buy again. `canceled`
 * is not here: a canceled the payment provider subscription "can't be reinstated" and a returning customer checks out anew
 * (https://developer.paddle.com/build/subscriptions/cancel-subscriptions). */
export const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due", "paused", PRICE_UNMAPPED_STATUS]);

export interface CheckoutRecord {
  transactionId: string;
  orgId: string;
  provider: string;
  plan: string;
  interval: string;
  founding: boolean;
  createdAt: string;
  resolvedAt: string | null;
  outcome: string | null;
}

type CheckoutRow = {
  transaction_id: string; org_id: string; provider: string; plan: string; billing_interval: string;
  founding: number; created_at: string; resolved_at: string | null; outcome: string | null;
};
const toCheckout = (r: CheckoutRow): CheckoutRecord => ({
  transactionId: r.transaction_id, orgId: r.org_id, provider: r.provider, plan: r.plan, interval: r.billing_interval,
  founding: r.founding === 1, createdAt: r.created_at, resolvedAt: r.resolved_at, outcome: r.outcome,
});

const insertCheckoutStmt = db.prepare(
  `INSERT INTO billing_checkouts (transaction_id, org_id, provider, plan, billing_interval, founding, created_at, person_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const readCheckoutStmt = db.prepare(`SELECT * FROM billing_checkouts WHERE transaction_id = ?`);
const readOpenCheckoutsStmt = db.prepare(
  `SELECT * FROM billing_checkouts WHERE org_id = ? AND provider = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT ?`,
);
const resolveCheckoutStmt = db.prepare(
  `UPDATE billing_checkouts SET resolved_at = ?, outcome = ? WHERE transaction_id = ? AND resolved_at IS NULL`,
);

/** Records a checkout transaction the hub created. Called BEFORE the id is handed to the browser, so a checkout can
 * never be paid that this table does not hold. */
export function recordCheckout(record: Omit<CheckoutRecord, "resolvedAt" | "outcome"> & { personId?: string | null }): void {
  insertCheckoutStmt.run(record.transactionId, record.orgId, record.provider, record.plan, record.interval, record.founding ? 1 : 0, record.createdAt, record.personId ?? null);
}

export function checkoutByTransaction(transactionId: string): CheckoutRecord | null {
  const row = readCheckoutStmt.get(transactionId) as CheckoutRow | undefined;
  return row ? toCheckout(row) : null;
}

/** The workspace's checkouts that have not reached a final answer, newest first. */
export function openCheckouts(orgId: string, providerTag: string, limit = 5): CheckoutRecord[] {
  return (readOpenCheckoutsStmt.all(orgId, providerTag, limit) as CheckoutRow[]).map(toCheckout);
}

/** Final answers only: "completed" (the subscription was applied), "canceled" (the provider canceled the
 * transaction), "superseded" (a newer checkout replaced an UNPAID one). Never set by a timer. */
export type CheckoutOutcome = "completed" | "canceled" | "superseded";

export function resolveCheckout(transactionId: string, outcome: CheckoutOutcome, nowMs = Date.now()): boolean {
  return resolveCheckoutStmt.run(new Date(nowMs).toISOString(), outcome, transactionId).changes > 0;
}

const readWebhookEventStmt = db.prepare(`SELECT 1 AS seen FROM billing_webhook_events WHERE event_id = ?`);
const insertWebhookEventStmt = db.prepare(
  `INSERT OR IGNORE INTO billing_webhook_events (event_id, event_type, processed_at) VALUES (?, ?, ?)`,
);

export function webhookEventProcessed(eventId: string): boolean {
  return Boolean(readWebhookEventStmt.get(eventId));
}

/** Marks an event processed. INSERT OR IGNORE: a concurrent duplicate that raced past `webhookEventProcessed` did the
 * same idempotent work and must not turn into an error. */
export function recordWebhookEvent(eventId: string, eventType: string, nowMs = Date.now()): void {
  insertWebhookEventStmt.run(eventId, eventType, new Date(nowMs).toISOString());
}
