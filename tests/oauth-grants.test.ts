import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { changeRole, createSession, removeMember } from "../src/accounts.js";
import {
  approveConsent, consentCsrf, CODE_TTL_SECONDS, CONSENT_TTL_MS, createConsent, csrfMatches, denyConsent,
  eligibleWorkspaces, freeConnectionName, oauthSecretFrom, pruneDeadConsents, readConsent, revokeGrant, WORKSPACE_SCOPE, type ApproveResult,
} from "../src/oauth-authorize.js";
import { issueTokenFamily, mcpResource, pruneStaleDcrClients, rotateRefreshToken, verifyAccessToken } from "../src/oauth.js";
import { checkAgentName, listActiveAgents, MAX_AGENT_NAME_CHARS, registerAgent, removeAgent, rotateAgentKey } from "../src/service.js";
import { setProjectIsolation } from "../src/project-isolation.js";
import { addMember, atCap, count, dcrClient, person, workspace } from "./helpers/oauth-fixtures.js";

// The authorization step's data and rules (plan 2026-09-29 §7.1, 7.2, 7.3, 7.6, 7.7; docs/design/MCP-CONNECTOR.md §3).


const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
function consentFor(personId: string, clientId: string, over: Partial<{ redirectUri: string; state: string }> = {}, nowMs = Date.now()) {
  return createConsent({
    personId, clientId, redirectUri: over.redirectUri ?? "https://claude.ai/api/mcp/auth_callback", resource: mcpResource(),
    codeChallenge: CHALLENGE, state: over.state ?? `state-${randomUUID()}`,
  }, nowMs);
}
function approved(result: ApproveResult) {
  if (!result.ok) throw new Error(`approve refused: ${result.reason} ${result.message}`);
  return result;
}
const grantRows = (personId: string) =>
  db.prepare(`SELECT grant_id, agent_id, scope_key, revoked_at FROM oauth_grants WHERE person_id = ? ORDER BY created_at, rowid`).all(personId) as
    Array<{ grant_id: string; agent_id: string; scope_key: string; revoked_at: string | null }>;
const connectorAgents = (orgId: string) =>
  db.prepare(`SELECT id, name, role, key_class, kind, scope, home_project, api_key_hash, removed_at FROM agents WHERE org_id = ? AND kind = 'connector'`).all(orgId) as
    Array<{ id: string; name: string; role: string; key_class: string; kind: string; scope: string; home_project: string | null; api_key_hash: string; removed_at: string | null }>;
const familyOf = (grant: { clientId: string; orgId: string; agentId: string; personId: string; grantId: string }) =>
  issueTokenFamily({ ...grant, resource: mcpResource() });

describe("approve creates one connector agent and grant, and a code bound to everything", () => {
  it("the agent is kind connector, role agent, workspace scope, with no usable key; the code names the grant", () => {
    const p = person();
    const org = workspace(p);
    const client = dcrClient();
    const consentId = consentFor(p, client, { state: "s1" });
    const before = Date.now();
    const r = approved(approveConsent({ consentId, personId: p, orgId: org, connectionName: "Claude-7f3a" }));
    expect(r).toMatchObject({ redirectUri: "https://claude.ai/api/mcp/auth_callback", state: "s1", reused: false });
    const [agent] = connectorAgents(org);
    expect(agent).toMatchObject({ id: r.agentId, name: "Claude-7f3a", role: "agent", key_class: "agent", kind: "connector", scope: "workspace", home_project: null, removed_at: null });
    expect(agent.api_key_hash, "not a SHA-256 hex digest, so no key hashes to it").not.toMatch(/^[0-9a-f]{64}$/);
    expect(grantRows(p)).toEqual([{ grant_id: r.grantId, agent_id: r.agentId, scope_key: WORKSPACE_SCOPE, revoked_at: null }]);
    const code = db.prepare(`SELECT * FROM oauth_codes WHERE grant_id = ?`).get(r.grantId) as Record<string, string | null>;
    expect(code).toMatchObject({
      client_id: client, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: CHALLENGE, resource: mcpResource(),
      person_id: p, org_id: org, agent_id: r.agentId, grant_id: r.grantId, used_at: null,
    });
    expect(code.code_hash).not.toBe(r.code);
    const ttl = Date.parse(code.expires_at!) - before;
    expect(ttl).toBeGreaterThan((CODE_TTL_SECONDS - 5) * 1000);
    expect(ttl).toBeLessThanOrEqual(CODE_TTL_SECONDS * 1000 + 1000);
  });

  it("in a workspace that keeps projects apart, the agent is scoped to the chosen project, which must be an enabled one", () => {
    const p = person();
    const org = workspace(p, { isolated: true, projects: ["github.com/acme/api", "github.com/acme/web"] });
    const client = dcrClient();
    const none = approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Claude-0001" });
    expect(none).toMatchObject({ ok: false, reason: "project_required" });
    const bogus = approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, projectKey: "github.com/acme/secret", connectionName: "Claude-0001" });
    expect(bogus).toMatchObject({ ok: false, reason: "project_required" });
    expect(connectorAgents(org)).toHaveLength(0);
    const r = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, projectKey: "github.com/acme/api", connectionName: "Claude-0001" }));
    expect(connectorAgents(org)[0]).toMatchObject({ id: r.agentId, scope: "project", home_project: "github.com/acme/api" });
    expect(grantRows(p)[0].scope_key).toBe("github.com/acme/api");
  });

  it("a person whose live role cannot add agents is refused, and nothing is written (the consent stays open)", () => {
    const p = person();
    const org = workspace(p, { role: "member" });
    const consentId = consentFor(p, dcrClient());
    expect(approveConsent({ consentId, personId: p, orgId: org, connectionName: "Claude-0002" })).toMatchObject({ ok: false, reason: "not_allowed" });
    const stranger = workspace(person());
    expect(approveConsent({ consentId, personId: p, orgId: stranger, connectionName: "Claude-0002" })).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(connectorAgents(org)).toHaveLength(0);
    expect(count(`oauth_codes WHERE person_id = ?`, p)).toBe(0);
    expect(readConsent(consentId, p).ok, "the refusal rolled the consent back too").toBe(true);
  });

  it("a duplicate connection name is refused on a new agent, with nothing written", () => {
    const p = person();
    const org = workspace(p);
    approved(approveConsent({ consentId: consentFor(p, dcrClient()), personId: p, orgId: org, connectionName: "Taken" }));
    const other = dcrClient("Cursor");
    expect(approveConsent({ consentId: consentFor(p, other), personId: p, orgId: org, connectionName: "taken" })).toMatchObject({ ok: false, reason: "invalid_name" });
    expect(connectorAgents(org)).toHaveLength(1);
  });
});

