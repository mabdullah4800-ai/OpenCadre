// pr-state recognises the THIRD house verdict spelling, and classifies it as a CLEARANCE.
//
// THE DEFECT (measured 2026-09-20, f052 lane 12). The fleet's reviewer briefs instruct a verdict
// line starting exactly `**APPROVE**`, `**CHANGES REQUESTED**` or `**No blocking correction**`.
// `VERDICT_RE` knew only the first two, so a reviewer who followed the brief EXACTLY -- correct
// `Reviewer:` line, correct SHA, correct direction -- had the verdict dropped at the entry filter,
// before any coverage logic ran. On #499 the review ended `**Verdict: No blocking correction.**` and
// the tool printed `verdicts NONE`.
//
// This is the third distinct way a verdict can vanish, after a stale SHA and an unresolvable
// identity, and it is the worst of the three because the reviewer did nothing wrong.
//
// WHY IT MATTERS BEYOND ONE DROPPED VERDICT: `pr-state` does not merely count. The count feeds a
// MERGE-SAFETY line and an exit code that other tooling gates on. So the fix must not convert a
// silent UNDER-count into a silent OVER-count -- manufacturing a clearance is strictly worse than
// losing one. That is why the two halves below are tested separately: the phrase must be RECOGNISED
// (entry) and must normalise to APPROVE rather than to a blocker (classification).
//
// THE DESIGN QUESTION, ANSWERED FROM THE REPO RATHER THAN INVENTED: the sibling
// `scripts/dev/verdict-read.mjs` already maps `**No blocking correction` -> APPROVE, with the reason
// "that is what it MEANS: the reviewer is saying nothing needs to move. It is a distinct SPELLING,
// not a third state." `pr-state` already agreed in one place (`:215`, "the third house verdict and it
// is CLEAR, not a block") and never said so at the door. This test pins the agreement.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "scripts/dev/pr-state.mjs"), "utf8");

/** The entry filter, read out of the source. Testing the SOURCE rather than a copy means a rename or
 * a revert fails here rather than passing against a stale duplicate of the pattern. */
function entryFilter(): RegExp {
  const m = source.match(/const VERDICT_RE = (\/.*\/);/);
  if (!m) throw new Error("VERDICT_RE not found in pr-state.mjs -- the extractor is stale, not the fix");
  return eval(m[1]) as RegExp; // eslint-disable-line no-eval -- reading a literal out of a local file
}

/** The kind classifier, likewise read out of the source. */
function classifier(): RegExp {
  const m = source.match(/const verdictLine = (\/.*\/gim);/);
  if (!m) throw new Error("verdictLine not found in pr-state.mjs -- the extractor is stale, not the fix");
  return eval(m[1]) as RegExp; // eslint-disable-line no-eval
}

/** The normalisation pr-state applies to a matched kind, EXTRACTED FROM THE SOURCE.
 *
 * It was a hand-copied lambda in the first draft of this file, and that made two of the three
 * mutations GREEN -- a mutation that changed the source's mapping left this copy untouched, so the
 * test kept passing while asserting the opposite of what the tool does. That is "asserting a value
 * against itself": the local copy and the assertion share an author, so the pair cannot disagree.
 *
 * Reading the branch out of the source means a change there fails here. The parse is deliberately
 * narrow -- it extracts the two outcomes of the ternary and nothing else -- so it cannot silently
 * pick up a different expression.
 */
function normalise(word: string): string {
  // Reads `unfenced` rather than `c.body` since 2026-09-20: the scan runs over the fence-masked body
  // so a QUOTED verdict example cannot be read as the author's own. The extractor moved with it --
  // a rename here fails loudly rather than silently testing a pipeline the tool no longer uses.
  const m = source.match(/const hits = \[\.\.\.unfenced\.matchAll\(verdictLine\)\]\.map\(\(m\) => \((\/.*?\/i)\.test\(m\[1\]\) \? "([A-Z ]+)" : m\[1\]\.toUpperCase\(\)\)\);/);
  if (!m) throw new Error("the kind-normalisation line was not found in pr-state.mjs -- the extractor is stale, not the fix");
  const marker = eval(m[1]) as RegExp; // eslint-disable-line no-eval -- reading a literal out of a local file
  const mapped = m[2];
  return marker.test(word) ? mapped : word.toUpperCase();
}

