import http from "node:http";
import proxyaddr from "proxy-addr";
import { WebSocketServer } from "ws";
import { app } from "./rest.js";
import { handleMcpRequest } from "./mcp.js";
import { readMcpBody } from "./mcp-http.js";
import { authenticateAgentKey, isPausedWorkspaceKey } from "./auth.js";
import { sweepKeepalive } from "./live.js";
import { acceptLiveConnection, LIVE_MAX_PAYLOAD_BYTES } from "./live-connection.js";
import { sweepConsoleLive } from "./console-live.js";
import { beginShutdown } from "./shutdown.js";
import { isDraining } from "./draining.js";
import { sweepStaleAgents } from "./service.js";
import { sweepEscalations } from "./escalation.js";
import { sweepIdleSessions } from "./devices.js";
import { rebuildTaskSearchText, sweepAllExpiredLeases } from "./tasks.js";
import { sweepHubHealth } from "./ops-alerts.js";
import { sweepIdempotencyKeys } from "./idempotency.js";
import { sweepExpiredSessions } from "./accounts.js";
import { pruneDeadTokens, pruneExpiredCodes, pruneStaleDcrClients } from "./oauth.js";
import { oauthSecretFrom, pruneDeadConsents } from "./oauth-authorize.js";
import { cursorSecretFrom } from "./task-cursor.js";
import { emailSender } from "./mailer.js";
import { billingEnabled, trialMode, trialModeProblem } from "./billing.js";
import { createRateLimiter, rateLimitKey, requestsPerMinute } from "./ratelimit.js";
import { withRequestLog } from "./http-log.js";
import { log } from "./log.js";
import { privateWebhooksRequested } from "./webhook-guard.js";
import { reportCliProvenanceAtStartup } from "./cli-provenance-guard.js";
import { db } from "./db.js";
import { projectIsolationPreflight } from "./project-preflight.js";

// MCP endpoint is handled outside Express's own body parser (it needs the
// raw stream + its own JSON parsing per the SDK's transport), so it's wired
// directly on the underlying http.Server before Express's router sees it.
const mcpLimiter = createRateLimiter({ limit: requestsPerMinute(), windowMs: 60_000 });

const server = http.createServer(withRequestLog((req, res) => {
  // While draining, don't keep the connection alive for a process that's about to exit.
  if (isDraining()) res.setHeader("connection", "close");
  // DELETE terminates an MCP session explicitly (src/mcp.ts's routeMcpTransport +
  // StreamableHTTPServerTransport already implement this fully -- this route just needs to let a
  // DELETE reach it at all, same as POST always did). A plain client.close() does NOT send this
  // (confirmed by reading the SDK client: close() only aborts locally) -- a client must call
  // transport.terminateSession() explicitly to reach here. The idle sweep (mcp.ts) is still the
  // load-bearing cleanup for the common case; this closes the loop for clients that do call it.
  if (req.url === "/mcp" && (req.method === "POST" || req.method === "DELETE")) {
    const auth = req.headers["authorization"];
    const limited = mcpLimiter.check(rateLimitKey(typeof auth === "string" ? auth : undefined, proxyaddr(req, app.get("trust proxy fn"))));
    if (!limited.ok) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(limited.retryAfterSeconds) });
      res.end(JSON.stringify({ error: "rate limit exceeded", retryAfterSeconds: limited.retryAfterSeconds }));
      return;
    }
    readMcpBody(req, res, async (body) => {
      (req as unknown as { body: unknown }).body = body;
      await handleMcpRequest(req, res);
    });
    return;
  }
  app(req, res);
}));

const wss = new WebSocketServer({ server, path: "/live", maxPayload: LIVE_MAX_PAYLOAD_BYTES });
// 30s stays well under common proxy idle timeouts (Cloudflare ~100s, many LBs 60s).
setInterval(() => {
  sweepKeepalive(wss.clients);
  void sweepConsoleLive();
}, 30_000).unref();
wss.on("connection", (ws, req) => acceptLiveConnection(ws, req));