describe("the consent is single-use and personal (§7.3)", () => {
  it("a second answer fails, whichever it is", () => {
    const p = person();
    const org = workspace(p);
    const consentId = consentFor(p, dcrClient());
    approved(approveConsent({ consentId, personId: p, orgId: org, connectionName: "Once" }));
    expect(approveConsent({ consentId, personId: p, orgId: org, connectionName: "Twice" })).toMatchObject({ ok: false, reason: "consent", problem: "used" });
    expect(denyConsent(consentId, p)).toMatchObject({ ok: false, problem: "used" });
    expect(count(`oauth_codes WHERE person_id = ?`, p)).toBe(1);
  });

  it("an expired consent is refused, and another person cannot use one at all", () => {
    const p = person();
    const org = workspace(p);
    const client = dcrClient();
    const old = consentFor(p, client, {}, Date.now() - CONSENT_TTL_MS - 1000);
    expect(approveConsent({ consentId: old, personId: p, orgId: org, connectionName: "Late" })).toMatchObject({ ok: false, problem: "expired" });
    const mine = consentFor(p, client);
    const intruder = person();
    workspace(intruder);
    const theirOrg = workspace(intruder);
    expect(approveConsent({ consentId: mine, personId: intruder, orgId: theirOrg, connectionName: "Stolen" })).toMatchObject({ ok: false, problem: "unknown" });
    expect(denyConsent(mine, intruder)).toMatchObject({ ok: false, problem: "unknown" });
    expect(readConsent(mine, p).ok, "the owner's consent is untouched").toBe(true);
  });

  it("deny spends the consent and names the redirect and state from the stored row", () => {
    const p = person();
    const consentId = consentFor(p, dcrClient(), { state: "deny-state" });
    expect(denyConsent(consentId, p)).toEqual({ ok: true, redirectUri: "https://claude.ai/api/mcp/auth_callback", state: "deny-state" });
    expect(readConsent(consentId, p)).toEqual({ ok: false, problem: "used" });
  });
});

describe("get-or-create (§7.1, §7.2)", () => {
  it("two approvals for one tuple make one agent and one active grant", () => {
    const p = person();
    const org = workspace(p);
    const client = dcrClient();
    const a = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "First" }));
    const b = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Second" }));
    expect(b).toMatchObject({ agentId: a.agentId, grantId: a.grantId, reused: true });
    expect(connectorAgents(org).map((x) => x.name)).toEqual(["First"]);
    expect(count(`oauth_grants WHERE person_id = ? AND revoked_at IS NULL`, p)).toBe(1);
  });

  it("a writer that loses the race on the partial unique index reuses the winner's agent and leaves nothing of its own", () => {
    const p = person();
    const org = workspace(p);
    const client = dcrClient();
    const winnerAgent = randomUUID();
    const winnerGrant = randomUUID();
    let raced = false;
    const beforeGrantInsert = () => {
      if (raced) return;
      raced = true;
      // A second writer commits the same tuple between this one's reuse check and its insert.
      db.prepare(`INSERT INTO agents (id, org_id, name, url_key, api_key_hash, role, key_class, kind, scope) VALUES (?, ?, 'Winner', ?, ?, 'agent', 'agent', 'connector', 'workspace')`)
        .run(winnerAgent, org, `winner-${winnerAgent}`, `connector:${winnerAgent}`);
      db.prepare(`INSERT INTO oauth_grants (grant_id, person_id, client_id, org_id, scope_key, agent_id, created_at) VALUES (?, ?, ?, ?, '*', ?, ?)`)
        .run(winnerGrant, p, client, org, winnerAgent, new Date().toISOString());
    };
    const r = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Loser" }, Date.now(), { beforeGrantInsert }));
    expect(r).toMatchObject({ agentId: winnerAgent, grantId: winnerGrant, reused: true });
    expect(connectorAgents(org).map((x) => x.name)).toEqual(["Winner"]);
    expect(count(`oauth_grants WHERE person_id = ?`, p)).toBe(1);
  });

  it("the database itself refuses a second ACTIVE grant for a tuple, and allows one beside a revoked grant", () => {
    const p = person();
    const org = workspace(p);
    const insert = (revokedAt: string | null) => db.prepare(
      `INSERT INTO oauth_grants (grant_id, person_id, client_id, org_id, scope_key, agent_id, created_at, revoked_at) VALUES (?, ?, 'c', ?, '*', ?, ?, ?)`,
    ).run(randomUUID(), p, org, randomUUID(), new Date().toISOString(), revokedAt);
    insert(new Date().toISOString());
    insert(null);
    expect(() => insert(null)).toThrow(/UNIQUE/);
  });

  it("re-approval after every token expired reuses the agent", () => {
    const p = person();
    const org = workspace(p);
    const client = dcrClient();
    const a = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Kept" }));
    familyOf({ clientId: client, orgId: org, agentId: a.agentId, personId: p, grantId: a.grantId });
    db.prepare(`UPDATE oauth_tokens SET expires_at = ? WHERE agent_id = ?`).run(new Date(Date.now() - 1000).toISOString(), a.agentId);
    const b = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Ignored" }));
    expect(b).toMatchObject({ agentId: a.agentId, reused: true });
  });

  it("a consent for project B never touches project A's grant, agent or tokens", () => {
    const p = person();
    const org = workspace(p, { isolated: true, projects: ["github.com/acme/a", "github.com/acme/b"] });
    const client = dcrClient();
    const a = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, projectKey: "github.com/acme/a", connectionName: "Conn-A" }));
    const tokensA = familyOf({ clientId: client, orgId: org, agentId: a.agentId, personId: p, grantId: a.grantId });
    const b = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, projectKey: "github.com/acme/b", connectionName: "Conn-B" }));
    expect(b.agentId).not.toBe(a.agentId);
    expect(b.grantId).not.toBe(a.grantId);
    expect(b.reused).toBe(false);
    expect(connectorAgents(org).map((x) => [x.name, x.home_project])).toEqual(expect.arrayContaining([["Conn-A", "github.com/acme/a"], ["Conn-B", "github.com/acme/b"]]));
    expect(grantRows(p).map((g) => [g.scope_key, g.revoked_at])).toEqual([["github.com/acme/a", null], ["github.com/acme/b", null]]);
    expect(verifyAccessToken(tokensA.accessToken, mcpResource())?.agentId, "A's tokens still work").toBe(a.agentId);
  });
});

