import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import {
  acceptableRedirectUri, clientNameFrom, issueTokenFamily, mcpResource, oauthIpKey, oauthIssuer, pruneStaleDcrClients,
  redirectMatches, registerDynamicClient,
} from "../src/oauth.js";
import { createOrganization, registerAgent } from "../src/service.js";

// The MCP connector, authorization side (docs/design/MCP-CONNECTOR.md §3/§4, plan
// docs/superpowers/plans/2026-09-29-oauth-authorization.md). Dormant behind OPENCADRE_OAUTH=on.

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => { delete process.env.OPENCADRE_OAUTH; });

describe("redirect URIs (design §3: exact match, loopback port ignored, https or loopback only)", () => {
  it("match exactly", () => {
    expect(redirectMatches("https://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    for (const presented of [
      "https://claude.ai/api/mcp/auth_callback/", "https://claude.ai/api/mcp/auth_callbacK", "https://claude.ai:443/api/mcp/auth_callback",
      "https://CLAUDE.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback?x=1", "https://claude.ai.evil.example/api/mcp/auth_callback",
      "https://claude.ai:8443/api/mcp/auth_callback",
    ]) expect(redirectMatches("https://claude.ai/api/mcp/auth_callback", presented), presented).toBe(false);
  });

  // Plan §7.5 (RFC 8252 §7.3): the port is ignored for the three loopback forms, and only for them.
  it.each(["http://127.0.0.1", "http://[::1]", "http://localhost"])("ignores the port of %s, and nothing else", (origin) => {
    expect(redirectMatches(`${origin}/callback`, `${origin}:53682/callback`)).toBe(true);
    expect(redirectMatches(`${origin}:8787/callback`, `${origin}:9999/callback`)).toBe(true);
    expect(redirectMatches(`${origin}/callback`, `${origin}:53682/callback2`), "the path still matches exactly").toBe(false);
    expect(redirectMatches(`${origin}/callback`, `${origin}:53682/callback?x=1`), "the query still matches exactly").toBe(false);
  });

  it("gives no other host the port leniency, and never crosses loopback forms", () => {
    expect(redirectMatches("https://claude.ai/cb", "https://claude.ai:444/cb")).toBe(false);
    expect(redirectMatches("https://localhost/cb", "https://localhost:444/cb"), "https loopback is not the RFC 8252 case").toBe(false);
    expect(redirectMatches("http://localhost/cb", "http://127.0.0.1:5000/cb")).toBe(false);
    expect(redirectMatches("http://127.0.0.1/cb", "http://127.0.0.2:5000/cb")).toBe(false);
    expect(redirectMatches("http://localhost/cb", "http://localhost.evil.example:5000/cb")).toBe(false);
    expect(redirectMatches("http://localhost/cb", "http://localhost:5000@evil.example/cb")).toBe(false);
  });

  it("accepts https and the three loopback http forms", () => {
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect",
      "http://localhost/callback", "http://localhost:8787/callback", "http://127.0.0.1:53682/callback", "http://[::1]:8080/cb",
    ]) expect(acceptableRedirectUri(uri), uri).toBe(true);
  });

  it("refuses non-loopback http, other schemes, fragments, credentials and junk", () => {
    for (const uri of [
      "http://example.com/callback", "http://127.0.0.2/callback", "http://localhost.evil.example/cb", "http://10.0.0.1/cb",
      "cursor://anysphere.cursor-retrieval/oauth", "javascript:alert(1)", "https://claude.ai/cb#frag", "https://claude.ai/cb#",
      "http://localhost/cb#x", "https://user:pw@claude.ai/cb", "https://claude.ai@evil.example/cb", "not a url", "",
      "https://claude.ai/cb\n", " https://claude.ai/cb",
    ]) expect(acceptableRedirectUri(uri), JSON.stringify(uri)).toBe(false);
  });

  // Security review (Sonnet, 2026-09-29): each of these parses to a host other than the one a person reads, or hides a
  // character they cannot see. Only the canonical form (the URL parser's own serialisation) is acceptable.
  it.each([
    "https://evil.com\\@claude.ai/cb", "https://claude.ai\\.evil.com/cb", "https://claude.ai/cb\\x",
    "https://@evil.com/cb", "https://:@evil.com/cb", "https://%65vil.com/cb", "https://claude.ai:443/cb", "https://CLAUDE.ai/cb",
    "https://claude.ai/a/../cb", "https://claude\u200b.ai/cb", "https://claude.ai/cb\u200b", "https://claude.ai/\u202ebc",
    "https://cl\u00e4ude.ai/cb", "https://claude.ai/caf\u00e9", "http://localhost:0/callback", "http://127.0.0.1:0/cb", "http://[::1]:0/cb",
    "http://localhost:80/callback", "http://LOCALHOST/cb",
  ])("refuses the non-canonical or deceptive %j", (uri) => expect(acceptableRedirectUri(uri)).toBe(false));

  // Security review N1: the redirect's origin goes into the consent page's CSP, so its host must be a plain host name.
  it.each(["https://*/cb", "https://*.example.com/cb", "https://a;b.example/cb", "https://a,b.example/cb", "https://a'b.example/cb", "https://a!b.example/cb", "https://a_b.example/cb"])(
    "refuses a host with characters no plain host name has: %s", (uri) => expect(acceptableRedirectUri(uri)).toBe(false));

  it("still accepts ordinary and punycode hosts", () => {
    for (const uri of ["https://claude.ai/cb", "https://sub-1.example.co.uk/cb", "https://xn--bcher-kva.example/cb", "http://[::1]:8080/cb"]) {
      expect(acceptableRedirectUri(uri), uri).toBe(true);
    }
  });

  it("accepts a bare origin, which the parser only gives a trailing slash", () => {
    expect(acceptableRedirectUri("https://claude.ai")).toBe(true);
    expect(acceptableRedirectUri("http://localhost:8787")).toBe(true);
    expect(redirectMatches("https://claude.ai", "https://claude.ai/"), "still an exact string match").toBe(false);
  });

  it("an unacceptable URI never matches, even against itself", () => {
    expect(redirectMatches("http://example.com/cb", "http://example.com/cb")).toBe(false);
    expect(redirectMatches("https://claude.ai/cb#f", "https://claude.ai/cb#f")).toBe(false);
  });
});

