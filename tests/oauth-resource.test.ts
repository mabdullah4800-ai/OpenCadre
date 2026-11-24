import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { db } from "../src/db.js";
import {
  ACCESS_TOKEN_TTL_SECONDS, issueTokenFamily, mcpResource, revokeAgentTokens, rotateRefreshToken, verifyAccessToken,
} from "../src/oauth.js";
import { maskSecrets } from "../src/secrets.js";
import { revokeGrant } from "../src/oauth-authorize.js";
import { heldRequestCount } from "../src/revocation.js";
import { revokeTokenFamily } from "../src/oauth.js";
import { addMember, person } from "./helpers/oauth-fixtures.js";

// The MCP connector, resource side (docs/design/MCP-CONNECTOR.md §3, PR1). Dormant behind OPENCADRE_OAUTH=on.

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/mcp" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
        void handleMcpRequest(req, res);
      });
      return;
    }
    app(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => { delete process.env.OPENCADRE_OAUTH; });

let n = 0;
function connection() {
  const { orgId } = createOrganization(`OAuth Resource ${++n}`);
  const agent = registerAgent(orgId, `Claude-${n}a0f`);
  // The approving person is an admin of the workspace: a token is refused once its person may no longer add agents.
  const personId = person();
  addMember(orgId, personId, "admin");
  // Every family belongs to a grant (plan §7.2), and a token is refused once its grant is revoked or gone.
  const clientId = "https://claude.ai/oauth/client.json";
  const grantId = `grant-${n}-${agent.agentId.slice(0, 8)}`;
  db.prepare(`INSERT INTO oauth_grants (grant_id, person_id, client_id, org_id, scope_key, agent_id, created_at) VALUES (?, ?, ?, ?, '*', ?, ?)`)
    .run(grantId, personId, clientId, orgId, agent.agentId, new Date().toISOString());
  const grant = { clientId, orgId, agentId: agent.agentId, personId, resource: mcpResource(), grantId };
  return { orgId, agentId: agent.agentId, grant, pair: issueTokenFamily(grant) };
}

const initialize = (token?: string) => fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-test", version: "0" } } }),
});

describe("an access token", () => {
  it("acts as the agent it was issued for, for this resource only", () => {
    const c = connection();
    expect(verifyAccessToken(c.pair.accessToken, mcpResource())).toMatchObject({ orgId: c.orgId, agentId: c.agentId, role: "agent", connectorPersonId: c.grant.personId });
    expect(verifyAccessToken(c.pair.accessToken, "https://elsewhere.example/mcp"), "audience-bound").toBeNull();
  });

  it("is refused once expired, once revoked, and when a refresh token is presented in its place", () => {
    const c = connection();
    expect(verifyAccessToken(c.pair.accessToken, mcpResource(), Date.now() + (ACCESS_TOKEN_TTL_SECONDS + 1) * 1000)).toBeNull();
    expect(verifyAccessToken(c.pair.refreshToken, mcpResource())).toBeNull();
    revokeAgentTokens(c.agentId);
    expect(verifyAccessToken(c.pair.accessToken, mcpResource())).toBeNull();
  });

  it("is refused once its agent is removed", () => {
    const c = connection();
    db.prepare(`UPDATE agents SET removed_at = ? WHERE id = ?`).run(new Date().toISOString(), c.agentId);
    expect(verifyAccessToken(c.pair.accessToken, mcpResource())).toBeNull();
  });
});

