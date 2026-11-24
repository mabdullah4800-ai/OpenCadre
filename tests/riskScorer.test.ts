import { describe, expect, it } from "vitest";
import { scoreDiff, type DiffStats } from "../src/riskScorer.js";

const SMALL: DiffStats = { insertions: 3, deletions: 1 };
const LARGE: DiffStats = { insertions: 4000, deletions: 900 };

describe("scoreDiff -- deterministic path rules (always high, unconditional)", () => {
  it.each([
    "src/auth.ts",
    "src/approvals.ts",
    "src/mcp.ts",
    ".github/workflows/ci.yml",
    ".github/CODEOWNERS",
    "Dockerfile",
    "docker/Dockerfile",
    "migrations/0001_init.sql",
    "src/db/migrations/0007_add_column.ts",
    "20260913120000_add_index.js",
    "src/schema.sql",
  ])("%s alone forces high risk on a tiny diff", (path) => {
    const verdict = scoreDiff([path], SMALL);
    expect(verdict.risk).toBe("high");
    expect(verdict.reasons.length).toBeGreaterThan(0);
    expect(verdict.confidence).toBe(1);
  });

  it("a benign file alongside a high-risk one is still high", () => {
    const verdict = scoreDiff(["README.md", "src/auth.ts"], SMALL);
    expect(verdict.risk).toBe("high");
  });

  it("collects a distinct reason per matching high-risk file, no duplicates", () => {
    const verdict = scoreDiff(["src/auth.ts", "src/approvals.ts", "src/auth.ts"], SMALL);
    expect(verdict.risk).toBe("high");
    expect(new Set(verdict.reasons).size).toBe(verdict.reasons.length);
    expect(verdict.reasons.some((r) => r.includes("auth.ts"))).toBe(true);
    expect(verdict.reasons.some((r) => r.includes("approvals.ts"))).toBe(true);
  });

  it("a path that merely contains 'auth' as a substring is not a match (table is exact/prefix, not fuzzy)", () => {
    const verdict = scoreDiff(["src/authorization-helpers.ts"], SMALL);
    expect(verdict.risk).not.toBe("high");
  });
});

describe("scoreDiff -- test-only diffs", () => {
  it("a single test file with no sibling source change is low", () => {
    const verdict = scoreDiff(["tests/riskScorer.test.ts"], SMALL);
    expect(verdict.risk).toBe("low");
  });

  it("multiple test files with no source changes are low", () => {
    const verdict = scoreDiff(["tests/policy.test.ts", "tests/events.test.ts"], SMALL);
    expect(verdict.risk).toBe("low");
  });

  it("a test file plus its own implied source file does not take the test-only exemption path", () => {
    // The test-only rule only fires when EVERY changed file is a test path.
    // Here src/policy.ts is not, so rule 2 never applies -- the verdict
    // falls through to the structural rule instead (and, for a small diff
    // like this one, that legitimately still comes out "low"; the point of
    // this test is that it gets there via rule 3, not via the test-only
    // exemption, so a larger source change in the same diff would raise it).
    const verdict = scoreDiff(["tests/policy.test.ts", "src/policy.ts"], SMALL);
    expect(verdict.reasons.some((r) => r.includes("test-only"))).toBe(false);
  });

  it("a test file plus a LARGE change to its own source file is raised by the structural rule, unlike a pure test-only diff", () => {
    const testOnly = scoreDiff(
      Array.from({ length: 20 }, (_, i) => `tests/generated-${i}.test.ts`),
      LARGE
    );
    const withSource = scoreDiff(["tests/policy.test.ts", "src/policy.ts"], LARGE);
    expect(testOnly.risk).toBe("low");
    expect(withSource.risk).toBe("high");
  });

  it("a huge test-only diff is still low -- size never overrides the test-only rule", () => {
    const verdict = scoreDiff(
      Array.from({ length: 30 }, (_, i) => `tests/generated-${i}.test.ts`),
      LARGE
    );
    expect(verdict.risk).toBe("low");
  });
});

describe("scoreDiff -- structural signals nudge risk up, never down", () => {
  it("a small diff with ordinary files is low", () => {
    const verdict = scoreDiff(["src/timeline.ts"], SMALL);
    expect(verdict.risk).toBe("low");
  });

  it("many changed files (no path-rule hits) raises risk to at least medium", () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/module-${i}.ts`);
    const verdict = scoreDiff(files, SMALL);
    expect(verdict.risk).toBe("medium");
  });

  it("a very large line count raises risk to high even with few files", () => {
    const verdict = scoreDiff(["src/service.ts"], { insertions: 3000, deletions: 200 });
    expect(verdict.risk).toBe("high");
  });

  it("many files AND many lines is high, not double-counted past high", () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/module-${i}.ts`);
    const verdict = scoreDiff(files, LARGE);
    expect(verdict.risk).toBe("high");
  });

  it("a moderate-but-not-large diff lands at medium, not high", () => {
    const files = Array.from({ length: 7 }, (_, i) => `src/module-${i}.ts`);
    const verdict = scoreDiff(files, { insertions: 50, deletions: 10 });
    expect(verdict.risk).toBe("medium");
  });
});

describe("scoreDiff -- the load-bearing invariant: nothing can score BELOW the path-rule floor", () => {
  it("a huge, structurally low-risk-shaped diff touching src/auth.ts is still high, not downgraded by any other rule", () => {
    // If a future contributor adds a "large refactor => lower confidence,
    // treat as uncertain" heuristic, or an LLM layer, or any other signal,
    // this is the test that must keep failing until that signal is wired to
    // only ever raise risk, never lower it below the path floor.
    const files = [
      "src/auth.ts",
      ...Array.from({ length: 40 }, (_, i) => `tests/generated-${i}.test.ts`),
    ];
    const verdict = scoreDiff(files, LARGE);
    expect(verdict.risk).toBe("high");
  });

  it("a single-line, single-file change to a high-risk path is still high", () => {
    const verdict = scoreDiff(["src/approvals.ts"], { insertions: 1, deletions: 0 });
    expect(verdict.risk).toBe("high");
  });

  it("an empty diff (no files) never claims high or medium", () => {
    const verdict = scoreDiff([], { insertions: 0, deletions: 0 });
    expect(verdict.risk).toBe("low");
  });
});

describe("scoreDiff -- purity", () => {
  it("does not mutate its inputs", () => {
    const files = ["src/auth.ts", "src/timeline.ts"];
    const stats: DiffStats = { insertions: 10, deletions: 2 };
    const filesCopy = [...files];
    const statsCopy = { ...stats };
    scoreDiff(files, stats);
    expect(files).toEqual(filesCopy);
    expect(stats).toEqual(statsCopy);
  });

  it("is deterministic -- same input, same output, called repeatedly", () => {
    const files = ["src/mcp.ts", "src/timeline.ts"];
    const stats: DiffStats = { insertions: 20, deletions: 5 };
    const first = scoreDiff(files, stats);
    const second = scoreDiff(files, stats);
    expect(second).toEqual(first);
  });
});
