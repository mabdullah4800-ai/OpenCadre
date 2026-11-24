import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { db } from "./db.js";
import { authenticateAgentKey, isPausedWorkspaceKey } from "./auth.js";
import { getMembership, SESSION_COOKIE, sessionPerson } from "./accounts.js";
import { PAUSED_SOCKET_CODE } from "./kill-switch.js";
import { checkDeviceSession, isDeviceCredential } from "./devices.js";
import type { ConsolePrincipal } from "./console-live.js";

/** Who is opening a /live WebSocket: an agent with ?apiKey=, a device session with its Authorization and session headers, or a person signed in to the console with the session
 * cookie plus ?workspace=<orgId>. Close codes: 4001 not authenticated, 4003 workspace paused. */
export type LiveAuth = ({ ok: true; orgId: string; agentId: string } & { kind?: "agent" }) | ({ ok: true } & ConsolePrincipal) | { ok: false; code: number; reason: string };

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); }
      catch { return undefined; }
    }
  }
  return undefined;
}

export function authenticateLiveRequest(req: IncomingMessage): LiveAuth {
  const url = new URL(req.url ?? "", "http://localhost");
  const apiKey = url.searchParams.get("apiKey") ?? undefined;
  if (apiKey) {
    const authed = authenticateAgentKey(apiKey);
    if (authed) return { ok: true, orgId: authed.orgId, agentId: authed.agentId };
    return isPausedWorkspaceKey(apiKey)
      ? { ok: false, code: PAUSED_SOCKET_CODE, reason: "workspace paused by an operator" }
      : { ok: false, code: 4001, reason: "invalid api key" };
  }

  // A device session authenticates with the Authorization header and its session headers on the upgrade request, never
  // with a credential in the URL (a dev_ value in ?apiKey= is simply an invalid agent key above).
  const authorization = req.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  if (isDeviceCredential(bearer)) {
    const checked = checkDeviceSession(bearer, req.headers);
    if (checked.ok) return { ok: true, orgId: checked.auth.orgId, agentId: checked.auth.agentId };
    if (checked.reason === "paused") return { ok: false, code: PAUSED_SOCKET_CODE, reason: "workspace paused by an operator" };
    if (checked.reason === "project_not_enabled") return { ok: false, code: 4001, reason: "OpenCadre isn't enabled for this project" };
    return { ok: false, code: 4001, reason: "invalid device credential or session" };
  }

  const token = cookie(req, SESSION_COOKIE);
  if (!token) return { ok: false, code: 4001, reason: "invalid api key" };
  // Browsers send cookies on a WebSocket handshake from any site, so a session socket must come from the console's own
  // origin (cross-site WebSocket hijacking). Agents authenticate with a key and are unaffected.
  const origin = req.headers.origin;
  let sameOrigin = false;
  try {
    sameOrigin = Boolean(origin) && new URL(origin!).host === req.headers.host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return { ok: false, code: 4001, reason: "session sockets must come from the console" };
  const person = sessionPerson(token);
  const orgId = url.searchParams.get("workspace");
  if (!person || !orgId) return { ok: false, code: 4001, reason: "sign in again" };
  const membership = getMembership(orgId, person.id);
  if (!membership) return { ok: false, code: 4001, reason: "not a member of this workspace" };
  const row = db.prepare(`SELECT a.role, o.paused_at FROM agents a JOIN organizations o ON o.id = a.org_id WHERE a.id = ? AND a.org_id = ?`)
    .get(membership.agent_id, orgId) as { role: string; paused_at: string | null } | undefined;
  if (!row) return { ok: false, code: 4001, reason: "not a member of this workspace" };
  if (row.paused_at && row.role !== "operator") return { ok: false, code: PAUSED_SOCKET_CODE, reason: "workspace paused by an operator" };
  return {
    ok: true,
    kind: "console",
    orgId,
    agentId: membership.agent_id,
    personId: person.id,
    sessionHash: createHash("sha256").update(token).digest("hex"),
    memberRole: membership.role,
  };
}
