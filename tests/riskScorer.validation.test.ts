/**
 * Retroactive validation of the deterministic risk scorer against the 7
 * incidents documented in docs/design/FLEET_SCALING_AUDIT.md's incident
 * appendix (2026-09-13). The design doc (AMBIENT_INTELLIGENCE_V2.md §3.2)
 * requires this scorer to be "validate[d] retroactively against the audit's
 * own 7 incidents before it gates anything for real" -- this is that
 * validation. It is intentionally kept separate from riskScorer.test.ts,
 * which tests the scoring rules in isolation; this file tests the scorer
 * against real incident shapes.
 *
 * The audit's incident appendix is qualitative (root cause + fix, not a
 * literal file list), so each incident below is reconstructed as a
 * synthetic changed-file list based on what the appendix says the incident
 * and its fix actually touched. Where the audit names a script file
 * directly (e.g. `agent-inbox.mjs`, `poll-bridge.mjs`), that name is used
 * verbatim; where it names a subsystem (e.g. "REST/MCP parity", "CI
 * required checks"), the corresponding real source path is inferred
 * (`src/mcp.ts`, `.github/workflows/ci.yml`).
 */
import { describe, expect, it } from "vitest";
import { scoreDiff } from "../src/riskScorer.js";

describe("scoreDiff -- retroactive validation against FLEET_SCALING_AUDIT.md's 7 incidents", () => {
  it("Incident 1 (mail loss, ×2) -- fix touched get_messages' peek behavior on mcp.ts's tool surface", () => {
    // PR #51 added `peek` + `afterId` cursor semantics to get_messages,
    // which is registered on src/mcp.ts's tool-registration surface --
    // the unconditional high-risk rule fires on that alone.
    const verdict = scoreDiff(
      ["scripts/poll-bridge.mjs", "scripts/opencadre-watch.mjs", "src/mcp.ts"],
      { insertions: 40, deletions: 12 }
    );
    expect(verdict.risk).toBe("high");
  });

  it("Incident 2 (duplicate-send) -- GAP: the real fix (PR #48) was client-only and this scorer would NOT have caught it", () => {
    // Documented gap, not hidden: the fix lived entirely in
    // scripts/agent-inbox.mjs (a client watcher script outside src/), so no
    // path rule fires, and the diff is small, so no structural signal fires
    // either. The deterministic path table in this Phase 0 scorer covers
    // OpenCadre's own server surface (auth/approvals/mcp/CI/migrations); it
    // has no rule for "agent client tooling that can double-send," because
    // that class of defect isn't expressible as a path predicate. This is
    // exactly the kind of gap the design doc's future LLM layer (§3.2) is
    // meant to close -- it may only raise this "low" to something higher,
    // never the reverse.
    const verdict = scoreDiff(["scripts/agent-inbox.mjs"], { insertions: 25, deletions: 4 });
    expect(verdict.risk).toBe("low");
  });

  it("Incident 3 (merge-without-approval, PR #53) -- touches approvals.ts and mcp.ts, must never be low", () => {
    const verdict = scoreDiff(
      ["src/approvals.ts", "src/rest.ts", "src/mcp.ts"],
      { insertions: 180, deletions: 30 }
    );
    expect(verdict.risk).toBe("high");
    expect(verdict.risk).not.toBe("low");
  });

  it("Incident 4 (identity collision, wrong key attributed) -- touches auth.ts, must never be low", () => {
    const verdict = scoreDiff(["src/auth.ts"], { insertions: 15, deletions: 3 });
    expect(verdict.risk).toBe("high");
    expect(verdict.risk).not.toBe("low");
  });

  it("Incident 5 (false diff signal) -- fix is a CI merge-base change under .github/, must never be low", () => {
    const verdict = scoreDiff([".github/workflows/ci.yml"], { insertions: 8, deletions: 2 });
    expect(verdict.risk).toBe("high");
    expect(verdict.risk).not.toBe("low");
  });

  it("Incident 6 (watchdog POC) -- GAP: no server-side fix has shipped yet, so there is nothing real to score", () => {
    // Honest limitation: the audit explicitly says hub heartbeat
    // enforcement + auto-suspend (the actual fix for this incident) is NOT
    // built (§c, "Agent suspension: None"). Today's workaround was a
    // supervisor-run bash loop, not a repo change. A synthetic diff for
    // that workaround script (outside src/, small) scores low here for the
    // same structural reason as Incident 2 -- there is no path rule for
    // "ad hoc operational script," and there shouldn't be one invented just
    // to make this test pass, since the real fix (a hub-side heartbeat
    // sweeper under src/) doesn't exist to validate against yet.
    const verdict = scoreDiff(["scripts/supervisor-watchdog.sh"], { insertions: 20, deletions: 0 });
    expect(verdict.risk).toBe("low");
  });

  it("Incident 7 (review bottleneck, no required CI) -- fix is .github/workflows/ci.yml, must never be low", () => {
    const verdict = scoreDiff([".github/workflows/ci.yml", "package.json"], { insertions: 45, deletions: 1 });
    expect(verdict.risk).toBe("high");
    expect(verdict.risk).not.toBe("low");
  });

  it("summary invariant: every incident touching an approvals/auth/CI-adjacent path scores high, never low", () => {
    const authAdjacentIncidents = [
      ["src/approvals.ts", "src/rest.ts", "src/mcp.ts"],
      ["src/auth.ts"],
      [".github/workflows/ci.yml"],
    ];
    for (const files of authAdjacentIncidents) {
      const verdict = scoreDiff(files, { insertions: 50, deletions: 10 });
      expect(verdict.risk).not.toBe("low");
    }
  });
});
