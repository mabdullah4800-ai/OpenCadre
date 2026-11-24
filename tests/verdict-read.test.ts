import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { IDENTITY, MARKERS, formatReport, identitySignal, readVerdicts } from "../scripts/dev/verdict-read.mjs";

/**
 * `scripts/dev/verdict-read.mjs` reads a verdict off a PR thread so no merger parses prose again.
 *
 * The fixture is a REAL pull, not a hand-written one: `gh pr list --state open --json
 * number,headRefOid,headRefName,baseRefName,comments` against `origin/main` @ `d63f08f`, 2026-09-19.
 * Every marker line, near-miss line and identity line is verbatim; long prose lines are truncated to
 * stubs and line NUMBERS are preserved by never dropping a line, because the near-miss ordering is
 * by (commentIndex, lineNumber) and a rewrite would silently move a heading below the verdict it
 * sits above. Comments carrying nothing load-bearing are dropped. Rows #92/#226/#227 are shape-only
 * (#92/#226 have no comments; #227 is the stacked row).
 */
const ROWS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/verdict-read-rows.json", import.meta.url)), "utf8"));

const byNumber = (prs: any[], n: number) => prs.find((r) => r.number === n);
const rowOf = (n: number, prs = ROWS, opts?: any) => byNumber(readVerdicts(prs, opts).rows, n);

/** The two forward markers only. NOT a rule under test -- it is the narrow set the historical
 * marker was dropped from, kept here so the #359 and #364 regressions can be shown to FAIL. */
const NARROW = MARKERS.filter((m: { literal: string }) => m.literal !== "**No blocking correction");

describe("verdict-read: the marker set is CLOSED", () => {
  it("carries all three markers, historical included, with the historical one normalising to APPROVE", () => {
    expect(MARKERS.map((m: { literal: string }) => m.literal)).toEqual([
      "**APPROVE",
      "**CHANGES REQUESTED",
      "**No blocking correction",
    ]);
    expect(MARKERS.find((m: { literal: string }) => m.literal === "**No blocking correction")?.word).toBe("APPROVE");
  });

  // REGRESSION #359. Its own newest verdict line uses the historical marker, and it is the row where
  // getting this wrong produces a FALSE BLOCK rather than a skip: read with the two forward markers
  // it resolves to an OLDER comment's `**CHANGES REQUESTED**, at the same head. A merger grepping
  // the token finds a hit and believes it. The assertion below fails if either the set is narrowed
  // or the "last line" comparison stops being scoped to the comments the consumer can see.
  it("#359 resolves to the NEWER historical marker, not the older CHANGES REQUESTED", () => {
    const r = rowOf(359);
    expect(r.verdict.word).toBe("APPROVE");
    expect(r.verdict.marker).toBe("**No blocking correction");
    expect(r.verdict.line).toBe(
      "**No blocking correction.** The fourth and fifth corrections are the ones I sent this back over previously, and both now point at their own mechanism rather than at a status. Nothing in the new commit needs to move.",
    );
    // The older, opposite verdict is still there and is strictly older -- that is what makes the
    // narrow reading wrong rather than merely absent.
    expect(r.verdict.commentIndex).toBe(2);
    const older = ROWS.find((x: any) => x.number === 359).comments[0];
    expect(older.body).toContain("**CHANGES REQUESTED** at `43e287a4`");
    expect(older.createdAt < r.verdict.commentCreatedAt).toBe(true);
  });

  it("the #359 regression FAILS under the narrow set -- the pin can be made to go red", () => {
    const narrow = rowOf(359, ROWS, { markerSet: NARROW });
    expect(narrow.verdict.word).toBe("CHANGES REQUESTED");
    expect(narrow.verdict.line).toContain("43e287a4");
  });

  it("#353's newer historical marker also wins over its older `**APPROVE**", () => {
    const r = rowOf(353);
    expect(r.verdict.marker).toBe("**No blocking correction");
    expect(r.verdict.commentIndex).toBe(2);
    expect(r.verdict.word).toBe("APPROVE");
  });

  it("the historical-marker-only rows resolve instead of going dark (#364 #370 #371)", () => {
    for (const n of [364, 370, 371]) {
      const r = rowOf(n);
      expect(r.verdict, `#${n} must not be dark`).not.toBeNull();
      expect(r.verdict.marker, `#${n}`).toBe("**No blocking correction");
      expect(r.verdict.word).toBe("APPROVE");
    }
    // ...and these are exactly the rows the narrow set empties, which is the defect being pinned.
    const darkUnderNarrow = readVerdicts(ROWS, { markerSet: NARROW })
      .rows.filter((r: any) => !r.verdict)
      .map((r: any) => r.number);
    // #92/#226/#227 are dark either way (no comments at all); #364/#370/#371 are dark ONLY because
    // the set was narrowed. That difference is the whole defect, so both halves are asserted.
    expect(darkUnderNarrow).toEqual([92, 226, 227, 364, 370, 371]);
    expect(readVerdicts(ROWS).summary.noVerdict).toEqual([92, 226, 227]);
  });
});

