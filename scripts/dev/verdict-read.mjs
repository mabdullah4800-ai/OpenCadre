/** Read every open PR's verdict OFF THE THREAD, so no merger parses prose again.
 *
 * WHY THIS EXISTS
 * The fleet's merge rule is "the verdict line is the LAST line that STARTS with a marker", and the
 * marker set is CLOSED: `**APPROVE`, `**CHANGES REQUESTED`, and the historical
 * `**No blocking correction` (still live -- the only marker on #364/#370/#371). Every one of those
 * facts was learned by running this scan BY HAND, twice, late, after a merger had already read a
 * thread wrong. This is that scan, in the repo, with the cases that broke it pinned as tests.
 *
 * WHAT IT PRINTS, AND WHY EACH PART IS NOT OPTIONAL
 *   - the selected line VERBATIM, with the comment it came from and that comment's timestamp.
 *     A verdict WORD is not re-derivable: `**APPROVE**` and `**APPROVE at <sha>**` differ in what
 *     they pin, and `**No blocking correction**` and `**CHANGES REQUESTED**` differ in direction.
 *     Printing the word alone is how "last" silently became "last among the lines this consumer can
 *     see" instead of "last in the thread" (measured: a narrow marker set resolves #359 to an OLDER
 *     comment's CHANGES REQUESTED -- a false BLOCK at the same head, invisible to a merger who
 *     greps the token and finds a hit).
 *   - `headRefOid` FROM THE PR. The pin is a property of the ref, never of the prose. #352's own
 *     verdict says so out loud: its prior pin `7645a97` is named INSIDE the line that supersedes it.
 *   - `shasInLine`. Reported as raw material, deliberately NOT as a rule. #352's selected line names
 *     the head AND a superseded SHA in the same breath; any "the verdict names a stale head" check
 *     built on those tokens would fire on the row that is most careful about its pin. Extraction
 *     from prose is the thing this script exists to remove -- so it hands the human the tokens and
 *     asserts nothing.
 *   - near-miss lines: a marker spelled correctly but NOT at line start (`Verdict: **CHANGES
 *     REQUESTED** -- ...`, `## Review -- ... **APPROVE**`). Measured 2026-09-19 on the committed
 *     fixture (14 rows / 29 comments / 19 marker lines): 11 rows carry a line-start marker and
 *     7 of those 11 hold a near-miss, and on ZERO rows would relaxing the anchor
 *     change the answer -- every near-miss is rescued by a NEWER conformant line. That is a live
 *     hazard, not a dead one: the rescue is an accident of each thread's shape, and the day one of
 *     these is the newest line, a line-start reader resolves the row to an OLDER, opposite word.
 *     So they are printed with their position, and flagged only when one is NEWER than the line
 *     that was selected.
 *   - reachability: a row based on ANOTHER OPEN PR'S branch cannot be merged on its own. #227's
 *     base IS #226's head branch. Reported, never hidden -- an unreachable row still has a verdict
 *     worth reading, it just is not what the next merge seat should pick up.
 *
 * WHAT IT DELIBERATELY IS NOT
 * It is READ-ONLY and OFFLINE-SAFE: one `gh pr list`, no writes, no merge seat, no network in the
 * exported function (the tests call it with a saved pull). It NEVER exits non-zero to signal a
 * verdict -- a script that gates is a script whose blindness becomes a blocked merge. Print and
 * stop; the verdict is still a human read.
 */

/** The closed marker set, with the word each one normalises to.
 *
 * `**No blocking correction` maps to APPROVE because that is what it MEANS: the reviewer is saying
 * nothing needs to move. It is a distinct SPELLING, not a third state -- dropping it from the set
 * is the exact silent-skip this script was written to end. The trailing text is deliberately not
 * matched (`**No blocking correction**` and `**No blocking correction.**` both occur).
 */
export const MARKERS = [
  { literal: "**APPROVE", word: "APPROVE" },
  { literal: "**CHANGES REQUESTED", word: "CHANGES REQUESTED" },
  { literal: "**No blocking correction", word: "APPROVE" },
];