describe("the plan cap (§7.2): counted only when a NEW agent is created", () => {
  it("at the cap, a new scope creates NOTHING: no agent, no grant, no code, and the consent stays open", () => {
    const p = person();
    const org = workspace(p);
    atCap(org);
    const consentId = consentFor(p, dcrClient());
    const r = approveConsent({ consentId, personId: p, orgId: org, connectionName: "Over" });
    expect(r).toMatchObject({ ok: false, reason: "plan_limit" });
    if (!r.ok && r.reason === "plan_limit") expect(r.limit.body.code).toBeTruthy();
    expect(connectorAgents(org)).toHaveLength(0);
    expect(count(`oauth_grants WHERE org_id = ?`, org)).toBe(0);
    expect(count(`oauth_codes WHERE org_id = ?`, org)).toBe(0);
    expect(readConsent(consentId, p).ok).toBe(true);
  });

  it("at the cap, re-approving an existing active scope still succeeds with the same agent", () => {
    const p = person();
    const org = workspace(p);
    const client = dcrClient();
    const a = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Before" }));
    atCap(org);
    const b = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "After" }));
    expect(b).toMatchObject({ agentId: a.agentId, grantId: a.grantId, reused: true });
  });
});

describe("reconnect after Disconnect or removal (§7.6)", () => {
  it("after revokeGrant: a fresh grant and agent, and the old family stays revoked", () => {
    const p = person();
    const org = workspace(p);
    const client = dcrClient();
    const a = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Old" }));
    const old = familyOf({ clientId: client, orgId: org, agentId: a.agentId, personId: p, grantId: a.grantId });
    expect(revokeGrant(a.grantId)).toBe(true);
    expect(verifyAccessToken(old.accessToken, mcpResource()), "revoked at once").toBeNull();
    const b = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "New" }));
    expect(b.reused).toBe(false);
    expect(b.agentId).not.toBe(a.agentId);
    expect(b.grantId).not.toBe(a.grantId);
    expect(verifyAccessToken(old.accessToken, mcpResource())).toBeNull();
    expect(rotateRefreshToken(old.refreshToken, client).ok, "nor can the old family refresh back to life").toBe(false);
    const fresh = familyOf({ clientId: client, orgId: org, agentId: b.agentId, personId: p, grantId: b.grantId });
    expect(verifyAccessToken(fresh.accessToken, mcpResource())?.agentId).toBe(b.agentId);
  });

  it("after the agent is removed: removal revokes the grant and its families, and approval makes a fresh agent", () => {
    const p = person();
    const org = workspace(p);
    const client = dcrClient();
    const a = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Removed" }));
    const old = familyOf({ clientId: client, orgId: org, agentId: a.agentId, personId: p, grantId: a.grantId });
    expect(removeAgent(org, { id: "operator-x", name: "Operator" }, a.agentId).ok).toBe(true);
    expect(grantRows(p)[0].revoked_at).not.toBeNull();
    expect(count(`oauth_tokens WHERE family_id = ? AND revoked_at IS NULL`, old.familyId)).toBe(0);
    // The removed agent's name is never handed to a new agent (migration 55: an address is never reassigned), so the
    // consent screen says it is taken and fills in a free one; with another name, approval makes a fresh agent.
    expect(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Removed" }))
      .toMatchObject({ ok: false, reason: "invalid_name", suggestedName: "Removed 2", message: "Removed is taken. We filled in Removed 2." });
    const b = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Reconnected" }));
    expect(b.reused).toBe(false);
    expect(b.agentId).not.toBe(a.agentId);
    expect(verifyAccessToken(old.accessToken, mcpResource())).toBeNull();
  });

  it("a grant whose agent vanished without the grant being revoked is closed, not reused", () => {
    const p = person();
    const org = workspace(p);
    const client = dcrClient();
    const a = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Gone" }));
    db.prepare(`UPDATE agents SET removed_at = datetime('now') WHERE id = ?`).run(a.agentId);
    const b = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Back" }));
    expect(b.agentId).not.toBe(a.agentId);
    expect(grantRows(p).map((g) => g.revoked_at === null)).toEqual([false, true]);
  });
});

it("a connector agent can never be given an agent key: its credential is its OAuth grant", () => {
  const p = person();
  const org = workspace(p);
  const a = approved(approveConsent({ consentId: consentFor(p, dcrClient()), personId: p, orgId: org, connectionName: "Keyless" }));
  const before = db.prepare(`SELECT api_key_hash FROM agents WHERE id = ?`).pluck().get(a.agentId);
  expect(rotateAgentKey(org, { id: "operator-x", name: "Operator" }, a.agentId)).toBeNull();
  expect(db.prepare(`SELECT api_key_hash FROM agents WHERE id = ?`).pluck().get(a.agentId), "untouched").toBe(before);
});

