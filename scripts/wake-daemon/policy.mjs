// Wake policy (docs/design/UNIVERSAL_WAKE.md, section 3, "Policy" guard).
// Zero dependencies beyond the existing priority/pure-ack classifiers, so the daemon's
// notion of "worth waking for" never drifts from the Stop-hook/wake-script notion.
//
//   wakeEligible(message, session, opts) -> boolean
//   filterEligible(messages, session, opts) -> array of eligible messages, in order
//   buildDigest(messages) -> WakeDigest { ids, top, line } (docs section 3)

import { classifyPriority } from "../priority.mjs";
import { isPureAck } from "../pure-ack.mjs";

const PREVIEW_CHARS = 120;

function priorityOf(message) {
  return message.priority ?? classifyPriority(message);
}

/** wakeMedium defaults from OPENCADRE_WAKE_MEDIUM so callers don't have to repeat the env read. */
function wakeMediumEnabled(opts) {
  if (opts && typeof opts.wakeMedium === "boolean") return opts.wakeMedium;
  return process.env.OPENCADRE_WAKE_MEDIUM === "1";
}

// A message that still expects a reply is never a "pure ack" for wake purposes, even if its
// body structurally reads like one (mirrors scripts/opencadre-wake.mjs's `wakes` predicate).
function isPureAckMessage(message) {
  if (message.awaiting_reply) return false;
  return isPureAck(message.body);
}

/** Never wakes for: low priority, medium priority unless opted in, a pure ack, the session's
 * own sends, or a message this session has already been woken for (caller's job via a cursor —
 * see scripts/opencadre-wake.mjs's afterId pattern; this function only judges one message). */
export function wakeEligible(message, session = {}, opts = {}) {
  if (!message) return false;
  const priority = priorityOf(message);
  if (priority === "high") {
    // fall through
  } else if (priority === "medium") {
    if (!wakeMediumEnabled(opts)) return false;
  } else {
    return false; // low, or any unrecognised priority: never wake
  }
  if (session.agentId && message.from_agent_id && message.from_agent_id === session.agentId) return false;
  if (isPureAckMessage(message)) return false;
  return true;
}

export function filterEligible(messages, session = {}, opts = {}) {
  return (messages ?? []).filter((m) => wakeEligible(m, session, opts));
}

const preview = (s) => (s ?? "").length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : (s ?? "");

/** At most one line; never message bodies verbatim in UI-injected text (section 3). */
export function buildDigest(messages) {
  const ids = messages.map((m) => m.id);
  const top = messages.some((m) => priorityOf(m) === "high") ? "high" : "medium";
  const line = messages.length === 1
    ? `[${priorityOf(messages[0])}] from ${messages[0].from_agent_name}: ${preview(messages[0].body).replace(/\s+/g, " ")}`
    : `${messages.length} new message(s) from OpenCadre, top priority ${top}`;
  return { ids, top, line };
}
