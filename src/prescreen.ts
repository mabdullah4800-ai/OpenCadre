/** AI pre-screen for test/doc-only diffs (Ambient Intelligence v2 Phase 1).
 *
 * Narrow domain only: every changed path must be a test path or a docs path.
 * Anything else is out of Phase 1 scope and is flagged for a human — never
 * auto-approved. Decisions are recorded reviews via emitEvent; this module
 * never merges and must not be imported as a merge gate from rest.ts/mcp.ts
 * (see riskScorer.ts module comment — same rule).
 *
 * Deterministic first: scoreDiff provides the risk floor. High risk never
 * becomes approve. No LLM / network calls live here.
 */

import { emitEvent, type EventRecord } from "./events.js";
import { newId } from "./db.js";
import { scoreDiff, type DiffStats, type RiskLevel, type RiskVerdict } from "./riskScorer.js";

export type PrescreenDecision =
  | "approve_high_confidence"
  | "approve_low_confidence"
  | "flag_for_human"
  | "reject";

export type PrescreenScope = "test" | "docs" | "test_and_docs" | "out_of_scope" | "empty";

export interface PrescreenInput {
  orgId: string;
  changedFiles: string[];
  diffStats: DiffStats;
  actor?: { id: string; name: string } | null;
  /** Optional PR / review subject id; generated if omitted. */
  subjectId?: string;
}

export interface PrescreenResult {
  decision: PrescreenDecision;
  /** Human-readable label matching the design doc outputs. */
  label:
    | "approve (high confidence)"
    | "approve (low confidence)"
    | "flag for human"
    | "reject";
  risk: RiskLevel;
  reasons: string[];
  confidence: number;
  scope: PrescreenScope;
  event: EventRecord;
  /** Always false — Phase 1 records a review; it never merges. */
  merged: false;
}

const DECISION_LABEL: Record<PrescreenDecision, PrescreenResult["label"]> = {
  approve_high_confidence: "approve (high confidence)",
  approve_low_confidence: "approve (low confidence)",
  flag_for_human: "flag for human",
  reject: "reject",
};

/** Same shape as riskScorer's test-path rule (kept local so this module stays
 * independent of riskScorer internals). */
function isTestPath(path: string): boolean {
  return /\.test\.[tj]sx?$/.test(path) || /(^|\/)tests?\//.test(path);
}

/** Docs-only Phase 1 paths: `*.md` under `docs/`, or a root-level `*.md`.
 * Explicitly excludes CODEOWNERS / CI / non-markdown ops wiring. */
function isDocPath(path: string): boolean {
  if (path === "CODEOWNERS" || path.endsWith("/CODEOWNERS")) return false;
  if (path.startsWith(".github/")) return false;
  if (path.startsWith("docs/") && /\.md$/i.test(path)) return true;
  if (/^[^/]+\.md$/i.test(path)) return true;
  return false;
}

export function classifyScope(changedFiles: string[]): PrescreenScope {
  if (changedFiles.length === 0) return "empty";
  let hasTest = false;
  let hasDoc = false;
  for (const path of changedFiles) {
    const test = isTestPath(path);
    const doc = isDocPath(path);
    if (!test && !doc) return "out_of_scope";
    if (test) hasTest = true;
    if (doc) hasDoc = true;
  }
  if (hasTest && hasDoc) return "test_and_docs";
  if (hasTest) return "test";
  return "docs";
}

function decideFromVerdict(
  scope: PrescreenScope,
  verdict: RiskVerdict,
): { decision: PrescreenDecision; reasons: string[] } {
  const reasons = [...verdict.reasons];

  // High-risk path floor (confidence 1): reject unconditionally — never approve.
  // Checked before scope so a Tier-3 path cannot slip through as a soft flag alone.
  if (verdict.risk === "high" && verdict.confidence >= 1) {
    reasons.unshift("high-risk path floor — reject, never approve");
    return { decision: "reject", reasons };
  }

  if (scope === "out_of_scope") {
    reasons.unshift("diff touches paths outside Phase 1 test/doc-only scope");
    return { decision: "flag_for_human", reasons };
  }

  if (scope === "empty") {
    reasons.unshift("empty diff — nothing to pre-screen");
    return { decision: "flag_for_human", reasons };
  }

  // Structural / uncertain high (confidence < 1): flag for human, never approve.
  if (verdict.risk === "high") {
    reasons.unshift("high risk — flag for human, never approve");
    return { decision: "flag_for_human", reasons };
  }

  if (verdict.risk === "medium") {
    reasons.unshift("medium risk — escalate to human");
    return { decision: "flag_for_human", reasons };
  }

  // Low risk within Phase 1 scope.
  if (scope === "test" && verdict.confidence >= 0.9) {
    return { decision: "approve_high_confidence", reasons };
  }

  // Docs-only (and mixed test+docs) low risk: approve at low confidence.
  // Confidence from scoreDiff for non-test-only low is typically 0.7.
  return { decision: "approve_low_confidence", reasons };
}

/**
 * Run a deterministic Phase 1 pre-screen and record `review.prescreened`.
 * Does not merge, does not call network/LLM, does not mutate callers' inputs.
 */
export function prescreenDiff(input: PrescreenInput): PrescreenResult {
  const changedFiles = [...input.changedFiles];
  const diffStats = { ...input.diffStats };
  const scope = classifyScope(changedFiles);
  const verdict = scoreDiff(changedFiles, diffStats);
  const { decision, reasons } = decideFromVerdict(scope, verdict);
  const subjectId = input.subjectId ?? newId();
  const confidence = verdict.confidence;

  const event = emitEvent({
    orgId: input.orgId,
    type: "review.prescreened",
    actor: input.actor ?? null,
    subjectType: "review",
    subjectId,
    payload: {
      decision,
      label: DECISION_LABEL[decision],
      risk: verdict.risk,
      confidence,
      scope,
      reasons,
      changedFiles,
      diffStats,
      merged: false,
    },
  });

  return {
    decision,
    label: DECISION_LABEL[decision],
    risk: verdict.risk,
    reasons,
    confidence,
    scope,
    event,
    merged: false,
  };
}