// Security review S2: a connection lives only as long as its person may add agents in that workspace.
describe("membership changes end a person's connections", () => {
  function connected(role: "owner" | "admin" = "admin") {
    const owner = person();
    const org = workspace(owner);
    const p = person();
    addMember(org, p, role);
    const client = dcrClient();
    const a = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: `Conn-${randomUUID().slice(0, 6)}` }));
    const pair = familyOf({ clientId: client, orgId: org, agentId: a.agentId, personId: p, grantId: a.grantId });
    return { owner, org, p, client, a, pair };
  }
  const actor = (owner: string) => ({ id: "operator-x", name: "Operator", memberRole: "owner" as const, personId: owner });
  const agentRow = (id: string) => db.prepare(`SELECT removed_at FROM agents WHERE id = ?`).get(id) as { removed_at: string | null };

  it("removing the person revokes their grants, removes the connector agent, and refuses access and refresh", () => {
    const c = connected();
    removeMember(c.org, actor(c.owner), c.p);
    expect(grantRows(c.p).map((g) => g.revoked_at === null)).toEqual([false]);
    expect(agentRow(c.a.agentId).removed_at).not.toBeNull();
    expect(verifyAccessToken(c.pair.accessToken, mcpResource())).toBeNull();
    expect(rotateRefreshToken(c.pair.refreshToken, c.client).ok).toBe(false);
  });

  it("demoting the person to a role that cannot add agents does the same", () => {
    const c = connected();
    changeRole(c.org, actor(c.owner), c.p, "member");
    expect(grantRows(c.p).map((g) => g.revoked_at === null)).toEqual([false]);
    expect(agentRow(c.a.agentId).removed_at).not.toBeNull();
    expect(verifyAccessToken(c.pair.accessToken, mcpResource())).toBeNull();
    expect(rotateRefreshToken(c.pair.refreshToken, c.client).ok).toBe(false);
  });

  it("a role change that still may add agents leaves the connection alone", () => {
    const c = connected("admin");
    changeRole(c.org, actor(c.owner), c.p, "owner");
    expect(grantRows(c.p).map((g) => g.revoked_at)).toEqual([null]);
    expect(verifyAccessToken(c.pair.accessToken, mcpResource())?.agentId).toBe(c.a.agentId);
  });

  it("a refused membership change revokes nothing (same transaction)", () => {
    const owner = person();
    const org = workspace(owner);
    const client = dcrClient();
    const a = approved(approveConsent({ consentId: consentFor(owner, client), personId: owner, orgId: org, connectionName: "Sole-owner" }));
    expect(() => removeMember(org, actor(owner), owner)).toThrow(/at least one owner/);
    expect(grantRows(owner).map((g) => g.revoked_at)).toEqual([null]);
    expect(agentRow(a.agentId).removed_at).toBeNull();
  });

  it("defence in depth: a token whose person lost the role is refused even if the grant was somehow left active", () => {
    const c = connected();
    db.prepare(`UPDATE workspace_members SET role = 'member' WHERE org_id = ? AND person_id = ?`).run(c.org, c.p);
    expect(verifyAccessToken(c.pair.accessToken, mcpResource())).toBeNull();
    expect(rotateRefreshToken(c.pair.refreshToken, c.client)).toEqual({ ok: false, error: "invalid_grant", reused: false });
    db.prepare(`DELETE FROM workspace_members WHERE org_id = ? AND person_id = ?`).run(c.org, c.p);
    expect(verifyAccessToken(c.pair.accessToken, mcpResource())).toBeNull();
    db.prepare(`INSERT INTO workspace_members (org_id, person_id, role, agent_id, created_at) VALUES (?, ?, 'admin', 'm', ?)`).run(c.org, c.p, new Date().toISOString());
    expect(verifyAccessToken(c.pair.accessToken, mcpResource())?.agentId, "back to a qualifying role: accepted again").toBe(c.a.agentId);
    expect(rotateRefreshToken(c.pair.refreshToken, c.client).ok).toBe(true);
  });
});

// Security review S3 (design §6.1, the later switch): a workspace-wide connection cannot respect projects kept apart.
describe("switching project isolation on", () => {
  it("closes every workspace-wide connection in the same step, and leaves project-scoped ones alone", () => {
    const p = person();
    const org = workspace(p, { isolated: true, projects: ["github.com/acme/api"] });
    const client = dcrClient();
    const scoped = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, projectKey: "github.com/acme/api", connectionName: "Scoped" }));
    const scopedPair = familyOf({ clientId: client, orgId: org, agentId: scoped.agentId, personId: p, grantId: scoped.grantId });
    const actor = { id: "operator-x", name: "Operator" };
    setProjectIsolation(org, actor, false);
    const wide = approved(approveConsent({ consentId: consentFor(p, dcrClient("Cursor")), personId: p, orgId: org, connectionName: "Wide" }));
    const widePair = familyOf({ clientId: client, orgId: org, agentId: wide.agentId, personId: p, grantId: wide.grantId });
    const other = person();
    const otherWide = approved(approveConsent({ consentId: consentFor(other, client), personId: other, orgId: (addMember(org, other, "admin"), org), connectionName: "Wide-2" }));

    const switched = setProjectIsolation(org, actor, true);
    expect(switched).toMatchObject({ enabled: true, changed: true, disconnectedConnections: 2 });
    for (const a of [wide, otherWide]) {
      expect(db.prepare(`SELECT revoked_at FROM oauth_grants WHERE grant_id = ?`).pluck().get(a.grantId)).not.toBeNull();
      expect(db.prepare(`SELECT removed_at FROM agents WHERE id = ?`).pluck().get(a.agentId)).not.toBeNull();
    }
    expect(verifyAccessToken(widePair.accessToken, mcpResource())).toBeNull();
    expect(verifyAccessToken(scopedPair.accessToken, mcpResource())?.agentId, "a project-scoped connection stays").toBe(scoped.agentId);
    expect(setProjectIsolation(org, actor, true), "switching on again closes nothing").toMatchObject({ changed: false, disconnectedConnections: 0 });
    expect(setProjectIsolation(org, actor, false)).toMatchObject({ changed: true, disconnectedConnections: 0 });
  });
});

