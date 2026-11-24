#!/usr/bin/env node
// Is this PR safe to verdict, and is it safe to merge?
//
// Three failures cost this fleet real time on 2026-09-19, and all three were the same shape: a
// human holding routing state in their head and getting it wrong.
//
//   1. A verdict posted on a SHA that had already been verdicted    -> 3 reads of one commit
//   2. A hold lifted against a `main` measured an hour earlier      -> nearly a wasted full read
//   3. A verdict posted on a head that CONFLICTS with main          -> a verdict on a tree that
//                                                                      cannot exist post-merge
//
// Rules in a broadcast do not prevent any of those, because they rely on someone remembering. This
// does, because it is the thing you run instead of remembering. It answers, for one PR:
//
//   - does the newest verdict name the CURRENT head, or a SHA that has moved?
//   - does the head merge cleanly into CURRENT origin/main, right now?
//   - who has already verdicted this head, so you do not re-review a cleared delta?
//
// THE VERDICT FORMAT IS LOAD-BEARING. READ THIS BEFORE YOU WRITE A VERDICT.
// This tool finds a verdict's SUBJECT by reading the line where the verdict DECLARES it:
//
//     Reviewed commit `<sha>`          (or)   Verdict: ... at `<sha>`
//
// A verdict that opens with a preamble instead, and never declares its commit in one of those
// forms, falls back to SCANNING the body for SHAs -- and because every verdict is required to
// paste this tool's own output, a body reliably contains OTHER PRs' SHAs. The scan can then pick
// the wrong one and report your verdict as STALE, or as covering nothing.
//
// THAT CASE IS NOW REPORTED rather than silent:
//     [NO declaration parsed — SHA chosen by SCAN, may be the wrong commit]
// It still happens, and the fix is still yours -- the notice says the tool GUESSED, it cannot say
// what you meant. Two lanes lost a verdict this way in one night and both read it as a fabricated
// verdict, because nothing said the tool had scanned. Now something does. Write the declaration,
// and put the backticks around the SHA rather than the whole phrase.

//
// Read-only: it fetches and reads. It never pushes, merges, or comments.
//
//   node scripts/dev/pr-state.mjs 461
//   node scripts/dev/pr-state.mjs 461 465 456      # a whole queue
//
// Exit 0 = safe to act. Exit 1 = at least one PR is STALE or CONFLICTED.
//
// KNOWN LIMIT, stated rather than hidden: the APPROVE / CHANGES-REQUESTED classification is a
// HEURISTIC (first verb wins) and it is still wrong sometimes, because verdict bodies quote each
// other freely. Do not automate on `kind`. The load-bearing outputs -- which SHA a verdict names,
// whether it covers the head, and whether the head merges into main right now -- are exact, and
// they are the ones the exit code is computed from.

import { execFileSync } from "node:child_process";

// `gh` and `git` are called with an argv array, never a shell string: a command assembled as a
// string gets word-split by the shell and mangles quoting (this repo has been bitten by that).
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryRun = (cmd, args) => { try { return { ok: true, out: run(cmd, args) }; } catch (e) { return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; } };

// THE HOUSE VERDICT SET IS THREE SPELLINGS, NOT TWO, and this regex was one short.
//
// The fleet's briefs (2-review.md, 12-reviewer-2.md) instruct a verdict line that starts exactly
// `**APPROVE**`, `**CHANGES REQUESTED**` or `**No blocking correction**`. This filter knew only the
// first two, so a reviewer who followed the brief EXACTLY -- correct `Reviewer:` line, correct SHA,
// correct direction -- had their verdict dropped at the filter, before any of the coverage logic ran.
// Measured: f052's #499 review ended `**Verdict: No blocking correction.**` and `pr-state` printed
// `verdicts NONE`. That is the third distinct way a verdict can vanish, after the stale SHA and the
// unresolvable identity, and the worst of the three because the reviewer did nothing wrong.
//
// NOT A THIRD STATE. `scripts/dev/verdict-read.mjs` -- the sibling that reads these same threads --
// already normalises `**No blocking correction` to APPROVE, with the reason: "that is what it MEANS:
// the reviewer is saying nothing needs to move. It is a distinct SPELLING, not a third state." This
// file already agreed in one place (`:215`: "the third house verdict and it is CLEAR, not a block")
// and simply never said so at the door. Widening the entry filter to match the sibling is what makes
// the two agree.
//
// WHY WIDENING IS SAFE, given that this filter feeds a MERGE-SAFETY line: the phrase is recognised
// here AND classified as APPROVE below, so it can never reach the blockers list, which keys on the
// exact string `CHANGES REQUESTED`. The alternative -- adding it to the filter and letting the
// classifier fall through -- would default it to APPROVE anyway via the lastIndexOf branch, which is
// the right answer by accident; the classifier below names it explicitly so the two agree on purpose.
const VERDICT_RE = /\bAPPROVE\b|\bCHANGES REQUESTED\b|\bNo blocking correction\b/;
// A 7-40 char hex run. Deliberately loose: every candidate is then RESOLVED against git, because
// pattern-matching finds candidates and only ancestry/existence decides them.
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;

