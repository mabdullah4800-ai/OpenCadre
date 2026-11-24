import { randomUUID } from "node:crypto";
import type { MemberRole } from "../../src/accounts.js";

// A signed-in PERSON for tests that decide a clearance. Since migration 53 a clearance is decided by a person only
// (docs/superpowers/plans/2026-09-30-person-approvals.md): an agent key, a device credential or a connector token is
// refused. So a test that used to approve with an operator's agent key now does it the way the console does, with a
// session cookie and the workspace header, or in-process with the same person as the decider.
//
// Built through the product's own paths (upsertPerson, createInvite + acceptInvite, createSession), so the person gets
// a real membership and member agent exactly as an invited teammate would.

export interface SignedInPerson {
  personId: string;
  /** The person's display name: what the record, the console and the gate show as who decided. */
  name: string;
  /** The in-process decider for decideApproval: the member agent, carrying the person. */
  decider: { id: string; name: string; person: { id: string; name: string; channel: "console" } };
  /** Headers for a console request in this workspace (cookie, workspace header, JSON). */
  headers: Record<string, string>;
}

let n = 0;

export async function signInPerson(orgId: string, name = "Operator", role: MemberRole = "owner"): Promise<SignedInPerson> {
  const { upsertPerson, createInvite, acceptInvite, createSession, getMembership, displayName, SESSION_COOKIE } = await import("../../src/accounts.js");
  const { db } = await import("../../src/db.js");
  const id = `person-${randomUUID()}`;
  const person = upsertPerson({ id, email: `test-person-${++n}@example.test`, emailVerified: true, name, avatarUrl: null });
  const invite = createInvite(orgId, { id: "test-fixture", name: "Test fixture" }, role, null);
  acceptInvite(invite.token, person);
  const membership = getMembership(orgId, id)!;
  const agentName = (db.prepare(`SELECT name FROM agents WHERE id = ?`).get(membership.agent_id) as { name: string }).name;
  const { token } = createSession(id);
  const shown = displayName(person);
  return {
    personId: id,
    name: shown,
    decider: { id: membership.agent_id, name: agentName, person: { id, name: shown, channel: "console" } },
    headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-opencadre-workspace": orgId, "content-type": "application/json" },
  };
}

const people = new Map<string, Promise<SignedInPerson>>();

/** One "Operator" person per workspace, signed in once and reused. */
export function operatorPerson(orgId: string): Promise<SignedInPerson> {
  if (!people.has(orgId)) people.set(orgId, signInPerson(orgId));
  return people.get(orgId)!;
}

/** Any console request as the workspace's signed-in "Operator" person, e.g. PUT /v1/clearance-policy, which an agent or
 * Operator key may only read (#653). */
export async function asPerson(hubUrl: string, orgId: string, method: string, route: string, body?: unknown): Promise<Response> {
  const { headers } = await operatorPerson(orgId);
  return fetch(`${hubUrl}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** Decides a clearance the way the console does: POST /v1/approvals/:id/decide as a signed-in person. */
export async function decideAsPerson(
  hubUrl: string, orgId: string, approvalId: string, body: { decision: "approve" | "deny"; note?: string; grantMinutes?: number },
): Promise<Response> {
  const { headers } = await operatorPerson(orgId);
  return fetch(`${hubUrl}/v1/approvals/${approvalId}/decide`, { method: "POST", headers, body: JSON.stringify(body) });
}
