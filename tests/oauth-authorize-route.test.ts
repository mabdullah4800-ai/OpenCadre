import type { AddressInfo } from "node:net";
import http from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// GET and POST /oauth/authorize and the consent page (docs/design/MCP-CONNECTOR.md §3/§4; plan 2026-09-29 §3 and the
// binding §7 amendments). Signing in runs for real against a stand-in Supabase Auth, as in tests/accounts.test.ts, so
// "signed out -> sign in -> back to the same authorize URL" is the hub's own code end to end.

const signer = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = "oauth-route-key";
const supaCodes = new Map<string, { challenge: string }>();
let supabaseUrl = "";
const signInUser = { id: "u-grace", email: "grace@example.com", name: "Grace Hopper" };
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
      supaCodes.set(code, { challenge: url.searchParams.get("code_challenge")! });
      return res.writeHead(302, { location: `${url.searchParams.get("redirect_to")}?code=${code}` }).end();
    }
    if (url.pathname === "/auth/v1/settings") return json(200, { external: { github: true, google: false, email: true } });
    if (url.pathname === "/auth/v1/token") {
      const { auth_code, code_verifier } = JSON.parse(raw);
      const entry = supaCodes.get(auth_code);
      if (!entry || entry.challenge !== createHash("sha256").update(String(code_verifier)).digest("base64url")) return json(400, { msg: "invalid flow state" });
      return json(200, {
        access_token: jwt({ sub: signInUser.id, iss: `${supabaseUrl}/auth/v1`, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: signInUser.email }),
        user: { id: signInUser.id, email: signInUser.email, email_confirmed_at: "2026-09-15T00:00:00Z", user_metadata: { full_name: signInUser.name } },
      });
    }
    json(404, {});
  });
});

let hub: http.Server;
let base: string;
let db: typeof import("../src/db.js").db;
let accounts: typeof import("../src/accounts.js");
let oauth: typeof import("../src/oauth.js");
let authorize: typeof import("../src/oauth-authorize.js");
let cimd: typeof import("../src/oauth-cimd.js");
let fx: typeof import("./helpers/oauth-fixtures.js");

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeSupabase.listen(0, resolve));
  supabaseUrl = `http://127.0.0.1:${(fakeSupabase.address() as AddressInfo).port}`;
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  const { app } = await import("../src/rest.js");
  const { withRequestLog } = await import("../src/http-log.js");
  ({ db } = await import("../src/db.js"));
  accounts = await import("../src/accounts.js");
  oauth = await import("../src/oauth.js");
  authorize = await import("../src/oauth-authorize.js");
  cimd = await import("../src/oauth-cimd.js");
  fx = await import("./helpers/oauth-fixtures.js");
  // Wrapped in the hub's request log, as src/index.ts does, so the log test below reads what production would write.
  hub = http.createServer(withRequestLog(app));
  await new Promise<void>((resolve) => hub.listen(0, resolve));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => hub.close(() => resolve()));
  await new Promise<void>((resolve) => fakeSupabase.close(() => resolve()));
});
beforeEach(() => { process.env.OPENCADRE_OAUTH = "on"; });
afterEach(() => {
  delete process.env.OPENCADRE_OAUTH;
  delete process.env.OPENCADRE_PUBLIC_APP_URL;
  cimd.cimdRouteDefaults.resolve = undefined;
  cimd.cimdRouteDefaults.transport = undefined;
  cimd.clearCimdCache();
});

