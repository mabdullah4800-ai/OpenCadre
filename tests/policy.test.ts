import { describe, expect, it } from "vitest";
import { evaluate, sameProjectOrUnknown, type Viewer } from "../src/policy.js";
import type { EventRecord } from "../src/events.js";

const ME = "agent-me";
const OTHER = "agent-other";
const viewer: Viewer = { agentId: ME, files: ["src/auth.ts", "./src/api/routes.ts"] };

function ev(type: EventRecord["type"], overrides: Partial<EventRecord> & { payloadObj?: Record<string, unknown> } = {}): EventRecord {
  const { payloadObj, ...rest } = overrides;
  return {
    seq: 1, id: "e", org_id: "o", type, actor_agent_id: OTHER, actor_agent_name: "Other",
    subject_type: "task", subject_id: "s", target_agent_id: null, payload: JSON.stringify(payloadObj ?? {}),
    created_at: "2026-09-13 00:00:00", ...rest,
  };
}

describe("policy.evaluate", () => {
  it("ignores the viewer's own actions", () => {
    expect(evaluate(ev("conflict.detected", { actor_agent_id: ME, target_agent_id: ME }), viewer)).toBeNull();
  });

  it.each([
    ["conflict.detected", 1],
    ["approval.requested", 1],
    ["approval.decided", 1],
    ["approval.expired", 1],
    ["question.asked", 1],
    ["question.answered", 1],
    ["message.sent", 2],
    ["task.lease_expired", 2],
    ["approval.grant_created", 2],
    ["approval.grant_revoked", 2],
    ["approval.withdrawn", 2],
    ["task.lane_changed", 2],
    ["approval.noted", 3],
  ] as const)("%s directed at the viewer is P%i", (type, priority) => {
    const result = evaluate(ev(type, { target_agent_id: ME, payloadObj: { priority: "medium" } }), viewer);
    expect(result?.priority).toBe(priority);
    expect(result?.reason).toBeTruthy();
  });

  it("the same directed events aimed at someone else are background (P3) or irrelevant", () => {
    expect(evaluate(ev("question.asked", { target_agent_id: OTHER }), viewer)?.priority).toBe(3);
    expect(evaluate(ev("message.sent", { target_agent_id: OTHER }), viewer)).toBeNull();
    expect(evaluate(ev("conflict.detected", { target_agent_id: OTHER }), viewer)?.priority).toBe(3);
  });

  it("a sender's high priority raises a message to P1 but never higher", () => {
    expect(evaluate(ev("message.sent", { target_agent_id: ME, payloadObj: { priority: "high" } }), viewer)?.priority).toBe(1);
    expect(evaluate(ev("message.sent", { target_agent_id: ME, payloadObj: { priority: "low" } }), viewer)?.priority).toBe(2);
  });

  it("decisions touching the viewer's files are P2, others P3", () => {
    expect(evaluate(ev("decision.recorded", { payloadObj: { title: "x", scope: "src/auth.ts" } }), viewer)?.priority).toBe(2);
    expect(evaluate(ev("decision.recorded", { payloadObj: { title: "x", scope: "src/api" } }), viewer)?.priority).toBe(2);
    expect(evaluate(ev("decision.recorded", { payloadObj: { title: "x", scope: "./src/" } }), viewer)?.priority).toBe(2);
    expect(evaluate(ev("decision.recorded", { payloadObj: { title: "x", scope: "docs" } }), viewer)?.priority).toBe(3);
    expect(evaluate(ev("decision.recorded", { payloadObj: { title: "x" } }), viewer)?.priority).toBe(3);
    expect(evaluate(ev("decision.recorded", { payloadObj: { title: "x", scope: "src/authentication.ts" } }), viewer)?.priority).toBe(3);
  });

  it("scope matching stays forward-slash on every platform -- these are repo-relative declarations, not OS paths", () => {
    // Looks like the containment bug PR #237 fixed in scripts/deepseek-shell-guard.mjs (`real.startsWith(`${base}/`)`),
    // but it is the same SHAPE under a different contract, and copying #237's fix here would BREAK it.
    //
    // isAllowedCwd compares realpathSync output, which on win32 is backslash-separated, so a hardcoded "/" made its
    // subdirectory branch dead there. overlaps() (src/policy.ts) compares agent-DECLARED strings -- "src/auth.ts",
    // "./src/api/routes.ts" -- supplied via set_status and the decision payload's `scope`. Nothing on this path runs a
    // value through path.join or realpath, so the separator is always "/" and always should be. Routing these through
    // path.sep would insert "\" on Windows and match nothing (measured, path.sep = "\\"):
    //
    //   scope="src"       file="src/auth.ts"        current=true   path.sep=false
    //   scope="src/api"   file="src/api/routes.ts"  current=true   path.sep=false
    //
    // Pinned so a later "the same bug is in policy.ts" pass cannot reintroduce it.
    expect(evaluate(ev("decision.recorded", { payloadObj: { title: "x", scope: "src" } }), viewer)?.priority).toBe(2);
    expect(evaluate(ev("decision.recorded", { payloadObj: { title: "x", scope: "src/api" } }), viewer)?.priority).toBe(2);
    // A backslash spelling is not a directory boundary here -- it is a different (invalid) declaration and must not
    // match. This is the assertion that fails loudly if someone makes the separator platform-aware.
    expect(evaluate(ev("decision.recorded", { payloadObj: { title: "x", scope: "src\\api" } }), viewer)?.priority).toBe(3);
  });

  it("a decision from another project is P3 even when its scope matches the viewer's files; an unknown project on either side keeps P2", () => {
    const decision = ev("decision.recorded", { payloadObj: { title: "x", scope: "src/auth.ts" } });
    const inProjectA: Viewer = { ...viewer, project: "github.com/acme/a" };
    expect(evaluate(decision, inProjectA, "github.com/acme/b")?.priority).toBe(3);
    expect(evaluate(decision, inProjectA, "github.com/acme/a")?.priority).toBe(2);
    expect(evaluate(decision, inProjectA, null)?.priority).toBe(2);
    expect(evaluate(decision, viewer, "github.com/acme/b")?.priority).toBe(2);
  });

  it("goal.set is always P2 for everyone, unlike decision.recorded's file-overlap rule", () => {
    // No file overlap, no shared project, and not directed at the viewer -- would be P3 (or null)
    // for decision.recorded, but a fleet goal is meant for every agent regardless.
    const noOverlap = ev("goal.set", { payloadObj: { text: "Ship it" }, target_agent_id: null });
    expect(evaluate(noOverlap, viewer)?.priority).toBe(2);
    const differentProject = ev("goal.set", { payloadObj: { text: "Ship it" }, target_agent_id: null });
    expect(evaluate(differentProject, { ...viewer, project: "github.com/acme/a" }, "github.com/acme/b")?.priority).toBe(2);
  });

  it("sameProjectOrUnknown is false only for two different known projects", () => {
    expect(sameProjectOrUnknown("a", "b")).toBe(false);
    expect(sameProjectOrUnknown("a", "a")).toBe(true);
    expect(sameProjectOrUnknown(null, "b")).toBe(true);
    expect(sameProjectOrUnknown("a", undefined)).toBe(true);
  });

  it("teammates' routine activity is P3", () => {
    for (const type of ["agent.phase_changed", "agent.task_changed", "task.created", "task.claimed", "task.released", "task.completed"] as const) {
      expect(evaluate(ev(type), viewer)?.priority).toBe(3);
    }
  });

  it("a teammate going stale, suspended or resumed is P3 fleet-status background, not dropped entirely", () => {
    // Regression: these three types used to fall through evaluate() to null (invisible in both
    // items and background counts) because BACKGROUND omitted them -- a teammate you're waiting
    // on for a question or approval could go quiet with no trace in the digest at all.
    for (const type of ["agent.stale", "agent.suspended", "agent.resumed"] as const) {
      expect(evaluate(ev(type), viewer)?.priority).toBe(3);
    }
  });

  it("never assigns P0", () => {
    const all = ["agent.phase_changed", "message.sent", "question.asked", "conflict.detected", "approval.requested", "decision.recorded"] as const;
    for (const type of all) {
      const result = evaluate(ev(type, { target_agent_id: ME, payloadObj: { priority: "high", scope: "src" } }), viewer);
      expect(result === null || result.priority >= 1).toBe(true);
    }
  });
});