describe("authorization server metadata (RFC 8414; plan §3)", () => {
  it("is 404 while dormant", async () => {
    expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(404);
  });

  it("with OPENCADRE_OAUTH=on: exactly the plan's fields", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const issuer = oauthIssuer();
    expect(await res.json()).toEqual({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      scopes_supported: ["fleet"],
    });
  });
});

describe("dynamic client registration (RFC 7591; design §3 \"DCR fallback\"; plan §3)", () => {
  // Each test registers from its own address (the app trusts loopback proxies), so the per-IP limit stays per test.
  let ipCounter = 0;
  const nextIp = () => `198.51.100.${++ipCounter}`;
  const register = (body: unknown, ip = nextIp(), raw?: string) => fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: raw ?? JSON.stringify(body),
  });
  const claudeCode = {
    client_name: "Claude Code",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  const rowOf = (clientId: string) =>
    db.prepare(`SELECT kind, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?`).get(clientId) as
      { kind: string; client_name: string | null; redirect_uris: string } | undefined;
  const countRows = () => (db.prepare(`SELECT COUNT(*) AS n FROM oauth_clients`).get() as { n: number }).n;

  it("is 404 while dormant, and stores nothing", async () => {
    const before = countRows();
    expect((await register(claudeCode)).status).toBe(404);
    expect(countRows()).toBe(before);
  });

  it("registers a public client under a random client_id, stored as kind 'dcr'", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const res = await register(claudeCode);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      client_id: expect.stringMatching(/^dcr_[0-9a-f]{32}$/),
      client_id_issued_at: expect.any(Number),
      client_name: "Claude Code",
      redirect_uris: claudeCode.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(body).not.toHaveProperty("client_secret");
    expect(Math.abs((body.client_id_issued_at as number) - Date.now() / 1000)).toBeLessThan(60);
    expect(rowOf(body.client_id as string)).toEqual({ kind: "dcr", client_name: "Claude Code", redirect_uris: JSON.stringify(claudeCode.redirect_uris) });
    const again = (await (await register(claudeCode)).json()) as { client_id: string };
    expect(again.client_id, "every registration is its own client").not.toBe(body.client_id);
  });

  // Grok Bot's registration on 2026-10-30, the connect that worked against production, sent only Cursor's web callback.
  // The three-URI set reported for Cursor-built clients adds a cursor:// scheme, which today's rule refuses. If Grok Bot
  // starts sending it, this case is the one to revisit (easy onboarding plan, Slice 6), rather than a silent break.
  // Not an allow-list: the rule accepts any canonical https URI (and http loopback); these are just the URIs Grok Bot sends.
  it("the redirect URIs Grok Bot registers with: the web callback and the loopback pass the general rule, a cursor:// scheme does not", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const grok = (redirect_uris: string[]) => register({ client_name: "Grok Bot", redirect_uris, token_endpoint_auth_method: "none" });
    const web = "https://www.cursor.com/agents/mcp/oauth/callback";
    expect((await grok([web])).status).toBe(201);
    expect((await grok([web, "http://localhost:8787/callback"])).status).toBe(201);
    const before = countRows();
    const refused = await grok([web, "http://localhost:8787/callback", "cursor://anysphere.cursor-mcp/oauth/callback"]);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_redirect_uri" });
    expect(countRows()).toBe(before);
  });

  it("treats an absent auth method as public, and a client_id in the request as nothing", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const res = await register({ redirect_uris: ["https://cursor.com/agents/mcp/oauth/callback"], client_id: "https://evil.example/client.json" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; token_endpoint_auth_method: string; client_name?: string };
    expect(body.client_id).toMatch(/^dcr_/);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body).not.toHaveProperty("client_name");
    expect(rowOf(body.client_id)?.client_name).toBeNull();
  });

  it.each([
    ["a non-loopback http redirect", { redirect_uris: ["http://example.com/callback"] }],
    ["a redirect with a fragment", { redirect_uris: ["https://example.com/callback#x"] }],
    ["a custom scheme", { redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth"] }],
    ["one bad redirect among good ones", { redirect_uris: ["https://example.com/cb", "http://10.0.0.1/cb"] }],
    ["no redirect_uris", { client_name: "x" }],
    ["an empty redirect_uris", { redirect_uris: [] }],
    ["redirect_uris that are not strings", { redirect_uris: [42] }],
    ["redirect_uris that are not a list", { redirect_uris: "https://example.com/cb" }],
  ])("refuses %s with invalid_redirect_uri, and stores nothing", async (_label, body) => {
    process.env.OPENCADRE_OAUTH = "on";
    const before = countRows();
    const res = await register(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_redirect_uri", error_description: expect.any(String) });
    expect(countRows()).toBe(before);
  });

  it.each([
    ["a confidential client", { ...claudeCode, token_endpoint_auth_method: "client_secret_basic" }],
    ["a private_key_jwt client", { ...claudeCode, token_endpoint_auth_method: "private_key_jwt" }],
    ["a non-string client_name", { ...claudeCode, client_name: 42 }],
    ["an over-long client_name", { ...claudeCode, client_name: "x".repeat(101) }],
    ["a JSON array", [claudeCode]],
  ])("refuses %s with invalid_client_metadata, and stores nothing", async (_label, body) => {
    process.env.OPENCADRE_OAUTH = "on";
    const before = countRows();
    const res = await register(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_client_metadata", error_description: expect.any(String) });
    expect(countRows()).toBe(before);
  });

  it("answers a body that is not JSON in the RFC 7591 shape", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const res = await register(undefined, nextIp(), "{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_client_metadata", error_description: expect.any(String) });
  });

  it("is rate-limited per IP", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await register(claudeCode, ip)).status);
    expect(statuses.every((s) => s === 201)).toBe(true);
    const limited = await register(claudeCode, ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(await limited.json()).toMatchObject({ error: expect.any(String), error_description: expect.any(String) });
    expect((await register(claudeCode, nextIp())).status, "another network is unaffected").toBe(201);
  });

  // Security review (Sonnet, 2026-09-29), D1.
  it("keys the IPv6 limit on the /64, so rotating addresses inside it buys nothing", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    for (let i = 1; i <= 20; i++) expect((await register(claudeCode, `2001:db8:77:1::${i.toString(16)}`)).status).toBe(201);
    expect((await register(claudeCode, "2001:db8:77:1:ffff:ffff:ffff:ffff")).status, "same /64").toBe(429);
    expect((await register(claudeCode, "2001:db8:77:2::1")).status, "the next /64").toBe(201);
  });

  it("the network key: IPv4 as is, v4-mapped as its IPv4, IPv6 by /64 however it is written", () => {
    expect(oauthIpKey("203.0.113.9")).toBe("ip:203.0.113.9");
    expect(oauthIpKey("::ffff:203.0.113.9")).toBe("ip:203.0.113.9");
    expect(oauthIpKey("2001:db8:0:1::5")).toBe(oauthIpKey("2001:0db8:0000:0001:ffff:0:0:1"));
    expect(oauthIpKey("2001:db8:0:1::5")).not.toBe(oauthIpKey("2001:db8:0:2::5"));
    expect(oauthIpKey(undefined)).toBe("ip:unknown");
  });

  it("takes 20 redirect URIs and refuses 21", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const uris = (n: number) => Array.from({ length: n }, (_, i) => `https://example.com/cb${i}`);
    expect((await register({ redirect_uris: uris(20) })).status).toBe(201);
    const refused = await register({ redirect_uris: uris(21) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("takes a 512-character redirect URI and refuses 513", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const uriOf = (length: number) => `https://example.com/${"a".repeat(length - "https://example.com/".length)}`;
    expect(uriOf(512)).toHaveLength(512);
    expect((await register({ redirect_uris: [uriOf(512)] })).status).toBe(201);
    const refused = await register({ redirect_uris: [uriOf(513)] });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it.each([
    ["a bidi override", "Claude‮edoc"], ["a bidi isolate", "Claude⁦x⁩"], ["a zero-width space", "Clau​de"],
    ["a NUL", "Claude\u0000"], ["a newline", "Claude\nApproved by OpenCadre"], ["a private-use character", "Claude"],
  ])("refuses a client_name with %s", async (_label, name) => {
    process.env.OPENCADRE_OAUTH = "on";
    const res = await register({ ...claudeCode, client_name: name });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_client_metadata" });
    expect(clientNameFrom(name).ok, "the same rule as CIMD").toBe(false);
  });

  it("accepts a client_name in any script", () => {
    expect(clientNameFrom("Claude Code")).toEqual({ ok: true, name: "Claude Code" });
    expect(clientNameFrom("クロード")).toEqual({ ok: true, name: "クロード" });
    expect(clientNameFrom("Café 🤖")).toEqual({ ok: true, name: "Café 🤖" });
  });

  it("answers a body over the 10 MB parser limit in the RFC 7591 shape", async () => {
    process.env.OPENCADRE_OAUTH = "on";
    const res = await register(undefined, nextIp(), JSON.stringify({ ...claudeCode, padding: "x".repeat(10 * 1024 * 1024 + 1) }));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "invalid_client_metadata", error_description: expect.any(String) });
  });
});

