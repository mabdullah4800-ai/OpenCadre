// The verdicts claude-desktop-emu.ts reaches, as pure functions so each can be falsified without a vendor run
// (tests/claude-desktop-emu-verdicts.test.ts). Review 049a on #671: an instrument must not certify a run whose
// prerequisites were not met. So a baseline that did not complete, an extra turn before the mail, or a control process
// that died are INCONCLUSIVE, never PASS: a dead control is silent for the same reason a healthy one is.

/** What the script observed of one emulated session. */
export type Probe = {
  /** `result` events seen on stdout so far (one per completed turn). */
  results: number;
  /** Whether the FIRST result was a success (subtype "success", not is_error); null before any result. */
  firstResultOk: boolean | null;
  /** The child's exit code once it has exited, else null; `exited` distinguishes a signal exit (code null). */
  exitCode: number | null;
  exited: boolean;
};

export type Verdict = { status: "PASS" | "FAIL" | "INCONCLUSIVE"; detail: string };

const alive = (p: Probe) => !p.exited;
const died = (label: string, p: Probe) => `${label} exited (code ${p.exitCode ?? "signal"})`;

/** The baseline: every session finished exactly its first turn, successfully, and is still running. `completed` is
 * whether the wait for it returned true before its timeout. */
export function baselineVerdict(completed: boolean, sessions: Record<string, Probe>): Verdict {
  const problems: string[] = [];
  if (!completed) problems.push("the baseline wait timed out");
  for (const [label, p] of Object.entries(sessions)) {
    if (!alive(p)) problems.push(died(label, p));
    if (p.results < 1) problems.push(`${label} never finished its first turn`);
    else if (p.results > 1) problems.push(`${label} ran ${p.results} turns where one was typed`);
    if (p.results >= 1 && p.firstResultOk !== true) problems.push(`${label}'s first turn did not succeed`);
  }
  return problems.length
    ? { status: "INCONCLUSIVE", detail: `baseline not met: ${problems.join("; ")}` }
    : { status: "PASS", detail: `all ${Object.keys(sessions).length} sessions finished one successful turn and are running` };
}

/** Just before the mail: the idle sessions ran no turn since the baseline and are both still running. Otherwise a
 * later "wake" could be a turn that was already under way, and the idle interval would not be what it says. */
export function preMailVerdict(sessions: Record<string, Probe>): Verdict {
  const problems: string[] = [];
  for (const [label, p] of Object.entries(sessions)) {
    if (!alive(p)) problems.push(died(label, p));
    if (p.results !== 1) problems.push(`${label} has ${p.results} results, not 1, before the mail`);
  }
  return problems.length
    ? { status: "INCONCLUSIVE", detail: `not idle when mailed: ${problems.join("; ")}` }
    : { status: "PASS", detail: "both sessions idle after exactly one turn, and running" };
}

/** The wake leg: A started a turn by itself after the mail, replied with the nonce, nothing was typed. */
export function wakeVerdict(a: Probe, input: { resultsAtMail: number; replied: boolean; typedSinceMail: number; seconds: string | null; windowSeconds: number; idleSeconds: number; nonce: string }): Verdict {
  if (input.typedSinceMail !== 0) return { status: "INCONCLUSIVE", detail: `${input.typedSinceMail} message(s) were typed into A after the mail` };
  const woke = a.results > input.resultsAtMail;
  if (woke && input.replied) {
    return { status: "PASS", detail: `idle ${input.idleSeconds} s after its completed turn, then mailed: A woke by itself after ${input.seconds} s and replied PONG-${input.nonce} on its thread; nothing was typed into it` };
  }
  if (!alive(a) && !woke) return { status: "INCONCLUSIVE", detail: `${died("A", a)} before waking, so its silence says nothing about the watcher` };
  return { status: "FAIL", detail: woke ? "A started a turn after the mail but no PONG reply from A arrived on its thread" : `A did not wake within ${input.windowSeconds} s of the mail` };
}

/** The control: C (no asyncRewake handler) must stay idle AND stay alive through the whole observation window. A
 * control that exited is inconclusive: its silence is indistinguishable from a healthy one's. */
export function controlVerdict(c: Probe, input: { resultsAtMail: number; replied: boolean; windowSeconds: number }): Verdict {
  if (c.results > input.resultsAtMail || input.replied) {
    return { status: "FAIL", detail: "the CONTROL session (no asyncRewake handler) woke or replied, so something other than the watcher wakes sessions" };
  }
  if (!alive(c)) return { status: "INCONCLUSIVE", detail: `${died("the control", c)} during the observation window, so its silence proves nothing` };
  return { status: "PASS", detail: `the control session (identical but for the asyncRewake handler) stayed idle and running for ${input.windowSeconds} s after the same mail` };
}

/** The run's verdict: PASS only when every expected leg ran AND passed. A run stopped early has fewer legs, and missing
 * legs make it INCONCLUSIVE (or FAIL, if any leg failed), never PASS. Exit codes: 0 PASS, 1 FAIL, 2 INCONCLUSIVE. */
export function overallVerdict(legs: readonly string[], results: ReadonlyArray<{ leg: string; status: Verdict["status"] }>) {
  const passed = legs.filter((leg) => results.some((r) => r.leg === leg && r.status === "PASS"));
  const verdict: Verdict["status"] = passed.length === legs.length ? "PASS" : results.some((r) => r.status === "FAIL") ? "FAIL" : "INCONCLUSIVE";
  return { verdict, passed: passed.length, exitCode: verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2 };
}
