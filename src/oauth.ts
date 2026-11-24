import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { db } from "./db.js";
import { hashKey, type AuthedAgent, type AgentRole, type KeyClass } from "./auth.js";
import { endHeldRequests } from "./revocation.js";
import { disconnectAgent } from "./live.js";
import { ipv6Groups } from "./webhook-guard.js";
import { emitEvent } from "./events.js";
import { can, type Role } from "./permissions.js";

/**
 * The MCP connector, resource side (docs/design/MCP-CONNECTOR.md §3, PR1). The hub is both the OAuth 2.1 authorization
 * server and the protected resource `<hub>/mcp`, so the issuer and the audience are ours and no token ever leaves the
 * hub (MCP authorization spec 2026-07-28: no token passthrough; a token must be audience-bound to this server).
 *
 * DORMANT until OPENCADRE_OAUTH=on. With it off, nothing here is reachable: /mcp accepts exactly what it did (agent
 * keys and device credentials), no metadata is served and no 401 carries a WWW-Authenticate challenge. The
 * authorization side (consent, code exchange, registration) is PR2; until it lands, only tests mint tokens.
 */

export const oauthEnabled = (): boolean => process.env.OPENCADRE_OAUTH === "on";

/** The issuer, and the origin of the resource. The same value `connect` commands are built from (rest.ts publicHubUrl). */
export const oauthIssuer = (): string => (process.env.OPENCADRE_PUBLIC_HUB_URL || "https://hub.opencadre.example").replace(/\/+$/, "");

/** The one resource this hub protects. Claude requires the protected-resource metadata's `resource` to equal the URL the
 * person typed, path included, so it is the /mcp URL itself, with no trailing slash (RFC 8707 canonical form). */
export const mcpResource = (): string => `${oauthIssuer()}/mcp`;

/** Where the consent page lives: the CONSOLE's origin, not the hub's. A person's session cookie is host-only and is set
 * on the console's host by sign-in (src/rest.ts /v1/auth/callback), so only a page on that host can see who is
 * approving. In production that is https://app.opencadre.example while the issuer stays https://hub.opencadre.example; RFC 8414
 * lets an endpoint live on another host than the issuer. Unset outside production, it is the issuer's own origin. */
export const oauthConsentOrigin = (): string =>
  (process.env.OPENCADRE_PUBLIC_APP_URL || (process.env.NODE_ENV === "production" ? "https://app.opencadre.example" : oauthIssuer())).replace(/\/+$/, "");

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/mcp";
export const OAUTH_SCOPE = "fleet";

/** RFC 9728 protected resource metadata. Claude uses only the first `authorization_servers` entry. */
export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [oauthIssuer()],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "OpenCadre",
  };
}

/** The challenge a client reads on a 401 to find the metadata (MCP spec: `resource_metadata` in WWW-Authenticate). */
export const wwwAuthenticate = (): string =>
  `Bearer resource_metadata="${oauthIssuer()}${PROTECTED_RESOURCE_PATH}", scope="${OAUTH_SCOPE}"`;

// --- Authorization server (PR2) -----------------------------------------------------------------------------------------
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** RFC 8414 metadata, exactly the plan's fields (plan §3). Claude uses CIMD only when BOTH
 * `client_id_metadata_document_supported` is true and "none" is an endpoint auth method, else DCR (design §2); ChatGPT's
 * stable redirect needs `authorization_response_iss_parameter_supported` (RFC 9207). S256 is the only PKCE method, so
 * `plain` is never advertised (design §4). */