const PORT = Number(process.env.PORT || 8787);
const SWEEP_INTERVAL_MS = 60_000;
server.listen(PORT, () => {
  if (privateWebhooksRequested()) {
    log.error(process.env.NODE_ENV === "production"
      ? "OPENCADRE_WEBHOOK_ALLOW_PRIVATE is set in production and is being ignored; remove it"
      : "OPENCADRE_WEBHOOK_ALLOW_PRIVATE is set: webhook SSRF protection is off (local development only)");
  }
  log.info("opencadre listening", { port: PORT, rest: "/v1", mcp: "/mcp", live: "/live", version: process.env.OPENCADRE_VERSION ?? null });
  // OPENCADRE_REQUIRE_CLI_PROVENANCE=1: name the reason /health will refuse, every boot (src/cli-provenance-guard.ts).
  reportCliProvenanceAtStartup();
  log.info("transactional email", { provider: emailSender().describe() });
  // The trial mode is an ops control (src/billing.ts trialMode): say which one this process runs, every boot.
  // Billing is off unless OPENCADRE_BILLING=on: new workspaces then start on the non-expiring plan (src/billing.ts).
  log.info("billing", { enabled: billingEnabled() });
  if (billingEnabled()) log.info("trial mode", { mode: trialMode(), newWorkspaces: trialMode() === "card" ? "no plan until a 7-day card-required trial starts in checkout" : "hub-side cardless trial" });
  const trialProblem = trialModeProblem();
  if (trialProblem) log.error(`trial mode misconfigured: ${trialProblem}`);
  // A configured OAuth secret that is too short is not used; say so once, at startup (src/oauth-authorize.ts).
  const oauthSecretProblem = oauthSecretFrom(process.env).problem;
  if (oauthSecretProblem) log.warn(oauthSecretProblem);
  // The same for the task list cursor key (src/task-cursor.ts).
  const cursorSecretProblem = cursorSecretFrom(process.env).problem;
  if (cursorSecretProblem) log.warn(cursorSecretProblem);
  // Task search reads only text indexed under the current masking version (migration 54): rebuild every stale row now,
  // in bounded batches that yield between them, so a masking change or a fresh migration is caught up soon after boot.
  // Until a row is rebuilt it matches no search at all (fail closed), so the hub serves meanwhile.
  (() => {
    let rebuilt = 0;
    const started = Date.now();
    const step = () => {
      try {
        const n = rebuildTaskSearchText();
        rebuilt += n;
        if (n > 0) return void setImmediate(step);
        if (rebuilt) log.info("task search index rebuilt", { rows: rebuilt, ms: Date.now() - started });
      } catch (err) {
        log.warn("task search index rebuild failed; unindexed tasks match no search until the next start", { error: err });
      }
    };
    setImmediate(step);
  })();
  // A workspace enforcing project isolation while a repository is split across project keys has a fleet cut in two
  // (PROJECT_ISOLATION.md §7 item 3): say so at startup. Switching isolation on already refuses in that state.
  try {
    const enforcing = db.prepare(`SELECT id FROM organizations WHERE project_isolation = 1`).pluck().all() as string[];
    for (const orgId of enforcing) {
      const [report] = projectIsolationPreflight(db, { orgId }).workspaces;
      if (report?.splits.length) log.warn("project isolation is on but a repository is split across project keys", { orgId, splits: report.splits.map((s) => ({ name: s.name, keys: s.keys.map((k) => k.projectKey) })) });
    }
  } catch (err) {
    log.warn("project isolation pre-flight check failed", { error: err });
  }
  // Heartbeat staleness sweep -- only in the real server bootstrap path
  // (npm start / this module). Tests import rest/service directly and must
  // not start a live interval; they call sweepStaleAgents() themselves.
  const sweepTimer = setInterval(() => {
    try {
      sweepStaleAgents();
    } catch (err) {
      log.warn("stale agent sweep failed", { error: err });
    }
    try {
      sweepIdleSessions();
    } catch (err) {
      log.warn("idle session sweep failed", { error: err });
    }
    // Notice only: tells a claimant its task lease lapsed, on time rather than on the workspace's next read.
    // It never releases a task or changes its status, claimant or lease (src/tasks.ts sweepExpiredLeases).
    try {
      sweepAllExpiredLeases();
    } catch (err) {
      log.warn("task lease expiry sweep failed", { error: err });
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
});

// Started here, not in rest.ts, so tests that import the app never run a real timer.
setInterval(() => {
  sweepEscalations(new Date()).catch((err) => log.warn("escalation sweep failed", { error: err }));
  sweepHubHealth().catch((err) => log.warn("hub health sweep failed", { error: err }));
  try {
    sweepIdempotencyKeys();
    sweepExpiredSessions();
  } catch (err) {
    log.warn("idempotency key sweep failed", { error: err });
  }
  // Open registration must not accumulate forever: unused DCR clients go after 30 days (src/oauth.ts).
  try {
    pruneDeadConsents();
    pruneExpiredCodes();
    pruneDeadTokens();
    pruneStaleDcrClients();
  } catch (err) {
    log.warn("stale OAuth client sweep failed", { error: err });
  }
}, 60_000).unref();

// Any client mid wait_for_message / GET /v1/messages/wait (or a timeline or
// approval wait) has no way to know this process is about to exit -- without
// unblocking them here, they hang on a dead connection until their own
// client-side timeout, up to 280s. A real ~5min blind window was observed
// live during a hub restart.
function gracefulShutdown(signal: string): void {
  log.info("shutdown: resolving pending long-polls before exit", { signal });
  beginShutdown();
  server.close(() => process.exit(0));
  // Force-exit if something (e.g. a lingering WS) keeps the event loop
  // alive past a reasonable grace period.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