describe("verdict-read: the pin comes from headRefOid, never from prose", () => {
  // REGRESSION #352. Its selected line names the head AND a superseded pin in the same breath, so
  // any "the verdict names a stale SHA" rule built on those tokens fires on the row that is most
  // careful about its pin. The instrument reports the tokens and asserts nothing.
  it("#352 approves and its selected line names both the head and the pin it supersedes", () => {
    const r = rowOf(352);
    expect(r.verdict.word).toBe("APPROVE");
    expect(r.verdict.line).toContain("**APPROVE** — at `2399e1ad0c827b4b63a063c49670004f8a894b18`");
    expect(r.shasInLine).toContain("2399e1ad0c827b4b63a063c49670004f8a894b18");
    expect(r.shasInLine, "the superseded pin is a mention, not the pin").toContain("7645a97");
    // The pin the merger must use is the PR's own field, and it is NOT derivable from the line alone.
    expect(r.headRefOid).toBe("2399e1ad0c827b4b63a063c49670004f8a894b18");
  });

  it("a verdict line naming a head that is not the current head is REPORTED, not silently accepted", () => {
    const stale = [
      {
        number: 9001,
        headRefOid: "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee",
        headRefName: "lane/x",
        baseRefName: "main",
        comments: [
          {
            createdAt: "2026-09-19T00:00:00Z",
            body: "Reviewed commit `1111111222222223333333344444444`.\n\nReviewer: Agent-Test1 (non-author).\n\n**CHANGES REQUESTED** at `1111111222222223333333344444444` — stale head.\n",
          },
        ],
      },
    ];
    const r = rowOf(9001, stale);
    expect(r.verdict.word).toBe("CHANGES REQUESTED");
    expect(r.verdict.line).toContain("1111111");
    expect(r.headRefOid).toBe("aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee");
    expect(r.notes.join(" | ")).toContain("does not name the head");
    // Reported means the block still stands -- the mismatch is information for the human, and the
    // instrument does not get to decide the block was wrong.
    expect(r.verdict.word).toBe("CHANGES REQUESTED");
  });
});

describe("verdict-read: near-misses are printed, and flagged only when they are newer", () => {
  it("#352's `Verdict: **CHANGES REQUESTED**` does not start its line, so it is a near-miss and not the verdict", () => {
    const r = rowOf(352);
    const nm = r.nearMisses.filter((n: any) => n.line.startsWith("Verdict: **CHANGES REQUESTED**"));
    expect(nm).toHaveLength(1);
    expect(nm[0].commentIndex).toBe(0);
    expect(nm[0].newerThanVerdict).toBe(false);
    expect(r.verdict.commentIndex).toBe(2);
  });

  it("a heading above the verdict inside the SAME comment is older, not newer", () => {
    // #362 and #369 carry `## Review — ... **APPROVE**` at line 0 with the conformant verdict later
    // in the same comment. Ordering by line number is what keeps this from being a false alarm.
    for (const n of [362, 369]) {
      const r = rowOf(n);
      const sameComment = r.nearMisses.filter((m: any) => m.commentIndex === r.verdict.commentIndex);
      expect(sameComment.length, `#${n} has a heading near-miss`).toBeGreaterThan(0);
      for (const m of sameComment) expect(m.newerThanVerdict, `#${n} heading at line ${m.lineNumber}`).toBe(false);
      expect(r.nearMisses.some((m: any) => m.newerThanVerdict)).toBe(false);
    }
  });

  it("#360 has TWO line-start markers in ONE comment: the LATER line wins, and a word-only check cannot see it", () => {
    // The only row in the committed fixture whose comment holds more than one line-start marker (no
    // row in the 7-row live pull has one), so it is the only row that exercises the
    // `|| a.lineNumber - b.lineNumber` term of the ordering AT ALL. Both markers normalise to
    // APPROVE, so asserting the WORD proves nothing: a mutant that reverses the within-comment order
    // (measured against this fixture) still returns "APPROVE" while selecting the EARLIER line. Two
    // independent catchers are therefore asserted, neither of which is the word:
    //   1. `shasInLine` -- the winner's line names the head; the historical marker's line names no
    //      SHA at all, so the mutant's list comes back empty.
    //   2. the ABSENCE of the "does not name the head" note -- the mutant FIRES it, the control does
    //      not. Asserting the note's PRESENCE would pass under both readings and catch nothing.
    const body = ROWS.find((x: any) => x.number === 360).comments[0].body;
    const starts = String(body)
      .split(/\r?\n/)
      .filter((l: string) => MARKERS.some((m: { literal: string }) => l.startsWith(m.literal)));
    expect(starts, "the premise: this is the multi-marker comment").toHaveLength(2);
    expect(starts[0]).toBe("**No blocking correction.**");
    expect(starts[1]).toContain("**APPROVE**");

    const r = rowOf(360);
    expect(r.verdict.word).toBe("APPROVE");
    expect(r.verdict.marker, "catcher 1a: the LAST marker is the winner").toBe("**APPROVE");
    expect(r.verdict.line, "catcher 1b: and it is the line that names the head").toContain("0a2356f0a69dde3e8edd6416e74dbc2c4aeab8fb");
    expect(r.shasInLine, "catcher 1c: present on the control, EMPTY under the mutant").toEqual(["0a2356f0a69dde3e8edd6416e74dbc2c4aeab8fb"]);
    expect(r.notes, "catcher 2: the mutant's note must be ABSENT").toEqual([]);
    // The losing marker is in the SAME comment and is strictly EARLIER, which is what makes the
    // reversed order wrong rather than merely different.
    expect(r.verdict.commentIndex).toBe(0);
  });

  it("CONTROL: over the whole real fixture, no near-miss is newer than the verdict it sits under", () => {
    // Measured 2026-09-19 on this fixture (14 rows / 29 comments): 11 rows carry a line-start marker,
    // 19 marker lines, 7 of the 11 marker rows hold a near-miss (8 near-miss lines) -- and relaxing
    // the anchor would change the answer on ZERO rows, because every one is rescued by a newer
    // conformant line. The rescue is an accident of each thread, which is why the flag exists for
    // the day it stops holding.
    //
    // The marker-line count is RE-DERIVED here from the raw fixture rather than taken from the
    // instrument, so a change to the reader cannot move the denominator out from under the
    // numerator. (An earlier revision of this file said "7 of 19"; 19 was reproducible against
    // neither the marker rows nor the marker lines, and was replaced by the pair it should have
    // been. That the count is 19 TODAY is a coincidence of the added #360 row -- it does not
    // retroactively vindicate the old number, which described a 13-row fixture where the true
    // count was 17.)
    const markerLines = ROWS.reduce(
      (a: number, pr: any) =>
        a + (pr.comments ?? []).reduce((b: number, c: any) => b + (c.body ?? "").split(/\r?\n/).filter((l: string) => MARKERS.some((m: { literal: string }) => l.startsWith(m.literal))).length, 0),
      0,
    );
    const report = readVerdicts(ROWS);
    expect(report.rows.filter((r: any) => r.verdict).length, "rows carrying a line-start marker").toBe(11);
    expect(markerLines, "marker lines in the fixture").toBe(19);
    expect(report.rows.filter((r: any) => r.nearMisses.length).length, "rows carrying a near-miss").toBe(7);
    expect(report.rows.flatMap((r: any) => r.nearMisses).length, "near-miss lines").toBe(8);
    expect(report.summary.nearMissNewerThanVerdict).toEqual([]);
  });
});

