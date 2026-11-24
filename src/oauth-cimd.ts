import { promises as dnsPromises } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";
import { log } from "./log.js";
import { acceptableRedirectUri, clientNameFrom, MAX_REDIRECT_URIS } from "./oauth.js";
import { createRateLimiter } from "./ratelimit.js";
import { isPublicAddress } from "./webhook-guard.js";

/**
 * Client ID Metadata Documents (docs/design/MCP-CONNECTOR.md §3 "Client identity", §4). A CIMD client's `client_id` is
 * an https URL, and the hub fetches that URL to learn the client's name and redirect URIs. ChatGPT uses it
 * (`https://chatgpt.com/oauth/client.json`), and Claude does once the metadata advertises it.
 *
 * The fetch is an SSRF surface: whoever starts an authorization names the URL, and the hub fetches it from inside its
 * host, which runs other services on loopback and can reach the cloud metadata endpoint. So (design §4, Codex-OpenCadre-
 * f46c on 6d5e407, and the Sonnet security review of 2026-09-29): https on the default port only; the host is resolved
 * ONCE, through c-ares with its own short timeout (never dns.lookup, whose libuv pool thread a blackholed nameserver
 * would hold past our deadline), and EVERY answer must be public (webhook-guard's classification); the connection goes
 * to a validated address with the original hostname as TLS SNI and Host header, so a second DNS answer cannot move it
 * (no rebinding); the answers are tried in order, so a dual-stack host whose IPv6 is unreachable still works; no
 * redirects; one deadline over resolve, connect and read; a 64 KB cap; the document must name itself. Resolver and
 * transport are injectable so tests need no network.
 *
 * Failures reach the caller as ONE generic message, so the authorize page is no oracle for what a name resolves to or
 * how a host answered; the reason goes to the hub's own log (the URL and a short reason, never the document).
 */

export const CIMD_TIMEOUT_MS = 5_000;
/** Per DNS query (A and AAAA run in parallel), one try: well inside the overall deadline. */
export const CIMD_DNS_TIMEOUT_MS = 2_000;
/** How long one address may take to answer while another validated address is still left to try. */
export const CIMD_ATTEMPT_TIMEOUT_MS = 2_000;
export const CIMD_MAX_BYTES = 64 * 1024;
/** Short, so a client that changes its redirect URIs is picked up within minutes (design §4 "a short TTL"). */
export const CIMD_CACHE_TTL_MS = 5 * 60_000;
/** A failure is remembered briefly, so repeating an authorize request cannot turn the hub into a fetch amplifier. */
export const CIMD_NEGATIVE_TTL_MS = 30_000;
/** The URL is attacker-chosen, so the cache is bounded; the oldest entry goes first. */
export const CIMD_CACHE_MAX_ENTRIES = 500;
export const CIMD_FETCH_ERROR = "could not fetch the client metadata document";
export const CIMD_RATE_LIMITED = "too many client metadata fetches from this network; try again in a minute";

/** Per network, for the authorize step (plan Task 4): only a fetch that actually goes out counts -- a cache hit or a
 * request that joins one already in flight does not. Keyed by the caller's IP (oauthIpKey), never by a bearer string. */
export const cimdFetchLimiter = createRateLimiter({ limit: Number(process.env.OPENCADRE_OAUTH_CIMD_FETCH_PER_MIN) || 10, windowMs: 60_000 });

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type CimdResolver = (hostname: string) => Promise<ResolvedAddress[]>;
/** What the transport is told: WHERE to connect (the validated address) and WHO to say it is talking to. */
export interface CimdTarget {
  address: string;
  family: 4 | 6;
  hostname: string;
  hostHeader: string;
  port: number;
  path: string;
  signal: AbortSignal;
}
export interface CimdResponse { status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array> }
export type CimdTransport = (target: CimdTarget) => Promise<CimdResponse>;
export interface CimdDeps {
  resolve?: CimdResolver;
  transport?: CimdTransport;
  now?: () => number;
  /** The caller's network (oauthIpKey(req.ip)); when given, a fetch that would go out is checked against cimdFetchLimiter. */
  rateLimitKey?: string;
}

export type CimdResult = { ok: true; clientId: string; clientName: string; redirectUris: string[] } | { ok: false; error: string };

