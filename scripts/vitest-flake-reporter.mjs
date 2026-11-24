/**
 * A vitest reporter that makes an unexplained failure characterisable on FIRST sight.
 *
 * WHY THIS EXISTS
 * ---------------
 * This repo's merge gate is the LOCAL suite, so a green
 * local run is the only signal there is. A flake under full-suite load is therefore worse
 * here than in a repo with CI, because a flaky gate makes every future green run suspect.
 *
 * That already cost us once. A run reported `1 failed | 121 passed` and the failure never
 * reproduced across five subsequent runs. The name was lost permanently because the
 * failing run was the FIRST one, before output was being redirected to a file — only the
 * summary shape survived. A bare test name would not have been enough either: the useful
 * question is not only WHICH test failed but WHY NOW.
 *
 * WHAT IT RECORDS, on failure only
 * --------------------------------
 *   - the failing test's FULL NAME (suite > test) and its file
 *   - that test's OWN duration, against the median of its file's passing tests
 *   - the file's total duration and the run's total duration
 *   - the slowest tests in the run, so contention is visible directly
 *
 * WHY DURATIONS
 * -------------
 * They discriminate between the likely causes in ONE capture:
 *   - failing test is a duration OUTLIER among its neighbours -> a timing assumption
 *   - its duration is normal but the run was slow            -> resource contention
 *   - both normal                                            -> neither; worth a real look
 *
 * THREE OUTCOMES FROM ONE CAPTURE, INSTEAD OF ANOTHER ANECDOTE.
 *
 * HOW TO USE IT
 * -------------
 * Registered in vitest.config.ts, so every `npm test` emits it on failure and nothing on
 * success. To silence it for one run: `npx vitest run --reporter=default`.
 *
 * NOTE ON THE VITEST 4 API, learned the hard way: `onFinished` is NEVER CALLED in vitest 4
 * (it is `onTestRunEnd`), and the task tree is not reliably populated at run end. An
 * earlier version of this file used `onFinished` and produced NO OUTPUT AT ALL while
 * looking correct — a reporter that fails quietly is worse than no reporter, because its
 * silence reads as "no flake". It was caught only by running it against a deliberately
 * failing test. Do the same to any change here.
 *
 * Written by DeepSeek-D2V6 (reviewer). Shape agreed with DeepSeek-KCHU, whose three runs
 * measured a 1.27x spread in total run duration on the SAME commit and machine — the
 * evidence that wall-clock jitter here is large enough to matter.
 */

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const ms = (n) => `${Math.round(Number(n) || 0)}ms`;

export default class FlakeReporter {
  onInit() {
    this.runStart = Date.now();
    /** @type {{file: string, name: string, duration: number, state: string}[]} */
    this.tests = [];
  }

  /** The only hook in vitest 4 that fires per completed test with usable data. */
  onTestCaseResult(testCase) {
    const t = testCase?.task ?? testCase;
    if (!t?.name) return;
    const file = t.file?.name ?? t.file?.filepath ?? "(unknown file)";
    // The suite path, built from the parent chain, gives a readable full name.
    const parts = [];
    for (let p = t.parent; p?.name; p = p.parent) parts.unshift(p.name);
    this.tests.push({
      file,
      name: [...parts, t.name].join(" > "),
      duration: Number(t.result?.duration ?? 0),
      state: String(t.result?.state ?? "unknown"),
    });
  }

  onTestRunEnd() {
    const runDuration = Date.now() - this.runStart;
    const all = this.tests;
    const failures = all.filter((t) => t.state === "fail" || t.state === "failed");

    // Silent on success: this is a failure instrument, not a progress bar.
    if (!failures.length) return;

    const lines = [];
    lines.push("");
    lines.push("=".repeat(78));
    lines.push("FLAKE CAPTURE — a failure was recorded with its timing context");
    lines.push("=".repeat(78));
    const files = new Set(all.map((t) => t.file));
    lines.push(`run duration : ${ms(runDuration)} across ${files.size} file(s), ${all.length} test(s)`);

    const slowest = [...all].sort((a, b) => b.duration - a.duration).slice(0, 5);
    lines.push("");
    lines.push("slowest tests in this run (contention shows up here first):");
    for (const t of slowest) lines.push(`  ${ms(t.duration).padStart(8)}  ${t.name}`);

    for (const f of failures) {
      const passing = all.filter((t) => t.file === f.file && t.state !== "fail" && t.state !== "failed");
      const med = median(passing.map((t) => t.duration));
      const fileTotal = all.filter((t) => t.file === f.file).reduce((a, t) => a + t.duration, 0);
      const ratio = med > 0 ? f.duration / med : 0;

      lines.push("");
      lines.push("-".repeat(78));
      lines.push(`FAILED: ${f.name}`);
      lines.push(`  file            : ${f.file}`);
      lines.push(`  state           : ${f.state}`);
      lines.push(`  THIS TEST took  : ${ms(f.duration)}`);
      lines.push(`  file median     : ${ms(med)}  (median of ${passing.length} passing test(s) in the same file)`);
      lines.push(`  ratio to median : ${ratio ? `${ratio.toFixed(2)}x` : "n/a (no passing siblings)"}`);
      lines.push(`  file total      : ${ms(fileTotal)}`);
      const reading =
        ratio >= 2
          ? "DURATION OUTLIER within its file -> if this test REPRODUCES, the duration is incidental and the assertion is the real failure; if it does NOT reproduce, suspect a TIMING ASSUMPTION"
          : ratio > 0
            ? "test duration NORMAL -> if the whole run was slow, suspect CONTENTION; if not, NEITHER"
            : "inconclusive (no passing siblings to compare against)";
      lines.push(`  reading         : ${reading}`);
      // A capture is NOT a verdict. This fires on every failure, including a plain assertion
      // failure that will reproduce every time - observed in practice when a deliberately
      // broken assertion was captured with a 3.26x ratio and read as a timing problem. The
      // ratio only becomes evidence about FLAKINESS once the same test is seen to pass
      // elsewhere; on its own it says nothing about reproducibility.
      lines.push("  NOTE            : a capture is not a verdict - re-run before concluding anything.");
      lines.push("                    The ratio is only evidence of flakiness if this test PASSES on a re-run.");
    }
    lines.push("=".repeat(78));
    lines.push("Compare against the next occurrence: same test + same reading = a real pattern.");
    lines.push("");

    // stderr, so it survives any stdout capture and never pollutes another reporter.
    for (const line of lines) process.stderr.write(`${line}\n`);
  }
}