// ---- declaration-reading helpers, shared by the two describes below --------------------------

/** The declaration regex, read out of the source, so a revert fails here. */
function declaration(): RegExp {
  const m = source.match(/const declared = c\.body\.match\((\/.*\/i)\);/);
  if (!m) throw new Error("the declaration parser was not found in pr-state.mjs -- the extractor is stale, not the fix");
  return eval(m[1]) as RegExp; // eslint-disable-line no-eval -- reading a literal out of a local file
}

/** The normalised SHA, read out of the source rather than re-derived, so a change to the two-group
 *  handling fails here. Mirrors the tool's own line: `declared ? (declared[1] ?? declared[2]) : null`.
 *  Also binds the identifier `unparsedFlag` needs, by the same name the source uses. */
function declaredSha(body: string): string | null {
  const m = source.match(/const declaredSha = declared \? (.*) : null;/);
  if (!m) throw new Error("the declaredSha normalisation was not found in pr-state.mjs -- the extractor is stale, not the fix");
  const declared = body.match(declaration());
  return declared ? (declared[1] ?? declared[2]) : null;
}

const SHA = /\b[0-9a-f]{7,40}\b/g;
const GOOD = "9856fde74f1a170e55b33800e25a9788cc046744";
const OTHER = "fd933679c1ac2942be567f6bd24addfacebef49e";

/** The `unparsed` flag's ACTUAL expression, lifted from the source and evaluated against the body.
 *  Re-implementing it here would make the test and the tool agree by construction -- the mistake
 *  this file's own `normalise` helper documents having made once already.
 *
 *  The expression names the tool's own locals, so they are bound here from the supplied body. Any
 *  NEW identifier the flag gains fails loudly (`is not defined`) rather than silently evaluating to
 *  false -- which is the direction that would hide a broken flag behind a green test. */
function unparsedFlag(body: string): boolean {
  const m = source.match(/const unparsed = (.*);/);
  if (!m) throw new Error("the `unparsed` flag was not found in pr-state.mjs -- the extractor is stale, not the fix");
  // Evaluate the source's own expression with its locals bound by the names it uses. A NEW
  // identifier the flag gains fails loudly (`declaredSha is not defined`) rather than evaluating to
  // false -- the direction that would hide a broken flag behind a green test.
  // eslint-disable-next-line no-eval -- the flag's own expression, evaluated against supplied input
  return Boolean(eval(`((declaredSha, scan) => ${m[1]})`)(declaredSha(body), [...new Set(body.match(SHA) ?? [])]));
}

describe("pr-state: the third house verdict spelling is recognised", () => {
  it("the ENTRY FILTER admits all three spellings the briefs prescribe", () => {
    const re = entryFilter();
    // The three, verbatim from 2-review.md:10 and 12-reviewer-2.md:21.
    expect(re.test("**APPROVE**")).toBe(true);
    expect(re.test("**CHANGES REQUESTED**")).toBe(true);
    // THE ONE THAT WAS MISSING. Red before the fix -- this is the defect as an assertion.
    expect(re.test("**No blocking correction**")).toBe(true);
  });

  it("admits the exact shape that was dropped: a `Verdict:` prefix and trailing full stop", () => {
    // f052's #499 comment, which the tool did not count. The brief says the line must START with the
    // marker; this variant prefixes `Verdict:` and ends with a full stop, and both must survive.
    const re = entryFilter();
    expect(re.test("**Verdict: No blocking correction.**")).toBe(true);
  });

  it("still admits the two original spellings, so nothing previously counted is lost", () => {
    // The regression half. A widened filter that dropped a spelling would be a worse bug than the
    // one being fixed, and it would fail in the quiet direction.
    const re = entryFilter();
    expect(re.test("**APPROVE** at `abc1234`")).toBe(true);
    expect(re.test("**CHANGES REQUESTED** — the query names a column that exists nowhere")).toBe(true);
  });
});