export function authorizationServerMetadata() {
  const issuer = oauthIssuer();
  return {
    issuer,
    authorization_endpoint: `${oauthConsentOrigin()}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    // Revocation takes no client authentication either (RFC 7009 with public clients); without this field RFC 8414
    // implies client_secret_basic.
    revocation_endpoint_auth_methods_supported: ["none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    scopes_supported: [OAUTH_SCOPE],
  };
}

// Redirect URIs (design §3/§4, plan §7.5). A loopback URI is http to one of exactly these three hosts, read from the
// raw string: `http://localhost.evil.example` or `http://localhost:1@evil.example` must not qualify, so the host must be
// followed by an optional port and then a path, a query or the end.
const LOOPBACK_REDIRECT = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(?=[/?]|$)/;

/** Only https and loopback http are redirect targets (design §3). The string a person approves must be the place the
 * browser goes, so the URI must already be in the URL parser's canonical form (a bare origin may lack only the trailing
 * slash the parser adds). Anything the parser would rewrite (`https://evil.com\@claude.ai`, an empty `@` userinfo,
 * `%65vil.com`, an upper-case host, a default port, dot segments) is refused, not normalised (Sonnet security review,
 * 2026-09-29). Refused before parsing: anything outside printable ASCII (whitespace, controls, zero-width and bidi
 * characters, look-alike letters), a backslash, and a fragment (RFC 6749 §3.1.2). Refused after: credentials
 * (`https://claude.ai@evil.example` reads as claude.ai to a person but goes to evil.example) and port 0. */
export function acceptableRedirectUri(uri: string): boolean {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2000) return false;
  if (/[^\x21-\x7e]|[#\\]/.test(uri)) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  const bareOrigin = url.pathname === "/" && !url.search && url.href === `${uri}/`;
  if (url.href !== uri && !bareOrigin) return false;
  if (url.username || url.password || url.port === "0") return false;
  // The host must be a plain letters-digits-hyphens name (security review N1): the consent page shows it as where the
  // answer goes. It once went into that page's CSP as well (form-action), where `*`, `;`, `,` or a quote would widen or
  // break the policy; since onboarding slice 3 the CSP names no redirect origin, and the rule stays. Canonical form has
  // already lower-cased it, and an internationalised name arrives as punycode.
  if (url.protocol === "https:") return /^[a-z0-9.-]+$/.test(url.hostname);
  if (url.protocol !== "http:") return false;
  return LOOPBACK_REDIRECT.test(uri) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** A presented redirect against a registered one: the exact string, except that the port of a loopback http URI is
 * ignored (RFC 8252 §7.3: a native app listens on whatever port it gets; Claude Code registers
 * `http://localhost/callback` and `http://127.0.0.1/callback`, design §2). No other host, and no https URI, gets that
 * leniency. Both sides must be acceptable, so a stored value that predates a rule cannot match. */
export function redirectMatches(registered: string, presented: string): boolean {
  if (!acceptableRedirectUri(registered) || !acceptableRedirectUri(presented)) return false;
  if (registered === presented) return true;
  const withoutPort = (uri: string) => (LOOPBACK_REDIRECT.test(uri) ? uri.replace(LOOPBACK_REDIRECT, "http://$1") : null);
  const a = withoutPort(registered);
  return a !== null && a === withoutPort(presented);
}

/** The per-network key for the OAuth endpoints' own rate limits (DCR, and the CIMD fetch at authorize). IPv4 keys on
 * the address; IPv6 on its /64, the smallest block one subscriber is normally given, so rotating addresses inside it buys
 * no extra budget (Sonnet security review, 2026-09-29). A v4-mapped address counts as the IPv4 address it carries. It is
 * never keyed on a bearer string, which a caller can vary at will (the global limiter's rateLimitKey does). */
export function oauthIpKey(ip: string | undefined): string {
  if (!ip) return "ip:unknown";
  const plain = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  if (isIP(plain) !== 6) return `ip:${plain}`;
  return `ip6:${ipv6Groups(plain).slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

export const CLIENT_NAME_MAX = 100;
export const MAX_REDIRECT_URIS = 20;

/** DCR takes a tighter bound per redirect URI than the general 2000 (acceptableRedirectUri): every registration is a
 * stored row anyone can create, and no real callback is longer (Sonnet security review D1). */
export const DCR_REDIRECT_URI_MAX = 512;
/** Control, format (zero-width, bidi), surrogate, private-use and unassigned characters, plus the bidi embeddings,
 * overrides and isolates named explicitly: none belongs in a name a person reads on the consent page, and a bidi override
 * can make the name read as something else ("Claude" + U+202E + "edoc"). */
const INVISIBLE_OR_REORDERING = /[\p{C}‪-‮⁦-⁩]/u;

/** The display name a client asserts, by one rule for DCR and CIMD clients. The consent page shows it next to the
 * redirect's hostname (design §3), which is what a person should trust; the name is only a label, so it is bounded and
 * refused outright (not silently cleaned) when it carries characters a person cannot see. */
export function clientNameFrom(value: unknown): { ok: true; name: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, name: null };
  if (typeof value !== "string") return { ok: false, error: "client_name must be a string" };
  if (INVISIBLE_OR_REORDERING.test(value)) return { ok: false, error: "client_name must not contain control, invisible or bidirectional-override characters" };
  const name = value.trim();
  if (name.length > CLIENT_NAME_MAX) return { ok: false, error: `client_name must be at most ${CLIENT_NAME_MAX} characters` };
  return { ok: true, name: name || null };
}

/** The RFC 7591 §3.2.1 response: everything the hub registered, and no secret, because every client here is public. */
export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
}
export type RegistrationResult =
  | { ok: true; client: RegisteredClient }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; error_description: string };

const insertClient = db.prepare(`INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris) VALUES (?, 'dcr', ?, ?)`);

/** Dynamic client registration (RFC 7591), the fallback for clients without CIMD (design §2/§3). Public clients only:
 * the metadata advertises "none" as the one endpoint auth method, so a client asking for a secret is refused rather
 * than given a registration it would then use wrongly. The redirect URIs follow the same rule the authorize step
 * enforces (acceptableRedirectUri), so a URI that could never be used is refused here, where the client can see why.
 * grant_types and response_types are not negotiated: RFC 7591 §3.2.1 lets the server substitute its own, and the
 * response states the only ones this hub serves. A client_id in the request is ignored; the hub picks a random one,
 * which never starts with https:// and so can never be mistaken for a CIMD URL. */
export function registerDynamicClient(body: unknown, nowMs = Date.now()): RegistrationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_client_metadata", error_description: "the registration must be a JSON object" };
  }
  const m = body as Record<string, unknown>;
  if (m.token_endpoint_auth_method !== undefined && m.token_endpoint_auth_method !== "none") {
    return { ok: false, error: "invalid_client_metadata", error_description: "only public clients are supported: token_endpoint_auth_method must be \"none\"" };
  }
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: "invalid_redirect_uri", error_description: `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs` };
  }
  if (!uris.every((u) => typeof u === "string" && u.length <= DCR_REDIRECT_URI_MAX && acceptableRedirectUri(u))) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      error_description: `every redirect URI must be a canonical https URI, or http to localhost, 127.0.0.1 or [::1], of at most ${DCR_REDIRECT_URI_MAX} characters`,
    };
  }
  const name = clientNameFrom(m.client_name);
  if (!name.ok) return { ok: false, error: "invalid_client_metadata", error_description: name.error };
  const clientId = `dcr_${randomBytes(16).toString("hex")}`;
  insertClient.run(clientId, name.name, JSON.stringify(uris));
  return {
    ok: true,
    client: {
      client_id: clientId,
      client_id_issued_at: Math.floor(nowMs / 1000),
      ...(name.name ? { client_name: name.name } : {}),
      redirect_uris: uris as string[],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  };
}

export const DCR_CLIENT_UNUSED_TTL_DAYS = 30;
const pruneDcrClients = db.prepare(
  `DELETE FROM oauth_clients
    WHERE kind = 'dcr' AND created_at < datetime(?, 'unixepoch')
      AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.client_id = oauth_clients.client_id)
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)
      AND NOT EXISTS (SELECT 1 FROM oauth_consents k WHERE k.client_id = oauth_clients.client_id)
      AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = oauth_clients.client_id)`,
);

/** Registration is open to anyone, so an unused registration must not live forever (Sonnet security review D1): a DCR
 * client older than DCR_CLIENT_UNUSED_TTL_DAYS that no authorization code, token, grant or pending consent names is
 * deleted. One that was ever used keeps its row while any of those (spent, revoked or expired) still refers to it. Run
 * by the hub's minute sweep (src/index.ts). */
export function pruneStaleDcrClients(nowMs = Date.now()): number {
  return pruneDcrClients.run(Math.floor(nowMs / 1000) - DCR_CLIENT_UNUSED_TTL_DAYS * 24 * 60 * 60).changes;
}

// --- Tokens -------------------------------------------------------------------------------------------------------------
// Opaque random strings, stored only as SHA-256 hashes, like agent keys. The prefixes are distinct from agt_ (agent key)
// and dev_ (device credential) so each credential kind is recognisable, and src/secrets.ts masks them.
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const newToken = (prefix: "oca" | "ocr") => `${prefix}_${randomBytes(24).toString("hex")}`;
const isoIn = (seconds: number, nowMs: number) => new Date(nowMs + seconds * 1000).toISOString();

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  familyId: string;
}

const insertToken = db.prepare(
  `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, org_id, agent_id, person_id, resource, expires_at, created_at, grant_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

/** One approval: the client, the workspace and connector agent it created, the PERSON who approved it (connect_this_computer
 * re-checks that person's live role, design §3), and the resource the tokens are bound to. */
export interface Grant {
  clientId: string; orgId: string; agentId: string; personId: string; resource: string;
  /** The durable grant (oauth_grants, plan §7.2) the family belongs to; a refresh keeps it. Required: a token is refused
   * once its grant is revoked or gone (verifyAccessToken, rotateRefreshToken). */
  grantId: string;
}

function insertPair(familyId: string, grant: Grant, nowMs: number): TokenPair {
  const accessToken = newToken("oca");
  const refreshToken = newToken("ocr");
  const now = new Date(nowMs).toISOString();
  const grantId = grant.grantId;
  insertToken.run(hashKey(accessToken), "access", familyId, grant.clientId, grant.orgId, grant.agentId, grant.personId, grant.resource, isoIn(ACCESS_TOKEN_TTL_SECONDS, nowMs), now, grantId);
  insertToken.run(hashKey(refreshToken), "refresh", familyId, grant.clientId, grant.orgId, grant.agentId, grant.personId, grant.resource, isoIn(REFRESH_TOKEN_TTL_SECONDS, nowMs), now, grantId);
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, familyId };
}

