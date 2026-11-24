import { describe, expect, it } from "vitest";
import { emitEvent, listEvents, resolveAllEventWaiters, waitForEvents } from "../src/events.js";
import { createOrganization, registerAgent } from "../src/service.js";

// Review (opencadre-55): a wait filtered to agent.* used to return empty on any unrelated org event, so a
// watcher (possibly an LLM turn) was woken by routine traffic.
function org() {
  const { orgId } = createOrganization("Typed Wait Org");
  const agent = registerAgent(orgId, "Typed-Watcher");
  const after = listEvents(orgId, { latest: true, limit: 1 }).at(-1)?.seq ?? 0;
  return { orgId, agentId: agent.agentId, after };
}
const emit = (orgId: string, agentId: string, type: "decision.recorded" | "agent.stale") =>
  emitEvent({ orgId, type, subjectType: "agent", subjectId: agentId, payload: {} });

describe("typed timeline wait", () => {
  it("is not ended by events outside its filter, and returns on the first matching one", async () => {
    const { orgId, agentId, after } = org();
    const started = Date.now();
    const waiting = waitForEvents(orgId, after, 5, ["agent.stale"]);
    setTimeout(() => emit(orgId, agentId, "decision.recorded"), 50);
    setTimeout(() => emit(orgId, agentId, "decision.recorded"), 100);
    setTimeout(() => emit(orgId, agentId, "agent.stale"), 250);
    const events = await waiting;
    expect(events.map((e) => e.type)).toEqual(["agent.stale"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it("returns empty at the timeout when only unrelated events happen", async () => {
    const { orgId, agentId, after } = org();
    const waiting = waitForEvents(orgId, after, 0.4, ["agent.stale"]);
    setTimeout(() => emit(orgId, agentId, "decision.recorded"), 50);
    expect(await waiting).toEqual([]);
  });

  it("still returns at once on graceful shutdown", async () => {
    const { orgId, after } = org();
    const started = Date.now();
    const waiting = waitForEvents(orgId, after, 30, ["agent.stale"]);
    setTimeout(() => resolveAllEventWaiters(), 50);
    expect(await waiting).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