describe("pr-state: the third spelling classifies as a CLEARANCE, never as a block", () => {
  it("normalises to APPROVE — it is a distinct SPELLING, not a third state", () => {
    // The design ruling, matching scripts/dev/verdict-read.mjs:55 and pr-state.mjs:215.
    expect(normalise("No blocking correction")).toBe("APPROVE");
  });

  it("the kind classifier matches it, so it is classified deliberately and not by falling through", () => {
    // WHY THIS IS A SEPARATE ASSERTION FROM THE NORMALISATION. The fallback branch
    // (`lastIndexOf("CHANGES REQUESTED") > lastIndexOf("APPROVE")`) would ALSO return APPROVE here,
    // because the phrase contains neither verb. So a passing end-to-end test cannot tell "classified
    // on purpose" from "defaulted by accident" -- and those diverge the day someone edits the
    // fallback. Matching the classifier directly is what makes the intent checkable.
    const hits = [..."**Verdict: No blocking correction.**".matchAll(classifier())].map((m) => m[1]);
    expect(hits, "the classifier must SEE the phrase as a verdict line").toHaveLength(1);
    expect(normalise(hits[0])).toBe("APPROVE");
  });

  it("a body stating it does NOT produce a blocker — the fail-open direction that would be worse", () => {
    // The direction that matters. If widening the entry filter caused this phrase to be read as a
    // block, the tool would refuse a merge a reviewer had cleared.
    //
    // THE BODY IS DELIBERATELY ONE WHERE THE FALLBACK CANNOT RESCUE A BROKEN CLASSIFIER: it contains
    // no bare `APPROVE` and no `CHANGES REQUESTED`, so the only way to reach "APPROVE" is through the
    // classifier seeing the phrase itself. A body that also carried a stray APPROVE would pass even
    // with the classifier reverted — measurable, and the reason the earlier draft's clearance cases
    // stayed green under the classify-as-block mutation.
    const body = "## Review — #N at `abc1234`\n\nReviewed commit `abc1234`.\n\n**No blocking correction.**";
    expect(body, "the fixture must not contain a rescue verb, or it tests the fallback instead").not.toMatch(/\bAPPROVE\b|\bCHANGES REQUESTED\b/);
    const hits = [...body.matchAll(classifier())].map((m) => m[1]);
    expect(hits, "the classifier must see the phrase; the fallback cannot save this fixture").toHaveLength(1);
    expect(normalise(hits[hits.length - 1])).toBe("APPROVE");
    expect(normalise(hits[hits.length - 1])).not.toBe("CHANGES REQUESTED");
  });

  it("a REAL block still wins when it is the last verdict line — widening did not blunt the block", () => {
    // The other direction. A clearance stated first and then superseded by a block must still block:
    // "a body that states a verdict more than once is stating its conclusion last".
    const body = "**No blocking correction** — earlier read.\n\nOn re-read:\n\n**CHANGES REQUESTED** — the phantom column.";
    const hits = [...body.matchAll(classifier())].map((m) => m[1]);
    expect(normalise(hits[hits.length - 1])).toBe("CHANGES REQUESTED");
  });
});

describe("pr-state: the fix keeps the two regexes consistent with each other", () => {
  it("every spelling the ENTRY FILTER admits can also be CLASSIFIED", () => {
    // The invariant whose violation was the bug: the door and the classifier disagreeing. A spelling
    // let in but never classified would land on the fallback, which is where an accident becomes a
    // policy without anyone deciding it.
    const entry = entryFilter();
    const kindRe = classifier();
    for (const line of ["**APPROVE**", "**CHANGES REQUESTED**", "**No blocking correction**"]) {
      if (!entry.test(line)) continue; // not admitted: not this test's business
      expect(
        [...line.matchAll(kindRe)].length,
        `${line} is admitted by the entry filter but the kind classifier does not see it`,
      ).toBeGreaterThan(0);
    }
  });

  it("agrees with its sibling — verdict-read.mjs maps the same phrase to APPROVE", () => {
    // Cross-file, because the two tools read the SAME threads and a disagreement between them is a
    // second defect of exactly the kind being fixed. This asserts the sibling still holds its end;
    // it does not import it, so a change there fails here loudly rather than silently diverging.
    const read = readFileSync(resolve(process.cwd(), "scripts/dev/verdict-read.mjs"), "utf8");
    expect(read, "verdict-read.mjs must still map the third spelling to APPROVE").toMatch(
      /\{\s*literal:\s*"\*\*No blocking correction",\s*word:\s*"APPROVE"\s*\}/,
    );
  });
});

