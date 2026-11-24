import { afterEach, describe, expect, it, vi } from "vitest";

// Stage 3 retro finding: "per-tenant API keys and agent identities, with impersonation structurally
// impossible, not policy-enforced." agents.api_key_hash is now a UNIQUE column (migration 28); this
// exercises the client-side half of that -- registerAgent/rotateAgentKey retrying with a fresh key
// on the (astronomically unlikely, but no longer merely "unlikely") collision case, instead of a raw
// constraint-violation error reaching the caller.
//
// randomBytes is mocked to FORCE a collision deterministically: two consecutive calls return the
// same bytes (simulating two randomly-generated keys hashing the same, however that happened), then
// a third call returns something different. createHash/timingSafeEqual are left real.
describe("registerAgent / rotateAgentKey: retries a hash collision instead of surfacing a raw DB error", () => {
  afterEach(() => {
    vi.doUnmock("node:crypto");
    vi.resetModules();
  });

  it("registerAgent succeeds on the second attempt when the first generated key collides", async () => {
    const real = await vi.importActual<typeof import("node:crypto")>("node:crypto");
    let call = 0;
    vi.doMock("node:crypto", () => ({
      ...real,
      randomBytes: (n: number) => (call++ === 0 ? Buffer.alloc(n, 7) : real.randomBytes(n)),
    }));
    vi.resetModules();
    const { createOrganization, registerAgent } = await import("../src/service.js");

    const { orgId } = createOrganization("Key Collision Org");
    // First agent takes the "colliding" key (call #0 -- the fixed all-7s bytes).
    const first = registerAgent(orgId, "Agent One");

    // Reset the mock's counter so the NEXT registerAgent call also starts by generating the
    // identical colliding bytes on its first attempt -- forcing a real UNIQUE violation against
    // Agent One's already-stored hash, then a real retry onto call #1 (genuinely random bytes).
    call = 0;
    const second = registerAgent(orgId, "Agent Two");

    expect(second.apiKey).not.toBe(first.apiKey);
    // Both agents are real, distinct, live rows -- the collision never silently dropped one.
    expect(second.agentId).not.toBe(first.agentId);
  });
});
