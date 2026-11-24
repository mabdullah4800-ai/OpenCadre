import { db, newId } from "./db.js";
import { resolveAddressable, sendMessage } from "./service.js";
import type { Priority } from "./service.js";
import { emitEvent } from "./events.js";
import { notifyApprovalByPush } from "./push.js";
import { isDraining } from "./draining.js";
import { maskAndCap, maskSecrets } from "./secrets.js";
import { stampFor } from "./project-stamps.js";
import { canSee, NotReachableError, projectDisplayName, projectFilterSql } from "./scope.js";

/** Universal approval gate (issue #10). Any agent, on any vendor, asks before a
 * risky action, and a PERSON decides: a signed-in member of the workspace, in the
 * console or on their phone (docs/superpowers/plans/2026-09-30-person-approvals.md).
 * An agent key, a device credential or an MCP connector token is never a person's
 * decision, whoever holds it. The gate fails closed: no decision before expires_at
 * means 'expired', which callers must treat as denied -- a slow human never
 * turns into a silent yes. The requester can never approve its own request. */

/** 'withdrawn': the agent that asked took the request back before anyone decided it (withdrawApproval). Like denied and
 * expired it is final, and it means do not perform the action. */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "noted" | "withdrawn";
export type Risk = "low" | "medium" | "high";
/** Who may decide a request (migration 53). 'person' is every clearance's kind in this build. 'supervisor' (an agent a
 * person has designated) exists in the schema only: the designation is not built (plan §4.1), nothing creates such a
 * row, and the database refuses one. */
export type DeciderKind = "person" | "supervisor";

/** The signed-in person behind a decision, and the channel it came through. Only the console session path (src/rest.ts
 * requireMemberSession) produces one. */
export interface PersonDecider {
  id: string;
  /** Display name at the time of the decision: the record keeps it even if the person is renamed or leaves. */
  name: string;
  channel: "console";
}

/** What an agent, a device or a connector token is told when it tries to decide a person-required request. */
export const PERSON_REQUIRED_REFUSAL = "A person has to decide this one: open it in OpenCadre on your phone or computer.";

export interface ApprovalRecord {
  id: string;
  org_id: string;
  requested_by_agent_id: string;
  requested_by_agent_name: string;
  action: string;
  details: string | null;
  risk: Risk;
  category: string | null;
  status: ApprovalStatus;
  /** For a person's decision, their member agent (the console acts through it); for an auto-approval, the grant's. */
  decided_by_agent_id: string | null;
  decided_by_agent_name: string | null;
  decision_note: string | null;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
  /** The requester's home project, stamped at write time (write-once). */
  project_key: string | null;
  /** Who may decide it (write-once). */
  decider_kind: DeciderKind;
  /** The person who decided it, or whose grant auto-approved it; null otherwise. Write-once, as are the next two. */
  decided_by_person_id: string | null;
  decided_by_person_name: string | null;
  /** How the person's decision arrived: "console", or "grant" for an auto-approval. */
  decided_via: string | null;
}

type Agent = { id: string; name: string };
/** A decider: the calling agent, and the signed-in person behind it when there is one. */
export type Decider = Agent & { person?: PersonDecider | null };

export const DEFAULT_EXPIRES_SECONDS = 15 * 60;
const MAX_EXPIRES_SECONDS = 24 * 60 * 60;
const MAX_WAIT_SECONDS = 280; // stays under typical proxy/tunnel timeouts, like wait_for_message

const waiters = new Map<string, Array<() => void>>();

function wake(approvalId: string): void {
  const list = waiters.get(approvalId);
  waiters.delete(approvalId);
  for (const w of list ?? []) w();
}

/** Releases every pending approval wait, e.g. on graceful shutdown: each returns the request's current state. */
export function resolveAllApprovalWaiters(): void {
  for (const id of [...waiters.keys()]) wake(id);
}

/** Project isolation (PROJECT_ISOLATION.md §5): a request outside the viewer's visible projects doesn't exist for it.
 * No viewer (the hub itself): every request in the org. */
function visibleTo(orgId: string, viewer: string | undefined, row: { project_key: string | null } | undefined): boolean {
  return Boolean(row) && (viewer === undefined || canSee({ orgId, agentId: viewer }, row!.project_key));
}

