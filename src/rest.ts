import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";
import { db } from "./db.js";
import { createRateLimiter, rateLimitMiddleware, requestsPerMinute } from "./ratelimit.js";
import { authenticateAgentKey, authenticateOrgBootstrapKey, isPausedWorkspaceKey } from "./auth.js";
import { PAUSED_ERROR, pauseWorkspace, resumeWorkspace, workspacePauseState } from "./kill-switch.js";
import { agentLimitRefusal, billingVerb, liveAgentsFor, machineLimitRefusal, readOnlyRefusal, workspaceBilling } from "./billing.js";
import { captureRawBody, signedBodyOf } from "./raw-body.js";
import type { AgentRole } from "./auth.js";
import {
  AgentNameError, askClarification, broadcastMessage, consumeMessages, createOrganization, DUPLICATE_SEND, getAgentCapabilities, getAgentRoundBudget, getFile,
  getMessages, heartbeat, listActiveAgents, MESSAGE_BODY_TOO_LONG, PHASES, registerAgent, removeAgent, reply, resolvePeekDefault, rotateAgentKey,
  sendMessage, SESSION_ENDED_ERROR, searchMessages, setAgentCapabilities, setAgentRoundBudget, setAgentStatus, setAgentWebhook, getOrgAgentWebhook, sendTestWake, setOrgAgentWebhook, shareFile, waitForMessage, getThreadStatus,
} from "./service.js";
import {
  checkDeviceSession, ADOPT_LIVE_HEADER, CHAT_PROVEN_HEADER, CLIENT_HEADER, createDevice, describeComputer, deviceAuthError, DeviceError, deviceRefusalResponse, enableCurrentProject, listDeviceProjects, HOST_SESSION_HEADER,
  isDeviceCredential, isQuietLegacyRefusal, leaveDeviceSession, listDevices as listOrgDevices, listSessions, looksLikeDeviceCode, PROJECT_HEADER, PROJECT_NAME_HEADER,
  recordDeviceConnectorReport, recordDeviceTools, redeemDeviceCode, nameSession, keepSessionName, ProfileNameError, SessionNameRefusal, RESOLVE_ONLY_HEADER, revokeDevice, SESSION_HEADER,
} from "./devices.js";
import { listProjects, PROJECT_KEY_ERROR, ProjectError, setProjectEnabled } from "./projects.js";
import type { AuthedAgent } from "./auth.js";
import type { KeyClass, LastWake, Priority } from "./service.js";
import { acceptTask, claimTask, completeTask, createTask, getTaskById, listTaskPage, listTasks, parseTaskListQuery, rejectTask, releaseTask, renewClaim, setTaskLane, supersedeTask, TaskHeldError, TaskInputError, TaskQueryError } from "./tasks.js";
import { taskBoard } from "./task-board.js";
import { TaskCursorError } from "./task-cursor.js";
import { claimResource, listResourceLocks, releaseResource, renewResourceLock, ResourceLockInputError } from "./resource-locks.js";
import { BlackboardInputError, deleteFact, getFact, listFacts, setFact } from "./blackboard.js";
import { getAgentReliability, listAgentReliability } from "./reliability.js";
import { getTaskShapeStats } from "./task-telemetry.js";
import { getOrgUsageSummary, OrgUsageInputError } from "./org-usage.js";
import { retentionNotice } from "./retention.js";
import { archiveMemory, createMemory, getMemory, listMemory, MemoryInputError, searchMemory, supersedeMemory } from "./memory.js";
import { getGoals, setGoal } from "./goals.js";
import { APPROVAL_STATUSES_HEADER, countNotedApprovals, decideApproval, forClientWithoutWithdrawn, getApprovalById, knowsWithdrawn, listApprovalGrants, listApprovals, requestApproval, revokeApprovalGrant, waitForApproval, withdrawApproval } from "./approvals.js";
import type { ApprovalRecord, ApprovalStatus, Risk } from "./approvals.js";
import { recordDecision } from "./events.js";
import { listTimeline, sweepTimeline, waitForTimeline } from "./timeline.js";
import { ackEvent, pullEvents } from "./deliveries.js";
import { getAwareness } from "./awareness.js";
import { CLI_TARBALL, CONNECT_CLIENTS, cliTarballUrl, connectCodeStatus, connectCommand, createConnectCode, redeemConnectCode } from "./connect.js";
import type { ConnectClient } from "./connect.js";
import { STAMP_PATTERN, cliManifest, currentCliPackage, publicHubUrl } from "./cli-package.js";
import { cliProvenanceProblem } from "./cli-provenance-guard.js";
import { parseUsageReport, setAgentUsage } from "./usage.js";
import { validateWebhookAuthHeader, validateWebhookUrl } from "./webhook-guard.js";
import { beginIdempotent, completeIdempotent, IDEMPOTENCY_KEY_PATTERN, releaseIdempotent, requestHash } from "./idempotency.js";
import { totalsSnapshot, windowStats } from "./metrics.js";
import { liveSocketCount, pendingInboxWaiterCount } from "./live.js";
import { pendingEventWaiterCount } from "./events.js";
import { holdOpenRequest } from "./revocation.js";
import { log } from "./log.js";
import {
  AccountError, acceptInvite, changeRole, createInvite, createSession, createWorkspace, deleteSession, describeInvite,
  displayName, getMembership, isMemberRole, listMembers, listWorkspaces, publicPerson, removeMember, revokeInvite, SESSION_COOKIE,
  SESSION_DAYS, sessionPerson, upsertPerson, canCreateWorkspace, signupMode, unverifiedEmailRefusal, type MemberRole, type Person,
} from "./accounts.js";
import {
  AUTHORIZATION_SERVER_METADATA_PATH, authorizationServerMetadata, clientOfFamily, exchangeAuthorizationCode, familyOfToken,
  mcpResource, OAUTH_SCOPE, revokeTokenFamily,
  oauthConsentOrigin, oauthEnabled, oauthIssuer, PROTECTED_RESOURCE_PATH, protectedResourceMetadata, oauthIpKey,
  registerDynamicClient, rotateRefreshToken,
} from "./oauth.js";
import {
  answeredConsent, approveConsent, checkAuthorizeRequest, CONSENT_PROBLEM_MESSAGE, consentCsrf, createConsent, csrfMatches,
  defaultNewProjectName, defaultProjectKey, defaultWorkspaceId, denyConsent, eligibleWorkspaces, freeConnectionName, grantNames, hasActiveGrant, loadOauthClient, readConsent,
  redirectStillRegistered, redirectWithParams, returnHref, type ConsentProblem,
} from "./oauth-authorize.js";
import { renderAlreadyConnectedPage, renderConsentPage, renderOauthErrorPage, renderReturnPage, type PageChrome } from "./oauth-consent-page.js";
import { authorizeUrl, enabledMethods, exchangeCode, newPkce, OAUTH_PROVIDERS, sendMagicLink, supabaseAuthConfig, type OAuthProvider } from "./supabase-auth.js";
import { consumeLocalTicket, issueLocalTicket } from "./local-sign-in.js";
import { onboardingProgress } from "./onboarding.js";
import { can, roleFor, type Action } from "./permissions.js";
import { deleteSubscription, listDevices, pushConfig, pushToPeople, saveSubscription } from "./push.js";
import { POLICY_PASS_REASONS, recordPolicyPass, reportExecuted } from "./clearance-bypass.js";
import { clearClearancePolicy, getClearancePolicy, isClearanceMode, listClearancePolicies, normalizeProject, setClearancePolicy } from "./clearance-policy.js";
import { getProjectSettings, parseProjectParam, ProjectSettingsError, setWipCap } from "./project-settings.js";
import { NOT_REACHABLE, NoNamespaceError, NotReachableError, projectIsolationEnabled, visibleOf, withScopeCache } from "./scope.js";
import {
  linkProjects, listProjectLinks, PreflightRefusedError, ProjectLinkError, projectIsolationState, setProjectIsolation, unlinkProjects,
} from "./project-isolation.js";

const VALID_PRIORITIES: Priority[] = ["high", "medium", "low"];
function normalizePriority(raw: unknown): Priority {
  return typeof raw === "string" && (VALID_PRIORITIES as string[]).includes(raw) ? (raw as Priority) : "medium";
}

// An oversized body is the caller's fault; an ended session is gone; a target outside the sender's projects is forbidden
// (project isolation); any other message failure is a missing agent or thread.
const messageErrorStatus = (result: { error: string; code?: string }) =>
  result.code === NOT_REACHABLE ? 403
  : result.code === DUPLICATE_SEND ? 409
  : result.error === MESSAGE_BODY_TOO_LONG ? 400
  : result.error === SESSION_ENDED_ERROR ? 410
  : 404;

// Absent means no limit, so existing REST readers keep getting the whole inbox.
function messageLimitFrom(raw: unknown): number | undefined {
  const n = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export const app = express();
// Behind Caddy on the same host. In Docker, Caddy's connection arrives from the
// bridge gateway (172.17.0.1), so trust loopback and private ranges -- never
// public addresses -- so req.ip is the real client and can't be spoofed remotely.
app.set("trust proxy", ["loopback", "uniquelocal"]);
app.use((req, res, next) => {
  // Host-scoped only: do not commit unrelated subdomains to HTTPS or preload.
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
});
// The provider webhook is EXEMPT from the global limiter and carries its own (see its route below).
// It must be exempted here rather than given a limiter downstream: `app.use` runs for every request
// before any route handler, so a route cannot escape this one by adding another behind it.
app.use(
  rateLimitMiddleware(createRateLimiter({ limit: requestsPerMinute(), windowMs: 60_000 }), {
    exempt: ["/v1/billing/webhook"],
  }),
);
// The body parser keeps a reference to the bytes it read (src/raw-body.ts's captureRawBody),
// which the billing webhook below verifies. It is a REFERENCE and not a copy -- express.json already
// buffers every body to parse it -- so the marginal cost is a pointer, and the alternative (a
// raw-body middleware mounted ahead of this line for one path) is order-dependent and can be
// silenced by moving a line. Order-independent is the whole reason the capture lives here.
// Request compression is unnecessary for our JSON clients and expands the unauthenticated
// native-decoder surface (including Node's October 2026 Brotli advisory). Refuse it before inflation.
app.use(express.json({ limit: "10mb", inflate: false, verify: captureRawBody }));
// Project scope answers (src/scope.ts) are cached for the life of one request.
app.use((_req, _res, next) => withScopeCache(() => next()));

function bearer(req: Request): string | undefined {
  const h = req.header("authorization");
  if (!h?.startsWith("Bearer ")) return undefined;
  return h.slice("Bearer ".length);
}

interface AuthedRequest extends Request {
  orgId?: string;
  agentId?: string;
  agentName?: string;
  keyClass?: KeyClass;
  agentRole?: AgentRole;
  /** Set when a person signed in with a session cookie (docs/design/ACCOUNTS.md), not an agent key. */
  person?: Person;
  memberRole?: MemberRole;
  /** Set when a device credential (dev_) authenticated one of its sessions (src/devices.ts). */
  deviceId?: string;
}

// --- Cookies (people sessions) ------------------------------------------------------
function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function setCookie(req: Request, res: Response, name: string, value: string, { maxAgeSeconds, path = "/", domain = null }: { maxAgeSeconds: number; path?: string; domain?: string | null }) {
  const secure = req.secure || process.env.NODE_ENV === "production";
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSeconds}${domain ? `; Domain=${domain}` : ""}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
}

/** THE way a person's session starts in the browser: the session cookie (host-only, unchanged) and the hint. Every
 * sign-in path goes through here (tests/site-signed-in-hint.test.ts holds that). */
function startPersonSession(req: Request, res: Response, token: string) {
  setCookie(req, res, SESSION_COOKIE, token, { maxAgeSeconds: SESSION_DAYS * 86_400 });
}
/** THE way a person's session ends in the browser: both cookies cleared. Every sign-out path goes through here. */
function endPersonSession(req: Request, res: Response) {
  setCookie(req, res, SESSION_COOKIE, "", { maxAgeSeconds: 0 });
}

const WORKSPACE_HEADER = "x-opencadre-workspace";

/** The writes an operator may make on a workspace with NO PLAN YET (src/billing.ts readOnlyRefusal): the ones needed to
 * START it -- bringing in the team. Everything else
 * (messages, tasks, memory, keys, connect codes, computers, ...) is a product write and waits for the trial. Reads,
 * sign-in and sign-out are not gated at all (they are GETs, or not workspace-authenticated). */
const PENDING_SETUP_ROUTES: readonly RegExp[] = [
  /^\/v1\/workspaces\/[^/]+\/(invites|members)(\/|$)/,
];
const isPendingSetupRoute = (path: string) => PENDING_SETUP_ROUTES.some((re) => re.test(path));

function parsePeekQuery(raw: unknown, keyClass: KeyClass): boolean {
  if (raw === undefined) return resolvePeekDefault(keyClass);
  return raw === "true";
}

function requireAgentAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!bearer(req) && readCookie(req, SESSION_COOKIE)) return requireMemberSession(req, res, next);
  // A device credential resolves to its own session agent, then continues exactly like an agent key.
  if (isDeviceCredential(bearer(req))) {
    const checked = checkDeviceSession(bearer(req), req.headers);
    if (!checked.ok) {
      // An approval gate from before opt-in projects falls back to its last cached mode on "no session", and would hold
      // or block a risky command under a cached ask or strict. Its policy read in a project that isn't enabled gets
      // "no policy" instead, so it behaves as if OpenCadre weren't there.
      if (isQuietLegacyRefusal(checked) && req.method === "GET" && req.path === "/v1/clearance-policy") {
        return res.json({ policy: { project: normalizeProject(req.query.project) ?? "", mode: "off", source: "default", updatedBy: null, updatedAt: null } });
      }
      const refused = deviceRefusalResponse(checked);
      return res.status(refused.status).json(refused.body);
    }
    req.deviceId = checked.auth.deviceId;
    return admitAgent(req, res, next, checked.auth);
  }
  const authed = authenticateAgentKey(bearer(req));
  if (!authed) {
    if (isPausedWorkspaceKey(bearer(req))) return res.status(423).json({ error: PAUSED_ERROR });
    return res.status(401).json({ error: "invalid or missing agent API key" });
  }
  admitAgent(req, res, next, authed);
}

function admitAgent(req: AuthedRequest, res: Response, next: NextFunction, authed: AuthedAgent) {
  // A lapsed workspace keeps serving reads and refuses writes (src/billing.ts). This runs BEFORE the
  // request is held open below: a refused write must not register as a waiting request, or the
  // refusal would leave an entry nothing is going to end. The predicate takes the HTTP method, which
  // is exactly the read/write distinction the pause gate never needed -- pause refuses both.
  // billingVerb: the method, or the full route key of a LAPSE_EXEMPT_WRITES route (req.route is the matched route here,
  // since this runs as that route's own middleware).
  const billingRefused = readOnlyRefusal(authed.orgId, billingVerb(req.method, req.route?.path), { role: authed.role, setup: isPendingSetupRoute(req.path) });
  if (billingRefused) return res.status(billingRefused.status).json(billingRefused.body);
  req.orgId = authed.orgId;
  req.agentId = authed.agentId;
  req.agentName = authed.agentName;
  req.keyClass = authed.keyClass;
  req.agentRole = authed.role;
  // Revoking this key ends a waiting request at once (src/revocation.ts). Only reads and questions wait;
  // retry-safe writes finish in milliseconds and must not have a 401 recorded against their key.
  if (req.method === "GET" || req.path === "/v1/questions") holdOpenRequest(authed.agentId, res);
  // Any authenticated REST call is real, current liveness -- a REST-only
  // agent (no WS, no MCP, never calls POST /v1/heartbeat itself) would
  // otherwise never register as online no matter how active it is. Found
  // live: ClaudeCode-Session showed "offline" while actively messaging.
  // A diagnostic read (`opencadre doctor`) opts out, so it measures the heartbeat age of the agent's
  // real loop instead of its own call; the echoed header tells it this hub honored the opt-out.
  if (req.method === "GET" && req.get("x-opencadre-probe") === "no-heartbeat") res.setHeader("x-opencadre-probe", "no-heartbeat");
  else heartbeat(authed.orgId, authed.agentId);
  next();
}

/** A person's console session acting in one workspace through their member agent. The workspace header is required:
 * it names the workspace, and as a non-simple header it also blocks cross-site requests (CSRF) that a cookie alone
 * would let through. */
function requireMemberSession(req: AuthedRequest, res: Response, next: NextFunction) {
  const person = sessionPerson(readCookie(req, SESSION_COOKIE));
  if (!person) {
    // The session is gone (expired, signed out elsewhere, or never real), so the site should stop saying "Open console".
    return res.status(401).json({ error: "Your session ended. Sign in again." });
  }
  const orgId = req.header(WORKSPACE_HEADER);
  if (!orgId) return res.status(400).json({ error: "Choose a workspace: send the X-OpenCadre-Workspace header with its id." });
  const membership = getMembership(orgId, person.id);
  if (!membership) return res.status(403).json({ error: "You're not a member of this workspace." });
  const row = db.prepare(`SELECT a.id, a.name, a.role, o.paused_at FROM agents a JOIN organizations o ON o.id = a.org_id WHERE a.id = ? AND a.org_id = ?`)
    .get(membership.agent_id, orgId) as { id: string; name: string; role: AgentRole; paused_at: string | null } | undefined;
  if (!row) return res.status(403).json({ error: "You're not a member of this workspace." });
  if (row.paused_at && row.role !== "operator") return res.status(423).json({ error: PAUSED_ERROR });
  // Same read/write rule as the agent-key path, and it matters most here: the web app is where the
  // workspace's own people find out WHY their workspace went read-only, so its reads must keep
  // working (GET /v1/me carries the billing state). Operators are exempt, as with pause.
  const billingRefused = readOnlyRefusal(orgId, billingVerb(req.method, req.route?.path), { role: row.role, setup: isPendingSetupRoute(req.path) });
  if (billingRefused) return res.status(billingRefused.status).json(billingRefused.body);
  req.person = person;
  req.memberRole = membership.role;
  req.orgId = orgId;
  req.agentId = row.id;
  req.agentName = row.name;
  req.keyClass = "agent";
  req.agentRole = row.role;
  if (req.method === "GET" || req.path === "/v1/questions") holdOpenRequest(row.id, res);
  heartbeat(orgId, row.id);
  next();
}

/** A signed-in person with no workspace context (their account, their workspace list, accepting an invite). Writes must
 * be JSON: a cross-site form can't send that content type without a CORS preflight, which the hub never approves. */
function requirePerson(req: AuthedRequest, res: Response, next: NextFunction) {
  const person = sessionPerson(readCookie(req, SESSION_COOKIE));
  if (!person) {
    return res.status(401).json({ error: "Sign in first." });
  }
  if (req.method !== "GET" && !req.is("application/json")) return res.status(415).json({ error: "Send JSON (content-type: application/json)." });
  req.person = person;
  next();
}