/** A line STARTS with a marker. This is the contract, so it is tested against the RAW line: v4
 * anchors at line start, and a control over all 24 open rows found trimming changed the answer on
 * ZERO of them -- the anchor carries the weight, not whitespace tolerance. Do not "strengthen" this
 * by normalising leading whitespace; that would silently adopt blockquoted prose as a verdict. */
const startsWithMarker = (markers) => new RegExp(`^(?:${markers.map((m) => m.literal.replace(/[*]/g, "\\*")).join("|")})`);

/** Marker-shaped ANYWHERE in the line: the near-miss detector. */
const containsMarker = (markers) => new RegExp(`(?:${markers.map((m) => m.literal.replace(/[*]/g, "\\*")).join("|")})`);

const MARKER_SET = { start: startsWithMarker(MARKERS), any: containsMarker(MARKERS) };

/** The non-author signal: `Reviewer:` followed by a NAME. Not the bare word, and not anchored.
 *
 * WHAT WAS WRONG WITH THE PERMISSIVE FORM. `/reviewer:|non-author/i` over the WHOLE body makes any
 * comment that merely MENTIONS the concept "identified" -- and identity is tested BEFORE selection,
 * so a marker in such a comment is adopted. #377's review (46f9) named the two shapes that follow:
 * an author replying "On the non-author requirement: ..." and then writing `**APPROVE**` becomes the
 * row's verdict, OVER a reviewer's earlier `**CHANGES REQUESTED**`. That is a false UNBLOCK, in a
 * tool whose whole purpose is to be read instead of the prose -- the one direction it cannot fail in.
 *
 * WHY NOT ANCHOR AT LINE START. That is the obvious tightening, it is what "test the identity LINE,
 * not the body" sounds like, and it is catastrophic. Measured 2026-09-19 over the live 25-row pull:
 * the dominant spelling puts the signature MID-LINE, on the `Reviewed commit` line --
 *     Reviewed commit `<sha>`. Reviewer: ClaudeCode-OpenCadre-1101 (non-author)
 * -- and only **2** of 70 comments carry a `Reviewer:` at column 0. Anchoring at line start takes the
 * live board's verdicted rows from **20 to 0** (all 20 rows resolve differently) and the committed
 * fixture from 3 dark rows to **13** -- it empties the whole instrument. The token's POSITION is not
 * the discriminator; its SHAPE is.
 *
 * THE DISCRIMINATOR -- a signature, not a mention. All four measured spellings carry `Reviewer:`
 * followed by a NAME:
 *   `Reviewer: ClaudeCode-OpenCadre-1101 (non-author).`     the common one
 *   `Reviewer: ClaudeCode-OpenCadre-1101.`                  #353 c1 -- NO parenthetical at all
 *   `Reviewer: \`Agent-FFH9\` (...)`                         #369/#376 -- backticked name
 *   `**Reviewer: ClaudeCode-OpenCadre-7570 (non-author)**`  #362 -- bold-wrapped, `Reviewer:` mid-line
 * The mentions do not:
 *   "The \`Reviewer: ... (non-author)\` line is the only signal."  `...` is not a name
 *   "**Reviewer note:** 1101's non-author verdict names ..."       no colon after `Reviewer`
 *   "an independent non-author re-read" / "(7570, non-author, ...)"  no `Reviewer:` at all
 * Measured free: over the live 25-row pull this resolves all 20 verdicted rows to the SAME word and
 * the SAME comment as the permissive form (0 of 20 changed) and leaves both dark sets identical
 * (live [92 212 226 227 377], fixture [92 226 227]).
 *
 * "A NAME" USED TO MEAN "ANY WORD OF THREE LETTERS OR MORE". 46f9's residual on #377: the class was
 * `[A-Za-z][A-Za-z0-9_-]{2,}`, so `Reviewer: see the note below` was a signature and `Reviewer: the
 * thread above` was one too. An author replying "Reviewer: see my comment on F4" and then writing
 * `**APPROVE**` became the row's verdict -- the same false UNBLOCK as the mention case, reached by a
 * spelling that passes the colon test. The NON-HYPHENATED half of that class is now closed by SHAPE,
 * and the shape every real name has is a compound with at least one `-`.
 *   "Reviewer: see the note below for what moved."   the token is a WORD, not a name -- now null
 *   "Reviewer: the thread above already covers it."  same
 *   "Reviewer: Someone (non-author)"                 same -- which is why the tests' placeholder
 *                                                    name had to become identifier-shaped
 * The HYPHENATED half is NOT closed, and #383's review is where that was measured. A hyphen is a
 * shape ordinary ENGLISH has too, so a sentence whose first word is hyphenated still identifies:
 *   "Reviewer: non-author verdicts are the only signal."  -> "Reviewer: non-author"   (non-null)
 *   "Reviewer: read-only handling matters here."          -> "Reviewer: read-only"     (non-null)
 * `non-author` is the likeliest word to follow `Reviewer:` in a sentence ABOUT this convention, so
 * the same false UNBLOCK survives that spelling end to end. The CLAIM is narrowed here; the rule is
 * left alone, and STILL OPEN below records the measurement behind that choice.
 * RE-MEASURED, both corpora, because a regex change to this rule has twice produced an instrument
 * reporting the board dark. Shipped -> candidate, canonical answer per row: fixture 0 of 14 rows
 * changed (11 -> 11 verdicted, dark still [92 226 227]); the 2026-09-19 live pull 0 of 7 (4 -> 4
 * verdicted, dark still [92 226 227]). Only ONE of the two refs is checkable from the tree: the
 * fixture is committed above. The live pull is the 7-row snapshot `live-0819.json`, which is NOT in
 * the tree -- so its numbers are point-in-time and can be neither re-run nor checked here, and an
 * earlier revision of this paragraph claiming "both corpora name their ref" was wrong about one of
 * them. A
 * POSITIVE CONTROL ran in the same pass and returned `null` where the shipped rule returned a word
 * (the three lines above), so the zeroes are the instrument declining to move, not a dead
 * instrument -- which is the only reading a zero is entitled to.
 *
 * STILL OPEN, NARROWED. TWO spellings survive, and neither one is closed by this revision.
 *   (1) UNCLOSABLE IN TEXT. An author who QUOTES a reviewer's signature VERBATIM, without a
 *       blockquote marker, is textually identical to a reviewer writing it -- no rule over the text
 *       can separate them. 46f9 named this case; neither of us closed it, and the hyphen requirement
 *       does not close it. What the hyphen DOES close here is the word-shaped quote: a quoted
 *       `Reviewer: Someone` stops identifying, because `Someone` is not a shape the fleet produces.
 *       A quoted `Reviewer: ClaudeCode-OpenCadre-1101` still identifies and no text rule can stop it.
 *   (2) CLOSABLE BY A RULE, DELIBERATELY NOT CLOSED HERE. `Reviewer: non-author ...` is a hyphenated
 *       ordinary WORD, not a name -- the paragraph above. A rule CAN close it: requiring the name to
 *       be followed by `(non-author)` or end-of-line was measured against the committed fixture and
 *       refused 0 of the 27 identified LINES there -- a different denominator from the 27 identified
 *       COMMENTS below, and the two were checked to be the SAME SET rather than assumed equal: no
 *       identified comment in the fixture carries two such lines. It was NOT shipped, because
 *       that fixture does not contain every spelling the fleet writes and the candidate refused two
 *       real ones it does not hold -- `Reviewer: ClaudeCode-OpenCadre-7570 — see above` and
 *       `Reviewer: Codex-OpenCadre-1e67 — approved the payload translation`. A rule that closes a
 *       false UNBLOCK by refusing real signatures opens a false DARK, which is the failure this rule
 *       has already caused twice. What is corrected here is the CLAIM, not the class.
 *
 * The matched text is carried out with the verdict and PRINTED by formatReport, so a false
 * `identified` is visible in the OUTPUT and not only in the input.
 *
 * THE NAME CLASS REQUIRES AT LEAST ONE `-`. Every name the fleet has produced is a compound
 * (`ClaudeCode-OpenCadre-1101`, `Agent-FFH9`, `ClaudeCode-OpenCadre-e617`). Over the COMMITTED
 * fixture -- the half of the census that is checkable from the tree -- that is 4 distinct signatures
 * over 27 identified comments: `ClaudeCode-OpenCadre-1101` 19x, `ClaudeCode-OpenCadre-7570` 5x,
 * `` `Agent-FFH9`` 2x, `ClaudeCode-OpenCadre-9d1f` 1x; ZERO bare non-hyphenated words, which is the
 * premise the rule needs. An earlier revision reported "6 distinct names over 32 identified
 * comments" as a census of "both corpora"; the live half counted a local pull that is not in the
 * tree, so those numbers were not checkable and are WITHDRAWN rather than explained. The
 * rest of the class is `[A-Za-z0-9_]`, deliberately WITHOUT `.`: a name is followed by a period in
 * `Reviewer: ClaudeCode-OpenCadre-1101.` (#353 c1), and allowing `.` swallows the period into the
 * evidence. Apart from the hyphen the class only bounds where the MATCH stops -- the hyphen is what
 * decides which lines are signatures at all.
 */
