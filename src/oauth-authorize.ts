import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";
import { getMembership, type MemberRole } from "./accounts.js";
import { agentLimitRefusal, type PlanLimitRefusal } from "./billing.js";
import { can } from "./permissions.js";
import { enabledProjectKeys, listProjects, ProjectError, sanitizeProject, setProjectEnabled } from "./projects.js";
import { agentUrlKey, AgentNameError, checkAgentName, MAX_AGENT_NAME_CHARS } from "./service.js";
import { addressHeld, clipToUnits, describeClash, heldNames, isProfileName, isReservedName, type HeldNames, heldLookalike, lookalikeHeld, nameClash, nameProblem, safeNameBase } from "./agent-names.js";
import { acceptableRedirectUri, endConnectorConnections, redirectMatches, revokeAgentTokenRows } from "./oauth.js";
import { CIMD_RATE_LIMITED, isCimdClientId, peekClientMetadata, resolveClientMetadata } from "./oauth-cimd.js";

/**
 * The MCP connector's authorization step, data and rules (docs/design/MCP-CONNECTOR.md §3 "What an approval creates";
 * plan 2026-09-29 §7, Codex-OpenCadre-049a's amendments, binding over the plan's §3):
 *
 *  - §7.3 a validated GET /oauth/authorize becomes a single-use CONSENT row, and the page carries only its id and a
 *    CSRF token. The approve/deny POST takes client, redirect, resource, PKCE challenge and state from that row, never
 *    from the form, and marks it used atomically, so a second POST fails.
 *  - §7.7 the CSRF token is an HMAC over (the session, the consent id) with a server secret: two tabs of one session
 *    hold different tokens, and neither tab's token approves the other's consent.
 *  - §7.1/§7.2 one connector agent per (person, client, workspace, scope), scope = the chosen project when the
 *    workspace keeps projects apart, else the whole workspace ('*'). Approve is ONE transaction: an active grant whose
 *    agent is live is reused (the plan cap is not counted); otherwise the cap is checked and the agent and grant are
 *    inserted. The partial unique index makes a concurrent duplicate lose and retry as a reuse.
 *  - §7.6 uniqueness covers ACTIVE grants only: revokeGrant (Disconnect, PR3) and an agent's removal set revoked_at,
 *    and the next approval for that tuple creates a fresh grant and agent.
 *
 * Kept out of src/oauth.ts: this module needs the account, billing and project modules, and oauth.ts is imported by
 * the CIMD fetcher, so putting it there would close an import cycle.
 */

export const CONSENT_TTL_MS = 10 * 60_000;
export const CODE_TTL_SECONDS = 60;
/** The scope key of a grant for the whole workspace (no project chosen). Never a project key: projectKeyOf refuses it. */
export const WORKSPACE_SCOPE = "*";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code?.startsWith("SQLITE_CONSTRAINT") ?? false;

// --- The CSRF secret ----------------------------------------------------------------------------------------------------
// The hub had no server-wide secret before this (sessions, keys and codes are random values stored as hashes; the only
// HMAC is the payment provider's webhook, keyed by the payment provider's secret). OPENCADRE_OAUTH_SECRET, when set (32+ characters), keeps consent
// pages valid across a restart; unset, a random key is drawn per process, which costs nothing but this: a consent page
// open during a restart has to be started again from the app. It never leaves the process and is never logged.
const OAUTH_SECRET_MIN_CHARS = 32;

/** The CSRF key from the environment, and the problem to warn about, if any: a configured value shorter than
 * OAUTH_SECRET_MIN_CHARS is NOT used (a weak key would be worse than a random one); a random per-process key is, and
 * src/index.ts logs the problem at startup (security review N8). */
export function oauthSecretFrom(env: NodeJS.ProcessEnv): { key: Buffer; problem: string | null } {
  const configured = env.OPENCADRE_OAUTH_SECRET ?? "";
  if (configured.length >= OAUTH_SECRET_MIN_CHARS) return { key: Buffer.from(configured, "utf8"), problem: null };
  return {
    key: randomBytes(32),
    problem: configured
      ? `OPENCADRE_OAUTH_SECRET is shorter than ${OAUTH_SECRET_MIN_CHARS} characters, so it is not used: consent pages use a per-process key and must be started again after a restart`
      : null,
  };
}

let csrfKey: Buffer | undefined;
const serverSecret = (): Buffer => (csrfKey ??= oauthSecretFrom(process.env).key);

/** The consent page's CSRF token: HMAC(server secret, hash of the session token, consent id), plan §7.7. The session is
 * named by its hash, the same value the sessions table stores, so the raw cookie never enters the MAC. */
export function consentCsrf(sessionToken: string, consentId: string, key: Buffer = serverSecret()): string {
  return createHmac("sha256", key).update(`${sha256(sessionToken)}\n${consentId}`).digest("base64url");
}