describe("grant_id rides the token family", () => {
  it("issued and rotated tokens carry the grant", () => {
    const p = person();
    const org = workspace(p);
    const client = dcrClient();
    const a = approved(approveConsent({ consentId: consentFor(p, client), personId: p, orgId: org, connectionName: "Carrier" }));
    const pair = familyOf({ clientId: client, orgId: org, agentId: a.agentId, personId: p, grantId: a.grantId });
    const next = rotateRefreshToken(pair.refreshToken, client);
    expect(next.ok).toBe(true);
    const grants = db.prepare(`SELECT DISTINCT grant_id FROM oauth_tokens WHERE family_id = ?`).pluck().all(pair.familyId);
    expect(grants).toEqual([a.grantId]);
    expect(count(`oauth_tokens WHERE family_id = ?`, pair.familyId)).toBe(4);
  });
});

// Security review N8: the configured secret is the one used, and a too-short one is refused loudly, not used.
describe("OPENCADRE_OAUTH_SECRET", () => {
  it("set (32+ characters): it is the key, so a consent page survives a restart", () => {
    const value = "k".repeat(40);
    const secret = oauthSecretFrom({ OPENCADRE_OAUTH_SECRET: value });
    expect(secret).toEqual({ key: Buffer.from(value, "utf8"), problem: null });
    const expected = createHmac("sha256", value).update(`${createHash("sha256").update("session").digest("hex")}\n${"consent-1"}`).digest("base64url");
    expect(consentCsrf("session", "consent-1", secret.key)).toBe(expected);
  });

  it("too short: a random per-process key instead, and a problem to warn about at startup", () => {
    const a = oauthSecretFrom({ OPENCADRE_OAUTH_SECRET: "short" });
    const b = oauthSecretFrom({ OPENCADRE_OAUTH_SECRET: "short" });
    expect(a.problem).toMatch(/OPENCADRE_OAUTH_SECRET is shorter than 32 characters/);
    expect(a.key).toHaveLength(32);
    expect(a.key.equals(b.key), "random, not derived from the short value").toBe(false);
    expect(a.key.equals(Buffer.from("short"))).toBe(false);
  });

  it("unset: a random per-process key, and nothing to warn about (the documented default)", () => {
    const unset = oauthSecretFrom({});
    expect(unset.problem).toBeNull();
    expect(unset.key).toHaveLength(32);
  });
});

describe("CSRF (§7.7): HMAC over the session and the consent id", () => {
  it("each tab's token approves only its own consent, and only in its own session", () => {
    const p = person();
    const client = dcrClient();
    const { token: session } = createSession(p);
    const { token: otherSession } = createSession(p);
    const tabA = consentFor(p, client);
    const tabB = consentFor(p, client);
    const csrfA = consentCsrf(session, tabA);
    const csrfB = consentCsrf(session, tabB);
    expect(csrfA).not.toBe(csrfB);
    expect(csrfMatches(session, tabA, csrfA)).toBe(true);
    expect(csrfMatches(session, tabB, csrfB)).toBe(true);
    expect(csrfMatches(session, tabB, csrfA), "tab A's token on tab B's consent").toBe(false);
    expect(csrfMatches(session, tabA, csrfB), "tab B's token on tab A's consent").toBe(false);
    expect(csrfMatches(otherSession, tabA, csrfA), "another session").toBe(false);
    expect(csrfMatches(undefined, tabA, csrfA)).toBe(false);
    expect(csrfMatches(session, tabA, "")).toBe(false);
    expect(csrfMatches(session, tabA, `${csrfA.slice(0, -1)}${csrfA.endsWith("A") ? "B" : "A"}`)).toBe(false);
  });
});

describe("where a person may connect", () => {
  it("lists only workspaces where their live role may add agents, and never a paused one", () => {
    const p = person();
    const owner = workspace(p, { role: "owner", name: "A owner" });
    const admin = workspace(p, { role: "admin", name: "B admin", isolated: true, projects: ["github.com/acme/api"] });
    workspace(p, { role: "member", name: "C member" });
    const paused = workspace(p, { role: "owner", name: "D paused" });
    db.prepare(`UPDATE organizations SET paused_at = datetime('now') WHERE id = ?`).run(paused);
    const listed = eligibleWorkspaces(p);
    expect(listed.map((w) => w.orgId)).toEqual([owner, admin]);
    expect(listed[1]).toMatchObject({ isolated: true, projects: [{ key: "github.com/acme/api", name: "api" }] });
    expect(listed[0]).toMatchObject({ isolated: false, projects: [] });
  });
});

it("pruning keeps a DCR client that a grant or a pending consent names", () => {
  const p = person();
  const org = workspace(p);
  const granted = dcrClient();
  const pending = dcrClient();
  const unused = dcrClient();
  approved(approveConsent({ consentId: consentFor(p, granted), personId: p, orgId: org, connectionName: "Pruned-not" }));
  // Only the grant names it now: its code is gone, and its answered consent was swept a day after it expired.
  db.prepare(`DELETE FROM oauth_codes WHERE client_id = ?`).run(granted);
  expect(pruneDeadConsents(Date.now() + CONSENT_TTL_MS + 24 * 60 * 60_000 + 1000)).toBeGreaterThanOrEqual(1);
  expect(count(`oauth_consents WHERE client_id = ?`, granted)).toBe(0);
  consentFor(p, pending);
  for (const id of [granted, pending, unused]) db.prepare(`UPDATE oauth_clients SET created_at = datetime('now', '-31 days') WHERE client_id = ?`).run(id);
  pruneStaleDcrClients();
  const left = (id: string) => count(`oauth_clients WHERE client_id = ?`, id) === 1;
  expect([left(granted), left(pending), left(unused)]).toEqual([true, true, false]);
});

