import { createHash, randomBytes } from "node:crypto";
import { db, newId } from "./db.js";
import { emitEvent } from "./events.js";
import { disconnectAgent } from "./live.js";
import { scheduleConsoleAccessRecheck } from "./console-live.js";
import { endHeldRequests } from "./revocation.js";
import { checkAgentName, AgentNameError, createOrganization, MAX_AGENT_NAME_CHARS, registerAgent } from "./service.js";
import { hashKey } from "./auth.js";
import { clipToUnits, heldNames, safeNameBase } from "./agent-names.js";
import { PENDING_PLAN, signupPlan } from "./billing.js";
import { closeConnectorGrants, endConnectorConnections } from "./oauth.js";
import { can } from "./permissions.js";
import type { VerifiedIdentity } from "./supabase-auth.js";

/** People, sessions, workspace membership and invites (docs/design/ACCOUNTS.md). A person acts in a workspace
 * through a member agent row (key_class 'human'), so every existing route, event and approval works unchanged
 * and shows the person's name. Agents keep their keys. */

export const MEMBER_ROLES = ["owner", "admin", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const isMemberRole = (v: unknown): v is MemberRole => typeof v === "string" && (MEMBER_ROLES as readonly string[]).includes(v);

export const SESSION_COOKIE = "oc_session";
export const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

export class AccountError extends Error {
  /** `code` is optional and additive: it lets a client branch on a machine-readable discriminator
   * instead of on the human message (docs/design/SELF-SERVE-BACKEND.md §5.1). `accountError` in
   * src/rest.ts must serialize it -- setting it here alone never reaches the client. */
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export interface Person {
  id: string;
  email: string | null;
  email_verified: number;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
  last_sign_in_at: string | null;
}

export const displayName = (p: Pick<Person, "name" | "email">) => p.name || p.email?.split("@")[0] || "Member";
const publicPerson = (p: Person) => ({ id: p.id, name: displayName(p), email: p.email, avatarUrl: p.avatar_url });

// --- people and sessions ----------------------------------------------------------

export function upsertPerson(identity: VerifiedIdentity): Person {
  db.prepare(
    `INSERT INTO people (id, email, email_verified, name, avatar_url, created_at, last_sign_in_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET email = excluded.email, email_verified = excluded.email_verified,
       name = COALESCE(excluded.name, people.name), avatar_url = COALESCE(excluded.avatar_url, people.avatar_url),
       last_sign_in_at = excluded.last_sign_in_at`,
  ).run(identity.id, identity.email, identity.emailVerified ? 1 : 0, identity.name, identity.avatarUrl, iso(Date.now()), iso(Date.now()));
  return getPerson(identity.id)!;
}

export const getPerson = (id: string) => db.prepare(`SELECT * FROM people WHERE id = ?`).get(id) as Person | undefined;

/** Returns the raw session token for the cookie; only its hash is stored. */
export function createSession(personId: string): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = iso(now + SESSION_DAYS * 86_400_000);
  db.prepare(`INSERT INTO sessions (token_hash, person_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(sha256(token), personId, iso(now), iso(now), expiresAt);
  return { token, expiresAt };
}

/** The person behind a session cookie, or null. Sliding: a session used more than a day after its last use is extended. */
export function sessionPerson(token: string | undefined, nowMs = Date.now()): Person | null {
  if (!token) return null;
  const row = db.prepare(`SELECT person_id, last_used_at, expires_at FROM sessions WHERE token_hash = ?`).get(sha256(token)) as
    { person_id: string; last_used_at: string; expires_at: string } | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) <= nowMs) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256(token));
    return null;
  }
  if (nowMs - Date.parse(row.last_used_at) > 86_400_000) {
    db.prepare(`UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?`)
      .run(iso(nowMs), iso(nowMs + SESSION_DAYS * 86_400_000), sha256(token));
  }
  return getPerson(row.person_id) ?? null;
}

export function deleteSession(token: string | undefined): void {
  if (token) {
    const deleted = db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256(token)).changes;
    if (deleted) scheduleConsoleAccessRecheck();
  }
}

export function sweepExpiredSessions(nowMs = Date.now()): number {
  const deleted = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(iso(nowMs)).changes;
  if (deleted) scheduleConsoleAccessRecheck();
  return deleted;
}

// --- membership ----------------------------------------------------------------------

export interface Membership {
  org_id: string;
  person_id: string;
  role: MemberRole;
  agent_id: string;
  created_at: string;
}

export const getMembership = (orgId: string, personId: string) =>
  db.prepare(`SELECT * FROM workspace_members WHERE org_id = ? AND person_id = ?`).get(orgId, personId) as Membership | undefined;

export function listWorkspaces(personId: string): Array<{ orgId: string; name: string; role: MemberRole; paused: boolean }> {
  return (db.prepare(
    `SELECT m.org_id, o.name, m.role, o.paused_at FROM workspace_members m JOIN organizations o ON o.id = m.org_id
     WHERE m.person_id = ? ORDER BY o.name`,
  ).all(personId) as Array<{ org_id: string; name: string; role: MemberRole; paused_at: string | null }>)
    .map((r) => ({ orgId: r.org_id, name: r.name, role: r.role, paused: Boolean(r.paused_at) }));
}

export const agentRoleFor = (role: MemberRole) => (role === "member" ? "agent" : "operator");

/** The longest suffix memberAgentName adds: every candidate fits MAX_AGENT_NAME_CHARS with it. */
const MEMBER_SUFFIX_ROOM = " (99)".length;

/** A unique display name among the workspace's agents: "Ada", then "Ada (2)". The person's display name is only made
 * safe first (safeNameBase): an emoji's zero-width joiner or a mixed-script name must not stop them joining. Its length
 * is capped in UTF-16 units, as checkAgentName counts it, leaving room for the suffix, so a name of emoji or one NFKC
 * expands can never fail sign-up or an invite on length. */
export function memberAgentName(orgId: string, base: string): string {
  const held = heldNames(orgId);
  let root = clipToUnits(safeNameBase(base), MAX_AGENT_NAME_CHARS - MEMBER_SUFFIX_ROOM) || "Member";
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? root : `${root} (${n})`;
    try {
      return checkAgentName(orgId, candidate, undefined, { held });
    } catch (err) {
      if (!(err instanceof AgentNameError)) throw err;
      // A reserved word is not made free by a number ("Operator (2)" is still the hub's word), and a name that breaks
      // a rule never will be (a final guard: safeNameBase should not leave one): the fallback instead. Joining a
      // workspace never fails on a name.
      if ((err.status === 400 || err.reason === "reserved") && root !== "Member") {
        root = "Member";
        n = 0;
      } else if (err.status !== 409) {
        throw err;
      }
    }
  }
  throw new AccountError("couldn't pick a unique member name", 409);
}

/** Adds a person to a workspace with a member agent. Call inside a transaction. */
function addMember(orgId: string, person: Person, role: MemberRole, invitedBy: string | null): Membership {
  const agentId = newId();
  const name = memberAgentName(orgId, displayName(person));
  // A person never authenticates with this row's key: the hash is of random bytes that are never kept.
  db.prepare(
    // People see the whole workspace (PROJECT_ISOLATION.md §3.2): scope 'workspace', no home project.
    `INSERT INTO agents (id, org_id, name, url_key, api_key_hash, role, key_class, scope) VALUES (?, ?, ?, ?, ?, ?, 'human', 'workspace')`,
  ).run(agentId, orgId, name, `member-${agentId}`, hashKey(randomBytes(32).toString("hex")), agentRoleFor(role));
  db.prepare(`INSERT INTO workspace_members (org_id, person_id, role, agent_id, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(orgId, person.id, role, agentId, invitedBy, iso(Date.now()));
  emitEvent({ orgId, type: "member.joined", actor: { id: agentId, name }, subjectType: "member", subjectId: person.id, payload: { name, role } });
  return getMembership(orgId, person.id)!;
}

/** Whether this hub admits NEW workspaces: the sign-up kill switch, `OPENCADRE_SIGNUP`.
 *
 * WHY THIS EXISTS AGAIN, AND WHY IT IS NOT THE OLD FLAG. 165c7850 removed `OPENCADRE_SIGNUP` along with
 * the waitlist, on the decision that sign-up is open to every verified person -- and it hardcoded
 * `"open"`. That decision stands: the default here is OPEN, unset means open, and nothing below brings
 * back the waitlist, its table's routes, or an approval step. What that commit also removed, as a side
 * effect rather than a decision, was the operator's only way to stop new sign-ups during abuse without
 * a deploy; LAUNCH-CHECKLIST §7 still told the operator to set `OPENCADRE_SIGNUP=waitlist`, which had
 * silently become a no-op. This restores the switch and nothing else: `closed` refuses new workspaces.
 * It does not touch existing workspaces, sign-in, invites, or any other route.
 *
 * VALUES, trimmed and case-insensitive: unset, empty, `open` or `waitlist` -> open; `closed` and EVERY
 * other value -> closed. An emergency switch fails closed: an operator who typed `clsoed` during an abuse
 * incident meant to shut the door, and leaving it open would be the silent failure (review of #633 by
 * Codex-OpenCadre-049a). The open list is explicit, not a default:
 *   - `waitlist` MUST stay open. It was the documented pre-launch value, so it may still sit in a
 *     production `.env`; 165c7850 made it inert on purpose, and its test ("the retired signup flag
 *     cannot restore the waitlist gate") pins that. Treating it as closed would shut sign-ups on the
 *     next deploy of any hub that never cleaned the line up -- silently, at launch.
 *   - The cost moves the other way: a stray value in `.env` now closes sign-ups. Reading the switch back
 *     catches either mistake: `GET /v1/auth/config` answers `"signup"` with what actually took
 *     (LAUNCH-CHECKLIST §7 makes that the verify step, after an edit AND after every deploy). */
const SIGNUP_OPEN_VALUES = new Set(["", "open", "waitlist"]);
/**
 *
 * READ AT CALL TIME from `env` (default `process.env`), not captured at startup -- so tests can flip it
 * per request. On the production box that is not a live toggle: a container's environment only changes
 * when it restarts, so an edit to `/opt/opencadre/.env` still needs a restart (LAUNCH-CHECKLIST §7).
 *
 * The return type stays the field `/v1/auth/config` has always sent. Both readers already treat any
 * value other than `"open"` as not-open (public/site/signup-cta.mjs `signupIsAvailable`, the console's
 * `applySignupWording`), so `"closed"` needs no client change to make them stop inviting sign-ups. */
export type SignupMode = "open" | "closed";
export function signupMode(env: NodeJS.ProcessEnv = process.env): SignupMode {
  const raw = (env.OPENCADRE_SIGNUP ?? "").trim().toLowerCase();
  return SIGNUP_OPEN_VALUES.has(raw) ? "open" : "closed";
}

/** Browser sessions must prove ownership of an email before creating a workspace. */
export const EMAIL_UNVERIFIED = "E_EMAIL_UNVERIFIED";

/** The kill switch is on (`OPENCADRE_SIGNUP=closed`). Its own code, distinct from EMAIL_UNVERIFIED,
 * because the person can do nothing about it and the console must not tell them to check their inbox. */
export const SIGNUP_CLOSED = "E_SIGNUP_CLOSED";

/** Whether a person may create a workspace -- read by `/v1/auth/me`, whose `canCreateWorkspace` is what
 * makes the console hide the create form and show its ask-for-an-invite note. It depends only on the
 * hub's switch: every signed-in person is equally entitled while sign-up is open. */
export function canCreateWorkspace(_person: Person): boolean { return signupMode() === "open"; }

/** The domain rule `createWorkspace` enforces. Here rather than only in the route so the one writer of
 * new workspaces carries it, whoever calls it; the route is currently the only caller. */
export function workspaceCreationRefusal(person: Person): { code: string; message: string } | null {
  if (canCreateWorkspace(person)) return null;
  return {
    code: SIGNUP_CLOSED,
    message: "New workspaces can't be created on this hub right now. If you were invited to a workspace, use the invite link; existing workspaces are unaffected.",
  };
}

/** The HTTP route checks the verified email before minting the first agent key. */
export function unverifiedEmailRefusal(person: Person): { code: string; message: string } | null {
  if (person.email && person.email_verified) return null;
  return { code: EMAIL_UNVERIFIED, message: "Verify your email address, then try again." };
}
export interface CreatedWorkspace {
  orgId: string;
  name: string;
  role: MemberRole;
  /** True when this person already had a workspace by that name and it was returned instead of creating
   * a second one (§6.4). The console can use it to say "you already have this workspace". */
  existing?: boolean;
  /** The person's first agent key, returned exactly once. Recovery is by
   * rotation, never by re-reading this (only its hash is stored, src/auth.ts). Absent on a re-submit. */
  agent?: { agentId: string; agentName: string; apiKey: string; urlKey: string };
}

/** The name the self-serve first key gets. Distinct from the person's own member-agent name, which
 * `addMember` has already claimed in the same workspace. */
export const FIRST_AGENT_NAME = "First Agent";

export function createWorkspace(person: Person, rawName: unknown): CreatedWorkspace {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > 80) throw new AccountError("Give the workspace a name of 1 to 80 characters.", 400);
  const refusal = workspaceCreationRefusal(person);
  if (refusal) throw new AccountError(refusal.message, 403, refusal.code);
  return db.transaction(() => {
    // Idempotent by natural key (docs/design/SELF-SERVE-BACKEND.md §6.4): a double-submit — the same
    // person, the same workspace name — returns the workspace they already have instead of creating a
    // second one. The generic `idempotent()` middleware cannot be used here: it keys on
    // `(org_id, agent_id, key)`, and a person creating their FIRST workspace has neither yet. The
    // person is already a unique actor, so their own existing workspace with that name is the key.
    // Inside the transaction, so two concurrent submits cannot both pass the check (SQLite serialises
    // writers here). Deliberately scoped to the person: a second person naming their workspace "Acme"
    // is a different workspace and must not be blocked or joined.
    const existing = db.prepare(
      `SELECT o.id AS org_id, o.name, m.role FROM organizations o
       JOIN workspace_members m ON m.org_id = o.id
       WHERE m.person_id = ? AND lower(o.name) = lower(?)`,
    ).get(person.id, name) as { org_id: string; name: string; role: MemberRole } | undefined;
    if (existing) {
      // No key is re-minted: the first one was returned once and only its hash is stored, so a
      // double-submit must not silently issue a second credential (recovery is rotate, not re-read).
      return { orgId: existing.org_id, name: existing.name, role: existing.role, existing: true };
    }
    // A person may hold only one live free trial as owner. The check sits after the natural-key
    // retry above and inside the same transaction as creation, so double-submit still returns
    // the first workspace and parallel creates cannot mint two fresh trials. A live trial is either kind: the hub-side
    // (cardless) clock, or a card-required the payment provider trial (`subscription_status = 'trialing'`), which carries no hub clock
    // and would otherwise escape this check.
    // Keyed on the PERSON: a workspace they own now OR one they created (migration 50), so handing ownership to someone
    // else and stepping down does not free them to start another.
    const theirs = `(o.created_by_person_id = ? OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.org_id = o.id AND m.person_id = ? AND m.role = 'owner'))`;
    const activeTrial = db.prepare(
      `SELECT o.id FROM organizations o
       WHERE ${theirs}
         AND ((o.plan = 'trial' AND datetime(o.trial_ends_at) > datetime(?)) OR o.subscription_status = 'trialing') LIMIT 1`,
    ).get(person.id, person.id, iso(Date.now()));
    if (activeTrial) throw new AccountError("You already own a workspace with an active trial. Choose a plan for it before creating another workspace.", 402, "ACTIVE_TRIAL_WORKSPACE");
    // THE TRIAL MODE decides what the new workspace starts on (src/billing.ts signupPlan): under `card` (the launch
    // behaviour) it is "No plan yet" until its owner starts the 7-day card-required trial in checkout; under `cardless`
    // it gets the hub-side trial clock, as before.
    const plan = signupPlan();
    // AT MOST ONE UNSTARTED WORKSPACE PER OWNER. A "No plan yet" workspace is a trial waiting to be started; a second one
    // would let one person line up several first checkouts. Refused with the waiting workspace's id, so the console takes
    // the person straight to it (public/app/app.js) instead of showing a dead end. Inside the same transaction as the
    // create, so two parallel submits cannot both pass it.
    if (plan === PENDING_PLAN) {
      const waiting = db.prepare(
        `SELECT o.id, o.name FROM organizations o WHERE ${theirs} AND o.plan = ? LIMIT 1`,
      ).get(person.id, person.id, PENDING_PLAN) as { id: string; name: string } | undefined;
      if (waiting) {
        throw new AccountError(
          `Your workspace "${waiting.name}" is waiting for its free trial to start. Choose a plan for it before creating another workspace.`,
          409, "WORKSPACE_PENDING", { workspace: { orgId: waiting.id, name: waiting.name } },
        );
      }
    }
    const { orgId } = createOrganization(name, plan);
    db.prepare(`UPDATE organizations SET created_by_person_id = ? WHERE id = ?`).run(person.id, orgId);
    addMember(orgId, person, "owner", null);
    // A workspace with no plan yet gets NO first agent key: nothing can use one until the trial starts (every limit on
    // PENDING_PLAN is 0), and handing out a credential the workspace cannot use is the "key with nothing behind it" the
    // console would then have to explain. Keys are created from the console once the trial is running.
    if (plan === PENDING_PLAN) return { orgId, name, role: "owner" as MemberRole };
    // Self-serve: hand the person a working operator key in the same round trip, so they are not left
    // holding a session cookie and nothing to connect an agent with (the hole in §2.3). Minted through
    // the ordinary registerAgent path so rotate/revoke/RBAC/events all apply to it unchanged.
    //
    // It needs a name of its own: `addMember` above already took the person's display name for their
    // member agent, and checkAgentName refuses a duplicate within the workspace. "First Agent" is the
    // workspace's first connectable identity, which is what the console will show in the roster; the
    // person can rename it later through the existing routes.
    const agent = registerAgent(orgId, FIRST_AGENT_NAME, { role: "operator" });
    return { orgId, name, role: "owner" as MemberRole, ...(agent ? { agent } : {}) };
  })();
}

export function listMembers(orgId: string) {
  const members = db.prepare(
    `SELECT m.person_id, m.role, m.created_at, a.name AS agent_name, p.email, p.name, p.avatar_url
     FROM workspace_members m JOIN people p ON p.id = m.person_id JOIN agents a ON a.id = m.agent_id
     WHERE m.org_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, a.name`,
  ).all(orgId) as Array<{ person_id: string; role: MemberRole; created_at: string; agent_name: string; email: string | null; name: string | null; avatar_url: string | null }>;
  const invites = db.prepare(
    `SELECT id, role, email, created_by_name, created_at, expires_at FROM workspace_invites
     WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
  ).all(orgId, iso(Date.now())) as Array<{ id: string; role: MemberRole; email: string | null; created_by_name: string; created_at: string; expires_at: string }>;
  return {
    members: members.map((m) => ({ personId: m.person_id, name: m.agent_name, email: m.email, avatarUrl: m.avatar_url, role: m.role, joinedAt: m.created_at })),
    invites: invites.map((i) => ({ id: i.id, role: i.role, email: i.email, invitedBy: i.created_by_name, createdAt: i.created_at, expiresAt: i.expires_at })),
  };
}

type Actor = { id: string; name: string };

export function changeRole(orgId: string, actor: Actor & { memberRole: MemberRole | null }, personId: string, role: MemberRole): void {
  let closedConnectors: string[] = [];
  const demoted = db.transaction((): string | null => {
    const target = getMembership(orgId, personId);
    if (!target) throw new AccountError("That person isn't a member of this workspace.", 404);
    if (target.role === role) return null;
    // Admins manage members and admins; only owners (or an Operator key) touch ownership.
    const touchesOwner = target.role === "owner" || role === "owner";
    if (touchesOwner && actor.memberRole === "admin") throw new AccountError("Only an owner can change ownership.", 403);
    if (target.role === "owner" && ownerCount(orgId) === 1) throw new AccountError("A workspace needs at least one owner. Make someone else an owner first.", 409);
    db.prepare(`UPDATE workspace_members SET role = ? WHERE org_id = ? AND person_id = ?`).run(role, orgId, personId);
    db.prepare(`UPDATE agents SET role = ? WHERE id = ?`).run(agentRoleFor(role), target.agent_id);
    // A role that may no longer add agents may no longer keep a connector either (MCP-CONNECTOR security review S2).
    if (!can(role, "agents.create")) closedConnectors = closeConnectorGrants({ orgId, personId }, actor);
    emitEvent({ orgId, type: "member.role_changed", actor, subjectType: "member", subjectId: personId, payload: { from: target.role, to: role } });
    return agentRoleFor(target.role) === "operator" && agentRoleFor(role) !== "operator" ? target.agent_id : null;
  })();
  endConnectorConnections(closedConnectors, "your role in this workspace changed");
  // A demotion takes effect on open connections too: they reconnect under the new role.
  if (demoted) {
    disconnectAgent(demoted, "your role changed");
    endHeldRequests(demoted, 409, "Your role in this workspace changed. Reload to continue.");
  }
}

export function removeMember(orgId: string, actor: Actor & { memberRole: MemberRole | null; personId: string | null }, personId: string): void {
  const target = db.transaction(() => {
    const t = getMembership(orgId, personId);
    if (!t) throw new AccountError("That person isn't a member of this workspace.", 404);
    const self = actor.personId === personId;
    if (!self && t.role === "owner" && actor.memberRole === "admin") throw new AccountError("Only an owner can remove an owner.", 403);
    if (t.role === "owner" && ownerCount(orgId) === 1) throw new AccountError("A workspace needs at least one owner. Make someone else an owner first.", 409);
    // Retire any historically issued member-row bearer in the SAME transaction as membership removal.
    // This placeholder is not a SHA-256 digest, so no bearer can hash to it. Keep the row/name/history and
    // the person's global console sessions: membership checks withdraw only this workspace's access.
    db.prepare(`UPDATE agents SET api_key_hash = ? WHERE id = ? AND org_id = ?`)
      .run(`member-removed:${randomBytes(32).toString("hex")}`, t.agent_id, orgId);
    // Standing authority ends with membership, atomically with credential retirement.
    db.prepare(`DELETE FROM approval_grants WHERE org_id = ? AND granted_by_person_id = ?`).run(orgId, personId);
    db.prepare(`DELETE FROM workspace_members WHERE org_id = ? AND person_id = ?`).run(orgId, personId);
    // Their MCP connectors go with them (security review S2).
    const closed = closeConnectorGrants({ orgId, personId }, actor);
    emitEvent({ orgId, type: "member.removed", actor, subjectType: "member", subjectId: personId, payload: { self } });
    return { ...t, closed };
  })();
  endConnectorConnections(target.closed, "removed from the workspace");
  // Their console connections in this workspace end now, like a rotated key (R3).
  disconnectAgent(target.agent_id, "removed from the workspace");
  endHeldRequests(target.agent_id, 403, "You're no longer a member of this workspace.");
}

const ownerCount = (orgId: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE org_id = ? AND role = 'owner'`).get(orgId) as { n: number }).n;

// --- invites -----------------------------------------------------------------------

interface InviteRow {
  id: string;
  org_id: string;
  role: MemberRole;
  email: string | null;
  created_by_name: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export function createInvite(orgId: string, actor: Actor, role: MemberRole, rawEmail: unknown): { id: string; token: string; role: MemberRole; email: string | null; expiresAt: string } {
  const email = typeof rawEmail === "string" && rawEmail.trim() ? rawEmail.trim().toLowerCase() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError("That email address doesn't look right.", 400);
  const token = `oci_${randomBytes(24).toString("base64url")}`;
  const id = newId();
  const expiresAt = iso(Date.now() + INVITE_DAYS * 86_400_000);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO workspace_invites (id, org_id, token_hash, role, email, created_by_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, sha256(token), role, email, actor.name, iso(Date.now()), expiresAt);
    emitEvent({ orgId, type: "invite.created", actor, subjectType: "member", subjectId: id, payload: { role, emailLocked: Boolean(email) } });
  })();
  return { id, token, role, email, expiresAt };
}

export function revokeInvite(orgId: string, actor: Actor, inviteId: string): boolean {
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE workspace_invites SET revoked_at = ? WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`)
      .run(iso(Date.now()), inviteId, orgId).changes;
    if (changed) emitEvent({ orgId, type: "invite.revoked", actor, subjectType: "member", subjectId: inviteId, payload: {} });
    return changed > 0;
  })();
}

const findInvite = (token: string) =>
  (typeof token === "string" && token.startsWith("oci_")
    ? db.prepare(`SELECT * FROM workspace_invites WHERE token_hash = ?`).get(sha256(token))
    : undefined) as InviteRow | undefined;

function inviteProblem(invite: InviteRow | undefined, nowMs: number): string | null {
  if (!invite) return "This invite link isn't valid. Ask for a new one.";
  if (invite.revoked_at) return "This invite was revoked. Ask for a new one.";
  if (invite.accepted_at) return "This invite was already used. Ask for a new one.";
  if (Date.parse(invite.expires_at) <= nowMs) return "This invite expired. Ask for a new one.";
  return null;
}

const maskEmail = (email: string) => {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 1)}${"•".repeat(Math.max(1, user.length - 1))}@${domain}`;
};

/** What the accept page shows before sign-in. Never reveals the full locked email. */
export function describeInvite(token: string, nowMs = Date.now()) {
  const invite = findInvite(token);
  const problem = inviteProblem(invite, nowMs);
  if (!invite) return { valid: false, problem };
  const org = db.prepare(`SELECT name FROM organizations WHERE id = ?`).get(invite.org_id) as { name: string } | undefined;
  return {
    valid: !problem,
    problem,
    workspaceName: org?.name ?? null,
    role: invite.role,
    invitedBy: invite.created_by_name,
    lockedToEmail: invite.email ? maskEmail(invite.email) : null,
    expiresAt: invite.expires_at,
  };
}

export function acceptInvite(token: string, person: Person, nowMs = Date.now()): { orgId: string; name: string; role: MemberRole; alreadyMember: boolean } {
  return db.transaction(() => {
    const invite = findInvite(token);
    const problem = inviteProblem(invite, nowMs);
    if (problem) throw new AccountError(problem, invite ? 410 : 404);
    if (invite!.email && (!person.email_verified || person.email?.toLowerCase() !== invite!.email)) {
      throw new AccountError(`This invite is for ${maskEmail(invite!.email)}. Sign in with that account to accept it.`, 403);
    }
    const org = db.prepare(`SELECT name FROM organizations WHERE id = ?`).get(invite!.org_id) as { name: string };
    const existing = getMembership(invite!.org_id, person.id);
    if (existing) return { orgId: invite!.org_id, name: org.name, role: existing.role, alreadyMember: true };
    db.prepare(`UPDATE workspace_invites SET accepted_at = ?, accepted_by = ? WHERE id = ?`).run(iso(nowMs), person.id, invite!.id);
    addMember(invite!.org_id, person, invite!.role, invite!.created_by_name);
    return { orgId: invite!.org_id, name: org.name, role: invite!.role, alreadyMember: false };
  })();
}

export { publicPerson };
