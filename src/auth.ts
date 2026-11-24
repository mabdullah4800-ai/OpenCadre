import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";

export function generateApiKey(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type KeyClass = "agent" | "watcher";
export type AgentRole = "agent" | "operator";

export interface AuthedAgent {
  orgId: string;
  agentId: string;
  agentName: string;
  keyClass: KeyClass;
  role: AgentRole;
}

const findAgentByHash = db.prepare(
  `SELECT a.id, a.org_id, a.name, a.key_class, a.role, o.paused_at
   FROM agents a JOIN organizations o ON o.id = a.org_id
   WHERE a.api_key_hash = ? AND a.removed_at IS NULL AND a.key_class != 'human'
     AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.agent_id = a.id)`,
);

type AgentRow = { id: string; org_id: string; name: string; key_class: string; role: AgentRole; paused_at: string | null };

/** Resolves an "Authorization: Bearer <agent api key>" header to an org/agent identity. While the
 * workspace is paused (src/kill-switch.ts) only operator keys resolve, so every caller fails closed.
 * Person/member rows have no bearer authority, even if an older release issued them a credential. */
export function authenticateAgentKey(bearer: string | undefined): AuthedAgent | null {
  if (!bearer) return null;
  const hash = hashKey(bearer);
  const row = findAgentByHash.get(hash) as AgentRow | undefined;
  if (!row) return null;
  if (row.paused_at && row.role !== "operator") return null;
  const keyClass: KeyClass = row.key_class === "watcher" ? "watcher" : "agent";
  return { orgId: row.org_id, agentId: row.id, agentName: row.name, keyClass, role: row.role };
}

/** True for a real agent key refused only because its workspace is paused, so callers can say so. */
export function isPausedWorkspaceKey(bearer: string | undefined): boolean {
  if (!bearer) return false;
  const row = findAgentByHash.get(hashKey(bearer)) as AgentRow | undefined;
  return Boolean(row?.paused_at && row.role !== "operator");
}

const findOrgByHash = db.prepare(
  `SELECT id, name FROM organizations WHERE bootstrap_key_hash = ?`,
);

/** Resolves an org-level bootstrap key, used only to register new agents. */
export function authenticateOrgBootstrapKey(bearer: string | undefined): { orgId: string; orgName: string } | null {
  if (!bearer) return null;
  const hash = hashKey(bearer);
  const row = findOrgByHash.get(hash) as { id: string; name: string } | undefined;
  if (!row) return null;
  return { orgId: row.id, orgName: row.name };
}