// --- Harness --------------------------------------------------------------------------------------------------------
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
let ipCounter = 0;
const nextIp = () => `198.18.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;

function authorizeQuery(clientId: string, over: Record<string, string | undefined> = {}) {
  const params: Record<string, string | undefined> = {
    response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: CHALLENGE, code_challenge_method: "S256",
    resource: oauth.mcpResource(), state: "st-123", scope: "fleet", ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.append(k, v);
  return `/oauth/authorize?${q}`;
}
const get = (path: string, { cookie, ip = nextIp() }: { cookie?: string; ip?: string } = {}) =>
  fetch(`${base}${path}`, { redirect: "manual", headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) } });
const post = (fields: Record<string, string>, { cookie, ip = nextIp() }: { cookie?: string; ip?: string } = {}) =>
  fetch(`${base}/oauth/authorize`, {
    method: "POST", redirect: "manual", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
  });
function signedIn(personId: string): { cookie: string; token: string } {
  const { token } = accounts.createSession(personId);
  return { cookie: `${accounts.SESSION_COOKIE}=${encodeURIComponent(token)}`, token };
}
const hidden = (html: string) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
async function openConsent(personId: string, clientId: string, session = signedIn(personId), over: Record<string, string | undefined> = {}) {
  const res = await get(authorizeQuery(clientId, over), { cookie: session.cookie });
  expect(res.status).toBe(200);
  const html = await res.text();
  return { html, session, res, ...(hidden(html) as { consent: string; csrf: string }) };
}
const locationOf = (res: Response) => new URL(res.headers.get("location")!);
const params = (url: URL) => Object.fromEntries(url.searchParams.entries());
const unescapeHtml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);
/** The page an answer returns (onboarding slice 3): a 200 from the hub's own origin, never a 302, whose meta refresh and
 * visible link carry the same URL back to the client. Returns that URL, decoded from the HTML. */
async function returnOf(res: Response): Promise<{ url: URL; href: string; html: string }> {
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  const html = await res.text();
  const refresh = html.match(/<meta http-equiv="refresh" content="0;url=([^"]*)">/)?.[1];
  const link = html.match(/<a class="btn btn-ink" href="([^"]*)">Return to [^<]*<\/a>/)?.[1];
  expect(refresh, "a meta refresh").toBeTruthy();
  expect(link, "the same URL as a link").toBe(refresh);
  const href = unescapeHtml(refresh!);
  return { url: new URL(href), href, html };
}
const formActionOf = (res: Response) =>
  res.headers.get("content-security-policy")!.split(";").map((d) => d.trim()).find((d) => d.startsWith("form-action "));

/** An active grant between the person and the client, and a session for that person. */
function connectedTo(personId: string, orgId: string, clientId: string) {
  const consentId = authorize.createConsent({ personId, clientId, redirectUri: CALLBACK, resource: oauth.mcpResource(), codeChallenge: CHALLENGE, state: "s" });
  const approved = authorize.approveConsent({ consentId, personId, orgId, connectionName: `Prior-${randomUUID().slice(0, 6)}` });
  if (!approved.ok) throw new Error(approved.message);
  return signedIn(personId);
}

function setup(opts: Parameters<typeof import("./helpers/oauth-fixtures.js").workspace>[1] = {}) {
  const personId = fx.person("Grace");
  const orgId = fx.workspace(personId, opts);
  const clientId = fx.dcrClient("Claude");
  return { personId, orgId, clientId };
}

// --- GET: validation -------------------------------------------------------------------------------------------------
// The strict console policy the OAuth pages keep, written out in full: no third-party script, style, image, connection
// or frame origin, and no inline-style exception.
const STRICT_CONSOLE_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
];
function expectStrictConsoleCsp(csp: string) {
  const directives = csp.split(";").map((d) => d.trim());
  for (const d of STRICT_CONSOLE_DIRECTIVES) expect(directives, d).toContain(d);
  expect(directives.find((d) => d.startsWith("form-action "))).toMatch(/^form-action 'self'/);
  for (const word of ["unsafe-inline", "unsafe-eval", "unsafe-hashes"]) expect(csp).not.toContain(word);
}

describe("GET /oauth/authorize: validation", () => {
  it("an error page keeps the strict console CSP, with no inline-style exception", async () => {
    setup();
    const res = await get(authorizeQuery("dcr_ffffffffffffffffffffffffffffffff"));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Couldn't connect");
    expectStrictConsoleCsp(res.headers.get("content-security-policy") ?? "");
  });

  it("is 404 while dormant, and so is POST", async () => {
    delete process.env.OPENCADRE_OAUTH;
    const { clientId } = setup();
    expect((await get(authorizeQuery(clientId))).status).toBe(404);
    expect((await post({ consent: "x", csrf: "y", decision: "approve" })).status).toBe(404);
  });

  it.each([
    ["no client_id", (c: string) => authorizeQuery(c, { client_id: undefined })],
    ["an unknown client", () => authorizeQuery("dcr_ffffffffffffffffffffffffffffffff")],
    ["no redirect_uri", (c: string) => authorizeQuery(c, { redirect_uri: undefined })],
    ["an unregistered redirect", (c: string) => authorizeQuery(c, { redirect_uri: "https://evil.example/cb" })],
    ["a look-alike redirect", (c: string) => authorizeQuery(c, { redirect_uri: "https://claude.ai/api/mcp/auth_callback/" })],
    ["a redirect given twice", (c: string) => `${authorizeQuery(c)}&redirect_uri=${encodeURIComponent(CALLBACK)}`],
  ])("with %s: an error PAGE, never a redirect", async (_label, build) => {
    const { clientId } = setup();
    const res = await get(build(clientId));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("Couldn't connect");
  });

  it.each([
    ["response_type token", { response_type: "token" }, "unsupported_response_type"],
    ["no code_challenge", { code_challenge: undefined }, "invalid_request"],
    ["a malformed code_challenge", { code_challenge: "short" }, "invalid_request"],
    ["the plain PKCE method", { code_challenge_method: "plain" }, "invalid_request"],
    ["no PKCE method", { code_challenge_method: undefined }, "invalid_request"],
    ["another resource", { resource: "https://elsewhere.example/mcp" }, "invalid_target"],
    ["no resource", { resource: undefined }, "invalid_target"],
  ])("with %s: redirected back (error, state, iss) only for a person already connected to that client", async (_label, over, error) => {
    const { personId, orgId, clientId } = setup();
    // Signed out, or signed in with no connection to this client: an error page with a link to click, never a 302.
    for (const cookie of [undefined, signedIn(personId).cookie]) {
      const page = await get(authorizeQuery(clientId, over), { cookie });
      expect(page.status).toBe(400);
      expect(page.headers.get("location")).toBeNull();
      const html = await page.text();
      const link = html.match(/<a class="btn btn-quiet" href="([^"]+)">Return to claude\.ai<\/a>/);
      expect(link, "a plain link back that the person must click").not.toBeNull();
      const back = new URL(link![1].replaceAll("&amp;", "&"));
      expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
      expect(params(back)).toMatchObject({ error, state: "st-123", iss: oauth.oauthIssuer() });
    }
    // A person who already approved this client gets the redirect itself (RFC 6749 §4.1.2.1), uncached.
    const session = connectedTo(personId, orgId, clientId);
    const res = await get(authorizeQuery(clientId, over), { cookie: session.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const loc = locationOf(res);
    expect(`${loc.origin}${loc.pathname}`).toBe(CALLBACK);
    expect(params(loc)).toMatchObject({ error, state: "st-123", iss: oauth.oauthIssuer() });
  });

  it("with no state: the error carries iss and no state", async () => {
    const { personId, orgId, clientId } = setup();
    const session = connectedTo(personId, orgId, clientId);
    const res = await get(authorizeQuery(clientId, { state: undefined }), { cookie: session.cookie });
    const p = params(locationOf(res));
    expect(p).toMatchObject({ error: "invalid_request", iss: oauth.oauthIssuer() });
    expect(p).not.toHaveProperty("state");
  });

  // Security review S1 (reproduced): registration is open, so anyone can register a redirect of their choosing. Before
  // the fix, a bogus response_type made the hub 302 a victim straight to it, with no session and no click.
  it("is no open redirect: a self-registered client's bogus request gets a page, not a 302 to its redirect", async () => {
    const reg = await fetch(`${base}/oauth/register`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
      body: JSON.stringify({ client_name: "Bank", redirect_uris: ["https://phish.example/login"] }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "bogus", client_id, redirect_uri: "https://phish.example/login", state: "x" });
    for (const cookie of [undefined, signedIn(fx.person()).cookie]) {
      const res = await get(`/oauth/authorize?${q}`, { cookie });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("Return to phish.example");
    }
  });

  it("a CIMD client is read through the guarded fetcher; a failed fetch is an error page with the generic message", async () => {
    const personId = fx.person();
    fx.workspace(personId);
    const clientId = "https://chatgpt.com/oauth/client.json";
    const doc = { client_id: clientId, client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] };
    cimd.cimdRouteDefaults.resolve = async () => [{ address: "104.18.32.47", family: 4 }];
    cimd.cimdRouteDefaults.transport = async () => ({ status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(doc)); })() });
    const ok = await openConsent(personId, clientId, signedIn(personId), { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" });
    expect(ok.html).toContain("Connect ChatGPT");
    expect(ok.html).toContain("<strong>chatgpt.com</strong>");
    cimd.clearCimdCache();
    cimd.cimdRouteDefaults.resolve = async () => [{ address: "169.254.169.254", family: 4 }];
    const refused = await get(authorizeQuery(clientId, { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }), { cookie: signedIn(personId).cookie });
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(text).toContain(cimd.CIMD_FETCH_ERROR);
    expect(text).not.toContain("169.254");
  });
});

// --- GET: sign-in and the page ---------------------------------------------------------------------------------------
describe("GET /oauth/authorize: sign-in and the consent page", () => {
  it("signed out: to the console's sign-in, and after signing in, back to this exact authorize URL", async () => {
    const { clientId } = setup();
    const path = authorizeQuery(clientId, { state: "keep me/é&=" });
    const first = await get(path);
    expect(first.status).toBe(302);
    const toSignIn = new URL(first.headers.get("location")!, base);
    expect(toSignIn.pathname).toBe("/app/");
    const next = toSignIn.searchParams.get("next")!;
    expect(next).toBe(path);
    // The console's GitHub button: /v1/auth/start with that next, through the provider and back to the callback.
    const start = await get(`/v1/auth/start?provider=github&next=${encodeURIComponent(next)}`);
    const pkce = start.headers.getSetCookie().find((c) => c.startsWith("oc_pkce="))!.split(";")[0];
    const provider = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const callback = await get(new URL(provider.headers.get("location")!).pathname + new URL(provider.headers.get("location")!).search, { cookie: pkce });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location"), "the exact authorize URL, query and all").toBe(path);
    const session = callback.headers.getSetCookie().find((c) => c.startsWith(`${accounts.SESSION_COOKIE}=`))!.split(";")[0];
    // Grace can add agents in a workspace of her own, so the page shows.
    const grace = db.prepare(`SELECT id FROM people WHERE email = ?`).get(signInUser.email) as { id: string };
    fx.workspace(grace.id);
    const back = await get(path, { cookie: session });
    expect(back.status).toBe(200);
    expect(await back.text()).toContain("Connect Claude");
  });

  it("sign-in's next admits the consent page but still refuses anything else", async () => {
    for (const [next, expected] of [
      ["/oauth/authorize?x=1", "/oauth/authorize?x=1"],
      ["/oauth/authorizeX?x=1", "/app/"],
      ["/oauth/token?x=1", "/app/"],
      ["//evil.example/oauth/authorize?x", "/app/"],
      ["/oauth/authorize?\\evil", "/app/"],
      ["https://evil.example/oauth/authorize?x", "/app/"],
    ]) {
      const start = await get(`/v1/auth/start?provider=github&next=${encodeURIComponent(next)}`);
      const pkce = start.headers.getSetCookie().find((c) => c.startsWith("oc_pkce="))!;
      const encodedNext = decodeURIComponent(pkce.split(";")[0].split("=")[1]).split(".")[1];
      expect(Buffer.from(encodedNext, "base64url").toString("utf8"), next).toBe(expected);
    }
  });

  it("on the wrong host, sends the browser to the console's origin, where the session cookie is", async () => {
    process.env.OPENCADRE_PUBLIC_APP_URL = "https://app.opencadre.test";
    const { clientId } = setup();
    const path = authorizeQuery(clientId);
    const res = await get(path);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://app.opencadre.test${path}`);
    process.env.OPENCADRE_OAUTH = "on";
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as { issuer: string; authorization_endpoint: string };
    expect(meta.authorization_endpoint).toBe("https://app.opencadre.test/oauth/authorize");
    expect(meta.issuer, "the issuer stays the hub").toBe(oauth.oauthIssuer());
  });

  it("the page: console CSP with frame-ancestors 'none', the client name escaped, the redirect HOST, and only consent + csrf hidden", async () => {
    const personId = fx.person();
    fx.workspace(personId);
    const clientId = fx.dcrClient(`<img src=x onerror="alert(1)">Claude & "Co"`, [CALLBACK]);
    const { html, res, consent, csrf } = await openConsent(personId, clientId);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(formActionOf(res), "the form posts here; the answer is a page, not a redirect a form submission follows").toBe("form-action 'self'");
    expect(csp.split(/[s;]+/), "no bare https: source anywhere in the policy").not.toContain("https:");
    expect(csp).not.toContain("claude.ai");
    // The consent page opens no checkout, so it keeps the strict console policy: the console's inline-style exception
    // for a payment overlay must not reach it.
    expectStrictConsoleCsp(csp);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Claude &amp; &quot;Co&quot;");
    expect(html).toContain("<strong>claude.ai</strong>");
    expect(Object.keys(hidden(html)).sort()).toEqual(["consent", "csrf"]);
    expect(consent).toBeTruthy();
    expect(csrf).toBeTruthy();
    // The console's stylesheets, from its own page, versioned and in order: since the design tokens (#648) the
    // console's colours are var(--n-*) references into /shared/tokens.css, so a page missing one renders unresolved.
    const stylesheets = (page: string) => [...page.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    const consoleIndex = (await import("../src/rest.js")).versionedConsoleIndex();
    expect(stylesheets(consoleIndex)).toContain(stylesheets(consoleIndex).find((h) => h.startsWith("/shared/tokens.css?v=")));
    expect(stylesheets(html)).toEqual(stylesheets(consoleIndex));
    expect(html, "no inline script under the console CSP").not.toMatch(/<script/i);
    expect(html, "no inline style under the console CSP").not.toMatch(/\sstyle=|<style/i);
    expect(html).not.toContain("—");
    expect(html).toContain('<use href="#oc-lockup"/>');
    expect(html).toContain('id="oc-lockup"');
    for (const value of [CHALLENGE, "st-123", CALLBACK]) expect(html, "the request never travels through the page").not.toContain(value);
  });

  it("lists only workspaces where the person's live role may add agents", async () => {
    const personId = fx.person();
    fx.workspace(personId, { role: "owner", name: "Owned Space" });
    fx.workspace(personId, { role: "admin", name: "Admin Space" });
    fx.workspace(personId, { role: "member", name: "Member Space" });
    const { html } = await openConsent(personId, fx.dcrClient("Claude"));
    expect(html).toContain("Owned Space");
    expect(html).toContain("Admin Space");
    expect(html).not.toContain("Member Space");
  });

  it("a workspace that keeps projects apart gets a project picker; one that does not gets the every-agent sentence", async () => {
    const isolatedPerson = fx.person();
    fx.workspace(isolatedPerson, { isolated: true, projects: ["github.com/acme/api"], name: "Apart" });
    const apart = (await openConsent(isolatedPerson, fx.dcrClient())).html;
    expect(apart).toContain('name="project" value="github.com/acme/api"');
    expect(apart).not.toContain("every agent");
    const openPerson = fx.person();
    fx.workspace(openPerson, { isolated: false, name: "Together" });
    const together = (await openConsent(openPerson, fx.dcrClient())).html;
    expect(together).not.toContain('name="project"');
    expect(together).toContain("Can message every agent in Together.");
  });

  it("no workspace where the person may add agents: says so, offers Deny and Open OpenCadre", async () => {
    const personId = fx.person();
    fx.workspace(personId, { role: "member" });
    const { html } = await openConsent(personId, fx.dcrClient());
    expect(html).toContain("You need to be an owner or admin of a workspace.");
    expect(html).not.toContain('value="approve"');
    expect(html).toContain('value="deny"');
    expect(html).toContain('<a class="btn btn-quiet" href="/app/">Open OpenCadre</a>');
  });
});