export const IDENTITY = /reviewer:\s*.?([A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+)/i;

/** Hex tokens long enough to be a commit, as written (may be abbreviated). */
const SHA_TOKEN = /\b[0-9a-f]{7,40}\b/gi;

const lines = (body) => String(body ?? "").split(/\r?\n/);

/** The identity signature in a comment, or null. Scanned LINE-wise so a multi-line body cannot smear
 * a token from one line into another, and returned as the matched text ALONE -- the discriminator is
 * the shape `Reviewer: <name>`, so that is exactly what the report shows a human. `IDENTITY` carries
 * no `g` flag, so `exec` does not keep state between calls. */
export function identitySignal(body) {
  for (const raw of lines(body)) {
    const m = IDENTITY.exec(raw);
    if (m) return m[0].trim();
  }
  return null;
}

/** A bare `Reviewer:` with no name shape required -- deliberately NOT the identity rule, and used
 * ONLY to explain what the note says when a marker-bearing comment is not counted as a non-author
 * line. `IDENTITY` narrows the name to a compound, so a comment can carry `Reviewer:` and still be
 * refused for the SHAPE of what follows it.
 *
 * TWO INSTRUMENTS, TWO AXES, ONE CLAUSE EACH. The note is assembled from two tests that do NOT share
 * a scope, and every earlier revision tried to state both with a single claim about one axis -- which
 * is false on the other axis, whichever axis is chosen:
 *   - `BARE_REVIEWER` is tested over the WHOLE BODY, unanchored and case-insensitive, so it fires on
 *     a TOKEN: it cannot see whether a signature was ATTEMPTED, nor where in the body it sits.
 *   - `identitySignal` is scanned LINE-wise, so it is null when no SINGLE LINE matches `IDENTITY`.
 *
 * Three falsifying inputs, one per mechanism; each earlier wording died on one of them:
 *   1. PROSE MENTION -- "I asked the reviewer: what changed?" above a `**APPROVE**`. No signature was
 *      attempted, so the original "has a `Reviewer:` line that does not match the signature shape"
 *      reported REFUSED where MISSING is true. Same defect class as the shape case this module
 *      already had to correct (#383), one string over, and again the one thing a reader of these
 *      notes cannot check without re-reading every comment.
 *   2. SPLIT TOKEN -- "I asked the reviewer\n: what changed?". `\s*` sits between the word and the
 *      colon and `\s` matches a NEWLINE, so the BODY matches while NO LINE holds the token. Any
 *      wording claiming a LINE carries the token is false here, and no per-line rule can express
 *      this input at all.
 *   3. SPLIT SIGNATURE -- "**APPROVE**\n\nReviewer:\nClaudeCode-OpenCadre-1101 (non-author)". The
 *      signature is present in full; only the line break hides it from the line-wise scan. A claim
 *      about what the BODY carries ("carries no signature-shaped name") is false here, and that is
 *      how the token-axis wording -- correct on 1 and 2 -- died. Raised in the review of #401.
 *
 * The repair is not a third wording bet: state each instrument's result ON ITS OWN AXIS, so both
 * clauses are true BY CONSTRUCTION rather than by case analysis. "matches the bare `reviewer:`
 * pattern" IS `BARE_REVIEWER.test(body)`, the branch condition itself; "has no line with a
 * signature-shaped name" IS `identitySignal(body) === null`, which the guards entail (see the
 * entailment note at the note sites). No input above falsifies either clause, because each is a
 * restatement of a test that already ran.
 *
 * WHAT IT STILL DOES NOT SEPARATE, RECORDED SO IT IS NOT READ AS A FIX. The note distinguishes
 * token-ABSENT from token-PRESENT. It does NOT distinguish a MENTION from an ATTEMPT -- these two
 * bodies get the SAME sentence:
 *     "I asked the reviewer: what changed?"
 *     'The line reads "Reviewer: Someone (non-author)" and I agree.'
 * Splitting them needs a shape test this one does not have, and a new shape test over this rule needs
 * its own measurement on both corpora first -- the live pull at 2026-09-19T08:59Z held 5 rows and ONE
 * comment, which can measure nothing. Recorded rather than guessed at.
 *
 * The note explains a row; it never decides one. Neither wording can move a verdict word, which is
 * why the fix could ride as its own change at all. */
const BARE_REVIEWER = /reviewer\s*:/i;

/** The reason a marker-bearing comment is not counted as a non-author line, phrased to follow
 * "the comment carrying it" / "a comment that". The branches are separated by whether the bare token
 * is present at all. Each clause states ONE instrument's result on THAT instrument's own axis -- see
 * the axis note above `BARE_REVIEWER` -- so both clauses are true by construction, and neither
 * branch claims a signature was ATTEMPTED. */
function noIdentityReason(body) {
  return BARE_REVIEWER.test(String(body ?? ""))
    ? "matches the bare `reviewer:` pattern and has no line with a signature-shaped name"
    : "has no non-author line";
}

/** Every marker line in one comment, with its line number, in line order. */
function markerLines(comment, set) {
  const out = [];
  lines(comment?.body).forEach((raw, lineNumber) => {
    if (!set.start.test(raw)) return;
    const marker = MARKERS.find((m) => raw.startsWith(m.literal));
    out.push({ line: raw, lineNumber, marker: marker.literal, word: marker.word });
  });
  return out;
}

/** Every marker-shaped line that does NOT start with a marker -- the near-misses. */
function nearMissLines(comment, set) {
  const out = [];
  lines(comment?.body).forEach((raw, lineNumber) => {
    if (set.start.test(raw)) return;
    if (!set.any.test(raw)) return;
    out.push({ line: raw, lineNumber });
  });
  return out;
}

/**
 * @param {Array<{number:number,headRefOid:string,headRefName?:string,baseRefName?:string,comments?:Array}>} prs
 *   exactly the shape of `gh pr list --json number,headRefOid,headRefName,baseRefName,comments`.
 * @param {{markerSet?: Array}} [opts] `markerSet` EXISTS FOR THE TESTS AND FOR MEASURING A NARROWER
 *   RULE -- never for a report a merger reads. It is the seam that lets a regression test prove it
 *   can FAIL: the same fixture, read with the two forward markers only, must resolve #359 to the
 *   older `**CHANGES REQUESTED**`. A pin on the correct answer that cannot be made to fail is not
 *   evidence about the rule.
 * @returns {{rows: Array, summary: object}} rows sorted by number.
 */
export function readVerdicts(prs, opts = {}) {
  const all = Array.isArray(prs) ? prs : [];
  const markers = opts.markerSet ?? MARKERS;
  const set = markers === MARKERS ? MARKER_SET : { start: startsWithMarker(markers), any: containsMarker(markers) };
  // A branch that is the head of an open PR. A row whose BASE is in here cannot be merged alone.
  const openHead = new Map();
  for (const pr of all) if (pr.headRefName) openHead.set(pr.headRefName, pr.number);

  const rows = all
    .map((pr) => {
      const comments = pr.comments ?? [];
      const stackedOn = pr.baseRefName ? (openHead.get(pr.baseRefName) ?? null) : null;

      // Candidate verdict lines, paired with the comment they live in. `identified` is judged on
      // the COMMENT (its identity line is a property of the review, not of one line of it).
      const candidates = [];
      for (let i = 0; i < comments.length; i += 1) {
        const identity = identitySignal(comments[i]?.body);
        for (const m of markerLines(comments[i], set)) {
          candidates.push({ ...m, commentIndex: i, commentCreatedAt: comments[i]?.createdAt ?? null, identified: identity !== null, identity });
        }
      }
      // Ordering is (commentIndex, lineNumber): comments arrive in thread order, and within one
      // comment a later line supersedes an earlier one.
      const ordered = [...candidates].sort((a, b) => a.commentIndex - b.commentIndex || a.lineNumber - b.lineNumber);
      const picked = ordered.filter((c) => c.identified).at(-1) ?? null;
      const unfiltered = ordered.at(-1) ?? null;

      // A verdict must come from a NON-AUTHOR comment, so when none carries a marker the row has no
      // verdict -- it does NOT fall back to whatever an unidentified comment said. Falling back
      // would let an author's own `**APPROVE**` be printed as the row's verdict, which is the one
      // thing the identity check exists to prevent. The alternative is still shown, in `unfiltered`,
      // with a note: fail-closed here means "no verdict", and the human still sees what was skipped.
      const selected = picked;
      const shasInLine = selected ? [...new Set(selected.line.match(SHA_TOKEN) ?? [])] : [];

      // Near-misses NEWER than what we selected. Same-comment ordering is by line number, so a
      // heading above a verdict in one comment is correctly read as older.
      const nearMisses = [];
      for (let i = 0; i < comments.length; i += 1) {
        for (const nm of nearMissLines(comments[i], set)) {
          const newer =
            !selected ||
            i > selected.commentIndex ||
            (i === selected.commentIndex && nm.lineNumber > selected.lineNumber);
          nearMisses.push({ ...nm, commentIndex: i, commentCreatedAt: comments[i]?.createdAt ?? null, newerThanVerdict: newer });
        }
      }

      const notes = [];
      if (stackedOn !== null) notes.push(`base is #${stackedOn}'s head branch (${pr.baseRefName}) - not mergeable alone`);
      if (unfiltered && !picked) {
        notes.push(`a marker line exists but the comment carrying it ${noIdentityReason(comments[unfiltered.commentIndex]?.body)}`);
      }
      if (picked && unfiltered && (unfiltered.commentIndex !== picked.commentIndex || unfiltered.lineNumber !== picked.lineNumber)) {
        notes.push(`the newest marker line is in a comment that ${noIdentityReason(comments[unfiltered.commentIndex]?.body)} (c${unfiltered.commentIndex}) - both are printed`);
      }
      if (!selected) notes.push(comments.length ? "no verdict line in any comment" : "no comments at all");
      if (selected && !shasInLine.some((s) => String(pr.headRefOid ?? "").toLowerCase().startsWith(s.toLowerCase()))) {
        notes.push("the selected line does not name the head - take the pin from headRefOid, not from the line");
      }
      if (nearMisses.some((n) => n.newerThanVerdict)) notes.push("a NEWER marker-shaped line does not conform - read it before merging");

      return {
        number: pr.number,
        headRefOid: pr.headRefOid ?? null,
        headRefName: pr.headRefName ?? null,
        baseRefName: pr.baseRefName ?? null,
        reachable: stackedOn === null,
        stackedOn,
        verdict: selected
          ? {
              word: selected.word,
              marker: selected.marker,
              line: selected.line,
              commentIndex: selected.commentIndex,
              commentCreatedAt: selected.commentCreatedAt,
              identified: selected.identified,
              identity: selected.identity,
            }
          : null,
        unfiltered: unfiltered && !picked ? { line: unfiltered.line, word: unfiltered.word, commentIndex: unfiltered.commentIndex } : null,
        shasInLine,
        nearMisses,
        notes,
      };
    })
    .sort((a, b) => a.number - b.number);

  return {
    rows,
    summary: {
      rows: rows.length,
      verdicts: rows.filter((r) => r.verdict).length,
      noVerdict: rows.filter((r) => !r.verdict).map((r) => r.number),
      approve: rows.filter((r) => r.verdict?.word === "APPROVE").map((r) => r.number),
      changesRequested: rows.filter((r) => r.verdict?.word === "CHANGES REQUESTED").map((r) => r.number),
      unreachable: rows.filter((r) => !r.reachable).map((r) => r.number),
      nearMissNewerThanVerdict: rows.filter((r) => r.nearMisses.some((n) => n.newerThanVerdict)).map((r) => r.number),
    },
  };
}

/** Human-readable dump. Print and stop -- there is no exit code that means "do not merge". */
export function formatReport({ rows, summary }) {
  const out = [];
  out.push(`${summary.rows} open rows | ${summary.verdicts} with a verdict | ${summary.approve.length} APPROVE | ${summary.changesRequested.length} CHANGES REQUESTED`);
  out.push(`no verdict line: ${summary.noVerdict.length ? summary.noVerdict.map((n) => "#" + n).join(" ") : "(none)"}`);
  out.push(`not mergeable alone (stacked base): ${summary.unreachable.length ? summary.unreachable.map((n) => "#" + n).join(" ") : "(none)"}`);
  out.push("");
  for (const r of rows) {
    const head = r.headRefOid ? r.headRefOid.slice(0, 8) : "(no head)";
    out.push(`#${r.number}  ${head}  base=${r.baseRefName ?? "?"}${r.stackedOn !== null ? ` (on #${r.stackedOn})` : ""}`);
    if (r.verdict) {
      out.push(`    ${r.verdict.word}  [${r.verdict.marker}]  c${r.verdict.commentIndex} @${r.verdict.commentCreatedAt}`);
      out.push(`    line: ${r.verdict.line}`);
      // The identity EVIDENCE, not a boolean. The selection above is only as trustworthy as this
      // signature, so printing it is what makes a false `identified` visible in the output rather
      // than only in the input.
      out.push(`    identity: ${r.verdict.identity ?? "(NONE -- adopted without a signature: this is a bug)"}`);
      if (r.shasInLine.length) out.push(`    shas named in that line: ${r.shasInLine.join(" ")}`);
    } else {
      out.push(`    (no verdict)`);
    }
    if (r.unfiltered) out.push(`    UNFILTERED alternative: c${r.unfiltered.commentIndex} ${r.unfiltered.line}`);
    for (const nm of r.nearMisses) {
      out.push(`    near-miss${nm.newerThanVerdict ? " (NEWER than the verdict)" : ""} c${nm.commentIndex}:${nm.lineNumber} ${nm.line}`);
    }
    for (const n of r.notes) out.push(`    note: ${n}`);
    out.push("");
  }
  out.push("This is a READ, not a gate. The verdict is still a human read of the thread.");
  return out.join("\n");
}

/** CLI. Read-only: one `gh pr list`, no writes, no merge, no push. */
async function main(argv) {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const fileIdx = argv.indexOf("--file");
  let prs;
  if (fileIdx !== -1) {
    // Offline path: a previously saved pull, so this can be run with no network and no gh.
    prs = JSON.parse(readFileSync(argv[fileIdx + 1], "utf8"));
  } else {
    const json = execFileSync(
      "gh",
      ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefOid,headRefName,baseRefName,comments"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    prs = JSON.parse(json);
  }
  const report = readVerdicts(prs);
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
}

// `pathToFileURL`, not `new URL("file://" + argv[1])`: on Windows the hand-rolled form builds
// `file://B:/...`, whose HOST is `b` and whose href can never equal this module's `file:///B:/...`.
// The guard would simply never fire and the CLI would be silently dead -- the same false-green shape
// as a check that runs but is never read.
const ranDirectly = async () => {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(process.argv[1]).href;
};

if (await ranDirectly()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`verdict-read failed: ${err.message}`);
    process.exitCode = 1;
  });
}
