import { randomBytes } from "node:crypto";
import { db, newId } from "./db.js";
import { addressHeld, describeClash, isProfileName, nameClash, nameProblem, type HeldNames, type NameProblem } from "./agent-names.js";
import { emitEvent } from "./events.js";
import { log } from "./log.js";
import { computeAgentState, type AgentState } from "./agent-state.js";
import { postWebhook } from "./webhook-guard.js";
import { generateApiKey, hashKey, type KeyClass } from "./auth.js";
export type { KeyClass } from "./auth.js";
import { defaultPlan, trialEndsAtFor } from "./billing.js";
import type { AgentRole } from "./auth.js";
import { currentUsage, type AgentUsage } from "./usage.js";
import { endHeldRequests } from "./revocation.js";
import { disconnectAgent, hasLiveSocket, notifyInboxWaiters, pushToAgent, resolveReplyWaiter, waitForInboxActivity, waitForReply } from "./live.js";
import { maskAndCap, maskSecrets } from "./secrets.js";
import { sameProjectOrUnknown } from "./policy.js";
import { resolveProjectKey, stampFor } from "./project-stamps.js";
import {
  assertReachable, canSee, isReachable, isWorkspaceScope, NOT_REACHABLE, NotReachableError, ownProjectsOf, projectIsolationEnabled,
} from "./scope.js";

/** The presence window: an agent is ONLINE while its last heartbeat is inside this TTL.
 *
 * EXPORTED (it was private until plan-limit enforcement needed it) so that the "how many live agents
 * does this workspace have" COUNTER and the roster that SHOWS them cannot disagree. A second, copied
 * constant in src/billing.ts would be the same number until someone tuned one of them, and then a
 * workspace would be refused a new agent by a limit whose own roster said it was under -- the failure
 * mode is a refusal that contradicts the screen the user is looking at, which is indistinguishable from
 * a bug. One number, one meaning, imported by both.
 *
 * 2 minutes, matching the original presence-TTL design. */
export const HEARTBEAT_TTL_MS = 2 * 60 * 1000;
/** How long since last_heartbeat_at before an active agent is auto-suspended
 * (status=paused). Distinct from presence online TTL above: offline = no recent
 * beat for UI presence; stale = unverified for future Tier-1 gates. Paused here
 * means auto-suspended for staleness (not a manual operator pause). Auth does
 * not block paused agents -- their next real heartbeat unsuspends them. */
export function staleAfterMs(): number {
  const raw = process.env.OPENCADRE_STALE_AFTER_MS;
  if (raw == null || raw === "") return 30 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000;
}

export interface AgentRecord {
  id: string;
  org_id: string;
  name: string;
  url_key: string;
  role: AgentRole;
  status: string;
  last_heartbeat_at: string | null;
  webhook_url: string | null;
  webhook_auth_header: string | null;
  /** The last wake POST to webhook_url (migration 59, recordWakeOutcome): when, the outcome and the HTTP status. */
  last_wake_at?: string | null;
  last_wake_outcome?: string | null;
  last_wake_status?: number | null;
  current_task: string | null;
  editing_files: string | null;
  status_updated_at: string | null;
  phase?: string | null;
  usage: string | null;
  /** named (agt_ key) | session (one tool session on a device, src/devices.ts). */
  kind?: "named" | "session";
  /** A session's tool (claude-code, codex, ...) and its project's display name: the roster shows them beside a session's word name. */
  client?: string | null;
  project_name?: string | null;
  device_id?: string | null;
  seat_id?: string | null;
  tool_session_id?: string | null;
  project?: string | null;
  ended_at?: string | null;
  /** The project the agent belongs to (PROJECT_ISOLATION.md §3.2): a session's is fixed when it joins. */
  home_project?: string | null;
  /** project | projects | workspace: what the agent may see and reach while project isolation is on (src/scope.ts). */
  scope?: string;
}

export interface MessageRecord {
  id: string;
  org_id: string;
  thread_id: string;
  from_agent_id: string;
  from_agent_name: string;
  to_agent_id: string;
  to_agent_name: string;
  body: string;
  kind: string;
  priority: string;
  awaiting_reply: number;
  created_at: string;
  read_at: string | null;
  delivered_at: string | null;
  file_id: string | null;
  /** The sender's home project, stamped at write time (write-once). */
  project_key: string | null;
  /** The recipient's home project, stamped at write time (write-once). Differs from project_key on a cross-project message. */
  to_project_key: string | null;
}

export type Priority = "high" | "medium" | "low";

export interface FileRecord {
  id: string;
  org_id: string;
  uploaded_by_agent_id: string;
  uploaded_by_agent_name: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content: Buffer;
  created_at: string;
  /** The uploader's home project, stamped at write time (write-once). */
  project_key: string | null;
}

// Kept deliberately narrow -- "primarily .md and .pdf" per the operator.
// Extend this allowlist explicitly rather than accepting arbitrary binaries;
// an open upload surface is a real abuse vector this MVP hasn't hardened for.
const ALLOWED_FILE_EXTENSIONS = [".md", ".pdf"];

function assertAllowedFilename(filename: string): void {
  const lower = filename.toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new Error(`Unsupported file type for "${filename}" -- allowed: ${ALLOWED_FILE_EXTENSIONS.join(", ")}`);
  }
}

/** A new workspace starts with project isolation on (PROJECT_ISOLATION.md §7 item 3): it has no fleet that could be split.
 * Workspaces from before enforcement keep it off (migration 17) until an operator switches it on.
 *
 * It also starts on the trial plan with a real clock (src/billing.ts), and the length comes from the
 * plan row's `trial_days` rather than from a constant here. A workspace with no clock never lapses --
 * that is exactly how the grandfathered workspaces are expressed, and deliberately NOT how a new one
 * is, or the trial would never end.
 *
 * `planKey` DEFAULTS TO A REAL SIGNUP'S PLAN, so no existing caller changes, and a test that needs a
 * workspace which cannot hit a plan limit passes "internal" explicitly.
 *
 * WHY A PARAMETER RATHER THAN A RULE: the alternative -- making limits inert whenever `VITEST` is set, a
 * pattern this codebase already uses in src/log.ts and src/mcp.ts -- would give EVERY suite an uncapped
 * workspace by default. That is the exact fixture shape that hid a real finding today: a refusal with zero
 * production call sites stayed green for six tests because nothing in the test environment ever reached
 * it. A default that cannot enforce a limit is a default that cannot test one, so the plan is named at
 * the call site that needs it and the DEFAULT stays what production does. */
export function createOrganization(name: string, planKey: string = defaultPlan()): { orgId: string; bootstrapKey: string } {
  const orgId = newId();
  const bootstrapKey = generateApiKey("org");
  db.prepare(
    `INSERT INTO organizations (id, name, bootstrap_key_hash, project_isolation, plan, trial_ends_at) VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(orgId, name, hashKey(bootstrapKey), planKey, trialEndsAtFor(planKey));
  return { orgId, bootstrapKey };
}

/** api_key_hash is now a UNIQUE column (migration 28) -- 192 bits of randomBytes(24) entropy in
 * generateApiKey makes a real collision astronomically unlikely, but "unlikely" isn't "impossible,"
 * and impersonation being structurally impossible is the whole point of the constraint. A bounded
 * retry with a freshly generated key turns the one-in-2^192 case into a silent, correct retry
 * instead of a raw constraint-violation 500 reaching the caller. */
const MAX_KEY_COLLISION_RETRIES = 3;
const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code?.startsWith("SQLITE_CONSTRAINT") ?? false;

export const MAX_AGENT_NAME_CHARS = 80;

/** A rejected agent name: 400 when it's malformed, 409 when the org already has it. */
export class AgentNameError extends Error {
  /** `reason` "reserved": the name is, or holds, a reserved word, so a number after it would not help. */
  constructor(message: string, readonly status: 400 | 409, readonly reason?: "reserved") {
    super(message);
  }
}

/** Messaging addresses agents by name, so a name must be unique in its org (ignoring case and surrounding whitespace) or
 * "send to Coder" is ambiguous. It must also never be one any other agent held before, even a removed one
 * (src/agent-names.ts addressHeld), or late mail or a stale client config naming it would reach a different agent; nor a
 * profile's own name, which is not an address (its chats are "<name> #<n>"). `selfId` is the agent being renamed: its own
 * current and past names stay its own. `system`: the hub itself mints this name (src/waitlist.ts "Operator"), so a
 * reserved name is allowed; nothing a person or app typed passes it. */
const NAME_PROBLEM_MESSAGE: Record<NameProblem, string> = {
  unusable: "name must not contain unassigned, private-use or line-break characters",
  invisible: "name must not contain invisible or direction-changing characters",
  blank: "name must not contain a blank other than a space",
  emoji: "name must not contain emoji",
  mark: "name must not start with a combining mark or stack them",
  mixed: "name must use letters from one alphabet",
  noletter: "name must contain a letter or digit",
};

export function checkAgentName(orgId: string, raw: unknown, selfId?: string, { system = false, held }: { system?: boolean; held?: HeldNames } = {}): string {
  // NFC, so a name typed decomposed is stored the way it is shown; it is compared folded (NFKC) anyway.
  const name = typeof raw === "string" ? raw.trim().normalize("NFC") : "";
  if (!name) throw new AgentNameError("name is required", 400);
  if (name.length > MAX_AGENT_NAME_CHARS) throw new AgentNameError(`name must be at most ${MAX_AGENT_NAME_CHARS} characters`, 400);
  if (/\p{Cc}/u.test(name)) throw new AgentNameError("name must not contain control characters", 400);
  // A NEW name can't pass for another agent's (src/agent-names.ts): nothing invisible, no odd blank, no leading
  // combining mark, letters from one script, and no lookalike of a name held now or before, a profile's or a reserved
  // one. Only names being set are judged; a stored one is never re-read through this.
  // As given, not trimmed: trim() would quietly drop a leading U+FEFF, which is refused like any invisible character.
  const problem = nameProblem(typeof raw === "string" ? raw : "");
  if (problem) throw new AgentNameError(NAME_PROBLEM_MESSAGE[problem], 400);
  // Held means held by ANY agent, now or before, removed ones included: an address is never reassigned (migration 55).
  if (addressHeld(orgId, name, selfId)) throw new AgentNameError(`an agent named ${name} already exists`, 409);
  if (isProfileName(orgId, name)) throw new AgentNameError(`${name} is a profile's name, and its chats are ${name} #1, ${name} #2 and so on; choose another name`, 409);
  // The 409 names the clash, so it is never a dead end: "José looks like Jose, an agent in this workspace".
  const clash = nameClash(orgId, name, { selfId, allowReserved: system, held });
  if (clash) throw new AgentNameError(`${describeClash(name, clash)}; choose another name`, 409, clash.kind === "reserved" ? "reserved" : undefined);
  return name;
}

/** The agent's URL slug: its name, or the id when the name has no usable letters. Distinct names can still slug alike
 * ("Agent A", "Agent-A"), so a taken slug gets the id appended instead of failing. */
export function agentUrlKey(orgId: string, name: string, agentId: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || agentId.slice(0, 8);
  const taken = db.prepare(`SELECT 1 FROM agents WHERE org_id = ? AND url_key = ?`).get(orgId, slug);
  return taken ? `${slug}-${agentId.slice(0, 8)}` : slug;
}

/** Throws AgentNameError for a malformed or duplicate name. */
export function registerAgent(
  orgId: string,
  rawName: string,
  { role = "agent", keyClass = "agent", system = false }: { role?: AgentRole; keyClass?: KeyClass; system?: boolean } = {},
): { agentId: string; agentName: string; apiKey: string; urlKey: string } {
  const name = checkAgentName(orgId, rawName, undefined, { system });
  const agentId = newId();
  const urlKey = agentUrlKey(orgId, name, agentId);
  // A named agent has no home project until the console can choose one (PROJECT_ISOLATION.md §6), so it is workspace-wide,
  // like the named agents migration 15 found (operator decision 1).
  for (let attempt = 0; ; attempt++) {
    const apiKey = generateApiKey("agt");
    try {
      db.prepare(
        `INSERT INTO agents (id, org_id, name, url_key, api_key_hash, role, key_class, scope) VALUES (?, ?, ?, ?, ?, ?, ?, 'workspace')`,
      ).run(agentId, orgId, name, urlKey, hashKey(apiKey), role, keyClass === "watcher" ? "watcher" : "agent");
      return { agentId, agentName: name, apiKey, urlKey };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= MAX_KEY_COLLISION_RETRIES) throw err;
    }
  }
}