/** A new token family for one approved grant (the code exchange in PR2 is its caller). */
export function issueTokenFamily(grant: Grant, nowMs = Date.now()): TokenPair {
  return db.transaction(() => insertPair(randomUUID(), grant, nowMs))();
}

const selectAccess = db.prepare(
  `SELECT t.org_id, t.agent_id, t.person_id, t.family_id, t.resource, t.expires_at, t.revoked_at, a.name, a.key_class, a.role, a.removed_at, o.paused_at,
          (SELECT m.role FROM workspace_members m WHERE m.org_id = t.org_id AND m.person_id = t.person_id) AS member_role,
          (SELECT g.revoked_at IS NULL FROM oauth_grants g WHERE g.grant_id = t.grant_id) AS grant_live
     FROM oauth_tokens t
     JOIN agents a ON a.id = t.agent_id AND a.org_id = t.org_id
     JOIN organizations o ON o.id = t.org_id
    WHERE t.token_hash = ? AND t.kind = 'access'`,
);
type AccessRow = {
  org_id: string; agent_id: string; person_id: string; family_id: string; resource: string; expires_at: string; revoked_at: string | null;
  name: string; key_class: string; role: AgentRole; removed_at: string | null; paused_at: string | null; member_role: string | null;
  grant_live: number | null;
};