/** Stage 3 RBAC (src/permissions.ts, docs/design/rbac-permission-model.md): one shared
 * can(role, action) table instead of each route hand-rolling its own operator/owner/
 * workspace-admin check. `roleFor` reproduces exactly what the three checks this replaced
 * (requireOperator/requireOwner/requireWorkspaceAdmin, all removed here) computed: a member
 * session's real memberRole when present, "owner" for a bare API-key operator (the bootstrap
 * exception -- pre-accounts keys predate the owner/admin split and are the org's highest-trust
 * credential), "agent" otherwise. This first pass is a pure refactor: every REQUIRED role in
 * permissions.ts matches today's actual gating, so no existing key or session gains or loses
 * access here -- only the second migration PR (per the design doc) changes any behavior. */
function requirePermission(action: Action) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const role = roleFor(req.agentRole, req.person ? req.memberRole ?? null : null);
    if (!can(role, action)) return res.status(403).json({ error: PERMISSION_DENIED_MESSAGE[action] ?? "not permitted" });
    next();
  };
}

/** Not Record<Action, string>: approval.decide/approvalGrant.revoke are MCP-only (src/mcp.ts),
 * no REST route gates on them, so they fall back to the generic message above instead of needing
 * a REST-specific entry here. */
const PERMISSION_DENIED_MESSAGE: Partial<Record<Action, string>> = {
  "agents.create": "operator role required",
  "agents.rotateKey": "Only an owner can do this.",
  "agents.delete": "Only an owner can do this.",
  "agents.webhook": "Only an owner or admin can do this.",
  "orgUsage.read": "operator role required",
  "connectCodes.manage": "operator role required",
  "devices.manage": "operator role required",
  "projects.manage": "operator role required",
  "projectLinks.manage": "operator role required",
  "projectIsolation.manage": "operator role required",
  "sessions.manage": "operator role required",
  "clearancePolicy.write": "operator role required",
  "projectSettings.write": "Only a workspace admin can change project settings.",
  "clearancePolicy.list": "operator role required",
  "members.list": "Only an owner or admin can manage members.",
  "members.invite": "Only an owner or admin can manage members.",
  "members.inviteRevoke": "Only an owner or admin can manage members.",
  "members.changeRole": "Only an owner can do this.",
  "members.remove": "Only an owner can do this.",
  "org.pause": "Only an owner can do this.",
  "org.resume": "Only an owner can do this.",
  "billing.manage": "Only an owner can do this.",
};

/** The four /v1/workspaces/:orgId/... routes below also need this orgId-vs-caller check,
 * which requireWorkspaceAdmin used to fold in; kept separate since it's route shape, not a
 * permission. */
function requireWorkspaceMatch(req: AuthedRequest, res: Response, next: NextFunction) {
  if (String(req.params.orgId) !== req.orgId) return res.status(404).json({ error: "No such workspace." });
  next();
}

/** Runs after requireAgentAuth on write routes. With an Idempotency-Key header, the write runs once and
 * every retry with the same key gets the first response back (header idempotent-replayed: true).
 * Only a 5xx releases the key. A dropped connection does not: the handler keeps running and records its
 * response, and releasing early would let a retry run the write a second time. */
function idempotent(scope: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const key = req.header("idempotency-key");
    if (key === undefined) return next();
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      return res.status(400).json({ error: "Idempotency-Key must be 8-128 characters of letters, digits, . _ : or -" });
    }
    const orgId = req.orgId!;
    const agentId = req.agentId!;
    const begin = beginIdempotent(orgId, agentId, key, scope, requestHash(scope, { params: req.params, body: req.body ?? null }));
    if (begin.state === "conflict") return res.status(422).json({ error: "Idempotency-Key was already used for a different request" });
    if (begin.state === "in_progress") return res.status(409).json({ error: "a request with this Idempotency-Key is still running; retry shortly" });
    if (begin.state === "replay") {
      res.setHeader("idempotent-replayed", "true");
      return res.status(begin.status).type("application/json").send(begin.response);
    }
    const { claimedAt } = begin;
    let settled = false;
    const settle = (response: string) => {
      if (settled) return;
      settled = true;
      if (res.statusCode < 500) completeIdempotent(orgId, agentId, key, claimedAt, res.statusCode, response);
      else releaseIdempotent(orgId, agentId, key, claimedAt);
    };
    // res.json goes through res.send, so wrapping send records every body a route can produce.
    const send = res.send.bind(res);
    res.send = ((body?: unknown) => {
      settle(Buffer.isBuffer(body) ? body.toString("utf8") : typeof body === "string" ? body : JSON.stringify(body ?? null));
      return send(body);
    }) as typeof res.send;
    // A bare res.end() still completed the write: record the status (with an empty body) so a retry
    // replays instead of running the write again.
    res.on("finish", () => settle(""));
    next();
  };
}

/** registerAgent throws AgentNameError for a bad or duplicate name; anything else is a real failure. */
function createAgentOr4xx(res: Response, orgId: string, name: unknown, keyClass: KeyClass = "agent") {
  try {
    return registerAgent(orgId, typeof name === "string" ? name : "", { keyClass });
  } catch (err) {
    if (!(err instanceof AgentNameError)) throw err;
    res.status(err.status).json({ error: err.message });
    return null;
  }
}

// --- Org bootstrap (admin-facing, not agent-facing) -------------------------
// This has no real signup/billing flow yet — see docs/saas-mvp-status.md for
// the honest gap list. It's enough to create a real org + first agent by hand
// or via a script during the MVP phase.
/** Checks the admin token. With OPENCADRE_ADMIN_TOKEN set it's required; with
 * none set, `openInDevelopment` routes stay open outside production (the old
 * local behavior) and everything else is unavailable. */
function requireAdmin({ openInDevelopment }: { openInDevelopment: boolean }) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Trimmed: a token that is only whitespace is a misconfiguration, and must read as "not set", never as a set token.
    const adminToken = process.env.OPENCADRE_ADMIN_TOKEN?.trim();
    if (adminToken) {
      const given = Buffer.from(bearer(req) ?? "");
      const expected = Buffer.from(adminToken);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return res.status(401).json({ error: "invalid or missing admin token" });
      }
      return next();
    }
    if (openInDevelopment && process.env.NODE_ENV !== "production") return next();
    return res.status(503).json({ error: "admin routes are disabled: set OPENCADRE_ADMIN_TOKEN" });
  };
}

app.post("/v1/orgs", requireAdmin({ openInDevelopment: true }), (req, res) => {
  const name = req.body?.name;
  if (!name) return res.status(400).json({ error: "name is required" });
  const { orgId, bootstrapKey } = createOrganization(name);
  res.status(201).json({ orgId, bootstrapKey });
});

app.post("/v1/agents", (req, res) => {
  const org = authenticateOrgBootstrapKey(bearer(req));
  if (!org) return res.status(401).json({ error: "invalid or missing org bootstrap key" });
  // A paused workspace adds no agents: "nothing runs" includes provisioning.
  if (workspacePauseState(org.orgId).paused) return res.status(423).json({ error: PAUSED_ERROR });
  // Provisioning is a write, and this path carries no agent identity, so admitAgent never sees it.
  const billingRefused = readOnlyRefusal(org.orgId, "POST");
  if (billingRefused) return res.status(billingRefused.status).json(billingRefused.body);
  // ...and the PLAN's agent limit, the other refusal this route owes before it creates anything. Same
  // order as the read-only check above: both precede the write, so a refusal half-creates nothing.
  const limitRefused = agentLimitRefusal(org.orgId, publicAppUrl(req), "bootstrap");
  if (limitRefused) return res.status(limitRefused.status).json(limitRefused.body);
  const keyClass = req.body?.keyClass === "watcher" ? "watcher" : "agent";
  const created = createAgentOr4xx(res, org.orgId, req.body?.name, keyClass);
  if (!created) return;
  const { agentId, apiKey, urlKey } = created;
  res.status(201).json({ agentId, apiKey, urlKey, keyClass });
});

// Operators create and rotate keys from the console with their own agent key,
// so nobody needs the org bootstrap key or a database edit. Keys are returned once.
app.post("/v1/org/agents", requireAgentAuth, requirePermission("agents.create"), (req: AuthedRequest, res) => {
  // The same limit as the bootstrap route, and here it also covers a lapse, because admitAgent's
  // read-only refusal has already run for this agent-facing path (unlike the bootstrap one above).
  const limitRefused = agentLimitRefusal(req.orgId!, publicAppUrl(req), req.person ? "member" : "agent");
  if (limitRefused) return res.status(limitRefused.status).json(limitRefused.body);
  const created = createAgentOr4xx(res, req.orgId!, req.body?.name);
  if (!created) return;
  const { agentId, agentName, apiKey } = created;
  res.status(201).json({ agentId, agentName, apiKey });
});

app.post("/v1/org/agents/:agentId/rotate-key", requireAgentAuth, requirePermission("agents.rotateKey"), (req: AuthedRequest, res) => {
  const rotated = rotateAgentKey(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.agentId));
  if (!rotated) return res.status(404).json({ error: "agent not found" });
  const ownKey = rotated.agentId === req.agentId;
  res.json({
    ...rotated,
    ownKey,
    ...(ownKey ? { note: "This was your own key. The key this session used no longer works; switch to the new key." } : {}),
  });
});

// Retires an agent: its key stops working now and it leaves every roster; its history stays (removeAgent in src/service.ts).
app.delete("/v1/org/agents/:agentId", requireAgentAuth, requirePermission("agents.delete"), (req: AuthedRequest, res) => {
  const removed = removeAgent(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.agentId));
  if (!removed.ok) return res.status(removed.status).json({ error: removed.error });
  res.json({ ok: true, agentId: removed.agentId, agentName: removed.agentName });
});

// A person sets an agent's wake webhook (the agent's own is POST /v1/webhook), so an app that can't see its trigger's
// key (a Grok Bot routine) never handles it. Both are write-only: the header, as on /v1/me, and the URL too, whose path
// or query can carry a token, so only its host and whether each is set come back. Which agents a caller may point
// where is wakeTarget in src/service.ts; another workspace's agent reads exactly like an unknown id.
const wakeBody = (hook: { webhook_host: string | null; webhook_url_set: boolean; webhook_auth_set: boolean; last_wake: LastWake }) =>
  ({ webhook_host: hook.webhook_host, webhook_url_set: hook.webhook_url_set, webhook_auth_set: hook.webhook_auth_set, last_wake: hook.last_wake });
const callerIsOwner = (req: AuthedRequest) => roleFor(req.agentRole, req.person ? req.memberRole ?? null : null) === "owner";

app.get("/v1/org/agents/:agentId/webhook", requireAgentAuth, requirePermission("agents.webhook"), (req: AuthedRequest, res) => {
  const hook = getOrgAgentWebhook(req.orgId!, String(req.params.agentId), callerIsOwner(req));
  if (!hook.ok) return res.status(hook.status).json({ error: hook.error });
  res.json(wakeBody(hook));
});

app.put("/v1/org/agents/:agentId/webhook", requireAgentAuth, requirePermission("agents.webhook"), async (req: AuthedRequest, res) => {
  const { url, authHeader } = req.body ?? {};
  if (url !== undefined && url !== null && typeof url !== "string") {
    return res.status(400).json({ error: "url must be a string, or null to clear the webhook, or omitted to keep it" });
  }
  if (authHeader !== undefined && authHeader !== null && typeof authHeader !== "string") {
    return res.status(400).json({ error: "authHeader must be a string or null" });
  }
  if (typeof authHeader === "string") {
    const check = validateWebhookAuthHeader(authHeader);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  if (typeof url === "string") {
    const check = validateWebhookUrl(url);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  // An omitted url keeps the stored one; an omitted header keeps the stored one only while the address doesn't change
  // (setOrgAgentWebhook); null or "" clears it.
  const set = setOrgAgentWebhook(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.agentId), callerIsOwner(req), url, authHeader);
  if (!set.ok) return res.status(set.status).json({ error: set.error });
  // Someone else changed it, so tell the agent, from the caller's agent (a person's member agent, or an operator key),
  // naming the host only. Low priority on purpose: low is the one priority that never fires the webhook
  // (notifyWebhookBestEffort), so the notice can't POST the address just saved before anyone asked it to; it still lands
  // in the inbox and the awareness digest. Best effort: the setting is already saved, so a notice that can't be sent (an
  // ended session) doesn't fail the request. A re-PUT that changed nothing says nothing.
  if (set.changed && set.agentId !== req.agentId) {
    const who = req.person ? displayName(req.person) : req.agentName!;
    const notice = set.webhook_url_set ? `${who} set your wake webhook to ${set.webhook_host}.` : `${who} cleared your wake webhook.`;
    try {
      await sendMessage(req.orgId!, { id: req.agentId!, name: req.agentName! }, set.agentId, notice, "low", null, { skipDuplicateCheck: true });
    } catch (err) {
      log.warn("wake webhook notice not sent", { agentId: set.agentId, error: err });
    }
  }
  res.json({ ok: true, ...wakeBody(set) });
});

// One wake POST on request, to check the address and header (sendTestWake). Limited per agent and per workspace, since
// each one reaches a third party's endpoint (a Grok routine allows 200 runs an hour), and a workspace with many agents
// must not turn the button into a way to flood them.
const testWakeLimiter = createRateLimiter({ limit: 6, windowMs: 60_000 });
const workspaceTestWakeLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
app.post("/v1/org/agents/:agentId/webhook/test", requireAgentAuth, requirePermission("agents.webhook"), async (req: AuthedRequest, res) => {
  const agentId = String(req.params.agentId);
  // The target rules first, so another workspace can't spend this agent's budget, then the budget.
  const target = getOrgAgentWebhook(req.orgId!, agentId, callerIsOwner(req));
  if (!target.ok) return res.status(target.status).json({ error: target.error });
  const limited = testWakeLimiter.check(`agent:${agentId}`);
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfterSeconds));
    return res.status(429).json({ error: "At most 6 test wakes a minute for one agent. Wait a moment and try again." });
  }
  const workspaceLimited = workspaceTestWakeLimiter.check(`org:${req.orgId}`);
  if (!workspaceLimited.ok) {
    res.setHeader("Retry-After", String(workspaceLimited.retryAfterSeconds));
    return res.status(429).json({ error: "At most 20 test wakes a minute for one workspace. Wait a moment and try again." });
  }
  const sent = await sendTestWake(req.orgId!, agentId, callerIsOwner(req));
  if (!sent.ok) return res.status(sent.status).json({ error: sent.error });
  res.json({ ok: true, ...wakeBody(sent) });
});

// --- People: sign-in, workspaces, members, invites (docs/design/ACCOUNTS.md) -----------
const publicAppUrl = (req: Request) =>
  (process.env.OPENCADRE_PUBLIC_APP_URL || (process.env.NODE_ENV === "production" ? "https://app.opencadre.example" : `${req.protocol}://${req.get("host")}`)).replace(/\/+$/, "");
const PKCE_COOKIE = "oc_pkce";
// Only a path inside the console, or the MCP connector's consent page (a signed-out person comes back to it after
// sign-in, src/rest.ts GET /oauth/authorize): never an absolute URL, protocol-relative URL, backslash trick, or ".."
// that resolves elsewhere (no open redirect). The browser resolves the Location header the same way new URL does here.
function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || !(raw.startsWith("/app") || raw.startsWith("/oauth/authorize?")) || raw.startsWith("//") || raw.includes("\\")) return "/app/";
  try {
    const resolved = new URL(raw, "https://console.invalid");
    const inConsole = resolved.pathname === "/app" || resolved.pathname.startsWith("/app/");
    if (resolved.host !== "console.invalid" || !(inConsole || resolved.pathname === "/oauth/authorize")) return "/app/";
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return "/app/";
  }
}
const emailLimiter = createRateLimiter({ limit: Number(process.env.OPENCADRE_EMAIL_SIGNIN_PER_HOUR) || 5, windowMs: 3_600_000 });
const authUnavailable = (res: Response) => res.status(503).json({ error: "Sign-in isn't configured on this hub yet." });

function beginSignIn(req: Request, res: Response) {
  const { verifier, challenge } = newPkce();
  // Ties the callback to this browser: a code stolen or replayed elsewhere has no verifier to redeem it with.
  setCookie(req, res, PKCE_COOKIE, `${verifier}.${Buffer.from(safeNext(req.query.next ?? req.body?.next)).toString("base64url")}`, { maxAgeSeconds: 600, path: "/v1/auth" });
  return { challenge, redirectTo: `${publicAppUrl(req)}/v1/auth/callback` };
}

let methodsCache: { at: number; value: Awaited<ReturnType<typeof enabledMethods>> } | null = null;
/** For tests only: drops the cached method list so the provider-unreachable branch is reachable. The
 * cache is a 5-minute success memo, so a test that makes the provider fail would otherwise be served a
 * stale success and silently not exercise the branch it claims to. Follows `resetJwksCache`
 * (src/supabase-auth.ts) -- same shape, same reason. */
export function resetMethodsCache(): void {
  methodsCache = null;
  methodsInFlight = null;
}
/** One provider read at a time: every caller that finds the cache stale while a read is out shares that read, so an
 * outage costs one timed-out request per expiry, not one per page view. */
let methodsInFlight: Promise<Awaited<ReturnType<typeof enabledMethods>>> | null = null;
function refreshMethods(cfg: NonNullable<ReturnType<typeof supabaseAuthConfig>>) {
  if (!methodsInFlight) {
    const read = enabledMethods(cfg)
      .then((value) => { methodsCache = { at: Date.now(), value }; return value; })
      .finally(() => { if (methodsInFlight === read) methodsInFlight = null; });
    read.catch(() => {}); // a caller that stopped waiting (the site's bound) must not leave an unhandled rejection
    methodsInFlight = read;
  }
  return methodsInFlight;
}
// `signup` rides this call rather than getting its own endpoint because the reader is the marketing
// page, showing available sign-in methods before anyone has signed
// in -- so it has to be the hub's answer, not the default baked into a static page. It is deliberately
// independent of `methods`: `signup: "open"` with every method off still admits nobody, and
// `enabled: false` with `signup: "open"` is a hub with no sign-in configured. Callers branch on both.
// `signup: "closed"` is the operator's kill switch (`OPENCADRE_SIGNUP=closed`, src/accounts.ts
// `signupMode`); both readers treat anything but "open" as not-open, so neither needed a change for it.
app.get("/v1/auth/config", async (_req, res) => {
  res.json(await authConfigAnswer());
});
/** The answer /v1/auth/config gives, also what the site's first paint is rendered from (the "/" route below). `waitMs`
 * bounds how long a caller waits on the provider when the cache is stale: past it, the methods are unknown (all false),
 * exactly as when the provider fails, while the shared read carries on and fills the cache for the next request. */