/** Replaces an agent's key; the old key stops authenticating at once. Scoped to
 * the org, so null means no such agent here. The new key is returned once and only its hash is stored. */
export function rotateAgentKey(
  orgId: string,
  actor: { id: string; name: string },
  agentId: string,
): { agentId: string; agentName: string; apiKey: string } | null {
  let apiKey = "";
  let agentName: string | null = null;
  for (let attempt = 0; ; attempt++) {
    apiKey = generateApiKey("agt");
    try {
      agentName = db.transaction(() => {
        // A session agent is reached only through its device credential; giving it a key would let it outlive the device's revocation.
        // A connector agent's credential is its OAuth grant (docs/design/MCP-CONNECTOR.md §3): a key would outlive a
        // Disconnect, which revokes only the grant's tokens. A removed agent stays removed: rotating would hand its retired
        // identity a working key again. People act through console sessions, never their internal member-row hash.
        // Check the membership relation too, so legacy key-class drift cannot turn a person into a key-based agent.
        const row = db.prepare(
          `SELECT a.name FROM agents a WHERE a.id = ? AND a.org_id = ?
             AND a.kind NOT IN ('session', 'connector') AND a.removed_at IS NULL AND a.key_class != 'human'
             AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.agent_id = a.id)`,
        ).get(agentId, orgId) as { name: string } | undefined;
        if (!row) return null;
        db.prepare(`UPDATE agents SET api_key_hash = ? WHERE id = ? AND org_id = ?`).run(hashKey(apiKey), agentId, orgId);
        emitEvent({ orgId, type: "agent.key_rotated", actor, subjectType: "agent", subjectId: agentId, payload: { agentName: row.name } });
        return row.name;
      })();
      break;
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= MAX_KEY_COLLISION_RETRIES) throw err;
    }
  }
  if (agentName === null) return null;
  disconnectAgent(agentId, "api key rotated");
  endHeldRequests(agentId, 401, "This API key no longer works: it was rotated.");
  return { agentId, agentName, apiKey };
}

export const REMOVE_SELF_ERROR = "you can't remove yourself";
export const REMOVE_MEMBER_ERROR = "remove the person under Settings → Members instead";

export type RemoveAgentResult =
  | { ok: true; agentId: string; agentName: string }
  | { ok: false; status: 400 | 404; error: string };

/** Retires an agent for good (DELETE /v1/org/agents/:agentId). Scoped to the org, so another workspace's agent is
 * not found. Its key stops working in the same transaction that marks it removed (the hash becomes a placeholder no
 * key can hash to), a session agent's session ends, and everything the agent holds open is cut off right after.
 * The row stays, so its messages, events and tasks keep their names; only the living stop seeing it.
 * People are removed under Settings -> Members, never here: their member agent is how they act in the workspace. */
