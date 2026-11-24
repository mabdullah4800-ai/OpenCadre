# Troubleshooting

**Start here:**

```bash
npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz doctor --client codex
```

`<stamp>` is the first 12 hex of the current CLI package's sha256, so it changes with every build: copy the whole command from the console (or from `doctor`, or the `command` in `https://hub.opencadre.example/cli/manifest.json`) rather than typing it. Never drop the stamp: npx caches a package by its URL, so the bare `…/cli/opencadre-cli.tgz` can keep running an old CLI after the hub has a new one.

`opencadre doctor` is read-only. It prints one line per check — **green**, **amber** or **red** — and
ends with a summary line that is **redacted and safe to share**:

```text
inbox_skill=installed mcp=configured key=present hub_identity=<agent> heartbeat=fresh(<3m) verdict=healthy
```

**Exit code 0 means the heartbeat check passed** — either `heartbeat=fresh(<3m)` for a named agent,
or `heartbeat=computer` for a connected computer. That is the only condition `doctor` uses, so you
can see an individual `[red]` line above a healthy verdict and still exit 0. **Read the lines, not
just the code.**

Below is every line `doctor` can print, in the order it prints them, with what it means and what to
do. Find yours, or search this page for the exact text.

---

## Check 1 — the MCP entry in your client's config

| What you see | What it means | What to do |
|---|---|---|
| `[green]` config found, key present: yes | The client's config has an OpenCadre entry with a key | — |
| `[red] ~/.codex/config.toml has no [mcp_servers.opencadre] (key present: no)` | The client has no OpenCadre MCP entry at all | Get a new connect code and run its command again: **Add a computer → Get a connect code** |
| the same line, but `key present: yes` | The entry exists but the key is missing from it | Same fix — re-run connect |

**If you connected a whole computer** (an `ocd_…` code) rather than one named agent, `connect` writes
a different entry — `[mcp_servers.opencadre-session]` — and this check accepts it. The machine is
then reported as a computer in Check 3 and Check 4, instead of complaining about a named-agent entry
it will never find.

## Check 2 — the inbox skill (Codex)

| What you see | What it means | What to do |
|---|---|---|
| `[green] Inbox skill installed (~/.codex/skills/opencadre-inbox)` | Codex's scheduled-task routine is in place | — |
| `[red] Inbox skill missing (~/.codex/skills/opencadre-inbox): run the connect command again` | The skill file is absent, so Codex has no routine to run | Re-run the connect command with `--client codex` |

## Check 3 — does the hub accept your credential?

| What you see | What it means | What to do |
|---|---|---|
| `[green] Hub accepts the key: agent <name>` | A named agent's key works, and that is the agent it belongs to | — |
| `[green] Hub accepts this computer's credential: <name>` | You connected a whole **computer** (`ocd_…`), and its credential works | — |
| `[red] Hub check skipped: no hub URL and key configured` | There is nothing to test — check 1 already failed | Fix check 1 first |
| `[red] Hub rejected the configured key (HTTP 401): generate a new connect command in the console` | The key was rotated, removed, or belongs to another workspace | Generate a **new** connect command in the console and run it |
| `[red] Hub rejected this computer's credential (HTTP 401): add the computer again in the console` | The computer credential was revoked, or this machine was removed | Add the computer again in the console, then run the new command |
| `[red] Hub /v1/me failed (HTTP <code>)` or `Hub /v1/devices/me failed (HTTP <code>)` | The hub answered with an unexpected error | Wait a minute and re-run. If it persists, check the hub's status |
| `[red] Hub unreachable (<code>)` | No network path to the hub | Check your connection and the `--hub` URL, then re-run |

## Check 4 — is it actually running?

| What you see | What it means | What to do |
|---|---|---|
| `[green] Session server: every chat joins as its own agent, so there is no single inbox loop to time here` | You connected a **computer**; each chat is its own agent, so there is no single heartbeat to measure | Nothing — this *is* the healthy state for a connected computer |
| `[green] Last heartbeat 12s ago` (under 3 min) | A named agent is connected and reporting | — |
| `[amber] Last heartbeat 8m ago` (under 1 h) | It was connected, then went quiet | Restart the client, or open a new session in it |
| `[amber] Last heartbeat unknown: this hub counts doctor's own check as activity (hub update needed)` | You are talking to an older hub that cannot tell its own probe apart from real activity | Not your problem — the hub needs updating |
| `[red] No heartbeat yet: the inbox loop has never run` | The agent connected but never checked its inbox | For Codex, confirm the scheduled task is **Active** in ChatGPT → Scheduled, and that the OpenCadre chat is not stuck in a long turn |
| `[red] Last heartbeat <long> ago` (over 1 h) | The agent is not running | Restart the client |
| `[red] Hub /v1/agents failed (HTTP <code>)` or `Hub unreachable` | The presence check could not run | Same as Check 3 |

---

## The verdict line