export function csrfMatches(sessionToken: string | undefined, consentId: string, presented: unknown): boolean {
  if (!sessionToken || typeof presented !== "string" || !presented) return false;
  const expected = Buffer.from(consentCsrf(sessionToken, consentId));
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// --- Consents -----------------------------------------------------------------------------------------------------------
export interface ConsentRequest {
  personId: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  state: string;
}
export interface Consent extends ConsentRequest { expiresAt: string }

const insertConsent = db.prepare(
  `INSERT INTO oauth_consents (consent_hash, person_id, client_id, redirect_uri, resource, code_challenge, state, expires_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const selectConsent = db.prepare(`SELECT * FROM oauth_consents WHERE consent_hash = ?`);
const spendConsent = db.prepare(
  `UPDATE oauth_consents SET used_at = ? WHERE consent_hash = ? AND person_id = ? AND used_at IS NULL AND expires_at > ?`,
);
type ConsentRow = {
  consent_hash: string; person_id: string; client_id: string; redirect_uri: string; resource: string; code_challenge: string;
  state: string; expires_at: string; used_at: string | null;
};

/** Stores one validated authorization request and returns the consent id the page carries (only its hash is kept). */
export function createConsent(request: ConsentRequest, nowMs = Date.now()): string {
  const consentId = randomBytes(32).toString("base64url");
  insertConsent.run(
    sha256(consentId), request.personId, request.clientId, request.redirectUri, request.resource, request.codeChallenge,
    request.state, iso(nowMs + CONSENT_TTL_MS), iso(nowMs),
  );
  return consentId;
}

export type ConsentProblem = "unknown" | "used" | "expired";
/** Messages a person reads on the error page. Another person's consent reads as unknown: no oracle for its existence. */
export const CONSENT_PROBLEM_MESSAGE: Record<ConsentProblem, string> = {
  unknown: "This sign-in request isn't valid.",
  used: "This request was already answered.",
  expired: "This request expired.",
};

const toConsent = (row: ConsentRow): Consent => ({
  personId: row.person_id, clientId: row.client_id, redirectUri: row.redirect_uri, resource: row.resource,
  codeChallenge: row.code_challenge, state: row.state, expiresAt: row.expires_at,
});

function consentProblem(row: ConsentRow | undefined, personId: string, nowMs: number): ConsentProblem | null {
  if (!row || row.person_id !== personId) return "unknown";
  if (row.used_at) return "used";
  if (Date.parse(row.expires_at) <= nowMs) return "expired";
  return null;
}

const deleteDeadConsents = db.prepare(`DELETE FROM oauth_consents WHERE expires_at < ?`);
/** Consents past their 10 minutes are dead whether or not they were answered; a day later they go (the hub's minute
 * sweep, src/index.ts), which also lets an unused DCR client that only a consent named be pruned. The day keeps "this
 * request was already answered" readable for a while instead of "isn't valid". */
export function pruneDeadConsents(nowMs = Date.now()): number {
  return deleteDeadConsents.run(iso(nowMs - 24 * 60 * 60_000)).changes;
}

/** An open consent of this person's, for rendering the page again (a workspace switch, a refused approve). */
export function readConsent(consentId: unknown, personId: string, nowMs = Date.now()): { ok: true; consent: Consent } | { ok: false; problem: ConsentProblem } {
  if (typeof consentId !== "string" || !consentId) return { ok: false, problem: "unknown" };
  const row = selectConsent.get(sha256(consentId)) as ConsentRow | undefined;
  const problem = consentProblem(row, personId, nowMs);
  return problem ? { ok: false, problem } : { ok: true, consent: toConsent(row!) };
}

/** Marks the consent used, exactly once: the UPDATE must change one row. Call inside the answer's transaction. */
function takeConsent(consentId: string, personId: string, nowMs: number): { ok: true; consent: Consent } | { ok: false; problem: ConsentProblem } {
  const hash = sha256(consentId);
  if (spendConsent.run(iso(nowMs), hash, personId, iso(nowMs)).changes !== 1) {
    return { ok: false, problem: consentProblem(selectConsent.get(hash) as ConsentRow | undefined, personId, nowMs) ?? "used" };
  }
  return { ok: true, consent: toConsent(selectConsent.get(hash) as ConsentRow) };
}

// --- Where a person may connect -----------------------------------------------------------------------------------------
export interface WorkspaceChoice {
  orgId: string;
  name: string;
  role: MemberRole;
  /** The workspace keeps projects apart: the connection is scoped to one project the person picks. */
  isolated: boolean;
  /** The person's role may create and enable projects (projects.manage), so an isolated workspace with none is no dead
   * end: the page offers to create one. */
  canCreateProjects: boolean;
  /** Enabled projects, for the picker (only read when isolated). `lastSeenAt` is when a session last used it. */
  projects: Array<{ key: string; name: string; lastSeenAt?: string | null }>;
  /** When the person last used this workspace in the console: their member agent's last heartbeat, which every console
   * request in the workspace refreshes (src/rest.ts requireMemberSession). */
  lastUsedAt?: string | null;
}

/** The person's workspaces where their LIVE role may add agents (agents.create: admin or owner), not paused. */
export function eligibleWorkspaces(personId: string): WorkspaceChoice[] {
  const rows = db.prepare(
    `SELECT m.org_id, o.name, m.role, o.project_isolation, a.last_heartbeat_at
       FROM workspace_members m JOIN organizations o ON o.id = m.org_id LEFT JOIN agents a ON a.id = m.agent_id AND a.org_id = m.org_id
      WHERE m.person_id = ? AND o.paused_at IS NULL ORDER BY o.name COLLATE NOCASE, o.id`,
  ).all(personId) as Array<{ org_id: string; name: string; role: MemberRole; project_isolation: number; last_heartbeat_at: string | null }>;
  return rows
    .filter((r) => can(r.role, "agents.create"))
    .map((r) => ({
      orgId: r.org_id,
      name: r.name,
      role: r.role,
      lastUsedAt: r.last_heartbeat_at,
      isolated: r.project_isolation === 1,
      canCreateProjects: can(r.role, "projects.manage"),
      projects: r.project_isolation === 1
        ? listProjects(r.org_id).filter((p) => p.enabled).map((p) => ({ key: p.projectKey, name: p.name, lastSeenAt: p.lastSeenAt }))
        : [],
    }));
}

/** The workspace the first step preselects: the one the person used most recently in the console, else the first. */
export function defaultWorkspaceId(workspaces: WorkspaceChoice[]): string | null {
  // SQLite's datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC, with no zone; an ISO stamp may carry one.
  const ms = (t?: string | null) => (t ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(" ", "T")}Z`) : NaN);
  let best: { orgId: string; at: number } | null = null;
  for (const w of workspaces) {
    const at = ms(w.lastUsedAt);
    if (Number.isFinite(at) && (!best || at > best.at)) best = { orgId: w.orgId, at };
  }
  return best?.orgId ?? workspaces[0]?.orgId ?? null;
}

