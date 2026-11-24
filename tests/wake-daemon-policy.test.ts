import { describe, expect, it } from "vitest";
import { buildDigest, filterEligible, wakeEligible } from "../scripts/wake-daemon/policy.mjs";

const msg = (over: Record<string, unknown> = {}) => ({
  id: "m1", body: "prod is down", priority: "high", from_agent_id: "peer", from_agent_name: "Waker", ...over,
});

describe("wake-daemon policy", () => {
  it("wakes for high priority", () => {
    expect(wakeEligible(msg({ priority: "high" }))).toBe(true);
  });

  it("never wakes for low priority", () => {
    expect(wakeEligible(msg({ priority: "low" }))).toBe(false);
  });

  it("wakes for medium only when OPENCADRE_WAKE_MEDIUM is set", () => {
    const m = msg({ priority: "medium" });
    expect(wakeEligible(m, {}, { wakeMedium: false })).toBe(false);
    expect(wakeEligible(m, {}, { wakeMedium: true })).toBe(true);
  });

  it("never wakes for a pure acknowledgement", () => {
    expect(wakeEligible(msg({ body: "thanks", priority: "high" }))).toBe(false);
  });

  it("still wakes for an ack-shaped body when the message is awaiting a reply", () => {
    expect(wakeEligible(msg({ body: "thanks", priority: "high", awaiting_reply: true }))).toBe(true);
  });

  it("never wakes for the session's own sends", () => {
    expect(wakeEligible(msg({ from_agent_id: "self" }), { agentId: "self" })).toBe(false);
  });

  it("filterEligible keeps only the eligible messages, in order", () => {
    const messages = [msg({ id: "a", priority: "high" }), msg({ id: "b", priority: "low" }), msg({ id: "c", priority: "high" })];
    expect(filterEligible(messages).map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("buildDigest is a single line and never echoes more than one message body verbatim across many", () => {
    const messages = [msg({ id: "a" }), msg({ id: "b", priority: "medium" })];
    const digest = buildDigest(messages);
    expect(digest.ids).toEqual(["a", "b"]);
    expect(digest.top).toBe("high");
    expect(digest.line.split("\n")).toHaveLength(1);
  });
});