// --- POST ------------------------------------------------------------------------------------------------------------
describe("POST /oauth/authorize", () => {
  it("approve: a page that returns to the stored redirect with code, state and iss, and the code is stored hashed with its grant", async () => {
    const { personId, orgId, clientId } = setup();
    const { session, consent, csrf } = await openConsent(personId, clientId, undefined, { state: "a b&c=d/é" });
    const res = await post({ consent, csrf, decision: "approve", workspace: orgId, name: "Claude-1a2b" }, { cookie: session.cookie });
    const { url: loc, html } = await returnOf(res);
    expect(html).toContain("Connected as <strong>Claude-1a2b</strong> to <strong>");
    expect(html).toContain("Returning to <strong>claude.ai</strong>…");
    expect(html).toContain(">Return to claude.ai</a>");
    expect(html, "no script under the console CSP").not.toMatch(/<script/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(formActionOf(res)).toBe("form-action 'self'");
    expectStrictConsoleCsp(res.headers.get("content-security-policy")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CALLBACK);
    const p = params(loc);
    expect(Object.keys(p).sort()).toEqual(["code", "iss", "state"]);
    expect(p.state, "state round-trips exactly").toBe("a b&c=d/é");
    expect(p.iss).toBe(oauth.oauthIssuer());
    const row = db.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`).get(createHash("sha256").update(p.code).digest("hex")) as Record<string, string>;
    expect(row).toMatchObject({ client_id: clientId, redirect_uri: CALLBACK, code_challenge: CHALLENGE, person_id: personId, org_id: orgId });
    expect(row.grant_id).toBeTruthy();
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector' AND name = 'Claude-1a2b'`, orgId)).toBe(1);
  });

  it("a redirect that already has a query keeps it untouched; https and loopback redirects both come back exactly, the port kept", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId);
    const clientId = fx.dcrClient("Local", ["https://app.example/cb?tenant=a%20b", "http://127.0.0.1/callback"]);
    const q = await openConsent(personId, clientId, undefined, { redirect_uri: "https://app.example/cb?tenant=a%20b" });
    const withQuery = await returnOf(await post({ consent: q.consent, csrf: q.csrf, decision: "approve", workspace: orgId, name: "Local-1" }, { cookie: q.session.cookie }));
    expect(withQuery.href).toMatch(/^https:\/\/app\.example\/cb\?tenant=a%20b&code=[^&]+&state=st-123&iss=/);
    expect(withQuery.html).toContain("Returning to <strong>app.example</strong>…");
    const loop = await openConsent(personId, clientId, undefined, { redirect_uri: "http://127.0.0.1:53682/callback" });
    expect(formActionOf(loop.res), "the consent page names no redirect origin").toBe("form-action 'self'");
    const back = await returnOf(await post({ consent: loop.consent, csrf: loop.csrf, decision: "approve", workspace: orgId, name: "Local-2" }, { cookie: loop.session.cookie }));
    expect(`${back.url.origin}${back.url.pathname}`).toBe("http://127.0.0.1:53682/callback");
    expect(Object.keys(params(back.url)).sort()).toEqual(["code", "iss", "state"]);
    expect(back.html).toContain("Returning to <strong>127.0.0.1</strong>…");
    expect(back.html).toMatch(/<meta http-equiv="refresh" content="0;url=http:\/\/127\.0\.0\.1:53682\/callback\?code=/);
  });

  it("form-action is 'self' alone on every OAuth page, a client whose callback bounces on (Cursor) included", async () => {
    const personId = fx.person();
    const clientId = fx.dcrClient("Cursor", ["https://www.cursor.com/agents/mcp/oauth/callback"]);
    const c = await openConsent(personId, clientId, undefined, { redirect_uri: "https://www.cursor.com/agents/mcp/oauth/callback" });
    expect(formActionOf(c.res)).toBe("form-action 'self'");
    const csp = c.res.headers.get("content-security-policy")!;
    expect(csp.split(/[s;]+/), "no bare https: source").not.toContain("https:");
    for (const word of ["cursor.com", "localhost", "127.0.0.1"]) expect(csp).not.toContain(word);
    const bad = await get("/oauth/authorize?response_type=code&client_id=dcr_00000000000000000000000000000000");
    expect(formActionOf(bad)).toBe("form-action 'self'");
  });

  it("every value on the return page is escaped: a state carrying \"><script>, a quote in the redirect path, the names", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId, { name: "R&D <Team>" });
    const redirect = "https://app.example/cb'x";
    const clientId = fx.dcrClient("Escapes", [redirect]);
    const state = `"><script>alert(1)</script>'&x=y`;
    const c = await openConsent(personId, clientId, undefined, { redirect_uri: redirect, state });
    const res = await post({ consent: c.consent, csrf: c.csrf, decision: "approve", workspace: orgId, name: "Grok <Bot>" }, { cookie: c.session.cookie });
    const { url, href, html } = await returnOf(res);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<Bot>");
    expect(html).not.toContain("<Team>");
    expect(html).toContain("Connected as <strong>Grok &lt;Bot&gt;</strong> to <strong>R&amp;D &lt;Team&gt;</strong>.");
    expect(html.match(/https:\/\/app\.example\/cb&#39;x\?code=/g), "the quote in the path is escaped in both attributes").toHaveLength(2);
    expect(html).not.toContain("cb'x");
    expect(`${url.origin}${url.pathname}`).toBe(redirect);
    expect(href.startsWith(`${redirect}?code=`)).toBe(true);
    expect(params(url).state, "the state round-trips exactly").toBe(state);
  });

  it("the return page says Connected even when the names cannot be read, and never Not connected after an approve", async () => {
    const { renderReturnPage } = await import("../src/oauth-consent-page.js");
    const html = renderReturnPage({ styleLinks: "", sprite: "" }, { href: "http://127.0.0.1:5000/cb?code=c&state=s", host: "127.0.0.1", connected: true, names: null });
    expect(html).toContain("<h1 class=\"signin-title\">Connected.</h1>");
    expect(html).not.toContain("Not connected");
    expect(html).toContain("<meta http-equiv=\"refresh\" content=\"0;url=http://127.0.0.1:5000/cb?code=c&amp;state=s\">");
    expect(html).toContain("<a class=\"btn btn-ink\" href=\"http://127.0.0.1:5000/cb?code=c&amp;state=s\">Return to 127.0.0.1</a>");
  });

  it("a state that reads like a second refresh target (;url=https://evil, x) round-trips, and the refresh stays on the redirect", async () => {
    const { personId, orgId, clientId } = setup();
    const state = ";url=https://evil, x";
    const c = await openConsent(personId, clientId, undefined, { state });
    const { url, html } = await returnOf(await post({ consent: c.consent, csrf: c.csrf, decision: "approve", workspace: orgId, name: "Semi-1" }, { cookie: c.session.cookie }));
    expect(url.origin).toBe(new URL(CALLBACK).origin);
    expect(`${url.origin}${url.pathname}`).toBe(CALLBACK);
    expect(params(url).state).toBe(state);
    const content = html.match(/<meta http-equiv="refresh" content="([^"]*)">/)![1];
    expect(content.match(/url=/gi), "one url= only: the state's is percent-encoded").toHaveLength(1);
    expect(content).not.toMatch(/[;,]\s*url=https:\/\/evil/i);
    expect(html).not.toContain("https://evil");
  });

  it("the consent is spent before the page is drawn, so a failure drawing it still returns the person with the code", async () => {
    const rest = await import("../src/rest.js");
    const hooks = rest.oauthReturnHooks;
    const { names, chrome } = hooks;
    try {
      // The names can't be read: the page says Connected., and still carries the code.
      hooks.names = () => { throw new Error("names unavailable"); };
      const a = setup();
      const ca = await openConsent(a.personId, a.clientId);
      const first = await returnOf(await post({ consent: ca.consent, csrf: ca.csrf, decision: "approve", workspace: a.orgId, name: "Spent-1" }, { cookie: ca.session.cookie }));
      expect(first.html).toContain('<h1 class="signin-title">Connected.</h1>');
      expect(`${first.url.origin}${first.url.pathname}`).toBe(CALLBACK);
      expect(params(first.url)).toMatchObject({ state: "st-123", iss: oauth.oauthIssuer() });
      const stored = db.prepare(`SELECT 1 FROM oauth_codes WHERE code_hash = ?`).get(createHash("sha256").update(params(first.url).code).digest("hex"));
      expect(stored, "the code on the page is the stored one").toBeTruthy();
      // The console's chrome can't be built either: the page without it, the same URL.
      hooks.chrome = () => { throw new Error("chrome unavailable"); };
      const b = setup();
      const cb = await openConsent(b.personId, b.clientId);
      const second = await returnOf(await post({ consent: cb.consent, csrf: cb.csrf, decision: "approve", workspace: b.orgId, name: "Spent-2" }, { cookie: cb.session.cookie }));
      expect(second.html).not.toContain('id="oc-lockup"');
      expect(params(second.url).code).toBeTruthy();
      expect(params(second.url).state).toBe("st-123");
    } finally {
      hooks.names = names;
      hooks.chrome = chrome;
    }
  });

  it("returnToClient refuses a redirect acceptableRedirectUri would not admit: an error page, no refresh, no link", async () => {
    const { returnToClient } = await import("../src/rest.js");
    const { returnHref } = authorize;
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(document.cookie)//", "data:text/html,<script>alert(1)</script>", "cursor://anysphere/cb", "http://evil.example/cb"]) {
      expect(returnHref(bad, { code: "c", state: "s" }), bad).toBeNull();
      const sent: { status?: number; html?: string; headers: Record<string, string>; location?: string } = { headers: {} };
      const res = {
        setHeader(k: string, v: string) { sent.headers[k.toLowerCase()] = v; return res; },
        status(n: number) { sent.status = n; return res; },
        type() { return res; },
        send(html: string) { sent.html = html; return res; },
        redirect(_s: number, to: string) { sent.location = to; return res; },
      };
      returnToClient(res as unknown as Parameters<typeof returnToClient>[0], bad, { code: "c", state: "s" }, true);
      expect(sent.status, bad).toBe(400);
      expect(sent.location, bad).toBeUndefined();
      expect(sent.html).toContain("This app&#39;s return address isn&#39;t valid. Start again from the app.");
      expect(sent.html).not.toContain('http-equiv="refresh"');
      expect(sent.html).not.toMatch(/javascript:|data:text|cursor:\/\/|evil\.example/i);
    }
    expect(returnHref(CALLBACK, { code: "c", state: "s" })).toBe(`${CALLBACK}?code=c&state=s`);
  });

  it("deny: a page that returns access_denied, the state and iss; nothing is created", async () => {
    const { personId, orgId, clientId } = setup();
    const { session, consent, csrf } = await openConsent(personId, clientId);
    const res = await post({ consent, csrf, decision: "deny" }, { cookie: session.cookie });
    const { url, html } = await returnOf(res);
    expect(html).toContain("Not connected");
    expect(html).toContain("Returning to <strong>claude.ai</strong>…");
    expect(html).not.toContain("Connected as");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(`${url.origin}${url.pathname}`).toBe(CALLBACK);
    expect(params(url)).toMatchObject({ error: "access_denied", state: "st-123", iss: oauth.oauthIssuer() });
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, orgId)).toBe(0);
    expect(fx.count(`oauth_codes WHERE person_id = ?`, personId)).toBe(0);
  });

  it("two tabs: swapping their consent ids, each with its own otherwise-valid CSRF, is refused both ways", async () => {
    const { personId, orgId, clientId } = setup();
    const session = signedIn(personId);
    const tabA = await openConsent(personId, clientId, session, { state: "tab-a" });
    const tabB = await openConsent(personId, clientId, session, { state: "tab-b", redirect_uri: CALLBACK });
    const aWithB = await post({ consent: tabB.consent, csrf: tabA.csrf, decision: "approve", workspace: orgId, name: "Mix-1" }, { cookie: session.cookie });
    const bWithA = await post({ consent: tabA.consent, csrf: tabB.csrf, decision: "approve", workspace: orgId, name: "Mix-2" }, { cookie: session.cookie });
    expect([aWithB.status, bWithA.status]).toEqual([403, 403]);
    expect(fx.count(`oauth_codes WHERE person_id = ?`, personId)).toBe(0);
    // And each tab still works for its own request, landing on its own state.
    const a = await post({ consent: tabA.consent, csrf: tabA.csrf, decision: "approve", workspace: orgId, name: "Mix-3" }, { cookie: session.cookie });
    expect(params((await returnOf(a)).url).state).toBe("tab-a");
  });

  it("another session's CSRF is refused, even for the same person", async () => {
    const { personId, orgId, clientId } = setup();
    const tab = await openConsent(personId, clientId);
    const other = signedIn(personId);
    const res = await post({ consent: tab.consent, csrf: tab.csrf, decision: "approve", workspace: orgId, name: "Other-1" }, { cookie: other.cookie });
    expect(res.status).toBe(403);
    const noSession = await post({ consent: tab.consent, csrf: tab.csrf, decision: "approve", workspace: orgId, name: "Other-2" });
    expect(noSession.status).toBe(401);
    expect(await noSession.text()).toContain('role="alert">You&#39;re signed out.</p>');
  });

  it("tampered hidden fields change nothing: client, redirect, challenge, resource and state come from the stored consent", async () => {
    const { personId, orgId, clientId } = setup();
    const { session, consent, csrf } = await openConsent(personId, clientId);
    const other = fx.dcrClient("Evil", ["https://evil.example/cb"]);
    const res = await post({
      consent, csrf, decision: "approve", workspace: orgId, name: "Tamper-1",
      client_id: other, redirect_uri: "https://evil.example/cb", code_challenge: "A".repeat(43), resource: "https://evil.example/mcp", state: "evil",
    }, { cookie: session.cookie });
    const { url: loc } = await returnOf(res);
    expect(`${loc.origin}${loc.pathname}`).toBe(CALLBACK);
    expect(params(loc).state).toBe("st-123");
    const row = db.prepare(`SELECT client_id, redirect_uri, code_challenge, resource FROM oauth_codes WHERE person_id = ?`).get(personId);
    expect(row).toEqual({ client_id: clientId, redirect_uri: CALLBACK, code_challenge: CHALLENGE, resource: oauth.mcpResource() });
  });

  it("a duplicate POST fails and makes no second code", async () => {
    const { personId, orgId, clientId } = setup();
    const { session, consent, csrf } = await openConsent(personId, clientId);
    const fields = { consent, csrf, decision: "approve", workspace: orgId, name: "Dup-1" };
    expect((await post(fields, { cookie: session.cookie })).status).toBe(200);
    const again = await post(fields, { cookie: session.cookie });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("Already connected as <strong>Dup-1</strong> in <strong>");
    expect(await (await post({ ...fields, consent: "unknown" }, { cookie: session.cookie })).text()).not.toContain("Start again from the app you were connecting");
    expect((await post({ ...fields, decision: "deny" }, { cookie: session.cookie })).status).toBe(409);
    expect(fx.count(`oauth_codes WHERE person_id = ?`, personId)).toBe(1);
  });

  it("an expired consent is refused", async () => {
    const { personId, orgId, clientId } = setup();
    const session = signedIn(personId);
    const consent = authorize.createConsent({
      personId, clientId, redirectUri: CALLBACK, resource: oauth.mcpResource(), codeChallenge: CHALLENGE, state: "old",
    }, Date.now() - authorize.CONSENT_TTL_MS - 1000);
    const res = await post({ consent, csrf: authorize.consentCsrf(session.token, consent), decision: "approve", workspace: orgId, name: "Late-1" }, { cookie: session.cookie });
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('role="alert">This request expired.</p>');
  });

  it("the plan cap refuses ON the page, keeps the consent open, and creates nothing", async () => {
    const { personId, orgId, clientId } = setup();
    fx.atCap(orgId);
    const { session, consent, csrf } = await openConsent(personId, clientId);
    const res = await post({ consent, csrf, decision: "approve", workspace: orgId, name: "Capped-1" }, { cookie: session.cookie });
    expect(res.status).toBe(402);
    const html = await res.text();
    expect(html).toContain("Connect Claude");
    expect(html).toMatch(/class="error" id="consent-error" role="alert">[^<]*plan/);
    expect(hidden(html)).toEqual({ consent, csrf });
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, orgId)).toBe(0);
    expect(fx.count(`oauth_grants WHERE org_id = ?`, orgId)).toBe(0);
    expect(fx.count(`oauth_codes WHERE org_id = ?`, orgId)).toBe(0);
    // Lifting the cap, the same page's form still works.
    db.prepare(`UPDATE organizations SET plan = 'trial' WHERE id = ?`).run(orgId);
    expect((await post({ consent, csrf, decision: "approve", workspace: orgId, name: "Capped-1" }, { cookie: session.cookie })).status).toBe(200);
  });

  it("choosing a workspace re-renders for it; approving a kept-apart workspace without a project asks for one", async () => {
    const personId = fx.person();
    const together = fx.workspace(personId, { name: "A Together" });
    const apart = fx.workspace(personId, { isolated: true, projects: ["github.com/acme/api"], name: "B Apart" });
    const clientId = fx.dcrClient("Claude");
    const { session, consent, csrf, html } = await openConsent(personId, clientId);
    // Two workspaces: the first page asks for the workspace only, so no project list can belong to the wrong one.
    expect(html).not.toContain("every agent in A Together");
    expect(html).not.toContain('value="approve"');
    const chosen = await post({ consent, csrf, decision: "choose", workspace: apart }, { cookie: session.cookie });
    expect(chosen.status).toBe(200);
    expect(await chosen.text()).toContain('name="project" value="github.com/acme/api"');
    const noProject = await post({ consent, csrf, decision: "approve", workspace: apart, name: "Proj-1" }, { cookie: session.cookie });
    expect(noProject.status).toBe(400);
    expect(await noProject.text()).toContain("Choose a project.");
    const ok = await post({ consent, csrf, decision: "approve", workspace: apart, project: "github.com/acme/api", name: "Proj-1" }, { cookie: session.cookie });
    expect(ok.status).toBe(200);
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector' AND home_project = 'github.com/acme/api'`, apart)).toBe(1);
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, together)).toBe(0);
  });

  it("a workspace the person cannot add agents to is refused, even if posted by hand", async () => {
    const personId = fx.person();
    fx.workspace(personId);
    const memberOf = fx.workspace(personId, { role: "member" });
    const { session, consent, csrf } = await openConsent(personId, fx.dcrClient());
    const res = await post({ consent, csrf, decision: "approve", workspace: memberOf, name: "Nope-1" }, { cookie: session.cookie });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('role="alert">You need to be an owner or admin.</p>');
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, memberOf)).toBe(0);
  });

  it("is rate-limited per network", async () => {
    const ip = nextIp();
    const limit = Number(process.env.OPENCADRE_OAUTH_AUTHORIZE_PER_MIN) || 30;
    const statuses: number[] = [];
    for (let i = 0; i <= limit; i++) statuses.push((await post({ consent: "x", csrf: "y", decision: "approve" }, { ip })).status);
    expect(statuses.slice(0, limit).every((s) => s === 401)).toBe(true);
    expect(statuses[limit]).toBe(429);
    expect((await post({ consent: "x", csrf: "y" }, { ip: nextIp() })).status).toBe(401);
  });

  // Security review N4: nothing on the way back to a client may be cached, or leak the URL it came from.
  it("every answer on the way back is no-store and no-referrer: the sign-in and wrong-host 302s, the approve and deny pages", async () => {
    const uncached = (res: Response, status: number, label: string) => {
      expect(res.status, label).toBe(status);
      expect(res.headers.get("cache-control"), label).toBe("no-store");
      expect(res.headers.get("referrer-policy"), label).toBe("no-referrer");
    };
    const { personId, orgId, clientId } = setup();
    uncached(await get(authorizeQuery(clientId)), 302, "to sign-in");
    const a = await openConsent(personId, clientId);
    uncached(await post({ consent: a.consent, csrf: a.csrf, decision: "approve", workspace: orgId, name: "Hdr-1" }, { cookie: a.session.cookie }), 200, "approve");
    const d = await openConsent(personId, clientId);
    uncached(await post({ consent: d.consent, csrf: d.csrf, decision: "deny" }, { cookie: d.session.cookie }), 200, "deny");
    process.env.OPENCADRE_PUBLIC_APP_URL = "https://app.opencadre.test";
    uncached(await get(authorizeQuery(clientId)), 302, "to the console's host");
  });

  // Security review N3: the stored redirect is checked against the client's registration again when the person answers.
  it("a redirect the client no longer has registered is refused at approve, and nothing is created", async () => {
    const { personId, orgId, clientId } = setup();
    const { session, consent, csrf } = await openConsent(personId, clientId);
    db.prepare(`UPDATE oauth_clients SET redirect_uris = ? WHERE client_id = ?`).run(JSON.stringify(["https://claude.ai/other"]), clientId);
    const res = await post({ consent, csrf, decision: "approve", workspace: orgId, name: "Stale-1" }, { cookie: session.cookie });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('role="alert">This app&#39;s return address changed. Start again from the app.</p>');
    expect(res.headers.get("location")).toBeNull();
    expect(fx.count(`oauth_codes WHERE person_id = ?`, personId)).toBe(0);
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, orgId)).toBe(0);
  });

  // Security review N10: a successful approve needs nothing from the client's metadata document, so it fetches nothing.
  it("approving a CIMD client does not fetch its metadata again", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId);
    const clientId = "https://chatgpt.com/oauth/client.json";
    const doc = { client_id: clientId, client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] };
    let fetches = 0;
    cimd.cimdRouteDefaults.resolve = async () => [{ address: "104.18.32.47", family: 4 }];
    cimd.cimdRouteDefaults.transport = async () => {
      fetches++;
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(doc)); })() };
    };
    const { session, consent, csrf } = await openConsent(personId, clientId, signedIn(personId), { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" });
    expect(fetches).toBe(1);
    cimd.clearCimdCache();
    const res = await post({ consent, csrf, decision: "approve", workspace: orgId, name: "NoFetch-1" }, { cookie: session.cookie });
    expect(res.status).toBe(200);
    expect(fetches, "the approve fetched nothing").toBe(1);
  });

  it("PUT /v1/org/project-isolation reports how many connections switching on disconnected", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId, { isolated: false });
    const consentId = authorize.createConsent({ personId, clientId: fx.dcrClient(), redirectUri: CALLBACK, resource: oauth.mcpResource(), codeChallenge: CHALLENGE, state: "s" });
    expect(authorize.approveConsent({ consentId, personId, orgId, connectionName: "Wide-route" }).ok).toBe(true);
    const { registerAgent } = await import("../src/service.js");
    const operator = registerAgent(orgId, "Isolation-Op", { role: "operator" });
    const res = await fetch(`${base}/v1/org/project-isolation`, {
      method: "PUT", headers: { authorization: `Bearer ${operator.apiKey}`, "content-type": "application/json", "x-forwarded-for": nextIp() },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, changed: true, disconnectedConnections: 1 });
  });

  it("no code, CSRF or consent id reaches the log", async () => {
    const { setLogSink } = await import("../src/log.js");
    const lines: string[] = [];
    process.env.OPENCADRE_LOG_LEVEL = "debug";
    const restore = setLogSink((line) => lines.push(line));
    try {
      const { personId, orgId, clientId } = setup();
      const { session, consent, csrf } = await openConsent(personId, clientId);
      const res = await post({ consent, csrf, decision: "approve", workspace: orgId, name: "Quiet-1" }, { cookie: session.cookie });
      const code = params((await returnOf(res)).url).code;
      const all = lines.join("\n");
      for (const secret of [code, csrf, consent, session.token, CHALLENGE]) expect(all).not.toContain(secret);
    } finally {
      restore();
      delete process.env.OPENCADRE_LOG_LEVEL;
    }
  });
});