it("the member fixture matches what accounts.addMember writes (a sanity check on the harness)", () => {
  const p = person();
  const org = workspace(person());
  addMember(org, p, "admin");
  expect(eligibleWorkspaces(p).map((w) => w.orgId)).toContain(org);
});

describe("connection names (onboarding slice 2 polish)", () => {
  it("a free name always fits the agent-name limit, even when every numbered form of a long name is taken", () => {
    const org = workspace(person());
    const long = "A".repeat(MAX_AGENT_NAME_CHARS);
    // Take the name and every numbered form of it, each the one the helper offered, so the next is its last resort.
    const offered = new Set<string>();
    for (let n = 1; n < 100; n++) offered.add(registerAgent(org, freeConnectionName(org, long)).agentName);
    expect(offered.size).toBe(99);
    const free = freeConnectionName(org, long);
    expect(free.length).toBeLessThanOrEqual(MAX_AGENT_NAME_CHARS);
    expect(checkAgentName(org, free)).toBe(free);
  });

  it("a client's display name with control characters still gives a valid default", () => {
    const org = workspace(person());
    const free = freeConnectionName(org, "Grok\u0000\tBot\u0007 \n");
    expect(free).toBe("Grok Bot");
    expect(checkAgentName(org, free)).toBe(free);
    expect(freeConnectionName(org, "\u0001\u0002")).toBe("Connection");
  });

  it("a profile's name is refused like a taken one, with a free name filled in", () => {
    const p = person();
    const org = workspace(p);
    db.prepare(`INSERT INTO agent_profiles (id, org_id, name, name_key) VALUES (?, ?, 'Atlas', 'atlas')`).run(randomUUID(), org);
    const refused = approveConsent({ consentId: consentFor(p, dcrClient()), personId: p, orgId: org, connectionName: "Atlas" });
    expect(refused).toMatchObject({ ok: false, reason: "invalid_name", suggestedName: "Atlas 2", message: "Atlas is taken. We filled in Atlas 2." });
  });
});

describe("connector names can't pass for another agent (second review, finding A)", () => {
  const typed = (org: string, p: string, name: string) =>
    approveConsent({ consentId: consentFor(p, dcrClient()), personId: p, orgId: org, connectionName: name });

  it("a default from a client_name equal to, or an invisible-character copy of, an existing agent's name gets a suffix", () => {
    const org = workspace(person());
    registerAgent(org, "Trusted Ops");
    expect(freeConnectionName(org, "Trusted Ops")).toBe("Trusted Ops 2");
    expect(freeConnectionName(org, "trusted\u200b ops")).toBe("trusted ops 2");
    expect(freeConnectionName(org, "\u202eTrusted Ops\u202c")).toBe("Trusted Ops 2");
    expect(freeConnectionName(org, "\uff34\uff52\uff55\uff53\uff54\uff45\uff44 \uff2f\uff50\uff53")).toBe("Trusted Ops 2");
  });

  it("a removed agent's name counts too, folded the same way", () => {
    const org = workspace(person());
    const old = registerAgent(org, "Night Watch");
    db.prepare(`UPDATE agents SET removed_at = datetime('now') WHERE id = ?`).run(old.agentId);
    expect(freeConnectionName(org, "NIGHT\u2060 WATCH")).toBe("NIGHT WATCH 2");
  });

  it("a typed name with a zero-width or bidi character is refused outright, and nothing is created", () => {
    const p = person();
    const org = workspace(p);
    registerAgent(org, "Atlas Bot");
    for (const name of ["Atlas\u200dBot", "Atlas \u200bBot", "\u202eAtlas Bot\u202c", "\u2066Atlas Bot\u2069", "Atlas Bot\u200f", "\ufeffAtlas Bot"]) {
      const res = typed(org, p, name);
      expect(res, JSON.stringify(name)).toMatchObject({ ok: false, reason: "invalid_name", message: "Use letters, numbers, spaces and punctuation." });
    }
    expect(count(`agents WHERE org_id = ? AND kind = 'connector'`, org)).toBe(0);
  });

  it("a typed case or compatibility variant of an existing name is refused with a free suggestion", () => {
    const p = person();
    const org = workspace(p);
    registerAgent(org, "Atlas Bot");
    expect(typed(org, p, "ATLAS BOT")).toMatchObject({ ok: false, reason: "invalid_name", suggestedName: "ATLAS BOT 2" });
    expect(typed(org, p, "\uff21\uff54\uff4c\uff41\uff53 \uff22\uff4f\uff54")).toMatchObject({ ok: false, reason: "invalid_name", suggestedName: "Atlas Bot 2" });
    expect(count(`agents WHERE org_id = ? AND kind = 'connector'`, org)).toBe(0);
  });

  it("an existing agent whose own name carries compatibility or invisible characters is matched folded, too", () => {
    const p = person();
    const org = workspace(p);
    registerAgent(org, "\uff32\uff45\uff4c\uff41\uff59");
    // Stored before the name rules (registerAgent refuses it now), so it is written directly.
    const legacy = registerAgent(org, "Gate legacy");
    db.prepare(`UPDATE agents SET name = ? WHERE id = ?`).run("Ga\u200bte", legacy.agentId);
    expect(freeConnectionName(org, "Relay")).toBe("Relay 2");
    expect(typed(org, p, "Gate")).toMatchObject({ ok: false, reason: "invalid_name", suggestedName: "Gate 2", message: "Gate looks like Gate, an agent in this workspace. We filled in Gate 2." });
  });

  it("a typed name is stored in its NFC form, as on every path (fullwidth letters kept, runs of space collapsed)", () => {
    const p = person();
    const org = workspace(p);
    const ok = approved(typed(org, p, "\uff27\uff52\uff4f\uff4b  Desk"));
    expect(connectorAgents(org).find((a) => a.id === ok.agentId)?.name).toBe("\uff27\uff52\uff4f\uff4b Desk");
  });
});

