import type { AddressInfo } from "node:net";
import http from "node:http";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// THE CARDLESS TRIAL MODE, pinned (src/billing.ts trialMode). These accounts tests are about sign-up minting the first
// operator key on the hub-side trial and the one-live-trial rule for it. The card-required flow that is the launch
// default (no key, "No plan yet" until checkout) is covered by tests/card-trial.test.ts.
process.env.OPENCADRE_TRIAL_MODE = "cardless";

/** Resolves a bearer key to its identity, for asserting a minted key is real. Imported here (not via
 * `service`) so the Phase 2 tests can call it directly, exactly as `requireAgentAuth` does. */
let authenticateAgentKey: typeof import("../src/auth.js").authenticateAgentKey;

/** A stand-in Supabase Auth: authorize (redirects back with a code), token (PKCE exchange), otp, settings and JWKS.
 * Tokens are signed with a real ES256 key, so the hub's verification runs for real. */
const signer = generateKeyPairSync("ec", { namedCurve: "P-256" });
const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = "test-key";
const codes = new Map<string, { challenge: string; user: FakeUser }>();
const otpRequests: Array<{ email: string; redirect: string | null; challenge: string }> = [];
let nextUser: FakeUser = user("u-ada", "ada@example.com", "Ada Lovelace");
let tokenOverride: ((u: FakeUser) => string) | null = null;
/** Makes /auth/v1/settings fail, so the hub's "provider unreachable" branch is reachable from a test.
 * The catch in GET /v1/auth/config only fires when `enabledMethods` rejects, so this is the only way in. */
let settingsFails = false;
/** Makes /auth/v1/settings never answer (held until the test releases it), and counts the reads that reached it: the
 * site's first paint must not wait on a provider that hangs, and concurrent pages must share one read. */
let settingsHangs = false;
let settingsReads = 0;
const heldSettings: http.ServerResponse[] = [];
let supabaseUrl = "";

interface FakeUser { id: string; email: string; name: string }
function user(id: string, email: string, name: string): FakeUser {
  return { id, email, name };
}

function jwt(claims: Record<string, unknown>, key: KeyObject = signer.privateKey, header: Record<string, unknown> = { alg: "ES256", kid: KID }) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc(header)}.${enc(claims)}`;
  return `${body}.${sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
const goodToken = (u: FakeUser) => jwt({ sub: u.id, iss: `${supabaseUrl}/auth/v1`, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: u.email });

const fake = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/auth/v1/.well-known/jwks.json") {
      return json(200, { keys: [{ ...signer.publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" }] });
    }
    // The browser hits /authorize directly, with no API key (as with real Supabase).
    if (url.pathname === "/auth/v1/authorize") {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, user: nextUser });
      return res.writeHead(302, { location: `${url.searchParams.get("redirect_to")}?code=${code}` }).end();
    }
    if (req.headers.apikey !== "sb_publishable_test") return json(401, { message: "Invalid API key" });
    if (url.pathname === "/auth/v1/settings") {
      settingsReads++;
      if (settingsHangs) return void heldSettings.push(res);
      // A 500 makes enabledMethods throw, which is the hub's "provider unreachable" branch.
      if (settingsFails) return json(500, { message: "provider unavailable" });
      return json(200, { external: { github: true, google: false, email: true } });
    }
    if (url.pathname === "/auth/v1/otp") {
      const body = JSON.parse(raw);
      otpRequests.push({ email: body.email, redirect: url.searchParams.get("redirect_to"), challenge: body.code_challenge });
      return json(200, {});
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      const { auth_code, code_verifier } = JSON.parse(raw);
      const entry = codes.get(auth_code);
      const challenge = createHash("sha256").update(String(code_verifier)).digest("base64url");
      if (!entry || entry.challenge !== challenge) return json(400, { msg: "invalid flow state" });
      codes.delete(auth_code);
      const u = entry.user;
      return json(200, {
        access_token: (tokenOverride ?? goodToken)(u),
        user: { id: u.id, email: u.email, email_confirmed_at: "2026-09-15T00:00:00Z", user_metadata: { full_name: u.name, avatar_url: "https://avatars.example/a.png" } },
      });
    }
    json(404, { msg: "not found" });
  });
});

let hub: http.Server;
let base: string;
let app: typeof import("../src/rest.js").app;
let resetMethodsCache: typeof import("../src/rest.js").resetMethodsCache;
let service: typeof import("../src/service.js");
let accounts: typeof import("../src/accounts.js");
let db: typeof import("../src/db.js").db;

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.listen(0, resolve));
  supabaseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  ({ app } = await import("../src/rest.js"));
  ({ resetMethodsCache } = await import("../src/rest.js"));
  service = await import("../src/service.js");
  accounts = await import("../src/accounts.js");
  ({ authenticateAgentKey } = await import("../src/auth.js"));
  ({ db } = await import("../src/db.js"));
  hub = http.createServer(app);
  await new Promise<void>((resolve) => hub.listen(0, resolve));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => hub.close(() => resolve()));
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});
beforeEach(() => {
  tokenOverride = null;
  settingsFails = false;
  delete process.env.OPENCADRE_SIGNUP;
});

const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]);
const cookieValue = (jar: string[], name: string) => jar.find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

/** Runs the whole browser flow for `who` and returns their session cookie header. */
async function signIn(who: FakeUser, next?: string): Promise<{ cookie: string; location: string }> {
  nextUser = who;
  const start = await fetch(`${base}/v1/auth/start?provider=github${next ? `&next=${encodeURIComponent(next)}` : ""}`, { redirect: "manual" });
  expect(start.status).toBe(302);
  const pkce = cookiesFrom(start).find((c) => c.startsWith("oc_pkce="))!;
  const toSupabase = start.headers.get("location")!;
  expect(toSupabase).toContain(`${supabaseUrl}/auth/v1/authorize?provider=github`);
  expect(toSupabase).toContain("code_challenge_method=s256");
  const back = await fetch(toSupabase, { redirect: "manual" });
  const callback = await fetch(back.headers.get("location")!, { redirect: "manual", headers: { cookie: pkce } });
  expect(callback.status).toBe(302);
  const session = cookiesFrom(callback).find((c) => c.startsWith("oc_session=") && c !== "oc_session=");
  return { cookie: session ?? "", location: callback.headers.get("location")! };
}