// --- Onboarding slice 2: a consent page that can't dead-end (docs/superpowers/plans/2026-10-30-easy-onboarding.md) ------
describe("the consent page never dead-ends (onboarding slice 2)", () => {
  /** The part of the form after the last field: where the error must sit, next to Approve. */
  const actionsOf = (html: string) => html.slice(html.lastIndexOf("</label>"), html.indexOf("</form>"));
  const projectRow = (orgId: string, key: string) =>
    db.prepare(`SELECT name, enabled FROM projects WHERE org_id = ? AND project_key = ?`).get(orgId, key) as { name: string; enabled: number } | undefined;

  it("a workspace that keeps projects apart and has none: Create a project inline, and Approve creates, enables and scopes to it", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId, { isolated: true, name: "Fresh" });
    const clientId = fx.dcrClient("Grok Bot");
    const { html, session, consent, csrf } = await openConsent(personId, clientId);
    expect(html).not.toContain("Turn one on in the console first");
    expect(html).toMatch(/<input name="new_project" type="text"[^>]* required/);
    expect(html).toContain('value="approve"');
    const res = await post({ consent, csrf, decision: "approve", workspace: orgId, new_project: "Grok Bot", name: "Grok Bot" }, { cookie: session.cookie });
    expect(res.status).toBe(200);
    expect(projectRow(orgId, "local:Grok-Bot")).toEqual({ name: "Grok-Bot", enabled: 1 });
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector' AND scope = 'project' AND home_project = 'local:Grok-Bot'`, orgId)).toBe(1);
    expect(fx.count(`events WHERE org_id = ? AND type = 'project.enabled' AND subject_id = 'local:Grok-Bot'`, orgId)).toBe(1);
  });

  it("creating a project is all-or-nothing: a refused approve (blank project, plan cap) creates no project", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId, { isolated: true, name: "Fresh" });
    const clientId = fx.dcrClient("Grok Bot");
    const blank = await openConsent(personId, clientId);
    const noName = await post({ consent: blank.consent, csrf: blank.csrf, decision: "approve", workspace: orgId, new_project: "  ", name: "Grok Bot" }, { cookie: blank.session.cookie });
    expect(noName.status).toBe(400);
    const page = await noName.text();
    expect(page).toMatch(/<input name="new_project" type="text"[^>]*aria-invalid="true" aria-describedby="consent-error" autofocus/);
    expect(page).toContain('role="alert">Use at least one letter or number.</p>');
    fx.atCap(orgId);
    const capped = await post({ consent: blank.consent, csrf: blank.csrf, decision: "approve", workspace: orgId, new_project: "Grok Bot", name: "Grok Bot" }, { cookie: blank.session.cookie });
    expect(capped.status).toBe(402);
    expect(await capped.text(), "the typed project name is kept").toContain('name="new_project" type="text" value="Grok Bot"');
    expect(fx.count(`projects WHERE org_id = ?`, orgId)).toBe(0);
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, orgId)).toBe(0);
  });

  it("someone who may not create projects is told whom to ask, with Deny and Open OpenCadre and no Approve", async () => {
    const { renderConsentPage } = await import("../src/oauth-consent-page.js");
    const html = renderConsentPage({ styleLinks: "", sprite: "" }, {
      consentId: "c", csrf: "t", clientName: "Grok Bot", redirectHost: "cursor.com", personLabel: "p@example.test",
      workspaces: [{ orgId: "o1", name: "Fresh", role: "admin", isolated: true, canCreateProjects: false, projects: [] }],
      selectedOrgId: "o1", chooseWorkspace: false, projectKey: null, newProjectName: "", connectionName: "Grok Bot",
    });
    expect(html).toContain("Ask an owner or admin to add a project.");
    expect(html).toContain('<a class="btn btn-quiet" href="/app/">Open OpenCadre</a>');
    expect(html).not.toContain('value="approve"');
    expect(html).not.toContain('name="new_project"');
    expect(html).toContain('value="deny"');
  });

  it("preselects the only project, else the most recently active, else none (and the choice stays required)", async () => {
    const one = fx.person();
    fx.workspace(one, { isolated: true, projects: ["github.com/acme/api"] });
    expect((await openConsent(one, fx.dcrClient())).html).toMatch(/name="project" value="github\.com\/acme\/api" checked required/);

    const two = fx.person();
    const orgId = fx.workspace(two, { isolated: true, projects: ["github.com/acme/api", "github.com/acme/web"] });
    const unseen = (await openConsent(two, fx.dcrClient())).html;
    expect(unseen).not.toMatch(/name="project" value="[^"]+" checked/);
    expect(unseen).toMatch(/name="project" value="github\.com\/acme\/api" required/);
    db.prepare(`UPDATE projects SET last_seen_at = ? WHERE org_id = ? AND project_key = ?`).run("2026-10-29T10:00:00.000Z", orgId, "github.com/acme/api");
    db.prepare(`UPDATE projects SET last_seen_at = ? WHERE org_id = ? AND project_key = ?`).run("2026-10-30T10:00:00.000Z", orgId, "github.com/acme/web");
    const seen = (await openConsent(two, fx.dcrClient())).html;
    expect(seen).toMatch(/name="project" value="github\.com\/acme\/web" checked required/);
    expect(seen).not.toMatch(/name="project" value="github\.com\/acme\/api" checked/);
  });

  it("two workspaces: choose the workspace, Continue, then only its projects; Change workspace goes back", async () => {
    const personId = fx.person();
    const first = fx.workspace(personId, { isolated: true, projects: ["github.com/acme/first"], name: "A First" });
    const second = fx.workspace(personId, { isolated: true, projects: ["github.com/acme/second"], name: "B Second" });
    const { html, session, consent, csrf } = await openConsent(personId, fx.dcrClient("Grok Bot"));
    expect(html).toContain('value="choose"');
    expect(html).toContain(">Continue</button>");
    expect(html).not.toContain('name="project"');
    expect(html).not.toContain('value="approve"');
    expect(html).not.toContain("Show options for this workspace");
    const chosen = await (await post({ consent, csrf, decision: "choose", workspace: second }, { cookie: session.cookie })).text();
    expect(chosen).toContain('name="project" value="github.com/acme/second" checked');
    expect(chosen).not.toContain("github.com/acme/first");
    expect(chosen, "only the chosen workspace is on the form").not.toContain(`value="${first}"`);
    expect(chosen).toContain(`value="${second}" checked`);
    expect(chosen).toContain('value="workspaces"');
    expect(chosen).toContain('value="approve"');
    const back = await (await post({ consent, csrf, decision: "workspaces", workspace: second, name: "Kept" }, { cookie: session.cookie })).text();
    expect(back).toContain(`value="${first}"`);
    expect(back).toContain(`value="${second}" checked`);
    expect(back).not.toContain('name="project"');
    expect(back, "a typed name survives the round trip").toContain('<input type="hidden" name="name" value="Kept">');
  });

  it("an approve error sits next to Approve, which references it; the project field is marked invalid", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId, { isolated: true, projects: ["github.com/acme/api", "github.com/acme/web"] });
    const { session, consent, csrf } = await openConsent(personId, fx.dcrClient());
    const res = await post({ consent, csrf, decision: "approve", workspace: orgId, name: "Err-1" }, { cookie: session.cookie });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(actionsOf(html)).toMatch(/<p class="error" id="consent-error" role="alert">Choose a project\.<\/p>/);
    expect(html).toMatch(/<button class="btn btn-ink" type="submit" name="decision" value="approve" aria-describedby="consent-error">/);
    expect(html).toMatch(/role="radiogroup" aria-labelledby="consent-project-label" aria-invalid="true" aria-describedby="consent-error"/);
    expect(html).toMatch(/name="project" value="github\.com\/acme\/api" required autofocus/);
  });

  it("the default name is the client's own name, made unique; the field is labelled Agent name", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId);
    const first = await openConsent(personId, fx.dcrClient("Grok Bot"));
    expect(first.html).toContain('name="name" type="text" value="Grok Bot"');
    expect(first.html).toContain('<span class="field-label">Agent name</span>');
    const { registerAgent } = await import("../src/service.js");
    registerAgent(orgId, "Grok Bot");
    const second = await openConsent(personId, fx.dcrClient("Grok Bot"));
    expect(second.html).toContain('name="name" type="text" value="Grok Bot 2"');
    // A DCR client named Cursor stays Cursor: the redirect is not used to guess the app.
    const cursor = await openConsent(personId, fx.dcrClient("Cursor", ["https://www.cursor.com/agents/mcp/oauth/callback"]), undefined, { redirect_uri: "https://www.cursor.com/agents/mcp/oauth/callback" });
    expect(cursor.html).toContain('name="name" type="text" value="Cursor"');
  });

  it("a typed name that is taken (even by a removed agent) comes back with a free one filled in, and why", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId);
    const { registerAgent } = await import("../src/service.js");
    const old = registerAgent(orgId, "Grok Bot Desk");
    db.prepare(`UPDATE agents SET removed_at = datetime('now') WHERE id = ?`).run(old.agentId);
    const { session, consent, csrf } = await openConsent(personId, fx.dcrClient("Grok Bot"));
    const res = await post({ consent, csrf, decision: "approve", workspace: orgId, name: "Grok Bot Desk" }, { cookie: session.cookie });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/name="name" type="text" value="Grok Bot Desk 2"[^>]*aria-invalid="true"/);
    expect(actionsOf(html)).toContain('id="consent-error" role="alert">Grok Bot Desk is taken. We filled in Grok Bot Desk 2.</p>');
    const ok = await post({ consent, csrf, decision: "approve", workspace: orgId, name: "Grok Bot Desk 2" }, { cookie: session.cookie });
    expect(ok.status).toBe(200);
  });

  it("already answered: names the agent and where it is when the consent made a grant; the generic page otherwise", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId, { isolated: true, projects: ["github.com/acme/api"], name: "Acme" });
    const clientId = fx.dcrClient("Grok Bot");
    const a = await openConsent(personId, clientId);
    const fields = { consent: a.consent, csrf: a.csrf, decision: "approve", workspace: orgId, project: "github.com/acme/api", name: "Grok <Bot>" };
    expect((await post(fields, { cookie: a.session.cookie })).status).toBe(200);
    const again = await post(fields, { cookie: a.session.cookie });
    expect(again.status).toBe(409);
    const text = await again.text();
    expect(text).toContain("Already connected as <strong>Grok &lt;Bot&gt;</strong> in <strong>api</strong> (Acme).");
    expect(text).not.toContain("Nothing was added");
    expect(text).not.toContain("close this tab");
    expect(text).not.toContain("<Bot>");
    // A denied consent made nothing: the generic page, which says so truthfully.
    const d = await openConsent(personId, clientId);
    await post({ consent: d.consent, csrf: d.csrf, decision: "deny" }, { cookie: d.session.cookie });
    const denied = await (await post({ consent: d.consent, csrf: d.csrf, decision: "approve", workspace: orgId, name: "X" }, { cookie: d.session.cookie })).text();
    expect(denied).toContain("already answered");
    expect(denied).not.toContain("already connected");
    // Disconnected since: no longer connected, so it does not claim to be.
    const grant = db.prepare(`SELECT grant_id FROM oauth_grants WHERE person_id = ? AND revoked_at IS NULL`).get(personId) as { grant_id: string };
    authorize.revokeGrant(grant.grant_id);
    expect(await (await post(fields, { cookie: a.session.cookie })).text()).not.toContain("already connected");
  });
});

