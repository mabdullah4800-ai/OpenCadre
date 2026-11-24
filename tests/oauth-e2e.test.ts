import type { AddressInfo } from "node:net";
import http from "node:http";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// The MCP connector end to end, in process (plan 2026-09-29 §5 Task 7; docs/design/MCP-CONNECTOR.md §2/§3). Two clients
// walk the whole path the way the real ones do, from a bare 401 on /mcp to a revoked token:
//   A, Claude-shaped: discovery from the 401, DCR with a loopback redirect, a different loopback port at authorize,
//     sign-in round trip, consent, form-encoded token request, /mcp as the connector, refresh, refresh reuse, revoke.
//   B, ChatGPT-shaped: a CIMD client_id served by the injected transport, its stable https redirect, iss checked, a
//     JSON token request, approved into ANOTHER project of the same projects-apart workspace.
// Signing in runs for real against a stand-in Supabase Auth (as tests/oauth-authorize-route.test.ts does).

const signer = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = "oauth-e2e-key";
const supaCodes = new Map<string, string>();
let supabaseUrl = "";
const grace = { id: "u-e2e-grace", email: "grace.e2e@example.com", name: "Grace Hopper" };
function jwt(claims: Record<string, unknown>) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "ES256", kid: KID })}.${enc(claims)}`;
  return `${body}.${sign("sha256", Buffer.from(body), { key: signer.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
const fakeSupabase = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/auth/v1/.well-known/jwks.json") return json(200, { keys: [{ ...signer.publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" }] });
    if (url.pathname === "/auth/v1/authorize") {
      const code = `code-${randomUUID()}`;
      supaCodes.set(code, url.searchParams.get("code_challenge")!);
      return res.writeHead(302, { location: `${url.searchParams.get("redirect_to")}?code=${code}` }).end();
    }
    if (url.pathname === "/auth/v1/settings") return json(200, { external: { github: true, google: false, email: true } });
    if (url.pathname === "/auth/v1/token") {
      const { auth_code, code_verifier } = JSON.parse(raw);
      if (supaCodes.get(auth_code) !== createHash("sha256").update(String(code_verifier)).digest("base64url")) return json(400, { msg: "invalid flow state" });
      return json(200, {
        access_token: jwt({ sub: grace.id, iss: `${supabaseUrl}/auth/v1`, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: grace.email }),
        user: { id: grace.id, email: grace.email, email_confirmed_at: "2026-09-15T00:00:00Z", user_metadata: { full_name: grace.name } },
      });
    }
    json(404, {});
  });
});

let hub: http.Server;
let base: string;
let db: typeof import("../src/db.js").db;
let cimd: typeof import("../src/oauth-cimd.js");
let fx: typeof import("./helpers/oauth-fixtures.js");
let service: typeof import("../src/service.js");

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeSupabase.listen(0, resolve));
  supabaseUrl = `http://127.0.0.1:${(fakeSupabase.address() as AddressInfo).port}`;
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  const { app } = await import("../src/rest.js");
  const { handleMcpRequest } = await import("../src/mcp.js");
  ({ db } = await import("../src/db.js"));
  cimd = await import("../src/oauth-cimd.js");
  fx = await import("./helpers/oauth-fixtures.js");
  service = await import("../src/service.js");
  // The hub as src/index.ts serves it: /mcp through the MCP handler, everything else through the REST app.
  hub = http.createServer((req, res) => {
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
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  // The issuer and the resource are this in-process hub, so every URL a client discovers points back here.
  process.env.OPENCADRE_PUBLIC_HUB_URL = base;
});
afterAll(async () => {
  delete process.env.OPENCADRE_PUBLIC_HUB_URL;
  await new Promise<void>((resolve) => hub.close(() => resolve()));
  await new Promise<void>((resolve) => fakeSupabase.close(() => resolve()));
});
afterEach(() => {
  delete process.env.OPENCADRE_OAUTH;
  cimd.cimdRouteDefaults.resolve = undefined;
  cimd.cimdRouteDefaults.transport = undefined;
  cimd.clearCimdCache();
});