const api = (path: string, init: RequestInit & { cookie?: string; workspace?: string } = {}) => {
  const { cookie, workspace, headers, ...rest } = init;
  return fetch(`${base}${path}`, {
    ...rest,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(workspace ? { "x-opencadre-workspace": workspace } : {}),
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(headers as Record<string, string>),
    },
  });
};

async function ownerWorkspace(who: FakeUser, name: string) {
  process.env.OPENCADRE_SIGNUP = "open";
  const { cookie } = await signIn(who);
  const created = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name }) });
  expect(created.status).toBe(201);
  const { workspace } = (await created.json()) as { workspace: { orgId: string } };
  return { cookie, orgId: workspace.orgId };
}

async function invite(owner: { cookie: string; orgId: string }, body: Record<string, unknown>) {
  const res = await api(`/v1/workspaces/${owner.orgId}/invites`, { method: "POST", cookie: owner.cookie, workspace: owner.orgId, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  const { url } = (await res.json()) as { url: string };
  return new URL(url).searchParams.get("invite")!;
}

describe("sign-in", () => {
  it("runs the PKCE flow server-side and sets an HttpOnly session; no Supabase token reaches the browser", async () => {
    nextUser = user("u-flow", "flow@example.com", "Flow Person");
    const start = await fetch(`${base}/v1/auth/start?provider=github`, { redirect: "manual" });
    const setCookies = start.headers.getSetCookie();
    expect(setCookies.find((c) => c.startsWith("oc_pkce="))).toMatch(/HttpOnly; SameSite=Lax/);
    const back = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const callback = await fetch(back.headers.get("location")!, { redirect: "manual", headers: { cookie: cookiesFrom(start)[0] } });
    expect(callback.headers.get("location")).toBe("/app/");
    const session = callback.headers.getSetCookie().find((c) => c.startsWith("oc_session=") && !c.startsWith("oc_session=;"));
    expect(session).toMatch(/HttpOnly; SameSite=Lax/);
    expect(await callback.text()).not.toMatch(/eyJ/);

    const me = await api("/v1/auth/me", { cookie: session!.split(";")[0] });
    expect(await me.json()).toEqual({
      person: { id: "u-flow", name: "Flow Person", email: "flow@example.com", avatarUrl: "https://avatars.example/a.png" },
      workspaces: [],
      canCreateWorkspace: true,
    });
  });

  it("refuses a callback without this browser's verifier, a forged token, a wrong issuer and an expired token", async () => {
    nextUser = user("u-bad", "bad@example.com", "Bad");
    const noVerifier = await fetch(`${base}/v1/auth/callback?code=code-x`, { redirect: "manual" });
    expect(noVerifier.headers.get("location")).toMatch(/auth_error=/);
    expect(cookiesFrom(noVerifier).some((c) => c.startsWith("oc_session=") && c !== "oc_session=")).toBe(false);

    const forged = [
      (u: FakeUser) => jwt({ sub: u.id, iss: `${supabaseUrl}/auth/v1`, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, stranger.privateKey),
      (u: FakeUser) => jwt({ sub: u.id, iss: "https://evil.supabase.co/auth/v1", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }),
      (u: FakeUser) => jwt({ sub: u.id, iss: `${supabaseUrl}/auth/v1`, aud: "authenticated", exp: Math.floor(Date.now() / 1000) - 10 }),
      (u: FakeUser) => jwt({ sub: u.id, iss: `${supabaseUrl}/auth/v1`, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, signer.privateKey, { alg: "none", kid: KID }),
    ];
    for (const make of forged) {
      tokenOverride = make;
      const { cookie, location } = await signIn(user("u-bad", "bad@example.com", "Bad"));
      expect(cookie).toBe("");
      expect(location).toMatch(/^\/app\/\?auth_error=/);
    }
  });

  it("never redirects outside the console after sign-in", async () => {
    for (const next of ["https://evil.example/", "//evil.example/app", "/app/\\\\evil.example", "/admin", "/app/../admin", "/app/%2e%2e/admin", "/apps"]) {
      expect((await signIn(user("u-next", "next@example.com", "Next"), next)).location).toBe("/app/");
    }
    expect((await signIn(user("u-next", "next@example.com", "Next"), "/app/?invite=oci_abc")).location).toBe("/app/?invite=oci_abc");
  });

  // The console puts the plan chosen on the pricing page into `next` (public/app/app.js signInNext), so it survives a
  // magic link that opens in a new tab. The query must come back untouched on a console path, and adding one must not
  // open any of the redirects the plain paths above are refused.
  it("keeps the plan and interval in the query of a console path, and still refuses every escape with one appended", async () => {
    const who = user("u-plan", "plan@example.com", "Plan");
    expect((await signIn(who, "/app/?plan=team&interval=annual")).location).toBe("/app/?plan=team&interval=annual");
    expect((await signIn(who, "/app?plan=pro")).location).toBe("/app?plan=pro");
    for (const next of [
      "https://evil.example/app/?plan=team&interval=annual", "//evil.example/app/?plan=team", "/app/\\\\evil.example?plan=team",
      "/app/../admin?plan=team", "/app/%2e%2e/admin?plan=team", "/apps?plan=team", "/admin?plan=team&interval=annual",
      "/app/?plan=team&next=https://evil.example/",
    ]) {
      const { location } = await signIn(who, next);
      // Either refused to the bare console, or (the last one) kept as an inert query on a console path.
      expect(location.startsWith("/app/") || location.startsWith("/app?")).toBe(true);
      expect(location).not.toContain("evil.example/app");
      expect(new URL(location, "https://console.invalid").host).toBe("console.invalid");
    }
    expect((await signIn(who, "//evil.example/app/?plan=team")).location).toBe("/app/");
    expect((await signIn(who, "/app/../admin?plan=team")).location).toBe("/app/");
  });

  it("sends a magic link with PKCE to the same callback, and rate-limits per address", async () => {
    const send = () => api("/v1/auth/email", { method: "POST", body: JSON.stringify({ email: "Link@Example.com" }) });
    const first = await send();
    expect(first.status).toBe(200);
    expect(otpRequests.at(-1)).toMatchObject({ email: "link@example.com", redirect: `${base}/v1/auth/callback` });
    expect(otpRequests.at(-1)!.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (let i = 0; i < 4; i++) await send();
    expect((await send()).status).toBe(429);
    expect((await api("/v1/auth/email", { method: "POST", body: JSON.stringify({ email: "not-an-email" }) })).status).toBe(400);
  });

  it("reports which methods the project has turned on", async () => {
    resetMethodsCache();
    expect(await (await api("/v1/auth/config")).json()).toEqual({ enabled: true, methods: { github: true, google: false, email: true }, signup: "open" });
  });

  it("reports open signup even when the retired flag is set", async () => {
    expect((await (await api("/v1/auth/config")).json()).signup).toBe("open");
    process.env.OPENCADRE_SIGNUP = "waitlist";
    expect((await (await api("/v1/auth/config")).json()).signup).toBe("open");
  });
  // When the provider cannot be reached we do NOT know which methods are on. The route used to answer
  // 200 with all three claimed true plus an `unverified` marker, and nothing read the marker: the
  // console renders a button per true method, so a transient provider failure showed GitHub, Google
  // and email as available on no evidence. The console already has an honest degraded state
  // ("Couldn't check sign-in options") but it is reached only by a THROWN error, which a 200 never is.
  // So the fix is to stop claiming: answer with the methods we actually know, and let the page say it
  // could not check. `unverified` is removed -- it was a marker with no consumer, and keeping it while
  // it means nothing is how a field like this survives to mislead the next reader.
  it("does not claim any sign-in method when the provider cannot be reached", async () => {
    settingsFails = true;
    // The route memoizes a SUCCESS for 5 minutes, so without this the test would be served a stale
    // list, never reach the catch, and pass or fail for the wrong reason.
    resetMethodsCache();
    try {
      const res = await api("/v1/auth/config");
      // 200 is right: the hub itself is up and can still serve agent-key sign-in. What must not
      // happen is asserting methods we have no basis for.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled: boolean; methods: Record<string, boolean>; unverified?: unknown; signup: string };
      expect(body).toEqual({ enabled: true, methods: { github: false, google: false, email: false }, signup: "open" });
      // The marker is gone, not merely unread: a field no consumer reads is a claim with no check.
      expect(body.unverified).toBeUndefined();
    } finally {
      settingsFails = false;
    }
  });

  // The positive control for the test above. Without this, a route that returned all-false ALWAYS
  // would pass it -- and "reports which methods the project has turned on" would fail instead, so the
  // pair is what pins the behavior. Asserted here explicitly because the degraded answer and the
  // unknown-methods answer must stay distinguishable.
  it("still reports the real methods when the provider answers", async () => {
    resetMethodsCache(); // drop the all-false entry the degraded-path test left behind
    expect(await (await api("/v1/auth/config")).json()).toEqual({ enabled: true, methods: { github: true, google: false, email: true }, signup: "open" });
  });

  it("signing out ends the session", async () => {
    const { cookie } = await signIn(user("u-out", "out@example.com", "Out"));
    expect((await api("/v1/auth/me", { cookie })).status).toBe(200);
    expect((await api("/v1/auth/signout", { method: "POST", cookie })).status).toBe(200);
    expect((await api("/v1/auth/me", { cookie })).status).toBe(401);
  });
});

describe("workspaces and the console", () => {
  it("creates a workspace without an approval row and makes the creator its owner", async () => {
    const { cookie } = await signIn(user("u-gate", "gate@example.com", "Gate"));
    const created = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Gate Labs" }) });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { agent?: { agentId: string } };
    expect(body.agent?.agentId).toBeTruthy();
    const me = (await (await api("/v1/auth/me", { cookie })).json()) as { workspaces: Array<{ name: string; role: string }> };
    expect(me.workspaces).toEqual([expect.objectContaining({ name: "Gate Labs", role: "owner" })]);
  });
  it("a session acts in a workspace only with the workspace header and a membership, as the person's own name", async () => {
    const ada = await ownerWorkspace(user("u-console", "console@example.com", "Console Owner"), "Console Co");
    expect((await api("/v1/agents", { cookie: ada.cookie })).status).toBe(400);
    const other = service.createOrganization("Someone Else").orgId;
    expect((await api("/v1/agents", { cookie: ada.cookie, workspace: other })).status).toBe(403);

    const ok = await api("/v1/tasks", { method: "POST", cookie: ada.cookie, workspace: ada.orgId, body: JSON.stringify({ title: "Wire sign-in" }) });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { task: { created_by_agent_name: string } }).task.created_by_agent_name).toBe("Console Owner");
    // Owners get the console's operator powers.
    expect((await api("/v1/clearance-policy", { method: "PUT", cookie: ada.cookie, workspace: ada.orgId, body: JSON.stringify({ mode: "ask" }) })).status).toBe(200);
  });

  it("a cookie can't be ridden cross-site: person-level writes must be JSON", async () => {
    const { cookie } = await signIn(user("u-csrf", "csrf@example.com", "Csrf"));
    const form = await fetch(`${base}/v1/workspaces`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "name=Evil" });
    expect(form.status).toBe(415);
  });

  it("agents keep their keys, and people don't show up as stale agents", async () => {
    const owner = await ownerWorkspace(user("u-keys", "keys@example.com", "Keys Owner"), "Keys Co");
    const agent = service.registerAgent(owner.orgId, "Codex");
    expect((await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${agent.apiKey}` } })).status).toBe(200);
    db.prepare(`UPDATE agents SET last_heartbeat_at = datetime('now', '-2 days') WHERE org_id = ?`).run(owner.orgId);
    service.sweepStaleAgents();
    const rows = db.prepare(`SELECT name, key_class, status FROM agents WHERE org_id = ? ORDER BY name`).all(owner.orgId);
    // Three rows now, not two: open mode mints the self-serve "First Agent" key alongside the person's
    // member agent (docs/design/SELF-SERVE-BACKEND.md §4.2). Both are real agents and both get swept.
    expect(rows).toEqual([
      { name: "Codex", key_class: "agent", status: "paused" },
      { name: "First Agent", key_class: "agent", status: "paused" },
      { name: "Keys Owner", key_class: "human", status: "active" },
    ]);
  });
});

describe("invites and members", () => {
  it("an invite link adds a member once; the accept page shows details without the full locked email", async () => {
    const owner = await ownerWorkspace(user("u-own1", "own1@example.com", "Owner One"), "Invite Co");
    const token = await invite(owner, { role: "member" });
    expect(await (await api(`/v1/invites/${token}`)).json()).toMatchObject({ valid: true, workspaceName: "Invite Co", role: "member", invitedBy: "Owner One", lockedToEmail: null });

    const bob = await signIn(user("u-bob", "bob@example.com", "Bob"));
    const accepted = await api(`/v1/invites/${token}/accept`, { method: "POST", cookie: bob.cookie, body: "{}" });
    expect(await accepted.json()).toEqual({ workspace: { orgId: owner.orgId, name: "Invite Co", role: "member", alreadyMember: false } });
    const reused = await api(`/v1/invites/${token}/accept`, { method: "POST", cookie: (await signIn(user("u-carl", "carl@example.com", "Carl"))).cookie, body: "{}" });
    expect(reused.status).toBe(410);

    const locked = await invite(owner, { role: "admin", email: "dana@example.com" });
    expect(((await (await api(`/v1/invites/${locked}`)).json()) as { lockedToEmail: string }).lockedToEmail).toBe("d•••@example.com");
    const wrong = await api(`/v1/invites/${locked}/accept`, { method: "POST", cookie: bob.cookie, body: "{}" });
    expect(wrong.status).toBe(403);
    const dana = await signIn(user("u-dana", "dana@example.com", "Dana"));
    expect((await api(`/v1/invites/${locked}/accept`, { method: "POST", cookie: dana.cookie, body: "{}" })).status).toBe(200);

    const members = (await (await api(`/v1/workspaces/${owner.orgId}/members`, { cookie: owner.cookie, workspace: owner.orgId })).json()) as { members: Array<{ name: string; role: string }> };
    expect(members.members.map((m) => [m.name, m.role])).toEqual([["Owner One", "owner"], ["Dana", "admin"], ["Bob", "member"]]);
    const pending = await invite(owner, { role: "member", email: "erin@example.com" });
    const listed = (await (await api(`/v1/workspaces/${owner.orgId}/members`, { cookie: owner.cookie, workspace: owner.orgId })).json()) as { invites: Array<Record<string, unknown>> };
    expect(pending).toMatch(/^oci_/);
    expect(Object.keys(listed.invites[0]).sort()).toEqual(["createdAt", "email", "expiresAt", "id", "invitedBy", "role"]);
  });

  // WAS "the Operator key can invite the first owner of an existing workspace (the claim path)", expecting 201. Every
  // member can decide clearances (person approvals, migration 53), so an email-less invite minted by a key lets the key
  // mint the person that approves its own fleet's commands. Security review of #653: an invite needs a person session.
  it("an Operator key or agent key cannot create an invite (it could mint a person who approves clearances); a person can", async () => {
    const { orgId } = service.createOrganization("Legacy Fleet");
    const operator = service.registerAgent(orgId, "Operator", { role: "operator", system: true });
    const agent = service.registerAgent(orgId, "Coder");
    for (const key of [operator.apiKey, agent.apiKey]) {
      const res = await fetch(`${base}/v1/workspaces/${orgId}/invites`, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ role: "owner" }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/Only a signed-in person can invite people/);
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM workspace_invites WHERE org_id = ?`).get(orgId)).toEqual({ n: 0 });
    // Control: the workspace's owner, signed in, invites through the same route.
    const owner = await ownerWorkspace(user("u-claim-owner", "claim-owner@example.com", "Claim Owner"), "Invite Control Co");
    const token = await invite(owner, { role: "member" });
    expect(token).toMatch(/^oci_/);
  });

  it("members can't manage people; admins can't touch owners; the last owner stays", async () => {
    const owner = await ownerWorkspace(user("u-own2", "own2@example.com", "Owner Two"), "Roles Co");
    const member = await signIn(user("u-mem", "mem@example.com", "Mem"));
    await api(`/v1/invites/${await invite(owner, { role: "member" })}/accept`, { method: "POST", cookie: member.cookie, body: "{}" });
    const admin = await signIn(user("u-adm", "adm@example.com", "Adm"));
    await api(`/v1/invites/${await invite(owner, { role: "admin" })}/accept`, { method: "POST", cookie: admin.cookie, body: "{}" });
    const as = (who: { cookie: string }) => ({ cookie: who.cookie, workspace: owner.orgId });

    expect((await api(`/v1/workspaces/${owner.orgId}/invites`, { method: "POST", ...as(member), body: JSON.stringify({ role: "member" }) })).status).toBe(403);
    expect((await api("/v1/clearance-policy", { method: "PUT", ...as(member), body: JSON.stringify({ mode: "off" }) })).status).toBe(403);
    expect((await api(`/v1/workspaces/${owner.orgId}/invites`, { method: "POST", ...as(admin), body: JSON.stringify({ role: "owner" }) })).status).toBe(403);
    expect((await api(`/v1/workspaces/${owner.orgId}/members/u-own2`, { method: "PATCH", ...as(admin), body: JSON.stringify({ role: "member" }) })).status).toBe(403);
    expect((await api(`/v1/workspaces/${owner.orgId}/members/u-own2`, { method: "PATCH", ...as(owner), body: JSON.stringify({ role: "member" }) })).status).toBe(409);

    // Stage 3 RBAC tightening: changing a role is owner-only now, so an admin can't
    // promote anyone -- not even a plain member -- only an owner can.
    expect((await api(`/v1/workspaces/${owner.orgId}/members/u-mem`, { method: "PATCH", ...as(admin), body: JSON.stringify({ role: "admin" }) })).status).toBe(403);

    // Promoting the member to admin gives them operator powers at once.
    expect((await api(`/v1/workspaces/${owner.orgId}/members/u-mem`, { method: "PATCH", ...as(owner), body: JSON.stringify({ role: "admin" }) })).status).toBe(200);
    expect((await api("/v1/clearance-policy", { method: "PUT", ...as(member), body: JSON.stringify({ mode: "off" }) })).status).toBe(200);

    // Demoting ends their open requests at once, and the new role applies to the next one.
    const held = api("/v1/messages/wait?timeoutSeconds=30", as(member));
    await new Promise((r) => setTimeout(r, 150));
    expect((await api(`/v1/workspaces/${owner.orgId}/members/u-mem`, { method: "PATCH", ...as(owner), body: JSON.stringify({ role: "member" }) })).status).toBe(200);
    expect((await held).status).toBe(409);
    expect((await api("/v1/clearance-policy", { method: "PUT", ...as(member), body: JSON.stringify({ mode: "off" }) })).status).toBe(403);
  });

  // Stage 3 retro finding: agents.role collapses owner+admin into one "operator" role everywhere,
  // so an admin could stop every agent in the workspace at once, the same as an owner. Pause/resume
  // (requireOwner, src/rest.ts) is the first place that distinction is actually enforced.
  it("pause/resume: an admin cannot stop the workspace, only an owner can", async () => {
    const owner = await ownerWorkspace(user("u-own-pause", "ownpause@example.com", "Owner Pause"), "Pause Co");
    const admin = await signIn(user("u-adm-pause", "admpause@example.com", "Admin Pause"));
    await api(`/v1/invites/${await invite(owner, { role: "admin" })}/accept`, { method: "POST", cookie: admin.cookie, body: "{}" });
    const as = (who: { cookie: string }) => ({ cookie: who.cookie, workspace: owner.orgId });

    const deniedPause = await api("/v1/org/pause", { method: "POST", ...as(admin), body: "{}" });
    expect(deniedPause.status).toBe(403);

    const allowedPause = await api("/v1/org/pause", { method: "POST", ...as(owner), body: "{}" });
    expect(allowedPause.status).toBe(200);

    // Resume is gated the same way -- an admin can't even resume a workspace an owner paused.
    const deniedResume = await api("/v1/org/resume", { method: "POST", ...as(admin), body: "{}" });
    expect(deniedResume.status).toBe(403);

    const allowedResume = await api("/v1/org/resume", { method: "POST", ...as(owner), body: "{}" });
    expect(allowedResume.status).toBe(200);
  });

  it("pause/resume: a bare Operator API key (not tied to a person) still works -- it predates the owner/admin split", async () => {
    const { orgId } = service.createOrganization("Bare Operator Pause Co");
    const operator = service.registerAgent(orgId, "Operator", { role: "operator", system: true });
    const auth = { headers: { authorization: `Bearer ${operator.apiKey}`, "content-type": "application/json" } };
    expect((await fetch(`${base}/v1/org/pause`, { method: "POST", ...auth, body: "{}" })).status).toBe(200);
    expect((await fetch(`${base}/v1/org/resume`, { method: "POST", ...auth, body: "{}" })).status).toBe(200);
  });

  // Stage 3 RBAC migration step 2 (docs/design/rbac-permission-model.md): agent key rotation and
  // deletion tightened from admin to owner-only, same trust tier as pause/resume -- both let a
  // caller change what runs as an agent in this workspace.
  it("agent key rotate/delete: an admin can't, only an owner can", async () => {
    const owner = await ownerWorkspace(user("u-own-keys", "ownkeys@example.com", "Owner Keys"), "Keys Co");
    const admin = await signIn(user("u-adm-keys", "admkeys@example.com", "Admin Keys"));
    await api(`/v1/invites/${await invite(owner, { role: "admin" })}/accept`, { method: "POST", cookie: admin.cookie, body: "{}" });
    const as = (who: { cookie: string }) => ({ cookie: who.cookie, workspace: owner.orgId });
    const coder = service.registerAgent(owner.orgId, "Coder Keys");

    const deniedRotate = await api(`/v1/org/agents/${coder.agentId}/rotate-key`, { method: "POST", ...as(admin), body: "{}" });
    expect(deniedRotate.status).toBe(403);
    const allowedRotate = await api(`/v1/org/agents/${coder.agentId}/rotate-key`, { method: "POST", ...as(owner), body: "{}" });
    expect(allowedRotate.status).toBe(200);

    const deniedDelete = await api(`/v1/org/agents/${coder.agentId}`, { method: "DELETE", ...as(admin) });
    expect(deniedDelete.status).toBe(403);
    const allowedDelete = await api(`/v1/org/agents/${coder.agentId}`, { method: "DELETE", ...as(owner) });
    expect(allowedDelete.status).toBe(200);
  });

  it("removing a member cuts their open requests and access at once; anyone can leave", async () => {
    const owner = await ownerWorkspace(user("u-own3", "own3@example.com", "Owner Three"), "Remove Co");
    const eve = await signIn(user("u-eve", "eve@example.com", "Eve"));
    await api(`/v1/invites/${await invite(owner, { role: "member" })}/accept`, { method: "POST", cookie: eve.cookie, body: "{}" });
    const waiting = api("/v1/messages/wait?timeoutSeconds=30", { cookie: eve.cookie, workspace: owner.orgId });
    await new Promise((r) => setTimeout(r, 150));

    expect((await api(`/v1/workspaces/${owner.orgId}/members/u-eve`, { method: "DELETE", cookie: owner.cookie, workspace: owner.orgId })).status).toBe(200);
    expect((await waiting).status).toBe(403);
    expect((await api("/v1/agents", { cookie: eve.cookie, workspace: owner.orgId })).status).toBe(403);
    const roster = (await (await api("/v1/agents", { cookie: owner.cookie, workspace: owner.orgId })).json()) as { agents: Array<{ name: string }> };
    expect(roster.agents.map((a) => a.name)).not.toContain("Eve");

    const finn = await signIn(user("u-finn", "finn@example.com", "Finn"));
    await api(`/v1/invites/${await invite(owner, { role: "member" })}/accept`, { method: "POST", cookie: finn.cookie, body: "{}" });
    expect((await api(`/v1/workspaces/${owner.orgId}/members/u-finn`, { method: "DELETE", cookie: finn.cookie, workspace: owner.orgId })).status).toBe(200);
    expect((await api(`/v1/workspaces/${owner.orgId}/members/u-own3`, { method: "DELETE", cookie: owner.cookie, workspace: owner.orgId })).status).toBe(409);
  });

  it("a paused workspace refuses members but keeps owners and admins in", async () => {
    const owner = await ownerWorkspace(user("u-own4", "own4@example.com", "Owner Four"), "Pause Co");
    const gus = await signIn(user("u-gus", "gus@example.com", "Gus"));
    await api(`/v1/invites/${await invite(owner, { role: "member" })}/accept`, { method: "POST", cookie: gus.cookie, body: "{}" });
    expect((await api("/v1/org/pause", { method: "POST", cookie: owner.cookie, workspace: owner.orgId, body: "{}" })).status).toBe(200);
    expect((await api("/v1/agents", { cookie: gus.cookie, workspace: owner.orgId })).status).toBe(423);
    expect((await api("/v1/agents", { cookie: owner.cookie, workspace: owner.orgId })).status).toBe(200);
  });

  it("member routes are scoped to the workspace in the header", async () => {
    const a = await ownerWorkspace(user("u-iso-a", "isoa@example.com", "Iso A"), "Iso A Co");
    const b = await ownerWorkspace(user("u-iso-b", "isob@example.com", "Iso B"), "Iso B Co");
    expect((await api(`/v1/workspaces/${b.orgId}/members`, { cookie: a.cookie, workspace: a.orgId })).status).toBe(404);
    expect((await api(`/v1/workspaces/${b.orgId}/invites`, { method: "POST", cookie: a.cookie, workspace: a.orgId, body: JSON.stringify({ role: "owner" }) })).status).toBe(404);
    expect((await api(`/v1/workspaces/${b.orgId}/members/u-iso-b`, { method: "DELETE", cookie: a.cookie, workspace: b.orgId })).status).toBe(403);
    expect(accounts.getMembership(b.orgId, "u-iso-b")?.role).toBe("owner");
  });
});

/** Phase 2 (docs/design/SELF-SERVE-BACKEND.md §8): a new user signs up and gets a first key with no
 * operator approval, behind the flag. These are the tests that define the unit — written against the
 * design's numbered list, and each one names the risk it covers. */
describe("self-serve: sign up, create a workspace, get a first key", () => {
  /** Signs a brand-new person in, creates their workspace under the open flag, and returns the first
   * key plus its identifiers. This is the unit's happy path, reused by the tests that need a key. */
  async function firstKey(who: FakeUser, name: string) {
    process.env.OPENCADRE_SIGNUP = "open";
    const { cookie } = await signIn(who);
    const res = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name }) });
    expect(res.status).toBe(201);
    const { workspace, agent } = (await res.json()) as {
      workspace: { orgId: string };
      agent: { agentId: string; apiKey: string };
    };
    return { cookie, orgId: workspace.orgId, agentId: agent.agentId, apiKey: agent.apiKey };
  }

  /** The whole point of the unit: a brand-new person, no waitlist row, no admin token, ends up holding
   * a working agt_ key. Everything below builds on this. */
  it("open sign-up issues a first key with no waitlist row and no admin token", async () => {
    process.env.OPENCADRE_SIGNUP = "open";
    const { cookie } = await signIn(user("u-ss1", "ss1@example.com", "Self Serve"));
    const res = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Solo Co" }) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { orgId: string; name: string; role: string };
      agent?: { agentId: string; agentName: string; apiKey: string; urlKey: string };
    };
    expect(body.workspace).toEqual(expect.objectContaining({ name: "Solo Co", role: "owner" }));
    expect(body.agent?.apiKey).toMatch(/^agt_[0-9a-f]{48}$/);

    // The key is real: it authenticates as an agent IN THAT ORG, at operator tier.
    const authed = authenticateAgentKey(body.agent!.apiKey);
    expect(authed).toEqual(expect.objectContaining({ orgId: body.workspace.orgId, agentId: body.agent!.agentId, role: "operator" }));
  });

  it("allows one active trial per owner, preserving idempotent retries and allowing a new one after upgrade or expiry", async () => {
    const { cookie } = await signIn(user("u-ss-trial", "trial@example.com", "Trial Owner"));
    const create = (name: string) => api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name }) });
    const first = await create("Trial One");
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { workspace: { orgId: string } }).workspace.orgId;
    const retry = await create("Trial One");
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { workspace: { existing: boolean } }).workspace.existing).toBe(true);
    const denied = await create("Trial Two");
    expect(denied.status).toBe(402);
    expect((await denied.json()) as { code: string }).toMatchObject({ code: "ACTIVE_TRIAL_WORKSPACE" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE person_id = ? AND role = 'owner'`).get("u-ss-trial")).toEqual({ n: 1 });

    db.prepare(`UPDATE organizations SET plan = 'pro', trial_ends_at = NULL WHERE id = ?`).run(firstId);
    const second = await create("Trial Two");
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { workspace: { orgId: string } }).workspace.orgId;
    expect((await create("Trial Three")).status).toBe(402);
    db.prepare(`UPDATE organizations SET trial_ends_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), secondId);
    expect((await create("Trial Three")).status).toBe(201);
  });
  it("the minted key is an ordinary agent key, so rotation and revocation work on it", async () => {
    process.env.OPENCADRE_SIGNUP = "open";
    const { cookie } = await signIn(user("u-ss2", "ss2@example.com", "Self Serve Two"));
    const created = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Rotate Co" }) });
    const { workspace, agent } = (await created.json()) as { workspace: { orgId: string }; agent: { agentId: string; apiKey: string } };

    // It is NOT the org bootstrap key: no org_ prefix, and an agents row exists behind it.
    expect(agent.apiKey.startsWith("org_")).toBe(false);
    expect(db.prepare(`SELECT key_class, role FROM agents WHERE id = ?`).get(agent.agentId)).toEqual({ key_class: "agent", role: "operator" });

    // Rotate it with the key itself (operator tier clears the owner-only bar via roleFor).
    const rotated = await api(`/v1/org/agents/${agent.agentId}/rotate-key`, {
      method: "POST",
      headers: { authorization: `Bearer ${agent.apiKey}` },
      workspace: workspace.orgId,
      body: "{}",
    });
    expect(rotated.status).toBe(200);
    const newKey = ((await rotated.json()) as { apiKey: string }).apiKey;
    expect(newKey).not.toBe(agent.apiKey);
    // The old key is dead immediately; the new one works.
    expect(authenticateAgentKey(agent.apiKey)).toBeNull();
    expect(authenticateAgentKey(newKey)).not.toBeNull();
  });

  it("the retired signup flag cannot restore the waitlist gate", async () => {
    process.env.OPENCADRE_SIGNUP = "waitlist";
    const { cookie } = await signIn(user("u-ss3", "ss3@example.com", "Self Serve Three"));
    const res = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Direct Co" }) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent?: { agentId: string } };
    expect(body.agent?.agentId).toBeTruthy();
  });
  it("open mode still requires a verified email over HTTP, but the domain rule does not", async () => {
    // The inbox-proof requirement is an HTTP-auth concern (0283's review of #324), so it lives in the
    // route. Over HTTP, an unverified sign-in is refused and told why.
    process.env.OPENCADRE_SIGNUP = "open";
    const { cookie } = await signIn(user("u-ss4", "ss4@example.com", "Self Serve Four"));
    db.prepare(`UPDATE people SET email_verified = 0 WHERE id = ?`).run("u-ss4");
    const res = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Unverified Co" }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("E_EMAIL_UNVERIFIED");

    // And the domain function is deliberately permissive for direct callers, which is what keeps the
    // isolation and stamping suites (fixtures with email: null) working. This is the distinction the
    // review asked for: entitlement vs proof-of-inbox.
    const direct = accounts.upsertPerson({ id: "u-ss4-direct", email: null, emailVerified: false, name: "Direct", avatarUrl: null } as Parameters<typeof accounts.upsertPerson>[0]);
    expect(accounts.canCreateWorkspace(direct)).toBe(true);
    expect(accounts.workspaceCreationRefusal(direct)).toBeNull();
    expect(accounts.unverifiedEmailRefusal(direct)).not.toBeNull(); // the route half still refuses it
  });

  it("tenant isolation: the first key cannot read or act in another workspace", async () => {
    process.env.OPENCADRE_SIGNUP = "open";
    const a = await firstKey(user("u-ss6a", "ss6a@example.com", "Iso A"), "Self Iso A");
    const b = await firstKey(user("u-ss6b", "ss6b@example.com", "Iso B"), "Self Iso B");
    // Same key, other workspace's members list: 404 (requireWorkspaceMatch does not leak existence).
    expect((await api(`/v1/workspaces/${b.orgId}/members`, { headers: { authorization: `Bearer ${a.apiKey}` }, workspace: b.orgId })).status).toBe(404);
    // And it cannot rotate the other org's key.
    expect((await api(`/v1/org/agents/${b.agentId}/rotate-key`, { method: "POST", headers: { authorization: `Bearer ${a.apiKey}` }, workspace: b.orgId, body: "{}" })).status).toBe(404);
  });

  it("mints nothing when the workspace name is invalid", async () => {
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM organizations`).get() as { n: number }).n;
    const { cookie } = await signIn(user("u-ss7", "ss7@example.com", "No Orphan"));
    const res = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: " " }) });
    expect(res.status).toBe(400);
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM organizations`).get() as { n: number }).n;
    expect(after).toBe(before);
  });
  it("double-submit of the same workspace name mints one workspace and one key", async () => {
    process.env.OPENCADRE_SIGNUP = "open";
    const { cookie } = await signIn(user("u-ss8", "ss8@example.com", "Double Submit"));
    const first = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Once Co" }) });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { workspace: { orgId: string }; agent?: { apiKey: string } };
    expect(firstBody.agent?.apiKey).toMatch(/^agt_/);

    const second = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Once Co" }) });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { workspace: { orgId: string; existing?: boolean }; agent?: unknown };
    // Exactly one workspace exists, and the re-submit returns THAT one.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE name = ?`).get("Once Co")).toEqual({ n: 1 });
    expect(secondBody.workspace.orgId).toBe(firstBody.workspace.orgId);
    expect(secondBody.workspace.existing).toBe(true);
    // And critically: no second credential is silently minted. Exactly one First Agent row exists.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND name = ?`).get(firstBody.workspace.orgId, "First Agent")).toEqual({ n: 1 });
    expect(secondBody.agent).toBeUndefined();
  });

  it("a different person naming their workspace the same thing gets their own, not the existing one", async () => {
    // The guard is scoped to the person: two people may both call their workspace "Acme".
    const a = await firstKey(user("u-ss8b", "ss8b@example.com", "Same Name A"), "Acme");
    const b = await firstKey(user("u-ss8c", "ss8c@example.com", "Same Name B"), "Acme");
    expect(b.orgId).not.toBe(a.orgId);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE name = ?`).get("Acme")).toEqual({ n: 2 });
  });

  it("deploy survival: a restart keeps the account, session, workspace and key; limiter state is not promised", async () => {
    process.env.OPENCADRE_SIGNUP = "open";
    const { cookie } = await signIn(user("u-ss9", "ss9@example.com", "Survivor"));
    const created = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Deploy Co" }) });
    const { workspace, agent } = (await created.json()) as { workspace: { orgId: string }; agent: { agentId: string; apiKey: string } };

    // Everything durable lives in the database, so it is readable after a "restart" — which for this
    // suite means re-reading through fresh connections rather than any in-process cache.
    expect(accounts.getPerson("u-ss9")).toBeTruthy();
    expect(accounts.sessionPerson(cookieValue([cookie], "oc_session"))).toBeTruthy();
    expect(accounts.getMembership(workspace.orgId, "u-ss9")?.role).toBe("owner");
    expect(authenticateAgentKey(agent.apiKey)).toEqual(expect.objectContaining({ orgId: workspace.orgId, agentId: agent.agentId }));

    // The limiter is in-memory by design (src/ratelimit.ts:7), so a restart resets its window. Assert
    // that explicitly, so the behaviour is documented by a test instead of pinned as a guarantee.
    const { createRateLimiter } = await import("../src/ratelimit.js");
    const fresh = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(fresh.check("k").ok).toBe(true);
    expect(fresh.check("k").ok).toBe(false);
    expect(createRateLimiter({ limit: 1, windowMs: 60_000 }).check("k").ok).toBe(true); // a new process starts clean
  });
});

/** The sign-up kill switch, `OPENCADRE_SIGNUP=closed` (src/accounts.ts `signupMode`). 165c7850 made sign-up
 * open for every verified person and removed the flag; this restores ONLY the operator's off switch. So the
 * arms below prove three things at once: `closed` refuses a NEW workspace and mints nothing; unset and `open`
 * still create (the open default 165c7850 decided is untouched); and everything a person who ALREADY has a
 * workspace does -- sign in, list workspaces, use one, accept an invite -- is unaffected. */
describe("the sign-up kill switch", () => {
  const counts = () => ({
    orgs: (db.prepare(`SELECT COUNT(*) AS n FROM organizations`).get() as { n: number }).n,
    agents: (db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }).n,
  });

  it("closed: refuses a new workspace with 403 E_SIGNUP_CLOSED, and creates and mints nothing", async () => {
    process.env.OPENCADRE_SIGNUP = "closed";
    const { cookie } = await signIn(user("u-ks1", "ks1@example.com", "Kill Switch One"));
    const before = counts();
    const res = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Closed Co" }) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; error?: string; agent?: unknown };
    expect(body.code).toBe(accounts.SIGNUP_CLOSED);
    expect(body.error).toMatch(/can't be created/);
    expect(body.agent).toBeUndefined();
    // The row counts, not just the status: a refusal that still wrote a workspace or a key would be the
    // failure that matters, and a 403 alone could not show it.
    expect(counts()).toEqual(before);
  });

  it("closed is read trimmed and case-insensitively, so a hand-edited .env line still takes", async () => {
    process.env.OPENCADRE_SIGNUP = "  Closed ";
    const { cookie } = await signIn(user("u-ks2", "ks2@example.com", "Kill Switch Two"));
    expect((await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Closed Two" }) })).status).toBe(403);
  });

  // An emergency switch fails closed (review of #633): an operator who mistyped `closed` during an incident
  // meant to shut the door, so an unknown non-empty value closes rather than silently leaving sign-up open.
  it("a mistyped value such as clsoed closes, and says so on /v1/auth/config", async () => {
    process.env.OPENCADRE_SIGNUP = "clsoed";
    const { cookie } = await signIn(user("u-ks3", "ks3@example.com", "Kill Switch Three"));
    expect((await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: "Closed Three" }) })).status).toBe(403);
    expect(((await (await api("/v1/auth/config")).json()) as { signup: string }).signup).toBe("closed");
  });

  for (const [i, [label, value]] of ([["unset", undefined], ["empty", "  "], ["open", "open"], ["the retired value waitlist", "waitlist"]] as const).entries()) {
    it(`${label}: creates a workspace and mints the first key`, async () => {
      if (value === undefined) delete process.env.OPENCADRE_SIGNUP;
      else process.env.OPENCADRE_SIGNUP = value;
      const { cookie } = await signIn(user(`u-ks-arm${i}`, `ks-arm${i}@example.com`, `Kill Switch ${label}`));
      const res = await api("/v1/workspaces", { method: "POST", cookie, body: JSON.stringify({ name: `Open Co ${label}` }) });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { agent?: { agentId: string } }).agent?.agentId).toBeTruthy();
    });
  }

  it("closed: reported on /v1/auth/config, so the operator can read the switch back and the site stops inviting sign-ups", async () => {
    resetMethodsCache();
    expect(((await (await api("/v1/auth/config")).json()) as { signup: string }).signup).toBe("open");
    process.env.OPENCADRE_SIGNUP = "closed";
    expect(((await (await api("/v1/auth/config")).json()) as { signup: string }).signup).toBe("closed");
  });

  it("closed: an existing owner still signs in, sees and uses their workspace, and can invite someone in", async () => {
    // Made while open -- the ordinary history of any workspace that exists when the switch is thrown.
    const owner = await ownerWorkspace(user("u-ks-own", "ks-own@example.com", "Kill Switch Owner"), "Existing Co");
    const token = await invite(owner, { role: "member" });
    process.env.OPENCADRE_SIGNUP = "closed";

    // A FRESH sign-in, not the cookie from before the switch: sign-in itself must be unaffected.
    const again = await signIn(user("u-ks-own", "ks-own@example.com", "Kill Switch Owner"));
    expect(again.cookie).not.toBe("");
    const me = (await (await api("/v1/auth/me", { cookie: again.cookie })).json()) as {
      workspaces: Array<{ orgId: string }>;
      canCreateWorkspace: boolean;
    };
    expect(me.workspaces.map((w) => w.orgId)).toContain(owner.orgId);
    // What makes the console hide its create form instead of offering one that will 403.
    expect(me.canCreateWorkspace).toBe(false);
    expect((await api(`/v1/workspaces/${owner.orgId}/members`, { cookie: again.cookie, workspace: owner.orgId })).status).toBe(200);

    // Joining an EXISTING workspace is not sign-up, so an invite still lands.
    const guest = await signIn(user("u-ks-guest", "ks-guest@example.com", "Kill Switch Guest"));
    expect((await api(`/v1/invites/${token}/accept`, { method: "POST", cookie: guest.cookie, body: "{}" })).status).toBe(200);
  });
});