describe("consent page polish (onboarding slice 2 review)", () => {
  it("the new-project field is prefilled (Main, else <Workspace> project), labelled, and has no helper sentence", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId, { isolated: true, name: "Fresh" });
    const { html } = await openConsent(personId, fx.dcrClient("Grok Bot"));
    expect(html).toContain('<span class="field-label">New project</span>');
    expect(html).toContain('name="new_project" type="text" value="Main"');
    expect(html).not.toContain("has none yet");
    // "Main" exists already (switched off): the default does not reuse it.
    db.prepare(`INSERT INTO projects (org_id, project_key, name, enabled) VALUES (?, 'local:Main', 'Main', 0)`).run(orgId);
    expect((await openConsent(personId, fx.dcrClient("Grok Bot"))).html).toContain('name="new_project" type="text" value="Fresh project"');
  });

  it("the page carries no helper sentences; the redirect host and the account stay, compact", async () => {
    const personId = fx.person();
    fx.workspace(personId, { isolated: true, projects: ["github.com/acme/api"], name: "Apart" });
    const { html } = await openConsent(personId, fx.dcrClient("Grok Bot"));
    expect(html).not.toContain("This connection works in the project you choose");
    expect(html).not.toContain("wants to work in your OpenCadre workspace");
    expect(html).not.toContain("After you answer");
    expect(html).not.toContain("Signed in as");
    expect(html).toContain('<p class="field-hint">Returns to <strong>claude.ai</strong></p>');
    expect(html).toMatch(/@example\.test · <button class="btn btn-ghost btn-sm" type="submit" name="decision" value="switch_account" form="consent-form" formnovalidate>Use another account<\/button>/);
    expect(html).toContain('<form class="stack" id="consent-form" method="post" action="/oauth/authorize">');
  });

  it("the already-connected page links to the console's agents list", async () => {
    const { personId, orgId, clientId } = setup();
    const { session, consent, csrf } = await openConsent(personId, clientId);
    const fields = { consent, csrf, decision: "approve", workspace: orgId, name: "Linked-1" };
    expect((await post(fields, { cookie: session.cookie })).status).toBe(200);
    expect(await (await post(fields, { cookie: session.cookie })).text()).toMatch(/<a class="btn btn-quiet" href="\/app\/#\/agents\/named">/);
  });
});