// --- A browser and an HTTP client, as small as the flow needs -----------------------------------------------------------
let ipCounter = 0;
const nextIp = () => `198.21.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;
const abs = (url: string) => new URL(url, base).href;
const get = (url: string, cookie?: string) =>
  fetch(abs(url), { redirect: "manual", headers: { "x-forwarded-for": nextIp(), ...(cookie ? { cookie } : {}) } });
const postForm = (url: string, fields: Record<string, string>, cookie?: string) => fetch(abs(url), {
  method: "POST", redirect: "manual", body: new URLSearchParams(fields).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": nextIp(), ...(cookie ? { cookie } : {}) },
});
const postJson = (url: string, body: unknown) => fetch(abs(url), {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
});
const cookieFrom = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))!.split(";")[0];
/** Where the page an approve or deny returns (onboarding slice 3) sends the browser: the URL its meta refresh carries,
 * which its visible link carries too, decoded from the HTML as a browser would. */
async function returnTo(res: Response): Promise<URL> {
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  const html = await res.text();
  const refresh = html.match(/<meta http-equiv="refresh" content="0;url=([^"]*)">/)![1];
  expect(html).toContain(`href="${refresh}">Return to `);
  return new URL(refresh.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!));
}
const hidden = (html: string) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** One JSON-RPC call on /mcp, stateless (no session), as a bare client would make it. Answers may come as SSE. */
async function mcp(token: string | undefined, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const payload = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? text;
  let body: { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } } = {};
  try { body = JSON.parse(payload); } catch { /* a non-JSON 401 body */ }
  return { res, body };
}
const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const { res, body } = await mcp(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  return body.result?.content?.map((c) => c.text).join("\n") ?? "";
};

/** Signs Grace in through the console's own sign-in, starting from wherever authorize sent her, and returns the session
 * cookie and the URL sign-in returned her to. */
async function signInFrom(signInRedirect: string) {
  const next = new URL(signInRedirect, base).searchParams.get("next")!;
  const start = await get(`/v1/auth/start?provider=github&next=${encodeURIComponent(next)}`);
  const provider = await fetch(start.headers.get("location")!, { redirect: "manual" });
  const callback = await get(provider.headers.get("location")!, cookieFrom(start, "oc_pkce"));
  expect(callback.status).toBe(302);
  return { session: cookieFrom(callback, "oc_session"), returnedTo: callback.headers.get("location")!, next };
}

describe("dormant: with OPENCADRE_OAUTH unset, nothing of the connector is reachable", () => {
  it("every OAuth route is 404 and a /mcp 401 carries no WWW-Authenticate", async () => {
    const unauthenticated = await mcp(undefined, "tools/list");
    expect(unauthenticated.res.status).toBe(401);
    expect(unauthenticated.res.headers.get("www-authenticate")).toBeNull();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/oauth/authorize?client_id=x"]) {
      expect((await get(path)).status, path).toBe(404);
    }
    for (const path of ["/oauth/register", "/oauth/authorize", "/oauth/token", "/oauth/revoke"]) {
      expect((await postForm(path, { grant_type: "authorization_code", token: "oca_x", consent: "x", csrf: "y" })).status, path).toBe(404);
    }
    expect((await postJson("/oauth/register", { redirect_uris: ["https://claude.ai/cb"] })).status).toBe(404);
    // Even a genuine connector token is refused while dormant: /mcp accepts exactly what it did before the connector.
    const { issueTokenFamily, mcpResource } = await import("../src/oauth.js");
    const ownerId = fx.person();
    const orgId = fx.workspace(ownerId);
    const { agentId } = service.registerAgent(orgId, "Dormant-Conn");
    const pair = issueTokenFamily({ clientId: "dcr_dormant", orgId, agentId, personId: ownerId, resource: mcpResource(), grantId: "grant-dormant" });
    const withToken = await mcp(pair.accessToken, "tools/list");
    expect(withToken.res.status).toBe(401);
    expect(withToken.res.headers.get("www-authenticate")).toBeNull();
  });
});

describe("the MCP connector end to end", () => {
  it("a Claude-shaped client (DCR, loopback) and a ChatGPT-shaped client (CIMD) each connect as their own scoped agent", async () => {
    process.env.OPENCADRE_OAUTH = "on";

    // ================= Client A, Claude-shaped =================
    // 1. A bare call on /mcp: 401, and the challenge names the protected-resource metadata (MCP authorization spec).
    const bare = await mcp(undefined, "tools/list");
    expect(bare.res.status).toBe(401);
    const challenge = bare.res.headers.get("www-authenticate")!;
    const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)![1];
    expect(prmUrl).toBe(`${base}/.well-known/oauth-protected-resource/mcp`);
    // 2. The PRM names this /mcp and its one authorization server.
    const prm = (await (await get(prmUrl)).json()) as { resource: string; authorization_servers: string[] };
    expect(prm.resource).toBe(`${base}/mcp`);
    // 3. The AS metadata, from the FIRST authorization server (Claude uses only that one, design §2).
    const as = (await (await get(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown> & {
      issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint: string; revocation_endpoint: string;
    };
    expect(as.issuer).toBe(base);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    // 4. DCR, public, with the loopback redirect Claude Code registers (no port).
    const reg = await postJson(as.registration_endpoint, { client_name: "Claude Code", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" });
    expect(reg.status).toBe(201);
    const clientA = ((await reg.json()) as { client_id: string }).client_id;
    // 5. Authorize on a random loopback port (RFC 8252: the port is ignored when matching), PKCE S256, the resource.
    const a = pkce();
    const redirectA = "http://127.0.0.1:53682/callback";
    const authorizeA = `${as.authorization_endpoint}?${new URLSearchParams({
      response_type: "code", client_id: clientA, redirect_uri: redirectA, code_challenge: a.challenge, code_challenge_method: "S256",
      resource: prm.resource, state: "state-A", scope: "fleet",
    })}`;
    const signedOut = await get(authorizeA);
    expect(signedOut.status).toBe(302);
    // 6. Not signed in: the console's sign-in, and back to this exact authorize URL.
    const { session, returnedTo, next } = await signInFrom(signedOut.headers.get("location")!);
    expect(returnedTo).toBe(next);
    expect(abs(returnedTo)).toBe(authorizeA);
    // Grace owns a workspace that keeps projects apart; A will work in "api", B in "web". One agent sits in each.
    const graceId = db.prepare(`SELECT id FROM people WHERE email = ?`).pluck().get(grace.email) as string;
    const orgId = fx.workspace(graceId, { isolated: true, projects: ["github.com/acme/api", "github.com/acme/web"], name: "Acme Platform" });
    for (const [name, home] of [["Api-Worker", "github.com/acme/api"], ["Web-Worker", "github.com/acme/web"]]) {
      const { agentId } = service.registerAgent(orgId, name);
      db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(home, agentId);
    }
    // 7. The consent page.
    const page = await get(returnedTo, session);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Connect Claude Code");
    expect(html).toContain("<strong>127.0.0.1</strong>");
    const formA = hidden(html);
    // 8. Approve into project "api".
    const approveA = await postForm("/oauth/authorize", { ...formA, decision: "approve", workspace: orgId, project: "github.com/acme/api", name: "Claude-e2e1" }, session);
    // 9. A page on the hub's own origin that sends the browser back to the client's loopback, on the port it asked for,
    // with code, state and iss: a meta refresh, not a 302, so no form-action applies to where the client's callback goes.
    const backA = await returnTo(approveA);
    expect(`${backA.origin}${backA.pathname}`).toBe(redirectA);
    expect(backA.searchParams.get("state")).toBe("state-A");
    expect(backA.searchParams.get("iss")).toBe(as.issuer);
    // 10. The code for tokens, form-encoded, at the TOKEN endpoint the metadata named.
    const tokenA = await postForm(as.token_endpoint, {
      grant_type: "authorization_code", code: backA.searchParams.get("code")!, redirect_uri: redirectA, code_verifier: a.verifier,
      client_id: clientA, resource: prm.resource,
    });
    expect(tokenA.status).toBe(200);
    const pairA = (await tokenA.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(pairA.token_type).toBe("Bearer");
    // 11. /mcp as the connector agent: it lists tools, and the roster it sees is its project's (and its own row).
    const tools = await mcp(pairA.access_token, "tools/list");
    expect(tools.res.status).toBe(200);
    expect(tools.body.result?.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["get_active_agents", "set_status", "send_message"]));
    await callTool(pairA.access_token, "set_status", { task: "e2e as the connector" });
    const connectorA = db.prepare(`SELECT id, name, kind, role, scope, home_project, current_task FROM agents WHERE org_id = ? AND name = 'Claude-e2e1'`).get(orgId);
    expect(connectorA).toMatchObject({ kind: "connector", role: "agent", scope: "project", home_project: "github.com/acme/api", current_task: "e2e as the connector" });
    const rosterA = await callTool(pairA.access_token, "get_active_agents");
    expect(rosterA).toContain("Claude-e2e1");
    expect(rosterA).toContain("Api-Worker");
    expect(rosterA, "another project's agent is out of A's reach").not.toContain("Web-Worker");

    // ================= Client B, ChatGPT-shaped =================
    const clientB = "https://chatgpt.com/oauth/client.json";
    const redirectB = "https://chatgpt.com/connector_platform_oauth_redirect";
    cimd.cimdRouteDefaults.resolve = async () => [{ address: "104.18.32.47", family: 4 }];
    cimd.cimdRouteDefaults.transport = async (target) => {
      expect(target).toMatchObject({ hostname: "chatgpt.com", hostHeader: "chatgpt.com", path: "/oauth/client.json", port: 443, address: "104.18.32.47" });
      const doc = { client_id: clientB, client_name: "ChatGPT", redirect_uris: [redirectB], token_endpoint_auth_method: "none" };
      return { status: 200, headers: { "content-type": "application/json" }, body: (async function* () { yield Buffer.from(JSON.stringify(doc)); })() };
    };
    const b = pkce();
    const pageB = await get(`${as.authorization_endpoint}?${new URLSearchParams({
      response_type: "code", client_id: clientB, redirect_uri: redirectB, code_challenge: b.challenge, code_challenge_method: "S256",
      resource: prm.resource, state: "state-B",
    })}`, session);
    expect(pageB.status).toBe(200);
    const htmlB = await pageB.text();
    expect(htmlB).toContain("Connect ChatGPT");
    expect(htmlB).toContain("<strong>chatgpt.com</strong>");
    const approveB = await postForm("/oauth/authorize", { ...hidden(htmlB), decision: "approve", workspace: orgId, project: "github.com/acme/web", name: "ChatGPT-e2e1" }, session);
    const backB = await returnTo(approveB);
    expect(`${backB.origin}${backB.pathname}`).toBe(redirectB);
    expect(backB.searchParams.get("iss"), "ChatGPT's stable redirect needs iss (RFC 9207)").toBe(as.issuer);
    expect(backB.searchParams.get("state")).toBe("state-B");
    const tokenB = await postJson(as.token_endpoint, {
      grant_type: "authorization_code", code: backB.searchParams.get("code"), redirect_uri: redirectB, code_verifier: b.verifier,
      client_id: clientB, resource: prm.resource,
    });
    expect(tokenB.status).toBe(200);
    const pairB = (await tokenB.json()) as { access_token: string; refresh_token: string };
    // Two connections: separate agents, separate grants, each scoped to its own project.
    const grants = db.prepare(`SELECT client_id, scope_key, agent_id FROM oauth_grants WHERE org_id = ? AND revoked_at IS NULL ORDER BY scope_key`).all(orgId) as
      Array<{ client_id: string; scope_key: string; agent_id: string }>;
    expect(grants.map((g) => [g.client_id, g.scope_key])).toEqual([[clientA, "github.com/acme/api"], [clientB, "github.com/acme/web"]]);
    expect(grants[0].agent_id).not.toBe(grants[1].agent_id);
    const rosterB = await callTool(pairB.access_token, "get_active_agents");
    expect(rosterB).toContain("ChatGPT-e2e1");
    expect(rosterB).toContain("Web-Worker");
    expect(rosterB).not.toContain("Api-Worker");
    expect(rosterB, "A's connector is in another project").not.toContain("Claude-e2e1");
    expect(await callTool(pairA.access_token, "get_active_agents"), "and B's is out of A's reach").not.toContain("ChatGPT-e2e1");

    // ================= A: refresh, refresh reuse, revocation =================
    const refreshed = await postForm(as.token_endpoint, { grant_type: "refresh_token", refresh_token: pairA.refresh_token, client_id: clientA, resource: prm.resource });
    expect(refreshed.status).toBe(200);
    const pairA2 = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(pairA2.refresh_token).not.toBe(pairA.refresh_token);
    expect((await mcp(pairA2.access_token, "tools/list")).res.status).toBe(200);
    // The spent refresh token again: it leaked, so the whole family goes, the new access token included.
    const reuse = await postForm(as.token_endpoint, { grant_type: "refresh_token", refresh_token: pairA.refresh_token, client_id: clientA });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_grant");
    const afterReuse = await mcp(pairA2.access_token, "tools/list");
    expect(afterReuse.res.status).toBe(401);
    expect(afterReuse.res.headers.get("www-authenticate")).toBe(challenge);
    // A reconnects: the same connector agent, a fresh family.
    const again = pkce();
    const pageA2 = await get(`${as.authorization_endpoint}?${new URLSearchParams({
      response_type: "code", client_id: clientA, redirect_uri: "http://127.0.0.1:61000/callback", code_challenge: again.challenge,
      code_challenge_method: "S256", resource: prm.resource, state: "state-A2",
    })}`, session);
    const approveA2 = await postForm("/oauth/authorize", { ...hidden(await pageA2.text()), decision: "approve", workspace: orgId, project: "github.com/acme/api", name: "Unused" }, session);
    const backA2 = await returnTo(approveA2);
    const pairA3 = (await (await postForm(as.token_endpoint, {
      grant_type: "authorization_code", code: backA2.searchParams.get("code")!, redirect_uri: "http://127.0.0.1:61000/callback",
      code_verifier: again.verifier, client_id: clientA, resource: prm.resource,
    })).json()) as { access_token: string; refresh_token: string };
    expect(db.prepare(`SELECT COUNT(*) FROM agents WHERE org_id = ? AND kind = 'connector'`).pluck().get(orgId), "re-approval reused A's agent").toBe(2);
    expect((await mcp(pairA3.access_token, "tools/list")).res.status).toBe(200);
    // RFC 7009 revocation of that fresh family: the next /mcp call is a 401 that names the metadata again.
    expect((await postForm(as.revocation_endpoint, { token: pairA3.access_token, client_id: clientA })).status).toBe(200);
    const afterRevoke = await mcp(pairA3.access_token, "tools/list");
    expect(afterRevoke.res.status).toBe(401);
    expect(afterRevoke.res.headers.get("www-authenticate")).toBe(challenge);
    // B was never touched by any of A's revocations.
    expect((await mcp(pairB.access_token, "tools/list")).res.status).toBe(200);
  });
});