// A COMMENT MENTIONING A VERDICT VERB IS NOT A VERDICT, and conflating the two produces the one
// failure this tool must never have: a FALSE GREEN.
//
// MEASURED 2026-09-20 on #465. The PR author posted "Resolution complete -- head `1e13e1d3`...",
// which referenced the word APPROVE in passing. The tool reported it as an APPROVE COVERING THE
// HEAD and printed "safe to merge". Merging on that would have landed a head NO REVIEWER HAD READ,
// on the author's own announcement. The only hint was `unattributed`, which is not a refusal.
//
// So a verdict must be ATTRIBUTABLE: it carries a "Reviewer: <agent>" line. That line is also the
// only identity signal available here, because every fleet PR posts through one shared gh account
// and `author` reads identically for author and reviewer alike -- there is no other way to tell
// whose comment this is. Comments that mention a verb without that line are reported separately as
// unattributed, and are NOT counted as coverage.
// The attribution line, and it took THREE measured failures to get right:
//   "Reviewer: **ClaudeCode-OpenCadre-e9c7**"   markdown bold -- a bare [A-Za-z0-9-]+ matches
//       nothing after "Reviewer: " and silently DROPS a real verdict.
//   "...carries no `Reviewer:` line, so it..."  prose ABOUT the rule matched and captured "line"
//       as a reviewer. My own verdict text minted a phantom verdict.
//   "...e24b218`. Reviewer: ClaudeCode-OpenCadre-1101"  MID-LINE -- so anchoring to a line start
//       (my fix for the second) dropped a real verdict. Fixing one broke another.
// The discriminator that handles all three is the NAME SHAPE, not the position: an agent id
// contains a hyphen. "line" does not. Emphasis is allowed around it; position is not constrained.
const REVIEWER_RE = /Reviewer:\s*[*_`]*([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)/;

function verdicts(pr, head) {
  const raw = run("gh", ["pr", "view", String(pr), "--json", "comments"]);
  return JSON.parse(raw).comments
    .filter((c) => VERDICT_RE.test(c.body))
    .map((c) => {
      // WHICH COMMIT DOES THIS VERDICT NAME? Taking the FIRST hex token was wrong in three
      // measured ways on #471 alone:
      //   "Reviewed `6caeaa65` -> `3ee8e3fe`"        -> named 6caeaa65, meant 3ee8e3fe
      //   a quoted `git ls-tree` line                 -> named a BLOB, which is not a commit at all
      //   four verdicts citing an earlier SHA first   -> all four fell into STALE; coverage read 2 of 4
      // The first two invent coverage; the third destroys it. Same cause, opposite directions.
      //
      // So: take every candidate, keep the ones git says are real COMMITS, and prefer the one that
      // matches the head. An abbreviation is not a string -- it is a commit reference written
      // short, and only `rev-parse` can say what it points at.
      // READ THE DECLARED SUBJECT. Every positional rule fails on a verdict that pastes this
      // tool's own output -- and the requirement to paste it GUARANTEES every verdict now contains
      // other PRs' SHAs. 1101's #470 verdict declares `Reviewed commit `2dad0b91`` and then quotes
      // output naming f91fd25e (an #471 commit); "last resolvable SHA" took f91fd25e, called their
      // verdict STALE, and counted no coverage. My own requirement created the failure mode.
      //
      // The house format already states the subject, so this is not a heuristic -- it is reading
      // the declaration instead of guessing. Measured across #470/#471/#465/#461: every verdict
      // carries one of these two forms. Positional logic stays as the fallback for bodies that
      // carry neither, which is why nothing previously fixed is lost.
      //
      // `commit` IS NO LONGER OPTIONAL (2026-09-20), and that one word is the whole fix. It used to
      // be `Reviewed(?:\s+commit)?`, which made a bare "reviewed" a declaration marker -- so a
      // sentence as ordinary as
      //     I reviewed `32391b7b` in full. The head moved.
      // parsed as a declaration naming 32391b7b. `String.match` returns the FIRST match, so it
      // OVERRODE a correct `Reviewed commit` line further down the same body. And because the prose
      // SHA resolves, `declaredResolves` was true, `declaredBroken` false, `cands = [prose]` -- the
      // scan was never consulted, so NO notice on that path was reachable. It fails CONFIDENTLY.
      // Measured on #504, where it cost a lane its verdict; 43cd found it by running their own body
      // against the pattern after a re-post appeared to fix it for a different reason than assumed.
      //
      // THE FIRST FIX WAS ANCHORING TO LINE START, AND IT WAS WRONG -- rejected by measurement, and
      // the measurement is the reason to distrust the obvious repair here. Anchoring looked safe on
      // a 13-PR corpus (25 declarations, all at line start). On a WIDER corpus -- 16,601 lines from
      // 120 PRs -- it LOST 18 real declarations, because the second sanctioned form is routinely
      // written mid-line or under a markdown heading:
      //     **Reviewer: agent (non-author).** Reviewed commit `<sha>`      <- mid-line
      //     ## Verdict: APPROVE at `<sha>`                                  <- heading
      //     ## Re-verdict: **CHANGES REQUESTED** at `<sha>`
      // That is exactly the failure this file already records at :98-101, where anchoring REVIEWER_RE
      // dropped a real mid-line verdict. The lesson is not "anchor more carefully" -- it is that a
      // corpus which agrees with your fix is not evidence the fix is right, and the smaller corpus
      // agreed because it did not CONTAIN the forms that break it.
      //
      // WHY THIS FIX IS SAFE WHERE ANCHORING WAS NOT: it removes an OVER-match rather than adding a
      // POSITION requirement, so it can only ever reject text that says "reviewed" without saying
      // "reviewed commit". Measured on the same 16,601-line corpus: 16,597 identical, 4 changed --
      // ALL FOUR are prose (two of them a lane's report ABOUT this bug) -- ZERO real declarations
      // lost, and zero newly parsed. A lane writing any real spelling keeps its subject; only the
      // verb-in-a-sentence is refused.
      //
      // NOT `lastIndexOf` EITHER, which the verb classifier uses at :193 and which is the obvious
      // precedent: for the VERB a re-read verdict names what it resolves BEFORE its own line, so last
      // wins. For the DECLARATION both orders occur -- prose before a real line, and prose after one
      // -- and no positional rule fixes both: last-win corrects the first and breaks the second.
      const declared = c.body.match(/(?:Reviewed commit|Verdict:[^`]*?\bat)\s+`([0-9a-f]{7,40})`/i);
      // A single alternative again, but `declaredSha` below is kept: it is the one place that turns
      // a match into a SHA, so a future second alternative has an obvious home and callers do not
      // each need to know how many capture groups exist.
      const declaredSha = declared ? (declared[1] ?? declared[2]) : null;
      // The declaration is preferred, but it is HAND-TYPED and can be wrong: 1101's #465 verdict
      // declares `1e13e1d34` -- one character longer than the real `1e13e1d3`. Trusting it alone
      // turned a genuine verdict into "?" and would have blocked a correct merge. So an
      // unresolvable declaration falls back to scanning, and the fallback is REPORTED rather than
      // silent, because a declaration that does not resolve is itself worth seeing.
      //
      // AND THE OTHER HALF OF "REPORTED", which was missing until 2026-09-20: `declaredBroken`
      // covers a declaration that PARSED and did not resolve. It does NOT cover a declaration that
      // never parsed at all -- a preamble before the line, or the backticks placed around the whole
      // phrase instead of the SHA (`Reviewed commit <sha>` rather than `Reviewed commit <sha>`).
      // That case took the scan with NO notice, so a reviewer who wrote a declaration this regex
      // cannot read saw their own verdict reported STALE against a commit they never reviewed,
      // with nothing saying the tool had guessed. Two lanes lost a verdict that way in one night;
      // both concluded the tool had fabricated one. It had scanned, silently, exactly as the header
      // above says it may. `unparsed` names that case so it is never silent again.
      const scan = [...new Set(c.body.match(SHA_RE) ?? [])];
      const declaredResolves = Boolean(declaredSha) && tryRun("git", ["rev-parse", "--verify", "--quiet", `${declaredSha}^{commit}`]).ok;
      const declaredBroken = Boolean(declaredSha) && !declaredResolves;
      // No declaration parsed, but the body does carry SHAs -- so the scan below is a GUESS, not a read.
      const unparsed = !declaredSha && scan.length > 0;
      const cands = declaredResolves ? [declaredSha] : scan;
      const commits = [];
      for (const s of cands) {
        const r = tryRun("git", ["rev-parse", "--verify", "--quiet", `${s}^{commit}`]);
        if (r.ok && r.out) commits.push({ short: s, full: r.out.trim() });
      }
      const atHead = commits.find((x) => x.full === head);
      // Prefer the head; else the LAST resolvable commit, since a body that cites a predecessor
      // states it before its own SHA. `?` when nothing resolves -- an instrument saying "I cannot
      // tell which commit this names" is strictly better than one that silently picks, and it is
      // the case this whole comment exists because of.
      const chosen = atHead ?? commits[commits.length - 1] ?? null;
      const m = chosen ? [chosen.short] : null;
      const unresolvable = !chosen && cands.length > 0;
      // CLASSIFY FROM A VERDICT *LINE*, never from the verb appearing anywhere in the prose.
      //
      // Two orderings exist and a first-verb rule only gets one of them right:
      //   "APPROVE ... (mentions a prior CHANGES REQUESTED)"   -> first-verb says APPROVE   correct
      //   "...1051's CHANGES REQUESTED is what this addresses ... APPROVE"  -> says BLOCK   WRONG
      // The second is the NATURAL shape for any re-read verdict, because a verdict that says what
      // it resolves names the block first. Measured on #461: 1101's APPROVE (line 73) was read as
      // CHANGES REQUESTED because line 22 referenced the prior block.
      //
      // This matters more than a display nit: verdicts are required to PASTE this output, so the
      // kind column is load-bearing for merges whether or not a header says not to automate on it.
      // So: a verdict line is one that STARTS with the verb (allowing markdown emphasis and a
      // "## Verdict:" prefix). Prose mentions mid-sentence are ignored. Last such line wins, since
      // a body that states a verdict more than once is stating its conclusion last.
      // `No blocking correction` is matched HERE, as its own alternative, so the third house
      // spelling is classified deliberately rather than arriving at "not a blocker" by falling
      // through. It NORMALISES TO APPROVE -- `verdict-read.mjs` already does exactly this ("a
      // distinct SPELLING, not a third state"), and the blockers list below keys on the exact
      // string `CHANGES REQUESTED`, so a clearance can never be read as a block.
      // A VERDICT INSIDE A CODE FENCE IS NOT A VERDICT -- AND THE FIX IS FENCE-AWARENESS, NOT THE
      // PREFIX CLASS. (2026-09-20.)
      //
      // THE DEFECT, MEASURED, AND IT FAILS OPEN. A review is REQUIRED to paste this tool's own
      // output, and that output contains verdict words (`verdict  APPROVE by ... COVERS HEAD`). So
      // any review that quotes an example -- including one quoting the tool -- has that example
      // counted as a verdict line. The kind is taken as the LAST hit, so the QUOTED example
      // overrides the author's own conclusion. f052 posted CHANGES REQUESTED, quoted
      // `## Verdict: APPROVE at <sha>` in an evidence table, and the tool printed
      // `APPROVE ... COVERS HEAD` / `OK ... safe to merge`. Their correction was misread too.
      // **The more thoroughly they documented the block, the more firmly the tool cleared the PR.**
      //
      // THE FIRST DIAGNOSIS OF THIS WAS MINE AND IT WAS WRONG, recorded because the wrong version
      // is the plausible one. I believed the prefix `[#>\s]*` was the route -- `\s` matches
      // NEWLINES, so it would span from a `##` heading into a fence. Measured: it is NOT the route.
      // A quoted verdict line sits at column 0 on its own line, so the `m` anchor alone matches it
      // with or without the newline span. Narrowing the prefix to `[ \t]` is still a real
      // improvement (a prefix should not cross a line), and it is kept -- but it CLOSES NOTHING
      // HERE. I had a plausible mechanism and a definite symptom, and the two were not related.
      //
      // THE ACTUAL FIX: mask fenced regions before scanning, so quoted content is not read as the
      // author's own claim. Unclosed fences mask to the end, which is the fail-SAFE direction: a
      // body that opens a fence and never closes it loses its verdict to the scan fallback rather
      // than gaining a false clearance from quoted text.
      //
      // WHY LAST-WINS SURVIVES, ruled explicitly rather than chosen silently. A body that states
      // its conclusion twice ends with the conclusion -- the common case, and last-wins is right for
      // it. A body that QUOTES examples is the case that breaks, and the remedy belongs at the
      // quoting boundary rather than in the ordering rule. First-wins would instead break every
      // re-read verdict, which names the block it resolves BEFORE its own line -- trading one
      // confirmed defect for a larger one.
      const unfenced = c.body.replace(/^[ \t]*(```|~~~).*$[\s\S]*?^[ \t]*\1.*$/gim, "").replace(/^[ \t]*(```|~~~)[\s\S]*$/im, "");
      const verdictLine = /^[#>]*[ \t]*(?:\*{0,2}Verdict\*{0,2}\s*[:—-]\s*)?\*{0,2}(APPROVE|CHANGES REQUESTED|No blocking correction)\b/gim;
      const hits = [...unfenced.matchAll(verdictLine)].map((m) => (/no blocking correction/i.test(m[1]) ? "APPROVE" : m[1].toUpperCase()));
      // Fall back to presence only when no line-anchored verdict exists at all, and prefer the
      // LAST occurrence -- the conclusion -- rather than the first, which is usually the citation.
      // The fallback reads `unfenced` too: it is the last place quoted verdict words could leak in.
      // REFUSE RATHER THAN PICK WHEN THE BODY MIXES VOCABULARIES (ruled 2026-09-20).
      //
      // Two kinds in one body means one of two documents, and the tool cannot tell them apart:
      // a review that CHANGED ITS MIND (conclusion last, so "last wins" is right), or a review
      // that QUOTED an example (the quoted one may be either first or last). Every index rule
      // fails open on one of them -- measured: last-wins clears a block that quotes an approve;
      // FIRST-wins would have cleared 43cd's #504, whose real declaration sits below prose. So the
      // tool declines instead of guessing, and the caller resolves it by reading the comment.
      //
      // THE ASYMMETRY DECIDES IT: a refusal costs a reviewer one terse re-post; a wrong guess costs
      // a merge. A candidate that cannot be classified is not a verdict this tool should act on.
      //
      // WHY THIS IS RARE, and the measurement is the reason it is shippable rather than disruptive
      // (87 real comment bodies across 19 PRs): 50 classify to ONE kind and are untouched; only
      // ONE (1.1%) hits the refusal -- and it is a body that genuinely mixes vocabularies in prose,
      // which the fleet's one-vocabulary-per-comment convention already forbids. Fence-awareness is
      // why it is rare: 3 bodies mixed WITHOUT masking and it silences 2 of them. Without part 2
      // this refusal would fire on every review that quotes evidence, and the tool would be
      // useless; with it, the refusal only fires where a human should look anyway.
      const kindsSeen = [...new Set(hits)];
      const ambiguous = kindsSeen.length > 1;
      // WAS THIS KIND READ OR INFERRED? `hits.length === 0` means no line-anchored verdict existed and
      // the kind came from the presence-fallback below, which DEFAULTS to APPROVE. That default is the
      // mechanism by which an evidence comment -- which mentions verdict words and declares a commit --
      // classifies as an approval at all, and it is why one reviewer counted as two.
      //
      // MEASURED: 8 of 59 attributed comments (14%) take this path. Two of the eight contain BOTH
      // verdict words and default to APPROVE; both were read and both happen to be correct -- BY LUCK,
      // NOT BY RULE. A permissive default that is right twice is not a safe default, so the row says
      // which ones were inferred rather than presenting a guess and a reading identically.
      const inferred = hits.length === 0;
      const kind = hits.length
        ? hits[hits.length - 1]
        : (unfenced.lastIndexOf("CHANGES REQUESTED") > unfenced.lastIndexOf("APPROVE") ? "CHANGES REQUESTED" : "APPROVE");
      // Reported, never resolved. Same shape as the `[NO declaration parsed — SHA chosen by SCAN]`
      // notice: the tool names the ambiguity and leaves the judgement to the reader.
      const ambiguousKinds = ambiguous ? kindsSeen.join(" + ") : null;
      // NOTE: `author` is NOT the reviewer. Every fleet PR is posted through one shared gh
      // account, so this field reads the same for all of them and cannot attribute a verdict.
      // The only identity signal is a "Reviewer: <agent> (non-author)" line the reviewer writes
      // in the body — so that is what is extracted, and the gh login is deliberately ignored.
      const who = c.body.match(REVIEWER_RE)?.[1] ?? null;
      return { who, at: c.createdAt ?? "", sha: m ? m[0] : null, full: chosen ? chosen.full : null, kind, attributed: who !== null, unresolvable, declaredBroken, unparsed, ambiguousKinds, inferred };
    });
}