describe("new_project only creates; approve stays inside the person's own workspace (second review, finding B)", () => {
  const projectState = (orgId: string, key: string) =>
    (db.prepare(`SELECT enabled FROM projects WHERE org_id = ? AND project_key = ?`).get(orgId, key) as { enabled: number } | undefined)?.enabled;

  it("a project an owner switched off is not turned back on by a crafted new_project; nothing is created", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId, { isolated: true, name: "Fresh" });
    db.prepare(`INSERT INTO projects (org_id, project_key, name, enabled) VALUES (?, 'local:Old', 'Old', 0)`).run(orgId);
    const { session, consent, csrf } = await openConsent(personId, fx.dcrClient("Grok Bot"));
    const res = await post({ consent, csrf, decision: "approve", workspace: orgId, new_project: "Old", name: "Grok Bot" }, { cookie: session.cookie });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('id="consent-error" role="alert">Old is turned off. Pick another name, or turn it on in Settings → Projects.</p>');
    expect(projectState(orgId, "local:Old")).toBe(0);
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, orgId)).toBe(0);
    expect(fx.count(`events WHERE org_id = ? AND type = 'project.enabled'`, orgId)).toBe(0);
  });

  it("new_project is refused once the workspace has an enabled project (S4): only the picker applies then", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId, { isolated: true, projects: ["local:Main"], name: "Has Main" });
    const { session, consent, csrf } = await openConsent(personId, fx.dcrClient("Grok Bot"));
    for (const newProject of ["Main", "Brand New"]) {
      const res = await post({ consent, csrf, decision: "approve", workspace: orgId, new_project: newProject, name: "Grok Bot" }, { cookie: session.cookie });
      expect(res.status, newProject).toBe(400);
      expect(await res.text()).toContain('id="consent-error" role="alert">Choose a project.</p>');
    }
    expect(fx.count(`projects WHERE org_id = ?`, orgId)).toBe(1);
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, orgId)).toBe(0);
    expect(fx.count(`events WHERE org_id = ? AND type = 'project.enabled'`, orgId)).toBe(0);
    // The picker still works.
    const ok = await post({ consent, csrf, decision: "approve", workspace: orgId, project: "local:Main", name: "Grok Bot" }, { cookie: session.cookie });
    expect(ok.status).toBe(200);
  });

  it("a member posting new_project is refused, and nothing is created", async () => {
    const personId = fx.person();
    fx.workspace(personId, { name: "A Own" });
    const memberOf = fx.workspace(personId, { role: "member", isolated: true, name: "B Member" });
    const { session, consent, csrf } = await openConsent(personId, fx.dcrClient());
    const res = await post({ consent, csrf, decision: "approve", workspace: memberOf, new_project: "Sneaky", name: "Sneaky-1" }, { cookie: session.cookie });
    expect(res.status).toBe(403);
    expect(fx.count(`projects WHERE org_id = ?`, memberOf)).toBe(0);
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, memberOf)).toBe(0);
  });

  it("a workspace the person does not belong to is refused, with or without new_project", async () => {
    const personId = fx.person();
    fx.workspace(personId, { name: "Mine" });
    const theirs = fx.workspace(fx.person(), { isolated: true, name: "Theirs" });
    const { session, consent, csrf } = await openConsent(personId, fx.dcrClient());
    for (const extra of [{}, { new_project: "Planted" }]) {
      const res = await post({ consent, csrf, decision: "approve", workspace: theirs, name: "Stranger-1", ...extra }, { cookie: session.cookie });
      expect(res.status).toBe(403);
    }
    expect(fx.count(`projects WHERE org_id = ?`, theirs)).toBe(0);
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, theirs)).toBe(0);
  });

  it("another workspace's project key on approve is refused", async () => {
    const personId = fx.person();
    const a = fx.workspace(personId, { isolated: true, projects: ["github.com/acme/a"], name: "A" });
    fx.workspace(personId, { isolated: true, projects: ["github.com/acme/b"], name: "B" });
    const { session, consent, csrf } = await openConsent(personId, fx.dcrClient());
    const res = await post({ consent, csrf, decision: "approve", workspace: a, project: "github.com/acme/b", name: "Cross-1" }, { cookie: session.cookie });
    expect(res.status).toBe(400);
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, a)).toBe(0);
    expect(projectState(a, "github.com/acme/b")).toBeUndefined();
  });
});

