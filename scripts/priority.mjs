/** Classify OpenCadre inbound mail for interrupt vs async handling. */

export function classifyPriority(entry) {
  const body = entry.body ?? entry.summary ?? "";
  const phase = entry.phase ?? "";
  const kind = entry.kind ?? "message";

  // Explicit markers only — do not match "priority=high" mentioned in prose
  if (/^\[priority\s*=\s*high\]/im.test(body) || /^priority\s*=\s*high\b/im.test(body)) return "high";
  if (/^\[HIGH\]/im.test(body)) return "high";
  if (kind === "step_update" && (phase === "blocker" || phase === "block")) return "high";
  if (kind === "question") return "high";
  if (/task assignment|operator directive|must acknowledge|acknowledge receipt/i.test(body)) return "high";
  if (/stop|do not push|policy change/i.test(body)) return "high";

  if (kind === "step_update") return "medium";
  if (/\[\d+\/10\]/i.test(body) || /\(\d+\s+of\s+10\)/i.test(body)) return "medium";

  return "low";
}

/** Zero-latency mode: every message interrupts immediately (operator directive). */
export function zeroLatencyEnabled() {
  return process.env.OPENCADRE_ZERO_LATENCY !== "0";
}

export function isInterrupt(priority) {
  if (zeroLatencyEnabled()) return true;
  return priority === "high";
}