// A FOURTH way a verdict can be misread, and the first one where the tool is not WRONG but SILENT.
//
// THE DEFECT (measured 2026-09-20, 6da7 lane 2, on #496). The declaration parser requires the SHA
// inside backticks -- `Reviewed commit \`<sha>\``. A reviewer who backticks the WHOLE PHRASE instead
// (a rendering habit, not a mistake about the subject) matches nothing, so `declared` is null and
// the body-SCAN runs. The scan picks a resolvable SHA out of a body that legitimately discusses
// several heads, and reports the verdict against one the reviewer never reviewed.
//
// `declaredBroken` already reports a declaration that PARSED and did not resolve. A declaration that
// never parsed is a DIFFERENT case, and it was unreported: two lanes lost a verdict this way in one
// night and both concluded the tool had fabricated one. It had scanned -- exactly as the header says
// it may -- with nothing saying it had guessed.
//
// THE TWO HALVES ARE SEPARATE PROPERTIES, tested separately: the notice must FIRE on a body that
// declares unparseably, and stay SILENT on one that declares correctly. A guard that always fires is
// as useless as one that never does, because it stops being read.
describe("pr-state: an unparseable declaration is REPORTED, not silently scanned", () => {

  it("FIRES on the shape that caused this: the whole phrase backticked, SHA included", () => {
    // Verbatim shape from the #496 comment that produced a verdict at a head its author never reviewed.
    const body = "`Reviewed commit " + GOOD + "`. Reviewer: x (non-author)\n\nI also saw " + OTHER + ".";
    expect(declaredSha(body), "this shape must NOT parse -- that is the whole defect").toBe(null);
    expect(unparsedFlag(body), "an unparseable declaration with SHAs present must be REPORTED").toBe(true);
  });

  it("STAYS SILENT on a correctly declared body — the false-positive direction", () => {
    for (const body of [
      "Reviewed commit `" + GOOD + "`. Reviewer: x (non-author)",
      "**Reviewed commit `" + GOOD + "`**\n\nReviewer: x",
    ]) {
      expect(declaredSha(body), "a correct declaration must parse").toBe(GOOD);
      expect(unparsedFlag(body), "a parsed declaration must NOT raise the notice").toBe(false);
    }
  });

  it("does NOT double-fire with declaredBroken — the two cases are disjoint", () => {
    // A declaration that PARSES but names a nonexistent commit is `declaredBroken`'s. If `unparsed`
    // fired there too, one condition would carry two notices.
    const broken = "Reviewed commit `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`. Reviewer: x";
    expect(declaredSha(broken), "a well-formed but unresolvable declaration still PARSES").toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(unparsedFlag(broken), "declaredBroken is the channel here; unparsed must not also fire").toBe(false);
  });

  it("stays silent on a body carrying NO SHA at all — nothing was guessed", () => {
    // `unresolvable` is the channel for that one. With no candidates the scan has nothing to pick,
    // so calling it a guess would be false.
    const body = "**APPROVE**\n\nReviewer: x";
    expect(declaredSha(body)).toBe(null);
    expect(unparsedFlag(body), "no SHAs means no guess, so no notice").toBe(false);
  });
});

