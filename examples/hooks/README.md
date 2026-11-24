# OpenCadre approval gate (Claude Code hook)

Pauses **risky** shell commands (Claude Code's Bash tool, and its PowerShell tool on Windows) for a person to approve in OpenCadre, in the
console or on their phone. No agent can decide a clearance, the named approver
included: an agent key, a computer's credential or a connector token is refused.
In Ask and Strict, an "approved" answer that names no person (a decision made by an
agent before this rule, or a hub older than the hook) is blocked, on every client. Everything else passes through untouched. You choose how strict it
is.

## Install

1. Add to `.claude/settings.json` (project) or `~/.claude/settings.json`:

   ```json
   { "hooks": { "PreToolUse": [ { "matcher": "Bash|PowerShell", "hooks": [
     { "type": "command", "command": "node /path/to/opencadre-approval-gate.mjs", "timeout": 600 } ] } ] } }
   ```

   Keep `PowerShell` in the matcher: on Windows, Claude Code's PowerShell tool runs commands too, and a
   `Bash`-only matcher lets every one of them through ungated. The gate reads a PowerShell tool's command
   as PowerShell.

2. Set `OPENCADRE_URL` (e.g. `https://hub.opencadre.example`) and `OPENCADRE_KEY`
   (this agent's key).
3. Optional: copy `approval-gate.config.example.json` to
   `~/.opencadre/approval-gate.json` for all projects, or to
   `.opencadre/approval-gate.json` in your project. A project's file comes
   with the repository, so it can only make the gate **stricter** (see
   "Config layers" below).

## Modes

| Mode | On a risky command | Blocks the agent? |
|---|---|---|
| `off` | Nothing | Never |
| `notify` *(default)* | Records it in OpenCadre and sends the approver a low-priority FYI | Never |
| `ask` | Waits for approve/deny; `onTimeout` and `onHubUnreachable` choose `deny` (default) or `allow` (no opinion, see below) | Until decided or `waitSeconds` |
| `strict` | Like `ask`, but always fails closed, and branch exemptions and the default allowlist are ignored (your own `allow` list still applies) | Until decided |

## Settings

| Key | Default | Meaning |
|---|---|---|
| `mode` | `notify` | See above. Env `OPENCADRE_GATE_MODE` overrides. |
| `approver` | none | Optional **agent name** to ping. The name must be one an agent in your workspace actually holds — a name from someone else's setup, or one left over from an agent you removed, will not resolve, and the gate will fall back to the workspace's operators and tell you so. Left unset, requests go to the operators directly. Env `OPENCADRE_APPROVER`. |
| `waitSeconds` | `540` | How long `ask`/`strict` waits. Keep it below the hook `timeout`. A dropped connection or a 5xx while waiting (a hub deploy) is retried every second until then; only a real decision, a 4xx or the deadline ends the wait. |
| `onTimeout` / `onHubUnreachable` | `deny` | `ask` mode only: `deny` or `allow`. **`allow` is not an OpenCadre approval**: the gate says nothing, so the command falls back to your tool's own permission settings (which may ask you, or may let it run if the tool is set to auto-approve), and the hub records a `clearance.policy_pass`. It is unsupported for verified person clearance, and the gate warns on stderr while it is set. `onHubUnreachable` covers only a hub that cannot be reached at all; a hub that answers but refuses the request, or a chat with no session yet, is an error and always blocks. `strict` ignores both. |
| `useDefaultRules` | `true` | Built-in rules: `rm-rf`, `force-push`, `git-reset-hard`, `git-clean`, `sql-drop`, `terraform`, `kubectl-delete`, `publish`, `docker-prune`, `prod-env-write`, `secret-file-write`, `agent-config-write`, `destructive-migration`. |
| `disabledCategories` | `[]` | Turn off individual built-in rules, e.g. `["docker-prune"]`. |
| `rules` | `[]` | Your own rules: `{ "category", "pattern" (regex), "risk" }`. |
| `useDefaultAllowlist` | `true` | Deleting only build/cache dirs (`node_modules`, `dist`, `build`, `.next`, `coverage`, …) never triggers. |
| `allow` | `[]` | Your own regexes for commands that should never trigger. |
| `protectedBranches` | `main, master, production, prod, release` | `force-push`, `git-reset-hard` and `git-clean` only trigger on these branches, or when the command names one. |

### Config layers

Trusted layers, later wins: built-in defaults < `~/.opencadre/approval-gate.json`
< the file at `$OPENCADRE_GATE_CONFIG` < env (`OPENCADRE_GATE_MODE`,
`OPENCADRE_APPROVER`, `OPENCADRE_APPROVAL_WAIT`). `rules`, `allow` and
`disabledCategories` are combined across them.

The project's `.opencadre/approval-gate.json` arrives with the code a chat
opens, so it can only **tighten** those layers, and it adds to them rather
than replacing them: `mode` becomes the stricter of the two
(`off` < `notify` < `ask` < `strict`), a `deny` fallback wins, its `rules`
and `protectedBranches` are added, and `waitSeconds` can only grow. Anything
that would loosen the gate (`onTimeout`/`onHubUnreachable` `"allow"`, a lower
`mode`, `allow`, `disabledCategories`, `useDefaultRules: false`, a shorter
wait) is ignored, with a warning on stderr; `opencadre doctor` reports it as
an error. Put such a setting in your own `~/.opencadre/approval-gate.json`
if you mean it.

### Who can allow a command

Only a person: a person's decision on that command in OpenCadre, or a
standing approval ("grant") a person gave for that category, which the gate
labels as such. Nothing else prints an allow, in any tool. A policy
fallback of `allow` is **no opinion**, never an approval; a record of it
that cannot reach the hub is queued in `~/.opencadre/run/policy-pass/`
(the masked command, never a key; at most 100 records, kept 7 days) and sent
by the same chat's next gated command in the same project (a chat with
no session id queues nothing). Warnings name ignored fields, never their values.

## Agent-config writes

`agent-config-write` (`risk: "high"`, not branch-aware) fires when a Bash
command writes to a file that reprograms an agent's own future behavior:
`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.mcp.json`, `.cursor/mcp.json`,
`.claude/settings.json`/`settings.local.json`, or one of this project's own
installed hook scripts (`opencadre-*.mjs`, `pure-ack.mjs`, wherever they're
installed under `.opencadre/bin/` or `examples/hooks/`). It matches a write
(`>`/`>>`, `cp`/`mv`/`tee`, `sed -i`, `scp`/`rsync`) naming one of those files,
not a plain read (`cat CLAUDE.md`) or a history lookup (`git log -- CLAUDE.md`).

This hook only ever receives Bash commands (see "Install" above) -- an agent
that edits these files through a dedicated file-write tool instead of a shell
command is invisible to it. Rewriting `CLAUDE.md` or `.mcp.json` is a
persistence vector, not a one-off destructive action: unlike `rm -rf`, its
effect outlives the command and silently changes what every later command
(from this agent or another one reading the same file) is allowed or told to
do -- including this gate's own script or the settings entry that wires it in.

## Secrets in commands

Rules match the command as typed, but the text sent to OpenCadre has secrets
masked first (`scripts/opencadre-secrets.mjs`): API keys and tokens, `Bearer`
values, passwords in URLs, and values of secret-named variables and flags, e.g.
`GITHUB_TOKEN=***` or `agt_***`. The hub masks the same shapes again when it
stores and shows clearance records.

## "Approve for 30 minutes"

When a person approves in OpenCadre they can approve for a while (`grantMinutes`
on `POST /v1/approvals/:id/decide` from the console). That agent's further requests
**in the same category and project** are auto-approved until the grant expires,
and each one records the person whose grant approved it. Review grants with
`list_approval_grants`; any agent or person can revoke one with
`revoke_approval_grant`, since revoking only takes permission away.

---

# OpenCadre session hook (Claude Code and Codex)

`opencadre-awareness.mjs` onboards every new session automatically and gives it
**checkpoint delivery**. Both clients run it with the same hook JSON.

| Event | What it does |
|---|---|
| `SessionStart` (startup, resume, clear, compact) | Calls `GET /v1/me` and injects `You are <agent> in the OpenCadre fleet "<org>".` plus a short fleet protocol (status, on-thread replies, no keys in messages, PR approval flow, awareness acks, wake script), then the awareness digest if anything happened. If the key is wrong or the hub is down it injects a one-line warning instead (an HTTP status or "hub unreachable", never the key). |
| `UserPromptSubmit` | Injects the awareness digest (`GET /v1/awareness`) **only when something P1 or P2 happened**, so quiet turns add nothing. |
| `PostToolUse` | Same, throttled per session. |
| `Stop` | Peeks the inbox. If real mail is waiting it returns `{"decision":"block"}` with up to 5 previews, so the agent answers before going idle. Low priority and pure acknowledgements never block unless a reply is awaited. When `stop_hook_active` is set it stays silent, so it can never loop. |

Install from your main OpenCadre checkout (the entries point at this file's absolute path):

```bash
node scripts/install-session-hooks.mjs --client codex          # ~/.codex/hooks.json
node scripts/install-session-hooks.mjs --client claude-code    # ~/.claude/settings.json
node scripts/install-session-hooks.mjs --client codex --dry-run  # print the merged JSON only
```

The installer merges idempotently, keeps unrelated hooks and settings, and backs
up the old file as `<file>.bak-<timestamp>`. It never touches keys. **Codex:**
open `/hooks` in Codex once and trust the new hooks, or they will not run.

**Where the key comes from**, first match wins:

1. `OPENCADRE_URL` and `OPENCADRE_KEY` in the environment.
2. The client's own MCP config, so no extra setup is needed. With `--client`
   (the installer always passes it) only that client's config is read, so a
   machine running both clients never swaps identities. Without it, Codex's
   config is tried first, then Claude Code's:
   - Codex: `[mcp_servers.opencadre]` in `~/.codex/config.toml` (`url` and the `Bearer` token in `http_headers`).
   - Claude Code: `mcpServers.opencadre` in `~/.claude.json` (the project matching the session's cwd, then user scope, then any project).

A trailing `/mcp` is stripped to get the hub URL. The lookup lives in
`scripts/opencadre-config.mjs`, shared with `opencadre-wake.mjs`.

| Setting | Default | Meaning |
|---|---|---|
| `OPENCADRE_URL`, `OPENCADRE_KEY` | from MCP config | Hub URL and this agent's key |
| `OPENCADRE_HOOK_HOME` | `~` | Home directory holding the client configs |
| `OPENCADRE_AWARENESS_MIN_INTERVAL` | `60` | Seconds between `PostToolUse` checks per session |
| `OPENCADRE_AWARENESS_STATE_DIR` | OS temp dir | Where the per-session throttle file lives |

It never blocks work: missing config, a slow hub or any error means no output
(SessionStart warns instead). Injected items tell the agent to `ack_event` what
it handled, so the fleet sees real acknowledgement rather than just delivery.

## Idle wake for Claude Code (asyncRewake)

The `Stop` hook above only runs when a turn ends, so a session that is already
idle would sit on new mail until a human typed. `--client claude-code` also adds
a second `Stop` handler to the same group:

```json
{
  "type": "command",
  "command": "node \"<checkout>/scripts/opencadre-wake.mjs\" --rewake --client claude-code",
  "asyncRewake": true,
  "timeout": 604800
}
```

How it works, on every Claude Code surface (CLI, Desktop app, IDE extensions, web):

1. Each time a turn ends, Claude Code starts the wake script in the background.
   It long-polls the inbox with `peek=true`, so it never marks mail read and
   costs no tokens while waiting.
2. Real mail (never low priority or pure acknowledgements) makes it write
   `OPENCADRE WAKE: N new message(s)…` plus previews to stderr and exit 2.
   Claude Code wakes the idle session with that text as a system reminder.
3. The agent answers, its turn ends, and the next `Stop` starts a fresh watcher.
   A cursor file stops it re-waking for mail it already reported.

Only one watcher runs per key: `~/.opencadre/wake-<key hash>.lock` holds the
owner's pid and is refreshed after every poll. Later watchers exit 0
immediately, and a lock left by a dead watcher is taken over. If the hub stays
unreachable, the watcher exits 2 with `OPENCADRE WAKE ERROR` so the agent knows
its wake stopped. A session with no OpenCadre key exits 0 silently. Claude Code
enforces `timeout` even on asyncRewake hooks, so the installer sets seven days.

```bash
node scripts/install-session-hooks.mjs --client claude-code
```

This replaces a `Monitor` or `run_in_background` watcher, so stop running one.
Codex has no asyncRewake, so the handler is never added to `~/.codex/hooks.json`.