/** The approving person still belongs to the workspace with a role that may add agents (agents.create). Membership
 * changes revoke the grant already (closeConnectorGrants); this is the second, independent check, read on every use
 * of a token (security review S2). */
const personMayConnect = (memberRole: string | null): boolean =>
  memberRole === "owner" || memberRole === "admin" || memberRole === "member" ? can(memberRole as Role, "agents.create") : false;

/** The agent an access token acts as, or null. Refused: an unknown token, a refresh token presented as an access token,
 * an expired or revoked one (revoked_at is read on EVERY request, so a family revoke takes effect at once, not at
 * expiry), a token for any other resource (audience binding), a removed agent, and a paused workspace (only operators
 * resolve there, as for agent keys; a connector agent is never an operator). */
/** An agent resolved from a connector token also names the person who approved the connection. */
export type ConnectorAgent = AuthedAgent & { connectorPersonId: string; connectorFamilyId: string };

export function verifyAccessToken(token: string | undefined, resource: string, nowMs = Date.now()): ConnectorAgent | null {
  if (!token || !token.startsWith("oca_")) return null;
  const row = selectAccess.get(hashKey(token)) as AccessRow | undefined;
  if (!row) return null;
  if (row.revoked_at || row.removed_at) return null;
  if (Date.parse(row.expires_at) <= nowMs) return null;
  if (row.resource !== resource) return null;
  if (row.paused_at && row.role !== "operator") return null;
  if (!personMayConnect(row.member_role)) return null;
  // The grant is the connection (Codex on #651): a revoked or missing grant ends its tokens even if their own rows
  // escaped revocation, and a token that names no grant (grant_id NULL, minted before grants existed) is refused too;
  // none exists in production, where the connector was never on.
  if (row.grant_live !== 1) return null;
  const keyClass: KeyClass = row.key_class === "watcher" ? "watcher" : "agent";
  return { orgId: row.org_id, agentId: row.agent_id, agentName: row.name, keyClass, role: row.role, connectorPersonId: row.person_id, connectorFamilyId: row.family_id };
}