describe("refresh rotation (atomic; reuse revokes the family)", () => {
  it("rotates: the new pair works and the spent refresh token does not", () => {
    const c = connection();
    const next = rotateRefreshToken(c.pair.refreshToken, c.grant.clientId);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(verifyAccessToken(next.accessToken, mcpResource())?.connectorPersonId, "the approving person survives rotation").toBe(c.grant.personId);
    expect(next.refreshToken).not.toBe(c.pair.refreshToken);
  });

  it("a reused refresh token revokes the whole family AT ONCE, including an access token minted after it", () => {
    const c = connection();
    const next = rotateRefreshToken(c.pair.refreshToken, c.grant.clientId);
    if (!next.ok) throw new Error("rotation failed");
    const reuse = rotateRefreshToken(c.pair.refreshToken, c.grant.clientId);
    expect(reuse).toEqual({ ok: false, error: "invalid_grant", reused: true });
    expect(verifyAccessToken(next.accessToken, mcpResource()), "not left to expire in an hour").toBeNull();
    expect(rotateRefreshToken(next.refreshToken, c.grant.clientId).ok, "the family's newest refresh token is dead too").toBe(false);
  });

  it("two refreshes with one token: exactly one wins", () => {
    const c = connection();
    const results = [rotateRefreshToken(c.pair.refreshToken, c.grant.clientId), rotateRefreshToken(c.pair.refreshToken, c.grant.clientId)];
    expect(results.filter((r) => r.ok).length).toBe(1);
  });

  it("another client cannot use the token, and that is not treated as reuse", () => {
    const c = connection();
    expect(rotateRefreshToken(c.pair.refreshToken, "https://other.example/client.json")).toEqual({ ok: false, error: "invalid_grant", reused: false });
    expect(rotateRefreshToken(c.pair.refreshToken, c.grant.clientId).ok).toBe(true);
  });
});

describe("/mcp", () => {
  it("with OPENCADRE_OAUTH=on: a connector's access token is accepted, and a 401 names the metadata", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const c = connection();
    expect((await initialize(c.pair.accessToken)).status).toBe(200);
    const refused = await initialize();
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp", scope="fleet"$/);
  });

  it("with it off (the default) nothing changes: the token is refused and no challenge is sent", async () => {
    const c = connection();
    const refused = await initialize(c.pair.accessToken);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBeNull();
  });
});

describe("protected resource metadata", () => {
  it("is served only while on, naming this resource and this issuer", async () => {
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
    process.env.OPENCADRE_OAUTH = "on";
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as { resource: string; authorization_servers: string[] };
      expect(body.resource).toBe(mcpResource());
      expect(body.authorization_servers).toEqual([mcpResource().replace(/\/mcp$/, "")]);
    }
  });
});

// Security review S4: held MCP requests (wait_for_message) carry the token family they were made with, so revoking one
// family ends exactly that family's held requests, and a second client of the same connector keeps its wait.
describe("held requests end with their own family only", () => {
  /** A wait_for_message held open on /mcp with this access token. Resolves to the HTTP status, or "aborted". */
  function holdWait(token: string, signal: AbortSignal): Promise<number | "aborted"> {
    return fetch(`${base}/mcp`, {
      method: "POST", signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_message", arguments: { timeoutSeconds: 60 } } }),
    }).then(async (res) => {
      if (res.status !== 200) return res.status;
      // An event stream that the revocation cut: reading it fails (or ends) instead of returning a result.
      try { await res.text(); } catch { return 401; }
      return res.status;
    }, () => "aborted" as const);
  }
  // Every wait is aborted after its test, pass or fail, so none keeps the server open.
  const aborts: AbortController[] = [];
  afterEach(() => { for (const a of aborts.splice(0)) a.abort(); });
  async function twoFamiliesWaiting() {
    process.env.OPENCADRE_OAUTH = "on";
    const c = connection();
    const second = issueTokenFamily(c.grant);
    const abort = new AbortController();
    aborts.push(abort);
    const first = holdWait(c.pair.accessToken, abort.signal);
    const other = holdWait(second.accessToken, abort.signal);
    for (let i = 0; i < 200 && heldRequestCount(c.agentId) < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(heldRequestCount(c.agentId)).toBe(2);
    return { c, second, abort, first, other };
  }
  /** Bounded, so a wait that never ends fails the test instead of hanging the file. */
  const within = (p: Promise<unknown>, ms = 3000) => Promise.race([p, new Promise((r) => setTimeout(() => r("still waiting"), ms))]);
  const stillPending = async (p: Promise<unknown>) => (await Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 300))])) === "pending";

  it("revoking one family (RFC 7009) ends that family's held request and not the other's", async () => {
    const w = await twoFamiliesWaiting();
    revokeTokenFamily(w.c.pair.familyId);
    expect(await within(w.first), "the revoked family's wait ends").toBe(401);
    expect(await stillPending(w.other), "the other family's wait is untouched").toBe(true);
    expect(heldRequestCount(w.c.agentId)).toBe(1);
    w.abort.abort();
  });

  it("a reused refresh token ends only the reused family's held requests", async () => {
    const w = await twoFamiliesWaiting();
    const rotated = rotateRefreshToken(w.c.pair.refreshToken, w.c.grant.clientId);
    expect(rotated.ok).toBe(true);
    expect(rotateRefreshToken(w.c.pair.refreshToken, w.c.grant.clientId)).toEqual({ ok: false, error: "invalid_grant", reused: true });
    expect(await within(w.first), "the reused family's wait ends").toBe(401);
    expect(await stillPending(w.other), "the other family's wait is untouched").toBe(true);
    expect(verifyAccessToken(w.second.accessToken, mcpResource()), "and its token still works").not.toBeNull();
    w.abort.abort();
  });
});