describe("every format and filler character counts as invisible (re-review of finding A)", () => {
  // Each is invisible in a name and survives NFKC; written as escapes, never as the characters themselves.
  const HIDDEN = ["\u00ad", "\u061c", "\u3164", "\ufe0f", "\u2062", "\u206a", "\u034f", "\u180e", "\u115f", "\u1160", "\ufe00"];
  const typed = (org: string, p: string, name: string) =>
    approveConsent({ consentId: consentFor(p, dcrClient()), personId: p, orgId: org, connectionName: name });

  it("a typed copy of an existing name with any of them is refused, and nothing is created", () => {
    const p = person();
    const org = workspace(p);
    registerAgent(org, "Ops");
    for (const hidden of HIDDEN) {
      expect(typed(org, p, `Ops${hidden}`), `U+${hidden.codePointAt(0)!.toString(16)}`)
        .toMatchObject({ ok: false, reason: "invalid_name", message: "Use letters, numbers, spaces and punctuation." });
    }
    expect(count(`agents WHERE org_id = ? AND kind = 'connector'`, org)).toBe(0);
  });

  it("a default carrying any of them is cleaned and gets a suffix", () => {
    const org = workspace(person());
    registerAgent(org, "Ops");
    for (const hidden of HIDDEN) expect(freeConnectionName(org, `O${hidden}ps`), `U+${hidden.codePointAt(0)!.toString(16)}`).toBe("Ops 2");
  });

  it("trimming to the length limit never splits a surrogate pair", () => {
    const org = workspace(person());
    // An astral letter (U+20000, Han, allowed with Latin) at the limit; an emoji would be refused before any cut.
    const wanted = `${"A".repeat(MAX_AGENT_NAME_CHARS - 3)}\u{20000}`;
    registerAgent(org, wanted);
    const free = freeConnectionName(org, wanted);
    expect(free.length).toBeLessThanOrEqual(MAX_AGENT_NAME_CHARS);
    expect(free).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(checkAgentName(org, free)).toBe(free);
  });
});

describe("mixed scripts can't make a lookalike connector name (round 3, S1)", () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  const CYRILLIC_O = cp(0x41e);
  const CYRILLIC_WORD = cp(0x41e, 0x43f, 0x441);
  const typed = (org: string, p: string, name: string) =>
    approveConsent({ consentId: consentFor(p, dcrClient()), personId: p, orgId: org, connectionName: name });

  it("a typed name mixing Latin with Cyrillic or Greek is refused; one script alone is fine", () => {
    const p = person();
    const org = workspace(p);
    expect(typed(org, p, `${CYRILLIC_O}ps`)).toMatchObject({ ok: false, reason: "invalid_name", message: "Use letters from one alphabet." });
    expect(typed(org, p, `${cp(0x39f)}ps`)).toMatchObject({ ok: false, reason: "invalid_name", message: "Use letters from one alphabet." });
    expect(count(`agents WHERE org_id = ? AND kind = 'connector'`, org)).toBe(0);
    approved(typed(org, p, "Ops"));
    approved(typed(workspace(p), p, CYRILLIC_WORD));
  });

  it("a default from a mixed client_name loses its lookalikes, so it can't pass for an existing agent", () => {
    const org = workspace(person());
    expect(freeConnectionName(org, `${CYRILLIC_O}ps`)).toBe("Ops");
    registerAgent(org, "Ops");
    expect(freeConnectionName(org, `${CYRILLIC_O}ps`)).toBe("Ops 2");
    expect(freeConnectionName(org, `Ops${cp(0x436)}`), "an unmapped letter is dropped").toBe("Ops 2");
    expect(freeConnectionName(org, CYRILLIC_WORD), "one script alone is kept").toBe(CYRILLIC_WORD);
  });
});