export type RefreshResult = ({ ok: true } & TokenPair) | { ok: false; error: "invalid_grant"; reused: boolean };

const spendRefresh = db.prepare(
  `UPDATE oauth_tokens SET spent_at = ?
    WHERE token_hash = ? AND kind = 'refresh' AND client_id = ? AND spent_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
);
const selectRefresh = db.prepare(
  `SELECT family_id, client_id, org_id, agent_id, person_id, resource, spent_at, grant_id,
          (SELECT m.role FROM workspace_members m WHERE m.org_id = t.org_id AND m.person_id = t.person_id) AS member_role,
          (SELECT g.revoked_at IS NULL FROM oauth_grants g WHERE g.grant_id = t.grant_id) AS grant_live
     FROM oauth_tokens t WHERE token_hash = ? AND kind = 'refresh'`,
);

/** Rotates a refresh token (docs/design/MCP-CONNECTOR.md §3, Codex-OpenCadre-f46c's contract on 6d5e407). ONE
 * transaction spends the presented token -- the UPDATE must change exactly one row -- and issues the new pair, so two
 * concurrent refreshes with the same token cannot both succeed: the second finds it spent. Presenting a SPENT token is
 * reuse, which means it leaked: the whole family (refresh AND access tokens) is revoked in the same transaction. */
export function rotateRefreshToken(refreshToken: string | undefined, clientId: string, nowMs = Date.now()): RefreshResult {
  if (!refreshToken || !refreshToken.startsWith("ocr_")) return { ok: false, error: "invalid_grant", reused: false };
  const hash = hashKey(refreshToken);
  const now = new Date(nowMs).toISOString();
  const outcome = db.transaction((): RefreshResult | { revokedFamily: { agentId: string; familyId: string } } => {
    const row = selectRefresh.get(hash) as { family_id: string; client_id: string; org_id: string; agent_id: string; person_id: string; resource: string; spent_at: string | null; grant_id: string; member_role: string | null; grant_live: number | null } | undefined;
    if (!row || row.client_id !== clientId) return { ok: false, error: "invalid_grant", reused: false };
    if (!personMayConnect(row.member_role)) return { ok: false, error: "invalid_grant", reused: false };
    if (row.grant_live !== 1) return { ok: false, error: "invalid_grant", reused: false };
    if (spendRefresh.run(now, hash, clientId, now).changes !== 1) {
      if (row.spent_at) {
        revokeFamilyRows(row.family_id, now);
        return { revokedFamily: { agentId: row.agent_id, familyId: row.family_id } };
      }
      return { ok: false, error: "invalid_grant", reused: false }; // expired or already revoked
    }
    return { ok: true, ...insertPair(row.family_id, { clientId: row.client_id, orgId: row.org_id, agentId: row.agent_id, personId: row.person_id, resource: row.resource, grantId: row.grant_id }, nowMs) };
  })();
  if ("revokedFamily" in outcome) {
    // Only the leaked family's held requests end; another client of the same connector keeps its own (review S4).
    endHeldRequests(outcome.revokedFamily.agentId, 401, "a reused refresh token revoked this connection", outcome.revokedFamily.familyId);
    return { ok: false, error: "invalid_grant", reused: true };
  }
  return outcome;
}

const revokeFamilyStmt = db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`);
const revokeAgentStmt = db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL`);
function revokeFamilyRows(familyId: string, now: string): number {
  return revokeFamilyStmt.run(now, familyId).changes;
}

/** A connection's live requests end with its tokens: held MCP requests (wait_for_message, …) and /live sockets. */
function endAgentConnections(agentId: string, reason: string): void {
  endHeldRequests(agentId, 401, reason);
  disconnectAgent(agentId, reason);
}

/** Marks every token of one agent revoked, and nothing else: for a caller that ends the agent's connections itself
 * after its own transaction commits (revokeGrant). */
export function revokeAgentTokenRows(agentId: string, nowMs = Date.now()): number {
  return revokeAgentStmt.run(new Date(nowMs).toISOString(), agentId).changes;
}

/** Revokes every token of one agent (Disconnect in the console, PR3, and the isolation later-switch rule). */
export function revokeAgentTokens(agentId: string, reason = "this connection was disconnected", nowMs = Date.now()): number {
  const changed = revokeAgentTokenRows(agentId, nowMs);
  endAgentConnections(agentId, reason);
  return changed;
}

const liveAccessForAgent = db.prepare(
  `SELECT 1 FROM oauth_tokens WHERE agent_id = ? AND kind = 'access' AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
);

