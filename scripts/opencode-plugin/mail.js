// OpenCadre mail for OpenCode: what to do with one hub answer. Pure (no network, no clock, no session), so every
// branch is testable. index.js owns the loop that calls the hub and wakes the chat.
//
// The wake itself is OpenCode's documented one: `ctx.session.synthetic({ sessionID, text })` "durably admits
// synthetic session input and schedules execution unless resume is false" (opencode.ai/v2/docs/api, operation
// session.synthetic, fetched 2026-09-23). So the plugin needs no idle detection: it waits on the hub for this chat's
// unread mail (peek, never consuming it) and admits one notice when some arrives; OpenCode runs it when it can.

/** The notice the chat receives: the same words the Claude Code and Codex watchers use, so an agent reads one
 * instruction everywhere. It names no message content: the chat reads its mail through its own tools. */
export const wakeText = (count) =>
  `You have ${count} unread OpenCadre message(s). Use "get_messages" to read them and answer each on its thread.`

/**
 * One step of the wait loop, from the hub's answer to `GET /v1/messages/wait?peek=true`.
 *
 *   wake     new unread mail: admit one notice, and wait after the newest id so it is not announced twice
 *   wait     nothing new within the long-poll: ask again
 *   backoff  this chat has no OpenCadre session yet (401 before any 200: it has not called an OpenCadre tool), or the hub was
 *            unreachable or said something unexpected: try again later, quietly
 *   ended    also after NO_SESSION_TRIES no-session answers in a row: most OpenCode chats never use OpenCadre and so can
 *            never have its mail, and waiting on them for the service's lifetime would hold a claim and a poll each
 *            (Codex-OpenCadre-8160, #585). The chat's next event claims it again, so one that starts using OpenCadre
 *            later is picked up then.
 *   ended    401 AFTER the hub had answered for this chat: its session was ended (idle past the hub's session TTL, or
 *            removed), so the watch ends and releases its claim; the chat's next event claims it again. Without this an
 *            abandoned chat would be polled for the life of OpenCode's service (Codex-OpenCadre-8160, #585).
 *   stop     the project is not enabled here (403), or the workspace is read-only on a lapsed bill (402): stay out
 *            of the way for the life of this chat. A lapsed bill never blocks or scolds (scripts/opencadre-config.mjs
 *            isBillingReadOnly: a convenience must not break the tool it lives in).
 */
export const NO_SESSION_TRIES = 3

export function nextStep({ status, body, known = false, misses = 0 }) {
  if (status === 200) {
    const messages = Array.isArray(body?.messages) ? body.messages : []
    if (messages.length === 0) return { action: "wait" }
    return { action: "wake", count: messages.length, afterId: String(messages[messages.length - 1].id) }
  }
  if (status === 402 || status === 403) return { action: "stop" }
  if (status === 401 && (known || misses + 1 >= NO_SESSION_TRIES)) return { action: "ended" }
  return { action: "backoff" }
}

/** The session id an OpenCode event carries, or null: the documented `{properties:{sessionID}}` and the measured
 * `{data:{sessionID}}` shapes (HARNESS-OPENCODE.md §3.3). */
export function sessionIdOf(event) {
  const id = event?.properties?.sessionID ?? event?.data?.sessionID
  return typeof id === "string" && id.startsWith("ses") ? id : null
}
