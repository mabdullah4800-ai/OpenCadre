// The bound that keeps hook-injected context under Codex's per-message cap, ASSERTED SO IT CANNOT
// DRIFT SILENTLY.
//
// The vendor caps each model-visible hook-output message at roughly 2,500 tokens. Over the cap,
// Codex does not truncate in place: it writes the full text to <temp_dir>/hook_outputs/<session>/
// <uuid>.txt and gives the model a head-and-tail preview with the saved-file path ("spilling"). For
// a mail digest that is a silent delivery failure behind a green exit code -- the hook succeeds, the
// delivery does not, and nothing in the output distinguishes them. The vendor also warns that
// spilled output lands on disk and says not to return sensitive data in hook output, which matters
// because the awareness hook is the one carrying hub message content.
//
// WHY THIS TEST AND NOT `additionalContextLimit`. Read on 2026-09-20: the repo sets no
// `additionalContextLimit` anywhere, so the hook inherits the 2,500-token default. But the payload
// CANNOT REACH IT -- three independent bounds keep it ~4.5x under. Setting the key would mean
// choosing a number to defend against a case that does not occur, which reads as a fix in review and
// is not one. The honest artifact is the bound itself: pin the numbers, so an edit that breaks the
// headroom fails HERE instead of spilling in production.
//
// WHAT THIS DOES NOT COVER, stated rather than implied: the vendor's "context from multiple hooks and
// plugins adds up and can degrade model performance" is a SUM across handlers, and one hook's test
// cannot measure it. That residue is named, not solved.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DIGEST_MAX_CHARS } from "../src/awareness.js";

/** The vendor's per-message cap: ~2,500 tokens. A rough 4 chars/token, so ~10,000 chars. */
const VENDOR_CAP_TOKENS = 2500;
const CHARS_PER_TOKEN = 4;
const VENDOR_CAP_CHARS = VENDOR_CAP_TOKENS * CHARS_PER_TOKEN;

const awarenessSrc = readFileSync(path.join(process.cwd(), "examples/hooks/opencadre-awareness.mjs"), "utf8");
const numConst = (name: string) => {
  const m = awarenessSrc.match(new RegExp(`const ${name} = (\\d+)`));
  if (!m) throw new Error(`could not read ${name} from opencadre-awareness.mjs -- the bound moved and this test cannot see it`);
  return Number(m[1]);
};

describe("hook-injected context stays under the vendor's per-message cap", () => {
  it("reads the constants from the source, so a rename fails loudly instead of passing vacuously", () => {
    // A test that silently stops finding its subject is the failure mode this guards.
    expect(numConst("PREVIEW_CHARS")).toBeGreaterThan(0);
    expect(numConst("MAX_PREVIEWS")).toBeGreaterThan(0);
  });

  it("the hub's own digest is capped by construction, well under the vendor limit", () => {
    expect(DIGEST_MAX_CHARS).toBe(1200);
    expect(DIGEST_MAX_CHARS).toBeLessThan(VENDOR_CAP_CHARS);
  });

  it("the Stop hook's preview block is bounded by MAX_PREVIEWS x PREVIEW_CHARS", () => {
    const previews = numConst("MAX_PREVIEWS") * numConst("PREVIEW_CHARS");
    const overflowLine = 60; // "…and N more" plus its prefix
    expect(previews + overflowLine).toBeLessThan(VENDOR_CAP_CHARS);
  });

  it("the WORST CASE across the hook's channels still fits the cap, with headroom equal to a factor", () => {
    // SessionStart is the largest injection: identity line + the fleet protocol + the hub digest.
    // The protocol is the one part not derived from a constant, so measure it from the source.
    const protocol = awarenessSrc.match(/const PROTOCOL = `([\s\S]*?)`;/);
    expect(protocol, "PROTOCOL constant not found -- the worst-case bound below would be meaningless").toBeTruthy();
    const protocolChars = protocol![1].length;

    const identityChars = 140; // "You are <name> in the OpenCadre fleet \"<org>\"."
    const worstCase = identityChars + protocolChars + DIGEST_MAX_CHARS;

    expect(worstCase).toBeLessThan(VENDOR_CAP_CHARS);
    // The factor matters as much as the inequality: a bound that PASSES by one char is a bound about
    // to break. This is the assertion that fails when someone doubles the digest without thinking.
    expect(VENDOR_CAP_CHARS / worstCase).toBeGreaterThanOrEqual(3);
  });

  it("the injected delivery text is the digest line, so the new wake path inherits the same bound", () => {
    // scripts/wake-daemon/inject-items.mjs sends digest.line verbatim. That line is built by
    // policy.mjs's buildDigest: single message = prefix + a 120-char preview; multiple = one counts
    // line with NO bodies at all. So the inject path is bounded by the same constant read above.
    const policy = readFileSync(path.join(process.cwd(), "scripts/wake-daemon/policy.mjs"), "utf8");
    expect(policy).toMatch(/PREVIEW_CHARS = (\d+)/);
    expect(Number(policy.match(/PREVIEW_CHARS = (\d+)/)![1])).toBe(numConst("PREVIEW_CHARS"));
  });
});