/** Revokes ONE token family (RFC 7009 revocation, plan §7.4; a reused authorization code). Other families of the same
 * connector agent keep working. The family's held MCP requests end at once: each was held with its family
 * (src/mcp.ts, holdOpenRequest), so another family's are untouched (review S4). Live sockets are not tied to a family,
 * so they end only when the agent has no live access token left. */
export function revokeTokenFamily(familyId: string, reason = "this connection was revoked", nowMs = Date.now()): number {
  const now = new Date(nowMs).toISOString();
  const agent = db.prepare(`SELECT agent_id FROM oauth_tokens WHERE family_id = ? LIMIT 1`).pluck().get(familyId) as string | undefined;
  const changed = revokeFamilyRows(familyId, now);
  if (agent && changed > 0) {
    endHeldRequests(agent, 401, reason, familyId);
    if (!liveAccessForAgent.get(agent, now)) disconnectAgent(agent, reason);
  }
  return changed;
}

/** The client a token family was issued to. */
export const clientOfFamily = (familyId: string): string | undefined =>
  db.prepare(`SELECT client_id FROM oauth_tokens WHERE family_id = ? LIMIT 1`).pluck().get(familyId) as string | undefined;

/** The family a presented access or refresh token belongs to, or null. */
export function familyOfToken(token: string | undefined): string | null {
  if (!token || !(token.startsWith("oca_") || token.startsWith("ocr_"))) return null;
  return (db.prepare(`SELECT family_id FROM oauth_tokens WHERE token_hash = ?`).pluck().get(hashKey(token)) as string | undefined) ?? null;
}