/** One request in this org, with a lapsed pending one moved to expired first (null if not in this org, or not visible to `viewer`). */
export function getApprovalById(orgId: string, id: string, viewer?: string): ApprovalRecord | null {
  sweepExpiredApprovals(orgId, id);
  const row = getApproval(orgId, id);
  return visibleTo(orgId, viewer, row) ? row! : null;
}

/** A row as it leaves this module. Actions, details and decision notes are masked when stored (requestApproval,
 * decideApproval; migration 12 for old actions and details); masking again on the way out also covers any row that
 * reached the table another way. */
function forOutput(row: ApprovalRecord): ApprovalRecord {
  const mask = (text: string | null) => (text === null ? null : maskSecrets(text));
  return { ...row, action: maskSecrets(row.action), details: mask(row.details), decision_note: mask(row.decision_note) };
}

function getApproval(orgId: string, id: string): ApprovalRecord | undefined {
  const row = db.prepare(`SELECT * FROM approvals WHERE id = ? AND org_id = ?`).get(id, orgId) as ApprovalRecord | undefined;
  return row && forOutput(row);
}

/** Lazily moves overdue pending requests to 'expired' and records it on the timeline. */
export function sweepExpiredApprovals(orgId: string, id?: string): void {
  const now = new Date().toISOString();
  const expired = db.transaction(() => {
    const rows = (id
      ? db.prepare(`UPDATE approvals SET status = 'expired', decided_at = datetime('now') WHERE org_id = ? AND id = ? AND status = 'pending' AND expires_at <= ? RETURNING id, requested_by_agent_id, action`).all(orgId, id, now)
      : db.prepare(`UPDATE approvals SET status = 'expired', decided_at = datetime('now') WHERE org_id = ? AND status = 'pending' AND expires_at <= ? RETURNING id, requested_by_agent_id, action`).all(orgId, now)
    ) as Array<{ id: string; requested_by_agent_id: string; action: string }>;
    for (const row of rows) {
      emitEvent({
        orgId, type: "approval.expired", subjectType: "approval", subjectId: row.id,
        targetAgentId: row.requested_by_agent_id, payload: { action: maskAndCap(row.action, SUMMARY_CHARS, "") },
      });
    }
    return rows;
  })();
  for (const row of expired) wake(row.id);
}

export interface ApprovalGrant {
  id: string;
  org_id: string;
  agent_id: string;
  agent_name: string;
  category: string;
  granted_by_agent_id: string;
  granted_by_agent_name: string;
  expires_at: string;
  created_at: string;
  /** The project of the request it was granted on (write-once). The grant covers only that project. */
  project_key: string | null;
  /** The person who created the grant (write-once); null for a grant no person made, which never covers a person row. */
  granted_by_person_id: string | null;
  granted_by_person_name: string | null;
}

const MAX_GRANT_MINUTES = 8 * 60;

/** The grant that auto-approves a new request, if any: the same requester, category and project (`IS`, so a
 * workspace-level request matches only a workspace-level grant), unexpired, and -- for a person row, which is every row
 * today -- created by a person. */
function activeGrant(orgId: string, agentId: string, category: string, projectKey: string | null, kind: DeciderKind): ApprovalGrant | undefined {
  return db.prepare(
    `SELECT * FROM approval_grants
      WHERE org_id = ? AND agent_id = ? AND category = ? AND project_key IS ? AND expires_at > ?
        AND (? = 'supervisor' OR granted_by_person_id IS NOT NULL)
        AND (granted_by_person_id IS NULL OR EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.org_id = approval_grants.org_id AND m.person_id = approval_grants.granted_by_person_id
        ))
      ORDER BY expires_at DESC LIMIT 1`,
  ).get(orgId, agentId, category, projectKey, new Date().toISOString(), kind) as ApprovalGrant | undefined;
}

/** Whether `agentId` is a supervisor a person designated for this request. Designation is not built (plan §4.1), so no
 * supervisor row can exist and this answers no: until it lands, an agent decides nothing. */
function isDesignatedSupervisor(_orgId: string, _agentId: string, _request: ApprovalRecord): boolean {
  return false;
}