/** The project the page preselects: the only one, else the one a session used most recently (projects.last_seen_at,
 * refreshed by every session request in it), else none, and the person must choose. */
export function defaultProjectKey(choice: WorkspaceChoice): string | null {
  if (choice.projects.length === 1) return choice.projects[0].key;
  let best: { key: string; at: number } | null = null;
  for (const p of choice.projects) {
    const at = p.lastSeenAt ? Date.parse(p.lastSeenAt) : NaN;
    if (Number.isFinite(at) && (!best || at > best.at)) best = { key: p.key, at };
  }
  return best?.key ?? null;
}

/** The live check at answer time: the person still belongs to the workspace with a role that may add agents, and it is
 * not paused. */
function liveAccess(personId: string, orgId: string): boolean {
  const membership = getMembership(orgId, personId);
  if (!membership || !can(membership.role, "agents.create")) return false;
  const org = db.prepare(`SELECT paused_at FROM organizations WHERE id = ?`).get(orgId) as { paused_at: string | null } | undefined;
  return Boolean(org && !org.paused_at);
}

/** Whether approve would refuse the name, against the held names worked out once by the caller (heldNames). */
function nameTaken(orgId: string, name: string, held: HeldNames): boolean {
  if (lookalikeHeld(orgId, name, { held })) return true;
  try {
    checkAgentName(orgId, name, undefined, { held });
    return false;
  } catch (err) {
    if (err instanceof AgentNameError) return true;
    throw err;
  }
}

/** `text` cut to fit MAX_AGENT_NAME_CHARS (counted in UTF-16 units, as checkAgentName counts) together with `suffix`,
 * dropping whole code points from its end, so a surrogate pair is never split. */
function clip(text: string, suffix: string): string {
  return `${clipToUnits(text, MAX_AGENT_NAME_CHARS - suffix.length)}${suffix}`;
}

/** A name free in the workspace, from `wanted` (the client's display name, or a name the person typed that is taken):
 * itself, else "<it> 2", "<it> 3" and so on, a number already at its end replaced ("Grok Bot 2" taken gives
 * "Grok Bot 3"). Names stay held after an agent is removed (src/agent-names.ts addressHeld), so this asks the same rule
 * approve applies. A display name is only a claim, so it is cleaned first (safeNameBase: no invisible characters, no
 * Latin mixed with Cyrillic or Greek), and every result fits
 * MAX_AGENT_NAME_CHARS, its suffix included. A free name is a suggestion only: approve checks it again. */
