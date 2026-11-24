// Stage 3 RBAC (docs/design/rbac-permission-model.md). One explicit table, read
// by REST middleware (and, in a later PR, MCP tool dispatch) so a human owner,
// a human admin, and a bare API-key operator get the same answer for the same
// action instead of each route hand-rolling its own role check.
//
// Migration step 1 was a pure refactor: every REQUIRED value matched the
// gating it replaced exactly. Step 2 tightened four rows to "owner" per the
// design doc's Decisions section -- a real behavior change for existing
// admins, not a refactor: agentKeys.rotate, agentKeys.delete,
// members.changeRole, members.remove. members.invite stays admin-level
// (confirmed with the operator after the design doc's table originally,
// incorrectly, lumped invite in with remove/changeRole).
//
// Step 3 (this version) adds MCP parity: approval.decide and
// approvalGrant.revoke, called from src/mcp.ts's decide_approval and
// revoke_approval_grant tools. Both are REQUIRED: "agent" -- the lowest
// rank, i.e. no restriction beyond authentication -- matching today's
// actual behavior exactly (any agent may decide another's approval or
// revoke a grant). The design doc's table originally listed these as
// "member", which would have been a real regression: MCP has no cookie/
// member-session path at all (AuthedAgent in src/auth.ts carries only
// role: "agent" | "operator", never a memberRole), so every real MCP
// caller is either "agent" or "owner" (a bare operator key) via roleFor()
// below -- never "member". Requiring "member" would have locked out every
// plain agent-key caller, which is nearly all of them. Corrected here.
//
// Step 4 (this version) adds billing.manage for POST /v1/billing/checkout
// (billing Phase 2 increment 3). REQUIRED: "owner", the same tier as
// org.pause/org.resume and for the same reason -- starting a payment commits
// the whole workspace to a recurring charge. The row is new alongside a new
// route, so no existing key or session gains or loses anything by it.
//
// Step 5 adds agents.webhook for PUT/GET /v1/org/agents/:agentId/webhook: a
// person sets another agent's wake webhook from the console, so an app that
// can't see its own trigger's key never carries it. REQUIRED: "admin", the
// same tier as agents.create. Also new alongside new routes.

export type Role = "owner" | "admin" | "member" | "agent";

export type Action =
  | "agents.create"
  | "agents.rotateKey"
  | "agents.delete"
  | "agents.webhook"
  | "orgUsage.read"
  | "connectCodes.manage"
  | "devices.manage"
  | "projects.manage"
  | "projectLinks.manage"
  | "projectIsolation.manage"
  | "sessions.manage"
  | "clearancePolicy.write"
  | "clearancePolicy.list"
  | "projectSettings.write"
  | "tasks.manage"
  | "members.list"
  | "members.invite"
  | "members.inviteRevoke"
  | "members.changeRole"
  | "members.remove"
  | "org.pause"
  | "org.resume"
  | "billing.manage"
  | "approval.decide"
  | "approvalGrant.revoke";

const RANK: Record<Role, number> = { agent: 0, member: 1, admin: 2, owner: 3 };

/** The required role for each action -- see the file header for what's changed since step 1. */
const REQUIRED: Record<Action, Role> = {
  "agents.create": "admin",
  "agents.rotateKey": "owner",
  "agents.delete": "owner",
  "agents.webhook": "admin",
  "orgUsage.read": "admin",
  "connectCodes.manage": "admin",
  "devices.manage": "admin",
  "projects.manage": "admin",
  "projectLinks.manage": "admin",
  "projectIsolation.manage": "admin",
  "sessions.manage": "admin",
  "clearancePolicy.write": "admin",
  "clearancePolicy.list": "admin",
  // The per-project WIP cap (src/project-settings.ts): GET /v1/org/projects/:key/settings stays readable by anyone who
  // can see the project; changing it is an admin's.
  "projectSettings.write": "admin",
  // Move any task on the work board (src/tasks.ts setTaskLane); its creator and its claimant may move it anyway.
  "tasks.manage": "admin",
  "members.list": "admin",
  "members.invite": "admin",
  "members.inviteRevoke": "admin",
  "members.changeRole": "owner",
  "members.remove": "owner",
  "org.pause": "owner",
  "org.resume": "owner",
  "billing.manage": "owner",
  // "agent" is only the role gate. What an agent may actually decide is narrower and lives in decideApproval
  // (src/approvals.ts, migration 53): a clearance is person-required, so only a signed-in person's console session
  // decides it; an agent could decide a 'supervisor' row, and none can exist until a person can designate one.
  "approval.decide": "agent",
  "approvalGrant.revoke": "agent",
};

/** `agents.role` is `"operator"` for both true owners/admins (pre-accounts era)
 * and bare API keys with no human account at all -- see requireOwner's own
 * comment in src/rest.ts for why a bare operator key is owner-equivalent (the
 * bootstrap exception the design doc describes). A member session carries its
 * real memberRole and always wins when present. */
export function roleFor(agentRole: "agent" | "operator" | undefined, memberRole: Role | undefined | null): Role {
  if (memberRole) return memberRole;
  if (agentRole === "operator") return "owner";
  return "agent";
}

export function can(callerRole: Role, action: Action): boolean {
  return RANK[callerRole] >= RANK[REQUIRED[action]];
}