/** A client_id is a metadata document URL exactly when it is an https URL; anything else is a DCR id (design §3). */
export const isCimdClientId = (clientId: string): boolean => typeof clientId === "string" && clientId.startsWith("https://");

// --- Resolution ---------------------------------------------------------------------------------------------------------
/** The two queries a resolver needs (dns.promises.Resolver has them); a test passes a fake. */
export interface DnsQueries { resolve4(hostname: string): Promise<string[]>; resolve6(hostname: string): Promise<string[]> }
export const DNS_RESOLVER_OPTIONS = { timeout: CIMD_DNS_TIMEOUT_MS, tries: 1 } as const;

/** A and AAAA in parallel, IPv4 first (the hub's own route is IPv4; IPv6 is tried after). One family failing is fine
 * while the other answers; both failing is a failure. */
export function dnsResolver(dns: DnsQueries): CimdResolver {
  return async (hostname) => {
    const [v4, v6] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
    const answers: ResolvedAddress[] = [
      ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 as const })) : []),
      ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 as const })) : []),
    ];
    if (answers.length === 0) throw v4.status === "rejected" ? v4.reason : new Error(`${hostname} has no address`);
    return answers;
  };
}

let systemResolver: CimdResolver | undefined;
const defaultResolver: CimdResolver = (hostname) =>
  (systemResolver ??= dnsResolver(new dnsPromises.Resolver(DNS_RESOLVER_OPTIONS)))(hostname);

// --- Transport ----------------------------------------------------------------------------------------------------------
const refuseLookup = () => {
  throw new Error("the CIMD transport connects to a validated address and never looks a name up");
};

/** Only a test passes `ca` (a local certificate authority), to prove the certificate is checked against the hostname. */
export interface TransportOptions { ca?: string | Buffer }

/** The real request: connect to the validated ADDRESS; say the hostname in SNI (so the certificate is checked against it)
 * and in Host. `lookup` throws, so if `host` ever became a name again the request fails instead of resolving a second
 * time. No agent, so no pooled socket is reused across hosts. Exported so a test can read the options it builds. */
export function httpsRequestOptions(target: CimdTarget, extra: TransportOptions = {}): https.RequestOptions {
  return {
    host: target.address,
    family: target.family,
    port: target.port,
    path: target.path,
    method: "GET",
    servername: target.hostname,
    headers: { host: target.hostHeader, accept: "application/json", "user-agent": "OpenCadre-Hub (client metadata)" },
    agent: false,
    rejectUnauthorized: true,
    signal: target.signal,
    lookup: refuseLookup as never,
    ...(extra.ca ? { ca: extra.ca } : {}),
  };
}

/** Node's https client does not follow redirects, so a 3xx comes back as-is and the caller refuses it. */
export function createHttpsTransport(extra: TransportOptions = {}): CimdTransport {
  return (target) =>
    new Promise((resolve, reject) => {
      const request = https.request(httpsRequestOptions(target, extra), (response) =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }));
      request.on("error", reject);
      request.end();
    });
}
export const httpsTransport: CimdTransport = createHttpsTransport();

// --- The URL and the document -------------------------------------------------------------------------------------------
type ParsedClientId = { ok: true; url: URL } | { ok: false; error: string };

/** The URL rules (draft-ietf-oauth-client-id-metadata-document §3, plus ours). Canonical form is required: the URL we
 * fetch, the one the document must name, and the one a person sees are then the same string, so no parser difference
 * (case, a default port, dot segments, stripped whitespace) can separate them. Refused as well: any explicit port (only
 * 443, so the fetch cannot be aimed at another service on a public host), an IP-literal host (TLS SNI cannot carry one,
 * and no real client publishes its document at a bare address) and a trailing-dot host (RFC 6066 forbids it in SNI, and
 * `chatgpt.com.` would be a second identity for `chatgpt.com`). */
function parseClientId(clientId: string): ParsedClientId {
  if (typeof clientId !== "string" || clientId.length > 2000) return { ok: false, error: "client_id is not a valid URL" };
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return { ok: false, error: "client_id is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "client_id must be an https URL" };
  if (url.username || url.password) return { ok: false, error: "client_id must not contain credentials" };
  if (clientId.includes("#")) return { ok: false, error: "client_id must not contain a fragment" };
  if (url.href !== clientId) return { ok: false, error: "client_id must be in canonical form" };
  if (url.port) return { ok: false, error: "client_id must use the default https port" };
  if (url.pathname === "/") return { ok: false, error: "client_id must contain a path" };
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) return { ok: false, error: "client_id must use a host name, not an address" };
  if (url.hostname.endsWith(".")) return { ok: false, error: "client_id must use a host name without a trailing dot" };
  return { ok: true, url };
}