describe("verdict-read: reachability and darkness are reported, never hidden", () => {
  it("#227's base is another OPEN PR's head branch", () => {
    const r = rowOf(227);
    expect(r.baseRefName).toBe("feat/reasonix-client");
    expect(r.reachable).toBe(false);
    expect(r.stackedOn).toBe(226);
    expect(r.notes.join(" | ")).toContain("not mergeable alone");
    // An unreachable row is still printed in full -- hiding it would lose a real verdict.
    expect(readVerdicts(ROWS).rows.map((x: any) => x.number)).toContain(227);
  });

  it("rows with no verdict line at all are named, and distinguished from rows with no comments", () => {
    const report = readVerdicts(ROWS);
    expect(report.summary.noVerdict).toEqual([92, 226, 227]);
    expect(rowOf(92).notes).toContain("no comments at all");
    expect(rowOf(226).notes).toContain("no comments at all");
  });

  it("every row is emitted, verdict or not -- a dark row is a row, not a missing row", () => {
    const report = readVerdicts(ROWS);
    expect(report.rows.map((r: any) => r.number)).toEqual([92, 226, 227, 352, 353, 355, 359, 360, 362, 364, 369, 370, 371, 375]);
    expect(report.summary.rows).toBe(ROWS.length);
  });
});

describe("verdict-read: the identity signal survives every spelling in the corpus", () => {
  it("#353's comment carries a bare `Reviewer:` with no parenthetical and is still identified", () => {
    const raw = ROWS.find((x: any) => x.number === 353).comments[1];
    expect(raw.body).toContain("Reviewer: ClaudeCode-OpenCadre-1101.");
    expect(raw.body).not.toContain("(non-author)");
    expect(rowOf(353).verdict.identified).toBe(true);
  });

  it("#362's reviewer spells the signature `Reviewer: \\`Agent-FFH9\\` (...)` and is still identified", () => {
    // Identified on the SIGNATURE, not on the neighbouring `Non-author.` sentence -- that sentence is
    // no longer a signal at all (see the signature-vs-mention suite below).
    const raw = ROWS.find((x: any) => x.number === 362).comments[3];
    expect(raw.body).toContain("Non-author.");
    expect(identitySignal(raw.body)).toBe("Reviewer: `Agent-FFH9");
    expect(rowOf(362).verdict.identified).toBe(true);
  });

  it("a marker line in a comment with no identity line is reported as an alternate, not adopted", () => {
    const anon = [
      {
        number: 9002,
        headRefOid: "f".repeat(40),
        headRefName: "lane/y",
        baseRefName: "main",
        comments: [
          { createdAt: "2026-09-19T00:00:00Z", body: "an author talking to themselves\n\n**APPROVE** — mine, honestly\n" },
        ],
      },
    ];
    const r = rowOf(9002, anon);
    expect(r.verdict).toBeNull();
    expect(r.unfiltered?.word).toBe("APPROVE");
    expect(r.notes.join(" | ")).toContain("no non-author line");
  });
});

