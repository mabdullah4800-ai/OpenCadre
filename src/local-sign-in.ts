import { createHash, randomBytes } from "node:crypto";
import type { VerifiedIdentity } from "./supabase-auth.js";

/** LOCAL SIGN-IN: how a person signs in to a hub that has no sign-in provider.
 *
 * WHY IT EXISTS. A clearance is decided by a signed-in PERSON (src/approvals.ts), and a workspace gets its owner when a
 * person creates it (src/accounts.ts createWorkspace). The only way to become a signed-in person was the Supabase flow,
 * so a hub started from the README had a working API and MCP server and a console nobody could enter.
 *
 * HOW. Whoever holds OPENCADRE_ADMIN_TOKEN (the hub's own root credential, the same one that gates creating
 * organizations) asks the hub for a one-time sign-in link for an email address. Opening the link signs that browser in
 * as that person, through the same upsertPerson + createSession path every other sign-in uses.
 *
 * THE LIMITS, each on purpose:
 *   - It is refused outright while a sign-in provider is configured. A hub that verifies people through a provider
 *     never mints a session for an address nobody proved they own.
 *   - A ticket works ONCE and for TEN MINUTES. Only its SHA-256 is kept, in this process's memory; a restart forgets
 *     every outstanding ticket, which fails closed.
 *   - The ticket is 256 random bits, compared by looking its hash up in a Map, so there is nothing to guess and no
 *     comparison whose timing depends on the secret.
 *   - The person's id is derived from the address ("local-" + a hash), so asking twice for one address signs in the same
 *     person, and a local person can never collide with a provider's person id.
 *   - Nothing here is logged: the request log records paths without their query strings (src/http-log.ts).
 *
 * CONFIGURING A PROVIDER LATER. New links stop at once and outstanding ones are refused, but people who already signed
 * in locally keep their sessions and their workspaces: ending them would leave a workspace whose only owner cannot
 * sign in. That window is how a hub moves over: sign in through the provider, have the local owner invite that account
 * as an owner, then sign the local person out. tests/local-sign-in.test.ts pins this.
 *
 * A LINK IS SPENT BY THE FIRST GET. A chat app or scanner that previews the URL uses it up; nothing is exposed, and the
 * admin mints another. */

export const LOCAL_TICKET_TTL_MS = 10 * 60_000;
/** A hub admin minting links in a loop must not grow this map without bound. */
export const MAX_OUTSTANDING_TICKETS = 100;

interface Outstanding {
  identity: VerifiedIdentity;
  expiresAtMs: number;
}

const outstanding = new Map<string, Outstanding>();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The address as stored and hashed: trimmed and lowercased. Null when it is not an email address. */
export function normalizeLocalEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return EMAIL.test(email) && email.length <= 254 ? email : null;
}

/** A stable person id for a local address. Never a provider's id shape (those are UUIDs). */
export const localPersonId = (email: string) => `local-${sha256(email).slice(0, 32)}`;

function sweep(nowMs: number): void {
  for (const [hash, t] of outstanding) if (t.expiresAtMs <= nowMs) outstanding.delete(hash);
}

export type IssueResult =
  | { ok: true; ticket: string; expiresAt: string }
  | { ok: false; status: 400 | 429; error: string };

/** Mints a one-time ticket for `email`. The raw ticket is returned once and never stored. */
export function issueLocalTicket(input: { email: unknown; name?: unknown }, nowMs = Date.now()): IssueResult {
  const email = normalizeLocalEmail(input.email);
  if (!email) return { ok: false, status: 400, error: "Enter a valid email address." };
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : null;
  sweep(nowMs);
  if (outstanding.size >= MAX_OUTSTANDING_TICKETS) {
    return { ok: false, status: 429, error: "Too many unused sign-in links. Use one, or wait ten minutes." };
  }
  const ticket = randomBytes(32).toString("base64url");
  const expiresAtMs = nowMs + LOCAL_TICKET_TTL_MS;
  outstanding.set(sha256(ticket), {
    identity: { id: localPersonId(email), email, emailVerified: true, name, avatarUrl: null },
    expiresAtMs,
  });
  return { ok: true, ticket, expiresAt: new Date(expiresAtMs).toISOString() };
}

/** Spends a ticket: the identity it was minted for, or null when it is unknown, already used or expired. The ticket
 * is removed BEFORE its expiry is read, so no path uses one twice. */
export function consumeLocalTicket(ticket: unknown, nowMs = Date.now()): VerifiedIdentity | null {
  if (typeof ticket !== "string" || ticket.length < 20 || ticket.length > 128) return null;
  const hash = sha256(ticket);
  const found = outstanding.get(hash);
  if (!found) return null;
  outstanding.delete(hash);
  return found.expiresAtMs > nowMs ? found.identity : null;
}

/** For tests. */
export function resetLocalTickets(): void {
  outstanding.clear();
}
export const outstandingLocalTickets = () => outstanding.size;
