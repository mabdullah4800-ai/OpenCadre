import type { AddressInfo } from "node:net";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { withRequestLog } from "../src/http-log.js";
import { redact, setLogSink } from "../src/log.js";
import { approveConsent, createConsent } from "../src/oauth-authorize.js";
import { mcpResource, verifyAccessToken } from "../src/oauth.js";
import { dcrClient, person, workspace } from "./helpers/oauth-fixtures.js";

// POST /oauth/revoke (RFC 7009; plan 2026-09-29 §5 Task 6 and §7.4: revoke ONLY the presented token's family) and the
// log redaction of the connector's credentials (design §4 "Token values never logged").

let server: http.Server;
let base: string;
beforeAll(async () => {
  // Wrapped in the hub's request log, as src/index.ts does, so the redaction test reads what production writes.
  server = http.createServer(withRequestLog(app));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { process.env.OPENCADRE_OAUTH = "on"; });
afterEach(() => { delete process.env.OPENCADRE_OAUTH; });

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
let ipCounter = 0;
const nextIp = () => `198.20.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;
const send = (path: string, fields: Record<string, string>, { json = false, ip = nextIp() } = {}) => fetch(`${base}${path}`, {
  method: "POST",
  body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
  headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded", "x-forwarded-for": ip },
});
type Tokens = { access_token: string; refresh_token: string };

/** One connector (person, client, workspace) and a helper that runs a full approve + code exchange for it, so a second
 * call is a second token FAMILY on the same connector agent (plan §7.2 reuses the agent). */
function connector() {
  const personId = person();
  const orgId = workspace(personId);
  const clientId = dcrClient("Claude", [CALLBACK]);
  const connect = async (): Promise<Tokens & { agentId: string; code: string; verifier: string }> => {
    const verifier = randomBytes(32).toString("base64url");
    const consentId = createConsent({
      personId, clientId, redirectUri: CALLBACK, resource: mcpResource(), codeChallenge: createHash("sha256").update(verifier).digest("base64url"), state: "s",
    });
    const approved = approveConsent({ consentId, personId, orgId, connectionName: "Claude-rv01" });
    if (!approved.ok) throw new Error(approved.message);
    const res = await send("/oauth/token", {
      grant_type: "authorization_code", code: approved.code, redirect_uri: CALLBACK, code_verifier: verifier, client_id: clientId, resource: mcpResource(),
    });
    expect(res.status).toBe(200);
    return { ...((await res.json()) as Tokens), agentId: approved.agentId, code: approved.code, verifier };
  };
  return { personId, orgId, clientId, connect };
}
const works = (t: Tokens) => verifyAccessToken(t.access_token, mcpResource()) !== null;

describe("POST /oauth/revoke", () => {
  it("is 404 while dormant", async () => {
    delete process.env.OPENCADRE_OAUTH;
    expect((await send("/oauth/revoke", { token: "oca_x" })).status).toBe(404);
  });

  it("revoking an access token ends ITS family only: another family on the same connector keeps working", async () => {
    const c = connector();
    const first = await c.connect();
    const second = await c.connect();
    expect(second.agentId, "one connector agent, two families").toBe(first.agentId);
    const res = await send("/oauth/revoke", { token: first.access_token, token_type_hint: "access_token", client_id: c.clientId });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(works(first)).toBe(false);
    expect((await send("/oauth/token", { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.clientId })).status, "its refresh token too").toBe(400);
    expect(works(second), "the other family survives").toBe(true);
    expect((await send("/oauth/token", { grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: c.clientId })).status).toBe(200);
  });

  it("revoking a refresh token (JSON, no hint) ends its family, access token included", async () => {
    const c = connector();
    const t = await c.connect();
    expect((await send("/oauth/revoke", { token: t.refresh_token, client_id: c.clientId }, { json: true })).status).toBe(200);
    expect(works(t)).toBe(false);
  });

  it("answers 200 for a token it does not know, and for one already revoked (RFC 7009 §2.2)", async () => {
    const c = connector();
    const t = await c.connect();
    for (const token of ["oca_" + "0".repeat(48), "ocr_nope", "not-a-token", t.access_token, t.access_token]) {
      expect((await send("/oauth/revoke", { token, client_id: c.clientId })).status, token).toBe(200);
    }
  });

  it("a client_id that is not the token's client revokes nothing (still 200)", async () => {
    const c = connector();
    const t = await c.connect();
    expect((await send("/oauth/revoke", { token: t.access_token, client_id: "dcr_someone_else" })).status).toBe(200);
    expect(works(t)).toBe(true);
    expect((await send("/oauth/revoke", { token: t.access_token })).status, "a public client may omit client_id").toBe(200);
    expect(works(t)).toBe(false);
  });

  it("refuses a request with no token, or a body it cannot read, in the RFC 6749 shape", async () => {
    const missing = await send("/oauth/revoke", { client_id: "x" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "invalid_request" });
    const broken = await fetch(`${base}/oauth/revoke`, { method: "POST", body: "{nope", headers: { "content-type": "application/json", "x-forwarded-for": nextIp() } });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: "invalid_request" });
  });

  it("is rate-limited per network", async () => {
    const ip = nextIp();
    const limit = Number(process.env.OPENCADRE_OAUTH_REVOKE_PER_MIN) || 60;
    for (let i = 0; i < limit; i++) expect((await send("/oauth/revoke", { token: "x" }, { ip })).status).toBe(200);
    const limited = await send("/oauth/revoke", { token: "x" }, { ip });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    expect((await send("/oauth/revoke", { token: "x" }, { ip: nextIp() })).status).toBe(200);
  });
});

describe("redaction (design §4: token values never logged)", () => {
  it("masks connector tokens anywhere in a string, a cut-short one included, and drops credential-named fields", () => {
    const access = `oca_${"a1".repeat(24)}`;
    const refresh = `ocr_${"b2".repeat(24)}`;
    const text = JSON.stringify(redact(`exchanged ${access} and ${refresh}, then oca_1234abcd9 was cut`));
    for (const secret of [access, refresh, "oca_1234abcd9"]) expect(text).not.toContain(secret);
    const fields = redact({
      code: "c0de", code_verifier: "v3rifier", access_token: "at", refresh_token: "rt", csrf: "cs", consent: "cn", client_secret: "sh",
      client_id: "dcr_visible",
    }) as Record<string, string>;
    expect(fields).toEqual({
      code: "[redacted]", code_verifier: "[redacted]", access_token: "[redacted]", refresh_token: "[redacted]", csrf: "[redacted]",
      consent: "[redacted]", client_secret: "[redacted]", client_id: "dcr_visible",
    });
  });

  it("a full connect, refresh and revoke through the request log writes no token, code or verifier", async () => {
    const lines: string[] = [];
    process.env.OPENCADRE_LOG_LEVEL = "debug";
    const restore = setLogSink((line) => lines.push(line));
    try {
      const c = connector();
      const t = await c.connect();
      const refreshed = (await (await send("/oauth/token", { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.clientId })).json()) as Tokens;
      await send("/oauth/token", { grant_type: "authorization_code", code: t.code, redirect_uri: CALLBACK, code_verifier: t.verifier, client_id: c.clientId, resource: mcpResource() });
      await send("/oauth/revoke", { token: refreshed.access_token });
      expect(lines.some((l) => l.includes("/oauth/token")), "the request log did run").toBe(true);
      const all = lines.join("\n");
      for (const secret of [t.access_token, t.refresh_token, refreshed.access_token, refreshed.refresh_token, t.code, t.verifier]) {
        expect(all).not.toContain(secret);
      }
      expect(all).not.toMatch(/\boc[ar]_[A-Za-z0-9]{8,}/);
    } finally {
      restore();
      delete process.env.OPENCADRE_LOG_LEVEL;
    }
  });
});