async function authConfigAnswer(waitMs?: number): Promise<{ enabled: boolean; methods: { github: boolean; google: boolean; email: boolean }; signup: string }> {
  const cfg = supabaseAuthConfig();
  if (!cfg) return { enabled: false, methods: { github: false, google: false, email: false }, signup: signupMode() };
  try {
    if (!methodsCache || Date.now() - methodsCache.at > 300_000) {
      const read = refreshMethods(cfg);
      if (waitMs === undefined) await read;
      else {
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("provider slow")), waitMs); });
        try { await Promise.race([read, late]); } finally { clearTimeout(timer); }
      }
    }
    return { enabled: true, methods: methodsCache!.value, signup: signupMode() };
  } catch {
    // The provider could not be reached, so we do NOT know which methods are on. This branch used to
    // claim all three true plus an `unverified` marker, and nothing ever read the marker -- the console
    // renders a button per true method, so a transient provider failure showed GitHub, Google and email
    // as available on no evidence. That is the page over-promising sign-in, on the sprint's first
    // screen. The console already HAS an honest degraded state ("Couldn't check sign-in options") but
    // reaches it only on a THROWN error, and a 200 is never one -- so the server's fabricated answer was
    // suppressing the client's truthful one.
    //
    // Answer with what we know, which is nothing. 200 and `enabled: true` are both right: the hub is up
    // and sign-in IS configured, and agent-key sign-in still works underneath; `methods` is the part we
    // cannot vouch for.
    return { enabled: true, methods: { github: false, google: false, email: false }, signup: signupMode() };
  }
}

app.get("/v1/auth/start", (req, res) => {
  const cfg = supabaseAuthConfig();
  if (!cfg) return authUnavailable(res);
  const provider = OAUTH_PROVIDERS.find((p) => p === req.query.provider) as OAuthProvider | undefined;
  if (!provider) return res.status(400).json({ error: `provider must be one of ${OAUTH_PROVIDERS.join(", ")}` });
  const { challenge, redirectTo } = beginSignIn(req, res);
  res.redirect(302, authorizeUrl(cfg, provider, redirectTo, challenge));
});

app.post("/v1/auth/email", async (req, res) => {
  const cfg = supabaseAuthConfig();
  if (!cfg) return authUnavailable(res);
  if (!req.is("application/json")) return res.status(415).json({ error: "Send JSON (content-type: application/json)." });
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
  for (const key of [`ip:${req.ip}`, `email:${email}`]) {
    const limited = emailLimiter.check(key);
    if (!limited.ok) {
      res.setHeader("Retry-After", String(limited.retryAfterSeconds));
      return res.status(429).json({ error: "Too many sign-in emails. Wait a while, then try again." });
    }
  }
  const { challenge, redirectTo } = beginSignIn(req, res);
  try {
    await sendMagicLink(cfg, email, redirectTo, challenge);
    res.json({ ok: true, message: `Check ${email} for a sign-in link. It works once, in this browser.` });
  } catch (err) {
    log.warn("magic link failed", { error: (err as Error).message });
    res.status(502).json({ error: "Couldn't send the sign-in email. Try again in a minute." });
  }
});

app.get("/v1/auth/callback", async (req, res) => {
  const cfg = supabaseAuthConfig();
  if (!cfg) return authUnavailable(res);
  const fail = (message: string) => res.redirect(302, `/app/?auth_error=${encodeURIComponent(message)}`);
  const pkce = readCookie(req, PKCE_COOKIE);
  setCookie(req, res, PKCE_COOKIE, "", { maxAgeSeconds: 0, path: "/v1/auth" });
  if (typeof req.query.error_description === "string" || typeof req.query.error === "string") {
    return fail(String(req.query.error_description || req.query.error));
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const [verifier, nextB64] = (pkce ?? "").split(".");
  if (!code || !verifier) return fail("That sign-in link expired or was opened in a different browser. Start again.");
  try {
    const identity = await exchangeCode(cfg, code, verifier);
    const person = upsertPerson(identity);
    const { token } = createSession(person.id);
    startPersonSession(req, res, token);
    res.redirect(302, safeNext(nextB64 ? Buffer.from(nextB64, "base64url").toString("utf8") : undefined));
  } catch (err) {
    log.warn("sign-in callback failed", { error: (err as Error).message });
    fail("Sign-in didn't complete. Start again.");
  }
});

// --- Local sign-in: a hub with no sign-in provider (src/local-sign-in.ts) -----------------------------------------
// The hub's admin mints a one-time link for an address; opening it signs that browser in as that person. Refused while
// a sign-in provider is configured, so a hub that verifies people never mints a session for an unproven address.
// `openInDevelopment: false`: unlike creating an organization, this is never open without the admin token.
const LOCAL_SIGN_IN_REFUSED = "This hub signs people in through its sign-in provider, so local sign-in links are off.";
app.post("/v1/admin/sign-in-links", requireAdmin({ openInDevelopment: false }), (req, res) => {
  if (supabaseAuthConfig()) return res.status(409).json({ error: LOCAL_SIGN_IN_REFUSED });
  const issued = issueLocalTicket({ email: req.body?.email, name: req.body?.name });
  if (!issued.ok) return res.status(issued.status).json({ error: issued.error });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ url: `${publicAppUrl(req)}/v1/auth/local?ticket=${issued.ticket}`, expiresAt: issued.expiresAt });
});

// Spends the ticket and starts the session exactly as the provider callback does (upsertPerson, createSession,
// startPersonSession). Every failure is the same redirect with the same message: it never says whether a ticket
// existed, was used or expired.
app.get("/v1/auth/local", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const fail = () => res.redirect(302, `/app/?auth_error=${encodeURIComponent("That sign-in link is no longer valid. Ask for a new one.")}`);
  if (supabaseAuthConfig()) return fail();
  const identity = consumeLocalTicket(req.query.ticket);
  if (!identity) return fail();
  const person = upsertPerson(identity);
  const { token } = createSession(person.id);
  startPersonSession(req, res, token);
  res.redirect(302, "/app/");
});

app.post("/v1/auth/signout", (req, res) => {
  deleteSession(readCookie(req, SESSION_COOKIE));
  endPersonSession(req, res);
  res.json({ ok: true });
});

app.get("/v1/auth/me", requirePerson, (req: AuthedRequest, res) => {
  // The console reads this on every load, so it is where the hint follows a sliding session (sessionPerson extends a
  // used session) instead of lapsing 30 days after sign-in while the person is still signed in.
  res.json({ person: publicPerson(req.person!), workspaces: listWorkspaces(req.person!.id), canCreateWorkspace: canCreateWorkspace(req.person!) });
});

// --- Phone notifications (Web Push, src/push.ts) ------------------------------------
// A device belongs to the signed-in person, not to a workspace: one phone hears about every workspace they decide in.
app.get("/v1/push/config", (_req, res) => {
  res.json(pushConfig());
});

app.get("/v1/push/devices", requirePerson, (req: AuthedRequest, res) => {
  res.json({ ...pushConfig(), devices: listDevices(req.person!.id) });
});

app.post("/v1/push/devices", requirePerson, (req: AuthedRequest, res) => {
  if (!pushConfig().enabled) return res.status(503).json({ error: "Phone notifications aren't set up on this hub yet." });
  const saved = saveSubscription(req.person!.id, req.body ?? {});
  if (!saved.ok) return res.status(400).json({ error: saved.error });
  res.status(201).json({ id: saved.id });
});

app.delete("/v1/push/devices", requirePerson, (req: AuthedRequest, res) => {
  if (!deleteSubscription(req.person!.id, req.body?.endpoint)) return res.status(404).json({ error: "No such device." });
  res.status(204).end();
});

const pushTestLimiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
app.post("/v1/push/test", requirePerson, async (req: AuthedRequest, res) => {
  if (!pushConfig().enabled) return res.status(503).json({ error: "Phone notifications aren't set up on this hub yet." });
  const limited = pushTestLimiter.check(`person:${req.person!.id}`);
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfterSeconds));
    return res.status(429).json({ error: "Wait a minute before sending another test." });
  }
  const outcome = await pushToPeople([req.person!.id], {
    type: "test", title: "OpenCadre notifications are on", body: "Clearance requests will show up here.", url: "/app/", tag: "opencadre-test",
  });
  res.json(outcome);
});

/** Serializes an AccountError. `code` (and `details`, e.g. WORKSPACE_PENDING's waiting workspace) are spread in only
 * when present, so every existing error keeps its exact current body -- the additions are additive and the wire shape
 * for old errors is byte-identical (docs/design/SELF-SERVE-BACKEND.md §5.1). */
const accountError = (res: Response, err: unknown) => {
  if (err instanceof AccountError) return res.status(err.status).json({ ...(err.details ?? {}), error: err.message, ...(err.code ? { code: err.code } : {}) });
  throw err;
};

// Self-serve workspace creation mints a credential, so it is rate-limited per person and per network
// (docs/design/SELF-SERVE-BACKEND.md §6.2). Previously unlimited; that was fine while an operator
// approved every signup by hand and is not fine once anyone can sign up.
//
// OFF outside production, following the pattern `requireAdmin` already uses (NODE_ENV !== "production").
// A per-network cap makes no sense for a test run or a local hub, where every caller shares 127.0.0.1
// and a suite legitimately creates many workspaces. Setting OPENCADRE_WORKSPACE_RATE_LIMIT=1 (or any
// non-zero value) forces it on locally, so the limit itself stays testable.
const workspaceRateLimitOn = () => process.env.NODE_ENV === "production" || Boolean(process.env.OPENCADRE_WORKSPACE_RATE_LIMIT);
const workspaceCreateLimiter = createRateLimiter({ limit: Number(process.env.OPENCADRE_WORKSPACE_CREATE_PER_HOUR) || 5, windowMs: 3_600_000 });
const workspaceCreateIpLimiter = createRateLimiter({ limit: Number(process.env.OPENCADRE_WORKSPACE_CREATE_PER_IP_PER_HOUR) || 10, windowMs: 3_600_000 });

app.post("/v1/workspaces", requirePerson, (req: AuthedRequest, res) => {
  if (workspaceRateLimitOn()) {
    for (const [limiter, key] of [[workspaceCreateLimiter, `person:${req.person!.id}`], [workspaceCreateIpLimiter, `ip:${req.ip}`]] as const) {
      const limited = limiter.check(key);
      if (!limited.ok) {
        res.setHeader("Retry-After", String(limited.retryAfterSeconds));
        return res.status(429).json({ error: "Too many workspaces created from here. Try again later.", retryAfterSeconds: limited.retryAfterSeconds });
      }
    }
  }
  try {
    // The inbox-proof requirement for open self-serve lives HERE, at the HTTP boundary, not in
    // createWorkspace: it is about what this browser proved, not about the workspace entitlement, and
    // internal callers that build a Person directly must not be gated by it (0283's review of #324 --
    // putting it in the domain function skipped a 90-test suite).
    const unverified = unverifiedEmailRefusal(req.person!);
    if (unverified) return res.status(403).json({ error: unverified.message, code: unverified.code });
    // `agent` is a TOP-LEVEL sibling of `workspace`, not nested inside it, so the console can branch on
    // its presence to know whether a key was minted. On an idempotent retry it is absent and this body is
    // byte-identical to what the route returned before.
    const { agent, ...workspace } = createWorkspace(req.person!, req.body?.name);
    // A re-submit returns the existing workspace and must not welcome anyone twice (the ledger would refuse anyway).
    res.status(201).json({ workspace, ...(agent ? { agent } : {}) });
  } catch (err) {
    accountError(res, err);
  }
});

app.get("/v1/workspaces/:orgId/members", requireAgentAuth, requireWorkspaceMatch, requirePermission("members.list"), (req: AuthedRequest, res) => {
  res.json(listMembers(req.orgId!));
});

/** Only a signed-in person adds people. Every member can decide clearances (src/approvals.ts), so an invite an agent or
 * Operator key could create -- email-less, accepted by any account -- would let a key mint the person that approves its
 * own fleet's risky commands. This ends the Operator-key claim path ACCOUNTS.md described "during the transition". */
function requirePersonToInvite(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.person) {
    return res.status(403).json({ error: "Only a signed-in person can invite people, in OpenCadre. An agent or Operator key can't add people to a workspace." });
  }
  next();
}

app.post("/v1/workspaces/:orgId/invites", requireAgentAuth, requireWorkspaceMatch, requirePersonToInvite, requirePermission("members.invite"), (req: AuthedRequest, res) => {
  const role = req.body?.role ?? "member";
  if (!isMemberRole(role)) return res.status(400).json({ error: 'role must be "owner", "admin" or "member"' });
  if (role === "owner" && req.memberRole === "admin") return res.status(403).json({ error: "Only an owner can invite another owner." });
  try {
    const invite = createInvite(req.orgId!, { id: req.agentId!, name: req.agentName! }, role, req.body?.email);
    res.status(201).json({ id: invite.id, role: invite.role, email: invite.email, expiresAt: invite.expiresAt, url: `${publicAppUrl(req)}/app/?invite=${invite.token}` });
  } catch (err) {
    accountError(res, err);
  }
});

app.delete("/v1/workspaces/:orgId/invites/:inviteId", requireAgentAuth, requireWorkspaceMatch, requirePermission("members.inviteRevoke"), (req: AuthedRequest, res) => {
  if (!revokeInvite(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.inviteId))) {
    return res.status(404).json({ error: "No open invite with that id." });
  }
  res.json({ ok: true });
});

app.patch("/v1/workspaces/:orgId/members/:personId", requireAgentAuth, requireWorkspaceMatch, requirePermission("members.changeRole"), (req: AuthedRequest, res) => {
  if (!isMemberRole(req.body?.role)) return res.status(400).json({ error: 'role must be "owner", "admin" or "member"' });
  try {
    changeRole(req.orgId!, { id: req.agentId!, name: req.agentName!, memberRole: req.memberRole ?? null }, String(req.params.personId), req.body.role);
    res.json(listMembers(req.orgId!));
  } catch (err) {
    accountError(res, err);
  }
});

// Owners and admins remove others; anyone can leave (remove themselves).
app.delete("/v1/workspaces/:orgId/members/:personId", requireAgentAuth, (req: AuthedRequest, res, next) => {
  if (req.person && String(req.params.personId) === req.person.id && String(req.params.orgId) === req.orgId) return next();
  requireWorkspaceMatch(req, res, () => requirePermission("members.remove")(req, res, next));
}, (req: AuthedRequest, res) => {
  try {
    removeMember(req.orgId!, { id: req.agentId!, name: req.agentName!, memberRole: req.memberRole ?? null, personId: req.person?.id ?? null }, String(req.params.personId));
    res.json({ ok: true });
  } catch (err) {
    accountError(res, err);
  }
});

app.get("/v1/invites/:token", (req, res) => {
  res.json(describeInvite(String(req.params.token)));
});

app.post("/v1/invites/:token/accept", requirePerson, (req: AuthedRequest, res) => {
  try {
    const workspace = acceptInvite(String(req.params.token), req.person!);
    res.json({ workspace });
  } catch (err) {
    accountError(res, err);
  }
});

// --- Workspace kill switch (R3) ------------------------------------------------
// Pausing refuses every non-operator key and cuts their connections; resuming restores the same keys.
// Owner-only (permissions.ts: org.pause/org.resume require "owner"): stopping every agent in the
// workspace at once is the single most destructive action here, reserved for the top trust tier.
app.post("/v1/org/pause", requireAgentAuth, requirePermission("org.pause"), (req: AuthedRequest, res) => {
  res.json(pauseWorkspace(req.orgId!, { id: req.agentId!, name: req.agentName! }));
});

app.post("/v1/org/resume", requireAgentAuth, requirePermission("org.resume"), (req: AuthedRequest, res) => {
  res.json(resumeWorkspace(req.orgId!, { id: req.agentId!, name: req.agentName! }));
});

// --- Billing -------------------------------------------------------------------------------------------------------
// This hub has no payment provider. Plans and limits are still enforced from the plans table (src/billing.ts), and a
// self-hosted workspace starts on the non-expiring plan unless OPENCADRE_BILLING=on. The console asks this route whether
// it can offer a checkout; the answer here is always no.
app.get("/v1/billing/client-config", (_req, res) => {
  res.json({ available: false });
});