describe("verdict-read: the identity signal is a SIGNATURE, not a mention", () => {
  /**
   * The hole this suite pins, and the two ways to get the fix wrong.
   *
   * THE HOLE (found in #377's review by 46f9). The shipped matcher was `/reviewer:|non-author/i`
   * tested over the whole body, so an AUTHOR's comment became "identified" as soon as it mentioned
   * the concept -- and because identity is resolved BEFORE selection, its marker was adopted. An
   * author replying "On the non-author requirement: ..." and then writing `**APPROVE**` therefore
   * BECAME the verdict, over a reviewer's earlier `**CHANGES REQUESTED**`: a FALSE UNBLOCK, which is
   * the one direction a tool meant to replace prose-reading cannot fail in.
   *
   * WRONG FIX #1 -- keep the bare word, drop only the position. Anchoring at line start is what
   * "test the identity LINE" sounds like, and it empties the instrument: measured on the live
   * 25-row pull, verdicted rows go 20 -> 0. The dominant spelling is MID-LINE on the
   * `Reviewed commit` line, so the token's POSITION is not the discriminator.
   *
   * WRONG FIX #2 -- require `(non-author`. #353 c1 writes `Reviewer: ClaudeCode-OpenCadre-1101.`
   * with no parenthetical at all; #255 writes `(second reviewer lane)`. The parenthetical is not
   * the discriminator either.
   *
   * THE DISCRIMINATOR IS SHAPE: `Reviewer:` followed by a NAME.
   *
   * AND A NAME IS A COMPOUND (46f9's residual on #377). The first cut of the shape test spelled
   * "name" as `[A-Za-z][A-Za-z0-9_-]{2,}` -- three letters or more -- so `Reviewer: see the note
   * below` was a signature and an author could reach the same false UNBLOCK by quoting a sentence
   * rather than by mentioning the concept. The class now requires at least one `-`, which is the
   * one thing every real spelling in the corpus has. The suite below pins BOTH halves: the word
   * forms are refused, and the identifier forms the fleet actually writes are untouched.
   */
  const HISTORICAL = /reviewer:|non-author/i;

  it("the dominant spelling is MID-LINE, so a line-start rule cannot read the corpus", () => {
    // Recounted with the SHIPPED rule, so this cannot drift from the implementation. Measured over
    // 14 fixture rows: 26 comment occurrences mid-line, 1 at column 0.
    let midLine = 0;
    let col0 = 0;
    for (const pr of ROWS) {
      for (const c of pr.comments ?? []) {
        for (const raw of String(c.body ?? "").split(/\r?\n/)) {
          const i = raw.search(IDENTITY);
          if (i < 0) continue;
          if (i > 0) midLine += 1;
          else col0 += 1;
          break; // one signature per comment is the shape; more would be a mention
        }
      }
    }
    expect(midLine, "signatures that a line-start rule would miss").toBe(26);
    expect(col0, "signatures a line-start rule could still see").toBe(1);
    expect(midLine).toBeGreaterThan(col0);
  });

  it("#352's signature sits after `Reviewed commit <sha>.` on the SAME line and is read", () => {
    // Located by CONTENT, not by comment index: the fixture drops comments carrying nothing
    // load-bearing, so an index that holds in the live pull does not hold here.
    const raw = ROWS.find((x: any) => x.number === 352).comments.find((c: any) => String(c.body).includes("Reviewer:"));
    const line = String(raw.body).split(/\r?\n/).find((l: string) => l.includes("Reviewer:"));
    expect(line?.startsWith("Reviewed commit ")).toBe(true);
    expect(identitySignal(raw.body)).toBe("Reviewer: ClaudeCode-OpenCadre-1101");
    expect(rowOf(352).verdict.identity).toBe("Reviewer: ClaudeCode-OpenCadre-1101");
  });

  // REGRESSION -- 46f9's case 3. An author replies on-thread after a CHANGES REQUESTED, merely
  // mentioning the identity concept, and its marker is now the newest in the thread. This is the
  // shape the fleet produces constantly, which is why it is the one that matters.
  it("an author's reply that MENTIONS the concept does not become the verdict", () => {
    const authorReply = "On the non-author requirement: I read it the same way, thanks.\n\n**APPROVE**\n";
    expect(HISTORICAL.test(authorReply), "the historical rule would have adopted this").toBe(true);
    expect(identitySignal(authorReply), "the shipped rule must not").toBeNull();

    const prs = [
      {
        number: 9003,
        headRefOid: "a".repeat(40),
        headRefName: "lane/z",
        baseRefName: "main",
        comments: [
          { createdAt: "2026-09-19T00:00:00Z", body: "Reviewed commit `bbb`. Reviewer: Agent-Test1 (non-author).\n\n**CHANGES REQUESTED** at `bbb` -- one line to move.\n" },
          { createdAt: "2026-09-19T00:10:00Z", body: authorReply },
        ],
      },
    ];
    const r = rowOf(9003, prs);
    expect(r.verdict.word, "the block must survive the author's reply").toBe("CHANGES REQUESTED");
    expect(r.verdict.commentIndex).toBe(0);
  });

  it("STILL OPEN, pinned as open: an author quoting an IDENTIFIER-shaped signature is indistinguishable", () => {
    // Not a claim that this is fixed -- a pin that it is NOT, so the limitation cannot be quietly
    // forgotten. The author's text and a reviewer's signature are byte-identical here; NO rule over
    // the text can separate them, which is why the module records this case instead of papering it
    // over. If a future revision closes it by some non-textual means, this test goes red on purpose.
    //
    // NARROWED by the hyphen requirement, and the narrowing is the point. This test used to quote a
    // PLACEHOLDER name -- so it was pinning the exact case the fix closes while claiming to pin the
    // one no fix can. What remains genuinely unclosable is the identifier-shaped quotation, and only
    // that is pinned here now. The word-shaped half is pinned as CLOSED, in the test below.
    const quoted = 'The line reads "Reviewer: Agent-Test1 (non-author)" and I agree with it.\n\n**APPROVE**\n';
    expect(identitySignal(quoted), "the shipped rule cannot tell a quote from a signature").toBe("Reviewer: Agent-Test1");
    const prs = [
      {
        number: 9005,
        headRefOid: "a".repeat(40),
        headRefName: "lane/z",
        baseRefName: "main",
        comments: [
          { createdAt: "2026-09-19T00:00:00Z", body: "Reviewed commit `bbb`. Reviewer: Agent-Test1 (non-author).\n\n**CHANGES REQUESTED** at `bbb`.\n" },
          { createdAt: "2026-09-19T00:10:00Z", body: quoted },
        ],
      },
    ];
    expect(rowOf(9005, prs).verdict.word, "KNOWN LIMITATION: the quote is adopted").toBe("APPROVE");
  });

  it("the WORD-shaped quote IS closed: a quoted `Reviewer: Someone` no longer identifies", () => {
    // The other half of the narrowing, and the half that is a real behaviour change -- so it gets a
    // test rather than a mention. `Someone` is not a shape the fleet produces, so a quotation of a
    // placeholder signature stops being a signature. Because identity is resolved BEFORE selection,
    // that is the whole difference between the author's `**APPROVE**` being adopted and the
    // reviewer's earlier `**CHANGES REQUESTED**` standing: the same text, minus the false unblock.
    const quoted = 'The line reads "Reviewer: Someone (non-author)" and I agree with it.\n\n**APPROVE**\n';
    expect(identitySignal(quoted), "a bare word is not a name").toBeNull();
    const prs = [
      {
        number: 9006,
        headRefOid: "a".repeat(40),
        headRefName: "lane/z",
        baseRefName: "main",
        comments: [
          { createdAt: "2026-09-19T00:00:00Z", body: "Reviewed commit `bbb`. Reviewer: Agent-Test1 (non-author).\n\n**CHANGES REQUESTED** at `bbb`.\n" },
          { createdAt: "2026-09-19T00:10:00Z", body: quoted },
        ],
      },
    ];
    const r = rowOf(9006, prs);
    expect(r.verdict.word, "the block survives the quoted placeholder").toBe("CHANGES REQUESTED");
    expect(r.verdict.commentIndex).toBe(0);
    // ...and the author's marker is still REPORTED, not discarded -- the exclusion is from ADOPTION,
    // not from the report. Note WHERE it is reported: `unfiltered` is populated only when the row has
    // NO verdict at all (`unfiltered && !picked`), so with a verdict picked the divergence rides in a
    // note instead. This assertion started life as `unfiltered.word` and came back null, which is the
    // instrument saying the row was read, not that the marker was dropped.
    expect(r.unfiltered).toBeNull();
    // The note names what the instrument actually tested. c1 carries `Reviewer: Someone (non-author)`
    // and was refused for the SHAPE of the name, so it holds the bare token and no signature. An
    // earlier revision said this comment "has no non-author line", which is false about the input, and
    // this assertion used to pin that false sentence. #383's review found it: the note a human reads to
    // decide whether a review happened at all said the opposite of what the comment contains.
    //
    // The sentence below is the THIRD revision. Each earlier one stated both instruments' results with
    // a single claim on ONE axis, and died on the other: the original "has a `Reviewer:` line that does
    // not match the signature shape" implied a REFUSAL for a body whose only occurrence is ordinary
    // prose, and its replacement ("carries no signature-shaped name, only the bare reviewer token")
    // said a signature-shaped name was ABSENT about a body that contains ONE IN FULL -- split across a
    // line break, which is all the line-wise scan needs to miss it. Found in the review of #401; see
    // the split-signature test below, which is the one that goes red if the token-axis wording returns.
    expect(r.notes.join(" | "), "the skipped newer marker is still reported").toContain(
      "the newest marker line is in a comment that matches the bare `reviewer:` pattern and has no line with a signature-shaped name (c1)",
    );
    expect(r.notes.join(" | ")).toContain("both are printed");
    expect(r.notes.join(" | "), "the old false sentence must be gone").not.toContain("with NO non-author line");
  });

  it("the mention forms in the live corpus are not signatures", () => {
    // Every one of these is verbatim in the 25-row live pull, and every one was ADOPTED before.
    for (const mention of [
      "*(Identity: this is a `gh pr comment`. The `Reviewer: … (non-author)` line is the only signal.)*",
      "**Reviewer note:** 1101's non-author verdict names `1fc28ea` exactly, and this comment adds context.",
      "- **#375 at `b5ab830d`** -- APPROVED (7570, non-author, one-file re-read).",
      "**Requested:** an independent non-author re-read naming `7215c3c01f2f9bd12106553361cd3c346cd6fe81`.",
    ]) {
      expect(HISTORICAL.test(mention), "the historical rule would have adopted this").toBe(true);
      expect(identitySignal(mention), mention).toBeNull();
    }
    // ...and the parenthetical-free spelling is a signature, which is why requiring `(non-author`
    // is not the fix either.
    expect(identitySignal("Reviewed commit `393933e3`. Reviewer: ClaudeCode-OpenCadre-1101.")).toBe("Reviewer: ClaudeCode-OpenCadre-1101");
    expect(identitySignal("Reviewed commit `aaeb834f`. Reviewer: ClaudeCode-OpenCadre-2a98 (second reviewer lane).")).toBe("Reviewer: ClaudeCode-OpenCadre-2a98");
  });

  it("the reader reports the identity EVIDENCE, so formatReport can show it", () => {
    // The module's own comment claimed a false `identified` was "visible". It was not: formatReport
    // printed neither `identified` nor its evidence, so the claim had nothing behind it. Printing the
    // matched signature is what makes that comment true.
    const r = rowOf(352);
    const text = formatReport({ rows: [r], summary: readVerdicts([ROWS.find((x: any) => x.number === 352)]).summary });
    expect(text).toContain("identity: Reviewer: ClaudeCode-OpenCadre-1101");
  });

  it("CONTROL: every verdicted row in the fixture carries a signature", () => {
    // Pins the `(NONE -- adopted without a signature: this is a bug)` branch as unreachable on the
    // real corpus, so if it ever prints, the reader is adopting an unsigned comment.
    for (const r of readVerdicts(ROWS).rows.filter((x: any) => x.verdict)) {
      expect(r.verdict.identity, `#${r.number}`).toBeTruthy();
      expect(r.verdict.identified).toBe(true);
    }
  });

  it("STILL OPEN, pinned as open: a HYPHENATED ordinary word still identifies", () => {
    // The residual the hyphen requirement leaves, measured by #383's review. The shipped rule now
    // asks for a compound, and a hyphen is a shape ordinary ENGLISH has too, so the cheapest spelling
    // of the old hole survives: `non-author` is the likeliest word to follow `Reviewer:` in a sentence
    // ABOUT this convention, which is why it is the one pinned here.
    //
    // Pinned END TO END rather than at the matcher, because a matcher returning a word is only
    // interesting once identity is resolved BEFORE selection: the author's own `**APPROVE**` is then
    // adopted over the reviewer's earlier `**CHANGES REQUESTED**`. That adoption is the harm, so the
    // adoption is what the assertion names. If a future revision closes the class by any means
    // -- `(non-author)` adjacency, a name-shaped token, whatever -- this test goes red on purpose, and
    // the module's own comment says the class is open. It is a plain `it`, NOT `it.fails`: `it.fails`
    // passes on ANY throw, so it would pin that a defect exists without pinning which one.
    const authorReply = "Reviewer: non-author verdicts are the only signal we accept.\n\n**APPROVE**\n";
    expect(identitySignal(authorReply), "a hyphenated WORD, not a name").toBe("Reviewer: non-author");
    const prs = [
      {
        number: 9010,
        headRefOid: "a".repeat(40),
        headRefName: "lane/z",
        baseRefName: "main",
        comments: [
          { createdAt: "2026-09-19T00:00:00Z", body: "Reviewed commit `bbb`. Reviewer: Agent-Test1 (non-author).\n\n**CHANGES REQUESTED** at `bbb`.\n" },
          { createdAt: "2026-09-19T00:10:00Z", body: authorReply },
        ],
      },
    ];
    const r = rowOf(9010, prs);
    expect(r.verdict?.word, "KNOWN LIMITATION: the author's own APPROVE is adopted").toBe("APPROVE");
    expect(r.verdict?.commentIndex, "the reviewer's line at c0 is superseded by the reply at c1").toBe(1);
    // ...and the second spelling, so a future fix cannot close one and claim the class.
    expect(identitySignal("Reviewer: read-only handling matters here.")).toBe("Reviewer: read-only");
  });

  it("the note separates `no reviewer token at all` from `a token with no signature`", () => {
    // Same row shape, opposite causes, and `unfiltered && !picked` fires for both -- so the note is the
    // only thing a human reads to tell them apart. Until #383's review it reported the first cause for
    // both, which told a reader that a comment containing `Reviewer: Someone (non-author)` had no
    // reviewer line at all. The instrument CAN see exactly two things -- whether the bare `Reviewer:`
    // TOKEN is in the body at all, and whether any SINGLE LINE carries a signature -- and nothing
    // finer, so the note says exactly those two and no more. A reader deciding whether a review
    // happened is exactly who this note is for.
    //
    // TITLE CORRECTED, not decorated. It said "no signature written" vs "a signature REFUSED", which is
    // the distinction a reader WANTS and not the one this test can hold: the token test cannot separate
    // a refused signature from a prose mention, and the two get the same sentence -- pinned as open in
    // the test below. A title that claims the finer reading is a test named past its fixture.
    const MISSING = "an author talking to themselves\n\n**APPROVE** — mine, honestly\n";
    const REFUSED = 'The line reads "Reviewer: Someone (non-author)" and I agree with it.\n\n**APPROVE**\n';
    const mk = (n: number, body: string) => [
      { number: n, headRefOid: "a".repeat(40), headRefName: "lane/z", baseRefName: "main", comments: [{ createdAt: "2026-09-19T00:00:00Z", body }] },
    ];
    const missing = rowOf(9007, mk(9007, MISSING));
    const refused = rowOf(9008, mk(9008, REFUSED));
    expect(missing.verdict, "neither row has a verdict").toBeNull();
    expect(refused.verdict).toBeNull();
    expect(missing.notes.join(" | ")).toContain("the comment carrying it has no non-author line");
    expect(refused.notes.join(" | "), "the token IS present, so the note must say so").toContain(
      "the comment carrying it matches the bare `reviewer:` pattern and has no line with a signature-shaped name",
    );
    expect(refused.notes.join(" | "), "the false cause must not be reported for a comment carrying the token").not.toContain(
      "has no non-author line",
    );
  });

  it("a PROSE mention of the token is not reported as a refused signature", () => {
    // The regression the corrected wording exists for, and the reason it is asserted at the NOTE and
    // not at the regex. `BARE_REVIEWER` is tested over the WHOLE BODY -- unanchored and
    // case-insensitive -- so it fires on a TOKEN and cannot see whether a signature was ATTEMPTED.
    // A body whose only occurrence is ordinary prose reached the branch anyway, and the previous
    // wording answered it with "has a `Reviewer:` line that does not match the signature shape": a
    // claim about a LINE, implying a REFUSAL, for a comment where nothing was attempted. REFUSED
    // reported where MISSING is true -- the same defect class #383's review found, one string over.
    //
    // MUTATION CONTROL, and the reason this test is evidence rather than decoration: restore the
    // original wording ("has no non-author line") OR the intermediate line-claim and the two
    // assertions below go red. The first cannot be satisfied by a sentence that mentions a line, and
    // the second names the exact string the intermediate wording used. This test does NOT catch the
    // THIRD revision's defect -- the token-axis wording was true for prose -- which is why the
    // split-signature test below is a separate input and not a restatement of this one.
    const PROSE = "I asked the reviewer: what changed?\n\n**APPROVE**\n";
    const BARE_TOKEN = /reviewer\s*:/i; // re-derived here, not imported: the control must not borrow
    expect(BARE_TOKEN.test(PROSE), "the token IS present -- that is the whole point").toBe(true);
    expect(identitySignal(PROSE), "and it is not a signature").toBeNull();
    const r = rowOf(9009, [
      { number: 9009, headRefOid: "a".repeat(40), headRefName: "lane/z", baseRefName: "main", comments: [{ createdAt: "2026-09-19T00:00:00Z", body: PROSE }] },
    ]);
    expect(r.verdict, "no signature, so no verdict").toBeNull();
    expect(r.notes.join(" | "), "one clause per instrument, each on its OWN axis").toContain(
      "the comment carrying it matches the bare `reviewer:` pattern and has no line with a signature-shaped name",
    );
    expect(r.notes.join(" | "), "the false claim must be gone, not merely joined").not.toContain("`Reviewer:` line");
    expect(r.notes.join(" | "), "and it must not borrow the refusal vocabulary").not.toContain("does not match the signature shape");

    // SECOND falsifying input, and it is not the prose case -- a different mechanism that a fix aimed
    // only at prose would have missed. `BARE_REVIEWER` has `\s*` between the word and the colon, and
    // `\s` MATCHES A NEWLINE, so this body matches the pattern while NO LINE holds the token: line 1
    // ends at "reviewer", line 2 starts at ":". The wording "has a `Reviewer:` line" was false here
    // for a reason no per-line reading can see. Found by a self-falsification probe over the two note
    // sites, not by inspection. The clause that IS true here is the body-scoped one, and it is true
    // because it is the branch condition restated.
    const SPLIT = "I asked the reviewer\n: what changed?\n\n**APPROVE**\n";
    expect(BARE_TOKEN.test(SPLIT), "the BODY matches across the newline").toBe(true);
    expect(
      SPLIT.split("\n").some((l: string) => /reviewer\s*:/i.test(l)),
      "and yet NO LINE holds the token -- this is the point",
    ).toBe(false);
    const split = rowOf(9013, [
      { number: 9013, headRefOid: "a".repeat(40), headRefName: "lane/z", baseRefName: "main", comments: [{ createdAt: "2026-09-19T00:00:00Z", body: SPLIT }] },
    ]);
    expect(split.notes.join(" | ")).toContain(
      "matches the bare `reviewer:` pattern and has no line with a signature-shaped name",
    );
  });

  it("a signature SPLIT ACROSS A NEWLINE is not reported as absent", () => {
    // REGRESSION -- found in the review of #401 (comment 5740792569), and it is the MIRROR of the
    // split-token case above. There, the BODY matched while no LINE held the token. Here the signature
    // is present IN FULL and it is the line-wise scan that cannot see it: `identitySignal` splits the
    // body on newlines and tests each line alone, so `Reviewer:` ending one line and the name starting
    // the next yields `null` -- while the SAME BYTES flattened identify normally. That is a property
    // of the SCAN, not of the signature, and both halves are asserted so the difference cannot be
    // misread as a missing signature.
    //
    // The wording this replaces said "carries no signature-shaped name, only the bare reviewer token"
    // about this body: a claim about what the BODY carries, false about a body carrying a complete
    // signature. It was correct on the prose case AND on the split-token case, which is why it took a
    // third input to falsify it -- and why the repair is not a fourth choice of noun but ONE CLAUSE
    // PER INSTRUMENT, each on the axis that instrument actually tests.
    //
    // MUTATION CONTROL: restore the token-axis wording and the body-scoped clause below still passes
    // while the negation assertion goes red, so this test is evidence rather than decoration.
    const SPLIT_SIG = "**APPROVE**\n\nReviewer:\nClaudeCode-OpenCadre-1101 (non-author)\n";
    const FLAT = SPLIT_SIG.replace(/\n+/g, " ");
    expect(identitySignal(SPLIT_SIG), "the line-wise scan cannot see it").toBeNull();
    expect(identitySignal(FLAT), "the SAME BYTES flattened identify, so the signature IS there").toBe(
      "Reviewer: ClaudeCode-OpenCadre-1101",
    );
    const r = rowOf(9014, [
      { number: 9014, headRefOid: "a".repeat(40), headRefName: "lane/z", baseRefName: "main", comments: [{ createdAt: "2026-09-19T00:00:00Z", body: SPLIT_SIG }] },
    ]);
    expect(r.verdict, "not identified, so no verdict -- this test is not about identification").toBeNull();
    const notes = r.notes.join(" | ");
    expect(notes, "the clause the scan DOES entail: no single line carries it").toContain(
      "no line with a signature-shaped name",
    );
    expect(notes, "and the body-scoped clause, which is the branch condition restated").toContain(
      "matches the bare `reviewer:` pattern",
    );
    expect(notes, "the retracted body-level claim must be gone, not merely joined").not.toContain(
      "carries no signature-shaped name",
    );
  });

  it("STILL OPEN, pinned as open: the note cannot separate a MENTION from an ATTEMPT", () => {
    // The residual this wording leaves, recorded so the next reader does not mistake the correction for
    // a fix. The note now tells token-ABSENT from token-PRESENT, which is exactly what the instrument
    // tests -- and no more. A prose mention and a refused signature are both token-present, so they get
    // the SAME sentence, and `refused` below asserts that sameness.
    //
    // Pinned as a plain `it` asserting the CONFLATION, not `it.fails`: `it.fails` passes on ANY throw,
    // so it would pin that a limitation exists without pinning which one. If a future revision adds a
    // shape test that splits these two -- which would be a real improvement -- this test goes red and
    // must be rewritten, deliberately. It is not decorated with a vague "known issue" comment.
    const MISSING = "an author talking to themselves\n\n**APPROVE** — mine, honestly\n";
    const PROSE = "I asked the reviewer: what changed?\n\n**APPROVE**\n";
    const REFUSED = 'The line reads "Reviewer: Someone (non-author)" and I agree with it.\n\n**APPROVE**\n';
    const mk = (n: number, body: string) => [
      { number: n, headRefOid: "a".repeat(40), headRefName: "lane/z", baseRefName: "main", comments: [{ createdAt: "2026-09-19T00:00:00Z", body }] },
    ];
    const reason = (n: number, body: string) => {
      const note = rowOf(n, mk(n, body)).notes.find((x: string) => x.includes("non-author line") || x.includes("signature-shaped"));
      expect(note, "the note fires for all three").toBeTruthy();
      return note;
    };
    expect(reason(9011, PROSE), "KNOWN LIMITATION: a mention reads exactly like a refusal").toBe(reason(9012, REFUSED));
    expect(reason(9011, MISSING), "but the absent case IS separated").not.toBe(reason(9012, REFUSED));
  });
});

