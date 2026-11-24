// Genuine live push layer. Since this service owns its whole stack (unlike
// the Paperclip-plugin version, which had to borrow ctx.agents.sessions),
// this is real server-controlled push: each connected agent holds one
// WebSocket, and we push straight down it the moment a message arrives.

import type { WebSocket } from "ws";
import { isDraining } from "./draining.js";

const sockets = new Map<string, WebSocket>();
/** Every open socket per agent: a reconnect replaces the push target above, but an older socket can still be open. */
const agentSockets = new Map<string, Set<WebSocket>>();
const pendingReplyWaiters = new Map<string, (body: string) => void>();

/** Gauges for /v1/metrics. */
export function liveSocketCount(): number {
  return sockets.size;
}
export function pendingInboxWaiterCount(): number {
  let n = 0;
  for (const list of pendingInboxWaiters.values()) n += list.length;
  return n;
}

export function registerSocket(agentId: string, ws: WebSocket): void {
  sockets.set(agentId, ws);
  let all = agentSockets.get(agentId);
  if (!all) agentSockets.set(agentId, (all = new Set()));
  all.add(ws);
  ws.on("close", () => {
    if (sockets.get(agentId) === ws) sockets.delete(agentId);
    all.delete(ws);
    if (all.size === 0 && agentSockets.get(agentId) === all) agentSockets.delete(agentId);
  });
}

/** Drops an agent's live socket, e.g. after its key is rotated, so a leaked key can't keep receiving pushes. */
export function disconnectAgent(agentId: string, reason: string, code = 4001): void {
  for (const ws of agentSockets.get(agentId) ?? []) ws.close(code, reason);
}

export function pushToAgent(agentId: string, payload: Record<string, unknown>): boolean {
  const ws = sockets.get(agentId);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

/** Whether a push to the agent would reach it now (the same test pushToAgent makes). */
export function hasLiveSocket(agentId: string): boolean {
  const ws = sockets.get(agentId);
  return Boolean(ws && ws.readyState === ws.OPEN);
}

// Proxies close idle WebSockets (seen live: 1006 every ~15-20 min), and a dead peer that never
// closed cleanly would still look "live" and swallow pushes. So the hub pings every interval and
// terminates any socket that didn't answer the previous ping.
const answeredPing = new WeakMap<WebSocket, boolean>();

/** Starts tracking a socket for keepalive; `onAlive` runs on every pong (e.g. a presence heartbeat). */
export function trackKeepalive(ws: WebSocket, onAlive: () => void): void {
  answeredPing.set(ws, true);
  ws.on("pong", () => {
    answeredPing.set(ws, true);
    onAlive();
  });
}

/** One keepalive round over the server's clients: terminate the silent, ping the rest. */
export function sweepKeepalive(clients: Iterable<WebSocket>): void {
  for (const ws of clients) {
    if (answeredPing.get(ws) === false) {
      ws.terminate();
      continue;
    }
    answeredPing.set(ws, false);
    ws.ping();
  }
}

export function isOnline(agentId: string): boolean {
  const ws = sockets.get(agentId);
  return !!ws && ws.readyState === ws.OPEN;
}

/** Called by the reply-side flow to unblock a pending ask_clarification wait. */
export function resolveReplyWaiter(threadId: string, body: string): void {
  const waiter = pendingReplyWaiters.get(threadId);
  if (waiter) {
    waiter(body);
    pendingReplyWaiters.delete(threadId);
  }
}

export function waitForReply(threadId: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingReplyWaiters.delete(threadId);
      resolve(null);
    }, timeoutMs);
    pendingReplyWaiters.set(threadId, (body: string) => {
      clearTimeout(timer);
      resolve(body);
    });
  });
}

// --- Long-poll: "wait_for_message" ------------------------------------
// A real alternative to fixed-interval polling for any client that CAN
// hold one HTTP request open (which every MCP tool call already does) but
// can't hold a raw WebSocket. Blocks the call itself until either a new
// message lands for this agent or the timeout elapses -- turns "check
// every N seconds and hope" into "return the instant something arrives,
// bounded by a real deadline." This is what makes ScheduleWakeup-driven
// re-invocation (Claude Code's 60s floor) feel near-instant in practice:
// call wait_for_message(55) instead of get_messages(), and the effective
// latency becomes real arrival time, not up to 60s of staleness.
const pendingInboxWaiters = new Map<string, Array<() => void>>();

export function notifyInboxWaiters(agentId: string): void {
  const waiters = pendingInboxWaiters.get(agentId);
  if (!waiters || waiters.length === 0) return;
  pendingInboxWaiters.delete(agentId);
  for (const w of waiters) w();
}

/** Call on graceful shutdown. A held wait_for_message/GET /v1/messages/wait
 * request has no way to know the process is about to die -- without this,
 * it hangs on a connection to a server that's gone until the client's own
 * timeout fires (up to 280s), which one live 3-agent test found actually
 * happens: a hub restart mid-deploy left a real client blind to a message
 * for minutes. Resolving every pending waiter here makes each held request
 * return immediately (with whatever's currently in the inbox) so a client
 * re-polls right away instead of hanging on a dead socket. */
export function resolveAllInboxWaiters(): void {
  for (const [agentId, waiters] of pendingInboxWaiters) {
    pendingInboxWaiters.delete(agentId);
    for (const w of waiters) w();
  }
}

export function waitForInboxActivity(agentId: string, timeoutMs: number): Promise<boolean> {
  if (isDraining()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let resolved = false;
    const resolver = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const list = pendingInboxWaiters.get(agentId);
      if (list) {
        const idx = list.indexOf(resolver);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) pendingInboxWaiters.delete(agentId);
      }
      resolve(false);
    }, timeoutMs);
    const list = pendingInboxWaiters.get(agentId) ?? [];
    list.push(resolver);
    pendingInboxWaiters.set(agentId, list);
  });
}