// Codex blocker on #651: a token is refused once its GRANT is revoked, even if its own rows escaped revocation (a crash
// between the two writes, or any other path that closes the grant alone), and when its grant row is missing.
describe("the grant is checked on every use", () => {
  it("a revoked grant refuses its tokens on /mcp and at refresh, even with the token rows un-revoked", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const c = connection();
    revokeGrant(c.grant.grantId);
    // The crash window: the grant is revoked but its token rows are not.
    db.prepare(`UPDATE oauth_tokens SET revoked_at = NULL WHERE family_id = ?`).run(c.pair.familyId);
    expect((await initialize(c.pair.accessToken)).status).toBe(401);
    expect(verifyAccessToken(c.pair.accessToken, mcpResource())).toBeNull();
    expect(rotateRefreshToken(c.pair.refreshToken, c.grant.clientId)).toEqual({ ok: false, error: "invalid_grant", reused: false });
  });

  it("a token whose grant row is missing, or that names no grant at all, is refused", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const missing = connection();
    db.prepare(`DELETE FROM oauth_grants WHERE grant_id = ?`).run(missing.grant.grantId);
    expect((await initialize(missing.pair.accessToken)).status).toBe(401);
    expect(rotateRefreshToken(missing.pair.refreshToken, missing.grant.clientId).ok).toBe(false);
    // Tokens minted before grants existed (grant_id NULL) are refused too: the connector was never enabled in
    // production, so no such row exists there, and none can be minted now (issueTokenFamily requires a grant).
    const legacy = connection();
    db.prepare(`UPDATE oauth_tokens SET grant_id = NULL WHERE family_id = ?`).run(legacy.pair.familyId);
    expect(verifyAccessToken(legacy.pair.accessToken, mcpResource())).toBeNull();
    expect(rotateRefreshToken(legacy.pair.refreshToken, legacy.grant.clientId).ok).toBe(false);
  });

  it("revokeGrant is one transaction: if revoking the tokens fails, the grant stays active too", () => {
    const c = connection();
    db.exec(`CREATE TEMP TRIGGER fail_token_revoke BEFORE UPDATE OF revoked_at ON oauth_tokens BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    try {
      expect(() => revokeGrant(c.grant.grantId)).toThrow(/simulated crash/);
    } finally {
      db.exec(`DROP TRIGGER fail_token_revoke`);
    }
    expect(db.prepare(`SELECT revoked_at FROM oauth_grants WHERE grant_id = ?`).pluck().get(c.grant.grantId), "no half-closed grant").toBeNull();
  });
});

it("connector tokens are masked wherever secrets are", () => {
  const c = connection();
  const masked = maskSecrets(`access ${c.pair.accessToken} refresh ${c.pair.refreshToken}`);
  expect(masked).not.toContain(c.pair.accessToken);
  expect(masked).not.toContain(c.pair.refreshToken);
  expect(masked).toMatch(/oca_\S+ refresh ocr_/);
});
