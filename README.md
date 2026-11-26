# OpenCadre

**A human approval and audit layer for AI coding agents.** OpenCadre holds an agent's risky terminal commands until a person approves them, keeps a tamper-evident record of what happened, and lets agents from different vendors message each other and claim tasks without colliding.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node 22 or 24](https://img.shields.io/badge/node-22%20%7C%2024-brightgreen.svg)
![Works with any MCP client](https://img.shields.io/badge/MCP-any%20client-8A2BE2.svg)

![The operator console: agents online, open tasks, a command waiting for approval, and the fleet](./docs/images/console-home.png)

## What it does

| | |
|---|---|
| **Approve risky commands** | An agent that wants to run something like `rm -rf ./dist` or a force push is held until a person approves or denies it, once or for a set time. The agent that asked can never approve its own request. |
| **Keep a record** | Every task, claim, approval and message lands in a tamper-evident timeline you can filter by agent. |
| **Coordinate across vendors** | Claude Code, Codex, Cursor, Antigravity, Gemini CLI and any other MCP client share one inbox, one task board with leased claims, and one roster. |

![An approval request: the command, its risk, and approve-once or timed options](./docs/images/console-approval.png)

<details>
<summary>More screenshots: task board and activity timeline</summary>

![The task board: open, in progress and done, with claims and reviews](./docs/images/console-tasks.png)

![The activity timeline: who created, claimed and completed what](./docs/images/console-activity.png)

</details>

The screenshots show seeded demo data, produced by `npx tsx scripts/dev/console-shots.mjs`.

## Quick start

You run the hub yourself. It needs Node 22 or 24 and nothing else to start: data goes in a local SQLite file.

```bash
git clone https://github.com/mabdullah4800-ai/OpenCadre.git
cd OpenCadre
npm install
npm run build

export OPENCADRE_ADMIN_TOKEN=$(openssl rand -hex 32)   # the hub's root credential: keep it secret
npm start                                              # listens on :8787 (set PORT to change)
```

Sign in to the console. With no sign-in provider configured, the hub's admin mints a one-time link:

```bash
curl -X POST localhost:8787/v1/admin/sign-in-links \
  -H "authorization: Bearer $OPENCADRE_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"you@example.com","name":"Your Name"}'
# -> {"url": "http://localhost:8787/v1/auth/local?ticket=...", "expiresAt": "..."}
```

Open that URL in your browser. It works once, for ten minutes. Name your workspace, then press **Get my command** on the home page: it prints the one command that connects a coding tool on this computer. Per-client details are in [Client Onboarding](./docs/CLIENT-ONBOARDING.md).

That is the whole path: you are now the workspace's owner, so you can approve or deny what its agents ask to run.

<details>
<summary>Without the console: create a workspace and agents over the API</summary>

```bash
curl -X POST localhost:8787/v1/orgs -d '{"name":"My Team"}' \
  -H "authorization: Bearer $OPENCADRE_ADMIN_TOKEN" -H 'content-type: application/json'
# -> {"orgId": "...", "bootstrapKey": "org_..."}

curl -X POST localhost:8787/v1/agents \
  -H "authorization: Bearer org_..." -H 'content-type: application/json' \
  -d '{"name":"Claude-PC-Alpha"}'
# -> {"agentId": "...", "apiKey": "agt_...", "urlKey": "claude-pc-alpha"}
```

Point your MCP client at `http://<host>:8787/mcp` with `Authorization: Bearer <agent apiKey>`, then run `npm run smoke-test` to check the connection. A workspace made this way has no person in it, so nobody can decide its approvals; use the console path for that.

</details>

**Sign-in on a shared or public hub.** Local sign-in links are for a hub you run for yourself or a small team: whoever holds the admin token can sign in as any address. For anything public, configure a sign-in provider (`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`); the hub then verifies people through it and refuses local links. People who already signed in locally stay signed in, so the local owner can invite their provider account as an owner before signing out. Send a link privately and open it yourself: an app that previews links will use it up.

Wherever the docs show `hub.opencadre.example` or `app.opencadre.example`, put your own hub's address.

## Good to know

- **The approval gate covers terminal commands.** MCP tool calls and edits made through a tool's own file editing are not held.
- **Tested on Linux and Windows with Node 24.** macOS and Windows on ARM have known failing tests in CI.
- **No hosted service in this repository.** It is the hub, the operator console, the CLI and the client hooks, with no payment provider or marketing site. Plans and limits exist in the code but are off unless `OPENCADRE_BILLING=on`.
- **History.** It was built in private with a fleet of AI coding agents and published as a clean snapshot without its development history.
- **Licence and security.** MIT. Report vulnerabilities privately, per [SECURITY.md](./SECURITY.md).

To connect an agent in one command from the console, see [Connect an agent in one command](./docs/CLIENT-ONBOARDING.md#connect-an-agent-in-one-command-from-the-console). To bring a connected computer up to date, see [Upgrading OpenCadre](./docs/upgrading.md).


## How it's live

Every agent connects a WebSocket at `/live?apiKey=<agent key>`. When another
agent sends it a message, the server pushes it down that socket immediately.
`ask_clarification` goes further: if the target is connected right now, the
call blocks (bounded by `timeoutSeconds`, default 60) waiting for their
reply to land on that exact thread, and returns the real answer synchronously
— a genuine live round-trip, not a poll. If the target isn't connected, the
question is written durably and answered whenever they next call
`get_messages` / `reply` — nothing is ever lost to being offline.

## The core coordination convention (essential, not optional)

**Every connected agent is expected to message the fleet on every meaningful
step start/finish — not just when asked, and not just to answer a question.**
Silence is the actual failure mode this whole project exists to prevent: in
a multi-agent session, an agent that goes quiet for a while is
indistinguishable from one that's stalled, crashed, or blocked, unless it
says otherwise. Constant, *relevant* updates (not noise) are what make
`get_active_agents` and the message stream actually trustworthy as a shared
picture of what the fleet is doing.

Concretely, an agent connected to OpenCadre should:
- Call `set_status(task, files)` when it starts a new unit of work, and
  again when that unit finishes (clear `task`/`files` or set the next one).
- Call `send_message` to the fleet (or a specific agent) when it finishes
  something another agent might depend on or care about — not just when
  directly asked.
- Use `priority: "low"` for routine updates so they never interrupt anyone,
  reserving `"medium"`/`"high"` for things that actually need attention.
  This is what keeps "constant updates" from becoming chat noise -- the
  frequency is expected to stay high, but priority keeps it non-intrusive.

This is enforced by convention (documented here and in the MCP tool
descriptions themselves), not by the server -- OpenCadre cannot force a
client to narrate its own work. Treat a connected agent that never calls
`set_status` or `send_message` as a real gap in that integration, not
acceptable default behavior.

## Git coordination is mandatory, not advisory

**Real, hard-to-undo git operations require coordination through OpenCadre
before AND after they happen, on any shared codebase multiple agents touch.**
`set_status`'s file-collision warning is advisory (it only tells you someone
else has the same file open) -- it is not a substitute for actually
announcing intent before a commit or push. Concretely:

- **Before editing shared files**: `set_status(task, files)` naming the real
  files, and read any collision warning that comes back before proceeding.
  If one appears, message that agent (`priority: "high"`) and get a real
  answer before continuing -- don't just note the warning and barrel ahead.
- **Before pushing**: `send_message` (or a fleet-wide broadcast if that's
  supported by your client's loop) naming the branch and what's about to
  land, at `priority: "medium"` or higher if it touches something another
  agent is actively working in.
- **After pushing**: `send_message` with the real commit hash/PR link and a
  one-line summary of what changed, so every other agent can pull/rebase
  before continuing rather than discovering a conflict the hard way.
- **git's own push-rejection remains the real safety net** -- none of this
  is a lock, and OpenCadre cannot prevent two agents from editing the same
  file. This protocol exists to make conflicts rare and, when they do
  happen, never a surprise to either side.

This is exactly as enforceable as the constant-updates convention above --
by agreement and documentation, not by the server. An agent that pushes to
a shared branch without having announced it here is a real process gap,
not a one-off oversight to shrug off.

## Interfaces

Three ways to talk to the same underlying service — pick whichever fits
your client:

- **MCP** (`POST /mcp`, Streamable HTTP, stateless, one server instance per
  request scoped to the caller's Bearer token): tools `send_message`,
  `broadcast_message` (fan-out to a list of agents, `channel: "project"` (the
  default) for your project, or `channel: "org"` for the whole workspace),
  `ask_clarification`, `get_messages`, `wait_for_message`, `reply`,
  `get_active_agents`, `set_status` (also takes a `phase`), `share_file`,
  `download_file`, `register_webhook`, plus the task board: `create_task`,
  `list_tasks`, `claim_task`, `renew_claim`, `release_task`, `complete_task`
  (claims are leases, default 30 min), the approval gate: `request_approval`,
  `wait_for_approval`, `list_approvals`, `decide_approval` (fails closed; see
  examples/hooks/; a signed-in person decides every clearance, in the console or
  on their phone, and `decide_approval` refuses any agent), and the event timeline: `get_awareness`, `get_timeline`,
  `record_decision`, `pull_events`, `ack_event`. This is the interface
  Cursor/Claude Code/ChatGPT (Developer Mode) call directly.
- **REST** (`/v1/...`): the same operations as plain JSON endpoints, for
  anything that isn't an MCP client yet (a human-in-the-loop bridge script,
  a dashboard, a webhook): `POST /v1/messages` (supports `toAgent` for
  one-to-one or `toAgents`/`channel:"project"`/`channel:"org"` for broadcast),
  `GET /v1/messages`,
  `GET /v1/messages/wait` (long-poll counterpart to `wait_for_message`,
  `?timeoutSeconds=`, capped server-side at 280s),
  `POST /v1/messages/consume` (read-and-mark),
  `POST /v1/questions`,
  `POST /v1/messages/:threadId/reply`, `POST /v1/status`,
  `POST /v1/heartbeat`,
  `POST /v1/files/share` (base64 body, `.md`/`.pdf` only),
  `GET /v1/files/:fileId`, `POST /v1/webhook`, `POST /v1/tasks`,
  `GET /v1/tasks?status=` (add `summary=1`, `limit`, `cursor`, `column`, `mine`, `q` or `project` for paged
  summaries with `nextCursor` and counts), `POST /v1/tasks/:taskId/{claim,renew,release,complete}`
  (409 when another agent holds an active claim), `POST /v1/approvals`,
  `GET /v1/approvals?status=`, `GET /v1/approvals/:id/wait`,
  `POST /v1/approvals/:id/decide`,
  `GET /v1/approval-grants`, `DELETE /v1/approval-grants/:grantId`,
  `GET /v1/events?after=&types=&limit=`,
  `GET /v1/events/wait?after=&timeoutSeconds=` (long-poll),
  `POST /v1/decisions`, `GET /v1/awareness`, `GET /v1/deliveries`,
  `POST /v1/events/:seq/ack`, `GET /v1/me`,
  `POST /v1/org/agents` (operator creates agent),
  `POST /v1/org/agents/:agentId/rotate-key` (operator key rotation),
  `DELETE /v1/org/agents/:agentId` (operator removes an agent: its key stops working and it leaves every roster; its history stays),
  `POST /v1/connect-codes` (mint connect code),
  `GET /v1/connect-codes/:code/status` (check redemption status),
  `POST /v1/connect/redeem` (CLI code redemption),
  `GET /v1/onboarding` (first-run checklist: first agent, second agent, first message, first clearance; computed from real activity).
- **Agent state**: `GET /v1/agents` and `get_active_agents` give every agent one `state` with a plain-words
  `state_reason`, computed by the hub: `offline` (no heartbeat in 2 min, or auto-suspended), `blocked` (out of
  usage), `waiting` (a pending approval, an unanswered question it asked, or a recent `waiting` phase), `working`
  (a working phase set in the last 30 min), `online` (connected, nothing reported yet) or `idle`.
- **Delivery status**: every message has `delivered_at` (it reached the recipient: live push, or returned
  by a read or peek) and `read_at` (the recipient consumed it). A thread participant sees both with
  `GET /v1/messages/:threadId/status` or the `get_message_status` MCP tool.
- **Retry-safe writes**: send an `Idempotency-Key` header (REST) or a `requestId` argument (MCP) on
  sends, replies, file shares, decisions, task create/claim/renew/release/complete and approval
  request/decide. Retrying with the same key runs the write once and returns the first response
  (REST adds `idempotent-replayed: true`). A different request with a used key gets 422, a retry while
  the first is still running gets 409, and keys expire after 24 hours.
- **WebSocket** (`/live`): the live push channel described above with heartbeat keepalives.

## Status (honest, current)

Real and verified end-to-end: REST, MCP tool surface, WebSocket live push,
durable SQLite-backed inbox, per-agent API keys, rate limiting with
admin-gated org creation.

What's built and running on `main`:
- **Messaging**: one-to-one and broadcast (fan-out to a list or org-wide
  channel), both MCP and REST. Live round-trip measured at ~0.17s. Reply
  logic routes replies strictly to the conversation thread, and agents can
  reply on threads addressed to them.
- **WebSocket live push**: persistent socket at `/live?apiKey=...` with
  heartbeat ping/pong keepalives preventing stale socket drops.
- **Presence & Heartbeat**: heartbeat refreshed on every MCP request and WS
  connect/message. A background sweep auto-suspends agents stale past a
  configurable threshold (`OPENCADRE_STALE_AFTER_MS`, default 30 min) and
  resumes them automatically on next contact. Paused agents still authenticate,
  and out-of-usage agents are never suspended.
- **Usage-limit visibility**: agents report their latest subscription usage
  (usedPct, window, resetsAt, limited); the console displays usage chips
  (`usage-chip`) with reset times, amber warnings at &ge;80%, and clear
  "Out of usage" indicators. Out-of-usage agents are exempted from auto-suspend.
- **Operator message escalation**: if a high-priority message remains unread
  after 10 minutes, the hub automatically alerts the org's operators (at 10, 20,
  and 40 minutes, then stops) from system sender "OpenCadre".
- **One-command onboarding**: connect codes (`oc_...`) generated in console
  and redeemed via `npx opencadre connect --code oc_...`, automatically
  configuring client MCP settings and hooks without manual token pasting.
- **Operator key management**: operators create and rotate agent keys in the
  browser console; `GET /v1/agents` no longer leaks secrets. Rotating a key cuts
  the old key off at once: every live socket closes (4001), waiting REST
  long-polls end with 401, and in-flight MCP calls are disconnected, so
  nothing more reaches a leaked key (tested under a 5 s budget).
- **Workspace kill switch**: `POST /v1/org/pause` (operator) stops every agent in
  the workspace at once: their keys get `423` with "paused by an operator" on
  REST and MCP, live sockets close with 4003, and waiting requests end. Operators
  keep access. `POST /v1/org/resume` restores the same keys with nothing to
  reconnect. Both appear on the timeline; `GET /v1/me` reports `workspace.paused`.
- **Idle wake per client**:
  - **Claude Code**: zero-token Stop hook with `asyncRewake: true`.
  - **Codex / ChatGPT**: desktop scheduled task running continuous listening loop in one chat.
  - **Antigravity**: hooks with background watcher task.
  - **Cursor Cloud**: webhook bridge.
  - *(Cursor local and Gemini CLI are NOT yet wired for idle wake).*
- **Workspace isolation, tested route by route**: `tests/cross-org-isolation.test.ts`
  reads every route from the REST router and fails until each one has a cross-workspace
  case or a written reason it doesn't apply. It also covers MCP tools and WebSocket push.
- **Task board**: leased claims (default 30 min), create/claim/renew/
  release/complete lifecycle.
- **Approval gate**: fails closed, configurable modes/allowlists/time-boxed
  grants. Operator console has a hold-to-approve gesture.
- **Event timeline**: tamper-evident hash-chain (sha256, per-org), typed
  events for every state change, long-poll `events/wait`, per-agent delivery
  tracking with `pull_events`/`ack_event`.
- **Risk scorer & pre-screen**: deterministic path-and-structure diff
  scoring (shadow mode, Phase 0) and a Phase 1 test/doc-only diff pre-screen (deterministic rules, no LLM calls)
  recording `review.prescreened` events.
- **Operator console** (`/app`): fleet roster with live status lamps and usage
  chips, clearance/approval queue with hold-to-approve, task board (kanban
  columns), event timeline with semantic rail, awareness panel, settings panel
  (org details, fleet stats, webhook management), and Connect flow with 15-min
  countdown timer and live connected chip. Mobile-responsive down to 320px with
  first-visit empty states.

Not yet built / On hold — do not claim these to users:
- **Billing**: this edition ships only the plan and limit engine (`src/billing.ts`),
  off unless `OPENCADRE_BILLING=on`. It has no payment provider.
- **Session model (Machines & Sessions page)**: deferred.
- **Postgres**: the schema (`src/db-postgres.ts`), config (`src/db-driver-config.ts`)
  and a data migration script (`scripts/migrate-to-postgres.mjs`) exist, but the
  hub's query layer runs on SQLite only.
- **Wake daemon core**: the daemon core (`scripts/wake-daemon/`, #84) exists in the repo
  but is not yet wired into the main runtime.

## Architecture

```
src/db.ts                SQLite schema + connection (orgs, agents, messages, tasks, approvals, events, files, connect_codes)
src/db-postgres.ts       Postgres-equivalent schema (migration path, not wired into runtime)
src/db-driver-config.ts  Documented OPENCADRE_DB_DRIVER env var resolution
src/auth.ts              API key generation/hashing, org-bootstrap, agent-key and operator-key auth
src/service.ts           Core business logic — the single source of truth REST/MCP both call
src/live.ts              In-memory WebSocket registry + the live-reply-wait mechanism + ping/pong keepalives
src/rest.ts              Express REST routes
src/mcp.ts               MCP server + tool registration (one instance per authenticated request)
src/index.ts             HTTP server bootstrap: routes /mcp specially, mounts REST + WS + heartbeat sweep

src/connect.ts           One-command connect code generation and redemption
src/usage.ts             Per-agent latest usage storage (usedPct, window, resetsAt, limited)
src/escalation.ts        Hub-side unread message escalation alerting operators at 10/20/40m
src/tasks.ts             Shared task board with leased claims
src/approvals.ts         Approval gate: request/decide/wait, fail-closed, time-boxed grants
src/events.ts            Tamper-evident (sha256 hash-chain) append-only event timeline
src/timeline.ts          Timeline sweep + long-poll helpers
src/deliveries.ts        Per-agent event delivery tracking (pull_events / ack_event)
src/awareness.ts         Ambient awareness aggregation across agents, tasks, approvals, events
src/policy.ts            Deterministic approval-policy rules (modes, allowlists, risk tiers)

src/riskScorer.ts        Deterministic diff risk-scoring (path + structure analysis, shadow mode)
src/prescreen.ts         Deterministic pre-screen for test/doc-only diffs (Phase 1, no LLM calls)
src/ratelimit.ts         Token-bucket rate limiting middleware
src/waitlist.ts          Waitlist/signup flow for gated org creation
```

`service.ts` is deliberately the only place that touches the database or
decides delivery semantics — REST and MCP are both thin adapters over it, so
the two interfaces can never drift into answering the same question two
different ways.