// --- Usage metering (Stage 3 retro finding) -- admin-tier (permissions.ts: orgUsage.read),
// same trust tier as the other org-operational reports (devices, sessions, projects) above.
app.get("/v1/org/usage", requireAgentAuth, requirePermission("orgUsage.read"), (req: AuthedRequest, res) => {
  const sinceDays = req.query.sinceDays === undefined ? undefined : Number(req.query.sinceDays);
  try {
    res.json({ usage: getOrgUsageSummary(req.orgId!, { sinceDays }) });
  } catch (err) {
    if (!(err instanceof OrgUsageInputError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

// --- Connect codes: console -> one command -> connected agent -----------------
// The console runs on app.opencadre.example, but agents talk to the hub host, so the
// command names the public hub explicitly instead of trusting the request's host. One definition (src/cli-package.ts),
// shared with the awareness digest's connector item, which prints the same stamped command.

// --- MCP connector: protected resource metadata (RFC 9728; docs/design/MCP-CONNECTOR.md) --------------------------------
// Served at the path-suffixed form clients try first and at the root form, only while OPENCADRE_OAUTH=on.
for (const path of [PROTECTED_RESOURCE_PATH, "/.well-known/oauth-protected-resource"]) {
  app.get(path, (_req, res) => {
    if (!oauthEnabled()) return res.status(404).json({ error: "not found" });
    res.set("cache-control", "public, max-age=300").json(protectedResourceMetadata());
  });
}
// RFC 8414 authorization server metadata (plan §3), dormant the same way.
app.get(AUTHORIZATION_SERVER_METADATA_PATH, (_req, res) => {
  if (!oauthEnabled()) return res.status(404).json({ error: "not found" });
  res.set("cache-control", "public, max-age=300").json(authorizationServerMetadata());
});
// Dynamic client registration (RFC 7591; design §3/§4, plan §3). Unauthenticated by nature, so it is throttled per
// network (design §4): each registration is a stored row. The default leaves room for a cloud client whose users share
// a few egress addresses; CIMD clients never come here. IPv6 is counted per /64 (oauthIpKey).
const oauthRegisterLimiter = createRateLimiter({ limit: Number(process.env.OPENCADRE_OAUTH_REGISTER_PER_MIN) || 20, windowMs: 60_000 });
app.post("/oauth/register", (req, res) => {
  if (!oauthEnabled()) return res.status(404).json({ error: "not found" });
  const limited = oauthRegisterLimiter.check(oauthIpKey(req.ip));
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfterSeconds));
    res.set("cache-control", "no-store");
    return res.status(429).json({ error: "rate_limited", error_description: "Too many registrations from this network. Try again in a minute." });
  }
  const result = registerDynamicClient(req.body);
  res.set("cache-control", "no-store");
  if (!result.ok) return res.status(400).json({ error: result.error, error_description: result.error_description });
  res.status(201).json(result.client);
});
// A body the JSON parser refused (malformed, or over its 10 MB limit) never reaches the route; RFC 7591 §3.2.2 still
// wants its error shape, not an HTML page.
const REFUSED_BODY: Record<string, string> = {
  "entity.parse.failed": "the registration body is not valid JSON",
  "entity.too.large": "the registration body is too large",
};
app.use("/oauth/register", (err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const reason = REFUSED_BODY[(err as { type?: string })?.type ?? ""];
  if (!reason || !oauthEnabled()) return next(err);
  res.set("cache-control", "no-store").status(400).json({ error: "invalid_client_metadata", error_description: reason });
});

// --- MCP connector: authorize and consent (docs/design/MCP-CONNECTOR.md §3/§4; plan 2026-09-29 §3 and §7) --------------
// GET validates the request (src/oauth-authorize.ts checkAuthorizeRequest), sends a signed-out person through the
// console's sign-in and back to this exact URL (safeNext), then stores a single-use consent and shows the page. POST
// takes ONLY the consent id, the CSRF token and the person's choices; everything else comes from the stored consent.
// Both are throttled per network (design §4), counted together.
const oauthAuthorizeLimiter = createRateLimiter({ limit: Number(process.env.OPENCADRE_OAUTH_AUTHORIZE_PER_MIN) || 30, windowMs: 60_000 });
/** The console's inline SVG sprite and its preconnect and stylesheet <link> tags, taken from the page the console
 * itself serves (versionedConsoleIndex: versioned, in order), so the consent page cannot drift from the console's
 * styles: since the design tokens (#648) the console's colours resolve through /shared/tokens.css, loaded first. */
function consoleChromeParts(): { sprite: string; styleLinks: string } {
  const index = versionedConsoleIndex();
  return {
    sprite: index.match(/<svg class="oc-sprite"[\s\S]*?<\/defs><\/svg>/)?.[0] ?? "",
    styleLinks: (index.match(/<link rel="(?:preconnect|stylesheet)"[^>]*>/g) ?? []).join("\n  "),
  };
}
const consentChrome = (): PageChrome => consoleChromeParts();
/** The console's strict CSP (frame-ancestors 'none' included),
 * with one change: form-action 'self', since the consent form posts to this origin.
 * Every answer to that form stays on this origin too: a re-drawn page, the page approve or deny returns (returnToClient),
 * or "Use another account"'s 302 to /app/. The answer used to be a 302 to the client, which Chrome holds, hop by hop, to
 * form-action; Cursor's callback bounces www.cursor.com -> cursor.com -> loopback, so form-action had to allow any https
 * origin (2026-10-30, a60f59ab). The return page's meta refresh is not a form submission, so 'self' is enough again. */
function sendOauthPage(res: Response, status: number, html: string) {
  res.setHeader("Content-Security-Policy", CONSOLE_CSP_STRICT.replace("form-action 'none'", "form-action 'self'"));
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.status(status).type("html").send(html);
}
const oauthErrorPage = (res: Response, status: number, message: string, returnTo?: { href: string; host: string }) =>
  sendOauthPage(res, status, renderOauthErrorPage(consentChrome(), message, returnTo));
/** What the return page reads besides the URL: the connection's names and the console's chrome. A seam for tests only. */
export const oauthReturnHooks = { names: grantNames, chrome: consentChrome };
/** The answer to an approve or a deny: a 200 page on this origin that returns the browser to the client, by meta refresh
 * and by link (onboarding slice 3). The URL is built only from the stored consent's redirect, checked again against the
 * client's registration just before (redirectStillRegistered), with the code or error appended; never from the request.
 * no-store and no-referrer (sendOauthPage), as the code is in the URL.
 *
 * The redirect must still be one acceptableRedirectUri admits, or the person gets an error page and goes nowhere (security
 * review L2). Past that check the consent is already spent, so nothing optional may strand the person (L1): names that
 * can't be read leave the page saying "Connected."; chrome that can't be built gives the page without it; and if even
 * that fails, a plain 302 to the same URL. The log names the step and the error's type only, never the URL or code. */
export function returnToClient(res: Response, redirectUri: string, params: Record<string, string | undefined>, connected: boolean, grantId?: string) {
  const href = returnHref(redirectUri, params);
  if (!href) return oauthErrorPage(res, 400, "This app's return address isn't valid. Start again from the app.");
  let names: { agentName: string; scopeName: string } | null = null;
  if (grantId) {
    try {
      names = oauthReturnHooks.names(grantId);
    } catch (err) {
      log.warn("oauth return page: connection names unavailable", { error: (err as Error)?.name });
    }
  }
  let html: string;
  try {
    html = renderReturnPage(oauthReturnHooks.chrome(), { href, host: new URL(href).hostname, connected, names });
  } catch (err) {
    log.warn("oauth return page: drawn without the console chrome", { error: (err as Error)?.name });
    try {
      html = renderReturnPage({ styleLinks: "", sprite: "" }, { href, host: new URL(href).hostname, connected, names: null });
    } catch {
      return oauthRedirect(res, href);
    }
  }
  return sendOauthPage(res, 200, html);
}
/** Every 302 on the way to or back from a client: never cached, and never telling the next page where the person came
 * from (the authorize URL carries the client's state; security review N4). */
function oauthRedirect(res: Response, location: string) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  return res.redirect(302, location);
}
const CONSENT_PROBLEM_STATUS: Record<ConsentProblem, number> = { unknown: 400, used: 409, expired: 410 };
const APPROVE_REFUSAL_STATUS: Record<string, number> = {
  not_allowed: 403, project_required: 400, invalid_project: 400, invalid_name: 400, plan_limit: 402, project_limit: 402,
};
/** The field a refusal is about, marked invalid on the page (onboarding slice 2). */
const APPROVE_REFUSAL_FIELD: Record<string, "project" | "name"> = {
  project_required: "project", invalid_project: "project", project_limit: "project", invalid_name: "name",
};

function renderConsent(res: Response, status: number, input: {
  consentId: string; sessionToken: string; person: Person; clientName: string; redirectUri: string;
  selectedOrgId?: string | null; chooseWorkspace?: boolean; projectKey?: string | null; newProjectName?: string; connectionName?: string;
  error?: string; errorField?: "project" | "name";
}) {
  const redirect = new URL(input.redirectUri);
  const workspaces = eligibleWorkspaces(input.person.id);
  // Two or more workspaces: the workspace comes first, on its own step, until one of them is chosen (onboarding slice 2).
  const selected = workspaces.length === 1 ? workspaces[0] : input.chooseWorkspace ? undefined : workspaces.find((w) => w.orgId === input.selectedOrgId);
  const posted = selected?.projects.find((p) => p.key === input.projectKey)?.key;
  sendOauthPage(res, status, renderConsentPage(consentChrome(), {
    consentId: input.consentId,
    csrf: consentCsrf(input.sessionToken, input.consentId),
    clientName: input.clientName,
    redirectHost: redirect.hostname,
    personLabel: input.person.email || displayName(input.person),
    workspaces,
    // The first step preselects a workspace too: the one chosen before, else the one used most recently (U10).
    selectedOrgId: selected?.orgId ?? input.selectedOrgId ?? defaultWorkspaceId(workspaces),
    chooseWorkspace: !selected,
    projectKey: selected ? posted ?? defaultProjectKey(selected) : null,
    newProjectName: input.newProjectName ?? (selected?.isolated && selected.projects.length === 0 ? defaultNewProjectName(selected.orgId, selected.name) : ""),
    connectionName: input.connectionName?.trim() || (selected ? freeConnectionName(selected.orgId, input.clientName) : ""),
    error: input.error,
    errorField: input.errorField,
  }));
}

/** The page for a consent that can't be answered. A used one that made a connection still live says so, by name. */
function consentProblemPage(res: Response, problem: ConsentProblem, consentId: string, personId: string, message = CONSENT_PROBLEM_MESSAGE[problem]) {
  const made = problem === "used" ? answeredConsent(consentId, personId) : null;
  if (made) return sendOauthPage(res, CONSENT_PROBLEM_STATUS.used, renderAlreadyConnectedPage(consentChrome(), made));
  return oauthErrorPage(res, CONSENT_PROBLEM_STATUS[problem], message);
}

/** Throttles an authorize request; false when it answered with a 429 page. */
function authorizeAllowed(req: Request, res: Response): boolean {
  const limited = oauthAuthorizeLimiter.check(oauthIpKey(req.ip));
  if (limited.ok) return true;
  res.setHeader("Retry-After", String(limited.retryAfterSeconds));
  oauthErrorPage(res, 429, "Too many sign-in requests from this network. Try again in a minute.");
  return false;
}

app.get("/oauth/authorize", async (req, res) => {
  if (!oauthEnabled()) return res.status(404).json({ error: "not found" });
  // The consent page must be on the console's host, where the session cookie is (src/oauth.ts oauthConsentOrigin).
  const consentOrigin = oauthConsentOrigin();
  if ((process.env.OPENCADRE_PUBLIC_APP_URL || process.env.NODE_ENV === "production") && new URL(consentOrigin).host !== req.get("host")) {
    return oauthRedirect(res, `${consentOrigin}${req.originalUrl}`);
  }
  if (!authorizeAllowed(req, res)) return;
  const checked = await checkAuthorizeRequest(req.query as Record<string, unknown>, oauthIpKey(req.ip), mcpResource());
  if (checked.kind === "page") return oauthErrorPage(res, checked.status, checked.message);
  const sessionToken = readCookie(req, SESSION_COOKIE);
  const person = sessionPerson(sessionToken);
  if (checked.kind === "redirect") {
    const back = redirectWithParams(checked.redirectUri, { error: checked.error, error_description: checked.description, state: checked.state, iss: oauthIssuer() });
    // Registration is open, so anyone can register a redirect: an error goes straight back only to a client the
    // signed-in person has already approved. Anyone else gets a page and a link they must click (security review S1),
    // so the hub is never a one-hop redirect to wherever a stranger registered.
    if (person && hasActiveGrant(person.id, checked.clientId)) return oauthRedirect(res, back);
    return oauthErrorPage(res, 400, `This app's sign-in request isn't valid: ${checked.description}.`, { href: back, host: new URL(checked.redirectUri).hostname });
  }
  // Signed out: the console's sign-in, which returns to this exact URL (safeNext admits /oauth/authorize).
  if (!person || !sessionToken) return oauthRedirect(res, `/app/?next=${encodeURIComponent(req.originalUrl)}`);
  const { request } = checked;
  const consentId = createConsent({
    personId: person.id, clientId: request.client.clientId, redirectUri: request.redirectUri, resource: request.resource,
    codeChallenge: request.codeChallenge, state: request.state,
  });
  renderConsent(res, 200, { consentId, sessionToken, person, clientName: request.client.clientName, redirectUri: request.redirectUri });
});

app.post("/oauth/authorize", express.urlencoded({ extended: false, limit: "16kb", inflate: false }), async (req, res) => {
  if (!oauthEnabled()) return res.status(404).json({ error: "not found" });
  if (!authorizeAllowed(req, res)) return;
  const sessionToken = readCookie(req, SESSION_COOKIE);
  const person = sessionPerson(sessionToken);
  if (!person || !sessionToken) return oauthErrorPage(res, 401, "You're signed out.");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const field = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : undefined);
  const consentId = field("consent") ?? "";
  // The token is bound to this session AND this consent (plan §7.7), so neither another tab's consent nor another
  // session's token gets past here.
  if (!csrfMatches(sessionToken, consentId, body.csrf)) {
    return oauthErrorPage(res, 403, "This page can't be used any more.");
  }
  const decision = field("decision");
  const open = readConsent(consentId, person.id);
  if (!open.ok) return consentProblemPage(res, open.problem, consentId, person.id);
  const { consent } = open;
  // "Use another account": not an answer, so the consent stays unanswered (it is this person's, and nobody else can use
  // it). This browser is signed out, then sent to sign-in with the same request as next (safeNext admits it), rebuilt
  // from the stored consent, so after signing in the GET validates it again and opens a fresh consent page.
  if (decision === "switch_account") {
    deleteSession(sessionToken);
    endPersonSession(req, res);
    const again = new URLSearchParams({
      response_type: "code", client_id: consent.clientId, redirect_uri: consent.redirectUri, code_challenge: consent.codeChallenge,
      code_challenge_method: "S256", resource: consent.resource, state: consent.state,
    });
    return oauthRedirect(res, `/app/?next=${encodeURIComponent(`/oauth/authorize?${again}`)}`);
  }
  // The redirect was checked at GET; it is checked again now, since the answer sends the person there (review N3).
  if (!redirectStillRegistered(consent.clientId, consent.redirectUri)) {
    return oauthErrorPage(res, 400, "This app's return address changed. Start again from the app.");
  }
  if (decision === "deny") {
    const denied = denyConsent(consentId, person.id);
    if (!denied.ok) return consentProblemPage(res, denied.problem, consentId, person.id, denied.message);
    return returnToClient(res, denied.redirectUri, {
      error: "access_denied", error_description: "The person declined the connection", state: denied.state, iss: oauthIssuer(),
    }, false);
  }
  const choices = {
    selectedOrgId: field("workspace") ?? null, projectKey: field("project") ?? null, newProjectName: field("new_project"), connectionName: field("name"),
  };
  // The client's name is needed only to draw the page again, so a successful approve never reads (or, for a CIMD client,
  // fetches) the client's metadata (review N10).
  const again = async (status: number, extra: { error?: string; errorField?: "project" | "name"; connectionName?: string; chooseWorkspace?: boolean } = {}) => {
    const loaded = await loadOauthClient(consent.clientId, oauthIpKey(req.ip));
    const clientName = loaded.ok ? loaded.client.clientName : "This app";
    renderConsent(res, status, { consentId, sessionToken, person, clientName, redirectUri: consent.redirectUri, ...choices, ...extra });
  };
  // "choose": Continue from the workspace step, to that workspace's options. "workspaces": Change workspace, back to it.
  if (decision === "workspaces") return again(200, { chooseWorkspace: true });
  if (decision !== "approve") return again(200);
  const result = approveConsent({
    consentId, personId: person.id, orgId: choices.selectedOrgId ?? "", projectKey: choices.projectKey, newProjectName: choices.newProjectName ?? null,
    connectionName: choices.connectionName ?? "",
  });
  if (result.ok) {
    return returnToClient(res, result.redirectUri, { code: result.code, state: result.state, iss: oauthIssuer() }, true, result.grantId);
  }
  if (result.reason === "consent") return consentProblemPage(res, result.problem, consentId, person.id, result.message);
  return again(APPROVE_REFUSAL_STATUS[result.reason] ?? 400, {
    error: result.message,
    errorField: APPROVE_REFUSAL_FIELD[result.reason],
    ...(result.reason === "invalid_name" && result.suggestedName ? { connectionName: result.suggestedName } : {}),
  });
});

// --- MCP connector: the token endpoint (RFC 6749 §3.2/§4.1.3/§6; plan §5 Task 5). On the hub (the issuer): no cookie is
// needed, only the code or refresh token the client holds. Form encoding (Claude requires it, design §2) and JSON.
// Public clients only, so the client is named by client_id and proven by what it holds (the PKCE verifier, the refresh
// token). Every answer is no-store (RFC 6749 §5.1). Throttled per network: guessing codes or tokens has to be slow. The
// default is roomy because a cloud client (claude.ai) refreshes for all its users from a few egress addresses.
const oauthTokenLimiter = createRateLimiter({ limit: Number(process.env.OPENCADRE_OAUTH_TOKEN_PER_MIN) || 120, windowMs: 60_000 });
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
function oauthNoStore(res: Response) {
  res.set("cache-control", "no-store");
  res.set("pragma", "no-cache");
}
const tokenError = (res: Response, status: number, error: string, description: string) => {
  oauthNoStore(res);
  return res.status(status).json({ error, error_description: description });
};
const tokenResponse = (res: Response, pair: { accessToken: string; refreshToken: string; expiresIn: number }) => {
  oauthNoStore(res);
  return res.json({ access_token: pair.accessToken, token_type: "Bearer", expires_in: pair.expiresIn, refresh_token: pair.refreshToken, scope: OAUTH_SCOPE });
};

app.post("/oauth/token", express.urlencoded({ extended: false, limit: "16kb", inflate: false }), (req, res) => {
  if (!oauthEnabled()) return res.status(404).json({ error: "not found" });
  const limited = oauthTokenLimiter.check(oauthIpKey(req.ip));
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfterSeconds));
    return tokenError(res, 429, "rate_limited", "Too many token requests from this network. Try again in a minute.");
  }
  if (!req.is("application/x-www-form-urlencoded") && !req.is("application/json")) {
    return tokenError(res, 400, "invalid_request", "send the request form-encoded or as JSON");
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const field = (name: string) => (typeof body[name] === "string" && body[name] ? (body[name] as string) : undefined);
  const grantType = field("grant_type");
  const clientId = field("client_id");
  if (grantType === "authorization_code") {
    const code = field("code");
    const redirectUri = field("redirect_uri");
    const codeVerifier = field("code_verifier");
    if (!code || !redirectUri || !clientId || !codeVerifier) {
      return tokenError(res, 400, "invalid_request", "code, redirect_uri, client_id and code_verifier are required");
    }
    if (!CODE_VERIFIER.test(codeVerifier)) return tokenError(res, 400, "invalid_request", "code_verifier must be 43 to 128 unreserved characters");
    // RFC 8707: the token is for this hub's /mcp and nothing else. A resource that names anything else is refused; an
    // absent one means the resource the code was issued for (RFC 8707 §2.2), which is always this hub's /mcp, since
    // authorize accepts no other. Some clients (Cursor's cloud callback, which Grok Bot uses) send it only at authorize.
    const resource = field("resource");
    if (resource !== undefined && resource !== mcpResource()) return tokenError(res, 400, "invalid_target", `resource must be ${mcpResource()}`);
    const exchanged = exchangeAuthorizationCode({ code, clientId, redirectUri, resource: mcpResource(), codeVerifier });
    if (!exchanged.ok) return tokenError(res, 400, exchanged.error, exchanged.description);
    return tokenResponse(res, exchanged);
  }
  if (grantType === "refresh_token") {
    const refreshToken = field("refresh_token");
    if (!refreshToken || !clientId) return tokenError(res, 400, "invalid_request", "refresh_token and client_id are required");
    const resource = field("resource");
    if (resource !== undefined && resource !== mcpResource()) return tokenError(res, 400, "invalid_target", `resource must be ${mcpResource()}`);
    const rotated = rotateRefreshToken(refreshToken, clientId);
    if (!rotated.ok) return tokenError(res, 400, "invalid_grant", rotated.reused ? "this refresh token was already used; the connection was revoked" : "invalid, expired or revoked refresh token");
    return tokenResponse(res, rotated);
  }
  if (!grantType) return tokenError(res, 400, "invalid_request", "grant_type is required");
  return tokenError(res, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
});
// --- MCP connector: revocation (RFC 7009; plan §5 Task 6, §7.4). Revokes ONLY the presented token's family: another
// family on the same connector (a second computer, a second chat) keeps working. Disconnecting the whole connection is
// the console's (PR3). Always 200 for a well-formed request, known token or not (RFC 7009 §2.2), so the answer is no
// oracle for which tokens exist. A public client may omit client_id; one that names another client revokes nothing.
const oauthRevokeLimiter = createRateLimiter({ limit: Number(process.env.OPENCADRE_OAUTH_REVOKE_PER_MIN) || 60, windowMs: 60_000 });
app.post("/oauth/revoke", express.urlencoded({ extended: false, limit: "16kb", inflate: false }), (req, res) => {
  if (!oauthEnabled()) return res.status(404).json({ error: "not found" });
  const limited = oauthRevokeLimiter.check(oauthIpKey(req.ip));
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfterSeconds));
    return tokenError(res, 429, "rate_limited", "Too many revocation requests from this network. Try again in a minute.");
  }
  if (!req.is("application/x-www-form-urlencoded") && !req.is("application/json")) {
    return tokenError(res, 400, "invalid_request", "send the request form-encoded or as JSON");
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) return tokenError(res, 400, "invalid_request", "token is required");
  const clientId = typeof body.client_id === "string" && body.client_id ? body.client_id : undefined;
  const family = familyOfToken(token);
  if (family && (!clientId || clientOfFamily(family) === clientId)) revokeTokenFamily(family, "this connection was revoked by its app");
  oauthNoStore(res);
  res.status(200).end();
});
// As for registration: a body the parser refused gets the endpoint's own error shape (RFC 6749 §5.2), not an HTML page.
app.use(["/oauth/token", "/oauth/revoke"], (err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const type = (err as { type?: string })?.type;
  if (!oauthEnabled() || (type !== "entity.parse.failed" && type !== "entity.too.large")) return next(err);
  tokenError(res, 400, "invalid_request", type === "entity.too.large" ? "the request body is too large" : "the request body is not valid JSON");
});
// The code is the only credential on redeem, so guessing is throttled per network.
const redeemLimiter = createRateLimiter({ limit: Number(process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN) || 10, windowMs: 60_000 });