export function removeAgent(orgId: string, actor: { id: string; name: string }, agentId: string): RemoveAgentResult {
  const outcome = db.transaction((): RemoveAgentResult => {
    const row = db.prepare(`SELECT id, name, kind, key_class FROM agents WHERE id = ? AND org_id = ? AND removed_at IS NULL`)
      .get(agentId, orgId) as { id: string; name: string; kind: string; key_class: string } | undefined;
    if (!row) return { ok: false, status: 404, error: "agent not found" };
    if (row.id === actor.id) return { ok: false, status: 400, error: REMOVE_SELF_ERROR };
    const member = row.key_class === "human" || db.prepare(`SELECT 1 FROM workspace_members WHERE org_id = ? AND agent_id = ?`).get(orgId, row.id);
    if (member) return { ok: false, status: 400, error: REMOVE_MEMBER_ERROR };
    // Not a SHA-256 hex digest, so no key hashes to it (the same idea as a session agent's placeholder in src/devices.ts).
    const unusableKeyHash = `removed:${randomBytes(32).toString("hex")}`;
    db.prepare(
      `UPDATE agents SET removed_at = datetime('now'), removed_by_agent_name = ?, api_key_hash = ?,
         ended_at = CASE WHEN kind = 'session' THEN COALESCE(ended_at, datetime('now')) ELSE ended_at END
       WHERE id = ? AND org_id = ?`,
    ).run(actor.name, unusableKeyHash, row.id, orgId);
    // A connector agent's approval ends with it (plan 2026-09-29 §7.6): its grant is revoked, so approving the same
    // client again makes a fresh grant and agent, and its token families are revoked with it.
    const revokedAt = new Date().toISOString();
    db.prepare(`UPDATE oauth_grants SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL`).run(revokedAt, row.id);
    db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL`).run(revokedAt, row.id);
    emitEvent({ orgId, type: "agent.removed", actor, subjectType: "agent", subjectId: row.id, payload: { agentName: row.name } });
    return { ok: true, agentId: row.id, agentName: row.name };
  })();
  if (!outcome.ok) return outcome;
  disconnectAgent(agentId, "agent removed");
  endHeldRequests(agentId, 401, "This agent was removed by an operator.");
  return outcome;
}

/** Watcher-class keys peek by default so ingest scripts cannot steal mail (Incident 1). */
export function resolvePeekDefault(keyClass: KeyClass, explicitPeek?: boolean): boolean {
  if (explicitPeek !== undefined) return explicitPeek;
  return keyClass === "watcher";
}

export function heartbeat(orgId: string, agentId: string): void {
  db.transaction(() => {
    // A removed agent has no liveness: a wait it held can still be finishing in the background after its request was cut off.
    const row = db.prepare(`SELECT status FROM agents WHERE id = ? AND org_id = ? AND removed_at IS NULL`).get(agentId, orgId) as { status: string } | undefined;
    if (!row) return;
    // Always refresh liveness. If the agent was auto-suspended for staleness
    // (status=paused), a real call unsuspends it -- turn-based agents (Grok,
    // Cursor Cloud) go stale between turns and must come back on next contact.
    if (row.status === "paused") {
      db.prepare(
        `UPDATE agents SET last_heartbeat_at = datetime('now'), status = 'active' WHERE id = ? AND org_id = ?`,
      ).run(agentId, orgId);
      emitEvent({
        orgId,
        type: "agent.resumed",
        subjectType: "agent",
        subjectId: agentId,
        payload: { reason: "heartbeat" },
      });
    } else {
      db.prepare(`UPDATE agents SET last_heartbeat_at = datetime('now') WHERE id = ? AND org_id = ?`).run(agentId, orgId);
    }
  })();
}

/** Auto-suspend active agents whose last_heartbeat_at is null or older than
 * OPENCADRE_STALE_AFTER_MS (default 30m). Sets status=paused (paused =
 * auto-suspended for staleness), emits agent.stale then agent.suspended.
 * Idempotent: already-paused agents are skipped (no re-emit). Does not touch
 * auth -- paused agents still authenticate; resume happens via heartbeat().
 * An agent that is out of usage is expected to be silent, so it is left active. */
export function sweepStaleAgents(nowMs: number = Date.now()): { suspended: string[] } {
  const threshold = staleAfterMs();
  const cutoffMs = nowMs - threshold;
  const orgs = db.prepare(`SELECT id FROM organizations`).all() as Array<{ id: string }>;
  const suspended: string[] = [];
  for (const { id: orgId } of orgs) {
    const candidates = db
      // People aren't agents on a heartbeat loop: a member who closes the console isn't "stale".
      // Session agents have their own idle sweep (sweepIdleSessions in src/devices.ts), so the two never race.
      .prepare(`SELECT id, last_heartbeat_at, usage FROM agents WHERE org_id = ? AND status = 'active' AND key_class != 'human' AND kind != 'session' AND removed_at IS NULL`)
      .all(orgId) as Array<{ id: string; last_heartbeat_at: string | null; usage: string | null }>;
    for (const agent of candidates) {
      const beatMs = agent.last_heartbeat_at
        ? new Date(agent.last_heartbeat_at + "Z").getTime()
        : null;
      const isStale = beatMs == null || beatMs < cutoffMs;
      if (!isStale || currentUsage(agent.usage, nowMs)?.limited) continue;
      db.transaction(() => {
        // Re-check status inside the transaction for idempotency under concurrent sweeps.
        const current = db.prepare(`SELECT status FROM agents WHERE id = ? AND org_id = ?`).get(agent.id, orgId) as { status: string } | undefined;
        if (!current || current.status !== "active") return;
        db.prepare(`UPDATE agents SET status = 'paused' WHERE id = ? AND org_id = ?`).run(agent.id, orgId);
        emitEvent({
          orgId,
          type: "agent.stale",
          subjectType: "agent",
          subjectId: agent.id,
          payload: {
            reason: "heartbeat_stale",
            lastHeartbeatAt: agent.last_heartbeat_at,
            staleAfterMs: threshold,
          },
        });
        emitEvent({
          orgId,
          type: "agent.suspended",
          subjectType: "agent",
          subjectId: agent.id,
          payload: { reason: "heartbeat_stale" },
        });
        suspended.push(agent.id);
      })();
    }
  }
  return { suspended };
}

/** Lets an agent register a webhook URL (e.g. a Cursor Automation's
 * webhook trigger) that gets POSTed the instant a message arrives for it
 * while it has no live WebSocket open -- turns the "offline" fallback path
 * from silent polling into a real, instant, event-driven wake-up for any
 * client whose platform can receive a webhook, even if that platform can't
 * hold a persistent connection to us. webhookAuthHeader is stored verbatim
 * and sent as-is (e.g. "Bearer <cursor-issued-key>") -- callers must supply
 * whatever their receiving platform's webhook trigger actually expects.
 * A changed address or header clears the last wake's outcome, which described the old one, and ends any wake chain
 * still running for the old one (it gives up the agent's slot), even if a later change restores the same address and
 * header: that chain carries an older message and must never resume, nor make the next message count as covered.
 * Every path that sets a webhook comes through here (the person's PUT, POST /v1/webhook and register_webhook). */
export function setAgentWebhook(
  orgId: string,
  agentId: string,
  webhookUrl: string | null,
  webhookAuthHeader: string | null,
): void {
  const before = db.prepare(`SELECT webhook_url, webhook_auth_header FROM agents WHERE id = ? AND org_id = ?`)
    .get(agentId, orgId) as { webhook_url: string | null; webhook_auth_header: string | null } | undefined;
  const changed = before !== undefined && (before.webhook_url !== webhookUrl || before.webhook_auth_header !== webhookAuthHeader);
  if (changed) wakesInProgress.delete(agentId);
  // After the change commits (a caller may be inside a transaction), wake the new webhook for mail already waiting.
  if (changed && webhookUrl !== null) setImmediate(() => rewakeForUnread(orgId, agentId));
  db.prepare(
    `UPDATE agents SET
       last_wake_at = CASE WHEN webhook_url IS @url AND webhook_auth_header IS @header THEN last_wake_at END,
       last_wake_outcome = CASE WHEN webhook_url IS @url AND webhook_auth_header IS @header THEN last_wake_outcome END,
       last_wake_status = CASE WHEN webhook_url IS @url AND webhook_auth_header IS @header THEN last_wake_status END,
       webhook_url = @url, webhook_auth_header = @header
     WHERE id = @agentId AND org_id = @orgId`,
  ).run({ url: webhookUrl, header: webhookAuthHeader, agentId, orgId });
}

export const WAKE_PERSON_ERROR = "A person's own agent's wake can't be set here: its mail would go to that address.";
export const WAKE_OPERATOR_ERROR = "Only an owner can set an operator agent's wake: its mail would go to that address.";

/** The wake as a person sees it: the host, and only whether a URL and a header are set. The full URL is never shown
 * back (its path or query can carry a token), and neither is the header. */
export type OrgAgentWebhook = {
  ok: true; agentId: string; agentName: string; webhook_host: string | null; webhook_url_set: boolean; webhook_auth_set: boolean; last_wake: LastWake;
  /** On a set: whether the address or header actually changed (an identical re-PUT changes nothing). */
  changed?: boolean;
};
export type OrgAgentWebhookResult = OrgAgentWebhook | { ok: false; status: 400 | 403 | 404; error: string };

/** How the most recent wake POST to the agent's current webhook went (migration 59): when, the outcome, and the HTTP
 * status code (null when there was no answer). Never the response body. */
export type WakeResult = "delivered" | "rejected" | "failed" | "gave_up";
export type LastWake = { at: string; outcome: WakeResult; status: number | null } | null;
type LastWakeColumns = { last_wake_at: string | null; last_wake_outcome: string | null; last_wake_status: number | null };
const lastWakeOf = (row: LastWakeColumns): LastWake =>
  row.last_wake_at && row.last_wake_outcome ? { at: row.last_wake_at, outcome: row.last_wake_outcome as WakeResult, status: row.last_wake_status } : null;

type WakeTargetRow = LastWakeColumns & { name: string; role: string; webhook_url: string | null; webhook_auth_header: string | null; person: number };

/** Whose wake a person may point where (PUT/GET /v1/org/agents/:agentId/webhook). The wake POST carries each message's
 * body and sender (notifyWebhookBestEffort), so setting an agent's wake is reading its mail: never a person's own agent
 * (key_class human or a member row, as rotateAgentKey checks), and an operator-role agent only for an owner. Scoped to
 * the org first, so another workspace's agent is not found rather than refused. */
function wakeTarget(orgId: string, agentId: string, callerIsOwner: boolean): { ok: true; row: WakeTargetRow } | { ok: false; status: 403 | 404; error: string } {
  const row = db.prepare(
    `SELECT a.name, a.role, a.webhook_url, a.webhook_auth_header, a.last_wake_at, a.last_wake_outcome, a.last_wake_status,
       (a.key_class = 'human' OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.agent_id = a.id)) AS person
     FROM agents a WHERE a.id = ? AND a.org_id = ? AND a.removed_at IS NULL`,
  ).get(agentId, orgId) as WakeTargetRow | undefined;
  if (!row) return { ok: false, status: 404, error: "agent not found" };
  if (row.person) return { ok: false, status: 403, error: WAKE_PERSON_ERROR };
  if (row.role === "operator" && !callerIsOwner) return { ok: false, status: 403, error: WAKE_OPERATOR_ERROR };
  return { ok: true, row };
}

// The same address once parsed (letter case in the scheme or host, a default port): anything else is another
// destination, even at the same origin, since routines on a shared host differ only by path.
const sameAddress = (a: string | null, b: string) => {
  try {
    return a !== null && new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
};
const hostOf = (url: string | null) => {
  try {
    return url === null ? null : new URL(url).host;
  } catch {
    return null;
  }
};
const wakeView = (agentId: string, name: string, url: string | null, header: string | null, lastWake: LastWake): OrgAgentWebhook =>
  ({ ok: true, agentId, agentName: name, webhook_host: hostOf(url), webhook_url_set: url !== null, webhook_auth_set: header !== null, last_wake: lastWake });

export function getOrgAgentWebhook(orgId: string, agentId: string, callerIsOwner: boolean): OrgAgentWebhookResult {
  const target = wakeTarget(orgId, agentId, callerIsOwner);
  if (!target.ok) return target;
  const { row } = target;
  return wakeView(agentId, row.name, row.webhook_url, row.webhook_auth_header, lastWakeOf(row));
}

/** A person sets another agent's webhook from the console (PUT /v1/org/agents/:agentId/webhook), so an app that
 * can't see its own trigger's key never carries it. A null URL clears the header too; an omitted (undefined) URL keeps
 * the stored one, so the header alone can change. An omitted header keeps the stored one only while the address
 * doesn't change (no url, or the stored URL once parsed), so nobody can move it to their own server, or their own path
 * on a shared host, and receive a secret they can't read; null or "" clears it. The timeline names the agent, the URL's
 * host and the host it replaced only: never the header, and never the path or query, which can carry a token. */
export function setOrgAgentWebhook(
  orgId: string,
  actor: { id: string; name: string },
  agentId: string,
  callerIsOwner: boolean,
  webhookUrl: string | null | undefined,
  webhookAuthHeader: string | null | undefined,
): OrgAgentWebhookResult {
  return db.transaction((): OrgAgentWebhookResult => {
    const target = wakeTarget(orgId, agentId, callerIsOwner);
    if (!target.ok) return target;
    const { row } = target;
    const url = webhookUrl === undefined ? row.webhook_url : webhookUrl;
    if (webhookUrl === undefined && url === null) return { ok: false, status: 400, error: "url is required: this agent has no wake webhook yet" };
    // An omitted url is the stored one, so it is the same address and keeps the header.
    const header = url === null ? null
      : webhookAuthHeader !== undefined ? webhookAuthHeader || null
      : sameAddress(row.webhook_url, url) ? row.webhook_auth_header : null;
    setAgentWebhook(orgId, agentId, url, header);
    // An overwrite or a clear names the host it replaced, so a changed destination shows on the timeline.
    const previousHost = hostOf(row.webhook_url);
    const replaced = previousHost === null ? {} : { previousHost };
    emitEvent(url === null
      ? { orgId, type: "agent.webhook_cleared", actor, subjectType: "agent", subjectId: agentId, payload: { agentName: row.name, ...replaced } }
      : { orgId, type: "agent.webhook_set", actor, subjectType: "agent", subjectId: agentId,
          payload: { agentName: row.name, host: hostOf(url), authHeaderSet: header !== null, ...replaced } });
    // setAgentWebhook keeps the last wake only while neither the address nor the header changed.
    const unchanged = row.webhook_url === url && row.webhook_auth_header === header;
    return { ...wakeView(agentId, row.name, url, header, unchanged ? lastWakeOf(row) : null), changed: !unchanged };
  })();
}

/** One wake POST on a person's request (POST /v1/org/agents/:agentId/webhook/test), to check the address and header:
 * the same guarded POST and header as a real wake, and no retry. The body says only that it is a test, never who asked:
 * the receiver is a third party. Its outcome is recorded like any wake's. The same target rules as setting the webhook. */
export async function sendTestWake(orgId: string, agentId: string, callerIsOwner: boolean): Promise<OrgAgentWebhookResult> {
  const target = wakeTarget(orgId, agentId, callerIsOwner);
  if (!target.ok) return target;
  const { row } = target;
  if (row.webhook_url === null) return { ok: false, status: 400, error: "this agent has no wake webhook to test" };
  await postWake(agentId, row.webhook_url, row.webhook_auth_header, newId(), 1, JSON.stringify({ type: "wake.test" }));
  return getOrgAgentWebhook(orgId, agentId, callerIsOwner);
}

type WebhookOutcome = "delivered" | "retry" | "give_up";

/** Records a wake POST's outcome on the agent, only while its webhook is still the address and header the POST used, so
 * a POST still in flight for an old address or key can't describe the new one. "gave_up" keeps the last attempt's
 * status. */
function recordWakeOutcome(agentId: string, url: string, header: string | null, outcome: WakeResult, status: number | null): void {
  db.prepare(
    `UPDATE agents SET last_wake_at = datetime('now'), last_wake_outcome = @outcome,
       last_wake_status = CASE WHEN @outcome = 'gave_up' THEN last_wake_status ELSE @status END
     WHERE id = @agentId AND webhook_url IS @url AND webhook_auth_header IS @header`,
  ).run({ outcome, status, agentId, url, header });
}

/** One wake POST, its outcome recorded: delivered (2xx), rejected (any other status) or failed (no answer). */
async function postWake(
  agentId: string, url: string, authHeader: string | null, eventId: string, attempt: number, body: string,
): Promise<{ result: "delivered" | "rejected" | "failed"; status: number | null }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // The same id on every attempt, so a receiver can ignore a delivery it already handled.
    "x-opencadre-event-id": eventId,
    "x-opencadre-attempt": String(attempt),
  };
  if (authHeader) headers["authorization"] = authHeader;
  let status: number;
  try {
    // Guarded: https to public addresses only, checked at connect time, no redirects (src/webhook-guard.ts).
    status = await postWebhook(url, headers, body, 5000);
  } catch (err) {
    log.warn("webhook notify failed", { agentId, eventId, attempt, error: err });
    recordWakeOutcome(agentId, url, authHeader, "failed", null);
    return { result: "failed", status: null };
  }
  const delivered = status >= 200 && status < 300;
  if (!delivered) log.warn("webhook rejected", { agentId, eventId, attempt, status });
  recordWakeOutcome(agentId, url, authHeader, delivered ? "delivered" : "rejected", status);
  return { result: delivered ? "delivered" : "rejected", status };
}

async function fireWebhookOnce(target: AgentRecord, eventId: string, attempt: number, payload: Record<string, unknown>): Promise<WebhookOutcome> {
  if (!target.webhook_url) return "give_up";
  const { result, status } = await postWake(target.id, target.webhook_url, target.webhook_auth_header, eventId, attempt, JSON.stringify({ ...payload, eventId, attempt }));
  if (result === "delivered") return "delivered";
  if (result === "failed" || status === null) return "retry";
  // A 4xx means the receiver refuses this request; repeating it won't help (408 and 429 are the exceptions).
  return status >= 500 || status === 408 || status === 429 ? "retry" : "give_up";
}

/** Seconds to wait before each retry. Low priority never wakes anyone, so it has no webhook at all. */
function retryDelaysMs(priority: Priority): number[] {
  const override = process.env.OPENCADRE_WEBHOOK_RETRY_MS;
  if (override) return override.split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  return priority === "high" ? [3_000, 15_000, 60_000] : [5_000, 30_000];
}

/** Agents with a webhook wake still being attempted, and the address and header that chain POSTs to. A wake is a
 * wake: the agent reads all of its mail when it runs, so a burst of messages to an unreachable agent starts one retry
 * chain, not one per message. One chain per agent PER WEBHOOK: once the webhook changes, the old chain is stale, and a
 * new message replaces it with a chain to the current address instead of waiting for it. */
type WakeChain = { url: string; header: string | null };
const wakesInProgress = new Map<string, WakeChain>();
const isRead = db.prepare(`SELECT read_at IS NOT NULL AS read FROM messages WHERE id = ?`);
const currentWebhook = db.prepare(`SELECT webhook_url, webhook_auth_header FROM agents WHERE id = ? AND removed_at IS NULL`);
/** Whether the agent's webhook is still the address and header a wake chain started with. */
const stillTheWebhook = (target: AgentRecord) => {
  const now = currentWebhook.get(target.id) as { webhook_url: string | null; webhook_auth_header: string | null } | undefined;
  return now !== undefined && now.webhook_url === target.webhook_url && now.webhook_auth_header === target.webhook_auth_header;
};

/** Priority-aware wake-up. Low priority never interrupts anyone: it waits in the durable inbox. Medium and
 * high POST the recipient's webhook and retry failures with backoff (high harder), each attempt carrying
 * the same event id. A retry is skipped once the message has been read another way. Retries are held in
 * memory, so a hub restart drops the remaining ones; the message itself is always durable in the inbox. */
async function notifyWebhookBestEffort(
  target: AgentRecord,
  eventId: string,
  payload: Record<string, unknown>,
  priority: Priority,
): Promise<void> {
  if (!target.webhook_url || priority === "low") return;
  // `target` was read when this message was sent, so it is the current webhook. A chain already running to it covers
  // this message; a chain to an older address or key is stale, and this one takes its slot (it stops at its next check).
  const running = wakesInProgress.get(target.id);
  if (running && running.url === target.webhook_url && running.header === target.webhook_auth_header) return;
  const chain: WakeChain = { url: target.webhook_url, header: target.webhook_auth_header };
  wakesInProgress.set(target.id, chain);
  try {
    const delays = retryDelaysMs(priority);
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
      if (attempt > 1 && (isRead.get(eventId) as { read: number } | undefined)?.read) return;
      // A person may have changed or cleared the webhook since this chain started, or a newer chain replaced it: then
      // the body never goes to the old address again, nor to the new one under the old key. Stops quietly, records nothing.
      if (wakesInProgress.get(target.id) !== chain || !stillTheWebhook(target)) return;
      const outcome = await fireWebhookOnce(target, eventId, attempt, { ...payload, priority });
      if (outcome !== "retry") return;
      if (attempt > delays.length) {
        log.warn("webhook gave up after retries", { agentId: target.id, eventId, attempts: attempt });
        recordWakeOutcome(target.id, target.webhook_url, target.webhook_auth_header, "gave_up", null);
        return;
      }
      await new Promise((r) => setTimeout(r, delays[attempt - 1]).unref?.());
    }
  } finally {
    // Only this chain's own slot: a newer chain that replaced it keeps running.
    if (wakesInProgress.get(target.id) === chain) wakesInProgress.delete(target.id);
  }
}

/** A webhook was just set or changed (setAgentWebhook, every path): if mail that wakes an agent is still unread, wake the
 * new webhook now for the most recent such message. Typical case: the old webhook was failing (a bad key, a 503), its
 * chain stops once the webhook changes, and without this the person's fix would leave the queued mail stranded until
 * the next message. A deliberate disclosure: the payload is the one that message's own wake carries (the same the next
 * message would send), to the address just chosen. Medium and high only, as a new message; nothing for an agent with a
 * live connection, whose mail was pushed to it. It goes through notifyWebhookBestEffort, so the one-chain-per-webhook
 * rule holds. */
function rewakeForUnread(orgId: string, agentId: string): void {
  if (hasLiveSocket(agentId)) return;
  const target = db.prepare(`SELECT * FROM agents WHERE id = ? AND org_id = ? AND removed_at IS NULL`).get(agentId, orgId) as AgentRecord | undefined;
  if (!target?.webhook_url) return;
  const m = db.prepare(
    `SELECT id, thread_id, from_agent_name, body, kind, priority, file_id FROM messages
     WHERE org_id = ? AND to_agent_id = ? AND read_at IS NULL AND kind IN ('message', 'question') AND priority IN ('medium', 'high')
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(orgId, agentId) as { id: string; thread_id: string; from_agent_name: string; body: string; kind: string; priority: Priority; file_id: string | null } | undefined;
  if (!m) return;
  const payload = m.kind === "question"
    ? { type: "question", threadId: m.thread_id, from: m.from_agent_name, body: m.body, awaitingReply: true }
    : { type: "message", threadId: m.thread_id, from: m.from_agent_name, body: m.body, fileId: m.file_id };
  void notifyWebhookBestEffort(target, m.id, payload, m.priority);
}

/** Presence: an agent is online while its last heartbeat is inside the TTL. */
export function isOnline(lastHeartbeatAt: string | null): boolean {
  return lastHeartbeatAt ? new Date(lastHeartbeatAt + "Z").getTime() > Date.now() - HEARTBEAT_TTL_MS : false;
}

/** A roster row. `webhook_url` and `device_id` are present only on the viewer's own row (see listActiveAgents). */
export type RosterAgent = Omit<AgentRecord, "webhook_url" | "webhook_auth_header" | "last_wake_at" | "last_wake_outcome" | "last_wake_status" | "usage" | "device_id" | "seat_id" | "tool_session_id" | "home_project" | "scope"> & {
  webhook_url?: string | null;
  device_id?: string | null;
  /** The agent's home project, resolved through the aliases; null for a person or a workspace-wide agent. */
  project_key: string | null;
  /** project | projects | workspace (a person is always workspace). */
  scope: string;
  online: boolean;
  editing_files_parsed: string[];
  /** File paths this agent shares with another ONLINE agent in the same project. Derived on read
   * from the same rule setAgentStatus applies at write time, so the roster's collision signal and
   * the writer's collision warning can never disagree. Empty means no live overlap -- it is the
   * normal state, not an error. Advisory only: this is never a lock (docs/decisions #1789). */
  collision_files: string[];
  /** The other agents sharing at least one of those paths, by name. Sorted for a stable render. */
  collision_agents: string[];
  usage: AgentUsage | null;
  state: AgentState;
  state_reason: string;
  /** A connector agent's OAuth client name, from its newest grant: the app it connected from, whatever the person named
   * the agent at consent or since. Only on kind 'connector' rows. */
  client_name?: string | null;
};

/** Fleet listing, returned as-is by GET /v1/agents: never carries the key hash or the webhook's auth header.
 * Includes `status` (active | paused) so callers can see auto-suspended agents; `online` is the 2-minute presence TTL.
 * `viewerAgentId` is whoever reads the roster: only that agent's own row keeps its `webhook_url` and `device_id`
 * (docs/design/PROJECT_ISOLATION.md §5). Without a viewer, no row carries them.
 * With project isolation on, a viewer sees only the agents it can reach (its own project, linked projects and
 * workspace-wide agents), each with its `project_key`. People (members) are always listed: they take part in every
 * project and can be messaged from any of them. */
export function listActiveAgents(orgId: string, viewerAgentId?: string): RosterAgent[] {
  const all = db
    // A removed member's row stays for history (their messages and events) but leaves the roster, and so do an ended session and a removed agent.
    .prepare(`SELECT * FROM agents WHERE org_id = ? AND (key_class != 'human' OR id IN (SELECT agent_id FROM workspace_members WHERE org_id = ?))
              AND NOT (kind = 'session' AND ended_at IS NOT NULL) AND removed_at IS NULL ORDER BY name`)
    .all(orgId, orgId) as Array<AgentRecord & { api_key_hash?: string; key_class?: string }>;
  const viewer = viewerAgentId === undefined ? null : { orgId, agentId: viewerAgentId };
  const rows = viewer ? all.filter((row) => row.id === viewer.agentId || row.key_class === "human" || isReachable(viewer, row)) : all;
  const countBy = (sql: string) =>
    new Map((db.prepare(sql).all(orgId) as Array<{ agent_id: string; n: number }>).map((row) => [row.agent_id, row.n]));
  const pendingApprovals = countBy(
    `SELECT requested_by_agent_id AS agent_id, COUNT(*) AS n FROM approvals
     WHERE org_id = ? AND status = 'pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') GROUP BY requested_by_agent_id`,
  );
  const openQuestions = countBy(
    `SELECT from_agent_id AS agent_id, COUNT(*) AS n FROM messages
     WHERE org_id = ? AND kind = 'question' AND awaiting_reply = 1
       AND created_at > datetime('now', '-1 day') GROUP BY from_agent_id`, // an abandoned question stops counting after a day
  );
  // A connector's OAuth client name, by its newest grant (ordered oldest first, so the newest wins the Map). Read by the
  // roster's connector ids (oauth_grants_agent_idx), and not at all when it has none. DCR is unauthenticated, so this is
  // the label the client chose for itself: it lets the console find the Grok Bot connection the person approved, whatever
  // they named it (src/oauth-authorize.ts); it does not prove which app holds the grant. A revoked grant still counts:
  // the name records where the connection came from, not whether it is live. A CIMD client has no oauth_clients row
  // (only DCR inserts one, src/oauth.ts), so its connector gets null today.
  // AgentRecord types kind as named | session; an OAuth connection is stored as 'connector' (src/oauth-authorize.ts).
  const connectorIds = rows.filter((row) => String(row.kind) === "connector").map((row) => row.id);
  const clientNames = new Map(connectorIds.length === 0 ? [] : (db.prepare(
    `SELECT g.agent_id, c.client_name FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
     WHERE g.agent_id IN (${connectorIds.map(() => "?").join(", ")}) AND g.org_id = ? ORDER BY g.created_at, g.rowid`,
  ).all(...connectorIds, orgId) as Array<{ agent_id: string; client_name: string | null }>).map((row) => [row.agent_id, row.client_name]));
  // A session's seat and tool session ids stay server-side: the roster is visible to every agent in the workspace.
  // So do another agent's webhook URL (it can carry a secret in its path or query) and its device id.
  // Each row names its project (resolved home) and scope, so a viewer can tell a linked project's agent from its own.
  const mapped: Array<Omit<RosterAgent, "collision_files" | "collision_agents">> = rows.map(({ api_key_hash: _hash, webhook_auth_header: _auth, last_wake_at: _wakeAt, last_wake_outcome: _wakeOutcome, last_wake_status: _wakeStatus, seat_id: _seat, tool_session_id: _tool, home_project, scope, webhook_url, device_id, ...rest }) => {
    const human = rest.key_class === "human";
    const placed = { ...rest, project_key: human ? null : resolveProjectKey(orgId, home_project), scope: human ? "workspace" : scope ?? "workspace" };
    const r = viewerAgentId !== undefined && rest.id === viewerAgentId ? { ...placed, webhook_url, device_id } : placed;
    const online = isOnline(r.last_heartbeat_at);
    const usage = currentUsage(r.usage);
    const { state, reason } = computeAgentState({
      online, status: r.status, phase: r.phase ?? null, statusUpdatedAt: r.status_updated_at,
      usageLimited: Boolean(usage?.limited), usageResetsAt: usage?.resetsAt ?? null,
      pendingApprovals: pendingApprovals.get(r.id) ?? 0, openQuestions: openQuestions.get(r.id) ?? 0,
    });
    // current_task is masked again here (in addition to setAgentStatus's write-time mask) as defense-in-depth for
    // rows written before masking existed (migration 14 also masks these in place, but this covers any row a future
    // write path might miss). editing_files is deliberately left unmasked, on read and on write: this same function's
    // return value is what setAgentStatus's own collision check compares by exact string equality against every other
    // online agent's file list, so masking it would risk false-negative collisions for negligible benefit -- a real
    // file path being secret-shaped is not the risk decision #1789 is about.
    return { ...r, current_task: maskSecrets(r.current_task ?? "") || null, online, editing_files_parsed: parseEditingFiles(r.editing_files), usage, state, state_reason: reason,
      ...(String(r.kind) === "connector" ? { client_name: clientNames.get(r.id) ?? null } : {}) };
  });
  // Collision state is DERIVED here rather than stored, for the same reason state/state_reason are: it
  // depends on other agents' current rows, so a stored copy would go stale the moment a neighbour changes
  // its files or drops offline. Computed after the rows are built, because each row's answer depends on
  // every other row's.
  return withCollisions(mapped);
}

/** Attach live collision state to a roster, using the SAME rule setAgentStatus applies when it warns a
 * writer: another agent counts only if it is ONLINE and shares the project (a named agent has no project
 * and is compared with everyone -- docs/design/PROJECT_ISOLATION.md §7 item 1). Keeping one definition in
 * one place is the point: the console and the writer's warning must not be able to disagree about whether
 * two agents are on the same file. */
function withCollisions(rows: Array<Omit<RosterAgent, "collision_files" | "collision_agents">>): RosterAgent[] {
  return rows.map((row) => {
    const mine = row.editing_files_parsed;
    if (mine.length === 0 || !row.online) return { ...row, collision_files: [], collision_agents: [] };
    const files = new Set<string>();
    const agents = new Set<string>();
    for (const other of rows) {
      if (other.id === row.id || !other.online) continue;
      if (!sameProjectOrUnknown(row.project_key, other.project_key)) continue;
      for (const f of other.editing_files_parsed) if (mine.includes(f)) files.add(f);
      // Named only when it actually shares a path: an agent in the project that overlaps on nothing is
      // not a collision partner, and listing it would make the signal unreadable at fleet scale.
      if (other.editing_files_parsed.some((f) => mine.includes(f))) agents.add(other.name);
    }
    return { ...row, collision_files: [...files].sort(), collision_agents: [...agents].sort() };
  });
}

function parseEditingFiles(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f) => typeof f === "string") : [];
  } catch {
    return [];
  }
}