describe("pruning DCR clients (D1)", () => {
  const age = (clientId: string, days: number) =>
    db.prepare(`UPDATE oauth_clients SET created_at = datetime('now', ?) WHERE client_id = ?`).run(`-${days} days`, clientId);
  const exists = (clientId: string) => db.prepare(`SELECT 1 FROM oauth_clients WHERE client_id = ?`).get(clientId) !== undefined;
  const newClient = () => {
    const r = registerDynamicClient({ redirect_uris: ["https://example.com/cb"] });
    if (!r.ok) throw new Error(r.error);
    return r.client.client_id;
  };

  it("deletes a DCR client older than 30 days with no codes and no tokens, and nothing else", () => {
    const { orgId } = createOrganization(`Prune ${Date.now()}`);
    const agent = registerAgent(orgId, "Pruned-conn");
    const stale = newClient();
    const young = newClient();
    const withCode = newClient();
    const withToken = newClient();
    const cimd = `https://prune-${Date.now()}.example/client.json`;
    db.prepare(`INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris) VALUES (?, 'cimd', NULL, '[]')`).run(cimd);
    db.prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, person_id, org_id, agent_id, expires_at)
       VALUES (?, ?, 'https://example.com/cb', 'c', ?, 'p', ?, ?, ?)`,
    ).run(`h-${withCode}`, withCode, mcpResource(), orgId, agent.agentId, new Date().toISOString());
    issueTokenFamily({ clientId: withToken, orgId, agentId: agent.agentId, personId: "p", resource: mcpResource(), grantId: "grant-prune" });
    for (const id of [stale, withCode, withToken, cimd]) age(id, 31);
    age(young, 29);

    expect(pruneStaleDcrClients()).toBeGreaterThanOrEqual(1);
    expect(exists(stale), "old, unused DCR client").toBe(false);
    expect(exists(young), "younger than 30 days").toBe(true);
    expect(exists(withCode), "a code still names it").toBe(true);
    expect(exists(withToken), "a token still names it").toBe(true);
    expect(exists(cimd), "only DCR clients are pruned").toBe(true);
  });
});