/** The person really is a member of this workspace, acting through their own member agent. The REST path checked the
 * session already; this holds the same line for any in-process caller. */
function personActsHere(orgId: string, decider: Agent, person: PersonDecider): boolean {
  const member = db.prepare(`SELECT agent_id FROM workspace_members WHERE org_id = ? AND person_id = ?`).get(orgId, person.id) as { agent_id: string } | undefined;
  return member?.agent_id === decider.id;
}

const NOTICE_DETAILS_CHARS = 4000;
/** Stored lengths. Nothing capped these before (TEXT columns, a 10 MB JSON body): the gate sends at most 500 characters
 * of command, and details stay within one message body (MAX_MESSAGE_BODY_CHARS). Longer input is cut, not refused. */
export const MAX_APPROVAL_ACTION_CHARS = 2000;
export const MAX_APPROVAL_DETAILS_CHARS = 16000;
/** Event payload summaries (action, decision note). Always cut with maskAndCap: mask first, then cut. */
const SUMMARY_CHARS = 200;

export async function requestApproval(
  orgId: string,
  requester: Agent,
  input: {
    action: string;
    details?: string | null;
    risk?: Risk;
    approver?: string | null;
    expiresInSeconds?: number;
    waitSeconds?: number;
    /** Stable kind of action (e.g. "force-push"); time-boxed grants match on it. */
    category?: string | null;
    /** Record for audit and notify the approver, but don't ask for a decision. */
    notifyOnly?: boolean;
  },
): Promise<ApprovalRecord> {
  // Agents send whole commands, keys and all: only the masked text is stored, emitted, pushed or messaged.
  const action = maskAndCap(input.action?.trim() ?? "", MAX_APPROVAL_ACTION_CHARS);
  if (!action) throw new Error("action is required");
  const inputDetails = input.details?.trim() ? maskAndCap(input.details.trim(), MAX_APPROVAL_DETAILS_CHARS) : null;
  const expiresIn = input.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS;
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_EXPIRES_SECONDS) {
    throw new Error(`expiresInSeconds must be between 0 and ${MAX_EXPIRES_SECONDS}`);
  }
  // The approver must be reachable from the requester's project, and able to see the request it is asked to decide.
  const approver = input.approver ? resolveAddressable(orgId, input.approver, requester) : null;
  if (input.approver && !approver) throw new Error(`No agent found matching approver "${input.approver}"`);
  if (approver && !input.notifyOnly && !canSee({ orgId, agentId: approver.id }, stampFor(orgId, requester.id))) {
    throw new NotReachableError(`${approver.name} can't decide clearances in this project. Name an approver in your project, or leave it to the operators.`);
  }

  const id = newId();
  const risk: Risk = input.risk ?? "medium";
  const category = input.category?.trim() || null;
  const projectKey = stampFor(orgId, requester.id);
  // Server-side and constant: nothing the requester sends (a flag, a category, an origin label) chooses the kind. A
  // 'supervisor' kind needs a person's designation, which does not exist yet (plan §4.1).
  const deciderKind: DeciderKind = "person";
  const grant = category && !input.notifyOnly ? activeGrant(orgId, requester.id, category, projectKey, deciderKind) : undefined;
  const status: ApprovalStatus = input.notifyOnly ? "noted" : grant ? "approved" : "pending";
  const grantPerson = grant?.granted_by_person_id ? { id: grant.granted_by_person_id, name: grant.granted_by_person_name } : null;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO approvals (id, org_id, requested_by_agent_id, requested_by_agent_name, action, details, risk, category, status,
                              decided_by_agent_id, decided_by_agent_name, decision_note, decided_at, expires_at, project_key,
                              decider_kind, decided_by_person_id, decided_by_person_name, decided_via)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, requester.id, requester.name, action, inputDetails, risk, category, status,
      grant?.granted_by_agent_id ?? null, grant?.granted_by_agent_name ?? null,
      grant ? `auto-approved by ${grantPerson?.name ?? grant.granted_by_agent_name}'s "${category}" grant until ${grant.expires_at}` : null,
      status === "pending" ? null : new Date().toISOString(),
      new Date(Date.now() + expiresIn * 1000).toISOString(),
      projectKey, deciderKind, grantPerson?.id ?? null, grantPerson?.name ?? null, grantPerson ? "grant" : null);

    const summary = { action: maskAndCap(action, SUMMARY_CHARS, ""), risk, ...(category ? { category } : {}) };
    if (status === "noted") {
      emitEvent({ orgId, type: "approval.noted", actor: requester, subjectType: "approval", subjectId: id, targetAgentId: approver?.id, payload: summary });
      return;
    }
    emitEvent({ orgId, type: "approval.requested", actor: requester, subjectType: "approval", subjectId: id, targetAgentId: grant ? null : approver?.id, payload: summary });
    if (grant) {
      emitEvent({
        orgId, type: "approval.decided", actor: { id: grant.granted_by_agent_id, name: grant.granted_by_agent_name },
        subjectType: "approval", subjectId: id, targetAgentId: requester.id,
        payload: { decision: "approve", viaGrant: true, grantId: grant.id, ...(grantPerson ? { byPerson: true } : {}) },
      });
    }
  })();

  // Attention-based routing (Stage 2 retro finding: "surface only high-uncertainty/high-risk
  // decisions" instead of paging the approver identically for everything). Design retro P2 finding
  // fixed here too: broadcast_message-style uniform "medium risk" urgency for every approval buried
  // the genuinely urgent ones in routine noise. The approval itself is unchanged either way -- still
  // pending, still fail-closed, still requires an explicit decision -- only how loudly it's surfaced
  // scales with risk. A low-risk request lands quietly in the inbox for whenever the approver next
  // checks; only medium/high risk interrupts with a push, and priority itself tracks risk instead of
  // defaulting every pending request to "high" regardless of how routine it is.
  const attentionPriority: Priority = risk === "high" ? "high" : risk === "medium" ? "medium" : "low";

  // Phones hear about it in parallel with the approver's inbox; a push problem never fails the request.
  // Low risk is deliberately excluded from the push channel -- it still shows up in the inbox message
  // below and on the timeline, just without demanding the approver's immediate attention.
  if (status === "pending" && risk !== "low") {
    void notifyApprovalByPush({
      id, org_id: orgId, action, risk, requested_by_agent_name: requester.name, project_name: projectDisplayName(orgId, stampFor(orgId, requester.id)),
    }, approver?.id ?? null);
  }

  if (approver && status !== "approved") {
    // The notice must fit the message body cap, or sendMessage would drop it silently.
    const details = !inputDetails ? ""
      : `\nDetails: ${maskAndCap(inputDetails, NOTICE_DETAILS_CHARS, `… (truncated; full details on approval ${id})`)}`;
    await sendMessage(orgId, requester, approver.id, input.notifyOnly
      ? `FYI (no approval needed) ${requester.name} is running: ${action}${details}`
      : `APPROVAL NEEDED (${risk} risk) from ${requester.name}: ${action}` +
        `${details}\nApproval id: ${id} -- a person decides this one, in OpenCadre on their phone or computer; agents can't decide it.`,
      input.notifyOnly ? "low" : attentionPriority);
  }

  if (status === "pending" && input.waitSeconds && input.waitSeconds > 0) return (await waitForApproval(orgId, id, input.waitSeconds))!;
  return getApproval(orgId, id)!;
}

