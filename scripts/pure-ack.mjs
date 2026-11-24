#!/usr/bin/env node
/**
 * Pure acknowledgment detection (VISION.md 59bec59).
 * Structural only — no reply text generation.
 */
export function isPureAck(body) {
  const t = (body ?? "").trim();
  if (!t || t.length > 400) return false;
  if (/\?/.test(t)) return false;
  if (/\b(please|must|stop|rebase|commit hash|git status|do not|policy|fix|confirm|task assignment|guidance)\b/i.test(t)) {
    return false;
  }
  // A leading ack phrase, not a full-string match: real agents (LLMs) almost never send a bare
  // "Ack." -- they write "Acknowledged, closing out, no reply needed" or similar. Requiring the
  // whole message to reduce to one word meant this never matched real traffic, so the hub's own
  // "don't wake/block for pure acks" design was silently defeated for exactly the case it exists
  // for. Still reject anything containing a real question or an actionable keyword above.
  return (
    /^(confirmed|thanks|thank you|got it|ack|acknowledged|roger|copy|understood)\b/i.test(t) ||
    /^confirmed, got both:/i.test(t) ||
    /round-trip works\.?\s*thanks\.?$/i.test(t)
  );
}