/** Reads at most CIMD_MAX_BYTES; stops (and so releases the socket) as soon as the cap is passed. */
async function readCapped(response: CimdResponse): Promise<Buffer | null> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > CIMD_MAX_BYTES) return null;
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > CIMD_MAX_BYTES) return null;
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** The document's own problems are named (they are the client developer's to fix and reveal nothing about our
 * network); none of them echoes the host. */
function validateDocument(clientId: string, hostname: string, raw: Buffer): CimdResult {
  let doc: unknown;
  try {
    doc = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, error: "the client metadata document is not JSON" };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "the client metadata document is not a JSON object" };
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) return { ok: false, error: "the client metadata document's client_id does not match its URL" };
  // Only public clients exist here (the metadata advertises "none"). A document declaring another method, or publishing
  // a secret, expects the hub to verify a credential it never will, so it is refused rather than silently downgraded.
  if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== "none") {
    return { ok: false, error: "only public clients (token_endpoint_auth_method \"none\") are supported" };
  }
  if ("client_secret" in d) return { ok: false, error: "a client metadata document must not contain a client_secret" };
  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: `the client metadata document must list 1 to ${MAX_REDIRECT_URIS} redirect_uris` };
  }
  if (!uris.every((u) => typeof u === "string" && acceptableRedirectUri(u))) {
    return { ok: false, error: "every redirect_uri must be a canonical https or loopback http URI" };
  }
  const name = clientNameFrom(d.client_name);
  if (!name.ok) return name;
  return { ok: true, clientId, clientName: name.name ?? hostname, redirectUris: uris as string[] };
}

/** A fetch-stage failure: the detail is logged, the caller gets the generic message. */
class FetchFailure extends Error {}

/** Rejects when the signal aborts, so an attempt whose transport ignores its signal still ends on time. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new FetchFailure("aborted"));
    const onAbort = () => reject(new FetchFailure("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Tries each validated address in order under the overall signal. An address that errors (or, while another is left,
 * takes longer than CIMD_ATTEMPT_TIMEOUT_MS) is abandoned for the next; an HTTP answer of any status ends the search. */
async function connect(answers: ResolvedAddress[], url: URL, transport: CimdTransport, signal: AbortSignal): Promise<CimdResponse> {
  const failures: string[] = [];
  for (let i = 0; i < answers.length && !signal.aborted; i++) {
    const attempt = new AbortController();
    const relay = () => attempt.abort();
    signal.addEventListener("abort", relay, { once: true });
    const timer = i < answers.length - 1 ? setTimeout(relay, CIMD_ATTEMPT_TIMEOUT_MS) : undefined;
    try {
      const response = await untilAborted(transport({
        address: answers[i].address,
        family: answers[i].family,
        hostname: url.hostname,
        hostHeader: url.host,
        port: 443,
        path: `${url.pathname}${url.search}`,
        signal: attempt.signal,
      }), attempt.signal);
      clearTimeout(timer);
      return response; // the attempt stays tied to the overall signal, which ends the body read on every path
    } catch (err) {
      clearTimeout(timer);
      attempt.abort();
      signal.removeEventListener("abort", relay);
      failures.push(`${answers[i].address}: ${(err as { code?: string })?.code ?? (err as Error)?.message ?? "error"}`);
    }
  }
  throw new FetchFailure(signal.aborted ? "timed out" : `no address answered (${failures.join("; ")})`);
}

async function fetchAndValidate(url: URL, resolve: CimdResolver, transport: CimdTransport, signal: AbortSignal): Promise<CimdResult> {
  let answers: ResolvedAddress[];
  try {
    answers = await untilAborted(resolve(url.hostname), signal);
  } catch (err) {
    throw new FetchFailure(signal.aborted ? "timed out" : `did not resolve (${(err as { code?: string })?.code ?? "error"})`);
  }
  if (answers.length === 0) throw new FetchFailure("did not resolve");
  const refused = answers.filter((a) => !isPublicAddress(a.address));
  if (refused.length > 0) throw new FetchFailure(`resolves to a non-public address (${refused.map((a) => a.address).join(", ")})`);
  const response = await connect(answers, url, transport, signal);
  if (response.status >= 300 && response.status < 400) throw new FetchFailure(`answered ${response.status}; redirects are not followed`);
  if (response.status !== 200) throw new FetchFailure(`answered ${response.status}`);
  let body: Buffer | null;
  try {
    body = await untilAborted(readCapped(response), signal);
  } catch {
    throw new FetchFailure(signal.aborted ? "timed out" : "the body could not be read");
  }
  if (!body) throw new FetchFailure(`larger than ${CIMD_MAX_BYTES / 1024} KB`);
  return validateDocument(url.href, url.hostname, body);
}

