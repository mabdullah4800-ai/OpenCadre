import { createHash, createPublicKey, randomBytes, verify, type KeyObject, type webcrypto } from "node:crypto";
type JsonWebKey = webcrypto.JsonWebKey;

/** Server-side Supabase Auth (docs/design/ACCOUNTS.md). The hub runs the PKCE flow itself and verifies the
 * resulting access token against the project's JWKS, so no Supabase token or JS ever reaches the browser.
 * Zero dependencies: ES256 verification uses node:crypto. */

export const OAUTH_PROVIDERS = ["github", "google"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface SupabaseAuthConfig {
  /** e.g. https://<ref>.supabase.co */
  url: string;
  /** The project's publishable (anon) key: public by design, sent as the apikey header. */
  publishableKey: string;
}

/** Null when sign-in isn't configured on this hub, so people routes answer 503 instead of failing oddly. */
export function supabaseAuthConfig(): SupabaseAuthConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  return url && publishableKey ? { url, publishableKey } : null;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function authorizeUrl(cfg: SupabaseAuthConfig, provider: OAuthProvider, redirectTo: string, challenge: string): string {
  const params = new URLSearchParams({ provider, redirect_to: redirectTo, code_challenge: challenge, code_challenge_method: "s256" });
  return `${cfg.url}/auth/v1/authorize?${params}`;
}

const headers = (cfg: SupabaseAuthConfig) => ({ apikey: cfg.publishableKey, "content-type": "application/json" });
const TIMEOUT_MS = 10_000;

/** Emails a sign-in link; the link lands on the same callback as OAuth. Throws with Supabase's message on failure. */
export async function sendMagicLink(cfg: SupabaseAuthConfig, email: string, redirectTo: string, challenge: string): Promise<void> {
  const res = await fetch(`${cfg.url}/auth/v1/otp?${new URLSearchParams({ redirect_to: redirectTo })}`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ email, create_user: true, code_challenge: challenge, code_challenge_method: "s256" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(await supabaseError(res));
}

/** Which sign-in methods the project has turned on (Authentication → Providers). */
export async function enabledMethods(cfg: SupabaseAuthConfig): Promise<{ github: boolean; google: boolean; email: boolean }> {
  const res = await fetch(`${cfg.url}/auth/v1/settings`, { headers: headers(cfg), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(await supabaseError(res));
  const external = ((await res.json()) as { external?: Record<string, boolean> }).external ?? {};
  return { github: Boolean(external.github), google: Boolean(external.google), email: Boolean(external.email) };
}

export interface VerifiedIdentity {
  id: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

/** Trades the one-time code for tokens, verifies the access token, and returns who signed in. The tokens
 * themselves are discarded: the hub issues its own session. */
export async function exchangeCode(cfg: SupabaseAuthConfig, code: string, verifier: string): Promise<VerifiedIdentity> {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(await supabaseError(res));
  const body = (await res.json()) as {
    access_token?: string;
    user?: { id?: string; email?: string; email_confirmed_at?: string | null; user_metadata?: Record<string, unknown> };
  };
  if (typeof body.access_token !== "string") throw new Error("Supabase returned no access token");
  const claims = await verifyAccessToken(cfg, body.access_token);
  if (!body.user || body.user.id !== claims.sub) throw new Error("the token and the user don't match");
  const meta = body.user.user_metadata ?? {};
  const pick = (...keys: string[]) => keys.map((k) => meta[k]).find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim() ?? null;
  return {
    id: claims.sub,
    email: body.user.email?.toLowerCase() ?? null,
    emailVerified: Boolean(body.user.email_confirmed_at),
    name: pick("full_name", "name", "user_name", "preferred_username"),
    avatarUrl: pick("avatar_url", "picture"),
  };
}

// --- JWT verification -----------------------------------------------------------

interface Claims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
}

const JWKS_TTL_MS = 10 * 60_000;
let jwksCache: { url: string; fetchedAt: number; keys: Map<string, KeyObject> } | null = null;

async function signingKey(cfg: SupabaseAuthConfig, kid: string): Promise<KeyObject | undefined> {
  const fresh = jwksCache && jwksCache.url === cfg.url && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  // An unknown kid after a key rotation gets one refetch, never more per call.
  if (!fresh || !jwksCache!.keys.has(kid)) {
    const res = await fetch(`${cfg.url}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`couldn't fetch signing keys (HTTP ${res.status})`);
    const { keys = [] } = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const map = new Map<string, KeyObject>();
    for (const jwk of keys) {
      if (jwk.kid && jwk.kty === "EC" && jwk.crv === "P-256") map.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
    jwksCache = { url: cfg.url, fetchedAt: Date.now(), keys: map };
  }
  return jwksCache!.keys.get(kid);
}

/** Verifies an ES256 access token issued by this project: signature, issuer, audience, expiry. */
export async function verifyAccessToken(cfg: SupabaseAuthConfig, token: string, nowMs = Date.now()): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: string; kid?: string };
  let claims: Partial<Claims>;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed token");
  }
  // Only the asymmetric algorithm the project publishes: never "none", never HS256 with a guessable secret.
  if (header.alg !== "ES256" || !header.kid) throw new Error("unexpected token algorithm");
  const key = await signingKey(cfg, header.kid);
  if (!key) throw new Error("unknown signing key");
  const valid = verify("sha256", Buffer.from(`${headerB64}.${payloadB64}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signatureB64, "base64url"));
  if (!valid) throw new Error("bad token signature");
  if (claims.iss !== `${cfg.url}/auth/v1`) throw new Error("token from another issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes("authenticated")) throw new Error("token for another audience");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) throw new Error("token expired");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("token without a subject");
  return claims as Claims;
}

/** For tests only. */
export function resetJwksCache(): void {
  jwksCache = null;
}

async function supabaseError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { msg?: string; message?: string; error_description?: string; error?: string };
  return body.msg || body.error_description || body.message || body.error || `Supabase answered HTTP ${res.status}`;
}
