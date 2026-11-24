import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "../../src/db.js";
import { createOrganization } from "../../src/service.js";
import type { MemberRole } from "../../src/accounts.js";

// People, workspaces and projects for the OAuth authorization tests (tests/oauth-grants.test.ts,
// tests/oauth-authorize-route.test.ts), written straight to the tables the way tests/billing-checkout.test.ts does, so
// the tests do not depend on sign-up's trial rules.

let n = 0;
export function person(name = "Ada"): string {
  const id = `person-${randomUUID()}`;
  db.prepare(`INSERT INTO people (id, email, name, created_at) VALUES (?, ?, ?, ?)`).run(id, `${id}@example.test`, `${name} ${++n}`, new Date().toISOString());
  return id;
}

/** Adds the person to the workspace with a member agent, as src/accounts.ts addMember does. */
export function addMember(orgId: string, personId: string, role: MemberRole): void {
  const agentId = randomUUID();
  db.prepare(
    `INSERT INTO agents (id, org_id, name, url_key, api_key_hash, role, key_class, scope) VALUES (?, ?, ?, ?, ?, ?, 'human', 'workspace')`,
  ).run(agentId, orgId, `Member ${agentId.slice(0, 8)}`, `member-${agentId}`, createHash("sha256").update(randomBytes(16)).digest("hex"), role === "member" ? "agent" : "operator");
  db.prepare(`INSERT INTO workspace_members (org_id, person_id, role, agent_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(orgId, personId, role, agentId, new Date().toISOString());
}

/** A workspace the person belongs to. `isolated` is whether it keeps projects apart; `projects` are enabled in it. */
export function workspace(personId: string, { role = "owner", isolated = false, projects = [] as string[], plan, name }:
  { role?: MemberRole; isolated?: boolean; projects?: string[]; plan?: string; name?: string } = {}): string {
  const { orgId } = createOrganization(name ?? `OAuth WS ${++n}`, plan);
  db.prepare(`UPDATE organizations SET project_isolation = ? WHERE id = ?`).run(isolated ? 1 : 0, orgId);
  addMember(orgId, personId, role);
  for (const key of projects) {
    db.prepare(`INSERT INTO projects (org_id, project_key, name, enabled, enabled_at) VALUES (?, ?, ?, 1, ?)`)
      .run(orgId, key, key.split("/").pop(), new Date().toISOString());
  }
  return orgId;
}

/** Puts the workspace at its plan's agent cap: "No plan yet" allows no live agents at all. */
export const atCap = (orgId: string) => db.prepare(`UPDATE organizations SET plan = 'pending' WHERE id = ?`).run(orgId);

/** A registered DCR client row with one https redirect. */
export function dcrClient(name = "Claude Code", redirectUris = ["https://claude.ai/api/mcp/auth_callback"]): string {
  const clientId = `dcr_${randomBytes(16).toString("hex")}`;
  db.prepare(`INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris) VALUES (?, 'dcr', ?, ?)`).run(clientId, name, JSON.stringify(redirectUris));
  return clientId;
}

export const count = (sql: string, ...args: unknown[]) => (db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...args) as { n: number }).n;