/** Announces what this agent is currently doing, so the fleet has a clean,
 * current-state view (never a message log) of who's doing what and which
 * files are in play. Returns any OTHER active agent already editing an
 * overlapping file, as an advisory collision warning -- never a lock.
 * Real conflict prevention is still git's own push-rejection; this is
 * purely "so you can ask before you start," which is the actual, honest
 * value this kind of visibility can provide across independent agents. */
export const PHASES = ["planning", "editing", "testing", "reviewing", "waiting"] as const;
export type Phase = (typeof PHASES)[number];

/** `phase` undefined leaves the current phase unchanged; null clears it. */
export function setAgentStatus(
  orgId: string,
  agentId: string,
  task: string | null,
  files: string[],
  phase?: Phase | null,
): { collisions: Array<{ agentName: string; files: string[] }> } {
  if (phase != null && !(PHASES as readonly string[]).includes(phase)) {
    throw new Error(`phase must be one of ${PHASES.join(", ")}`);
  }
  // Status task text is agent-supplied free text, shown to the whole workspace (docs/decisions #1789): masked the
  // same way task text is (src/tasks.ts). editing_files is left untouched here -- setAgentStatus's own collision
  // check below compares these values by exact string equality against every other online agent's stored list, so
  // masking on write would silently break real-file collision detection; it is masked only for display, in
  // listActiveAgents below.
  const maskedTask = task === null ? null : maskSecrets(task);
  return db.transaction(() => {
    const before = db.prepare(`SELECT name, current_task, phase, project FROM agents WHERE id = ? AND org_id = ?`)
      .get(agentId, orgId) as { name: string; current_task: string | null; phase: string | null; project: string | null } | undefined;
    if (!before) return { collisions: [] };
    const actor = { id: agentId, name: before.name };
    const nextPhase = phase === undefined ? before.phase : phase;

    db.prepare(
      `UPDATE agents SET current_task = ?, editing_files = ?, phase = ?, status_updated_at = datetime('now') WHERE id = ? AND org_id = ?`,
    ).run(maskedTask, JSON.stringify(files), nextPhase, agentId, orgId);

    if (maskedTask !== before.current_task) {
      emitEvent({ orgId, type: "agent.task_changed", actor, subjectType: "agent", subjectId: agentId, payload: { from: before.current_task, to: maskedTask } });
    }
    if (nextPhase !== before.phase) {
      emitEvent({ orgId, type: "agent.phase_changed", actor, subjectType: "agent", subjectId: agentId, payload: { from: before.phase, to: nextPhase } });
    }

    if (files.length === 0) return { collisions: [] };
    const collisions: Array<{ agentName: string; files: string[] }> = [];
    // Two repos can both have src/index.ts: only agents in the same project collide. A named agent has no project
    // (NULL) and is still compared with everyone (docs/design/PROJECT_ISOLATION.md §7 item 1).
    const candidates = listActiveAgents(orgId).filter((a) => a.id !== agentId && a.online && sameProjectOrUnknown(before.project, a.project));
    for (const other of candidates) {
      const overlap = other.editing_files_parsed.filter((f) => files.includes(f));
      if (overlap.length === 0) continue;
      collisions.push({ agentName: other.name, files: overlap });
      emitEvent({
        orgId, type: "conflict.detected", actor, subjectType: "conflict", subjectId: newId(),
        targetAgentId: other.id, payload: { with: other.name, files: overlap },
      });
    }
    return { collisions };
  })();
}