// A FIFTH way a verdict is misread, and the only one where a lane that does everything RIGHT loses
// its subject. Found by 43cd reviewing the fix above, after they ran their own #504 body through the
// pattern to check the notice fired -- it did not, and the reason was not the one they had assumed.
//
// THE DEFECT. `Reviewed` is case-insensitive and `commit` is optional, so an ordinary sentence
//     I reviewed `32391b7b` in full. The head moved.
// parsed as a DECLARATION naming 32391b7b. `String.match` returns the FIRST match, so it OVERRODE a
// correct `Reviewed commit \`<head>\`` line further down the body. And because the prose SHA
// resolves, `declaredResolves` was true, `declaredBroken` false, `cands = [prose]` -- the scan was
// never consulted, so NO notice on that path was reachable. It fails CONFIDENTLY, which is why
// 43cd's re-post "fixed" it: the correct line moved FIRST, not because preambles stopped mattering.
//
// WHY ANCHORING AND NOT `lastIndexOf` (the verb classifier's precedent at :193): both orders occur --
// prose before a real line, and prose after one -- and no positional rule fixes both. `lastIndexOf`
// corrects the first and BREAKS the second. Anchoring fixes both, because what distinguishes a
// declaration from prose is not its position but that it IS the line.
//
// THE ASSUMPTION, AND WHY IT IS CHECKED RATHER THAN ASSUMED: anchoring requires declarations to sit
// at line start -- the same move that once DROPPED a real verdict in `REVIEWER_RE` (:98-101). Across
// 13 fleet PRs every one of the 25 real declaration lines begins at line start, so the assumption
// holds on the evidence available. The loop below is what checks it.
describe("pr-state: a declaration is the LINE, not prose that mentions reviewing", () => {
  const PROSE = "bbbb111122223333444455556666777788889999";
  const REAL = "aaaa111122223333444455556666777788889999";

  it("IGNORES a prose sentence that would otherwise win on first-match — the case that cost a verdict", () => {
    const body = `I reviewed \`${PROSE}\` in full. The head moved.\n\nReviewed commit \`${REAL}\`. Reviewer: x`;
    expect(declaredSha(body), "the REAL declaration must win, not the prose mention that precedes it").toBe(REAL);
  });

  it("is order-independent — prose AFTER a real declaration also loses", () => {
    // The half `lastIndexOf` would break. Both orders must resolve to the declaration.
    const body = `Reviewed commit \`${REAL}\`. Reviewer: x\n\nI reviewed \`${PROSE}\` too.`;
    expect(declaredSha(body), "a later prose mention must not override the declaration above it").toBe(REAL);
  });

  it("still parses every real declaration shape the fleet writes", () => {
    // Every form below is a LINE TAKEN FROM A LIVE VERDICT in a 120-PR corpus, not invented. The
    // last three are the ones a LINE-START ANCHOR broke when it was tried first -- they are written
    // mid-line or under a markdown heading, and they cost 18 real declarations on that corpus. This
    // test is the tripwire: if a future change adds a position requirement, these fail.
    for (const body of [
      `Reviewed commit \`${REAL}\`. Reviewer: ClaudeCode-OpenCadre-x (non-author)`,
      `**Reviewed commit \`${REAL}\`**\n\nReviewer: x`,
      `> Reviewed commit \`${REAL}\`\n\nReviewer: x`,
      // MID-LINE after a Reviewer prefix — the exact shape that broke REVIEWER_RE at :98-101.
      `**Reviewer: ClaudeCode-OpenCadre-d617 (Lane 10, non-author).** Reviewed commit \`${REAL}\``,
      // The second sanctioned form, under a heading.
      `## Verdict: APPROVE at \`${REAL}\` — one note, nothing blocking`,
      // ...and with a bold block inside it.
      `## Re-verdict: **CHANGES REQUESTED** at \`${REAL}\``,
    ]) {
      expect(declaredSha(body), `a real declaration shape failed to parse: ${body.split("\n")[0]}`).toBe(REAL);
    }
  });

  it("a body that is ONLY prose still declares nothing — the notice remains reachable", () => {
    // Anchoring must not turn "prose mentions reviewing" into "a declaration was found", or the
    // silent-scan case above would become unreachable and this fix would undo that one.
    const body = `I reviewed \`${PROSE}\` in full, and nothing else here.`;
    expect(declaredSha(body), "prose alone is not a declaration").toBe(null);
    expect(unparsedFlag(body), "and with a SHA present the scan notice must still fire").toBe(true);
  });
});

