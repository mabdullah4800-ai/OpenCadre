import { describe, expect, it } from "vitest";
import { createOrganization, registerAgent } from "../src/service.js";
import { claimResource, listResourceLocks, releaseResource, renewResourceLock, ResourceLockInputError } from "../src/resource-locks.js";

function setupOrg(name = "Resource Locks Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return { orgId, a: { id: a.agentId, name: "Agent A" }, b: { id: b.agentId, name: "Agent B" } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("claimResource (design retro #4: a mutex for a shared mutable path/branch, since the hub can't provision a worktree remotely)", () => {
  it("lets one agent claim a fresh resource key", () => {
    const { orgId, a } = setupOrg();
    const result = claimResource(orgId, a, "/Users/x/Projects/sample-project", 60);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.holder_agent_name).toBe("Agent A");
    expect(result.lock.resource_key).toBe("/Users/x/Projects/sample-project");
  });

  it("blocks a second agent while the lease is active, naming the current holder", () => {
    const { orgId, a, b } = setupOrg();
    claimResource(orgId, a, "shared-path", 60);
    const blocked = claimResource(orgId, b, "shared-path", 60);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error).toContain("Agent A");
  });

  it("is idempotent for the current holder -- a renewal, not a takeover", () => {
    const { orgId, a } = setupOrg();
    expect(claimResource(orgId, a, "k", 60).ok).toBe(true);
    expect(claimResource(orgId, a, "k", 120).ok).toBe(true);
  });

  it("lets another agent take over once the lease expires", async () => {
    const { orgId, a, b } = setupOrg();
    expect(claimResource(orgId, a, "k", 0.2).ok).toBe(true);
    await sleep(300);
    const takeover = claimResource(orgId, b, "k", 60);
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;
    expect(takeover.lock.holder_agent_name).toBe("Agent B");
  });

  it("rejects an empty or overlong resourceKey", () => {
    const { orgId, a } = setupOrg();
    expect(() => claimResource(orgId, a, "", 60)).toThrow(ResourceLockInputError);
    expect(() => claimResource(orgId, a, "   ", 60)).toThrow(ResourceLockInputError);
    expect(() => claimResource(orgId, a, "x".repeat(501), 60)).toThrow(ResourceLockInputError);
  });

  it("rejects out-of-range lease lengths", () => {
    const { orgId, a } = setupOrg();
    expect(claimResource(orgId, a, "k", 0).ok).toBe(false);
    expect(claimResource(orgId, a, "k", 7 * 24 * 3600).ok).toBe(false);
  });

  it("never leaks across orgs -- the same resourceKey string in a different org doesn't collide", () => {
    const { orgId: orgA, a } = setupOrg("Org A");
    const { orgId: orgB, a: bAgent } = setupOrg("Org B");
    expect(claimResource(orgA, a, "same-key", 60).ok).toBe(true);
    expect(claimResource(orgB, bAgent, "same-key", 60).ok).toBe(true); // not blocked by org A's lock
    expect(listResourceLocks(orgA)).toHaveLength(1);
    expect(listResourceLocks(orgB)).toHaveLength(1);
  });
});

describe("renewResourceLock", () => {
  it("extends only the actual holder's lease", () => {
    const { orgId, a, b } = setupOrg();
    claimResource(orgId, a, "k", 60);
    expect(renewResourceLock(orgId, b, "k", 60).ok).toBe(false);
    expect(renewResourceLock(orgId, a, "k", 120).ok).toBe(true);
  });

  it("fails for a resourceKey nobody has claimed", () => {
    const { orgId, a } = setupOrg();
    expect(renewResourceLock(orgId, a, "never-claimed", 60).ok).toBe(false);
  });

  it("the holder can still renew after their own lease has lapsed, if nobody else took over", async () => {
    const { orgId, a } = setupOrg();
    claimResource(orgId, a, "k", 0.2);
    await sleep(300);
    // Renewal is a plain UPDATE keyed on holder_agent_id -- it doesn't check lease_expires_at, so a
    // slow renew doesn't lose the lock to a takeover that hasn't actually happened yet.
    expect(renewResourceLock(orgId, a, "k", 60).ok).toBe(true);
  });
});

describe("releaseResource", () => {
  it("lets the holder release, freeing the key for anyone", () => {
    const { orgId, a, b } = setupOrg();
    claimResource(orgId, a, "k", 60);
    expect(releaseResource(orgId, a, "k").ok).toBe(true);
    expect(claimResource(orgId, b, "k", 60).ok).toBe(true);
  });

  it("refuses to release someone else's lock", () => {
    const { orgId, a, b } = setupOrg();
    claimResource(orgId, a, "k", 60);
    const result = releaseResource(orgId, b, "k");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Agent A");
  });

  it("refuses to release a key nobody holds, or one whose lease already lapsed", async () => {
    const { orgId, a } = setupOrg();
    expect(releaseResource(orgId, a, "never-claimed").ok).toBe(false);
    claimResource(orgId, a, "k", 0.2);
    await sleep(300);
    expect(releaseResource(orgId, a, "k").ok).toBe(false); // lapsed -- claim it again instead
  });
});