/** For tests that reach the fetch through a route (tests/oauth-authorize-route.test.ts, the end-to-end test): the
 * resolver and transport used when the caller passes none. Never set outside tests. */
export const cimdRouteDefaults: { resolve?: CimdResolver; transport?: CimdTransport } = {};

/** One fetch under one deadline; never throws. */
async function fetchWithDeadline(url: URL, deps: CimdDeps): Promise<CimdResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CIMD_TIMEOUT_MS);
  try {
    return await fetchAndValidate(
      url, deps.resolve ?? cimdRouteDefaults.resolve ?? defaultResolver, deps.transport ?? cimdRouteDefaults.transport ?? httpsTransport, controller.signal,
    );
  } catch (err) {
    const reason = err instanceof FetchFailure ? err.message : "unexpected error";
    log.info("client metadata fetch failed", { clientId: url.href, reason: controller.signal.aborted ? `timed out after ${CIMD_TIMEOUT_MS / 1000} s` : reason });
    return { ok: false, error: CIMD_FETCH_ERROR };
  } finally {
    clearTimeout(timer);
    // Ends the request on every path (the deadline, a refused oversize body) so no socket outlives the answer.
    controller.abort();
  }
}

// --- Cache, in-flight sharing and the per-network limit -----------------------------------------------------------------
const cache = new Map<string, { expiresAt: number; result: CimdResult }>();
const inFlight = new Map<string, Promise<CimdResult>>();
/** For tests. */
export const clearCimdCache = (): void => {
  cache.clear();
  inFlight.clear();
};

/** Each caller gets its own copy, so one caller changing its redirect list cannot change another's or the cache's. */
const copyOf = (result: CimdResult): CimdResult => (result.ok ? { ...result, redirectUris: [...result.redirectUris] } : { ...result });

function remember(clientId: string, result: CimdResult, nowMs: number): void {
  cache.delete(clientId);
  while (cache.size >= CIMD_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(clientId, { expiresAt: nowMs + (result.ok ? CIMD_CACHE_TTL_MS : CIMD_NEGATIVE_TTL_MS), result });
}

/** The cached document for a client_id, or null; never fetches. */
export function peekClientMetadata(clientId: string, nowMs = Date.now()): (CimdResult & { ok: true }) | null {
  const hit = cache.get(clientId);
  if (!hit || hit.expiresAt <= nowMs || !hit.result.ok) return null;
  return copyOf(hit.result) as CimdResult & { ok: true };
}

/** The client a CIMD client_id names, or why it cannot be used. A success is cached by URL for CIMD_CACHE_TTL_MS and a
 * fetch failure for CIMD_NEGATIVE_TTL_MS; concurrent requests for one URL share one fetch; with a rateLimitKey, a fetch
 * that would go out is refused once that network has used its budget. A malformed URL is refused before any of this. */
export async function resolveClientMetadata(clientId: string, deps: CimdDeps = {}): Promise<CimdResult> {
  const parsed = parseClientId(clientId);
  if (!parsed.ok) return parsed;
  const now = deps.now ?? Date.now;
  const hit = cache.get(clientId);
  if (hit && hit.expiresAt > now()) return copyOf(hit.result);
  const pending = inFlight.get(clientId);
  if (pending) return copyOf(await pending);
  if (deps.rateLimitKey !== undefined && !cimdFetchLimiter.check(deps.rateLimitKey).ok) return { ok: false, error: CIMD_RATE_LIMITED };

  const fetching = fetchWithDeadline(parsed.url, deps)
    .then((result) => {
      remember(clientId, result, now());
      return result;
    })
    .finally(() => inFlight.delete(clientId));
  inFlight.set(clientId, fetching);
  return copyOf(await fetching);
}