// A SIXTH failure, and the only one that FAILS OPEN -- it manufactures a clearance over a live block.
//
// THE DEFECT (f052, #505, 2026-09-20). A review is REQUIRED to paste this tool's own output, and that
// output contains verdict words. So a review that quotes an example -- including one quoting the tool
// -- has the QUOTED text counted as a verdict line, and since the kind is the LAST hit, the quote
// overrides the author's own conclusion. f052 posted CHANGES REQUESTED, quoted
// `## Verdict: APPROVE at <sha>` in an evidence table, and the tool printed `APPROVE ... safe to
// merge`. **The more thoroughly they documented the block, the more firmly it cleared the PR.**
//
// THE FIRST DIAGNOSIS WAS MINE AND IT WAS WRONG, which is why the measure below is a table and not an
// argument. I believed the newline-spanning prefix (`[#>\s]*`) was the route. Measured: it is not --
// a quoted verdict line sits at column 0, so the `m` anchor alone reaches it with or without the
// span. Narrowing the prefix is kept (a prefix should not cross a line) but it closes nothing here.
//
// THE FIX IS FENCE-AWARENESS: mask fenced regions before scanning. The measure below is the part that
// matters -- these are not fixtures chosen by someone who already knows the answer's shape; they are
// the real body shapes from this fleet, including the one that caused the defect.
describe("pr-state: a verdict QUOTED in a fence is not the author's verdict", () => {
  /** The masked body and the classifier, both read out of the source so a revert fails here. */
  function kindOf(body: string): string | null {
    const maskExpr = source.match(/const unfenced = c\.body(.*);/)?.[1];
    if (maskExpr === undefined) throw new Error("the fence-masking line was not found in pr-state.mjs -- the extractor is stale, not the fix");
    const vl = source.match(/const verdictLine = (\/.*\/gim);/)?.[1];
    if (!vl) throw new Error("verdictLine was not found in pr-state.mjs -- the extractor is stale, not the fix");
    // eslint-disable-next-line no-eval -- the source's own masking expression, applied to supplied input
    const unfenced = eval(`((body) => body${maskExpr})`)(body);
    const re = eval(vl) as RegExp; // eslint-disable-line no-eval
    const hits = [...unfenced.matchAll(new RegExp(re.source, re.flags))]
      .map((m) => (/no blocking correction/i.test(m[1]) ? "APPROVE" : m[1].toUpperCase()));
    if (hits.length) return hits[hits.length - 1];
    // The fallback reads the masked body too -- the last place a quoted verdict word could leak in.
    return unfenced.lastIndexOf("CHANGES REQUESTED") > unfenced.lastIndexOf("APPROVE") ? "CHANGES REQUESTED" : "APPROVE";
  }

  it("FAILS OPEN no longer: a block that QUOTES an approve stays a block", () => {
    // f052's shape. This is the assertion the defect inverted -- it read APPROVE before the fix.
    const body = "**CHANGES REQUESTED** at `abc123`.\n\n## Evidence\n\n```\n## Verdict: APPROVE at `def456`\n```\n";
    expect(kindOf(body), "a quoted example must not override the author's conclusion").toBe("CHANGES REQUESTED");
  });

  it("an UNCLOSED fence is fail-SAFE — the verdict is lost, never manufactured", () => {
    // No closing fence masks to the end. The body loses its verdict to the scan fallback rather than
    // gaining a clearance from quoted text: losing a block is recoverable, inventing one is not.
    const body = "**CHANGES REQUESTED** at `abc123`\n\n```\n## Verdict: APPROVE at `def456`\n";
    expect(kindOf(body), "an unterminated fence must not yield its quoted APPROVE").not.toBe("APPROVE");
  });

  it("every REAL verdict shape still classifies — the fix must not cost a true reading", () => {
    // These are live shapes, not invented. A fence fix that ate real verdicts would be worse than the
    // defect: it would lose clearances AND blocks rather than inventing one.
    const real: Array<[string, string]> = [
      ["## Verdict: APPROVE at `abc123`\n\nReviewer: x", "APPROVE"],
      ["## Review — #N\n\n**CHANGES REQUESTED** at `abc123`\n", "CHANGES REQUESTED"],
      // A re-read verdict NAMES the block it resolves first, then concludes -- last-wins is why this
      // class works, and first-wins would break all of them.
      ["CHANGES REQUESTED was the earlier verdict.\n\n**APPROVE** at `abc123`\n", "APPROVE"],
      ["**No blocking correction.**\n\nReviewer: x", "APPROVE"],
    ];
    for (const [body, want] of real) {
      expect(kindOf(body), `a real verdict shape misclassified: ${body.split("\n").pop()}`).toBe(want);
    }
  });
});