// --- The code exchange (POST /oauth/token, plan §5 Task 5) ----------------------------------------------------------------
export interface CodeExchange { code: string; clientId: string; redirectUri: string; resource: string; codeVerifier: string }
export type TokenError = { ok: false; error: "invalid_grant" | "invalid_target"; description: string };

const selectCode = db.prepare(
  `SELECT c.client_id, c.redirect_uri, c.code_challenge, c.resource, c.person_id, c.org_id, c.agent_id, c.grant_id, c.expires_at,
          c.used_at, c.family_id, g.grant_id AS grant_found, g.revoked_at AS grant_revoked_at
     FROM oauth_codes c LEFT JOIN oauth_grants g ON g.grant_id = c.grant_id
    WHERE c.code_hash = ?`,
);
const spendCode = db.prepare(`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`);
const recordCodeFamily = db.prepare(`UPDATE oauth_codes SET family_id = ? WHERE code_hash = ?`);
type CodeRow = {
  client_id: string; redirect_uri: string; code_challenge: string; resource: string; person_id: string; org_id: string;
  agent_id: string; grant_id: string | null; expires_at: string; used_at: string | null; family_id: string | null;
  grant_found: string | null; grant_revoked_at: string | null;
};

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Exchanges an authorization code (RFC 6749 §4.1.3 with PKCE, RFC 7636 §4.6; design §3). The code must be unused and
 * unexpired, and the client, the EXACT redirect it was issued for (a loopback port included) and the resource must all
 * match; the verifier's S256 must equal the stored challenge (`plain` is never accepted: the stored value is always an
 * S256 challenge, so a verifier equal to it fails). A refused exchange spends nothing. A code presented AGAIN after it
 * was exchanged has leaked (OAuth 2.1 §4.1.2): it is refused and the family it minted is revoked. The spend and the
 * issue are one transaction, and the spend must change exactly one row, so two exchanges at once cannot both win. */
export function exchangeAuthorizationCode(input: CodeExchange, nowMs = Date.now()): ({ ok: true } & TokenPair) | TokenError {
  const hash = hashKey(input.code);
  const now = new Date(nowMs).toISOString();
  const outcome = db.transaction((): ({ ok: true } & TokenPair) | TokenError | { reusedFamily: string | null } => {
    const row = selectCode.get(hash) as CodeRow | undefined;
    if (!row) return { ok: false, error: "invalid_grant", description: "unknown authorization code" };
    if (row.used_at) return { reusedFamily: row.family_id };
    if (Date.parse(row.expires_at) <= nowMs) return { ok: false, error: "invalid_grant", description: "the authorization code expired" };
    if (row.client_id !== input.clientId) return { ok: false, error: "invalid_grant", description: "the authorization code was issued to another client" };
    if (row.redirect_uri !== input.redirectUri) return { ok: false, error: "invalid_grant", description: "redirect_uri does not match the authorization request" };
    if (row.resource !== input.resource) return { ok: false, error: "invalid_target", description: `resource must be ${row.resource}` };
    if (s256(input.codeVerifier) !== row.code_challenge) return { ok: false, error: "invalid_grant", description: "code_verifier does not match the code_challenge" };
    // A code names its grant; one whose grant is revoked or gone is refused (a code from before grants existed too).
    if (!row.grant_id || !row.grant_found || row.grant_revoked_at) return { ok: false, error: "invalid_grant", description: "this connection was disconnected" };
    if (spendCode.run(now, hash, now).changes !== 1) return { reusedFamily: null };
    const pair = issueTokenFamily({
      clientId: row.client_id, orgId: row.org_id, agentId: row.agent_id, personId: row.person_id, resource: row.resource, grantId: row.grant_id,
    }, nowMs);
    recordCodeFamily.run(pair.familyId, hash);
    return { ok: true, ...pair };
  }).immediate();
  if ("reusedFamily" in outcome) {
    if (outcome.reusedFamily) revokeTokenFamily(outcome.reusedFamily, "a reused authorization code revoked this connection", nowMs);
    return { ok: false, error: "invalid_grant", description: "the authorization code was already used" };
  }
  return outcome;
}