/** What an agent's own client declares it can actually do (e.g. "shell", "git-write", "file-write") --
 * self-reported, not verified by the hub (the hub has no way to check what tools a remote client
 * actually wired up). Design retro finding: a task assigned to an agent whose bridge only exposes
 * hub-coordination tools surfaced the gap mid-task, after real effort, instead of at claim time.
 * create_task's requiredCapabilities + claim_task's check (src/tasks.ts) is the enforcement side;
 * this is where an agent tells the hub what it has. Replaces the whole list each call -- not a
 * merge -- so an agent that loses a capability (e.g. a worktree revoked) can accurately shrink it. */
export function setAgentCapabilities(orgId: string, agentId: string, capabilities: string[]): { ok: true; capabilities: string[] } | { ok: false; error: string } {
  const cleaned = [...new Set(capabilities.map((c) => c.trim()).filter(Boolean))];
  const changed = db.prepare(`UPDATE agents SET capabilities = ? WHERE id = ? AND org_id = ?`).run(JSON.stringify(cleaned), agentId, orgId).changes;
  if (changed === 0) return { ok: false, error: "agent not found" };
  const actorRow = db.prepare(`SELECT name FROM agents WHERE id = ? AND org_id = ?`).get(agentId, orgId) as { name: string } | undefined;
  emitEvent({
    orgId, type: "agent.capabilities_set", actor: { id: agentId, name: actorRow?.name ?? agentId },
    subjectType: "agent", subjectId: agentId, payload: { capabilities: cleaned },
  });
  return { ok: true, capabilities: cleaned };
}

