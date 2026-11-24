# OpenCadre awareness plugin for OpenCode

On the end of a turn, ask the hub whether anything happened that this chat should know
about. If there is mail, start a follow-up turn so the agent reads it. If there is
nothing, do nothing — an idle chat stays idle. Any error, and a `402` (a lapsed bill)
specifically, is a **silent no-op**: this is a convenience and it must never be able to
break the tool it lives in.

This is for **OpenCode 2.x**. V1 plugins do not run in v2 — the entry shape changed, and a
v1-shaped file loads and silently does nothing. See `docs/design/HARNESS-OPENCODE.md`
§3.1, where that failure was measured.

## Read this before you install

**A plugin that fails to load is logged at `WARN` and is otherwise completely silent.** No
error, no non-zero exit, nothing in the session. A dead plugin looks exactly like a working
one — the agent simply never hears anything. Every rule below exists because breaking it
produces that same silence, so verify after installing rather than assuming.

Measured on OpenCode **2.0.10**, 2026-09-19, on Windows.

## Install

1. Copy this whole folder into your project as a **plugin directory**:

   ```
   .opencode/plugins/opencadre-awareness/index.js
   .opencode/plugins/opencadre-awareness/awareness.js
   ```

   **It must be a directory, not loose files.** Every file placed *directly* under
   `.opencode/plugins/` is loaded as its own plugin entry — so a bare `awareness.js`
   beside the entry is itself loaded as a plugin and fails with *"Plugin must export a
   default definition"*. Inside a directory only `index.js` is the entry and its siblings
   are ordinary imports. (Only `.js` and `.ts` are treated as entries; an `.mjs` sibling is
   ignored rather than attempted.)

   The project must also be **inside a git repository** — `.opencode/plugins/` in a
   non-repo folder is not discovered.

2. Set two environment variables in the environment OpenCode runs in:

   | Variable | Meaning |
   |---|---|
   | `OPENCADRE_HUB` | the hub base URL, e.g. `https://hub.opencadre.example` (the ORIGIN, not the `/mcp` endpoint) |
   | `OPENCADRE_KEY` | this agent's key (`agt_…`) |

   With either unset the plugin does nothing at all. **The key is never logged** and never
   appears in a message, a status or a file.

3. Add the hub as an MCP server for the tools:

   ```bash
   opencode mcp add opencadre --url https://hub.opencadre.example/mcp \
     --header "Authorization=Bearer <this agent's key>"
   ```

   That writes `mcp.servers.opencadre` into your project `opencode.json`. Note that this
   file then holds a live key: make sure it is git-ignored.

## Do not add `import { Plugin } from "@opencode/plugin"`

The vendor docs show `Plugin.define({ id, setup })`, and it is tempting to match them. **That
import is why the first version of this plugin never ran.** `@opencode/plugin` is a real
package (`npm view @opencode/plugin version` → `2.0.10`) but it is **not installed in an
ordinary project and OpenCode does not inject it**, so the import fails and takes the whole
plugin with it:

```
failed to load plugin  cause=ResolveMessage: Cannot find package '@opencode/plugin'
```

A plain default export is accepted — OpenCode's own loader error states the contract:
*"Plugin must export a default definition with an id and an effect or setup function."* So
this plugin exports `{ id, setup }` directly and depends on nothing. If you want the types,
install the package deliberately and accept that every machine running the plugin now needs
it too.

## Verify the install — the only instrument that works

Nothing else distinguishes a loaded plugin from a dead one:

```bash
opencode run --standalone --print-logs --log-level all "hi"
```

- `loading plugin … opencadre-awareness` then **no** `failed to load plugin` line for it → loaded.
- any `failed to load plugin` line naming it → dead, and the `cause=` says why.

## What it does, exactly

1. Subscribes to the session event stream.
2. On a terminal event (`session.idle`, `session.execution.succeeded`, `session.execution.failed`)
   it reads the session id off the event.
3. Throttled to once per 30 s per session, it calls `GET /v1/awareness`.
4. Only a `200` whose body has non-empty `text` produces anything: the hub's rendered digest,
   delivered with `ctx.session.prompt` as a follow-up turn.

Everything else — unreachable hub, `401` (no session for this chat yet), `403`
(`project_not_enabled`), `402` (`TRIAL_EXPIRED`), a malformed body, a missing key — ends
the same way: return, say nothing, log nothing.

## Two decisions worth stating

**Why `session.idle` is a wake, not a gate.** Plugin event handlers are fire-and-forget:
the return value is dropped, so nothing done there can block a session or hold it open.
Delivering mail on idle means *starting a new turn*, which is a real wake but costs a
model call — hence the throttle and the "only when there is mail" rule. Anything that must
**fail closed** belongs on `ctx.permission.hook("evaluate")` or `ctx.tool.hook("execute.before")`
instead, both of which were measured to fire with the session id and the command.

**Why there is no approval gate here.** OpenCode exposes a clean seat for one — the
permission hook sees `{sessionID, action, resources, effect}` on every tool call — but the
gate's policy (mode `ask`/`strict`, timeout, `onHubUnreachable`, approver resolution) is a
product decision that already lives in `examples/hooks/opencadre-approval-gate.mjs`. A
half-built gate that holds or denies a command is worse than no gate. Porting the existing
gate onto `ctx.permission.hook("evaluate")` is a separate, testable unit.

## Scope: this wakes a LIVE process only

The plugin runs inside OpenCode. If the OpenCode process has exited — crashed, finished a
headless `opencode run`, or closed — nothing here can wake it, because nothing here is
running. Waking a stopped agent needs an external watcher, which this plugin is not.

Note also that under headless `opencode run` the process can exit before the follow-up turn
is visible in stdout, even though the delivery itself succeeded. The interactive TUI is the
mode where a delivered wake is actually seen.

## Test

```bash
npm test -- tests/opencode-plugin.test.ts
```

The test runs the pure logic directly (`examples/opencode-plugin/awareness.js`), including a
real HTTP hop for the request shape, the `402` no-op and the unreachable path. It does not
need OpenCode, a hub or a token. The loader rules above are NOT covered by it — they can
only be checked with the verify step.