// A SEVENTH failure, and the one no index rule can fix: A BODY THAT MIXES VOCABULARIES.
//
// Two kinds in one body means one of two documents and the tool cannot tell them apart:
//   a review that CHANGED ITS MIND  -- conclusion last, so "last wins" is right
//   a review that QUOTED an example -- the quote may be first OR last
// Every index rule fails open on one of them. Measured: last-wins clears a block that quotes an
// approve; FIRST-wins would have cleared 43cd's #504, whose real declaration sits below prose.
//
// SO THE TOOL REFUSES. Ruled by 9d1f 2026-09-20, with 43cd's reason: the fix is a fence-aware lexer,
// not a different match index. The asymmetry decides it -- a refusal costs a reviewer one terse
// re-post; a wrong guess costs a merge.
//
// WHY THIS IS SHIPPABLE RATHER THAN DISRUPTIVE, measured on 87 real comment bodies / 19 PRs:
//   50 classify to ONE kind and are untouched
//   1  (1 of 59 attributed verdict comments, 1.7%) hits the refusal
//   3  mixed WITHOUT fence-masking -- fence-awareness silences 2 of them
// Part 2 is what makes part 3 rare. Without it this refusal would fire on every review that quotes
// evidence and the tool would be useless.
describe("pr-state: an ambiguous body is REFUSED, not resolved by picking", () => {
  /** Mirrors the shipped pipeline: mask, scan lines, collect DISTINCT kinds. */
  function kindsOf(body: string): string[] {
    const maskExpr = source.match(/const unfenced = c\.body(.*);/)?.[1];
    if (maskExpr === undefined) throw new Error("the fence-masking line was not found -- extractor stale");
    const vl = source.match(/const verdictLine = (\/.*\/gim);/)?.[1];
    if (!vl) throw new Error("verdictLine was not found -- extractor stale");
    // eslint-disable-next-line no-eval -- the source's own masking expression
    const unfenced = eval(`((body) => body${maskExpr})`)(body);
    const re = eval(vl) as RegExp; // eslint-disable-line no-eval
    return [...new Set([...unfenced.matchAll(new RegExp(re.source, re.flags))]
      .map((m) => (/no blocking correction/i.test(m[1]) ? "APPROVE" : m[1].toUpperCase())))];
  }

  it("the refusal is wired to the AMBIGUITY, and reads distinct kinds", () => {
    // The flag must key on the SET of kinds, not on the hit count -- two APPROVEs are a normal
    // body that states its conclusion twice, and must NOT refuse.
    expect(source, "the ambiguity flag must be derived from the SET of kinds").toMatch(
      /const kindsSeen = \[\.\.\.new Set\(hits\)\];\s*const ambiguous = kindsSeen\.length > 1;/,
    );
  });

  it("an ambiguous covering verdict reaches the EXIT CODE, not only the row text", () => {
    // THE HALF THAT MATTERS MOST. The row's `kind` is a guess the tool just refused to stand behind;
    // letting that guess decide `problems` would put the guess back in charge of the merge.
    expect(source, "an ambiguous covering verdict must be a `problems` entry, so the exit code agrees").toMatch(
      /covering\.filter\(\(v\) => v\.ambiguousKinds\)\) problems\.push\(/,
    );
    expect(source, "and the refusal must read 'CANNOT TELL', naming the ambiguity").toMatch(/CANNOT TELL/);
  });

  it("DISTINCT KINDS: a repeated kind is not ambiguous, two different kinds are", () => {
    expect(kindsOf("**APPROVE** at `a`\n\n**APPROVE** at `b`\n"), "two APPROVEs are one kind").toEqual(["APPROVE"]);
    const mixed = kindsOf("**CHANGES REQUESTED** at `a`\n\n**APPROVE** was what they wanted, so no.\n");
    expect(mixed.sort(), "two different kinds must be reported as mixed").toEqual(["APPROVE", "CHANGES REQUESTED"]);
  });

  it("a fence still silences the quotation — part 2 is what keeps the refusal rare", () => {
    const body = "**CHANGES REQUESTED** at `a`\n\n```\n## Verdict: APPROVE at `b`\n```\n";
    expect(kindsOf(body), "the quoted approve is inside a fence and must not make the body ambiguous").toEqual(["CHANGES REQUESTED"]);
  });
});