/** Blocks until the request is decided, expires, or waitSeconds (max 280)
 * passes -- whichever is first -- then returns its current state. Returns
 * null if no such request exists in this org. */
export async function waitForApproval(orgId: string, id: string, waitSeconds: number, viewer?: string): Promise<ApprovalRecord | null> {
  sweepExpiredApprovals(orgId, id);
  const current = getApproval(orgId, id);
  if (!visibleTo(orgId, viewer, current)) return null;
  if (current!.status !== "pending" || isDraining()) return current!;

  const waitMs = Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000;
  const untilExpiryMs = Math.max(new Date(current!.expires_at).getTime() - Date.now(), 0);
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      const list = waiters.get(id);
      if (list) waiters.set(id, list.filter((w) => w !== done));
      resolve();
    };
    const timer = setTimeout(done, Math.min(waitMs, untilExpiryMs + 5));
    waiters.set(id, [...(waiters.get(id) ?? []), done]);
  });

  sweepExpiredApprovals(orgId, id);
  return getApproval(orgId, id)!;
}

/** Decides a pending request. A 'person' row (every row today) takes a signed-in person: `decider.person`, which only
 * the console session path sets (src/rest.ts). An agent key, a device credential and a connector token arrive with none,
 * and get PERSON_REQUIRED_REFUSAL with `code: "person_required"` (403 over REST). A 'supervisor' row would also take its
 * designated supervisor agent; none can exist yet. */
