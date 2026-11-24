// Pure logic for the OpenCadre awareness plugin for OpenCode v2.
//
// Separate from index.js so the logic is importable by a test without an OpenCode process,
// a session or a token. (The entry no longer imports `@opencode/plugin`: that package is not
// installed in an ordinary project, and importing it made the whole plugin fail to load. See
// the README and docs/design/HARNESS-OPENCODE.md §3.1.)

/** Events that mean "the turn is over". `session.idle` is the documented one; it is
 *  deprecated in favour of `session.status` and, measured on 2.0.10 under `opencode run`,
 *  the process can exit before it is emitted, so the execution.* events are handled too. */
export const TERMINAL_EVENTS = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
])

/** The session id an event carries, or null. Handles both the documented
 *  `{properties:{sessionID}}` shape and the measured `{data:{sessionID}}` shape. */
export function sessionIdOf(event) {
  const id = event?.properties?.sessionID ?? event?.data?.sessionID
  return typeof id === "string" && id ? id : null
}

/** True when the hub refused a WRITE because the workspace's billing lapsed.
 *  Mirrors scripts/opencadre-config.mjs isBillingReadOnly: 402, code TRIAL_EXPIRED or absent. */
export function isBillingReadOnly(status, body) {
  return status === 402 && (body?.code === undefined || body?.code === "TRIAL_EXPIRED")
}

/**
 * The text handed to the model. Kept small: previews only, because the agent reads
 * full bodies through the MCP tools and repeating them here costs tokens twice.
 */
export function formatDigest(body, { maxItems = 5, previewChars = 120 } = {}) {
  const items = Array.isArray(body?.items) ? body.items : []
  const lines = []
  for (const item of items.slice(0, maxItems)) {
    const itemBody = typeof item?.body === "string" ? item.body : ""
    const preview = itemBody.length > previewChars ? `${itemBody.slice(0, previewChars)}…` : itemBody
    lines.push(`- [${item?.priority ?? "?"}] from ${item?.from_agent_name ?? "unknown"}: ${preview.replace(/\s+/g, " ")}`)
  }
  if (items.length > maxItems) lines.push(`…and ${items.length - maxItems} more`)
  const header = "OpenCadre has mail for this chat. Read it with get_messages, answer each on its thread:"
  return lines.length > 0 ? `${header}\n${lines.join("\n")}` : header
}

/**
 * What to do with a hub answer. Pure: no network, no clock, no session.
 *
 * Returns `{ deliver: true, text }` when the digest has something to say, and
 * `{ deliver: false, reason }` otherwise. Every failure path is a no-op.
 */
export function decide(response) {
  if (!response || typeof response !== "object") return { deliver: false, reason: "no-response" }
  const { status, body, networkError } = response
  if (networkError) return { deliver: false, reason: "unreachable" }
  if (isBillingReadOnly(status, body)) return { deliver: false, reason: "billing-read-only" }
  // 401 = no hub session for this chat yet; 403 = this project is not enabled.
  // Neither is an error the user should see, and neither can be fixed from here.
  if (status === 401) return { deliver: false, reason: "no-session" }
  if (status === 403) return { deliver: false, reason: "project-not-enabled" }
  if (status !== 200) return { deliver: false, reason: `http-${status}` }
  // GATE AND DELIVER THE SAME FIELD. `body.text` is the hub's own fully-rendered digest
  // (`render()`, src/awareness.ts): header, background counts, and the ack footer when any item is
  // directed. Re-rendering from `items` here produced two faults — it dropped every background
  // count, and for a digest with background but NO items it emitted formatDigest's bare header,
  // asserting "has mail for this chat" about a payload that carries no mail. A gate that reads one
  // field and a body that renders another can deliver a claim the gate never checked.
  const text = typeof body?.text === "string" ? body.text.trim() : ""
  if (!text) return { deliver: false, reason: "empty" }
  return { deliver: true, text }
}

/** GET the awareness digest, never throwing and never logging the key. */
export async function fetchDigest({ hub, key, sessionId, fetchImpl = fetch, timeoutMs = 5000 }) {
  if (!hub || !key) return { deliver: false, reason: "unconfigured" }
  try {
    const url = new URL("/v1/awareness", hub)
    const res = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${key}`, "x-opencadre-session": sessionId },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.json().catch(() => undefined)
    return decide({ status: res.status, body })
  } catch {
    // The reason is only ever "unreachable": never echo the key or the URL's query.
    return { deliver: false, reason: "unreachable" }
  }
}
