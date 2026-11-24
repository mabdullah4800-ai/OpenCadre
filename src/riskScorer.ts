/** Automated diff risk-scoring (Ambient Intelligence v2, design doc §3.2).
 *
 * Phase 0 scope, deliberately: the deterministic path-and-structure layer
 * ONLY. No LLM call lives here. The design doc requires this floor to exist
 * and be validated on its own (see riskScorer.validation.test.ts) before any
 * LLM layer is added on top of it -- and per §3.2, that future layer may only
 * ever *raise* a score, never lower one. This module is the enforcement point
 * for that floor: nothing downstream of it is allowed to produce a risk below
 * what the path rules alone require.
 *
 * Pure: no I/O, no network, no LLM calls -- matches the style of policy.ts so
 * every rule here is unit-testable in isolation.
 *
 * Phase 0 is shadow mode only (design doc §5): this module is scored and
 * logged, never wired into merge-gating. Do not import this from rest.ts or
 * mcp.ts as an enforcement point.
 */

export type RiskLevel = "low" | "medium" | "high";

export interface RiskVerdict {
  risk: RiskLevel;
  reasons: string[];
  confidence: number;
}

export interface DiffStats {
  insertions: number;
  deletions: number;
}

/** Order matters only for readability; every rule below is independently
 * evaluated (a diff can match several). Each entry pairs a path predicate
 * with the reason to surface when it fires. Auditable in one read: any file
 * matching any rule here forces the whole diff to "high", full stop, no
 * matter what else is in the diff or how small it is. */
const HIGH_RISK_PATH_RULES: { test: (path: string) => boolean; reason: string }[] = [
  { test: (p) => p === "src/auth.ts", reason: "touches src/auth.ts (authentication)" },
  { test: (p) => p === "src/approvals.ts", reason: "touches src/approvals.ts (approval gate)" },
  { test: (p) => p === "src/mcp.ts", reason: "touches src/mcp.ts (MCP tool-registration surface)" },
  { test: (p) => p.startsWith(".github/"), reason: "touches .github/ (CI/branch-protection config)" },
  { test: (p) => p === "Dockerfile" || p.endsWith("/Dockerfile"), reason: "touches Dockerfile" },
  { test: (p) => p.endsWith(".sql"), reason: "touches a .sql file" },
  { test: isMigrationShaped, reason: "touches a database migration" },
];

/** A path "looks like" a migration if it lives under a migrations-style
 * directory, or its filename carries the conventional numeric/timestamp
 * migration prefix (e.g. `0007_add_column.ts`, `20260913120000_init.js`). */
function isMigrationShaped(path: string): boolean {
  if (/(^|\/)(migrations|migrate)\//i.test(path)) return true;
  const file = path.slice(path.lastIndexOf("/") + 1);
  return /^\d{3,}[_-]/.test(file) && /\.(ts|js|sql|mjs|cjs)$/.test(file);
}

/** Large-diff structural thresholds. These only ever push risk UP from what
 * the path rules alone already require -- see the invariant test in
 * riskScorer.test.ts. */
const LARGE_FILE_COUNT = 15;
const LARGE_LINE_COUNT = 500;
const MODERATE_FILE_COUNT = 6;
const MODERATE_LINE_COUNT = 150;

function isTestPath(path: string): boolean {
  return /\.test\.[tj]sx?$/.test(path) || /(^|\/)tests?\//.test(path);
}

/** The non-test source path a given test path is presumed to cover, e.g.
 * `tests/policy.test.ts` / `src/policy.test.ts` -> `src/policy.ts`. Best
 * effort: used only to decide whether a diff is test-only, never to assert
 * coverage correctness. */
function impliedSourcePath(testPath: string): string {
  const withoutTestSuffix = testPath.replace(/\.test\.[tj]sx?$/, "");
  return withoutTestSuffix.replace(/^tests\//, "src/");
}

function rankOf(risk: RiskLevel): number {
  return risk === "high" ? 2 : risk === "medium" ? 1 : 0;
}

function levelOf(rank: number): RiskLevel {
  return rank >= 2 ? "high" : rank === 1 ? "medium" : "low";
}

/**
 * Score a diff for merge risk. Deterministic, pure, Phase 0 only:
 *
 * 1. Path rules run first and are unconditional -- any matching file forces
 *    "high" regardless of every other signal.
 * 2. Failing that, a diff touching ONLY `*.test.ts`-shaped paths with no
 *    corresponding non-test file changed in the same diff is "low".
 * 3. Otherwise, structural size (file count, insertions + deletions) nudges
 *    risk up from a "medium" floor -- it can raise but never lower what the
 *    path rules already assigned.
 */
export function scoreDiff(changedFiles: string[], diffStats: DiffStats): RiskVerdict {
  const reasons: string[] = [];

  // 1. Path rules: unconditional, always "high" when matched.
  const pathHits = changedFiles.flatMap((path) =>
    HIGH_RISK_PATH_RULES.filter((rule) => rule.test(path)).map((rule) => rule.reason)
  );
  if (pathHits.length > 0) {
    return { risk: "high", reasons: [...new Set(pathHits)], confidence: 1 };
  }

  // 2. Test-only diff: every changed file is a test path, and none of the
  // non-test files it implies were also changed in this diff.
  if (changedFiles.length > 0 && changedFiles.every(isTestPath)) {
    const impliedSources = new Set(changedFiles.map(impliedSourcePath));
    const touchesImpliedSource = changedFiles.some((f) => impliedSources.has(f));
    if (!touchesImpliedSource) {
      return {
        risk: "low",
        reasons: ["test-only diff with no corresponding non-test file change"],
        confidence: 0.9,
      };
    }
  }

  // 3. Structural signals. Baseline floor for anything reaching this point
  // is "low"; large diffs nudge that up, never down.
  let rank = rankOf("low");
  const totalLines = diffStats.insertions + diffStats.deletions;

  if (changedFiles.length >= LARGE_FILE_COUNT || totalLines >= LARGE_LINE_COUNT) {
    rank = Math.max(rank, rankOf("high"));
    reasons.push(
      `large diff (${changedFiles.length} files, ${totalLines} changed lines) exceeds the high-risk size threshold`
    );
  } else if (changedFiles.length >= MODERATE_FILE_COUNT || totalLines >= MODERATE_LINE_COUNT) {
    rank = Math.max(rank, rankOf("medium"));
    reasons.push(
      `moderate-sized diff (${changedFiles.length} files, ${totalLines} changed lines)`
    );
  }

  if (reasons.length === 0) {
    reasons.push("no high-risk path matched and diff is small");
  }

  return {
    risk: levelOf(rank),
    reasons,
    confidence: rank === rankOf("low") ? 0.7 : 0.6,
  };
}