describe("listResourceLocks", () => {
  it("lists every lock in the org, sorted by key, and none from another org", () => {
    const { orgId, a, b } = setupOrg();
    const { orgId: otherOrg, a: other } = setupOrg("Other Org");
    claimResource(orgId, a, "z-last", 60);
    claimResource(orgId, b, "a-first", 60);
    claimResource(otherOrg, other, "should-not-appear", 60);

    const locks = listResourceLocks(orgId);
    expect(locks.map((l) => l.resource_key)).toEqual(["a-first", "z-last"]);
  });
});

// Board task 081baee9, reported from real use: renew(60 s) on a lock held until 12:42 cut it to 12:13, and a
// holder's re-claim silently re-leased and answered "Claimed" with no sign it was already theirs.
describe("lease lengths never shrink silently (081baee9)", () => {
  const ms = (iso: string) => Date.parse(iso);

  it("renew never shortens: a renew shorter than the time left keeps the current expiry and says so", () => {
    const { orgId, a } = setupOrg();
    const claimed = claimResource(orgId, a, "k", 3600);
    if (!claimed.ok) throw new Error(claimed.error);
    const renewed = renewResourceLock(orgId, a, "k", 60);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.lock.lease_expires_at).toBe(claimed.lock.lease_expires_at);
    expect(renewed.leaseChanged).toBe(false);
    expect(renewed.leaseExpiresAt).toBe(claimed.lock.lease_expires_at);
    expect(listResourceLocks(orgId)[0].lease_expires_at).toBe(claimed.lock.lease_expires_at);
  });

  it("renew extends: a renew longer than the time left moves the expiry to now + leaseSeconds", () => {
    const { orgId, a } = setupOrg();
    const claimed = claimResource(orgId, a, "k", 60);
    if (!claimed.ok) throw new Error(claimed.error);
    const before = Date.now();
    const renewed = renewResourceLock(orgId, a, "k", 3600);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.leaseChanged).toBe(true);
    expect(ms(renewed.lock.lease_expires_at)).toBeGreaterThanOrEqual(before + 3600_000);
    expect(ms(renewed.lock.lease_expires_at)).toBeGreaterThan(ms(claimed.lock.lease_expires_at));
    expect(renewed.leaseExpiresAt).toBe(renewed.lock.lease_expires_at);
  });

  it("a fresh claim reports alreadyHeld: false", () => {
    const { orgId, a } = setupOrg();
    const claimed = claimResource(orgId, a, "k", 60);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.alreadyHeld).toBe(false);
    expect(claimed.leaseChanged).toBe(true);
  });

  it("a holder's re-claim reports alreadyHeld with an unchanged lease when the new one would be shorter", () => {
    const { orgId, a } = setupOrg();
    const first = claimResource(orgId, a, "k", 3600);
    if (!first.ok) throw new Error(first.error);
    const again = claimResource(orgId, a, "k", 60);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyHeld).toBe(true);
    expect(again.leaseChanged).toBe(false);
    expect(again.lock.lease_expires_at).toBe(first.lock.lease_expires_at);
    expect(again.leaseExpiresAt).toBe(first.lock.lease_expires_at);
    expect(again.lock.acquired_at).toBe(first.lock.acquired_at);
  });

  it("a holder's re-claim reports alreadyHeld with a changed lease when the new one is longer", () => {
    const { orgId, a } = setupOrg();
    const first = claimResource(orgId, a, "k", 60);
    if (!first.ok) throw new Error(first.error);
    const again = claimResource(orgId, a, "k", 3600);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyHeld).toBe(true);
    expect(again.leaseChanged).toBe(true);
    expect(ms(again.lock.lease_expires_at)).toBeGreaterThan(ms(first.lock.lease_expires_at));
  });

  it("a non-holder's claim on a held lock still refuses, naming the holder, and leaves the lease alone", () => {
    const { orgId, a, b } = setupOrg();
    const first = claimResource(orgId, a, "k", 60);
    if (!first.ok) throw new Error(first.error);
    const blocked = claimResource(orgId, b, "k", 3600);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error).toContain("Agent A");
    expect("alreadyHeld" in blocked).toBe(false);
    const [lock] = listResourceLocks(orgId);
    expect(lock.holder_agent_name).toBe("Agent A");
    expect(lock.lease_expires_at).toBe(first.lock.lease_expires_at);
  });

  it("a holder's re-claim of its own LAPSED lock is a fresh lease, not alreadyHeld", async () => {
    const { orgId, a } = setupOrg();
    claimResource(orgId, a, "k", 0.2);
    await sleep(300);
    const again = claimResource(orgId, a, "k", 60);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyHeld).toBe(false);
    expect(again.leaseChanged).toBe(true);
  });
});
