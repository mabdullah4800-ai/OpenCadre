import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { log } from "./log.js";
import { recordRequest, requestFinished, requestStarted } from "./metrics.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Only accept a caller-supplied request id that is short and plain, so it can't inject into logs. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** API traffic is logged at info; site assets and the console's static files at debug. */
const isApi = (path: string) => path === "/mcp" || path === "/health" || path.startsWith("/v1/");

/** Wraps the hub's HTTP handler: gives every request an id (echoed as x-request-id) and logs one line
 * when the response finishes, with method, path (never the query string), status, duration and, once
 * authenticated, the org and agent ids. Long-polls log when they return, so `ms` is their wait time. */
export function withRequestLog(handler: Handler): Handler {
  return (req, res) => {
    const incoming = req.headers["x-request-id"];
    const requestId = typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader("x-request-id", requestId);
    const started = process.hrtime.bigint();
    const tracked = requestStarted();
    res.on("close", () => requestFinished(tracked));
    // The IndexNow key file's path names the key itself (src/site-indexnow.ts), so the log writes it redacted.
    const path = (req.url ?? "").split("?")[0];
    res.on("finish", () => {
      const authed = req as IncomingMessage & { orgId?: string; agentId?: string };
      const fields = {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
        ...(authed.orgId && { orgId: authed.orgId }),
        ...(authed.agentId && { agentId: authed.agentId }),
      };
      recordRequest(path, res.statusCode, fields.ms);
      if (res.statusCode >= 500) log.error("request", fields);
      else if (isApi(path)) log.info("request", fields);
      else log.debug("request", fields);
    });
    handler(req, res);
  };
}