export function freeConnectionName(orgId: string, wanted: string): string {
  const held = heldNames(orgId);
  const base = clip(safeNameBase(wanted), "") || "Connection";
  // A reserved word is not made free by a number ("OpenCadre 2"), and a name that still breaks a rule (not merely taken)
  // never would be: the neutral default instead. Never a suggestion that would itself be refused.
  const name = isReservedName(base) || refusedForShape(orgId, base, held) ? "Connection" : base;
  if (!nameTaken(orgId, name, held)) return name;
  const stem = name.replace(/\s+\d+$/, "") || name;
  const fit = (suffix: string) => clip(stem, suffix);
  for (let n = 2; n < 100; n++) if (!nameTaken(orgId, fit(` ${n}`), held)) return fit(` ${n}`);
  return fit(`-${randomBytes(2).toString("hex")}`);
}

/** Whether checkAgentName refuses the name for its shape (400), as opposed to its being taken (409). */
function refusedForShape(orgId: string, name: string, held: HeldNames): boolean {
  try {
    checkAgentName(orgId, name, undefined, { held });
    return false;
  } catch (err) {
    if (err instanceof AgentNameError) return err.status === 400;
    throw err;
  }
}

/** The name the page offers for a workspace's first project: "Main", else "<Workspace> project", else "Main 2" and on.
 * Taken means a project row with that key exists, on or off: creating it would only turn an old one back on. */
export function defaultNewProjectName(orgId: string, workspaceName: string): string {
  const held = (name: string) => {
    const key = sanitizeProject(name);
    return !key || db.prepare(`SELECT 1 FROM projects WHERE org_id = ? AND project_key = ?`).get(orgId, `local:${key}`) !== undefined;
  };
  const candidates = ["Main", `${workspaceName} project`, ...Array.from({ length: 98 }, (_, i) => `Main ${i + 2}`)];
  return candidates.find((c) => !held(c)) ?? "Main";
}

// --- Grants -------------------------------------------------------------------------------------------------------------
class Refusal extends Error {
  constructor(readonly result: ApproveFailure) {
    super(result.reason);
  }
}

