import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { createOrganization } from "../src/service.js";
import { classifyScope, prescreenDiff } from "../src/prescreen.js";
import type { DiffStats } from "../src/riskScorer.js";

const SMALL: DiffStats = { insertions: 3, deletions: 1 };
const LARGE: DiffStats = { insertions: 4000, deletions: 900 };

describe("classifyScope", () => {
  it("recognizes test-only paths", () => {
    expect(classifyScope(["tests/prescreen.test.ts"])).toBe("test");
    expect(classifyScope(["src/foo.test.ts", "tests/bar.test.ts"])).toBe("test");
  });

  it("recognizes docs-only paths (docs/ or root *.md)", () => {
    expect(classifyScope(["docs/design/AMBIENT_INTELLIGENCE_V2.md"])).toBe("docs");
    expect(classifyScope(["README.md"])).toBe("docs");
    expect(classifyScope(["docs/ops/BRANCH_PROTECTION.md", "CHANGELOG.md"])).toBe("docs");
  });

  it("rejects CODEOWNERS / CI as docs", () => {
    expect(classifyScope([".github/CODEOWNERS"])).toBe("out_of_scope");
    expect(classifyScope([".github/workflows/ci.yml"])).toBe("out_of_scope");
    expect(classifyScope(["CODEOWNERS"])).toBe("out_of_scope");
  });

  it("marks mixed non-test/non-doc as out of scope", () => {
    expect(classifyScope(["tests/a.test.ts", "src/service.ts"])).toBe("out_of_scope");
    expect(classifyScope(["README.md", "src/policy.ts"])).toBe("out_of_scope");
  });
});

describe("prescreenDiff -- test-only approve", () => {
  it("approves a test-only low-risk diff at high confidence and emits review.prescreened", () => {
    const { orgId } = createOrganization("Prescreen Test Only");
    const result = prescreenDiff({
      orgId,
      changedFiles: ["tests/prescreen.test.ts"],
      diffStats: SMALL,
    });

    expect(result.scope).toBe("test");
    expect(result.risk).toBe("low");
    expect(result.decision).toBe("approve_high_confidence");
    expect(result.label).toBe("approve (high confidence)");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.merged).toBe(false);

    const events = listEvents(orgId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("review.prescreened");
    expect(events[0].subject_type).toBe("review");
    const payload = JSON.parse(events[0].payload);
    expect(payload.decision).toBe("approve_high_confidence");
    expect(payload.merged).toBe(false);
  });

  it("approves multiple test files the same way", () => {
    const { orgId } = createOrganization("Prescreen Multi Test");
    const result = prescreenDiff({
      orgId,
      changedFiles: ["tests/policy.test.ts", "tests/events.test.ts"],
      diffStats: SMALL,
    });
    expect(result.decision).toBe("approve_high_confidence");
    expect(result.merged).toBe(false);
  });
});

describe("prescreenDiff -- docs-only", () => {
  it("approves a docs-only low-risk diff at low confidence", () => {
    const { orgId } = createOrganization("Prescreen Docs Only");
    const result = prescreenDiff({
      orgId,
      changedFiles: ["docs/design/AMBIENT_INTELLIGENCE_V2.md"],
      diffStats: SMALL,
    });
    expect(result.scope).toBe("docs");
    expect(result.risk).toBe("low");
    expect(result.decision).toBe("approve_low_confidence");
    expect(result.label).toBe("approve (low confidence)");
    expect(result.merged).toBe(false);
    expect(listEvents(orgId)[0].type).toBe("review.prescreened");
  });

  it("approves root README.md as docs-only", () => {
    const { orgId } = createOrganization("Prescreen Readme");
    const result = prescreenDiff({
      orgId,
      changedFiles: ["README.md"],
      diffStats: SMALL,
    });
    expect(result.scope).toBe("docs");
    expect(result.decision).toBe("approve_low_confidence");
  });
});

describe("prescreenDiff -- mixed / high-risk flag or reject", () => {
  it("flags a mixed test+source diff for human (out of Phase 1 scope)", () => {
    const { orgId } = createOrganization("Prescreen Mixed");
    const result = prescreenDiff({
      orgId,
      changedFiles: ["tests/policy.test.ts", "src/policy.ts"],
      diffStats: SMALL,
    });
    expect(result.scope).toBe("out_of_scope");
    expect(result.decision).toBe("flag_for_human");
    expect(result.label).toBe("flag for human");
    expect(result.merged).toBe(false);
    expect(result.reasons.some((r) => /Phase 1|out of/i.test(r))).toBe(true);
  });

  it("rejects a high-risk path floor hit (never approve)", () => {
    const { orgId } = createOrganization("Prescreen Reject Auth");
    const result = prescreenDiff({
      orgId,
      changedFiles: ["src/auth.ts"],
      diffStats: SMALL,
    });
    expect(result.risk).toBe("high");
    expect(result.confidence).toBe(1);
    expect(result.decision).toBe("reject");
    expect(result.label).toBe("reject");
    expect(result.merged).toBe(false);
    expect(listEvents(orgId)[0].type).toBe("review.prescreened");
  });

  it("rejects other Tier-3 path-floor hits and never approves them", () => {
    const { orgId } = createOrganization("Prescreen Never Approve High");
    for (const files of [
      ["src/approvals.ts"],
      [".github/CODEOWNERS"],
      ["Dockerfile"],
    ] as string[][]) {
      const result = prescreenDiff({ orgId, changedFiles: files, diffStats: SMALL });
      expect(result.merged).toBe(false);
      expect(result.decision).toBe("reject");
      expect(result.risk).toBe("high");
    }
  });
});

describe("prescreenDiff -- no merge side effects", () => {
  it("never sets merged true and does not write approvals or alter agent status", () => {
    const { orgId } = createOrganization("Prescreen No Merge");
    const agentsBefore = db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE org_id = ?`).get(orgId) as { n: number };
    const approvalsBefore = db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE org_id = ?`).get(orgId) as { n: number };

    const result = prescreenDiff({
      orgId,
      changedFiles: ["tests/no-merge.test.ts"],
      diffStats: SMALL,
    });

    expect(result.merged).toBe(false);
    const payload = JSON.parse(result.event.payload);
    expect(payload.merged).toBe(false);

    const agentsAfter = db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE org_id = ?`).get(orgId) as { n: number };
    const approvalsAfter = db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE org_id = ?`).get(orgId) as { n: number };
    expect(agentsAfter.n).toBe(agentsBefore.n);
    expect(approvalsAfter.n).toBe(approvalsBefore.n);

    // Only the timeline event was written for this org from this call.
    expect(listEvents(orgId).every((e) => e.type === "review.prescreened")).toBe(true);
  });

  it("does not mutate caller inputs", () => {
    const { orgId } = createOrganization("Prescreen Pure");
    const files = ["tests/pure.test.ts", "README.md"];
    const stats: DiffStats = { insertions: 2, deletions: 1 };
    const filesCopy = [...files];
    const statsCopy = { ...stats };
    prescreenDiff({ orgId, changedFiles: files, diffStats: stats });
    expect(files).toEqual(filesCopy);
    expect(stats).toEqual(statsCopy);
  });

  it("a large structural high-risk non-test diff is never approved", () => {
    const { orgId } = createOrganization("Prescreen Large");
    const files = Array.from({ length: 20 }, (_, i) => `src/module-${i}.ts`);
    const result = prescreenDiff({ orgId, changedFiles: files, diffStats: LARGE });
    expect(result.scope).toBe("out_of_scope");
    expect(result.decision).toBe("flag_for_human");
    expect(result.merged).toBe(false);
  });
});