function report(pr) {
  const meta = JSON.parse(run("gh", ["pr", "view", String(pr), "--json", "headRefOid,headRefName,title,mergeable"]));
  const head = meta.headRefOid;
  run("git", ["fetch", "origin", meta.headRefName, "--quiet"]);
  run("git", ["fetch", "origin", "main", "--quiet"]);
  const main = run("git", ["rev-parse", "origin/main"]);

  const vs = verdicts(pr, head);
  const short = (s) => (s ? s.slice(0, 8) : "(none)");

  // MERGE-CLEANLINESS IS MEASURED AGAINST MAIN AS OF RIGHT NOW, not as of when anyone last looked.
  // A head-side green transfers to the merged tree only while main IS the merge base, so this
  // answer expires the moment main moves — which is exactly why it is computed per run.
  const mt = tryRun("git", ["merge-tree", "--write-tree", main, head]);
  const mergeState = mt.ok ? "CLEAN" : "CONFLICT";
  const conflictFiles = mt.ok ? [] : [...new Set((mt.out.match(/^\d+ [0-9a-f]+ [123]\t(.+)$/gm) ?? []).map((l) => l.split("\t")[1]))];

  // ONLY ATTRIBUTED COMMENTS COUNT AS VERDICTS. An unattributed one is listed, loudly, and never
  // contributes coverage -- see the REVIEWER_RE note: an author's own announcement mentioning the
  // word APPROVE was reported as covering the head, and "safe to merge" was printed under it.
  const real = vs.filter((v) => v.attributed);
  const unattributed = vs.filter((v) => !v.attributed);
  const covering = real.filter((v) => v.full && v.full === head);
  const stale = real.filter((v) => v.full && v.full !== head);

  console.log(`\n#${pr}  ${meta.title}`);
  console.log(`  head        ${short(head)}   main ${short(main)}`);
  console.log(`  merge       ${mergeState}${conflictFiles.length ? "  -> " + conflictFiles.join(", ") : ""}`);
  if (real.length === 0) console.log(`  verdicts    NONE`);
  const AMBIG = "  [CANNOT TELL which verdict governs — body mixes kinds; READ THE COMMENT, do not merge on this row]";
  // `[inferred]` marks a kind that was NOT declared: no line-anchored verdict was found and the
  // presence-fallback defaulted it. Rendered after the other notices so the reader sees WHAT was
  // concluded before being told how it was reached.
  const INFERRED = "  [inferred — no declared verdict line; kind defaulted from prose]";
  for (const v of covering) console.log(`  verdict     ${v.kind} by ${v.who} at ${short(v.sha)}  COVERS HEAD${v.declaredBroken ? "  [declared SHA did not resolve — recovered by scan]" : ""}${v.unparsed ? "  [NO declaration parsed — SHA chosen by SCAN, may be the wrong commit]" : ""}${v.ambiguousKinds ? AMBIG : ""}${v.inferred ? INFERRED : ""}`);
  for (const v of stale) console.log(`  verdict     ${v.kind} by ${v.who} at ${short(v.sha)}  STALE (head moved)${v.unparsed ? "  [NO declaration parsed — SHA chosen by SCAN, may be the wrong commit]" : ""}${v.ambiguousKinds ? AMBIG : ""}`);
  for (const v of real.filter((x) => x.unresolvable)) console.log(`  verdict     ${v.kind} by ${v.who} names NO RESOLVABLE COMMIT (?) — cannot tell which commit this verdict covers`);
  for (const v of unattributed) console.log(`  (not a verdict) comment at ${short(v.sha)} mentions a verdict verb but carries no "Reviewer:" line — NOT counted`);

  // The verdict is the ACTION-GUIDING line, so it names what to do, not just what is true.
  const problems = [];
  if (mergeState === "CONFLICT") problems.push("conflicts with main — resolve BEFORE any verdict; a verdict here describes a tree that cannot exist post-merge");
  if (covering.length === 0 && real.length > 0) problems.push("every verdict is stale — the head moved under the reviewer");
  // THE REWORK ADVISORY IS NOT A PROBLEM, AND IT WAS COMPUTED FROM A NUMBER THAT WAS NEVER A COUNT
  // OF REVIEWERS. (Ruled 2026-09-21 after the defect was measured on #505.)
  //
  // This line used to read `${covering.length} verdicts already cover this head — a further read is
  // rework, not verification`. `covering.length` counts COMMENTS, and the house protocol INSTRUCTS a
  // reviewer to post the verdict terse and the evidence separately -- so every correctly-posted review
  // inflates this to two. MEASURED on #505: f052's two comments, 18 seconds apart, produced
  // "2 verdicts already cover this head" from ONE reviewer.
  //
  // WHY THAT IS WORSE THAN AN OFF-BY-ONE: the sentence tells a genuine second reader to STAND DOWN
  // when one lane has read. It is a rework advisory computed from a number that cannot support it --
  // and on #505 the reader it misled was the MERGER, who held a clean, approved PR because this
  // advisory said it did not need a read. The tool's own bug made its own fix look blocked.
  //
  // THE FIX is a DEDUPED IDENTITY LIST, not a corrected count. A count answers "how many comments",
  // which is not the question a router asks; the question is "has anyone read this, and who?". A LIST
  // of distinct identities answers it, and -- the part that decided it -- a list is SAFE where a
  // deduped count is not: every comment still prints as its own row, so a reviewer who CHANGED their
  // verdict is visible as two rows under one name, while the list shows that name once.
  //
  // MEASURED BEFORE CHOOSING, because both obvious alternatives are harmful:
  //   - deduping the COUNT would have hidden FOUR real verdict changes in 59 attributed comments:
  //     #496 6da7, #505 43cd, #505 f052 (CHANGES REQUESTED -> APPROVE -- the block that governed the
  //     PR this was found on), #455 1051.
  //   - requiring a line-anchored verdict before counting would have dropped EIGHT more, and reading
  //     all eight showed several are GENUINE verdicts written as prose (`## APPROVE — #504 at \`<sha>\``,
  //     where the interpolated PR number sits between the word and the SHA). Trading a wrong count for
  //     a MISSING VERDICT is strictly the worse direction.
  // So: no rule picks a verdict, and nothing is deduped out of the row list.
  //
  // It is deliberately NOT a `problems` entry any more. A rework advisory is INFORMATION -- it never
  // gated a merge and it should not; a second read of a cleared head is cheap, and the one thing this
  // line must never do is talk a reader out of looking.
  const coveringReviewers = [...new Set(covering.map((v) => v.who).filter(Boolean))];
  // A COVERING VERDICT'S KIND DECIDES, and this file was blind to it. Every check above compares
  // SHA coverage; none looked at WHAT the covering verdict says. So one `CHANGES REQUESTED`
  // covering the head produced exactly the sentence and exactly `exit 0` as one APPROVE -- the tool
  // could not tell "cleared" from "blocked", and a caller scripting on the exit code got a green
  // light over a live block. Measured on the extracted rule: the two rows are byte-identical.
  //
  // WHY A BLOCK IS A PROBLEM AND NOT ITS OWN STATE. `exit 0` means "go ahead" -- that is what the
  // two lines below print and what gate-state.mjs uses (`exit 0` when a tool passes). A live block
  // is the opposite of go-ahead, so it belongs on the same list as a conflict: something the
  // caller must resolve BEFORE merging. Two consequences fall out of that choice:
  //   * a block and a conflict now behave identically, which is right -- both mean "do not merge
  //     yet", and neither is resumable by re-running the tool;
  //   * a block does NOT suppress the coverage count, so the tool still reports how many others
  //     have read the head. Losing that would hide a head that is blocked AND already over-read.
  //
  // `No blocking correction` is the third house verdict and it is CLEAR, not a block: only the
  // exact `CHANGES REQUESTED` string counts, so a verdict saying "no blocking correction" is
  // treated as the clearance it is.
  const blockers = covering.filter((v) => v.kind === "CHANGES REQUESTED");
  for (const b of blockers) problems.push(`BLOCKED by ${b.who} at ${short(b.sha)} — a covering CHANGES REQUESTED; do NOT merge until that author lifts it`);
  // AN AMBIGUOUS COVERING VERDICT IS ITSELF A PROBLEM, and it must reach the EXIT CODE, not only the
  // row text. The row's `kind` is a guess the tool just refused to stand behind; letting that guess
  // decide whether `problems` stays empty would put the guess back in charge of the merge — which is
  // the one thing this refusal exists to prevent. So a covering verdict whose body mixes kinds
  // always returns false, whether or not its last hit happened to read APPROVE.
  for (const a of covering.filter((v) => v.ambiguousKinds)) problems.push(`CANNOT TELL whether ${a.who}'s covering verdict at ${short(a.sha)} is a clearance or a block — its body mixes kinds (${a.ambiguousKinds}); read the comment before merging`);
  for (const p of problems) console.log(`  ! ${p}`);
  // THE `OK` LINES KEY ON REVIEWERS, NOT COMMENTS. `covering.length` is a COMMENT count, and the
  // protocol produces two comments per reviewer (verdict + evidence), so a head with one approving
  // reviewer can read `covering.length === 2` -- and the `=== 1` branch below then does not fire,
  // leaving NO `OK` line at all for a genuinely cleared head. The reader sees the rows, no verdict
  // sentence, and has to decide for themselves. `coveringReviewers` is the same set the advisory
  // above lists, so the two now agree by construction rather than by coincidence.
  //
  // NOTHING ELSE MOVES: `covering.length` still drives the coverage checks (`=== 0` for the
  // every-verdict-stale case), because those are about how many COMMENTS were found and are correct
  // as comment counts. Only the two sentences that speak about READERS were changed to count readers.
  if (problems.length === 0 && coveringReviewers.length === 1) console.log(`  OK  cleared by ${coveringReviewers[0]}, merges clean — safe to merge at ${short(head)}`);
  if (problems.length === 0 && covering.length === 0) console.log(`  OK  merges clean, no verdict yet — safe to REVIEW`);
  // SAID ONCE, ABOVE THE ROWS IT DESCRIBES. The question a router asks is "has anyone read this, and
  // who?" -- so the answer is a deduped list of identities, not a count of comments. Printed whenever
  // anything covers the head, including the single-reviewer case, because that is the case the old
  // advisory never spoke about at all.
  if (coveringReviewers.length) {
    const inferredCount = covering.filter((v) => v.inferred).length;
    console.log(`  read by     ${coveringReviewers.join(", ")}${covering.length > coveringReviewers.length ? `  (${covering.length} comments)` : ""}${inferredCount ? `  — ${inferredCount} of them INFERRED, see [inferred] rows` : ""}`);
  }

  // The exit status is the MACHINE-READABLE claim, and a caller cannot see the prose. It must
  // therefore agree with the prose in both directions: a covering block returns false, so the
  // process exits non-zero and a script gating on it stops rather than merging over a block.
  return problems.length === 0;
}

