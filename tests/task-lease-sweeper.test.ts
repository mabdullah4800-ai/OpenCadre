import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { createOrganization, registerAgent } from "../src/service.js";
import {
  LEASE_SWEEP_BATCH, claimTask, completeTask, createTask, noteLapsedLease, renewClaim, sweepAllExpiredLeases, sweepExpiredLeases,
  type TaskRecord,
} from "../src/tasks.js";

// The lease-expiry sweeper only NOTIFIES (Codex ruling, plan 2026-09-30 §1): one task.lease_expired per lapsed
// lease, and never a change to status, claimant or lease. Its write is conditional on the row still being the
// claim the sweep saw, so a renewal, takeover or completion that lands between the sweep's read and its write
// cannot produce a notice about a lease that no longer exists.

function setup(name = "Sweeper Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Sweeper-A");
  const b = registerAgent(orgId, "Sweeper-B");
  return { orgId, a: { id: a.agentId, name: "Sweeper-A" }, b: { id: b.agentId, name: "Sweeper-B" } };
}

const past = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** Backdates a claim's lease so it has lapsed, without sleeping. */
function lapse(taskId: string, minutesAgo = 5): void {
  db.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ?`).run(past(minutesAgo), taskId);
}

const row = (taskId: string) => db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRecord;
const expiries = (orgId: string, taskId: string) =>
  listEvents(orgId, { types: ["task.lease_expired"] }).filter((e) => e.subject_id === taskId);

describe("sweepExpiredLeases: notifies once per lapsed lease", () => {
  it("emits exactly one task.lease_expired for a lapsed claim, however often it runs", () => {
    const { orgId, a } = setup();
    const task = createTask(orgId, a, { title: "lapsing work" });
    expect(claimTask(orgId, a, task.id, 60).ok).toBe(true);
    lapse(task.id);
    sweepExpiredLeases(orgId);
    sweepExpiredLeases(orgId);
    sweepExpiredLeases(orgId);
    const events = expiries(orgId, task.id);
    expect(events).toHaveLength(1);
    expect(events[0].target_agent_id).toBe(a.id);
  });

  it("changes nothing but the emitted marker: status, claimant and lease stay exactly as they were", () => {
    const { orgId, a } = setup();
    const task = createTask(orgId, a, { title: "untouched claim" });
    claimTask(orgId, a, task.id, 60);
    lapse(task.id);
    const before = row(task.id);
    sweepExpiredLeases(orgId);
    const after = row(task.id);
    expect(after.lease_expiry_emitted_at).not.toBeNull();
    expect(after.status).toBe("claimed");
    expect(after.claimed_by_agent_id).toBe(a.id);
    expect(after.claimed_by_agent_name).toBe("Sweeper-A");
    expect(after.lease_expires_at).toBe(before.lease_expires_at);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("does not emit when a renewal beats the sweep", () => {
    const { orgId, a } = setup();
    const task = createTask(orgId, a, { title: "renewed in time" });
    claimTask(orgId, a, task.id, 60);
    lapse(task.id);
    expect(renewClaim(orgId, a, task.id, 60).ok).toBe(true);
    sweepExpiredLeases(orgId);
    expect(expiries(orgId, task.id)).toHaveLength(0);
  });

  it("does not emit for the lease the sweep saw when a renewal lands between its read and its write", () => {
    const { orgId, a } = setup();
    const task = createTask(orgId, a, { title: "renew race" });
    claimTask(orgId, a, task.id, 60);
    lapse(task.id);
    const seen = row(task.id); // the sweep's read
    expect(renewClaim(orgId, a, task.id, 60).ok).toBe(true); // lands before the sweep's write
    expect(noteLapsedLease(orgId, seen)).toBe(false);
    expect(expiries(orgId, task.id)).toHaveLength(0);
  });

  it("does not emit a second notice at the old claimant after a takeover", () => {
    const { orgId, a, b } = setup();
    const task = createTask(orgId, a, { title: "taken over" });
    claimTask(orgId, a, task.id, 60);
    lapse(task.id);
    const seen = row(task.id);
    expect(claimTask(orgId, b, task.id, 60).ok).toBe(true); // B takes the lapsed claim (its own read notifies A once)
    expect(noteLapsedLease(orgId, seen)).toBe(false);
    const events = expiries(orgId, task.id);
    expect(events).toHaveLength(1);
    expect(events[0].target_agent_id).toBe(a.id);
    expect(row(task.id).claimed_by_agent_id).toBe(b.id);
  });

  it("does not emit after the claimant completes the task", () => {
    const { orgId, a } = setup();
    const task = createTask(orgId, a, { title: "finished late" });
    claimTask(orgId, a, task.id, 60);
    lapse(task.id);
    const seen = row(task.id);
    expect(completeTask(orgId, a, task.id, "done").ok).toBe(true);
    expect(noteLapsedLease(orgId, seen)).toBe(false);
    sweepExpiredLeases(orgId);
    expect(expiries(orgId, task.id)).toHaveLength(0);
    expect(row(task.id).status).toBe("done");
  });

  it("emits again when a renewed lease lapses again", () => {
    const { orgId, a } = setup();
    const task = createTask(orgId, a, { title: "lapses twice" });
    claimTask(orgId, a, task.id, 60);
    lapse(task.id, 10);
    sweepExpiredLeases(orgId);
    expect(renewClaim(orgId, a, task.id, 60).ok).toBe(true);
    expect(row(task.id).lease_expiry_emitted_at).toBeNull();
    lapse(task.id, 2);
    sweepExpiredLeases(orgId);
    expect(expiries(orgId, task.id)).toHaveLength(2);
  });

  it("emits at most LEASE_SWEEP_BATCH notices per workspace per run, and the rest on the next", () => {
    const { orgId, a } = setup("Sweeper Batch Org");
    const extra = 5;
    for (let i = 0; i < LEASE_SWEEP_BATCH + extra; i++) {
      const t = createTask(orgId, a, { title: `batch ${i}` });
      claimTask(orgId, a, t.id, 60);
    }
    db.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE org_id = ?`).run(past(5), orgId);
    // Counted in SQL: listEvents pages at 200, which is the bound under test.
    const count = () => (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND type = 'task.lease_expired'`).get(orgId) as { n: number }).n;
    sweepExpiredLeases(orgId);
    expect(count()).toBe(LEASE_SWEEP_BATCH);
    sweepExpiredLeases(orgId);
    expect(count()).toBe(LEASE_SWEEP_BATCH + extra);
  });
});

describe("sweepAllExpiredLeases: the 60 s server timer's cross-workspace sweep", () => {
  it("notifies lapsed claims in every workspace without a read in any of them", () => {
    const one = setup("Sweeper All One");
    const two = setup("Sweeper All Two");
    const t1 = createTask(one.orgId, one.a, { title: "one" });
    const t2 = createTask(two.orgId, two.b, { title: "two" });
    claimTask(one.orgId, one.a, t1.id, 60);
    claimTask(two.orgId, two.b, t2.id, 60);
    lapse(t1.id);
    lapse(t2.id);
    sweepAllExpiredLeases();
    expect(expiries(one.orgId, t1.id)).toHaveLength(1);
    expect(expiries(two.orgId, t2.id)).toHaveLength(1);
    expect(row(t1.id)).toMatchObject({ status: "claimed", claimed_by_agent_id: one.a.id });
    expect(row(t2.id)).toMatchObject({ status: "claimed", claimed_by_agent_id: two.b.id });
  });

  it("leaves a live lease alone", () => {
    const { orgId, a } = setup("Sweeper All Live");
    const task = createTask(orgId, a, { title: "still leased" });
    claimTask(orgId, a, task.id, 60);
    sweepAllExpiredLeases();
    expect(expiries(orgId, task.id)).toHaveLength(0);
  });
});
