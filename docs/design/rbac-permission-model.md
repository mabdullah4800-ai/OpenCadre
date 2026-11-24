# RBAC permission model — design doc

Status: **Migration steps 1, 2 and 3 DONE.** Stage 3 item 3 is complete.
Written 2026-09-18 for Stage 3 item 3 ("RBAC scoped per workspace, not per
global admin") of the OpenCadre → Frontier SaaS roadmap. Operator decided the
three open questions on 2026-09-18 (see "Decisions" below) — the table and
migration plan reflect those decisions. Two corrections made during
implementation, both reconfirmed with the operator or caught before merge:
the "tightens" table row for workspace members originally, incorrectly,
conflated `invite` with `remove`/`change role` (only the latter two tighten);
and `approval.decide`/`approvalGrant.revoke` were originally specified as
`"member"`-tier, which would have locked out every plain agent-key caller
(MCP has no member-session path — see step 3 below) — corrected to
`"agent"`-tier, truly matching "no restriction beyond authentication."

## Why this exists

Today's authorization is almost entirely binary: `agents.role` is `'agent'` or
`'operator'`, and `requireOperator` gates every org-administrative route (agent
management, connect codes, devices, projects, clearance policy) the same way,
regardless of who's asking. A separate `workspace_members.role`
(`owner`/`admin`/`member`) exists for human console sessions, but it's consumed in
exactly two places: `requireWorkspaceAdmin` (member/invite CRUD, where admin and
owner are treated identically) and `requireOwner` (org pause/resume only, added in
[#250](https://github.com/mabdullah4800-ai/OpenCadre/pull/250) as a narrow, deliberately
scoped fix — not a general model). Everywhere else, `agentRoleFor()` collapses
owner and admin into the same `'operator'` value, so most routes can't tell them
apart, and a bare API-key operator (no human account at all) is treated as
owner-equivalent by convention, not by any written rule.

This is fine for a single-operator hub. It stops being fine the moment a
workspace has more than one human and they don't equally trust each other with
everything — which is the actual shape of "multi-tenancy" Stage 3 is named for.

## Non-goals

- **Not** building a generic policy engine (OPA/Casbin-style rule DSL). Overkill
  for the resource count here and harder to audit than an explicit table.
- **Not** touching the `owner`/`admin`/`member` role *names* or the accounts
  system's existing member/invite model — this is additive on top of it.
- **Not** adding per-resource ACLs (e.g. "only these three agents can see this
  task"). Existing `created_by`/`claimed_by`/`requested_by` ownership predicates
  (see current-state notes below) already handle action-level ownership and stay
  as-is; this doc is about *role* permissions, not per-row sharing.
- **Not** retrofitting MCP tools with a different model than REST — both must
  read the same permission table so a human operator, an API-key operator, and
  an MCP-connected agent get identical answers for identical actions.

## Current state (verified against `origin/main`, 2026-09-18)

Three role signals exist, inconsistently consumed:

| Signal | Values | Set by | Consumed by |
|---|---|---|---|
| `agents.role` (`agentRole`) | `agent`, `operator` | key issuance / `agentRoleFor()` | `requireOperator` (21 routes) |
| `workspace_members.role` (`memberRole`) | `owner`, `admin`, `member` | accounts system | `requireWorkspaceAdmin` (4 routes, admin===owner), `requireOwner` (2 routes, owner only) |
| — (absent) | — | bare API key, no human account | treated as owner-equivalent by convention in both `requireWorkspaceAdmin` and `requireOwner` |

Routes currently gated by `requireOperator` (admin and owner treated identically):
agent create/rotate-key/delete, `GET /v1/org/usage`, connect codes, devices,
projects, project-links, project-isolation, sessions, clearance-policy read-list
and write/delete.

Two routes (`/v1/org/pause`, `/v1/org/resume`) are `requireOwner`-only — the one
place this distinction currently exists.

Everything else (messages, tasks, approvals, files, memory, MCP tools) requires
only `requireAgentAuth` — any authenticated agent in the org, gated further (if
at all) by project-visibility (`canSee`/`scope.ts`), not by role.

**MCP tools have no role checks at all.** `decide_approval` and
`revoke_approval_grant` — both administrative-feeling — are callable by any
agent via MCP today, with no operator restriction, even though the REST
equivalents for adjacent actions (clearance policy writes) require operator.
*(2026-09-30: `decide_approval` now refuses every agent on a clearance — a person decides it; see the table below.)*

## Target model

### Roles (unchanged names, now consistently distinct)

- **owner** — one or more per workspace. Can do everything admin can, plus the
  handful of actions in the table below marked owner-only.
- **admin** — workspace-administrative actions short of the owner-only set.
- **member** — a human with a workspace login but no administrative rights;
  today this maps to `agentRole: 'agent'`, i.e. same ceiling as a plain agent key.
- **operator (bare API key, no human account)** — kept for backward compat with
  every existing single-operator deployment and the CLI/`connect` bootstrap
  flow. Treated as **admin-equivalent**, not owner-equivalent, by default (see
  "Migration" below for why this is a behavior change worth calling out
  explicitly rather than silently keeping the current owner-equivalent
  treatment).
- **agent** — a task-executing agent identity with no administrative rights.

### Permission table (resource × action → minimum role)

This is the actual deliverable: one explicit table, one source of truth, read
by both REST middleware and MCP tool dispatch.

| Resource | Action | Minimum role | Today |
|---|---|---|---|
| Org kill switch (pause/resume) | any | **owner** | owner (#250) — unchanged |
| Workspace members | remove, change role | **owner** | admin (via requireWorkspaceAdmin) — **tightens** |
| Workspace members | invite, revoke invite, list | admin | admin — unchanged |
| Agent keys | rotate, delete | **owner** | admin (via requireOperator) — **tightens** |
| Agent keys | create | admin | admin — unchanged |
| Connect codes, devices | create, list, revoke | admin | admin — unchanged |
| Projects, project-links, project-isolation | read, write | admin | admin — unchanged |
| Sessions (`/v1/org/sessions`) | read, patch | admin | admin — unchanged |
| Clearance policy | write, delete | admin | admin — unchanged |
| Clearance policy | read (list/get) | member | admin — **loosens** (already-visible policy, no reason to gate a read) |
| Org usage (`/v1/org/usage`) | read | admin | admin — unchanged |
| Approval decisions (MCP `decide_approval`, REST `POST /v1/approvals/:id/decide`) | decide | **agent** | any agent — unchanged, but **self-decision-block stays**. (Corrected from an earlier draft's "member": MCP has no member-session path at all, so "member" would have locked out every plain agent-key caller — see step 3 below) **Superseded 2026-09-30 (migration 53, docs/superpowers/plans/2026-09-30-person-approvals.md):** the role gate is still `agent`, but a clearance is person-required, so only a signed-in person's console session decides it; every agent key, device credential and connector token is refused with 403. |
| Approval grants (MCP `revoke_approval_grant`, REST `DELETE /v1/approval-grants/:id`) | revoke | **agent** | any agent — **unchanged** (operator decision: don't over-restrict a routine agent-to-agent action; same "agent" correction as above) |
| Webhook registration (`POST /v1/webhook`) | set own webhook | agent | agent (self only, `WHERE id = req.agentId`) — **unchanged**. Corrected after implementation review: this was initially proposed as admin-gated on the assumption it configures org-wide webhook delivery, but the route only ever sets the *caller's own* `webhook_url` (per-agent self-service, analogous to a notification preference) — there's no endpoint for an admin to set another agent's webhook, so admin-gating this route would just remove the ability for bare agent-key identities to self-configure at all. Operator confirmed: leave self-service; a real "admin configures another agent's webhook" capability would be its own separate unit if ever needed |
| Messages, tasks, memory, files (create/read/act within visibility scope) | — | agent | agent — unchanged |

Rows marked "tightens" are real behavior changes and need a migration note
(below), not silent enforcement — an admin who could rotate their own org's
agent keys yesterday can't today without asking an owner. Rows marked
"loosens" are the opposite: removing an unnecessary restriction.

### Enforcement mechanism

A single function, not a new middleware per role:

```ts
// src/permissions.ts
type Role = "owner" | "admin" | "member" | "agent";
type Action = "org.pause" | "members.invite" | "members.changeRole" | "agentKeys.rotate" | /* ... */;

const RANK: Record<Role, number> = { agent: 0, member: 1, admin: 2, owner: 3 };
const REQUIRED: Record<Action, Role> = { "org.pause": "owner", "agentKeys.rotate": "owner", /* ... */ };

export function can(callerRole: Role, action: Action): boolean {
  return RANK[callerRole] >= RANK[REQUIRED[action]];
}
```

`callerRole` is derived once per request from the same identity resolution
`requireAgentAuth` already does: a member-session caller gets their real
`memberRole`; a bare API-key operator maps to `'admin'` (not `'owner'`) unless
the workspace has zero human owners yet (bootstrap exception, see below); a
plain agent key maps to `'agent'`.

REST: one `requirePermission(action)` middleware replaces `requireOperator`/
`requireOwner`/`requireWorkspaceAdmin` call sites. MCP: `handleScopedMcpRequest`
computes `callerRole` once (same derivation) and each tool handler that needs
more than `'agent'` calls `can()` before acting — starting with
`decide_approval` (member — no change, now explicit) and `revoke_approval_grant`
(member — no change, now explicit; operator decided not to tighten this one).

### Bootstrap exception

A workspace created via the bootstrap key or `connect` flow before any human
account exists has no owner yet. In that state, the bare operator key **is**
owner-equivalent — there's no one else it could defer to. The moment a human
accepts an invite and becomes the workspace's first owner (accounts.ts's
existing "first member is owner" logic), the bare key drops to admin-equivalent
for every future request. This is a state check (`SELECT EXISTS(... role='owner'
...)`), not a role stored anywhere new.

## Migration

1. **Additive first — DONE**: `src/permissions.ts` ships `can()`/`roleFor()`
   with every row set to today's actual behavior (`agentKeys.rotate: "admin"`,
   not `"owner"` yet). `requirePermission(action)` replaced every
   `requireOperator`/`requireOwner`/`requireWorkspaceAdmin` call site in
   `src/rest.ts` 1:1. Verified pure refactor: full suite (144 files, 1779
   tests) passes unchanged, plus a new `tests/permissions.test.ts` locking in
   `can()`'s rank logic and the bare-operator bootstrap exception.
2. **Tighten — DONE**: `agentKeys.rotate`, `agentKeys.delete`,
   `members.changeRole` and `members.remove` now require `"owner"`.
   `members.invite` stays admin-level (see the note at the top of this doc).
   Real behavior change, exercised directly: `tests/accounts.test.ts` gained
   an admin-denied/owner-allowed case for agent key rotate/delete (mirroring
   the existing pause/resume case) and the existing role-promotion test was
   updated to show an admin can no longer promote a member (403) — only an
   owner can (200). Full suite: 145 files, 1786 tests, 0 failures. Still
   outstanding, as a follow-up rather than a design gap: a changelog line and
   console-visible copy telling existing admins their agent-key and
   membership-management access just narrowed.
3. **MCP parity — DONE**: `can()` now gates `decide_approval` and
   `revoke_approval_grant` in `src/mcp.ts`, and their REST equivalents
   (`POST /v1/approvals/:id/decide`, `DELETE /v1/approval-grants/:id`) in
   `src/rest.ts` — both read `approval.decide`/`approvalGrant.revoke` from
   the same table now, both `REQUIRED: "agent"`. A genuine no-op (every
   authenticated caller already had access), caught and fixed before merge:
   the table originally said `"member"` for these two, which is a rank MCP
   can never actually produce (`AuthedAgent` has no memberRole field at
   all), so it would have silently locked out every plain agent-key caller
   the moment MCP's check went live. `tests/permissions.test.ts` gained an
   agent-tier assertion group to lock this in.

Each is independently revertable and testable; none require a schema change
(no new columns — `callerRole` is derived, not stored).

## Test plan

- A generated table-driven test (same style as `tests/cross-org-isolation.test.ts`'s
  router-introspection trick): for every `Action` in `REQUIRED`, assert a member,
  an admin, and an owner get the expected 200/403 split. New actions added to the
  enum without a REQUIRED entry fail the test, the same way new routes without an
  isolation case fail today.
- Regression tests for the three "tightens" rows specifically (an admin who
  could do X yesterday gets 403 today) and the bootstrap exception (bare
  operator key on a zero-owner workspace still passes owner-gated actions).

## Decisions (operator, 2026-09-18)

1. **Owner-only** for member removal/role-change and agent-key
   rotation/delete, as proposed — not narrowed to just membership/ownership.
2. `revoke_approval_grant` **stays at member** — don't over-restrict a routine
   agent-to-agent action.
3. **Webhook registration gets its own row** — corrected after review (see the
   table): it's per-agent self-service, not org config, so it stays agent-level,
   unchanged. Confirmed with the operator 2026-09-18.

No further open questions. Next step is implementation, per the "Migration"
plan above.
