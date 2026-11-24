import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { authenticateLiveRequest } from "./live-auth.js";
import { registerSocket, trackKeepalive } from "./live.js";
import { registerConsoleSocket } from "./console-live.js";
import { heartbeat } from "./service.js";
import { log } from "./log.js";

export const LIVE_MAX_PAYLOAD_BYTES = 64 * 1024;

/** Shared production WebSocket wiring, also used by the local real-socket tests. */
export function acceptLiveConnection(ws: WebSocket, req: IncomingMessage): void {
  // Protocol errors (including oversized frames) must close this socket, not the hub.
  ws.on("error", () => ws.terminate());
  let auth: ReturnType<typeof authenticateLiveRequest>;
  try {
    auth = authenticateLiveRequest(req);
  } catch {
    ws.close(1011, "Could not authenticate this connection");
    return;
  }
  if (!auth.ok) {
    ws.close(auth.code, auth.reason);
    return;
  }
  if (auth.kind === "console") {
    registerConsoleSocket(ws, auth);
    log.info("console live socket connected", { orgId: auth.orgId });
    ws.on("close", (code) => log.info("console live socket closed", { orgId: auth.orgId, code }));
    trackKeepalive(ws, () => heartbeat(auth.orgId, auth.agentId));
    heartbeat(auth.orgId, auth.agentId);
    ws.on("message", () => heartbeat(auth.orgId, auth.agentId));
    return;
  }
  registerSocket(auth.agentId, ws);
  log.info("live socket connected", { orgId: auth.orgId, agentId: auth.agentId });
  ws.on("close", (code) => log.info("live socket closed", { orgId: auth.orgId, agentId: auth.agentId, code }));
  trackKeepalive(ws, () => heartbeat(auth.orgId, auth.agentId));
  heartbeat(auth.orgId, auth.agentId);
  ws.on("message", () => {
    // Live is push-only; an agent frame keeps that same authenticated agent live.
    heartbeat(auth.orgId, auth.agentId);
  });
}