// The console finds a Grok Bot connection by the OAuth client it came from, not by its agent name: a person names the
// connection at consent (ROBIN's Grok Bot is called "ROBIN") and can rename it later.
describe("the roster names a connector's OAuth client", () => {
  // Keyed by the roster's connector ids (oauth_grants_agent_idx), never a scan of every grant in the workspace.
  const grantReads = (run: () => unknown) => {
    const spy = vi.spyOn(db, "prepare");
    try {
      run();
      return spy.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes("oauth_grants"));
    } finally {
      spy.mockRestore();
    }
  };

  it("a workspace with no connector reads no grant at all, and its roster is whole", () => {
    const p = person();
    const org = workspace(p);
    const keyed = registerAgent(org, "grokker");
    let roster: ReturnType<typeof listActiveAgents> = [];
    expect(grantReads(() => { roster = listActiveAgents(org); })).toEqual([]);
    expect(roster.find((a) => a.id === keyed.agentId)).toBeTruthy();
    expect(roster.every((a) => !("client_name" in a))).toBe(true);
  });

  it("with connectors, the grant read is by agent id, not by workspace", () => {
    const p = person();
    const org = workspace(p);
    const grok = dcrClient("Grok Bot", ["https://www.cursor.com/agents/mcp/oauth/callback"]);
    approved(approveConsent({ consentId: consentFor(p, grok, { redirectUri: "https://www.cursor.com/agents/mcp/oauth/callback" }), personId: p, orgId: org, connectionName: "Grok Bot" }));
    const reads = grantReads(() => listActiveAgents(org));
    expect(reads).toHaveLength(1);
    // Keyed by agent id; the workspace is bound too, as defence in depth.
    expect(reads[0]).toMatch(/g\.agent_id IN \([^)]*\) AND g\.org_id = \?/);
  });

  it("a connector carries its newest grant's client_name; a keyed agent carries none", () => {
    const p = person();
    const org = workspace(p);
    const grok = dcrClient("Grok Bot", ["https://www.cursor.com/agents/mcp/oauth/callback"]);
    const r = approved(approveConsent({ consentId: consentFor(p, grok, { redirectUri: "https://www.cursor.com/agents/mcp/oauth/callback" }), personId: p, orgId: org, connectionName: "Research bot" }));
    const keyed = registerAgent(org, "grokker");
    const row = (id: string) => listActiveAgents(org).find((a) => a.id === id)!;
    expect(row(r.agentId)).toMatchObject({ name: "Research bot", kind: "connector", client_name: "Grok Bot" });
    expect(row(keyed.agentId).client_name ?? null).toBeNull();
    // Several grants for one agent: the newest one's client names it.
    const other = dcrClient("Claude");
    const at = (ms: number) => new Date(ms).toISOString();
    db.prepare(`INSERT INTO oauth_grants (grant_id, person_id, client_id, org_id, scope_key, agent_id, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), p, other, org, "older", r.agentId, at(Date.now() - 86_400_000), at(Date.now() - 86_000_000));
    expect(row(r.agentId).client_name).toBe("Grok Bot");
    db.prepare(`INSERT INTO oauth_grants (grant_id, person_id, client_id, org_id, scope_key, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), p, other, org, "newer", r.agentId, at(Date.now() + 1000));
    expect(row(r.agentId).client_name).toBe("Claude");
    // A grant row naming this agent under another workspace never names it here, however new.
    const elsewhere = workspace(p);
    db.prepare(`INSERT INTO oauth_grants (grant_id, person_id, client_id, org_id, scope_key, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), p, grok, elsewhere, "foreign", r.agentId, at(Date.now() + 5000));
    expect(row(r.agentId).client_name).toBe("Claude");
  });
});

describe("connector names against skeletons, scripts and reserved names (round 4)", () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  const typed = (org: string, p: string, name: string) =>
    approveConsent({ consentId: consentFor(p, dcrClient()), personId: p, orgId: org, connectionName: name });

  it("a default whose skeleton collides gets a suffix; a reserved one too; a mixed one loses its stray letters", () => {
    const org = workspace(person());
    registerAgent(org, "Ops");
    expect(freeConnectionName(org, "0ps")).toBe("0ps 2");
    // A reserved word is not made free by a number: the neutral default (F4).
    expect(freeConnectionName(org, "Admin")).toBe("Connection");
    expect(freeConnectionName(org, `${cp(0x555)}ps`), "an Armenian O becomes the Latin O it imitates").toBe("Ops 2");
    expect(freeConnectionName(org, `${cp(0x301)}Atlas${cp(0x2800)}`)).toBe("Atlas");
    expect(freeConnectionName(org, "Grok Bot")).toBe("Grok Bot");
  });

  it("typed: lookalikes and reserved names come back with a free name; unreadable or mixed names are refused", () => {
    const p = person();
    const org = workspace(p);
    registerAgent(org, "Ops");
    expect(typed(org, p, "0ps")).toMatchObject({ ok: false, reason: "invalid_name", suggestedName: "0ps 2", message: "0ps looks like Ops, an agent in this workspace. We filled in 0ps 2." });
    expect(typed(org, p, "Admin")).toMatchObject({ ok: false, reason: "invalid_name", suggestedName: "Connection", message: "Admin is a reserved name. We filled in Connection." });
    expect(typed(org, p, `Atlas${cp(0x2800)}`)).toMatchObject({ ok: false, message: "Use letters, numbers, spaces and punctuation." });
    expect(typed(org, p, `${cp(0x301)}Atlas`)).toMatchObject({ ok: false, message: "Use letters, numbers, spaces and punctuation." });
    expect(typed(org, p, cp(0x39a, 0x435, 0x440, 0x442))).toMatchObject({ ok: false, message: "Use letters from one alphabet." });
    expect(count(`agents WHERE org_id = ? AND kind = 'connector'`, org)).toBe(0);
    approved(typed(org, p, "Cursor-b781"));
  });
});

describe("no emoji in names (operator decision, 2026-10-31)", () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  const typed = (org: string, p: string, name: string) =>
    approveConsent({ consentId: consentFor(p, dcrClient()), personId: p, orgId: org, connectionName: name });

  it("a typed name with an emoji is refused; digits, # and * alone are fine", () => {
    const p = person();
    const org = workspace(p);
    for (const name of [`Bot ${cp(0x1f680)}`, `Bot ${cp(0x1f1fa, 0x1f1f8)}`, `Bot 1${cp(0xfe0f, 0x20e3)}`, `Bot ${cp(0x1f44d, 0x1f3fd)}`, `Bot ${cp(0x2764)}`]) {
      expect(typed(org, p, name), JSON.stringify([...name].map((c) => c.codePointAt(0)!.toString(16)))).toMatchObject({ ok: false, reason: "invalid_name", message: "Use letters, numbers, spaces and punctuation." });
    }
    expect(count(`agents WHERE org_id = ? AND kind = 'connector'`, org)).toBe(0);
    expect(approved(typed(org, p, "Agent #1")).ok).toBe(true);
    expect(approved(typed(org, p, "Bot *2")).ok).toBe(true);
  });

  it("a client_name with emoji gives a default without them, never a refusal", () => {
    const org = workspace(person());
    expect(freeConnectionName(org, `${cp(0x1f916)} Grok Bot`)).toBe("Grok Bot");
    expect(freeConnectionName(org, cp(0x1f916, 0x1f680))).toBe("Connection");
  });
});