// AN EIGHTH failure, and the first one where the tool misled a MERGER rather than a reviewer.
//
// THE DEFECT (measured 2026-09-21, 9d1f). `2 verdicts already cover this head — a further read is
// rework, not verification` counted COMMENTS. The house protocol INSTRUCTS a reviewer to post the
// verdict terse and the evidence separately, so EVERY correctly-posted review inflates that to two.
// On #505 one reviewer's two comments, 18 seconds apart, produced the sentence -- and the reader it
// talked out of looking was the MERGER, who held a clean approved PR because the tool said it needed
// no read. The tool's own bug made its own fix look blocked.
//
// THE TWO OBVIOUS FIXES WERE MEASURED AND BOTH ARE HARMFUL, which is why the shipped one is a list:
//   - deduping the COUNT would hide FOUR real verdict changes in 59 attributed comments (#496 6da7,
//     #505 43cd, #505 f052 CHANGES REQUESTED -> APPROVE, #455 1051) -- the third being the block that
//     governed the very PR this was found on;
//   - requiring a declared verdict line before counting drops EIGHT more, several of which are GENUINE
//     verdicts written as prose (`## APPROVE — #504 at `<sha>``).
// A deduped LIST is safe where a deduped COUNT is not: the list shows an identity once, while every
// comment still prints as its own row.
describe("pr-state: the head is described by REVIEWERS, not by a count of comments", () => {
  it("the rework advisory is gone from `problems` — it never gated a merge and must not", () => {
    // A rework advisory is INFORMATION. It talks a reader out of looking, which is the one thing it
    // must never do, and it is computed from a number that cannot support it.
    expect(source, "the comment-count advisory must no longer push a problem").not.toMatch(/problems\.push\(`\$\{covering\.length\} verdicts already cover/);
    expect(source, "and the sentence itself must be gone").not.toMatch(/a further read is rework/);
  });

  it("prints a DEDUPED identity list, and keeps the comment count as information beside it", () => {
    // The list answers "who has read this"; the parenthetical preserves "how many comments" without
    // letting it drive a decision.
    expect(source, "the list must be deduped by identity").toMatch(/const coveringReviewers = \[\.\.\.new Set\(covering\.map\(\(v\) => v\.who\)/);
    expect(source, "and must print with the comment count preserved as an aside").toMatch(/read by\s+\$\{coveringReviewers\.join/);
    expect(source, "the aside prints the comment count only when it differs").toMatch(/covering\.length > coveringReviewers\.length/);
  });

  it("the OK line keys on REVIEWERS, not comments — the bug that hid a cleared head", () => {
    // `covering.length === 1` was a comment test. With the protocol's two comments per reviewer, a
    // genuinely cleared head read as `covering.length === 2`, matched NEITHER `OK` branch, and printed
    // no verdict sentence at all.
    expect(source, "the cleared-by branch must count reviewers").toMatch(/problems\.length === 0 && coveringReviewers\.length === 1/);
    expect(source, "and it must name who cleared it").toMatch(/OK  cleared by \$\{coveringReviewers\[0\]\}/);
    // The coverage check must STILL be a comment count -- it asks how many comments were found.
    expect(source, "the no-verdict branch must stay a comment count").toMatch(/problems\.length === 0 && covering\.length === 0/);
  });

  it("labels an INFERRED kind, so a declared verdict and a defaulted one are distinguishable", () => {
    // 8 of 59 attributed comments (14%) take the presence-fallback: no line-anchored verdict was found
    // and the kind was DEFAULTED to APPROVE. Two of the eight contain BOTH verdict words and happen to
    // be correct -- by luck, not by rule. Without a label a reader sees `read by: f052` and cannot tell
    // whether f052 declared or was inferred -- the difference between EVIDENCE and a SUMMARY.
    expect(source, "the flag must be derived from the ABSENCE of a declared line").toMatch(/const inferred = hits\.length === 0;/);
    expect(source, "and a covering row must say so").toMatch(/\[inferred — no declared verdict line; kind defaulted from prose\]/);
    expect(source, "the identity list must report how many were inferred").toMatch(/of them INFERRED, see \[inferred\] rows/);
  });

  it("the two GATE lines are untouched — this change must not touch what decides a merge", () => {
    // The BLOCKED line and the mixed-kind refusal are the only outputs that gate. Neither moves.
    expect(source, "the BLOCKED line must be unchanged").toMatch(/problems\.push\(`BLOCKED by \$\{b\.who\} at \$\{short\(b\.sha\)\} — a covering CHANGES REQUESTED/);
    expect(source, "the ambiguity refusal must be unchanged").toMatch(/covering\.filter\(\(v\) => v\.ambiguousKinds\)\) problems\.push\(/);
  });
});