// A QUEUE OF INDIVIDUALLY-CLEAN PRs CAN STILL COLLIDE, and checking each against main can never say
// so. MEASURED 2026-09-20: #456 and #465 each reported CLEAN against main and conflicted with EACH
// OTHER in cli/lib/device.mjs -- in BOTH orders, so a real semantic collision, not an ordering
// artefact. It surfaced only because a merge preview was built by hand. The per-PR answer was true
// and useless, which is the failure mode this whole file exists to prevent, committed by this file.
function queueCheck(prs) {
  if (prs.length < 2) return true;
  const refOf = (pr) => `origin/${JSON.parse(run("gh", ["pr", "view", String(pr), "--json", "headRefName"])).headRefName}`;
  // Accumulate onto the PREVIOUS result, because that is what landing them in sequence does.
  // `merge-tree --write-tree` emits a TREE oid, and merge-tree's inputs must be COMMITs -- feeding
  // the tree straight back reports "not something we can merge" and the catch-all then renders it
  // as a CONFLICT. That is a false positive on every pair, and a control pair (#461 + #465, which
  // touch different files) is what exposed it. So each step is wrapped back into a commit.
  let acc = run("git", ["rev-parse", "origin/main"]);
  const landed = [];
  for (const pr of prs) {
    const ref = refOf(pr);
    const mt = tryRun("git", ["merge-tree", "--write-tree", acc, ref]);
    if (!mt.ok) {
      const files = [...new Set((mt.out.match(/^\d+ [0-9a-f]+ [123]\t(.+)$/gm) ?? []).map((l) => l.split("\t")[1]))];
      console.log(`  QUEUE CONFLICT: #${pr} does not apply on top of ${landed.length ? "#" + landed.join(" + #") : "main"}`);
      console.log(`                  ${files.join(", ") || "(run git merge-tree for detail)"}`);
      console.log(`                  -> land the others first, then merge main into #${pr} and resolve`);
      return false;
    }
    const tree = mt.out.split("\n")[0].trim();
    // Wrap the merged tree in a commit so the next iteration has a mergeable input. Parents are
    // the two sides, so the synthetic commit has the right history for the following merge-base.
    acc = run("git", ["commit-tree", tree, "-p", acc, "-p", run("git", ["rev-parse", ref]), "-m", "queue-preview"]);
    landed.push(pr);
  }
  console.log(`  QUEUE OK: #${prs.join(" -> #")} land cleanly in this order`);
  return true;
}

