// OpenCadre awareness plugin for OpenCode v2.
//
// On the terminal event of a session's turn, ask the hub whether anything happened that this
// chat should know about. If there is mail, start a follow-up turn so the agent reads it.
// Any error is a silent no-op: a convenience must never break the tool it lives in.
//
// TWO THINGS HERE ARE LOAD-BEARING AND WERE MEASURED ON OpenCode 2.0.10 (2026-09-19):
//
// 1. There is NO `import { Plugin } from "@opencode/plugin"`. That package is NOT installed in
//    an ordinary project, and OpenCode does not inject it, so importing it fails the whole
//    plugin with `Cannot find package '@opencode/plugin'`. OpenCode accepts a plain default
//    export — its own loader error states the contract: "Plugin must export a default
//    definition with an id and an effect or setup function." Adding that import re-breaks this.
//
// 2. This lives in a DIRECTORY (`.opencode/plugins/opencadre-awareness/`), not as loose files.
//    Every file directly under `.opencode/plugins/` is treated as its own plugin entry, so a
//    flat sibling module is loaded as a plugin and fails with "must export a default
//    definition". Inside a directory, only the entry is loaded and siblings are just imports.
//
// A plugin that fails to load is logged at WARN and is otherwise SILENT — the agent looks fine
// and simply never hears anything. Verify with:
//   opencode run --standalone --print-logs --log-level all "hi"   (grep for "failed to load plugin")
import { TERMINAL_EVENTS, fetchDigest, sessionIdOf } from "./awareness.js"

export default {
  id: "opencadre.awareness",
  async setup(ctx) {
    const hub = process.env.OPENCADRE_HUB
    const key = process.env.OPENCADRE_KEY
    // Unconfigured is the normal state on a machine without OpenCadre. Say nothing.
    if (!hub || !key) return

    // One throttle per session, so an idle chat with no mail is not polled in a loop.
    const lastCheck = new Map()
    const minIntervalMs = 30_000
    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!TERMINAL_EVENTS.has(event?.type)) continue
          const sessionId = sessionIdOf(event)
          if (!sessionId) continue
          const seen = lastCheck.get(sessionId) ?? 0
          const now = Date.now()
          if (now - seen < minIntervalMs) continue
          lastCheck.set(sessionId, now)

          const result = await fetchDigest({ hub, key, sessionId })
          if (!result.deliver) continue
          try {
            await ctx.session.prompt({ sessionID: sessionId, text: result.text })
          } catch {
            // A failed follow-up turn is a no-op, not a crash: the next turn tries again.
          }
        }
      } catch {
        // The stream ending is not an error worth reporting.
      }
    })()

    return () => controller.abort()
  },
}
