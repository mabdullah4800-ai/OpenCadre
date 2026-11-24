import type { AddressInfo } from "node:net";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { approveConsent, createConsent, revokeGrant, CONSENT_TTL_MS } from "../src/oauth-authorize.js";
import { ACCESS_TOKEN_TTL_SECONDS, mcpResource, pruneExpiredCodes, pruneDeadTokens, REFRESH_TOKEN_TTL_SECONDS, verifyAccessToken } from "../src/oauth.js";
import { count, dcrClient, person, workspace } from "./helpers/oauth-fixtures.js";

// POST /oauth/token (plan 2026-09-29 §5 Task 5 and §7; docs/design/MCP-CONNECTOR.md §3 "Tokens"; RFC 6749 §4.1.3/§5,
// OAuth 2.1 §4.1.2 for code reuse, RFC 7636 for PKCE, RFC 8707 for resource).

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { process.env.OPENCADRE_OAUTH = "on"; });
afterEach(() => { delete process.env.OPENCADRE_OAUTH; });

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
let ipCounter = 0;
const nextIp = () => `198.19.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;
const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

function mintCode({ redirectUri = CALLBACK, nowMs = Date.now() }: { redirectUri?: string; nowMs?: number } = {}) {
  const personId = person();
  const orgId = workspace(personId);
  const clientId = dcrClient("Claude", [CALLBACK, "http://127.0.0.1/callback"]);
  const verifier = randomBytes(32).toString("base64url");
  const consentId = createConsent({ personId, clientId, redirectUri, resource: mcpResource(), codeChallenge: challengeOf(verifier), state: "s" }, nowMs);
  const approved = approveConsent({ consentId, personId, orgId, connectionName: `Conn-${randomBytes(3).toString("hex")}` }, nowMs);
  if (!approved.ok) throw new Error(approved.message);
  return { ...approved, personId, orgId, clientId, verifier, redirectUri };
}
type Minted = ReturnType<typeof mintCode>;
const exchangeFields = (m: Minted, over: Record<string, string | undefined> = {}) => {
  const fields: Record<string, string | undefined> = {
    grant_type: "authorization_code", code: m.code, redirect_uri: m.redirectUri, code_verifier: m.verifier, client_id: m.clientId,
    resource: mcpResource(), ...over,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string>;
};
const form = (fields: Record<string, string>, ip = nextIp()) => fetch(`${base}/oauth/token`, {
  method: "POST", body: new URLSearchParams(fields).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
});
const json = (body: unknown, ip = nextIp()) => fetch(`${base}/oauth/token`, {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "content-type": "application/json", "x-forwarded-for": ip },
});
type TokenBody = { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("pragma")).toBe("no-cache");
  const body = (await res.json()) as { error: string; error_description?: string };
  expect(body.error).toBe(error);
  return body;
}

describe("authorization_code", () => {
  it("is 404 while dormant", async () => {
    delete process.env.OPENCADRE_OAUTH;
    expect((await form({ grant_type: "authorization_code" })).status).toBe(404);
  });

  it("form-encoded: issues an access and refresh token for the connector agent, no-store, bound to the grant", async () => {
    const m = mintCode();
    const res = await form(exchangeFields(m));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = (await res.json()) as TokenBody;
    expect(body).toEqual({
      access_token: expect.stringMatching(/^oca_/), refresh_token: expect.stringMatching(/^ocr_/), token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS, scope: "fleet",
    });
    expect(verifyAccessToken(body.access_token, mcpResource())).toMatchObject({ agentId: m.agentId, orgId: m.orgId, role: "agent", connectorPersonId: m.personId });
    expect(db.prepare(`SELECT DISTINCT grant_id FROM oauth_tokens WHERE agent_id = ?`).pluck().all(m.agentId)).toEqual([m.grantId]);
    expect(db.prepare(`SELECT used_at FROM oauth_codes WHERE grant_id = ?`).pluck().get(m.grantId)).not.toBeNull();
  });

  it("JSON: the same exchange works", async () => {
    const m = mintCode();
    const res = await json(exchangeFields(m));
    expect(res.status).toBe(200);
    expect(((await res.json()) as TokenBody).access_token).toMatch(/^oca_/);
  });

  it("no resource at the token endpoint: the code's own resource applies (RFC 8707 §2.2), in both encodings", async () => {
    for (const send of [form, json]) {
      const m = mintCode();
      const res = await send(exchangeFields(m, { resource: undefined }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as TokenBody;
      expect(verifyAccessToken(body.access_token, mcpResource())).toMatchObject({ agentId: m.agentId, orgId: m.orgId });
    }
  });

  it("a wrong verifier is refused and does not spend the code; the right one then works", async () => {
    const m = mintCode();
    await expectError(await form(exchangeFields(m, { code_verifier: randomBytes(32).toString("base64url") })), 400, "invalid_grant");
    expect((await form(exchangeFields(m))).status).toBe(200);
  });

  it("plain PKCE is refused: the challenge itself as the verifier does not match", async () => {
    const m = mintCode();
    const challenge = challengeOf(m.verifier);
    await expectError(await form(exchangeFields(m, { code_verifier: challenge })), 400, "invalid_grant");
  });

  it.each([
    ["a malformed verifier", { code_verifier: "short" }, 400, "invalid_request"],
    ["no verifier", { code_verifier: undefined }, 400, "invalid_request"],
    ["no code", { code: undefined }, 400, "invalid_request"],
    ["no redirect_uri", { redirect_uri: undefined }, 400, "invalid_request"],
    ["no client_id", { client_id: undefined }, 400, "invalid_request"],
    ["another redirect", { redirect_uri: "https://claude.ai/api/mcp/auth_callback/" }, 400, "invalid_grant"],
    ["another client", { client_id: "dcr_00000000000000000000000000000000" }, 400, "invalid_grant"],
    ["another resource", { resource: "https://elsewhere.example/mcp" }, 400, "invalid_target"],
    ["an unknown code", { code: randomBytes(32).toString("base64url") }, 400, "invalid_grant"],
  ] as const)("with %s: %s %s", async (_label, over, status, error) => {
    const m = mintCode();
    await expectError(await form(exchangeFields(m, over as Record<string, string | undefined>)), status, error);
    expect(db.prepare(`SELECT used_at FROM oauth_codes WHERE grant_id = ?`).pluck().get(m.grantId), "a refused exchange spends nothing").toBeNull();
  });

  it("the redirect must be the exact one used at authorize, loopback port included", async () => {
    const m = mintCode({ redirectUri: "http://127.0.0.1:53682/callback" });
    await expectError(await form(exchangeFields(m, { redirect_uri: "http://127.0.0.1:1111/callback" })), 400, "invalid_grant");
    expect((await form(exchangeFields(m))).status).toBe(200);
  });

  it("an expired code is refused", async () => {
    const m = mintCode({ nowMs: Date.now() - CONSENT_TTL_MS + 1000 - 61_000 });
    await expectError(await form(exchangeFields(m)), 400, "invalid_grant");
  });

  it("a code for a grant revoked since approval is refused", async () => {
    const m = mintCode();
    revokeGrant(m.grantId);
    await expectError(await form(exchangeFields(m)), 400, "invalid_grant");
  });

  it("a reused code is refused AND revokes the family it minted (OAuth 2.1 §4.1.2)", async () => {
    const m = mintCode();
    const first = (await (await form(exchangeFields(m))).json()) as TokenBody;
    expect(verifyAccessToken(first.access_token, mcpResource())).not.toBeNull();
    await expectError(await form(exchangeFields(m)), 400, "invalid_grant");
    expect(verifyAccessToken(first.access_token, mcpResource()), "the leaked code's tokens die with it").toBeNull();
    const refresh = await form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: m.clientId });
    await expectError(refresh, 400, "invalid_grant");
  });

  it("two exchanges of one code at once: exactly one succeeds, and the reuse revokes what it got", async () => {
    const m = mintCode();
    const results = await Promise.all([form(exchangeFields(m)), form(exchangeFields(m))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = (await results.find((r) => r.status === 200)!.json()) as TokenBody;
    expect(verifyAccessToken(winner.access_token, mcpResource())).toBeNull();
    expect(count(`oauth_tokens WHERE agent_id = ?`, m.agentId)).toBe(2);
  });
});

describe("refresh_token", () => {
  it("rotates through the existing function: the new pair works, the spent token is reuse and revokes the family", async () => {
    const m = mintCode();
    const first = (await (await form(exchangeFields(m))).json()) as TokenBody;
    const res = await json({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: m.clientId, resource: mcpResource() });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const next = (await res.json()) as TokenBody;
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(verifyAccessToken(next.access_token, mcpResource())?.agentId).toBe(m.agentId);
    await expectError(await form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: m.clientId }), 400, "invalid_grant");
    expect(verifyAccessToken(next.access_token, mcpResource()), "reuse revoked the whole family").toBeNull();
  });

  it("another client, another resource, or no token is refused", async () => {
    const m = mintCode();
    const first = (await (await form(exchangeFields(m))).json()) as TokenBody;
    await expectError(await form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: "dcr_other" }), 400, "invalid_grant");
    await expectError(await form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: m.clientId, resource: "https://elsewhere.example/mcp" }), 400, "invalid_target");
    await expectError(await form({ grant_type: "refresh_token", client_id: m.clientId }), 400, "invalid_request");
    expect((await form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: m.clientId })).status, "none of those spent it").toBe(200);
  });
});

describe("the endpoint", () => {
  it("refuses an unknown grant type, and a malformed or empty body, in the RFC 6749 shape", async () => {
    await expectError(await form({ grant_type: "password", username: "a", password: "b" }), 400, "unsupported_grant_type");
    await expectError(await form({}), 400, "invalid_request");
    await expectError(await json("{not json"), 400, "invalid_request");
    const other = await fetch(`${base}/oauth/token`, { method: "POST", body: "grant_type=authorization_code", headers: { "content-type": "text/plain", "x-forwarded-for": nextIp() } });
    await expectError(other, 400, "invalid_request");
  });

  it("is rate-limited per network", async () => {
    const ip = nextIp();
    const limit = Number(process.env.OPENCADRE_OAUTH_TOKEN_PER_MIN) || 120;
    const statuses: number[] = [];
    for (let i = 0; i <= limit; i++) statuses.push((await form({ grant_type: "password" }, ip)).status);
    expect(statuses.slice(0, limit).every((s) => s === 400)).toBe(true);
    const limited = await form({ grant_type: "password" }, ip);
    await expectError(limited, 429, "rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await form({ grant_type: "password" }, nextIp())).status).toBe(400);
  });
});

it("the sweep deletes token rows expired or revoked longer than the refresh TTL ago, and keeps the rest", async () => {
  const m = mintCode();
  const tokens = (await (await form(exchangeFields(m))).json()) as TokenBody;
  const hash = (t: string) => createHash("sha256").update(t).digest("hex");
  const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const ttlDays = REFRESH_TOKEN_TTL_SECONDS / 86_400;
  db.prepare(`UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?`).run(ago(ttlDays + 1), hash(tokens.access_token));
  db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?`).run(ago(ttlDays + 1), hash(tokens.refresh_token));
  const recent = mintCode();
  const kept = (await (await form(exchangeFields(recent))).json()) as TokenBody;
  db.prepare(`UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?`).run(ago(1), hash(kept.access_token));
  db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?`).run(ago(1), hash(kept.refresh_token));
  expect(pruneDeadTokens()).toBeGreaterThanOrEqual(2);
  const exists = (t: string) => count(`oauth_tokens WHERE token_hash = ?`, hash(t)) === 1;
  expect([exists(tokens.access_token), exists(tokens.refresh_token)]).toEqual([false, false]);
  expect([exists(kept.access_token), exists(kept.refresh_token)], "dead for a day only: kept (reuse is still recognised)").toEqual([true, true]);
});

it("the sweep deletes codes a day past expiry and keeps recent ones (reuse detection reads them)", () => {
  const old = mintCode({ nowMs: Date.now() - 2 * 24 * 60 * 60_000 });
  const recent = mintCode();
  db.prepare(`UPDATE oauth_codes SET used_at = ? WHERE grant_id = ?`).run(new Date().toISOString(), recent.grantId);
  expect(pruneExpiredCodes()).toBeGreaterThanOrEqual(1);
  expect(count(`oauth_codes WHERE grant_id = ?`, old.grantId)).toBe(0);
  expect(count(`oauth_codes WHERE grant_id = ?`, recent.grantId)).toBe(1);
});