export function getAgentCapabilities(orgId: string, agentId: string): string[] {
  const row = db.prepare(`SELECT capabilities FROM agents WHERE id = ? AND org_id = ?`).get(agentId, orgId) as { capabilities: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.capabilities);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/** What an agent's own client declares as its configured tool-call round cap (e.g. a bridge's
 * MAX_TOOL_ROUNDS) -- self-reported, not verified by the hub, same trust model as capabilities.
 * Stage 1 retro finding: a task needing many rounds can land on a bridge that silently truncates
 * mid-task once it hits its own cap. create_task's minRoundBudget + claim_task's check (src/tasks.ts)
 * is the enforcement side; this is where an agent tells the hub what its cap actually is. Pass null
 * to clear a previously-declared budget back to "unknown". */
export function setAgentRoundBudget(orgId: string, agentId: string, roundBudget: number | null): { ok: true; roundBudget: number | null } | { ok: false; error: string } {
  const cleaned = roundBudget === null ? null : Math.trunc(roundBudget);
  if (cleaned !== null && (!Number.isFinite(cleaned) || cleaned <= 0)) return { ok: false, error: "roundBudget must be a positive integer, or null to clear it" };
  const changed = db.prepare(`UPDATE agents SET round_budget = ? WHERE id = ? AND org_id = ?`).run(cleaned, agentId, orgId).changes;
  if (changed === 0) return { ok: false, error: "agent not found" };
  const actorRow = db.prepare(`SELECT name FROM agents WHERE id = ? AND org_id = ?`).get(agentId, orgId) as { name: string } | undefined;
  emitEvent({
    orgId, type: "agent.round_budget_set", actor: { id: agentId, name: actorRow?.name ?? agentId },
    subjectType: "agent", subjectId: agentId, payload: { roundBudget: cleaned },
  });
  return { ok: true, roundBudget: cleaned };
}

export function getAgentRoundBudget(orgId: string, agentId: string): number | null {
  const row = db.prepare(`SELECT round_budget FROM agents WHERE id = ? AND org_id = ?`).get(agentId, orgId) as { round_budget: number | null } | undefined;
  return row?.round_budget ?? null;
}

/** A living agent by name, url key or id. A removed one is "No agent found", even when its name has been reused.
 * `caller`: who is addressing it. With project isolation on, a target outside the caller's reach throws
 * NotReachableError (src/scope.ts), carrying the error text the caller sees. */
export function resolveAgent(orgId: string, nameOrKey: string, caller?: { id: string }): AgentRecord | null {
  // In order: an exact name, then a url key, then an id. One query with OR would return whichever row SQLite met first
  // when a name and another agent's url key or id are equal (names set before the rules that now refuse that).
  const lookup = (column: "name" | "url_key" | "id") => db
    .prepare(`SELECT * FROM agents WHERE org_id = ? AND ${column} = ? AND removed_at IS NULL`)
    .get(orgId, nameOrKey) as AgentRecord | undefined;
  const row = lookup("name") ?? lookup("url_key") ?? lookup("id");
  if (row && caller) assertReachable({ orgId, agentId: caller.id }, row);
  return row ?? null;
}

/** A refused message call. `code` NOT_REACHABLE: the target is outside the sender's projects (HTTP 403). */
export type MessageFailure = { ok: false; error: string; code?: typeof NOT_REACHABLE | typeof DUPLICATE_SEND };

/** Whether a sender is told WHY a target is out of reach (its project, and that an admin can link them): only people,
 * workspace-wide agents and operators, who can act on it. Anyone else gets the answer an unknown name gets, so an agent
 * in one project can't confirm another project's agent names or learn its name by guessing. */
function mayLearnReachability(orgId: string, agentId: string): boolean {
  if (isWorkspaceScope({ orgId, agentId })) return true;
  const row = db.prepare(`SELECT role FROM agents WHERE id = ? AND org_id = ?`).get(agentId, orgId) as { role: string | null } | undefined;
  return row?.role === "operator";
}

/** resolveAgent for a caller naming someone to address (a recipient, an approver): null when there is no such agent
 * OR when it is out of reach and the caller may not learn why, so both read the same. A caller who may learn why
 * (mayLearnReachability) gets the NotReachableError with the reason. The one place this rule is applied: every surface
 * that takes a name from the caller goes through here. */
export function resolveAddressable(orgId: string, nameOrKey: string, caller: { id: string }): AgentRecord | null {
  try {
    return resolveAgent(orgId, nameOrKey, caller);
  } catch (err) {
    if (err instanceof NotReachableError && !mayLearnReachability(orgId, caller.id)) return null;
    throw err;
  }
}

/** resolveAgent for a sender: a refusal becomes the error result a message call returns. */
function resolveTarget(orgId: string, nameOrKey: string, from: { id: string }): { ok: true; target: AgentRecord } | MessageFailure {
  try {
    const target = resolveAddressable(orgId, nameOrKey, from);
    return target ? { ok: true, target } : { ok: false, error: `No agent found matching "${nameOrKey}"` };
  } catch (err) {
    if (err instanceof NotReachableError) return { ok: false, error: err.message, code: NOT_REACHABLE };
    throw err;
  }
}

// Every recipient pays tokens to read a body, so one message can't flood an inbox.
export const MAX_MESSAGE_BODY_CHARS = 16000;
export const MESSAGE_BODY_TOO_LONG = `message body exceeds ${MAX_MESSAGE_BODY_CHARS} characters`;
/** Mail to a session agent that has ended would never be read by anyone. */
export const SESSION_ENDED_ERROR = "that session has ended";
const hasEnded = (agent: AgentRecord) => agent.kind === "session" && Boolean(agent.ended_at);
const bodyTooLong = (body: string) => body.length > MAX_MESSAGE_BODY_CHARS;

// FLEET_SCALING_AUDIT.md Incident 2, still open: one LLM turn sent 4 near-identical replies across
// separate threads. Client-side dedup (agent-inbox.mjs) only catches repeats within one process --
// a fresh turn, a restarted client, or a different tool path all bypass it. This is the server-side
// backstop the audit calls for: catch the SAME sender sending the SAME body (exact match after
// trimming -- a loose fuzzy match risks rejecting two genuinely different short messages that just
// happen to read alike) to a DIFFERENT recipient/thread within a short window.
//
// Deliberately in-memory, not persisted (same tradeoff as wakesInProgress above): a hub restart
// clears it, so a genuine repeat right after a restart isn't caught -- acceptable, since the failure
// mode this guards against is a single runaway turn re-sending itself, not a slow leak across
// restarts. Deliberately does NOT cover broadcastMessage: sending the same body to many recipients
// is broadcast's entire purpose, not the accidental-repetition pattern this targets.
export const DUPLICATE_SEND = "DUPLICATE_SEND";
const DUPLICATE_SEND_WINDOW_MS = 60_000;
// Below this length, exact-repeat collisions are far more likely to be legitimate routine text
// (an ack, a short status phrase, a test/probe fixture literal) than the accidental-repetition
// pattern this guards against -- confirmed the hard way: the project-isolation completeness matrix
// legitimately calls sendMessage with the fixed literal "from alpha" across many scenarios, which a
// length-blind check flagged as duplicates. The audit's actual reported incident (Incident 2) was
// several near-identical PARAGRAPHS, not a short phrase, so this threshold costs little real
// coverage while cutting the false-positive rate on short boilerplate to near zero.
const DUPLICATE_SEND_MIN_BODY_CHARS = 80;
const recentSendsByAgent = new Map<string, Array<{ body: string; target: string; at: number }>>();
export const duplicateSendError = (priorDestination: string) =>
  `You already sent this exact message to ${priorDestination} in the last minute. Reply once and reference the other thread if the other recipient needs to know, or use broadcast_message if this is meant for several people -- don't repeat the same body verbatim across threads.`;

/** Records a send and reports whether the SAME sender already sent this SAME body (trimmed, exact,
 * and long enough to matter -- see DUPLICATE_SEND_MIN_BODY_CHARS) to a DIFFERENT target within the
 * window. `target` should be specific enough that two sends to the same actual recipient never
 * count as a duplicate of each other (e.g. the resolved agent id, not a display name that could
 * collide) -- this guards against fan-out-by-accident, not against a legitimate retry to the same
 * recipient. */
function checkAndRecordDuplicateSend(agentId: string, body: string, target: string): { duplicate: true; priorTarget: string } | { duplicate: false } {
  const normalized = body.trim();
  if (normalized.length < DUPLICATE_SEND_MIN_BODY_CHARS) return { duplicate: false };
  const now = Date.now();
  const entries = (recentSendsByAgent.get(agentId) ?? []).filter((e) => now - e.at < DUPLICATE_SEND_WINDOW_MS);
  const dup = entries.find((e) => e.body === normalized && e.target !== target);
  entries.push({ body: normalized, target, at: now });
  recentSendsByAgent.set(agentId, entries);
  return dup ? { duplicate: true, priorTarget: dup.target } : { duplicate: false };
}

const MESSAGE_EVENT = { message: "message.sent", question: "question.asked", reply: "question.answered" } as const;

function insertMessage(row: {
  orgId: string;
  threadId: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  body: string;
  kind: "message" | "question" | "reply";
  priority?: Priority;
  awaitingReply: boolean;
  fileId?: string | null;
}): string {
  const id = newId();
  // The fleet protocol forbids keys in messages (AGENT-COORDINATION.md), so a secret-shaped substring here is
  // always a mistake, never intentional payload (docs/decisions #1789) -- mask the same way task/approval text is.
  const maskedBody = maskSecrets(row.body);
  db.transaction(() => {
    // Stamped with both ends' home projects (PROJECT_ISOLATION.md §4): equal within a project, different across a link.
    db.prepare(
      `INSERT INTO messages (id, org_id, thread_id, from_agent_id, from_agent_name, to_agent_id, to_agent_name, body, kind, priority, awaiting_reply, file_id, project_key, to_project_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      row.orgId,
      row.threadId,
      row.fromAgentId,
      row.fromAgentName,
      row.toAgentId,
      row.toAgentName,
      maskedBody,
      row.kind,
      row.priority ?? "medium",
      row.awaitingReply ? 1 : 0,
      row.fileId ?? null,
      stampFor(row.orgId, row.fromAgentId),
      stampFor(row.orgId, row.toAgentId),
    );
    emitEvent({
      orgId: row.orgId, type: MESSAGE_EVENT[row.kind], actor: { id: row.fromAgentId, name: row.fromAgentName },
      subjectType: "message", subjectId: id, targetAgentId: row.toAgentId,
      payload: { threadId: row.threadId, priority: row.priority ?? "medium", ...(row.fileId ? { fileId: row.fileId } : {}) },
    });
  })();
  // Real, immediate wake-up for anything long-polling wait_for_message --
  // "pure coordination without chaos" means low-priority mail still lands
  // durably and is still visible to a long-poller (this is not an
  // interrupt, just "something new exists"), while webhook/live-push
  // urgency below is what's actually gated by priority.
  notifyInboxWaiters(row.toAgentId);
  return id;
}

export async function sendMessage(
  orgId: string,
  from: { id: string; name: string },
  toNameOrKey: string,
  body: string,
  priority: Priority = "medium",
  fileId: string | null = null,
  // Internal only, never exposed via REST/MCP: broadcastMessage's whole purpose is sending the same
  // body to many recipients, which is exactly the pattern the duplicate-send guard exists to catch
  // for a single accidental repeat -- so its internal loop opts out here instead of every genuine
  // broadcast tripping the guard on its second recipient.
  opts: { skipDuplicateCheck?: boolean } = {},
): Promise<{ ok: true; threadId: string; delivered: "live" | "queued" } | MessageFailure> {
  if (bodyTooLong(body)) return { ok: false, error: MESSAGE_BODY_TOO_LONG };
  const resolved = resolveTarget(orgId, toNameOrKey, from);
  if (!resolved.ok) return resolved;
  const { target } = resolved;
  if (hasEnded(target)) return { ok: false, error: SESSION_ENDED_ERROR };
  if (!opts.skipDuplicateCheck) {
    const dupCheck = checkAndRecordDuplicateSend(from.id, body, target.id);
    if (dupCheck.duplicate) {
      const priorName = (db.prepare(`SELECT name FROM agents WHERE id = ? AND org_id = ?`).get(dupCheck.priorTarget, orgId) as { name: string } | undefined)?.name ?? dupCheck.priorTarget;
      return { ok: false, error: duplicateSendError(priorName), code: DUPLICATE_SEND };
    }
  }
  const threadId = newId();
  const id = insertMessage({
    orgId, threadId, fromAgentId: from.id, fromAgentName: from.name,
    toAgentId: target.id, toAgentName: target.name, body, kind: "message", priority, awaitingReply: false, fileId,
  });
  const delivered = pushToAgent(target.id, {
    type: "message", id, threadId, from: from.name, body, priority, fileId,
  });
  if (delivered) markDelivered([id]);
  if (!delivered) {
    void notifyWebhookBestEffort(target, id, { type: "message", threadId, from: from.name, body, fileId }, priority);
  }
  return { ok: true, threadId, delivered: delivered ? "live" : "queued" };
}

export type BroadcastDelivery =
  | { ok: true; toAgent: string; threadId: string; delivered: "live" | "queued" }
  | { ok: false; toAgent: string; error: string };

export type BroadcastChannel = "project" | "org";
export const ORG_CHANNEL_FORBIDDEN = 'channel "org" reaches every project, so only a workspace-wide agent may use it. Use channel "project" or toAgents.';
export const NO_HOME_PROJECT = 'channel "project" needs an agent that belongs to a project. Use channel "org" or toAgents.';

/** Fan-out one body to many agents. Each recipient gets an independent thread.
 * - channel "project" (broadcast_message's default): the other live agents that belong to the sender's own project(s).
 *   People and workspace-wide agents aren't included.
 * - channel "org": every other live agent and person in the workspace. With project isolation on, only a workspace-scope
 *   sender may use it (status 403 otherwise).
 * - toAgents: those names, each checked exactly like send_message. */
export async function broadcastMessage(
  orgId: string,
  from: { id: string; name: string },
  targets: { toAgents: string[] } | { channel: BroadcastChannel },
  body: string,
  priority: Priority = "medium",
): Promise<{ ok: true; deliveries: BroadcastDelivery[] } | { ok: false; error: string; status?: 400 | 403 }> {
  if (bodyTooLong(body)) return { ok: false, error: MESSAGE_BODY_TOO_LONG };
  const sender = { orgId, agentId: from.id };
  let names: string[];
  if (!("channel" in targets)) {
    names = [...new Set(targets.toAgents.map((n) => n.trim()).filter(Boolean))];
  } else if (targets.channel === "org") {
    if (projectIsolationEnabled(orgId) && !isWorkspaceScope(sender)) return { ok: false, error: ORG_CHANNEL_FORBIDDEN, status: 403 };
    names = listActiveAgents(orgId).filter((a) => a.id !== from.id).map((a) => a.name);
  } else {
    const own = ownProjectsOf(sender);
    if (!own?.length) return { ok: false, error: NO_HOME_PROJECT };
    names = listActiveAgents(orgId)
      .filter((a) => a.id !== from.id && a.scope !== "workspace" && (ownProjectsOf({ orgId, agentId: a.id }) ?? []).some((k) => own.includes(k)))
      .map((a) => a.name);
  }

  if (names.length === 0) {
    return { ok: false, error: "No recipients — provide toAgents or use channel=\"org\" with other agents registered" };
  }

  // FLEET_SCALING_AUDIT.md finding 2: broadcastMessage used to await sendMessage in a sequential
  // loop, one SQLite transaction per recipient -- N recipients meant N separate BEGIN/COMMIT round
  // trips, holding (and re-acquiring) the single writer lock N times for what is logically one
  // fan-out write. resolveAndInsert below is the same resolve-then-insertMessage logic sendMessage
  // uses, but purely synchronous (no network-ish push/webhook side effects), so every recipient's
  // resolution and insert can run inside ONE outer db.transaction() -- insertMessage's own internal
  // transaction() call becomes a nested savepoint automatically (better-sqlite3), so this changes
  // only the write-lock hold time, never the per-row atomicity or event semantics. The async
  // delivery step (live push / webhook) still runs per recipient, after the transaction commits --
  // unchanged in behavior, since it never touched SQLite in the first place.
  type Resolved =
    | { ok: true; toAgent: string; target: AgentRecord; id: string; threadId: string }
    | { ok: false; toAgent: string; error: string };
  const resolveAndInsert = (toAgent: string): Resolved => {
    const resolved = resolveTarget(orgId, toAgent, from);
    if (!resolved.ok) return { ok: false, toAgent, error: resolved.error };
    const { target } = resolved;
    if (hasEnded(target)) return { ok: false, toAgent, error: SESSION_ENDED_ERROR };
    const threadId = newId();
    const id = insertMessage({
      orgId, threadId, fromAgentId: from.id, fromAgentName: from.name,
      toAgentId: target.id, toAgentName: target.name, body, kind: "message", priority, awaitingReply: false, fileId: null,
    });
    return { ok: true, toAgent, target, id, threadId };
  };
  const resolvedAll = db.transaction(() => names.map(resolveAndInsert))();

  const deliveries: BroadcastDelivery[] = resolvedAll.map((r) => {
    if (!r.ok) return { ok: false, toAgent: r.toAgent, error: r.error };
    const delivered = pushToAgent(r.target.id, { type: "message", id: r.id, threadId: r.threadId, from: from.name, body, priority, fileId: null });
    if (delivered) markDelivered([r.id]);
    else void notifyWebhookBestEffort(r.target, r.id, { type: "message", threadId: r.threadId, from: from.name, body, fileId: null }, priority);
    return { ok: true, toAgent: r.toAgent, threadId: r.threadId, delivered: delivered ? "live" : "queued" };
  });
  return { ok: true, deliveries };
}

export async function askClarification(
  orgId: string,
  from: { id: string; name: string },
  toNameOrKey: string,
  body: string,
  timeoutSeconds: number,
  priority: Priority = "medium",
): Promise<{ ok: true; live: boolean; answer?: string; threadId: string } | MessageFailure> {
  if (bodyTooLong(body)) return { ok: false, error: MESSAGE_BODY_TOO_LONG };
  const resolved = resolveTarget(orgId, toNameOrKey, from);
  if (!resolved.ok) return resolved;
  const { target } = resolved;
  if (hasEnded(target)) return { ok: false, error: SESSION_ENDED_ERROR };
  const threadId = newId();

  const id = insertMessage({
    orgId, threadId, fromAgentId: from.id, fromAgentName: from.name,
    toAgentId: target.id, toAgentName: target.name, body, kind: "question", priority, awaitingReply: true,
  });

  const delivered = pushToAgent(target.id, {
    type: "question", id, threadId, from: from.name, body, priority, awaitingReply: true,
  });
  if (delivered) markDelivered([id]);

  if (!delivered) {
    void notifyWebhookBestEffort(target, id, {
      type: "question", threadId, from: from.name, body, awaitingReply: true,
    }, priority);
    return { ok: true, live: false, threadId };
  }

  // Target is live (has an open connection) — wait for its reply to land on
  // THIS thread via the live channel, bounded by timeoutSeconds. If it
  // times out, the question stays durably queued exactly as if delivery
  // had been offline all along.
  const reply = await waitForReply(threadId, timeoutSeconds * 1000);
  if (reply) {
    return { ok: true, live: true, answer: reply, threadId };
  }
  return { ok: true, live: false, threadId };
}

const MAX_MESSAGE_PAGE = 100;

/** peek: return the same rows without setting read_at, so a watcher or a
 * human "check now" can inspect the inbox without stealing mail from the
 * agent's real reader. Default (false) keeps read-on-fetch.
 * afterId: only unread mail inserted after that message (a peek watcher's
 * cursor). An unknown id falls back to all unread rather than hiding mail.
 * limit: return only the oldest N (clamped to 1..100); only those are marked
 * read, so the rest stays unread for the next call. Omitted means no limit. */
export function getMessages(
  orgId: string,
  agentId: string,
  since?: string,
  { peek = false, afterId, limit }: { peek?: boolean; afterId?: string; limit?: number } = {},
): MessageRecord[] {
  // SQLite treats a negative LIMIT as unbounded.
  const cap = limit === undefined ? -1 : Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_MESSAGE_PAGE);
  const rows = since
    ? (db
        .prepare(
          // datetime() normalizes ISO 8601 ("…T…Z") to created_at's "YYYY-MM-DD HH:MM:SS" before comparing.
          `SELECT * FROM messages WHERE org_id = ? AND to_agent_id = ? AND created_at > datetime(?) ORDER BY created_at ASC, rowid ASC LIMIT ?`,
        )
        .all(orgId, agentId, since, cap) as MessageRecord[])
    : (db
        .prepare(
          `SELECT * FROM messages WHERE org_id = ? AND to_agent_id = ? AND read_at IS NULL
             AND rowid > COALESCE((SELECT rowid FROM messages WHERE id = ? AND to_agent_id = ?), 0)
           ORDER BY created_at ASC, rowid ASC LIMIT ?`,
        )
        .all(orgId, agentId, afterId ?? null, agentId, cap) as MessageRecord[]);
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    // A peek still hands the mail to the recipient, so it counts as delivered; only a real read consumes it.
    markDelivered(ids);
    if (!peek) {
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`UPDATE messages SET read_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
    }
  }
  // Masked again here as defense-in-depth (docs/decisions #1789), same reasoning as tasks.ts's readRow(): insertMessage
  // masks on write, but this covers any row written before masking existed (migration 14 also masks these in place)
  // or by a future write path that misses it. Masking masked text changes nothing, so this is a no-op on real rows.
  return rows.map((r) => ({ ...r, body: maskSecrets(r.body) }));
}

/** Find past mail the caller sent or received, read or unread. getMessages answers "what is waiting
 * for me" (unread only, by construction); this answers "where is that message from last Tuesday",
 * which nothing could do before: once a row was read it was unreachable except by thread id.
 *
 * Scoped on BOTH sides of the conversation -- org_id and (to_agent_id = me OR from_agent_id = me) --
 * so search can never widen who sees a row. Bodies are masked at write time (insertMessage) and
 * re-masked here as defense-in-depth, same as getMessages. Newest first, so the most recent match
 * is the one a caller reading a truncated page actually wanted. */
export function searchMessages(
  orgId: string,
  agentId: string,
  { query, from, threadId, limit }: { query?: string; from?: string; threadId?: string; limit?: number } = {},
): MessageRecord[] {
  const cap = limit === undefined ? MAX_MESSAGE_PAGE : Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_MESSAGE_PAGE);
  const clauses = ["org_id = ?", "(to_agent_id = ? OR from_agent_id = ?)"];
  const params: unknown[] = [orgId, agentId, agentId];
  if (typeof query === "string" && query.trim()) {
    // LIKE with ESCAPE so a body containing % or _ is matched literally, not as a wildcard.
    const escaped = query.trim().replace(/[\\%_]/g, "\\$&");
    clauses.push("body LIKE ? ESCAPE '\\'");
    params.push(`%${escaped}%`);
  }
  if (typeof from === "string" && from.trim()) {
    clauses.push("from_agent_name = ?");
    params.push(from.trim());
  }
  if (typeof threadId === "string" && threadId.trim()) {
    clauses.push("thread_id = ?");
    params.push(threadId.trim());
  }
  params.push(cap);
  const rows = db
    .prepare(`SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...params) as MessageRecord[];
  return rows.map((r) => ({ ...r, body: maskSecrets(r.body) }));
}

/** Sets delivered_at once, the first time a message reaches its recipient. */
function markDelivered(ids: string[]): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE messages SET delivered_at = datetime('now') WHERE delivered_at IS NULL AND id IN (${placeholders})`).run(...ids);
}

export interface MessageStatus {
  id: string;
  kind: string;
  from: string;
  to: string;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  /** The message's actual text, already masked at write time (insertMessage) -- safe to return as
   * stored, no re-masking needed. Real defect fixed here: get_message_status used to withhold this
   * entirely, and once a message is consumed (get_messages marks it read), there was NO way to ever
   * read its text again through any API -- confirmed live, a message body was permanently
   * unrecoverable mid-session even though the row (and its text) was never deleted, just no longer
   * exposed. A thread is always exactly two parties by construction (reply() alternates between the
   * same from/to pair), so anyone who is a party to ANY row on this thread_id is a party to every
   * row on it -- returning body here doesn't broaden who can already see this thread's metadata. */
  body: string;
}

/** Delivery and read state of every message on a thread, for its participants only -- including
 * each message's full body, so a consumed (already-read) message's content is always recoverable by
 * either of its two parties, not just its metadata. */
export function getThreadStatus(orgId: string, agentId: string, threadId: string): { ok: true; messages: MessageStatus[] } | { ok: false; error: string } {
  const rows = db
    .prepare(
      `SELECT id, kind, from_agent_id, from_agent_name, to_agent_id, to_agent_name, body, created_at, delivered_at, read_at
       FROM messages WHERE org_id = ? AND thread_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(orgId, threadId) as Array<MessageStatus & { from_agent_id: string; to_agent_id: string; from_agent_name: string; to_agent_name: string }>;
  if (!rows.some((r) => r.from_agent_id === agentId || r.to_agent_id === agentId)) {
    return { ok: false, error: "No thread with that id that you are part of" };
  }
  return {
    ok: true,
    messages: rows.map((r) => ({ id: r.id, kind: r.kind, from: r.from_agent_name, to: r.to_agent_name, body: r.body, created_at: r.created_at, delivered_at: r.delivered_at, read_at: r.read_at })),
  };
}

/** Unread mail for this agent, after the afterId cursor when given -- how a
 * limited reader learns there is more waiting. */
/** Mark specific inbox rows read after a peek-only inspect (watcher ingest path). */
export function consumeMessages(
  orgId: string,
  agentId: string,
  messageIds: string[],
): { ok: true; consumed: number } | { ok: false; error: string } {
  if (!messageIds.length) return { ok: false, error: "messageIds must be a non-empty array" };
  const mark = db.prepare(
    `UPDATE messages SET read_at = datetime('now'), delivered_at = COALESCE(delivered_at, datetime('now'))
     WHERE id = ? AND org_id = ? AND to_agent_id = ? AND read_at IS NULL`,
  );
  let consumed = 0;
  for (const id of messageIds) {
    consumed += mark.run(id, orgId, agentId).changes;
  }
  return { ok: true, consumed };
}

export function countUnreadMessages(orgId: string, agentId: string, afterId?: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE org_id = ? AND to_agent_id = ? AND read_at IS NULL
       AND rowid > COALESCE((SELECT rowid FROM messages WHERE id = ? AND to_agent_id = ?), 0)`,
  ).get(orgId, agentId, afterId ?? null, agentId) as { n: number };
  return row.n;
}

export function reply(
  orgId: string,
  from: { id: string; name: string },
  threadId: string,
  body: string,
  // Internal only, never exposed via REST/MCP -- see sendMessage's skipDuplicateCheck for why an
  // intentional-fan-out caller (e.g. escalation.ts replying the same body into several operators'
  // separate threads) needs to opt out of the single-turn accidental-repeat guard.
  opts: { skipDuplicateCheck?: boolean } = {},
): { ok: true } | MessageFailure {
  if (bodyTooLong(body)) return { ok: false, error: MESSAGE_BODY_TOO_LONG };
  // Only the agent a question was asked of can answer it; the asker's own follow-up must not close it.
  const pendingQuestion = db
    .prepare(
      `SELECT * FROM messages WHERE org_id = ? AND thread_id = ? AND awaiting_reply = 1 AND to_agent_id = ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get(orgId, threadId, from.id) as MessageRecord | undefined;
  // No open question: answer the latest message on this thread that was addressed to the replier.
  const original = pendingQuestion ?? (db
    .prepare(
      `SELECT * FROM messages WHERE org_id = ? AND thread_id = ? AND to_agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(orgId, threadId, from.id) as MessageRecord | undefined);
  // Or a follow-up on a thread the replier started, before the other side has answered.
  const ownSent = original ? undefined : (db
    .prepare(
      `SELECT * FROM messages WHERE org_id = ? AND thread_id = ? AND from_agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(orgId, threadId, from.id) as MessageRecord | undefined);
  if (!original && !ownSent) return { ok: false, error: `No message to or from you found for thread ${threadId}` };
  const to = original
    ? { id: original.from_agent_id, name: original.from_agent_name }
    : { id: ownSent!.to_agent_id, name: ownSent!.to_agent_name };
  // A reply stays inside an existing thread, but only while its two ends can still reach each other: once the link
  // between their projects is removed, the thread takes no more replies (PROJECT_ISOLATION.md §5).
  try {
    assertReachable({ orgId, agentId: from.id }, to.id);
  } catch (err) {
    if (err instanceof NotReachableError) return { ok: false, error: err.message, code: NOT_REACHABLE };
    throw err;
  }
  // Keyed on threadId, not the recipient: this is the "4 near-identical replies across threads"
  // pattern (FLEET_SCALING_AUDIT.md Incident 2) specifically -- the same body landing on a second
  // open thread, whether or not it's the same recipient as the first.
  if (!opts.skipDuplicateCheck) {
    const dupCheck = checkAndRecordDuplicateSend(from.id, body, threadId);
    if (dupCheck.duplicate) return { ok: false, error: duplicateSendError(`thread ${dupCheck.priorTarget}`), code: DUPLICATE_SEND };
  }

  const id = db.transaction(() => {
    const replyId = insertMessage({
      orgId, threadId, fromAgentId: from.id, fromAgentName: from.name,
      toAgentId: to.id, toAgentName: to.name,
      body, kind: "reply", awaitingReply: false,
    });
    if (original) {
      db.prepare(`UPDATE messages SET awaiting_reply = 0 WHERE id = ?`).run(original.id);
      // Answering is reading. Before this a peek reader (the Stop hook, the wake watcher, any watcher key) kept re-listing a
      // thread the agent had already answered (fleet coordination plan, failure 4). Marked read, only among the replier's
      // own unread inbound rows on this thread:
      // - the message answered, always: replying to it is the proof it was seen;
      // - an OLDER row only once delivered_at says the replier was handed it. delivered_at is set by a live push, by any
      //   get_messages (peek included, so wait_for_message too) and by consume_messages; a webhook notice or an awareness
      //   line sets nothing. So an older row nothing ever handed over stays unread, rather than vanishing from
      //   get_messages, peek and awareness unseen (review of #779).
      // Later rows and other recipients' rows are never touched. delivered_at is set with read_at, as consumeMessages
      // does, so no receipt reads "read" but not "delivered".
      db.prepare(
        `UPDATE messages SET read_at = COALESCE(read_at, datetime('now')), delivered_at = COALESCE(delivered_at, datetime('now'))
           WHERE org_id = ? AND thread_id = ? AND to_agent_id = ? AND read_at IS NULL
             AND (id = ? OR (delivered_at IS NOT NULL AND rowid < (SELECT rowid FROM messages WHERE id = ?)))`,
      ).run(orgId, threadId, from.id, original.id, original.id);
    }
    return replyId;
  })();

  // Unblock a synchronous ask_clarification wait on this exact thread, if
  // one is pending, and ALSO push a plain notification in case the asker
  // isn't blocked inside that call anymore (e.g. it already timed out).
  // Only a real answer does that: a follow-up from the asker is not an answer.
  if (pendingQuestion) resolveReplyWaiter(threadId, body);
  if (pushToAgent(to.id, { type: "reply", id, threadId, from: from.name, body })) markDelivered([id]);

  return { ok: true };
}

/** Long-poll: block until either a new message lands for this agent or
 * timeoutSeconds elapses, then return the current unread set either way.
 * This is the real mechanism that makes a 60s-floor scheduler (Claude
 * Code's ScheduleWakeup) feel close to instant -- call
 * wait_for_message(55) instead of get_messages() and the effective
 * latency becomes real arrival time, not "however stale the last tick
 * was." Caps at 280s so it stays safely under typical HTTP/proxy
 * timeouts (Cloudflare's free tier included). */
export async function waitForMessage(
  orgId: string,
  agentId: string,
  timeoutSeconds: number,
  // `beat: false` is a watcher that is not the agent itself (the OpenCode plugin waiting on its chat's mail): its hold
  // must not keep the agent online, or an abandoned chat would read as live forever (Codex-OpenCadre-8160, #585).
  options: { peek?: boolean; afterId?: string; limit?: number; beat?: boolean } = {},
): Promise<MessageRecord[]> {
  // Check for mail that's ALREADY sitting unread before blocking at all --
  // without this, an agent that was offline (or just slow to call back)
  // when a message arrived would ignore it and burn the full timeout
  // waiting for a brand-new notifyInboxWaiters signal that never fires,
  // since notify only fires on a fresh insert, not on pre-existing mail.
  // Confirmed as a real bug via a live 3-agent test, not theoretical.
  // With peek, unread mail stays unread, so repeated peek-waits return
  // immediately until a real (non-peek) read consumes it.
  // A peek watcher passes afterId, so mail it already saw doesn't return instantly forever.
  const already = getMessages(orgId, agentId, undefined, options);
  if (already.length > 0) return already;
  const capped = Math.min(Math.max(timeoutSeconds, 1), 280);
  // A single held call up to 280s can outlast HEARTBEAT_TTL_MS (2 min),
  // so without this an agent that's actively connected the whole time
  // still reads as "offline" partway through the wait. Heartbeat once on
  // entry (some callers, e.g. a bare MCP tool invocation with no separate
  // auth-layer heartbeat, may reach here with no prior beat this request)
  // and again periodically for the duration of the hold.
  const beat = options.beat !== false;
  if (beat) heartbeat(orgId, agentId);
  const keepAlive = beat ? setInterval(() => heartbeat(orgId, agentId), 60_000) : undefined;
  try {
    await waitForInboxActivity(agentId, capped * 1000);
  } finally {
    clearInterval(keepAlive);
  }
  return getMessages(orgId, agentId, undefined, options);
}

export function uploadFile(
  orgId: string,
  uploader: { id: string; name: string },
  filename: string,
  mimeType: string,
  content: Buffer,
): { fileId: string } {
  assertAllowedFilename(filename); // validated against the real name; only the stored copy is masked (docs/decisions #1789)
  const id = newId();
  db.prepare(
    `INSERT INTO files (id, org_id, uploaded_by_agent_id, uploaded_by_agent_name, filename, mime_type, size_bytes, content, project_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, orgId, uploader.id, uploader.name, maskSecrets(filename), mimeType, content.length, content, stampFor(orgId, uploader.id));
  return { fileId: id };
}

/** A file the viewer may read: its uploader, a sender or recipient of a message that carries it, or an operator who can
 * see the uploader's project (always, while project isolation is off). Anyone else gets null (a 404 to the caller),
 * exactly as for an id that doesn't exist, so a leaked `fileId` (it is in the message.sent event payload) reveals
 * nothing (docs/design/PROJECT_ISOLATION.md §5). */
export function getFile(orgId: string, fileId: string, viewer: { agentId: string; role: AgentRole }): FileRecord | null {
  const anyRow = viewer.role === "operator" ? (db.prepare(`SELECT * FROM files WHERE org_id = ? AND id = ?`).get(orgId, fileId) as FileRecord | undefined) : undefined;
  const row = (anyRow && canSee({ orgId, agentId: viewer.agentId }, anyRow.project_key)
    ? anyRow
    : db.prepare(
      `SELECT * FROM files f WHERE f.org_id = ? AND f.id = ? AND (f.uploaded_by_agent_id = ? OR EXISTS (
         SELECT 1 FROM messages m WHERE m.org_id = f.org_id AND m.file_id = f.id AND (m.from_agent_id = ? OR m.to_agent_id = ?)))`,
    ).get(orgId, fileId, viewer.agentId, viewer.agentId, viewer.agentId)) as FileRecord | undefined;
  // Masked again here as defense-in-depth (docs/decisions #1789) -- content is never touched, only the name.
  return row ? { ...row, filename: maskSecrets(row.filename) } : null;
}

/** Convenience: upload + send in one call, the shape an agent actually
 * wants ("share this doc with X") rather than two round-trips. */
export async function shareFile(
  orgId: string,
  from: { id: string; name: string },
  toNameOrKey: string,
  filename: string,
  mimeType: string,
  content: Buffer,
  message: string,
  priority: Priority = "medium",
): Promise<{ ok: true; threadId: string; fileId: string; delivered: "live" | "queued" } | MessageFailure> {
  // Checked before the upload so a rejected message doesn't leave an orphaned file.
  if (bodyTooLong(message)) return { ok: false, error: MESSAGE_BODY_TOO_LONG };
  // So is the recipient: a file for an agent outside the sender's projects is never stored.
  const resolved = resolveTarget(orgId, toNameOrKey, from);
  if (!resolved.ok) return resolved;
  let fileId: string;
  try {
    ({ fileId } = uploadFile(orgId, from, filename, mimeType, content));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = await sendMessage(orgId, from, toNameOrKey, message, priority, fileId);
  if (!result.ok) return result;
  return { ok: true, threadId: result.threadId, fileId, delivered: result.delivered };
}