const selectActiveGrant = db.prepare(
  `SELECT g.grant_id, g.agent_id, (a.id IS NOT NULL AND a.removed_at IS NULL) AS live
     FROM oauth_grants g LEFT JOIN agents a ON a.id = g.agent_id AND a.org_id = g.org_id
    WHERE g.person_id = ? AND g.client_id = ? AND g.org_id = ? AND g.scope_key = ? AND g.revoked_at IS NULL`,
);
const revokeGrantRow = db.prepare(`UPDATE oauth_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`);
const insertConnectorAgent = db.prepare(
  `INSERT INTO agents (id, org_id, name, url_key, api_key_hash, role, key_class, kind, scope, home_project)
   VALUES (?, ?, ?, ?, ?, 'agent', 'agent', 'connector', ?, ?)`,
);
const insertGrant = db.prepare(
  `INSERT INTO oauth_grants (grant_id, person_id, client_id, org_id, scope_key, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

interface GrantTuple { personId: string; clientId: string; orgId: string; scopeKey: string }
interface GrantRef { grantId: string; agentId: string; reused: boolean }

/** Get-or-create, inside the caller's transaction (plan §7.2). */
/** Test-only seams, passed as an argument (production callers pass nothing): `beforeGrantInsert` runs between the reuse
 * check and the insert, where a second writer's competing grant would land. */
export interface ApproveTestHooks { beforeGrantInsert?: () => void }

function getOrCreateGrant(tuple: GrantTuple, rawName: string, nowMs: number, hooks: ApproveTestHooks): GrantRef {
  for (let attempt = 0; ; attempt++) {
    const active = selectActiveGrant.get(tuple.personId, tuple.clientId, tuple.orgId, tuple.scopeKey) as
      { grant_id: string; agent_id: string; live: number } | undefined;
    // Re-approval of a live scope: the same agent, and no cap check (it is not a new agent).
    if (active?.live) return { grantId: active.grant_id, agentId: active.agent_id, reused: true };
    // An active grant whose agent is gone (removed before removal revoked grants) is closed, and a fresh one made.
    if (active) revokeGrantRow.run(iso(nowMs), active.grant_id);

    // A NEW connection: the plan's live-agent cap, BEFORE anything is written (design §3, plan §7.2).
    const limit = agentLimitRefusal(tuple.orgId, undefined, "oauth");
    if (limit) throw new Refusal({ ok: false, reason: "plan_limit", message: limit.body.error, limit });
    // A typed name with a zero-width or direction character is refused outright; otherwise it is taken in its NFKC form,
    // and one that folds to an agent's name here (now or before) is refused like a duplicate (finding A).
    const rawTyped = typeof rawName === "string" ? rawName : "";
    const refuse = (message: string): never => { throw new Refusal({ ok: false, reason: "invalid_name", message }); };
    const ONLY_READABLE = "Use letters, numbers, spaces and punctuation.";
    // Stored as every path stores a name: NFC (compared folded anyway), its length measured on that.
    const typed = rawTyped.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!typed) refuse("Enter an agent name.");
    if (typed.length > MAX_AGENT_NAME_CHARS) refuse(`Agent name is too long (max ${MAX_AGENT_NAME_CHARS}).`);
    // The one validator (src/agent-names.ts nameProblem), on what was typed: an invisible or odd character is refused,
    // not quietly removed by NFKC.
    const problem = nameProblem(rawTyped);
    if (problem === "mixed") refuse("Use letters from one alphabet.");
    if (problem) refuse(ONLY_READABLE);
    if (/\p{Cc}/u.test(typed)) refuse(ONLY_READABLE);
    // Held by an agent (now or before) or as a profile's name: a free name goes in the field (onboarding slice 2), and
    // the message says why. Held exactly: taken. Otherwise it names the clash ("José looks like Jose, an agent in this
    // workspace", "Admin is a reserved name"), so the person sees what it was mistaken for.
    const taken = (why: string): never => {
      const suggestedName = freeConnectionName(tuple.orgId, typed);
      throw new Refusal({ ok: false, reason: "invalid_name", suggestedName, message: `${why}. We filled in ${suggestedName}.` });
    };
    const clash = nameClash(tuple.orgId, typed);
    if (clash) taken(addressHeld(tuple.orgId, typed) || isProfileName(tuple.orgId, typed) ? `${typed} is taken` : describeClash(typed, clash));
    let name = "";
    try {
      name = checkAgentName(tuple.orgId, typed);
    } catch (err) {
      if (!(err instanceof AgentNameError)) throw err;
      if (err.status !== 409) refuse(ONLY_READABLE);
      taken(`${typed} is taken`);
    }
    const agentId = randomUUID();
    const grantId = randomUUID();
    const scoped = tuple.scopeKey !== WORKSPACE_SCOPE;
    hooks.beforeGrantInsert?.();
    try {
      // A savepoint: a lost race undoes this agent too, and the outer transaction carries on to reuse the winner's.
      db.transaction(() => {
        // No agent key is minted: the connector acts only through its OAuth tokens. The placeholder is not a SHA-256 hex
        // digest, so no key hashes to it (the same idea as a session agent's, src/devices.ts).
        insertConnectorAgent.run(
          agentId, tuple.orgId, name, agentUrlKey(tuple.orgId, name, agentId), `connector:${randomBytes(32).toString("hex")}`,
          scoped ? "project" : "workspace", scoped ? tuple.scopeKey : null,
        );
        insertGrant.run(grantId, tuple.personId, tuple.clientId, tuple.orgId, tuple.scopeKey, agentId, iso(nowMs));
      })();
      return { grantId, agentId, reused: false };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 1) throw err;
      // Lost to a concurrent approval of the same tuple (the partial unique index): go round once more and reuse it.
    }
  }
}

/** Ends a grant: Disconnect (PR3 calls this from the console) and the isolation later-switch rule. Its token families
 * are revoked at once and its live requests end (revokeAgentTokens), and the next approval for the same tuple creates a
 * fresh grant and agent (plan §7.6). The agent itself is left for the caller to remove. */
export function revokeGrant(grantId: string, reason = "this connection was disconnected", nowMs = Date.now()): boolean {
  // ONE transaction for the grant and its tokens (Codex on #651): no failure between the two writes can leave a revoked
  // grant with a live token, or the reverse. The connections end after the commit.
  const outcome = db.transaction(() => {
    const row = db.prepare(`SELECT agent_id FROM oauth_grants WHERE grant_id = ?`).get(grantId) as { agent_id: string } | undefined;
    if (!row) return null;
    const changed = revokeGrantRow.run(iso(nowMs), grantId).changes === 1;
    revokeAgentTokenRows(row.agent_id, nowMs);
    return { agentId: row.agent_id, changed };
  }).immediate();
  if (!outcome) return false;
  endConnectorConnections([outcome.agentId], reason);
  return outcome.changed;
}

// --- Answering a consent ------------------------------------------------------------------------------------------------
export type ApproveFailure =
  | { ok: false; reason: "consent"; problem: ConsentProblem; message: string }
  | { ok: false; reason: "not_allowed" | "project_required" | "invalid_project" | "project_limit"; message: string }
  | { ok: false; reason: "invalid_name"; message: string; suggestedName?: string }
  | { ok: false; reason: "plan_limit"; message: string; limit: PlanLimitRefusal };
export type ApproveResult =
  | { ok: true; code: string; redirectUri: string; state: string; grantId: string; agentId: string; reused: boolean }
  | ApproveFailure;

export interface ApproveInput {
  consentId: string;
  personId: string;
  orgId: string;
  projectKey?: string | null;
  /** A project to create and enable for this connection, when the workspace keeps projects apart and none is chosen
   * (onboarding slice 2: a new workspace has none, and its first connect must not dead-end). */
  newProjectName?: string | null;
  connectionName: string;
}

/** Creates (or turns back on) the project named `raw` as `local:<name>`, through the one place projects are enabled
 * (src/projects.ts setProjectEnabled: the plan's project limit and the project.enabled event), acting as the person's
 * member agent, as the console's Add project does. Inside approve's transaction, so a refused approve undoes it. */
function createProjectFor(personId: string, orgId: string, raw: string): string {
  const membership = getMembership(orgId, personId);
  if (!membership || !can(membership.role, "projects.manage")) {
    throw new Refusal({ ok: false, reason: "not_allowed", message: "You need to be an owner or admin." });
  }
  const name = sanitizeProject(raw);
  if (!name) throw new Refusal({ ok: false, reason: "invalid_project", message: "Use at least one letter or number." });
  // Only ever CREATES (second review, finding B; round 3, S4): approve calls this only when the workspace has no enabled
  // project, and one an owner switched off stays off; turning it back on is the console's decision, not a side effect of
  // a connect.
  const key = `local:${name}`;
  const existing = db.prepare(`SELECT enabled FROM projects WHERE org_id = ? AND project_key = ?`).get(orgId, key) as { enabled: number } | undefined;
  if (existing) {
    throw new Refusal({ ok: false, reason: "invalid_project", message: `${name} is turned off. Pick another name, or turn it on in Settings → Projects.` });
  }
  const actor = db.prepare(`SELECT id, name FROM agents WHERE id = ? AND org_id = ?`).get(membership.agent_id, orgId) as { id: string; name: string } | undefined;
  try {
    return setProjectEnabled(orgId, { actor: actor ?? null, name: actor?.name ?? "OpenCadre", via: "operator" }, key, true, name).projectKey;
  } catch (err) {
    if (!(err instanceof ProjectError)) throw err;
    throw new Refusal({ ok: false, reason: err.status === 402 ? "project_limit" : "invalid_project", message: err.message });
  }
}

const insertCode = db.prepare(
  `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, person_id, org_id, agent_id, grant_id, expires_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

/** Approve: ONE immediate transaction that spends the consent, re-checks the person's live role, gets or creates the
 * grant and its connector agent, and stores a 60 s single-use code bound to the client, redirect, PKCE challenge,
 * resource, person, workspace, agent and grant. Any refusal rolls ALL of it back, the consent included, so the person
 * can choose again on the same page; nothing half-made is left (design §3). The code is returned once; only its hash
 * is stored. */
export function approveConsent(input: ApproveInput, nowMs = Date.now(), hooks: ApproveTestHooks = {}): ApproveResult {
  const run = db.transaction((): ApproveResult => {
    const taken = takeConsent(input.consentId, input.personId, nowMs);
    if (!taken.ok) return { ok: false, reason: "consent", problem: taken.problem, message: CONSENT_PROBLEM_MESSAGE[taken.problem] };
    const { consent } = taken;
    if (!liveAccess(input.personId, input.orgId)) {
      throw new Refusal({ ok: false, reason: "not_allowed", message: "You need to be an owner or admin." });
    }
    const isolated = (db.prepare(`SELECT project_isolation FROM organizations WHERE id = ?`).get(input.orgId) as { project_isolation: number }).project_isolation === 1;
    let scopeKey = WORKSPACE_SCOPE;
    if (isolated) {
      let project = typeof input.projectKey === "string" ? input.projectKey : "";
      const newProject = typeof input.newProjectName === "string" ? input.newProjectName : null;
      // new_project only where the page offers it: a workspace with no enabled project (S4). Otherwise the picker applies.
      if (!project && newProject !== null && enabledProjectKeys(input.orgId).length === 0) {
        project = createProjectFor(input.personId, input.orgId, newProject);
      }
      if (!project || !enabledProjectKeys(input.orgId).includes(project)) {
        throw new Refusal({ ok: false, reason: "project_required", message: "Choose a project." });
      }
      scopeKey = project;
    }
    const grant = getOrCreateGrant({ personId: input.personId, clientId: consent.clientId, orgId: input.orgId, scopeKey }, input.connectionName, nowMs, hooks);
    const code = randomBytes(32).toString("base64url");
    insertCode.run(
      sha256(code), consent.clientId, consent.redirectUri, consent.codeChallenge, consent.resource, input.personId, input.orgId,
      grant.agentId, grant.grantId, iso(nowMs + CODE_TTL_SECONDS * 1000), iso(nowMs),
    );
    return { ok: true, code, redirectUri: consent.redirectUri, state: consent.state, ...grant };
  });
  try {
    return run.immediate();
  } catch (err) {
    if (err instanceof Refusal) return err.result;
    throw err;
  }
}

/** What an answered consent made, when it made a connection that is still live: the agent's name and where it works.
 * Approve spends the consent and stores its code in one transaction with one clock reading, so the code is the one with
 * the consent's person, client, redirect and PKCE challenge, created at the instant the consent was used. A denied
 * consent has no code; a disconnected grant or a removed agent is no longer a connection. Either gives null, and the
 * page stays generic. Never more than the person saw when they approved: names only, no ids, codes or tokens. */
export function answeredConsent(consentId: unknown, personId: string): { agentName: string; workspaceName: string; projectName: string | null } | null {
  if (typeof consentId !== "string" || !consentId) return null;
  const row = db.prepare(
    `SELECT a.name AS agent_name, o.name AS workspace_name, g.org_id, g.scope_key
       FROM oauth_consents k
       JOIN oauth_codes c ON c.person_id = k.person_id AND c.client_id = k.client_id AND c.redirect_uri = k.redirect_uri
                         AND c.code_challenge = k.code_challenge AND c.created_at = k.used_at
       JOIN oauth_grants g ON g.grant_id = c.grant_id AND g.revoked_at IS NULL
       JOIN agents a ON a.id = g.agent_id AND a.org_id = g.org_id AND a.removed_at IS NULL
       JOIN organizations o ON o.id = g.org_id
      WHERE k.consent_hash = ? AND k.person_id = ? AND k.used_at IS NOT NULL
      ORDER BY c.created_at DESC LIMIT 1`,
  ).get(sha256(consentId), personId) as { agent_name: string; workspace_name: string; org_id: string; scope_key: string } | undefined;
  if (!row) return null;
  return { agentName: row.agent_name, workspaceName: row.workspace_name, projectName: projectNameOf(row.org_id, row.scope_key) };
}

const projectNameOf = (orgId: string, scopeKey: string): string | null => scopeKey === WORKSPACE_SCOPE
  ? null
  : ((db.prepare(`SELECT name FROM projects WHERE org_id = ? AND project_key = ?`).get(orgId, scopeKey) as { name: string } | undefined)?.name ?? scopeKey);

/** What a grant is, by name: its agent, and the project it works in or else its workspace. For the page approve returns
 * (onboarding slice 3); names only, as on the consent page. */
export function grantNames(grantId: string): { agentName: string; scopeName: string } | null {
  const row = db.prepare(
    `SELECT a.name AS agent_name, o.name AS workspace_name, g.org_id, g.scope_key
       FROM oauth_grants g
       JOIN agents a ON a.id = g.agent_id AND a.org_id = g.org_id
       JOIN organizations o ON o.id = g.org_id
      WHERE g.grant_id = ?`,
  ).get(grantId) as { agent_name: string; workspace_name: string; org_id: string; scope_key: string } | undefined;
  if (!row) return null;
  return { agentName: row.agent_name, scopeName: projectNameOf(row.org_id, row.scope_key) ?? row.workspace_name };
}

/** Deny: spends the consent and names where to send `access_denied`. */
export function denyConsent(consentId: string, personId: string, nowMs = Date.now()):
  { ok: true; redirectUri: string; state: string } | { ok: false; problem: ConsentProblem; message: string } {
  const taken = db.transaction(() => takeConsent(consentId, personId, nowMs)).immediate();
  if (!taken.ok) return { ok: false, problem: taken.problem, message: CONSENT_PROBLEM_MESSAGE[taken.problem] };
  return { ok: true, redirectUri: taken.consent.redirectUri, state: taken.consent.state };
}

// --- Validating GET /oauth/authorize ------------------------------------------------------------------------------------
export interface OauthClient { clientId: string; clientName: string; redirectUris: string[] }

/** A registered client: a DCR row, or a CIMD document fetched (and cached) through the SSRF-guarded fetcher, whose
 * per-network limit the caller's key is charged against. */
export async function loadOauthClient(clientId: string, rateLimitKey: string): Promise<{ ok: true; client: OauthClient } | { ok: false; message: string; limited?: boolean }> {
  if (isCimdClientId(clientId)) {
    const fetched = await resolveClientMetadata(clientId, { rateLimitKey });
    if (!fetched.ok) return { ok: false, message: `This app's details couldn't be read: ${fetched.error}.`, limited: fetched.error === CIMD_RATE_LIMITED };
    return { ok: true, client: { clientId, clientName: fetched.clientName, redirectUris: fetched.redirectUris } };
  }
  const row = db.prepare(`SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id = ? AND kind = 'dcr'`).get(clientId) as
    { client_name: string | null; redirect_uris: string } | undefined;
  if (!row) return { ok: false, message: "This app isn't registered with OpenCadre." };
  const uris = JSON.parse(row.redirect_uris) as unknown;
  return { ok: true, client: { clientId, clientName: row.client_name || "An app", redirectUris: Array.isArray(uris) ? uris.filter((u): u is string => typeof u === "string") : [] } };
}

export interface AuthorizeRequest { client: OauthClient; redirectUri: string; codeChallenge: string; state: string; resource: string }
export type AuthorizeCheck =
  /** Unsafe to redirect (the client or the redirect itself is in doubt): the hub shows an error page. */
  | { kind: "page"; status: number; message: string }
  /** The redirect is trusted: the error goes back to the client (RFC 6749 §4.1.2.1), with iss (RFC 9207). */
  | { kind: "redirect"; clientId: string; redirectUri: string; error: string; description: string; state?: string }
  | { kind: "ok"; request: AuthorizeRequest };

const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MAX_STATE_CHARS = 1024;
const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** RFC 6749 §4.1.1 with the MCP profile: the client and redirect first (their failure is a page, never a redirect to an
 * unverified place), then response_type, PKCE S256 only (design §4: `plain` refused), the RFC 8707 resource, which must
 * be this hub's /mcp, and a state. A parameter given twice is treated as absent. `scope` is not checked: the hub grants
 * one fixed scope ("fleet") whatever is asked. */
export async function checkAuthorizeRequest(query: Record<string, unknown>, rateLimitKey: string, resource: string): Promise<AuthorizeCheck> {
  const clientId = one(query.client_id);
  if (!clientId) return { kind: "page", status: 400, message: "The app didn't say who it is (no client_id)." };
  const loaded = await loadOauthClient(clientId, rateLimitKey);
  if (!loaded.ok) return { kind: "page", status: loaded.limited ? 429 : 400, message: loaded.message };
  const redirectUri = one(query.redirect_uri);
  if (!redirectUri || !loaded.client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
    return { kind: "page", status: 400, message: "This app asked to send you somewhere it didn't register, so OpenCadre stopped here." };
  }
  const state = one(query.state);
  const back = (error: string, description: string): AuthorizeCheck =>
    ({ kind: "redirect", clientId, redirectUri, error, description, ...(state && state.length <= MAX_STATE_CHARS ? { state } : {}) });
  if (one(query.response_type) !== "code") return back("unsupported_response_type", "response_type must be code");
  if (one(query.code_challenge_method) !== "S256") return back("invalid_request", "PKCE with code_challenge_method S256 is required");
  const codeChallenge = one(query.code_challenge);
  if (!codeChallenge || !S256_CHALLENGE.test(codeChallenge)) return back("invalid_request", "code_challenge must be an S256 challenge");
  if (one(query.resource) !== resource) return back("invalid_target", `resource must be ${resource}`);
  if (!state) return back("invalid_request", "state is required");
  if (state.length > MAX_STATE_CHARS) return back("invalid_request", `state must be at most ${MAX_STATE_CHARS} characters`);
  return { kind: "ok", request: { client: loaded.client, redirectUri, codeChallenge, state, resource } };
}

/** Whether the person has an active grant with this client: only then does a validation error go straight back to the
 * client's redirect (security review S1). Registration is open, so a redirect being registered proves nothing about
 * who set it up; without an existing connection the person gets a page with a link to click instead. */
export function hasActiveGrant(personId: string, clientId: string): boolean {
  return db.prepare(`SELECT 1 FROM oauth_grants WHERE person_id = ? AND client_id = ? AND revoked_at IS NULL LIMIT 1`).get(personId, clientId) !== undefined;
}

/** The consent's redirect is still one the client has registered (security review N3), checked again when the person
 * answers. A DCR client is read from its row. A CIMD client is checked against its cached document when there is one;
 * the answer never fetches it again (N10), so without a cached copy only the redirect's own rules are re-applied. */
export function redirectStillRegistered(clientId: string, redirectUri: string): boolean {
  if (!acceptableRedirectUri(redirectUri)) return false;
  if (isCimdClientId(clientId)) {
    const cached = peekClientMetadata(clientId);
    return !cached || cached.redirectUris.some((registered) => redirectMatches(registered, redirectUri));
  }
  const row = db.prepare(`SELECT redirect_uris FROM oauth_clients WHERE client_id = ? AND kind = 'dcr'`).get(clientId) as { redirect_uris: string } | undefined;
  if (!row) return false;
  const uris = JSON.parse(row.redirect_uris) as unknown;
  return Array.isArray(uris) && uris.some((registered) => typeof registered === "string" && redirectMatches(registered, redirectUri));
}

/** The URL an answer sends the browser back to (onboarding slice 3): the client's redirect with the answer appended, only
 * while the redirect is one acceptableRedirectUri admits (https, or http on a loopback host; never javascript:, data: or
 * any other scheme). Null otherwise, and the caller shows an error and navigates nowhere (security review L2). */
export function returnHref(redirectUri: string, params: Record<string, string | undefined>): string | null {
  return acceptableRedirectUri(redirectUri) ? redirectWithParams(redirectUri, params) : null;
}

/** The client's redirect with the answer appended to its query. Appended as text, not through URL.searchParams, which
 * would re-encode the client's own query; the redirect is canonical and has no fragment (acceptableRedirectUri). */
export function redirectWithParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.append(key, value);
  return `${redirectUri}${redirectUri.includes("?") ? "&" : "?"}${query.toString()}`;
}