app.post("/v1/connect-codes", requireAgentAuth, requirePermission("connectCodes.manage"), (req: AuthedRequest, res) => {
  const client = req.body?.client ?? "auto";
  if (!(CONNECT_CLIENTS as readonly unknown[]).includes(client)) {
    return res.status(400).json({ error: `client must be one of ${CONNECT_CLIENTS.join(", ")}` });
  }
  try {
    const { code, expiresAt } = createConnectCode(req.orgId!, { id: req.agentId! }, req.body?.agentName, client as ConnectClient);
    res.status(201).json({ code, expiresAt, command: connectCommand(publicHubUrl(), code, client as ConnectClient) });
  } catch (err) {
    if (!(err instanceof AgentNameError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

app.get("/v1/connect-codes/:code/status", requireAgentAuth, requirePermission("connectCodes.manage"), (req: AuthedRequest, res) => {
  const status = connectCodeStatus(req.orgId!, String(req.params.code));
  if (!status) return res.status(404).json({ error: "connect code not found" });
  res.json(status);
});

app.post("/v1/connect/redeem", (req, res) => {
  const limited = redeemLimiter.check(`ip:${req.ip}`);
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfterSeconds));
    return res.status(429).json({ error: "Too many connect attempts from this network. Try again in a minute." });
  }
  if (looksLikeDeviceCode(req.body?.code)) {
    // currentCredential (optional, body only): this computer's own credential, so reconnecting updates the same computer.
    const device = redeemDeviceCode(req.body?.code, req.body?.currentCredential);
    if (!device.ok) return res.status(device.status).json({ error: device.error });
    const { deviceCredential, deviceId, merged, computerName, client, orgName } = device;
    return res.status(201).json({ deviceCredential, deviceId, merged, computerName, client, orgName, hubUrl: publicHubUrl(), cliUrl: cliTarballUrl(publicHubUrl()) });
  }
  const result = redeemConnectCode(req.body?.code);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  const { apiKey, agentName, agentId, client, orgName } = result;
  res.status(201).json({ apiKey, agentName, agentId, hubUrl: publicHubUrl(), client, orgName, cliUrl: cliTarballUrl(publicHubUrl()) });
});

// --- Devices and sessions: per-session identity (src/devices.ts) -------------------------------
// An operator adds a device once; every tool session on it then gets its own agent automatically.
app.post("/v1/org/devices", requireAgentAuth, requirePermission("devices.manage"), (req: AuthedRequest, res) => {
  // THE PLAN'S MACHINE LIMIT, the refusal this route owes before it creates anything -- the same order as
  // the agent routes (`:387-390`): both precede the write, so a refusal half-creates nothing. `PRICING.md:107`
  // has promised "a 4th machine (Pro)" is refused since the plan table landed; this is that promise.
  const limitRefused = machineLimitRefusal(req.orgId!, publicAppUrl(req));
  if (limitRefused) return res.status(limitRefused.status).json(limitRefused.body);
  try {
    const { deviceId, code, expiresAt, client } = createDevice(req.orgId!, { id: req.agentId!, name: req.agentName! }, req.body?.name, req.body?.client);
    res.status(201).json({ deviceId, code, expiresAt, command: connectCommand(publicHubUrl(), code, client) });
  } catch (err) {
    if (!(err instanceof DeviceError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

app.get("/v1/org/devices", requireAgentAuth, requirePermission("devices.manage"), (req: AuthedRequest, res) => {
  res.json({ devices: listOrgDevices(req.orgId!) });
});

app.delete("/v1/org/devices/:deviceId", requireAgentAuth, requirePermission("devices.manage"), (req: AuthedRequest, res) => {
  const revoked = revokeDevice(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.deviceId));
  if (!revoked) return res.status(404).json({ error: "device not found" });
  res.json({ ok: true, ...revoked });
});

/** The session fields from headers, falling back to the same fields in a JSON body (for hooks that can't set headers). */
function sessionFieldsFrom(req: Request): Record<string, unknown> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pick = (header: string, field: string) => req.header(header) ?? (typeof body[field] === "string" ? body[field] : undefined);
  return {
    [SESSION_HEADER]: pick(SESSION_HEADER, "toolSessionId"),
    [HOST_SESSION_HEADER]: pick(HOST_SESSION_HEADER, "hostSessionId"),
    [CLIENT_HEADER]: pick(CLIENT_HEADER, "client"),
    [PROJECT_HEADER]: pick(PROJECT_HEADER, "project"),
    [PROJECT_NAME_HEADER]: pick(PROJECT_NAME_HEADER, "projectName"),
    [RESOLVE_ONLY_HEADER]: req.header(RESOLVE_ONLY_HEADER) ?? (body.resolveOnly === true ? "1" : undefined),
    // Every field readSessionHints reads *for this path* must be listed here: this function REPLACES
    // req.headers for the device path, so a header left out is not "unset", it is unreadable.
    // tests/session-adoption.test.ts caught exactly that, and tests/session-fields-parity.test.ts now
    // enforces the rule from the reader rather than from a copy of this list.
    [ADOPT_LIVE_HEADER]: req.header(ADOPT_LIVE_HEADER) ?? (body.adoptLive === true ? "1" : undefined),
    // `CHAT_PROVEN_HEADER` IS DELIBERATELY ABSENT, and the exclusion is a design decision rather than an
    // oversight — the omission looked like a defect against the rule above, and it is not.
    //
    // That header is how a caller asserts "a tool call proved this session is a CHAT" (migration 38's
    // label). `/mcp` is its SOLE CARRIER: it passes `req.headers` raw to checkDeviceSession (src/mcp.ts),
    // and the MCP proxy is the only writer — `noteChatProven`, gated on `m?.method === "tools/call"`.
    // A HOOK MUST NOT BE ABLE TO ASSERT IT. Hooks reach the hub resolve-only and build their headers
    // through `sessionHeaders()`, a fixed set that cannot carry it; listing it here would make the join
    // path *able to accept* an assertion the design says a hook must never make, which is the same
    // widening as admitting a hook as proof of a chat — the label would stop meaning "a tool call
    // proved this" and start meaning "something happened". The adoption site's dead promotion call in
    // src/devices.ts rests on exactly this invariant, so the two must agree.
    //
    // Consequence of leaving it out, stated so it is not discovered: a request to /v1/sessions/join or
    // /leave carrying the header has it ignored, which is correct — those routes are not a promotion
    // path, and nothing that promotes uses them.
  };
}

// The SessionStart hook learns its own name here. Any other request with the same session headers joins just the same.
app.post("/v1/sessions/join", (req, res) => {
  if (!isDeviceCredential(bearer(req))) return res.status(401).json({ error: "a device credential is required" });
  const checked = checkDeviceSession(bearer(req), sessionFieldsFrom(req));
  if (!checked.ok) {
    const refused = deviceRefusalResponse(checked);
    return res.status(refused.status).json(refused.body);
  }
  const { orgId, agentId, agentName, created } = checked.auth;
  heartbeat(orgId, agentId);
  res.status(created ? 201 : 200).json({ agentId, agentName, created });
});

// A computer calls these four as itself: the device credential alone, no session headers (the only device routes that
// don't name a session).
app.get("/v1/devices/me", (req, res) => {
  const found = describeComputer(bearer(req));
  if (!found.ok) {
    const refused = deviceRefusalResponse(found);
    return res.status(refused.status).json(refused.body);
  }
  const { deviceId, name, client, tools } = found;
  // cliUrl, as the redeem answers carry it: `connect` re-run with no code has only this answer to learn the current
  // stamp from, and without it printed the bare URL npx had cached (Q1g). The CLI takes only the stamp; the host stays
  // the one it talked to (cli/bin/opencadre.mjs cliUrlFor).
  res.json({ deviceId, name, client, tools, cliUrl: cliTarballUrl(publicHubUrl()) });
});

app.get("/v1/devices/projects", (req, res) => {
  const listed = listDeviceProjects(bearer(req));
  if (!listed.ok) {
    const refused = deviceRefusalResponse(listed);
    return res.status(refused.status).json(refused.body);
  }
  res.json({ projects: listed.projects });
});

app.post("/v1/devices/tools", (req, res) => {
  const recorded = recordDeviceTools(bearer(req), req.body?.tools);
  if (!recorded.ok) {
    if (recorded.reason === "bad_request") return res.status(400).json({ error: recorded.error });
    const refused = deviceRefusalResponse(recorded);
    return res.status(refused.status).json(refused.body);
  }
  res.json({ ok: true, tools: recorded.tools });
});

app.post("/v1/devices/connector-build", (req, res) => {
  const recorded = recordDeviceConnectorReport(bearer(req), req.body);
  if (!recorded.ok) {
    if (recorded.reason === "bad_request") return res.status(400).json({ error: recorded.error });
    const refused = deviceRefusalResponse(recorded);
    return res.status(refused.status).json(refused.body);
  }
  res.json({ ok: true });
});

app.put("/v1/devices/projects/enable-current", (req, res) => {
  try {
    const enabled = enableCurrentProject(bearer(req), req.headers);
    if (!enabled.ok) {
      if (enabled.reason === "bad_request") return res.status(400).json({ error: enabled.error });
      const refused = deviceRefusalResponse(enabled);
      return res.status(refused.status).json(refused.body);
    }
    res.json({ ok: true, project: enabled.project });
  } catch (err) {
    if (!(err instanceof ProjectError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

// --- Projects: opt-in per workspace (src/projects.ts) -------------------------------------------
app.get("/v1/org/projects", requireAgentAuth, requirePermission("projects.manage"), (req: AuthedRequest, res) => {
  res.json({ projects: listProjects(req.orgId!) });
});

app.put("/v1/org/projects", requireAgentAuth, requirePermission("projects.manage"), (req: AuthedRequest, res) => {
  try {
    const { projectKey, name, enabled } = req.body ?? {};
    const project = setProjectEnabled(req.orgId!, { actor: { id: req.agentId!, name: req.agentName! }, name: req.agentName!, via: "operator" }, projectKey, enabled, name);
    res.json({ project });
  } catch (err) {
    if (!(err instanceof ProjectError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

// --- Project settings: the per-project WIP cap (src/project-settings.ts) ----------------------------------------------
// The cap is per agent, by its home project: an agent's limit is its home project's cap, else the workspace default.
// :key is a project key, URL-encoded (github.com%2Fowner%2Frepo), or * (or %2A) for the workspace default. Reading is
// open to anyone who can see the project (an agent may want its cap); outside its projects one reads as not found.
// Changing it is an admin's (projectSettings.write); while projects are kept apart, a project's admin agent sets only its
// own projects, and only a workspace-wide admin sets the default. An Operator key may only tighten a cap; loosening one
// takes a signed-in person (src/project-settings.ts setWipCap).
function projectSettingsKey(req: AuthedRequest, res: Response): string | null {
  const project = parseProjectParam(String(req.params.key));
  if (project === null) res.status(400).json({ error: `${PROJECT_KEY_ERROR}, or * for the workspace default` });
  return project;
}

function sendProjectSettingsError(res: Response, err: unknown) {
  if (!(err instanceof ProjectSettingsError)) throw err;
  res.status(err.status).json({ error: err.message });
}

app.get("/v1/org/projects/:key/settings", requireAgentAuth, (req: AuthedRequest, res) => {
  const project = projectSettingsKey(req, res);
  if (project === null) return;
  try {
    res.json({ settings: getProjectSettings(req.orgId!, req.agentId!, project) });
  } catch (err) {
    sendProjectSettingsError(res, err);
  }
});

app.put("/v1/org/projects/:key/settings", requireAgentAuth, requirePermission("projectSettings.write"), (req: AuthedRequest, res) => {
  const project = projectSettingsKey(req, res);
  if (project === null) return;
  try {
    const { previous: _previous, ...settings } = setWipCap(req.orgId!, { agent: { id: req.agentId!, name: req.agentName! }, personId: req.person?.id ?? null }, project, req.body?.wipCap);
    res.json({ settings });
  } catch (err) {
    sendProjectSettingsError(res, err);
  }
});

// --- Project isolation: linked projects and the workspace setting (src/project-isolation.ts, src/scope.ts) ---------------
app.get("/v1/org/project-links", requireAgentAuth, requirePermission("projectLinks.manage"), (req: AuthedRequest, res) => {
  res.json({ links: listProjectLinks(req.orgId!) });
});

app.post("/v1/org/project-links", requireAgentAuth, requirePermission("projectLinks.manage"), (req: AuthedRequest, res) => {
  try {
    const { link, created } = linkProjects(req.orgId!, { id: req.agentId!, name: req.agentName! }, req.body?.projectA, req.body?.projectB);
    res.status(created ? 201 : 200).json({ link, created });
  } catch (err) {
    if (!(err instanceof ProjectLinkError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

app.delete("/v1/org/project-links", requireAgentAuth, requirePermission("projectLinks.manage"), (req: AuthedRequest, res) => {
  try {
    if (!unlinkProjects(req.orgId!, { id: req.agentId!, name: req.agentName! }, req.body?.projectA, req.body?.projectB)) {
      return res.status(404).json({ error: "those projects aren't linked" });
    }
    res.json({ ok: true });
  } catch (err) {
    if (!(err instanceof ProjectLinkError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

app.get("/v1/org/project-isolation", requireAgentAuth, requirePermission("projectIsolation.manage"), (req: AuthedRequest, res) => {
  res.json(projectIsolationState(req.orgId!));
});

// Switching on runs the pre-flight and refuses (409, with the report) while a repository is split across project keys.
app.put("/v1/org/project-isolation", requireAgentAuth, requirePermission("projectIsolation.manage"), (req: AuthedRequest, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
  try {
    res.json(setProjectIsolation(req.orgId!, { id: req.agentId!, name: req.agentName! }, enabled));
  } catch (err) {
    if (!(err instanceof PreflightRefusedError)) throw err;
    res.status(409).json({ error: err.message, report: err.report });
  }
});

app.post("/v1/sessions/leave", (req, res) => {
  if (!isDeviceCredential(bearer(req))) return res.status(401).json({ error: "a device credential is required" });
  const left = leaveDeviceSession(bearer(req), sessionFieldsFrom(req));
  if (!left.ok) {
    const failure = deviceAuthError(left.reason);
    return res.status(failure.status).json({ error: failure.error });
  }
  res.json({ ok: true, ended: left.ended });
});

app.get("/v1/org/sessions", requireAgentAuth, requirePermission("sessions.manage"), (req: AuthedRequest, res) => {
  const status = req.query.status ?? "live";
  if (status !== "live" && status !== "ended") return res.status(400).json({ error: 'status must be "live" or "ended"' });
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  if (since !== undefined && Number.isNaN(Date.parse(since))) return res.status(400).json({ error: "since must be a date, e.g. 2026-09-23T00:00:00Z" });
  res.json({ sessions: listSessions(req.orgId!, status, { endedSince: since }) });
});

// Naming a session is operator-owned (sessions PR1): only a signed-in person, never an agent or Operator key.
function requirePersonForNaming(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.person) return res.status(403).json({ error: "Only a signed-in owner or admin can name an agent, in OpenCadre on their phone or computer." });
  next();
}

app.patch("/v1/org/sessions/:agentId", requireAgentAuth, requirePersonForNaming, requirePermission("sessions.manage"), (req: AuthedRequest, res) => {
  try {
    const named = nameSession(req.orgId!, String(req.params.agentId), req.body?.name, {
      personId: req.person!.id, actor: { id: req.agentId!, name: req.agentName! },
    });
    if (!named) return res.status(404).json({ error: "session not found" });
    res.json(named);
  } catch (err) {
    if (err instanceof AgentNameError || err instanceof ProfileNameError || err instanceof SessionNameRefusal) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// The one-time naming prompt, answered "keep this name".
app.post("/v1/org/sessions/:agentId/keep-name", requireAgentAuth, requirePersonForNaming, requirePermission("sessions.manage"), (req: AuthedRequest, res) => {
  const kept = keepSessionName(req.orgId!, String(req.params.agentId));
  if (!kept) return res.status(404).json({ error: "session not found" });
  res.json(kept);
});

// --- Agent-facing API ---------------------------------------------------
app.post("/v1/heartbeat", requireAgentAuth, (req: AuthedRequest, res) => {
  heartbeat(req.orgId!, req.agentId!);
  res.json({ ok: true });
});

app.get("/v1/agents", requireAgentAuth, (req: AuthedRequest, res) => {
  res.json({ agents: listActiveAgents(req.orgId!, req.agentId!) });
});

app.post("/v1/messages", requireAgentAuth, idempotent("POST /v1/messages"), async (req: AuthedRequest, res) => {
  const { toAgent, toAgents, channel, body, priority, fileId } = req.body ?? {};
  if (!body) return res.status(400).json({ error: "body is required" });
  const from = { id: req.agentId!, name: req.agentName! };

  if (channel === "org" || channel === "project" || Array.isArray(toAgents)) {
    if (toAgent) return res.status(400).json({ error: "Use either toAgent or toAgents/channel, not both" });
    if (fileId) return res.status(400).json({ error: "file attachments are not supported on broadcast yet" });
    const targets = channel === "org" || channel === "project" ? { channel: channel as "org" | "project" } : { toAgents: toAgents as string[] };
    const result = await broadcastMessage(req.orgId!, from, targets, body, normalizePriority(priority));
    if (!result.ok) return res.status(result.status ?? 400).json({ ok: false, error: result.error });
    res.status(201).json(result);
    return;
  }

  if (!toAgent) return res.status(400).json({ error: "toAgent, toAgents, or channel is required" });
  const result = await sendMessage(
    req.orgId!, from, toAgent, body,
    normalizePriority(priority), typeof fileId === "string" ? fileId : null,
  );
  if (!result.ok) return res.status(messageErrorStatus(result)).json(result);
  res.status(201).json(result);
});

app.post("/v1/questions", requireAgentAuth, async (req: AuthedRequest, res) => {
  const { toAgent, body, timeoutSeconds, priority } = req.body ?? {};
  if (!toAgent || !body) return res.status(400).json({ error: "toAgent and body are required" });
  const result = await askClarification(
    req.orgId!, { id: req.agentId!, name: req.agentName! }, toAgent, body,
    typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? timeoutSeconds : 60,
    normalizePriority(priority),
  );
  if (!result.ok) return res.status(messageErrorStatus(result)).json(result);
  res.status(200).json(result);
});

app.get("/v1/messages", requireAgentAuth, (req: AuthedRequest, res) => {
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  const peek = parsePeekQuery(req.query.peek, req.keyClass!);
  const afterId = typeof req.query.afterId === "string" ? req.query.afterId : undefined;
  const limit = messageLimitFrom(req.query.limit);
  res.json({ messages: getMessages(req.orgId!, req.agentId!, since, { peek, afterId, limit }) });
});

// Real long-poll counterpart to GET /v1/messages -- blocks up to
// timeoutSeconds (capped at 280s server-side) instead of returning
// immediately, so a REST-only client can approach the same effective
// latency an MCP client gets from wait_for_message.
app.get("/v1/messages/wait", requireAgentAuth, async (req: AuthedRequest, res) => {
  const raw = Number(req.query.timeoutSeconds);
  const timeoutSeconds = Number.isFinite(raw) && raw > 0 ? raw : 55;
  const peek = parsePeekQuery(req.query.peek, req.keyClass!);
  const afterId = typeof req.query.afterId === "string" ? req.query.afterId : undefined;
  const limit = messageLimitFrom(req.query.limit);
  // The same opt-out the auth layer honours (x-opencadre-probe: no-heartbeat) reaches the hold, which beats on its own.
  const beat = req.get("x-opencadre-probe") !== "no-heartbeat";
  const messages = await waitForMessage(req.orgId!, req.agentId!, timeoutSeconds, { peek, afterId, limit, beat });
  res.json({ messages });
});

// Literal path, so it must be registered before /v1/messages/:threadId/* below, or Express
// would match "search" as a threadId. Read-only: search never marks mail read (see searchMessages).
app.get("/v1/messages/search", requireAgentAuth, (req: AuthedRequest, res) => {
  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const threadId = typeof req.query.threadId === "string" ? req.query.threadId : undefined;
  res.json({ messages: searchMessages(req.orgId!, req.agentId!, { query, from, threadId, limit: messageLimitFrom(req.query.limit) }) });
});

app.post("/v1/messages/consume", requireAgentAuth, (req: AuthedRequest, res) => {
  const messageIds = req.body?.messageIds;
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: "messageIds must be a non-empty array" });
  }
  const result = consumeMessages(req.orgId!, req.agentId!, messageIds.map(String));
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post("/v1/messages/:threadId/reply", requireAgentAuth, idempotent("POST /v1/messages/:threadId/reply"), (req: AuthedRequest, res) => {
  const { body } = req.body ?? {};
  if (!body) return res.status(400).json({ error: "body is required" });
  const threadId = String(req.params.threadId);
  const result = reply(req.orgId!, { id: req.agentId!, name: req.agentName! }, threadId, body);
  if (!result.ok) return res.status(messageErrorStatus(result)).json(result);
  res.json(result);
});

app.get("/v1/messages/:threadId/status", requireAgentAuth, (req: AuthedRequest, res) => {
  const result = getThreadStatus(req.orgId!, req.agentId!, String(req.params.threadId));
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.post("/v1/webhook", requireAgentAuth, (req: AuthedRequest, res) => {
  const { url, authHeader } = req.body ?? {};
  if (url !== null && typeof url !== "string") {
    return res.status(400).json({ error: "url must be a string or null (null clears the webhook)" });
  }
  if (typeof authHeader === "string") {
    const check = validateWebhookAuthHeader(authHeader);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  if (typeof url === "string") {
    const check = validateWebhookUrl(url);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  setAgentWebhook(req.orgId!, req.agentId!, url ?? null, typeof authHeader === "string" ? authHeader : null);
  res.json({ ok: true });
});

app.post("/v1/status", requireAgentAuth, (req: AuthedRequest, res) => {
  const { task, files, phase } = req.body ?? {};
  if (phase !== undefined && phase !== null && !(PHASES as readonly unknown[]).includes(phase)) {
    return res.status(400).json({ error: `phase must be one of ${PHASES.join(", ")}` });
  }
  const fileList = Array.isArray(files) ? files.filter((f) => typeof f === "string") : [];
  const result = setAgentStatus(req.orgId!, req.agentId!, typeof task === "string" ? task : null, fileList, phase);
  res.json({ ok: true, ...result });
});

app.post("/v1/capabilities", requireAgentAuth, (req: AuthedRequest, res) => {
  const { capabilities } = req.body ?? {};
  if (!(Array.isArray(capabilities) && capabilities.every((c) => typeof c === "string"))) {
    return res.status(400).json({ error: "capabilities must be an array of strings" });
  }
  const result = setAgentCapabilities(req.orgId!, req.agentId!, capabilities);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// Caller's own capabilities only -- reading another agent's crosses project isolation, which the
// MCP get_capabilities tool already handles correctly via resolveAgent's assertReachable check.
app.get("/v1/capabilities", requireAgentAuth, (req: AuthedRequest, res) => {
  res.json({ capabilities: getAgentCapabilities(req.orgId!, req.agentId!) });
});

app.post("/v1/round-budget", requireAgentAuth, (req: AuthedRequest, res) => {
  const { roundBudget } = req.body ?? {};
  if (roundBudget !== null && roundBudget !== undefined && typeof roundBudget !== "number") {
    return res.status(400).json({ error: "roundBudget must be a number, or null to clear it" });
  }
  const result = setAgentRoundBudget(req.orgId!, req.agentId!, roundBudget ?? null);
  if (!result.ok) return res.status(result.error === "agent not found" ? 404 : 400).json(result);
  res.json(result);
});

// Caller's own round budget only, same reach rule as /v1/capabilities.
app.get("/v1/round-budget", requireAgentAuth, (req: AuthedRequest, res) => {
  res.json({ roundBudget: getAgentRoundBudget(req.orgId!, req.agentId!) });
});

app.post("/v1/usage", requireAgentAuth, (req: AuthedRequest, res) => {
  const parsed = parseUsageReport(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  res.json({ usage: setAgentUsage(req.orgId!, { id: req.agentId!, name: req.agentName! }, parsed.report) });
});

// --- Timeline (Ambient Awareness v1, slice 1) -----------------------------------
const typesFrom = (raw: unknown) => (typeof raw === "string" && raw ? raw.split(",") : undefined);
const cursorFrom = (raw: unknown) => Math.max(Number(raw) || 0, 0);

app.get("/v1/events", requireAgentAuth, (req: AuthedRequest, res) => {
  // Without a cursor a reader wants what is happening now (same default as MCP get_timeline);
  // latest=false still pages from the org's first event.
  const latest = req.query.latest === undefined ? req.query.after === undefined : req.query.latest === "true";
  // subjectType + subjectId narrow the stream to one subject (e.g. a task's history), both or neither.
  const { subjectType, subjectId } = req.query;
  if ((subjectType === undefined) !== (subjectId === undefined) || (subjectType !== undefined && (typeof subjectType !== "string" || typeof subjectId !== "string" || !subjectType || !subjectId))) {
    return res.status(400).json({ error: "subjectType and subjectId go together, as non-empty strings" });
  }
  const subject = typeof subjectType === "string" && typeof subjectId === "string" ? { type: subjectType, id: subjectId } : undefined;
  const events = listTimeline(req.orgId!, { after: cursorFrom(req.query.after), types: typesFrom(req.query.types), limit: Number(req.query.limit) || undefined, latest, viewer: req.agentId!, subject });
  // Same reason as /v1/memory: a window that hides rows must announce itself, or a customer reading a
  // gap in their history concludes the history is gone (PRICING.md §4). Absent when there is no window.
  const retention = retentionNotice(req.orgId!);
  // AN EMPTY PAGE RE-SERVES THE CURSOR, AND WITH THE WINDOW IN SQL THAT IS CORRECT, NOT A STALL.
  //
  // This line was reported to me as a SECOND, independent defect: an empty page returns the cursor the
  // caller already held, so a paging client loops forever. MEASURED FALSE, and I built the fallback
  // that "fixed" it before checking whether it could be falsified. With the window applied in SQL, a
  // page is empty only when there are no VISIBLE rows past the cursor -- the caller has reached the end
  // of its readable history -- and returning the cursor it arrived with is then the honest answer,
  // because there is nothing beyond it to name. A caller stops.
  //
  // THE LOOP WAS REAL BEFORE THE FILTER MOVED, AND IT WAS A SYMPTOM. The page was empty because 200
  // hidden rows had consumed the LIMIT, not because the history had ended; moving the window into the
  // WHERE clause makes the page carry visible rows, so the cursor advances and the loop cannot form.
  //
  // BOTH DIRECTIONS WERE FIRED RATHER THAN ARGUED. Reverting the window to a JS filter reds the paging
  // test (so THAT fix is load-bearing). Reverting a `Math.max(cursor, highestEventSeq(orgId))` fallback
  // right here leaves the whole suite GREEN (so this fallback is unreachable). Unfalsifiable code is not
  // shipped to satisfy a description of a defect that measurement does not support -- and the honest
  // record is that the second defect does not exist, not that it was fixed.
  res.json({ events, nextAfter: events.at(-1)?.seq ?? cursorFrom(req.query.after), ...(retention ? { retention } : {}) });
});

app.get("/v1/events/wait", requireAgentAuth, async (req: AuthedRequest, res) => {
  const after = cursorFrom(req.query.after);
  const timeout = Number(req.query.timeoutSeconds);
  const events = await waitForTimeline(req.orgId!, after, Number.isFinite(timeout) && timeout > 0 ? timeout : 55, typesFrom(req.query.types), req.agentId!);
  res.json({ events, nextAfter: events.at(-1)?.seq ?? after });
});

app.get("/v1/awareness", requireAgentAuth, (req: AuthedRequest, res) => {
  const since = req.query.since === undefined ? undefined : cursorFrom(req.query.since);
  // ?board=1 adds the caller's own work board (src/task-board.ts); it is built only when asked for.
  res.json(getAwareness(req.orgId!, req.agentId!, { since, board: req.query.board === "1" || req.query.board === "true" }));
});

app.get("/v1/deliveries", requireAgentAuth, (req: AuthedRequest, res) => {
  sweepTimeline(req.orgId!);
  res.json({ events: pullEvents(req.orgId!, req.agentId!, Number(req.query.limit) || undefined) });
});

app.post("/v1/events/:seq/ack", requireAgentAuth, (req: AuthedRequest, res) => {
  const result = ackEvent(req.orgId!, req.agentId!, Number(req.params.seq), req.body?.outcome);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ delivery: result.delivery });
});

app.post("/v1/decisions", requireAgentAuth, idempotent("POST /v1/decisions"), (req: AuthedRequest, res) => {
  const { title, rationale, scope } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required" });
  const event = recordDecision(req.orgId!, { id: req.agentId!, name: req.agentName! }, {
    title, rationale: typeof rationale === "string" ? rationale : null, scope: typeof scope === "string" ? scope : null,
  });
  res.status(201).json({ event });
});

// multipart is deliberately not supported here -- base64 keeps this MVP's
// only two allowed file types (.md/.pdf) simple over plain JSON, matching
// how the MCP tool surface already takes file content.
app.post("/v1/files/share", requireAgentAuth, idempotent("POST /v1/files/share"), async (req: AuthedRequest, res) => {
  const { toAgent, filename, mimeType, contentBase64, message, priority } = req.body ?? {};
  if (!toAgent || !filename || !contentBase64 || !message) {
    return res.status(400).json({ error: "toAgent, filename, contentBase64, and message are required" });
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentBase64, "base64");
  } catch {
    return res.status(400).json({ error: "contentBase64 is not valid base64" });
  }
  const result = await shareFile(
    req.orgId!, { id: req.agentId!, name: req.agentName! }, toAgent, filename,
    typeof mimeType === "string" ? mimeType : "application/octet-stream",
    content, message, normalizePriority(priority),
  );
  if (!result.ok) return res.status(result.code === NOT_REACHABLE ? 403 : 400).json(result);
  res.status(201).json(result);
});

app.get("/v1/files/:fileId", requireAgentAuth, (req: AuthedRequest, res) => {
  const fileId = String(req.params.fileId);
  const file = getFile(req.orgId!, fileId, { agentId: req.agentId!, role: req.agentRole ?? "agent" });
  if (!file) return res.status(404).json({ error: `No file found matching "${fileId}"` });
  res.json({
    id: file.id, filename: file.filename, mimeType: file.mime_type,
    sizeBytes: file.size_bytes, uploadedBy: file.uploaded_by_agent_name,
    createdAt: file.created_at, contentBase64: file.content.toString("base64"),
  });
});

// --- Task board (issue #7) --------------------------------------------------
app.post("/v1/tasks", requireAgentAuth, idempotent("POST /v1/tasks"), (req: AuthedRequest, res) => {
  const { title, description, project, requiredCapabilities, minRoundBudget, requiredReviews, parentTaskId, lane, rank, heldReason } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required" });
  if (heldReason !== undefined && heldReason !== null && typeof heldReason !== "string") return res.status(400).json({ error: "heldReason must be a string" });
  if (project !== undefined && project !== null && typeof project !== "string") return res.status(400).json({ error: "project must be a project key" });
  if (requiredCapabilities !== undefined && !(Array.isArray(requiredCapabilities) && requiredCapabilities.every((c) => typeof c === "string"))) {
    return res.status(400).json({ error: "requiredCapabilities must be an array of strings" });
  }
  if (minRoundBudget !== undefined && minRoundBudget !== null && typeof minRoundBudget !== "number") {
    return res.status(400).json({ error: "minRoundBudget must be a number" });
  }
  if (requiredReviews !== undefined && requiredReviews !== null && typeof requiredReviews !== "number") {
    return res.status(400).json({ error: "requiredReviews must be a number" });
  }
  if (parentTaskId !== undefined && parentTaskId !== null && typeof parentTaskId !== "string") {
    return res.status(400).json({ error: "parentTaskId must be a string" });
  }
  try {
    const task = createTask(req.orgId!, { id: req.agentId!, name: req.agentName! }, {
      title, description: typeof description === "string" ? description : null, project, requiredCapabilities, minRoundBudget, requiredReviews, parentTaskId,
      // createTask validates both: lane next or held (never now), rank a whole number 0-100000 or null.
      lane, rank, heldReason,
    });
    res.status(201).json({ task });
  } catch (err) {
    if (!(err instanceof TaskInputError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

// With no paging parameter: every task, in full, oldest first -- today's response, unchanged. Any of summary, limit,
// cursor, column, mine, q or project opts into the paged response { tasks, nextCursor, counts, projects }
// (src/tasks.ts listTaskPage; docs/superpowers/plans/2026-09-30-task-paging.md). A bad parameter or cursor is a 400.
app.get("/v1/tasks", requireAgentAuth, (req: AuthedRequest, res) => {
  // ?board=1: the work board, { board: { now, next, held, done } } (src/task-board.ts), in the caller's projects.
  if (req.query.board === "1" || req.query.board === "true") {
    // Each section shows at most a page (src/task-board.ts BOARD_SHOWN); counts says how many each has.
    const { counts, ...board } = taskBoard(req.orgId!, req.agentId!);
    return res.json({ board, counts });
  }
  try {
    const parsed = parseTaskListQuery(req.query as Record<string, unknown>);
    if (parsed.legacy) return res.json({ tasks: listTasks(req.orgId!, { status: parsed.status, viewer: req.agentId! }) });
    res.json(listTaskPage(req.orgId!, req.agentId!, parsed.query));
  } catch (err) {
    if (!(err instanceof TaskQueryError || err instanceof TaskCursorError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

// One task's full record, untruncated -- list_tasks clips descriptions for the board view.
app.get("/v1/tasks/:taskId", requireAgentAuth, (req: AuthedRequest, res) => {
  const task = getTaskById(req.orgId!, { id: req.agentId! }, String(req.params.taskId));
  if (!task) return res.status(404).json({ error: `No task found matching "${req.params.taskId}"` });
  res.json({ task });
});

// --- Fleet goal (/goal) ------------------------------------------------------
app.get("/v1/goal", requireAgentAuth, (req: AuthedRequest, res) => {
  // `goal` is the one goal this caller works toward (its project's, else the workspace's), the field every installed
  // awareness hook reads. `workspaceGoal` is the workspace goal too, when the caller's project has its own.
  const { project, workspace } = getGoals(req.orgId!, { orgId: req.orgId!, agentId: req.agentId! });
  res.json({ goal: project ?? workspace, ...(project && workspace ? { workspaceGoal: workspace } : {}) });
});

app.post("/v1/goal", requireAgentAuth, idempotent("POST /v1/goal"), (req: AuthedRequest, res) => {
  const { text } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "text is required" });
  try {
    const goal = setGoal(req.orgId!, { id: req.agentId!, name: req.agentName! }, text);
    res.status(201).json({ goal });
  } catch (err) {
    if (!(err instanceof NoNamespaceError)) throw err;
    res.status(403).json({ error: err.message });
  }
});

// A failed task mutation is a 404 when the task doesn't exist in this org, and
// a 409 otherwise (claimed by someone else, already done, not your claim).
function sendTaskResult(res: Response, result: ReturnType<typeof claimTask>) {
  if (result.ok) return res.json(result);
  return res.status(result.error.startsWith("No task found") ? 404 : 409).json(result);
}

function leaseSecondsFrom(body: unknown): number | undefined {
  const raw = (body as { leaseSeconds?: unknown } | undefined)?.leaseSeconds;
  return typeof raw === "number" ? raw : undefined;
}

// The work board (fleet coordination plan, slice D): move a task to next or held (with a reason), or re-rank it. Its
// creator, its claimant or an admin (tasks.manage) may. now is a claim: 409 with a pointer to claim_task.
app.post("/v1/tasks/:taskId/lane", requireAgentAuth, idempotent("POST /v1/tasks/:taskId/lane"), (req: AuthedRequest, res) => {
  const admin = can(roleFor(req.agentRole, req.person ? req.memberRole ?? null : null), "tasks.manage");
  const { lane, rank, reason } = req.body ?? {};
  const result = setTaskLane(req.orgId!, { id: req.agentId!, name: req.agentName! }, { admin }, String(req.params.taskId), { lane, rank, reason });
  if (result.ok) return res.json(result);
  res.status(result.status).json({ ok: false, error: result.error });
});

app.post("/v1/tasks/:taskId/claim", requireAgentAuth, idempotent("POST /v1/tasks/:taskId/claim"), (req: AuthedRequest, res) => {
  // An admin (tasks.manage) may claim a held task; anyone else needs its creator to move it to NEXT first.
  const admin = can(roleFor(req.agentRole, req.person ? req.memberRole ?? null : null), "tasks.manage");
  sendTaskResult(res, claimTask(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.taskId), leaseSecondsFrom(req.body), { admin }));
});

app.post("/v1/tasks/:taskId/renew", requireAgentAuth, idempotent("POST /v1/tasks/:taskId/renew"), (req: AuthedRequest, res) => {
  sendTaskResult(res, renewClaim(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.taskId), leaseSecondsFrom(req.body)));
});

app.post("/v1/tasks/:taskId/release", requireAgentAuth, idempotent("POST /v1/tasks/:taskId/release"), (req: AuthedRequest, res) => {
  sendTaskResult(res, releaseTask(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.taskId)));
});

app.post("/v1/tasks/:taskId/complete", requireAgentAuth, idempotent("POST /v1/tasks/:taskId/complete"), (req: AuthedRequest, res) => {
  const summary = typeof req.body?.summary === "string" ? req.body.summary : null;
  sendTaskResult(res, completeTask(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.taskId), summary));
});

// Second pair of eyes on a done task (src/tasks.ts reviewGuard): any org agent other than the claimant may accept
// or reject. Not-done, already-accepted and self-review are all 409s via sendTaskResult -- none of them mean the
// task doesn't exist, which is the only case that gets a 404.
app.post("/v1/tasks/:taskId/accept", requireAgentAuth, idempotent("POST /v1/tasks/:taskId/accept"), (req: AuthedRequest, res) => {
  sendTaskResult(res, acceptTask(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.taskId)));
});

app.post("/v1/tasks/:taskId/reject", requireAgentAuth, idempotent("POST /v1/tasks/:taskId/reject"), (req: AuthedRequest, res) => {
  const note = typeof req.body?.note === "string" ? req.body.note : null;
  sendTaskResult(res, rejectTask(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.taskId), note));
});

// A correction is filed as its OWN task LINKED to the one it corrects -- never an edit of the filed
// row (see supersedeTask). The body carries the correction's own fields, exactly like create_task,
// because it IS a create plus a link; the URL names the row being corrected.
app.post("/v1/tasks/:taskId/supersede", requireAgentAuth, idempotent("POST /v1/tasks/:taskId/supersede"), (req: AuthedRequest, res) => {
  const { title, description, project, requiredCapabilities, minRoundBudget, requiredReviews } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required" });
  try {
    res.status(201).json({
      task: supersedeTask(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.taskId), {
        title, description: typeof description === "string" ? description : null, project,
        requiredCapabilities, minRoundBudget, requiredReviews,
      }, { admin: can(roleFor(req.agentRole, req.person ? req.memberRole ?? null : null), "tasks.manage") }),
    });
  } catch (err) {
    if (!(err instanceof TaskInputError)) throw err;
    // A 400 like every other TaskInputError, NOT a 409: nothing conflicts about state -- the caller's
    // TARGET is simply not the current row, and the message names the row that is, so a retry against
    // that row succeeds. A held task superseded by someone other than its creator or an admin is a 403.
    res.status(err instanceof TaskHeldError ? 403 : 400).json({ error: err.message });
  }
});

// --- Resource locks (design retro #4) ----------------------------------------
// resourceKey travels in the body/query, never the URL path: it's often a filesystem path or
// branch name, and neither of those survives a route param's implicit URL-decoding/slash-splitting
// unscathed.
// A success carries `leaseChanged` and `leaseExpiresAt`, and a claim also `alreadyHeld` (see resource-locks.ts): a renew
// never shortens a lease, and a holder's re-claim says it was already theirs.
function sendLockResult(res: Response, result: { ok: true; lock: unknown } | { ok: false; error: string }) {
  if (result.ok) return res.json(result);
  return res.status(result.error.includes("is locked by") ? 409 : result.error.includes("don't hold") ? 403 : 404).json(result);
}

app.post("/v1/resources/claim", requireAgentAuth, idempotent("POST /v1/resources/claim"), (req: AuthedRequest, res) => {
  const { resourceKey, note } = req.body ?? {};
  if (typeof resourceKey !== "string") return res.status(400).json({ error: "resourceKey is required" });
  try {
    sendLockResult(res, claimResource(req.orgId!, { id: req.agentId!, name: req.agentName! }, resourceKey, leaseSecondsFrom(req.body), typeof note === "string" ? note : null));
  } catch (err) {
    if (!(err instanceof ResourceLockInputError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

app.post("/v1/resources/renew", requireAgentAuth, idempotent("POST /v1/resources/renew"), (req: AuthedRequest, res) => {
  const { resourceKey } = req.body ?? {};
  if (typeof resourceKey !== "string") return res.status(400).json({ error: "resourceKey is required" });
  sendLockResult(res, renewResourceLock(req.orgId!, { id: req.agentId!, name: req.agentName! }, resourceKey, leaseSecondsFrom(req.body)));
});

app.post("/v1/resources/release", requireAgentAuth, idempotent("POST /v1/resources/release"), (req: AuthedRequest, res) => {
  const { resourceKey } = req.body ?? {};
  if (typeof resourceKey !== "string") return res.status(400).json({ error: "resourceKey is required" });
  const result = releaseResource(req.orgId!, { id: req.agentId!, name: req.agentName! }, resourceKey);
  if (!result.ok) return res.status(result.error.includes("not you") ? 403 : 404).json(result);
  res.json(result);
});

app.get("/v1/resources", requireAgentAuth, (req: AuthedRequest, res) => {
  res.json({ locks: listResourceLocks(req.orgId!, { orgId: req.orgId!, agentId: req.agentId! }) });
});

// --- Blackboard facts (Stage 2 retro finding) --------------------------------
// key travels in the body/query, never the URL path, same reasoning as resourceKey above -- a key
// like "deploy/target" would otherwise be mangled by route-param slash-splitting.
app.post("/v1/facts", requireAgentAuth, idempotent("POST /v1/facts"), (req: AuthedRequest, res) => {
  const { key, value, expectedVersion } = req.body ?? {};
  if (typeof key !== "string") return res.status(400).json({ error: "key is required" });
  if (typeof value !== "string") return res.status(400).json({ error: "value is required" });
  if (expectedVersion !== undefined && typeof expectedVersion !== "number") return res.status(400).json({ error: "expectedVersion must be a number" });
  try {
    const result = setFact(req.orgId!, { id: req.agentId!, name: req.agentName! }, key, value, { expectedVersion });
    if (!result.ok) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    if (!(err instanceof BlackboardInputError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

app.get("/v1/facts", requireAgentAuth, (req: AuthedRequest, res) => {
  const prefix = typeof req.query.prefix === "string" ? req.query.prefix : undefined;
  res.json({ facts: listFacts(req.orgId!, { prefix }, { orgId: req.orgId!, agentId: req.agentId! }) });
});

app.get("/v1/facts/one", requireAgentAuth, (req: AuthedRequest, res) => {
  const key = typeof req.query.key === "string" ? req.query.key : "";
  if (!key) return res.status(400).json({ error: "key is required" });
  const fact = getFact(req.orgId!, key, { orgId: req.orgId!, agentId: req.agentId! });
  if (!fact) return res.status(404).json({ error: `No fact found for key "${key}"` });
  res.json({ fact });
});

app.post("/v1/facts/delete", requireAgentAuth, idempotent("POST /v1/facts/delete"), (req: AuthedRequest, res) => {
  const { key } = req.body ?? {};
  if (typeof key !== "string") return res.status(400).json({ error: "key is required" });
  const result = deleteFact(req.orgId!, { id: req.agentId!, name: req.agentName! }, key);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// --- Agent reliability (Stage 2 retro finding) -------------------------------
app.get("/v1/reliability", requireAgentAuth, (req: AuthedRequest, res) => {
  const agentId = typeof req.query.agentId === "string" ? req.query.agentId : req.agentId!;
  res.json({ reliability: getAgentReliability(req.orgId!, agentId, { orgId: req.orgId!, agentId: req.agentId! }) });
});

app.get("/v1/reliability/all", requireAgentAuth, (req: AuthedRequest, res) => {
  res.json({ reliability: listAgentReliability(req.orgId!, { orgId: req.orgId!, agentId: req.agentId! }) });
});

// --- Task shape telemetry (Stage 2 retro finding) -----------------------------
app.get("/v1/task-shape-stats", requireAgentAuth, (req: AuthedRequest, res) => {
  res.json({ shapes: getTaskShapeStats(req.orgId!, { orgId: req.orgId!, agentId: req.agentId! }) });
});

// --- Shared project memory --------------------------------------------------
function paginationFrom(query: Request["query"]): { limit?: number; before?: number } {
  const limit = Number(query.limit);
  const before = Number(query.before);
  return { limit: Number.isFinite(limit) ? limit : undefined, before: Number.isFinite(before) ? before : undefined };
}

app.post("/v1/memory", requireAgentAuth, idempotent("POST /v1/memory"), (req: AuthedRequest, res) => {
  const { title, body, tag } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required" });
  if (typeof body !== "string" || !body.trim()) return res.status(400).json({ error: "body is required" });
  if (tag !== undefined && tag !== null && typeof tag !== "string") return res.status(400).json({ error: "tag must be a string" });
  try {
    const entry = createMemory(req.orgId!, { id: req.agentId!, name: req.agentName! }, { title, body, tag });
    res.status(201).json({ entry });
  } catch (err) {
    if (!(err instanceof MemoryInputError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

app.get("/v1/memory", requireAgentAuth, (req: AuthedRequest, res) => {
  const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
  const includeArchived = req.query.includeArchived === "true" || req.query.includeArchived === "1";
  const page = listMemory(req.orgId!, { tag, includeArchived, ...paginationFrom(req.query), viewer: { orgId: req.orgId!, agentId: req.agentId! } });
  // When a plan window can hide rows, say so -- otherwise a short or empty list reads as data loss
  // (PRICING.md §4). Absent entirely when the workspace has no window, so every other response shape is
  // byte-identical to before.
  const retention = retentionNotice(req.orgId!);
  res.json(retention ? { ...page, retention } : page);
});

app.get("/v1/memory/search", requireAgentAuth, (req: AuthedRequest, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  if (!q.trim()) return res.status(400).json({ error: "q is required" });
  const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
  const includeArchived = req.query.includeArchived === "true" || req.query.includeArchived === "1";
  res.json(searchMemory(req.orgId!, q, { tag, includeArchived, ...paginationFrom(req.query), viewer: { orgId: req.orgId!, agentId: req.agentId! } }));
});

app.get("/v1/memory/:id", requireAgentAuth, (req: AuthedRequest, res) => {
  const entry = getMemory(req.orgId!, String(req.params.id), { orgId: req.orgId!, agentId: req.agentId! });
  if (!entry) return res.status(404).json({ error: `No memory entry found matching "${req.params.id}"` });
  res.json({ entry });
});

// A failed memory mutation is a 404 when the entry doesn't exist in this org, and a 409 otherwise (already archived).
function sendMemoryResult(res: Response, result: ReturnType<typeof archiveMemory>) {
  if (result.ok) return res.json(result);
  return res.status(result.error.startsWith("No memory entry found") ? 404 : 409).json(result);
}

app.post("/v1/memory/:id/archive", requireAgentAuth, idempotent("POST /v1/memory/:id/archive"), (req: AuthedRequest, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
  sendMemoryResult(res, archiveMemory(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.id), reason));
});

app.post("/v1/memory/:id/supersede", requireAgentAuth, idempotent("POST /v1/memory/:id/supersede"), (req: AuthedRequest, res) => {
  const { title, body, tag } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required" });
  if (typeof body !== "string" || !body.trim()) return res.status(400).json({ error: "body is required" });
  sendMemoryResult(res, supersedeMemory(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.id), { title, body, tag }));
});

// --- Approval gate (issue #10) ----------------------------------------------
const APPROVAL_STATUSES: ApprovalStatus[] = ["pending", "approved", "denied", "expired", "noted", "withdrawn"];
/** Every approval record a REST response carries goes through this. "withdrawn" reaches only a client that sends
 * X-OpenCadre-Approval-Statuses: withdrawn (the current gate hook and the console do); any other reads it as "denied",
 * with the reason in decision_note, because a gate hook from before #673 would treat an unknown status as no decision and
 * fall through to onTimeout's allow (src/approvals.ts forClientWithoutWithdrawn). */
const approvalFor = (req: AuthedRequest, explicit = false) => (a: ApprovalRecord): ApprovalRecord =>
  explicit || knowsWithdrawn(req.get(APPROVAL_STATUSES_HEADER)) ? a : forClientWithoutWithdrawn(a);
const RISKS: Risk[] = ["low", "medium", "high"];
const numberOr = (raw: unknown) => (typeof raw === "number" ? raw : undefined);

app.post("/v1/approvals", requireAgentAuth, idempotent("POST /v1/approvals"), async (req: AuthedRequest, res) => {
  const { action, details, risk, approver, expiresInSeconds, waitSeconds, category, notifyOnly } = req.body ?? {};
  if (typeof action !== "string" || !action.trim()) return res.status(400).json({ error: "action is required" });
  try {
    const approval = await requestApproval(req.orgId!, { id: req.agentId!, name: req.agentName! }, {
      action,
      details: typeof details === "string" ? details : null,
      risk: RISKS.find((r) => r === risk),
      approver: typeof approver === "string" ? approver : null,
      expiresInSeconds: numberOr(expiresInSeconds),
      waitSeconds: numberOr(waitSeconds),
      category: typeof category === "string" ? category : null,
      notifyOnly: notifyOnly === true,
    });
    res.status(201).json({ approval: approvalFor(req)(approval) });
  } catch (err) {
    res.status(err instanceof NotReachableError ? 403 : 400).json({ error: (err as Error).message, ...(err instanceof NotReachableError ? { code: NOT_REACHABLE } : {}) });
  }
});

app.get("/v1/approvals", requireAgentAuth, (req: AuthedRequest, res) => {
  const status = APPROVAL_STATUSES.find((s) => s === req.query.status);
  // Notify-only ("noted") records are left out unless asked for (board task cf34b4c2): includeNoted=true, or
  // status=noted. notedHidden says how many were left out. A read filter only; nothing is deleted.
  const hideNoted = !status && !(req.query.includeNoted === "true" || req.query.includeNoted === "1");
  res.json({
    // Asking for status=withdrawn by name is asking for the status.
    approvals: listApprovals(req.orgId!, { status, viewer: req.agentId!, hideNoted }).map(approvalFor(req, status === "withdrawn")),
    notedHidden: hideNoted ? countNotedApprovals(req.orgId!, req.agentId!) : 0,
  });
});

// One request, e.g. for the console card a phone notification opens, without loading the whole history.
app.get("/v1/approvals/:approvalId", requireAgentAuth, (req: AuthedRequest, res) => {
  const approval = getApprovalById(req.orgId!, String(req.params.approvalId), req.agentId!);
  if (!approval) return res.status(404).json({ error: `No approval request found matching "${req.params.approvalId}"` });
  res.json({ approval: approvalFor(req)(approval) });
});

app.get("/v1/approvals/:approvalId/wait", requireAgentAuth, async (req: AuthedRequest, res) => {
  const raw = Number(req.query.timeoutSeconds);
  const approval = await waitForApproval(req.orgId!, String(req.params.approvalId), Number.isFinite(raw) && raw > 0 ? raw : 55, req.agentId!);
  if (!approval) return res.status(404).json({ error: `No approval request found matching "${req.params.approvalId}"` });
  res.json({ approval: approvalFor(req)(approval) });
});

app.post("/v1/approvals/:approvalId/decide", requireAgentAuth, requirePermission("approval.decide"), idempotent("POST /v1/approvals/:approvalId/decide"), (req: AuthedRequest, res) => {
  const { decision, note, grantMinutes } = req.body ?? {};
  if (decision !== "approve" && decision !== "deny") return res.status(400).json({ error: 'decision must be "approve" or "deny"' });
  // A person's decision comes only from the console session path (requireMemberSession sets req.person). An agent key, a
  // device credential (dev_) or anything else bearer-authenticated carries no person, whoever holds it, and a clearance
  // refuses it (src/approvals.ts decideApproval).
  const person = req.person ? { id: req.person.id, name: displayName(req.person), channel: "console" as const } : null;
  const result = decideApproval(req.orgId!, { id: req.agentId!, name: req.agentName!, person }, String(req.params.approvalId), decision,
    typeof note === "string" ? note : null, { grantMinutes: numberOr(grantMinutes) });
  if (result.ok) return res.json(result);
  res.status(result.code === "person_required" ? 403 : result.error.startsWith("No approval request") ? 404 : 409).json(result);
});

// The agent that asked takes its own pending request back (fleet coordination plan, failure 5). "The agent that asked" is
// the same agent identity: sessions that share one (a folder agent, one device credential) can withdraw each other's
// requests, an accepted part of the current identity model. Its own response says "withdrawn": only a client that knows
// the status calls this route. No role is needed: only the
// requester can, which withdrawApproval checks in the same UPDATE that withdraws it. 404 outside the caller's sight, 403 for
// anyone else (a person included: they deny instead), 409 once it is no longer pending.
app.post("/v1/approvals/:approvalId/withdraw", requireAgentAuth, idempotent("POST /v1/approvals/:approvalId/withdraw"), (req: AuthedRequest, res) => {
  const { note } = req.body ?? {};
  const result = withdrawApproval(req.orgId!, { id: req.agentId!, name: req.agentName! }, String(req.params.approvalId), typeof note === "string" ? note : null);
  if (result.ok) return res.json(result);
  res.status(result.code === "not_found" ? 404 : result.code === "not_requester" ? 403 : 409).json(result);
});

app.get("/v1/approval-grants", requireAgentAuth, (req: AuthedRequest, res) => {
  res.json({ grants: listApprovalGrants(req.orgId!, req.agentId!) });
});

app.delete("/v1/approval-grants/:grantId", requireAgentAuth, requirePermission("approvalGrant.revoke"), (req: AuthedRequest, res) => {
  if (!revokeApprovalGrant(req.orgId!, String(req.params.grantId), { id: req.agentId!, name: req.agentName! })) {
    return res.status(404).json({ error: "grant not found" });
  }
  res.json({ ok: true });
});

// --- Clearance policy (R4) ----------------------------------------------------
// Gates read the mode for their project; only operators change it.
const PROJECT_ERROR = "project must be a git remote such as github.com/owner/repo";

/** The clearance policy key of a project key: its normalized remote, or "" (the workspace default) for a key with no remote. */
const policyKeyOf = (projectKey: string) => (projectKey.includes("/") && !/^local:/i.test(projectKey) ? normalizeProject(projectKey) ?? "" : "");

app.get("/v1/clearance-policy", requireAgentAuth, (req: AuthedRequest, res) => {
  const requested = normalizeProject(req.query.project);
  if (requested === null) return res.status(400).json({ error: PROJECT_ERROR });
  // With project isolation on, an agent reads the policy of its own project, not whatever ?project= names: the named project
  // when it is one of the agent's own, else its home project (PROJECT_ISOLATION.md §5). Workspace-wide callers read any.
  let project = requested;
  const caller = { orgId: req.orgId!, agentId: req.agentId! };
  const visible = visibleOf(caller);
  if (projectIsolationEnabled(req.orgId!) && !visible.all) {
    const own = visible.keys.map(policyKeyOf);
    project = own.includes(requested) ? requested : own[0] ?? "";
  }
  res.json({ policy: getClearancePolicy(req.orgId!, project) });
});

app.get("/v1/clearance-policies", requireAgentAuth, requirePermission("clearancePolicy.list"), (req: AuthedRequest, res) => {
  res.json({ policies: listClearancePolicies(req.orgId!) });
});

/** Only a signed-in owner or admin PERSON changes clearance policy. A clearance is a person's decision (src/approvals.ts),
 * so a key that could set Ask to Off, or delete Strict so it falls back to the default Off, would skip clearances
 * altogether -- an Operator key is owner by roleFor, and a fleet's agents can hold one. Keys keep read access (GET). The
 * role rule after this (clearancePolicy.write: admin) still refuses a member. */
function requirePersonForPolicy(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.person) {
    return res.status(403).json({ error: "Only a signed-in owner or admin can change clearance policy, in OpenCadre on their phone or computer. An agent or Operator key can read it but not change it." });
  }
  next();
}

app.put("/v1/clearance-policy", requireAgentAuth, requirePersonForPolicy, requirePermission("clearancePolicy.write"), (req: AuthedRequest, res) => {
  const { project: rawProject, mode } = req.body ?? {};
  const project = normalizeProject(rawProject);
  if (project === null) return res.status(400).json({ error: PROJECT_ERROR });
  if (!isClearanceMode(mode)) return res.status(400).json({ error: 'mode must be "off", "notify", "ask" or "strict"' });
  res.json({ policy: setClearancePolicy(req.orgId!, { id: req.agentId!, name: req.agentName! }, project, mode) });
});

app.delete("/v1/clearance-policy", requireAgentAuth, requirePersonForPolicy, requirePermission("clearancePolicy.write"), (req: AuthedRequest, res) => {
  const project = normalizeProject(req.query.project);
  if (project === null) return res.status(400).json({ error: PROJECT_ERROR });
  if (!clearClearancePolicy(req.orgId!, { id: req.agentId!, name: req.agentName! }, project)) {
    return res.status(404).json({ error: "no clearance policy set for this project" });
  }
  res.json({ ok: true, policy: getClearancePolicy(req.orgId!, project) });
});

// A hook that runs after a command reports each risky command it saw run (src/clearance-bypass.ts).
app.post("/v1/clearances/executed", requireAgentAuth, idempotent("POST /v1/clearances/executed"), async (req: AuthedRequest, res) => {
  const { action, required, category, risk, approver, details } = req.body ?? {};
  if (typeof action !== "string" || !action.trim()) return res.status(400).json({ error: "action is required" });
  if (required !== "record" && required !== "approval") return res.status(400).json({ error: 'required must be "record" or "approval"' });
  try {
    res.json(await reportExecuted(req.orgId!, { id: req.agentId!, name: req.agentName! }, {
      action,
      required,
      category: typeof category === "string" ? category : null,
      risk: RISKS.find((r) => r === risk),
      approver: typeof approver === "string" ? approver : null,
      details: typeof details === "string" ? details : null,
    }));
  } catch (err) {
    res.status(err instanceof NotReachableError ? 403 : 400).json({ error: (err as Error).message, ...(err instanceof NotReachableError ? { code: NOT_REACHABLE } : {}) });
  }
});

// A gate handed a risky command back to the tool's own permission settings because its onTimeout / onHubUnreachable is
// "allow" (F7 / Q1f): a POLICY PASS, recorded as clearance.policy_pass. A separate route on purpose: /executed says a
// command RAN (and raises a bypass), which a pre-execution hook cannot know; this says only that OpenCadre expressed no
// opinion. Sent live, or later from the gate's offline queue under the same receipt id (recorded once).
const RECEIPT_ID = /^[A-Za-z0-9-]{8,64}$/;
app.post("/v1/clearances/policy-pass", requireAgentAuth, async (req: AuthedRequest, res) => {
  const { receiptId, reason, action, category, risk, approvalId, client, project, occurredAt, delivery } = req.body ?? {};
  if (typeof receiptId !== "string" || !RECEIPT_ID.test(receiptId)) return res.status(400).json({ error: "receiptId must be 8-64 letters, digits or -" });
  if (!POLICY_PASS_REASONS.includes(reason)) return res.status(400).json({ error: 'reason must be "timeout" or "hub_unreachable"' });
  if (typeof action !== "string" || !action.trim()) return res.status(400).json({ error: "action is required" });
  if (delivery !== "live" && delivery !== "queued") return res.status(400).json({ error: 'delivery must be "live" or "queued"' });
  const at = typeof occurredAt === "string" ? Date.parse(occurredAt) : NaN;
  // A queued record lives at most 7 days on the gate's machine; anything older, or from the future, is not one.
  if (!Number.isFinite(at) || at > Date.now() + 5 * 60_000 || at < Date.now() - 8 * 24 * 60 * 60_000) {
    return res.status(400).json({ error: "occurredAt must be an ISO time within the last 8 days" });
  }
  const short = (v: unknown, max: number, pattern = /^[\w.:/@~-]+$/) => (typeof v === "string" && v.length <= max && pattern.test(v) ? v : null);
  try {
    res.json(recordPolicyPass(req.orgId!, { id: req.agentId!, name: req.agentName! }, {
      receiptId,
      reason,
      action,
      category: short(category, 64),
      risk: RISKS.find((r) => r === risk),
      approvalId: short(approvalId, 64),
      client: short(client, 32),
      project: short(project, 200),
      occurredAt: new Date(at).toISOString(),
      delivery,
    }));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// First-run checklist (R5): computed from what exists in the workspace, never ticked by hand.
app.get("/v1/onboarding", requireAgentAuth, (req: AuthedRequest, res) => {
  // The checklist names agents and message senders from the whole workspace: with project isolation on, it is for people
  // and workspace-wide agents only (the console), not for an agent confined to a project.
  if (!visibleOf({ orgId: req.orgId!, agentId: req.agentId! }).all) return res.status(403).json({ error: "The first-run checklist covers the whole workspace; it isn't available to an agent in one project." });
  res.json(onboardingProgress(req.orgId!));
});

app.get("/v1/me", requireAgentAuth, (req: AuthedRequest, res) => {
  const nowMs = Date.now();
  const org = db.prepare(`SELECT name FROM organizations WHERE id = ?`).get(req.orgId!) as { name: string } | undefined;
  // The webhook secret is write-only: report only whether one is set.
  const hook = db.prepare(`SELECT webhook_url, webhook_auth_header IS NOT NULL AS auth_set FROM agents WHERE id = ?`)
    .get(req.agentId!) as { webhook_url: string | null; auth_set: number } | undefined;
  res.json({
    agentId: req.agentId, agentName: req.agentName, role: req.agentRole, orgId: req.orgId, orgName: org?.name ?? null,
    // A signed-in person's membership role in this workspace, read fresh on every request (null for a key sign-in). The
    // console compares it on each refresh: owner and admin share the agent role "operator", so `role` alone cannot show a
    // change between them.
    memberRole: req.person ? req.memberRole ?? null : null,
    webhook_url: hook?.webhook_url ?? null, webhook_auth_set: Boolean(hook?.auth_set),
    workspace: workspacePauseState(req.orgId!),
    // The hub agents and apps connect to. The console is served on another host in production (docs/ops/PRODUCTION.md),
    // so its "Connect an app" links and commands take this rather than the page's own origin.
    hubUrl: publicHubUrl(),
    // What an agent needs to tell "my workspace lapsed" apart from "my key is bad": the plan, the
    // date the clock runs out, and the limits the plan carries. A GET, so it keeps answering after
    // the workspace goes read-only -- which is the only way a refused agent can find out why.
    // `used.agents`: the live-agent count the limit is enforced against (countLiveAgents, one clock with the billing read),
    // a workspace aggregate with no names or projects; null when src/live-count.ts withholds it, as on every 402.
    billing: { ...workspaceBilling(req.orgId!, nowMs), used: { agents: liveAgentsFor(req.orgId!, req.person ? "member" : "agent", nowMs) } },
  });
});

// --- Web console (issue #19) --------------------------------------------------
// Static, no build step. Resolved relative to this module so it works from
// both src/ (tests, tsx) and dist/ (production): both sit next to public/.
const CONSOLE_DIR = fileURLToPath(new URL("../public/app/", import.meta.url));
// The console loads no third-party script. CONSOLE_CSP_STRICT is the console-family policy; the OAuth consent and error
// pages use it as it is (sendOauthPage).
const CONSOLE_CSP_STRICT = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
const CONSOLE_CSP = CONSOLE_CSP_STRICT;

// The console's page names each of its own assets with the running version (`/app/app.js?v=625bd23`), and is itself never
// cached. A CDN in front of the hub (Cloudflare, 4 h on static files) served the pre-deploy console-v2.css against the
// new index.html after a deploy: new markup, old styles, a broken sidebar. A versioned URL is a new cache key on every
// deploy, so the page can only ever load the assets it was built with. The shared stylesheets under /shared/ are
// versioned too: app.css's roles are var() references to /shared/tokens.css's primitives, so a stale cached copy of the
// shared file would leave every role unresolved (design-token plan s7).
const ASSET_VERSION = (process.env.OPENCADRE_VERSION || "dev").replace(/[^A-Za-z0-9._-]/g, "") || "dev";
let consoleIndexCache: string | null = null;
export function versionedConsoleIndex(version = ASSET_VERSION): string {
  if (consoleIndexCache !== null && version === ASSET_VERSION && process.env.NODE_ENV === "production") return consoleIndexCache;
  const html = readFileSync(`${CONSOLE_DIR}index.html`, "utf8")
    .replace(/(href|src)="(\/app\/[^"?#]+\.(?:css|js|webmanifest|png|svg)|\/shared\/[^"?#]+\.css)"/g, `$1="$2?v=${version}"`)
    // The console is not for search: noindex here and in the X-Robots-Tag header the route sends (src/site-seo.ts).
    .replace(/<head>/i, '<head>\n  <meta name="robots" content="noindex">');
  if (version === ASSET_VERSION) consoleIndexCache = html;
  return html;
}
/** A request path as express.static (send) resolves it on the host's disk: percent-decoded, a backslash taken as a
 * separator (send normalises with the native path module, which on Windows does; Codex on ff873e49 found
 * /app/%5cindex.html and /app/foo%5c..%5cindex.html serving the raw file), dot segments resolved, and lowercased for
 * a case-insensitive disk. Throws on a malformed escape. The route guards below decide on THIS path, never the raw one. */
function staticRequestPath(rawPath: string): string {
  return posix.normalize(decodeURIComponent(rawPath).replace(/\\/g, "/")).toLowerCase();
}

app.use("/app", (req, res, next) => {
  res.setHeader("Content-Security-Policy", CONSOLE_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // The static server below DECODES the path, resolves dot segments, and the disk is case-insensitive on Windows, so
  // /app/%69ndex.html, /app/INDEX.HTML or /app/%2e/index.html used to reach the raw file: no noindex, no X-Robots-Tag,
  // unversioned assets. The entry is decided on the path as the static server would see it (staticRequestPath):
  // decoded, backslashes as separators, normalised and lowercased, so every spelling of index.html gets the rendered
  // index below.
  let entry: string;
  try {
    entry = staticRequestPath(req.path);
  } catch {
    return res.status(400).type("text").send("Bad request");
  }
  if ((req.method === "GET" || req.method === "HEAD") && (entry === "/" || entry === "/index.html")) {
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Robots-Tag", "noindex");
    return res.type("html").send(versionedConsoleIndex());
  }
  next();
}, express.static(CONSOLE_DIR, { index: false, maxAge: "5m" }));

// --- Shared assets and the CLI package -----------------------------------------
// Headers for everything served outside /app and /v1: the shared stylesheets and icons, and the CLI download.
const siteHeaders = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Content-Security-Policy", CONSOLE_CSP_STRICT);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
};

const SHARED_DIR = fileURLToPath(new URL("../public/shared/", import.meta.url));
// The shared stylesheets are revalidated on every load (no-cache, answered by ETag), not cached for 5 minutes: every
// surface's roles resolve through /shared/tokens.css, and the site's pages link it without a version, so a copy held
// past a deploy would pair new roles with old primitives (design-token plan s7). The brand images keep their TTL.
app.use("/shared", siteHeaders, express.static(SHARED_DIR, {
  index: false,
  maxAge: "5m",
  setHeaders: (res, filePath) => { if (filePath.endsWith(".css")) res.setHeader("Cache-Control", "no-cache"); },
}));
// Pages link their icons from /shared/brand, but browsers, feed readers and link unfurlers still ask for /favicon.ico
// on every host (the console's app. host included), and a 404 there leaves a blank tab icon.
app.get("/favicon.ico", siteHeaders, (_req, res, next) =>
  res.sendFile("favicon.ico", { root: `${SHARED_DIR}brand`, maxAge: "1d" }, (err) => err && next(err)));

// The connect command installs the CLI straight from the hub: no registry account or publish step. Every command the hub
// prints now names the stamped alias below; this bare route stays for commands printed before, including their `?v=`.
// guard-allow(bare-route): the route's own path, not a printed command. tests/cli-unstamped-guard.test.ts lists it.
app.get("/cli/opencadre-cli.tgz", siteHeaders, (_req, res, next) => {
  const file = process.env.OPENCADRE_CLI_TARBALL || CLI_TARBALL;
  if (!existsSync(file)) return res.status(503).json({ error: "The OpenCadre CLI package isn't built on this hub. Run npm run build on the hub." });
  res.type("application/gzip");
  // `dotfiles: "allow"` because this path is CONFIG-SUPPLIED, not user-supplied — and because the
  // default ("ignore") silently 404s the whole route whenever the tarball sits under a dot-directory.
  // Measured 2026-09-20 on express 5.2.1: send's own `containsDotFile` (send/index.js:810) rejects any
  // path segment starting with ".", so `~/.opencadre/bin/opencadre-cli.tgz` answers 404 while the same
  // file under `dist/cli/` answers 200. The deployed hub is unaffected (Dockerfile WORKDIR /app), but a
  // hub under `~/.opencadre`, a self-hosted instance, or any dotted workdir would serve a route that
  // works in the state nobody tests and breaks in the state that ships.
  //
  // The `existsSync` guard above is what makes this safe: `file` is only ever the configured path (the
  // CLI_TARBALL constant or OPENCADRE_CLI_TARBALL), never a request value, so there is no traversal to
  // protect against here. On an attacker-influenced path this same option WOULD be a traversal hole.
  res.sendFile(file, { maxAge: "5m", dotfiles: "allow" }, (err) => err && next(err));
});

// Q1g: what the hub's CLI package IS, public and unauthenticated (ruling 049a §1: build identity, helper and import hashes
// and the package's address carry no credential). build.json from INSIDE the served tarball, plus that tarball's digest,
// size, stamp, immutable address and the one upgrade command, all from one snapshot of one buffer (src/cli-package.ts), so
// this answer and the package can never describe different builds. `doctor` prints `command` from here, and prints NO
// URL when this cannot be read (ruling §4). no-cache: every read revalidates, since the answer changes with each deploy.
app.get("/cli/manifest.json", siteHeaders, (_req, res) => {
  const manifest = cliManifest(publicHubUrl());
  res.setHeader("Cache-Control", "no-cache");
  res.status(manifest.status).json(manifest.body);
});

// The immutable, content-addressed alias every printed command now uses: /cli/<first 12 hex of sha256>/opencadre-cli.tgz.
// It serves the snapshot's exact buffer ONLY when the requested stamp is the current package's, and answers 404 for any
// other, including every stamp a previous deploy printed: never current bytes under an old address (ruling §1). That is
// what makes `immutable` with a year's max-age true, where the bare route has to keep a short TTL. A stamp that is not
// 12 lowercase hex is the same 404; the parameter is only ever compared, never used as a path.
app.get("/cli/:stamp/opencadre-cli.tgz", siteHeaders, (req, res) => {
  const stamp = String(req.params.stamp);
  const pkg = currentCliPackage();
  if (!STAMP_PATTERN.test(stamp) || !pkg || pkg.stamp !== stamp) {
    return res.status(404).json({ error: "No CLI package with that stamp on this hub. Copy the current command from the console, or read /cli/manifest.json." });
  }
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.type("application/gzip").send(pkg.bytes);
});

// This hub serves the console, the API, MCP and the CLI package. It has no marketing site: the root sends a browser to
// the console, keeping any query string.
app.get("/", (req, res) => {
  const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(302, `/app/${query}`);
});

// The deploy script keeps a new image only if this answers ok, so it proves the database
// can run a query. OPENCADRE_VERSION is the git sha the deploy script sets on the container.
// With OPENCADRE_REQUIRE_CLI_PROVENANCE=1 it also proves the CLI package can recognise official
// old helpers (src/cli-provenance-guard.ts), so an image built without deploy provenance rolls back.
app.get("/health", (_req, res) => {
  try {
    db.prepare("SELECT 1").get();
  } catch {
    return res.status(503).json({ status: "error", error: "database unavailable" });
  }
  const provenanceProblem = cliProvenanceProblem();
  if (provenanceProblem) return res.status(503).json({ status: "error", error: `CLI package provenance: ${provenanceProblem}` });
  res.json({ status: "ok", version: process.env.OPENCADRE_VERSION ?? null });
});

/** Metrics are hub-wide (every org's traffic), so no org key may read them, not even an operator's:
 * only OPENCADRE_METRICS_TOKEN (read-only, for an uptime monitor) or the hub's OPENCADRE_ADMIN_TOKEN. */
function requireMetricsAccess(req: Request, res: Response, next: NextFunction) {
  const given = Buffer.from(bearer(req) ?? "");
  const matches = (secret: string | undefined) => {
    if (!secret) return false;
    const expected = Buffer.from(secret);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  if (matches(process.env.OPENCADRE_METRICS_TOKEN) || matches(process.env.OPENCADRE_ADMIN_TOKEN)) return next();
  res.status(401).json({ error: "metrics token required" });
}

// Hub-wide numbers for alerting: a 5-minute window (5xx rate, p50/p95 latency without long-polls),
// totals since start, live connection gauges, and alerts.healthy for a JSON-query uptime monitor.
app.get("/v1/metrics", requireMetricsAccess, (_req, res) => {
  const schema = db.prepare(`SELECT MAX(version) AS v FROM schema_migrations`).get() as { v: number | null };
  res.json({
    version: process.env.OPENCADRE_VERSION ?? null,
    schemaVersion: schema.v,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    ...windowStats(),
    totals: totalsSnapshot(),
    live: { sockets: liveSocketCount(), inboxWaiters: pendingInboxWaiterCount(), eventWaiters: pendingEventWaiterCount() },
  });
});