/** Token rows expired, or revoked, longer ago than the refresh-token lifetime (security review N5). By then no refresh
 * token of the family can be presented as reuse (it has expired), so nothing is lost; the minute sweep runs this. */
export function pruneDeadTokens(nowMs = Date.now()): number {
  const cutoff = new Date(nowMs - REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  return db.prepare(`DELETE FROM oauth_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`).run(cutoff, cutoff).changes;
}

/** Codes live 60 s, but a spent one is kept a day longer, so presenting it again is still recognised as reuse. */
export function pruneExpiredCodes(nowMs = Date.now()): number {
  return db.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).run(new Date(nowMs - 24 * 60 * 60_000).toISOString()).changes;
}

// --- Closing connections when their basis goes (security review S2, S3) ---------------------------------------------------
const selectGrantsToClose = db.prepare(
  `SELECT g.grant_id, g.agent_id, a.name FROM oauth_grants g LEFT JOIN agents a ON a.id = g.agent_id
    WHERE g.org_id = ? AND g.revoked_at IS NULL AND (? IS NULL OR g.person_id = ?) AND (? = 0 OR g.scope_key = '*')`,
);

/** Closes connector connections INSIDE the caller's transaction, so they end with the change that removes their basis:
 * a person leaving the workspace or losing the role that may add agents (S2), or the workspace switching projects apart,
 * which a workspace-wide connection can no longer respect (design §6.1, S3). Each matching active grant is revoked, every
 * token of its agent is revoked, and the connector agent is removed (as removeAgent does). Returns the agents, whose live
 * requests the caller ends AFTER the commit (endConnectorConnections). */
export function closeConnectorGrants(
  filter: { orgId: string; personId?: string; workspaceScopeOnly?: boolean },
  actor: { id: string; name: string },
  nowMs = Date.now(),
): string[] {
  const now = new Date(nowMs).toISOString();
  const rows = selectGrantsToClose.all(filter.orgId, filter.personId ?? null, filter.personId ?? null, filter.workspaceScopeOnly ? 1 : 0) as
    Array<{ grant_id: string; agent_id: string; name: string | null }>;
  for (const row of rows) {
    db.prepare(`UPDATE oauth_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`).run(now, row.grant_id);
    revokeAgentStmt.run(now, row.agent_id);
    const removed = db.prepare(
      `UPDATE agents SET removed_at = datetime('now'), removed_by_agent_name = ?, api_key_hash = ? WHERE id = ? AND org_id = ? AND removed_at IS NULL`,
    ).run(actor.name, `removed:${randomBytes(32).toString("hex")}`, row.agent_id, filter.orgId).changes;
    if (removed) emitEvent({ orgId: filter.orgId, type: "agent.removed", actor, subjectType: "agent", subjectId: row.agent_id, payload: { agentName: row.name } });
  }
  return rows.map((r) => r.agent_id);
}

/** Ends the live requests of connector agents closeConnectorGrants closed. Call after the transaction commits. */
export function endConnectorConnections(agentIds: string[], reason: string): void {
  for (const agentId of agentIds) endAgentConnections(agentId, reason);
}