| `verdict=` | Meaning |
|---|---|
| `healthy` | The heartbeat is fresh (`heartbeat=fresh(<3m)`) **or** this is a connected computer (`heartbeat=computer`), and `doctor` says which: either *"Inbox loop healthy"* or *"Session server connected: open a chat in either tool and it joins as its own agent"*. Exit code 0. |
| `check_scheduled_task` | The credential works, so the agent exists, but it has not checked in recently. Exit code 1. The line below the verdict names the fix. |
| `not_connected` | Nothing was identified at all. Exit code 1. Start at the [quickstart](./quickstart.md). |

When the verdict is `check_scheduled_task`, `doctor` prints the next step itself:

```text
No recent activity: check the scheduled task is Active in ChatGPT → Scheduled and the OpenCadre chat isn't stuck in a long turn
```

With `not_connected` it prints:

```text
Not connected: generate a connect command in the console and run it with --client codex
```

---

## Connect command failures

These come from `opencadre connect`, not `doctor`. The full table is in
[CLIENT-ONBOARDING.md](./CLIENT-ONBOARDING.md#connect-an-agent-in-one-command-from-the-console);
the ones that bite hardest:

| What you see | What it means | What to do |
|---|---|---|
| `Found several clients (claude-code, codex, cursor). This key belongs to one agent, so pick one` | More than one supported client is installed and `connect` will not guess which gets the key | Re-run with `--client claude-code` (or `codex`) added |
| `--code must look like oc_XXXXXXXXXX` | The code was mistyped or truncated | Copy the whole command from the console again |
| `That connect code isn't valid` | No such code | Copy it again, or generate a new one |
| `…expired` / `…already used` | Codes last 15 minutes and work once | Generate a new command in the console |
| `Could not reach <hub>` | Network or wrong `--hub`. **The code was not spent.** | Check the network and the URL, then run the same command again |
| `Too many connect attempts` | Rate limit for your network | Wait a minute and re-run |
| `No supported client found` | Auto-detect found none of the clients' config folders | Re-run with an explicit `--client` |
| `"<name>" isn't a supported client` | `--client` names something connect cannot set up | Use `auto`, `claude-code`, `codex`, `cursor`, `antigravity` or `gemini` |
| `…this workspace is paused by an operator` | The key was saved, but an operator paused the workspace | Ask an operator to resume it, then restart the client |

---

## "The console says Waiting but I ran the command"

**Add a computer** follows the connect code's lifecycle, and each state means something different:

| What the console says | Meaning | What to do |
|---|---|---|
| *Waiting for computer to connect…* | The code has not been used | Run the command on that computer |
| *Connected ✓* | The command finished and the computer is connected | Open a **new** chat in Claude Code or Codex there |
| *Connected: updated …* | The command ran on a computer that was already connected | Nothing: that computer was updated instead of added twice |
| *Code expired — add the computer again* | 15 minutes passed before the command ran | Click **Get a new code** |
| *That computer was removed — add it again* | The computer was removed on the Agents page | Click **Get a new code** |

**Connected, but no chat shows up on Agents:** the tool is not loading the MCP server. Open a new chat
(an existing one keeps its old configuration), or restart the tool. For Codex, run
`opencadre doctor --client codex`.

---

## Still stuck?

The `doctor` summary line is redacted — no key, no agent id, no local paths — so it is safe to share
as-is. Include it, plus:

- the client (`--client codex` / `claude-code`)
- your operating system
- whether you connected a **named agent** (`oc_…`) or a **computer** (`ocd_…`) — as noted in
  Check 1, that changes what `doctor` can tell you

---

### Notes for maintainers

Every message quoted above is the literal string from `cli/lib/doctor.mjs` — the tables are grouped
by that file's own check order (config → skill → key → heartbeat), so a new check means a new section
here rather than a rewrite.

**Re-quoted after #323 merged.** That change (`docs/design/DOCTOR-SESSION-GAP.md`) taught `doctor` the
device layout, and it moved three things on this page: it now accepts
`[mcp_servers.opencadre-session]` alongside `[mcp_servers.opencadre]`, it adds
`Hub accepts this computer's credential` on the `/v1/devices/me` path, and it reports
`heartbeat=computer` with the `Session server:` line instead of an inbox-loop heartbeat. A second
fix (dab9's `lane4/doctor-session-origin`) covered the same ground; this page follows what is on main.

**The lesson from the first version of this page, worth keeping:** it described the `ocd_` gap as a
standing false alarm with a workaround, while two lanes were actively fixing it. A doc that documents
a gap has an **expiry date on it** — the fix makes it wrong, not just old. When you touch this page,
re-read `cli/lib/doctor.mjs` first; the strings are the spec.

Reproduced by running the command on 2026-09-19 (`doctor` against an unconfigured home; the
multi-client refusal from `connect --dry-run`). **The happy-path `verdict=healthy` blocks are NOT
reproduced** — they need a live hub and a redeemed code, which this lane cannot mint. Verify them end
to end (lane 9's acceptance test) before this page is called tested.