export function decideApproval(
  orgId: string,
  decider: Decider,
  id: string,
  decision: "approve" | "deny",
  note?: string | null,
  options: { grantMinutes?: number } = {},
): { ok: true; approval: ApprovalRecord; grant?: ApprovalGrant } | { ok: false; error: string; code?: "person_required" } {
  sweepExpiredApprovals(orgId, id);
  const current = getApproval(orgId, id);
  // People keep workspace-wide decide rights (they are workspace scope); an agent decides only what it can see.
  if (!current || !canSee({ orgId, agentId: decider.id }, current.project_key)) return { ok: false, error: `No approval request found matching "${id}"` };
  const person = decider.person ?? null;
  if (person && !personActsHere(orgId, decider, person)) return { ok: false, error: "You're not a member of this workspace.", code: "person_required" };
  const allowed = person !== null || (current.decider_kind === "supervisor" && isDesignatedSupervisor(orgId, decider.id, current));
  if (!allowed) return { ok: false, error: PERSON_REQUIRED_REFUSAL, code: "person_required" };
  if (current.requested_by_agent_id === decider.id) {
    return { ok: false, error: "The requesting agent can't decide its own approval request" };
  }
  // A note is agent or operator text shown on the Clearances page: stored masked, like the action.
  const decisionNote = note?.trim() ? maskAndCap(note.trim(), MAX_APPROVAL_DETAILS_CHARS) : null;
  const minutes = Math.min(options.grantMinutes ?? 0, MAX_GRANT_MINUTES);
  const result = db.transaction(() => {
    // Only a pending row changes, so a stale or replayed decide on a decided row changes nothing.
    const changed = db.prepare(
      `UPDATE approvals
          SET status = ?, decided_by_agent_id = ?, decided_by_agent_name = ?, decision_note = ?, decided_at = datetime('now'),
              decided_by_person_id = ?, decided_by_person_name = ?, decided_via = ?
        WHERE id = ? AND org_id = ? AND status = 'pending'`,
    ).run(decision === "approve" ? "approved" : "denied", decider.id, decider.name, decisionNote,
      person?.id ?? null, person?.name ?? null, person?.channel ?? null, id, orgId).changes;
    if (changed === 0) return null;
    const actor = { id: decider.id, name: decider.name };
    emitEvent({
      // byPerson, and nothing personal: the actor is the member agent, as before, and the person's id stays on the row.
      orgId, type: "approval.decided", actor, subjectType: "approval", subjectId: id, targetAgentId: current.requested_by_agent_id,
      payload: { decision, ...(person ? { byPerson: true } : {}), ...(decisionNote ? { note: maskAndCap(decisionNote, SUMMARY_CHARS, "") } : {}) },
    });

    // "Approve for N minutes": later requests from the same agent in the same category and project are auto-approved
    // until the grant expires, cutting prompt fatigue. The grant records the person; one without a person (a supervisor's)
    // never covers a person row (activeGrant).
    if (decision !== "approve" || !current.category || minutes <= 0) return {};
    const grantId = newId();
    db.prepare(
      `INSERT INTO approval_grants (id, org_id, agent_id, agent_name, category, granted_by_agent_id, granted_by_agent_name, expires_at, project_key,
                                    granted_by_person_id, granted_by_person_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(grantId, orgId, current.requested_by_agent_id, current.requested_by_agent_name, current.category,
      decider.id, decider.name, new Date(Date.now() + minutes * 60_000).toISOString(), current.project_key,
      person?.id ?? null, person?.name ?? null);
    const grant = db.prepare(`SELECT * FROM approval_grants WHERE id = ?`).get(grantId) as ApprovalGrant;
    emitEvent({
      orgId, type: "approval.grant_created", actor, subjectType: "grant", subjectId: grantId,
      targetAgentId: grant.agent_id, payload: { approvalId: id, category: grant.category, expiresAt: grant.expires_at },
    });
    return { grant };
  })();
  if (!result) return { ok: false, error: `Approval request "${id}" is already ${getApproval(orgId, id)!.status}` };
  const { grant } = result;
  wake(id);
  return { ok: true, approval: getApproval(orgId, id)!, grant };
}

/** What anyone but the requester is told when it tries to withdraw a request: a person decides it instead. */
export const WITHDRAW_NOT_REQUESTER = "Only the agent that asked can withdraw this request. A person can deny it instead.";

/** The request header a client sends to be told "withdrawn" as it is: X-OpenCadre-Approval-Statuses: withdrawn. */
export const APPROVAL_STATUSES_HEADER = "x-opencadre-approval-statuses";
/** The reason a client that doesn't know "withdrawn" is given, in decision_note, when it is told "denied" instead. */
export const WITHDRAWN_DENY_NOTE = "withdrawn by the agent that asked";

/** Whether a client said it understands "withdrawn" (the header above, a comma-separated list of statuses). */
export function knowsWithdrawn(headerValue: string | undefined): boolean {
  return (headerValue ?? "").split(",").some((s) => s.trim().toLowerCase() === "withdrawn");
}

/** A withdrawn request as a client that doesn't know the status must see it: DENIED (security review 2 of #780).
 * A gate hook from before #673 leaves its wait on any status but pending and, on one it doesn't recognise, falls
 * through to its onTimeout "allow": told "withdrawn", it would let an agent withdraw its own request to skip the
 * person's veto. Told "denied", every version denies. The note carries the real reason, and the requester stands as
 * "decided by" so an old hook's "denied by <name>" names who took it back. No person is recorded. Any other row is
 * returned unchanged. */
export function forClientWithoutWithdrawn(a: ApprovalRecord): ApprovalRecord {
  if (a.status !== "withdrawn") return a;
  return {
    ...a,
    status: "denied",
    decided_by_agent_id: a.requested_by_agent_id,
    decided_by_agent_name: a.requested_by_agent_name,
    decision_note: a.decision_note ? `${WITHDRAWN_DENY_NOTE}: ${a.decision_note}` : WITHDRAWN_DENY_NOTE,
  };
}

/** The requester takes back its own pending request (fleet coordination plan, failure 5): it is marked 'withdrawn', a
 * waiter wakes with that status, and the approver it named hears of it. Nobody decided it, so no decider is recorded.
 *
 * The single UPDATE is the whole check: it changes the row only while it is pending AND was asked for by this caller, so
 * a concurrent decision, an expiry or a second withdraw can never be overwritten. When it changes nothing, the row is
 * read again only to say why. */
export function withdrawApproval(
  orgId: string,
  requester: Agent,
  id: string,
  note?: string | null,
): { ok: true; approval: ApprovalRecord } | { ok: false; error: string; code: "not_found" | "not_requester" | "not_pending" } {
  sweepExpiredApprovals(orgId, id);
  const current = getApproval(orgId, id);
  // Outside the caller's projects the request doesn't exist for it, as for decideApproval.
  if (!current || !canSee({ orgId, agentId: requester.id }, current.project_key)) {
    return { ok: false, error: `No approval request found matching "${id}"`, code: "not_found" };
  }
  const withdrawNote = note?.trim() ? maskAndCap(note.trim(), MAX_APPROVAL_DETAILS_CHARS) : null;
  const changed = db.transaction(() => {
    const n = db.prepare(
      `UPDATE approvals SET status = 'withdrawn', decision_note = ?, decided_at = datetime('now')
        WHERE id = ? AND org_id = ? AND status = 'pending' AND requested_by_agent_id = ?`,
    ).run(withdrawNote, id, orgId, requester.id).changes;
    if (n === 0) return false;
    // The approver the request named (approval.requested's target), so its digest drops the request; null when it went
    // to the workspace's people, who see it leave the console's pending list.
    const requested = db.prepare(
      `SELECT target_agent_id FROM events WHERE org_id = ? AND type = 'approval.requested' AND subject_id = ? ORDER BY seq LIMIT 1`,
    ).get(orgId, id) as { target_agent_id: string | null } | undefined;
    emitEvent({
      orgId, type: "approval.withdrawn", actor: requester, subjectType: "approval", subjectId: id,
      targetAgentId: requested?.target_agent_id ?? null,
      payload: { action: maskAndCap(current.action, SUMMARY_CHARS, ""), ...(withdrawNote ? { note: maskAndCap(withdrawNote, SUMMARY_CHARS, "") } : {}) },
    });
    return true;
  })();
  if (!changed) {
    const now = getApproval(orgId, id)!;
    if (now.requested_by_agent_id !== requester.id) return { ok: false, error: WITHDRAW_NOT_REQUESTER, code: "not_requester" };
    return { ok: false, error: `Approval request "${id}" is already ${now.status}`, code: "not_pending" };
  }
  wake(id);
  return { ok: true, approval: getApproval(orgId, id)! };
}

/** viewer: the reading agent, whose visible projects filter the list (src/scope.ts). */
export function listApprovalGrants(orgId: string, viewer?: string): ApprovalGrant[] {
  const scope = viewer ? projectFilterSql({ orgId, agentId: viewer }, "project_key", { mode: "visible" }) : { sql: "1 = 1", params: [] };
  return db.prepare(`SELECT * FROM approval_grants WHERE org_id = ? AND expires_at > ? AND ${scope.sql} ORDER BY expires_at DESC`)
    .all(orgId, new Date().toISOString(), ...scope.params) as ApprovalGrant[];
}

export function revokeApprovalGrant(orgId: string, grantId: string, actor: Agent | null = null): boolean {
  return db.transaction(() => {
    // An agent revokes only a grant it can see; outside its projects the grant doesn't exist for it.
    const found = db.prepare(`SELECT project_key FROM approval_grants WHERE id = ? AND org_id = ?`).get(grantId, orgId) as { project_key: string | null } | undefined;
    if (!found || (actor && !canSee({ orgId, agentId: actor.id }, found.project_key))) return false;
    const grant = db.prepare(`DELETE FROM approval_grants WHERE id = ? AND org_id = ? RETURNING *`).get(grantId, orgId) as ApprovalGrant | undefined;
    if (!grant) return false;
    emitEvent({
      orgId, type: "approval.grant_revoked", actor, subjectType: "grant", subjectId: grant.id,
      // The grant row is already deleted, so its stamp comes from the returned row rather than a lookup.
      targetAgentId: grant.agent_id, payload: { category: grant.category }, projectKey: grant.project_key,
    });
    return true;
  })();
}

/** viewer: the reading agent, whose visible projects filter the list (src/scope.ts). Without one, every request is listed.
 * hideNoted leaves out notify-only records (status "noted": what requestApproval writes for notifyOnly, one per command
 * the approval gate reports), so the requests someone acts on are not buried under them (board task cf34b4c2). It only
 * applies without a status: asking for status "noted" lists them. A read filter only; every record stays stored. */
export function listApprovals(orgId: string, filter: { status?: ApprovalStatus; viewer?: string; hideNoted?: boolean } = {}): ApprovalRecord[] {
  sweepExpiredApprovals(orgId);
  const scope = approvalScope(orgId, filter.viewer);
  const where = filter.status ? "status = ?" : filter.hideNoted ? "status != 'noted'" : "1 = 1";
  const params = filter.status ? [filter.status] : [];
  return (db.prepare(`SELECT * FROM approvals WHERE org_id = ? AND ${where} AND ${scope.sql} ORDER BY created_at DESC, rowid DESC`)
    .all(orgId, ...params, ...scope.params) as ApprovalRecord[]).map(forOutput);
}

/** How many notify-only ("noted") records the viewer could see: what a listApprovals with hideNoted left out. */
export function countNotedApprovals(orgId: string, viewer?: string): number {
  const scope = approvalScope(orgId, viewer);
  return (db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND status = 'noted' AND ${scope.sql}`)
    .get(orgId, ...scope.params) as { n: number }).n;
}

function approvalScope(orgId: string, viewer?: string): { sql: string; params: unknown[] } {
  return viewer ? projectFilterSql({ orgId, agentId: viewer }, "project_key", { mode: "visible" }) : { sql: "1 = 1", params: [] };
}