describe("consent page copy and dead ends (round 3, UX review)", () => {
  it("Use another account signs this browser out and comes back to this same request after sign-in", async () => {
    const { personId, orgId, clientId } = setup();
    const { session, consent, csrf } = await openConsent(personId, clientId, undefined, { state: "keep me/é&=" });
    const res = await post({ consent, csrf, decision: "switch_account" }, { cookie: session.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${accounts.SESSION_COOKIE}=;`))).toBe(true);
    expect(accounts.sessionPerson(session.token), "the session is gone").toBeNull();
    const to = new URL(res.headers.get("location")!, base);
    expect(to.pathname).toBe("/app/");
    const next = new URL(to.searchParams.get("next")!, base);
    expect(next.pathname).toBe("/oauth/authorize");
    expect(params(next)).toMatchObject({
      response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: CHALLENGE, code_challenge_method: "S256",
      resource: oauth.mcpResource(), state: "keep me/é&=",
    });
    // Unanswered: switching account is not an answer. Signed in again, the same request opens a fresh consent page.
    expect(fx.count(`oauth_consents WHERE person_id = ? AND used_at IS NOT NULL`, personId)).toBe(0);
    const again = await get(`${next.pathname}${next.search}`, { cookie: signedIn(personId).cookie });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('value="approve"');
    expect(fx.count(`agents WHERE org_id = ? AND kind = 'connector'`, orgId)).toBe(0);
  });

  it("Use another account needs the page's CSRF token, like every answer", async () => {
    const { personId, clientId } = setup();
    const { session, consent } = await openConsent(personId, clientId);
    const res = await post({ consent, csrf: "forged", decision: "switch_account" }, { cookie: session.cookie });
    expect(res.status).toBe(403);
    expect(accounts.sessionPerson(session.token), "still signed in").not.toBeNull();
  });

  it("the first step preselects the workspace used most recently, else the first", async () => {
    const personId = fx.person();
    const first = fx.workspace(personId, { name: "A First" });
    const second = fx.workspace(personId, { name: "B Second" });
    const firstHtml = (await openConsent(personId, fx.dcrClient())).html;
    expect(firstHtml).toContain(`value="${first}" checked`);
    const member = db.prepare(`SELECT agent_id FROM workspace_members WHERE org_id = ? AND person_id = ?`);
    const at = (orgId: string, when: string) =>
      db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = ?`).run(when, (member.get(orgId, personId) as { agent_id: string }).agent_id);
    at(first, "2026-10-29 10:00:00");
    at(second, "2026-10-30 10:00:00");
    const html = (await openConsent(personId, fx.dcrClient())).html;
    expect(html).toContain(`value="${second}" checked`);
    expect(html).not.toContain(`value="${first}" checked`);
  });

  it("no role badge on workspaces; a project's key shows only when two projects share a name", async () => {
    const personId = fx.person();
    fx.workspace(personId, { isolated: true, projects: ["github.com/acme/api", "github.com/other/api", "github.com/acme/web"] });
    const { html } = await openConsent(personId, fx.dcrClient());
    expect(html).not.toMatch(/workspace-item-role">(owner|admin)</);
    expect(html).toContain('<span class="workspace-item-role">github.com/acme/api</span>');
    expect(html).toContain('<span class="workspace-item-role">github.com/other/api</span>');
    expect(html).not.toContain('<span class="workspace-item-role">github.com/acme/web</span>');
  });

  it("the error page offers one way on: back to the app when there is one, else Open OpenCadre; never 'Nothing was added'", async () => {
    setup();
    const plain = await (await get(authorizeQuery("dcr_ffffffffffffffffffffffffffffffff"))).text();
    expect(plain).not.toContain("Nothing was added");
    expect(plain).toContain('<a class="btn btn-quiet" href="/app/">Open OpenCadre</a>');
    expect(plain.match(/class="btn /g)).toHaveLength(1);
    const { clientId } = setup();
    const back = await (await get(authorizeQuery(clientId, { response_type: "token" }))).text();
    expect(back).toContain(">Return to claude.ai</a>");
    expect(back).not.toContain("Open OpenCadre");
    expect(back.match(/class="btn /g)).toHaveLength(1);
  });

  it("name messages are short and plain", async () => {
    const personId = fx.person();
    const orgId = fx.workspace(personId);
    const { session, consent, csrf } = await openConsent(personId, fx.dcrClient("Grok Bot"));
    const say = async (name: string) => {
      const html = await (await post({ consent, csrf, decision: "approve", workspace: orgId, name }, { cookie: session.cookie })).text();
      return html.match(/id="consent-error" role="alert">([^<]*)<\/p>/)?.[1];
    };
    expect(await say("   ")).toBe("Enter an agent name.");
    expect(await say("A".repeat(81))).toBe("Agent name is too long (max 80).");
    expect(await say("Grok\u0007Bot")).toBe("Use letters, numbers, spaces and punctuation.");
  });
});
