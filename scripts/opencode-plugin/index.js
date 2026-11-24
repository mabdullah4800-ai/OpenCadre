// OpenCadre plugin for OpenCode v2: mail that wakes an idle chat, and (via ./clearance.js) risky commands held for
// approval. Installed by `opencadre connect` into ~/.opencadre/bin/opencode-plugin/ and listed under `plugins` in
// OpenCode's config (opencode.ai/v2/docs/build/plugins: "add them to `plugins` in opencode.json(c)", absolute paths
// allowed). Every failure is a silent no-op: a convenience must never break the tool it lives in.
//
// MEASURED ON OpenCode 2.0.10 (2026-09-19 and 2026-09-23), and each one is load-bearing:
//  - No `import { Plugin } from "@opencode/plugin"`: that package is not installed for a local plugin, and the import
//    fails the whole plugin. A plain default export of `{ id, setup }` is the contract the loader states.
//  - This is a DIRECTORY with an index.js entry: every file directly under a plugins folder is loaded as its own plugin.
//  - ONE OpenCode process sets this plugin up SEVERAL times, once per project location it knows (six on the fleet PC,
//    one pid), and one repo can appear at two locations. So per-chat work is claimed in a process-wide record
//    (globalThis), and a chat is handled only by an instance whose project is that chat's project.
//  - The hub finds a chat's agent from this computer's credential, the chat's id AND its project headers; without the
//    project headers it answers "no OpenCadre session for this chat yet".
import { nextStep, sessionIdOf, wakeText } from "./mail.js"

const LONG_POLL_SECONDS = 50
// Tests shorten the waits with OPENCADRE_OPENCODE_BACKOFF_MS ("a,b,c"); nothing else sets it.
const BACKOFF_OVERRIDE = (process.env.OPENCADRE_OPENCODE_BACKOFF_MS ?? "").split(",").filter(Boolean).map(Number).filter((n) => n >= 0)
const BACKOFF_MS = BACKOFF_OVERRIDE.length ? BACKOFF_OVERRIDE : [15_000, 60_000, 300_000]
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve() }, { once: true })
})

export default {
  id: "opencadre",
  async setup(ctx) {
    let cfg
    try {
      // From this plugin's OWN generation (bin/.gen/<id>/opencadre-config.mjs once installed; scripts/ in a checkout),
      // never the install root by absolute path: a root copy is a legacy library of another revision (Q1g PR-2).
      cfg = await import("../opencadre-config.mjs")
    } catch {
      return // OpenCadre helpers are not installed beside this plugin: nothing to do.
    }
    const device = cfg.explainDeviceCredential?.({ client: "opencode" })?.credential
    if (!device?.hub || !device?.credential) return

    // Clearance is its own module, owned separately; registering it here keeps one plugin install for both.
    // A module that is not there yet is quiet; one that is there but fails to register is a SAFETY gap (risky commands
    // would run unheld), so it is reported on stderr, which OpenCode keeps in its log. Mail still works either way.
    let clearance = null
    try {
      clearance = await import("./clearance.js")
    } catch {
      // Not shipped with this install.
    }
    if (clearance?.registerClearance) {
      try {
        await clearance.registerClearance(ctx)
      } catch (err) {
        console.error(`opencadre: clearance did not register, so risky commands are NOT held for approval in this OpenCode location (${err?.message ?? err})`)
      }
    }

    const projectId = ctx.location?.project?.id
    const directory = ctx.location?.directory
    if (!projectId || !directory) return
    // Local opt-in: a folder whose project is not on this computer's enabled-project list is never named to the hub, so
    // no watcher starts there (scripts/opencadre-config.mjs folderAccess).
    if (cfg.folderAccess?.({ cwd: directory, hub: device.hub, credential: device.credential }) === "unlisted") return
    const shared = (globalThis.__opencadreOpencode ??= { watching: new Set() })
    const controller = new AbortController()
    const { signal } = controller

    const headersFor = (sessionID) => ({
      ...cfg.projectHeaders(directory),
      authorization: `Bearer ${device.credential}`,
      "x-opencadre-session": sessionID,
      "x-opencadre-client": "opencode",
      // Never create an agent from here: a chat that has not used OpenCadre has nothing to be woken for.
      [cfg.RESOLVE_ONLY_HEADER ?? "x-opencadre-resolve-only"]: "1",
      // Waiting is not activity: this watcher is not the chat, so its polls must not keep the chat's agent online. The
      // hub skips the heartbeat on auth AND during the hold for this header, so an abandoned chat lapses as it should.
      "x-opencadre-probe": "no-heartbeat",
    })

    const watch = async (sessionID) => {
      let afterId
      let failures = 0
      let known = false // the hub has answered 200 for this chat at least once
      let misses = 0 // no-session (401) answers in a row before any 200
      while (!signal.aborted) {
        let status = 0
        let body = null
        try {
          const query = new URLSearchParams({ peek: "true", timeoutSeconds: String(LONG_POLL_SECONDS), ...(afterId ? { afterId } : {}) })
          const res = await fetch(`${device.hub}/v1/messages/wait?${query}`, { headers: headersFor(sessionID), signal })
          status = res.status
          body = await res.json().catch(() => null)
        } catch {
          if (signal.aborted) return
        }
        const step = nextStep({ status, body, known, misses })
        if (step.action === "stop" || step.action === "ended") return
        if (status === 200) known = true
        misses = status === 401 && !known ? misses + 1 : 0
        if (step.action === "backoff") {
          await sleep(BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)], signal)
          continue
        }
        failures = 0
        if (step.action === "wake") {
          afterId = step.afterId
          try {
            await ctx.session.synthetic({ sessionID, text: wakeText(step.count) })
          } catch {
            // A refused admission is not a crash: the mail stays unread and the chat sees it on its next turn.
          }
        }
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal })) {
          const sessionID = sessionIdOf(event)
          if (!sessionID || shared.watching.has(sessionID)) continue
          let info
          try {
            info = await ctx.session.get({ sessionID })
          } catch {
            continue
          }
          // Another instance serves this chat's project (it will claim the chat when it sees the same event).
          if ((info?.projectID ?? info?.data?.projectID) !== projectId) continue
          if (shared.watching.has(sessionID)) continue
          shared.watching.add(sessionID)
          void watch(sessionID).finally(() => shared.watching.delete(sessionID))
        }
      } catch {
        // The stream ending is not an error worth reporting.
      }
    })()

    return () => controller.abort()
  },
}
