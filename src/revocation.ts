import type { ServerResponse } from "node:http";

/** Requests an agent's key is holding open right now: REST long-polls and MCP tool calls such as
 * wait_for_message can sit for minutes. Revoking the key (rotation, a paused workspace) ends them at
 * once, so a leaked or revoked key stops receiving data within seconds instead of at its timeout.
 * The handler still finishes later (its waiter resolves on its own); anything it writes then is
 * dropped, so it can neither reach the old client nor crash the process by writing after the end. */

const held = new Map<string, Set<ServerResponse>>();
const ended = new WeakSet<ServerResponse>();
/** The credential a held request was made with, when one agent can hold several: an MCP connector's token family
 * (src/oauth.ts). Revoking that family ends exactly its requests and leaves the agent's other families' alone. */
const heldWith = new WeakMap<ServerResponse, string>();

export function holdOpenRequest(agentId: string, res: ServerResponse, credential?: string): void {
  if (credential) heldWith.set(res, credential);
  let set = held.get(agentId);
  if (!set) held.set(agentId, (set = new Set()));
  set.add(res);
  res.once("close", () => {
    set.delete(res);
    if (set.size === 0 && held.get(agentId) === set) held.delete(agentId);
  });
}

export function heldRequestCount(agentId?: string): number {
  if (agentId) return held.get(agentId)?.size ?? 0;
  let n = 0;
  for (const set of held.values()) n += set.size;
  return n;
}

const NOOP_METHODS = ["writeHead", "setHeader", "removeHeader", "write", "end", "flushHeaders"] as const;

function silence(res: ServerResponse): void {
  const target = res as unknown as Record<string, unknown>;
  for (const method of NOOP_METHODS) target[method] = method === "write" ? () => false : () => res;
  // Express adds send/json/status on its response object.
  for (const method of ["send", "json", "status", "set"]) if (typeof target[method] === "function") target[method] = () => res;
  // A write the handler raced in before silence() must never surface as an unhandled stream error.
  res.on("error", () => {});
}

/** Ends every request the agent's key is holding open with `status` and `error`. Returns how many were ended. With
 * `credential`, only the requests held with that credential (holdOpenRequest's third argument) end. */
export function endHeldRequests(agentId: string, status: number, error: string, credential?: string): number {
  const set = held.get(agentId);
  if (!set) return 0;
  let count = 0;
  for (const res of [...set]) {
    if (credential !== undefined && heldWith.get(res) !== credential) continue;
    if (ended.has(res)) continue;
    ended.add(res);
    count++;
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error }));
    } else if (!res.writableEnded) {
      // Headers already went out (an MCP event stream): cut the connection.
      res.destroy();
    }
    silence(res);
    set.delete(res);
  }
  if (set.size === 0) held.delete(agentId);
  return count;
}
