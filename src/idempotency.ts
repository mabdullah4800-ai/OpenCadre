import { createHash } from "node:crypto";
import { db } from "./db.js";
import { log } from "./log.js";

/** Idempotent writes (reliability sprint R1.1). An agent that retries a write after a timeout or a dropped
 * connection sends the same key; the hub runs the write once and replays the first response to every
 * retry, so a retried send never delivers twice and a retried claim never double-claims.
 *
 * Keys are scoped to the calling agent. A key reused for a different request is rejected rather than
 * replayed. A write that fails with a server error (or never finishes) releases its key, so the retry
 * really runs. Keys expire after 24 hours. */

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const TTL_MS = 24 * 60 * 60 * 1000;
/** An in-progress key older than this belongs to a request that died mid-write; a retry may reclaim it.
 * INVARIANT: no idempotent write may take this long. A wrapped route that awaits something slow would let
 * a retry run the write a second time; completeIdempotent logs a warning if it ever happens. */
const RECLAIM_AFTER_MS = 2 * 60 * 1000;

export type Begin =
  | { state: "new"; claimedAt: string }
  | { state: "replay"; status: number; response: string }
  | { state: "conflict" }
  | { state: "in_progress" };

/** Stable JSON: object keys sorted, so the same request always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(scope: string, request: unknown): string {
  return createHash("sha256").update(`${scope}\n${canonical(request)}`).digest("hex");
}

const findKey = db.prepare(
  `SELECT request_hash, status, response, created_at FROM idempotency_keys WHERE org_id = ? AND agent_id = ? AND key = ?`,
);
const insertKey = db.prepare(
  `INSERT INTO idempotency_keys (org_id, agent_id, key, scope, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
);
const reclaimKey = db.prepare(`UPDATE idempotency_keys SET created_at = ? WHERE org_id = ? AND agent_id = ? AND key = ?`);
// Both match the claim's created_at, so a slow original that finishes after a retry reclaimed the key can't
// overwrite or delete the retry's record.
const finishKey = db.prepare(
  `UPDATE idempotency_keys SET status = ?, response = ? WHERE org_id = ? AND agent_id = ? AND key = ? AND created_at = ? AND status IS NULL`,
);
const releaseKey = db.prepare(`DELETE FROM idempotency_keys WHERE org_id = ? AND agent_id = ? AND key = ? AND created_at = ? AND status IS NULL`);
const expireKeys = db.prepare(`DELETE FROM idempotency_keys WHERE created_at < ?`);

/** Claims the key for this request, or says how to answer instead. Runs under a write lock, so two
 * identical requests arriving together can't both start the write. */
export function beginIdempotent(orgId: string, agentId: string, key: string, scope: string, hash: string, now = Date.now()): Begin {
  return db.transaction((): Begin => {
    const row = findKey.get(orgId, agentId, key) as { request_hash: string; status: number | null; response: string | null; created_at: string } | undefined;
    const claimedAt = new Date(now).toISOString();
    if (!row) {
      insertKey.run(orgId, agentId, key, scope, hash, claimedAt);
      return { state: "new", claimedAt };
    }
    if (row.request_hash !== hash) return { state: "conflict" };
    if (row.status !== null) return { state: "replay", status: row.status, response: row.response ?? "" };
    if (now - Date.parse(row.created_at) > RECLAIM_AFTER_MS) {
      reclaimKey.run(claimedAt, orgId, agentId, key);
      return { state: "new", claimedAt };
    }
    return { state: "in_progress" };
  }).immediate();
}

export function completeIdempotent(orgId: string, agentId: string, key: string, claimedAt: string, status: number, response: string): void {
  const { changes } = finishKey.run(status, response, orgId, agentId, key, claimedAt);
  if (changes === 0) log.warn("idempotent write finished after its key was reclaimed; the write may have run twice", { orgId, agentId, key });
}

/** Releases an unfinished key (after a server error) so a retry runs the write for real. */
export function releaseIdempotent(orgId: string, agentId: string, key: string, claimedAt: string): void {
  releaseKey.run(orgId, agentId, key, claimedAt);
}

export function sweepIdempotencyKeys(now = Date.now()): number {
  return expireKeys.run(new Date(now - TTL_MS).toISOString()).changes;
}

/** MCP tools: run `write` once per requestId and replay its text result afterwards. Without a
 * requestId the tool behaves exactly as before. */
export async function idempotentTool<T extends { content: Array<{ type: "text"; text: string }> }>(
  caller: { orgId: string; agentId: string },
  tool: string,
  args: Record<string, unknown>,
  write: () => Promise<T> | T,
): Promise<T | { content: Array<{ type: "text"; text: string }> }> {
  const { requestId, ...request } = args;
  if (requestId === undefined) return write();
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  if (typeof requestId !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(requestId)) {
    return text("Error: requestId must be 8-128 characters of letters, digits, . _ : or -");
  }
  const begin = beginIdempotent(caller.orgId, caller.agentId, requestId, `mcp:${tool}`, requestHash(`mcp:${tool}`, request));
  if (begin.state === "conflict") return text(`Error: requestId ${requestId} was already used for a different ${tool} request`);
  if (begin.state === "in_progress") return text(`Error: a ${tool} request with requestId ${requestId} is still running; retry shortly`);
  if (begin.state === "replay") return JSON.parse(begin.response) as T;
  try {
    const result = await write();
    completeIdempotent(caller.orgId, caller.agentId, requestId, begin.claimedAt, 200, JSON.stringify(result));
    return result;
  } catch (err) {
    releaseIdempotent(caller.orgId, caller.agentId, requestId, begin.claimedAt);
    throw err;
  }
}