describe("verdict-read: it is a read, not a gate", () => {
  const CLI = fileURLToPath(new URL("../scripts/dev/verdict-read.mjs", import.meta.url));

  it("exits 0 while PRINTING a CHANGES REQUESTED line -- it never votes", () => {
    // The title used to say "reporting a CHANGES REQUESTED ROW", which this fixture cannot support:
    // measured, `summary.changesRequested` is EMPTY -- every row in it resolves to APPROVE. What the
    // stdout assertion actually finds is a NEAR-MISS (`Verdict: **CHANGES REQUESTED**` on #352), and
    // the point survives unchanged: the report prints a blocking word and exits 0 anyway. But the
    // old title described a row that does not exist, so the empty set is asserted here rather than
    // left for a reader to discover. A test whose name outruns its fixture is how a suite stops
    // being readable as evidence.
    expect(readVerdicts(ROWS).summary.changesRequested, "the fixture holds no CHANGES REQUESTED row").toEqual([]);
    const r = spawnSync(process.execPath, [CLI, "--file", fileURLToPath(new URL("./fixtures/verdict-read-rows.json", import.meta.url))], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CHANGES REQUESTED");
    expect(r.stdout).toContain("This is a READ, not a gate.");
  });

  it("prints the selected line VERBATIM rather than a verdict word", () => {
    const r = rowOf(359);
    const text = formatReport({ rows: [r], summary: readVerdicts([ROWS.find((x: any) => x.number === 359)]).summary });
    expect(text).toContain("No blocking correction.** The fourth and fifth corrections are the ones I sent this back over previously");
  });

  it("the module has no write, spawn or network call in its exported path", () => {
    // A static tripwire, and honest about being one: the fixture-driven tests above already prove
    // the pure path is side-effect free on import. What this catches is someone LATER reaching for
    // `execSync("gh pr merge")` or a `fetch` inside the reader.
    const src = readFileSync(CLI, "utf8");
    const body = src.slice(0, src.indexOf("async function main"));
    for (const bad of ["writeFileSync", "execSync", "spawnSync", "fetch(", "gh pr merge", "gh pr comment"]) {
      expect(body.includes(bad), `the reader half must not contain ${bad}`).toBe(false);
    }
  });
});