// The format warning is PRINTED, not just commented. 1051 required this and was right: a verdict
// author runs `--help`; they do not read the parser. A warning only a maintainer can see does not
// prevent the failure it describes -- and this failure is silent, so the author gets no other signal.
const USAGE = [
  "usage: node scripts/dev/pr-state.mjs <pr> [<pr> ...]",
  "",
  "THE VERDICT FORMAT IS LOAD-BEARING. READ THIS BEFORE YOU WRITE A VERDICT.",
  "",
  "  A verdict's SUBJECT is read from the line where the verdict DECLARES it:",
  "",
  "      Reviewed commit `<sha>`        (or)   Verdict: ... at `<sha>`",
  "",
  "  A verdict that opens with a preamble and never declares its commit in one of those forms",
  "  falls back to SCANNING the body for SHAs. Every verdict is required to paste this tool's",
  "  output, so a body reliably contains OTHER PRs' SHAs -- the scan can pick the wrong one and",
  "  report your verdict as STALE, or as covering nothing.",
  "",
  "  IT FAILS QUIETLY. You see a verdict you posted reported stale or absent, with no error. If",
  "  that ever surprises you, check your declaration line first. Write the declaration.",
].join(String.fromCharCode(10));

const argv = process.argv.slice(2);
const prs = argv.filter((a) => /^\d+$/.test(a));
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (prs.length === 0) {
  console.error(USAGE);
  process.exit(2);
}
let allOk = true;
for (const pr of prs) { try { allOk = report(pr) && allOk; } catch (e) { console.log(`\n#${pr}  ERROR: ${e.message}`); allOk = false; } }
if (prs.length > 1) {
  console.log(`\nQUEUE, in the order given:`);
  try { allOk = queueCheck(prs) && allOk; } catch (e) { console.log(`  ERROR: ${e.message}`); allOk = false; }
}
console.log("");
process.exit(allOk ? 0 : 1);
