import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/** Outbound webhook safety (SSRF). Agents choose their own webhook URL and the hub POSTs to it from inside
 * its host, which also runs other services on loopback and can reach the cloud metadata endpoint
 * (169.254.169.254). So a webhook may only reach a public address:
 * - https only, no credentials in the URL, no redirects followed;
 * - every address is checked when the connection is made (the lookup hook), not just when the URL is
 *   registered, so a DNS name can't pass the check and then resolve to an internal address.
 * OPENCADRE_WEBHOOK_ALLOW_PRIVATE=1 lifts the address and https rules for local development and tests only.
 * It is ignored when NODE_ENV=production (the Docker image), so a copied env file can't switch the guard off. */

export const privateWebhooksRequested = () => process.env.OPENCADRE_WEBHOOK_ALLOW_PRIVATE === "1";
const allowPrivate = () => privateWebhooksRequested() && process.env.NODE_ENV !== "production";
/** True only in local development and tests (see above). Web Push uses it to lift its push-service host allowlist too. */
export const privateTargetsAllowed = allowPrivate;

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ["192.88.99.0", 24], // 6to4 relay anycast: a tunnel entry, never a public service
];

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expands an IPv6 address to 8 groups of 16-bit numbers (embedded dotted IPv4 supported). */
export function ipv6Groups(ip: string): number[] {
  let addr = ip.toLowerCase().split("%")[0];
  const dotted = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v = ipv4ToInt(dotted[1]);
    addr = addr.slice(0, -dotted[1].length) + `${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const middle = addr.includes("::") ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...middle, ...t].map((g) => parseInt(g || "0", 16));
}

function isBlockedV6(ip: string): boolean {
  const g = ipv6Groups(ip);
  const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  // ::/96 holds ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d, which a host with a 6-in-4 tunnel still routes to
  // that IPv4 address; nothing public is ever served from it, so the whole block is refused.
  if (g.slice(0, 6).every((x) => x === 0)) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedV4(embeddedV4()); // ::ffff:a.b.c.d
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return isBlockedV4(embeddedV4()); // ::ffff:0:a.b.c.d (RFC 2765)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedV4(embeddedV4()); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64 (RFC 8215): our side's translator
  if (g[0] === 0x2002) return isBlockedV4(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4 2002:a.b.c.d::/48
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo 2001::/32: a tunnel whose far end is an IPv4 host
  if (g[0] === 0x2001 && ((g[1] & 0xfff0) === 0x10 || (g[1] & 0xfff0) === 0x20)) return true; // ORCHID(v2) 2001:10::/28, 2001:20::/28
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard-only
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !isBlockedV4(ip);
  if (family === 6) return !isBlockedV6(ip);
  return false;
}

/** Checked when a webhook is registered, so an agent learns at once that a URL can never work. */
export function validateWebhookUrl(raw: string): { ok: true } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "webhook url is not a valid URL" };
  }
  if (allowPrivate()) return ["http:", "https:"].includes(url.protocol) ? { ok: true } : { ok: false, error: "webhook url must use https" };
  if (url.protocol !== "https:") return { ok: false, error: "webhook url must use https" };
  if (url.username || url.password) return { ok: false, error: "webhook url must not contain credentials; use authHeader" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return { ok: false, error: "webhook url must point to a public host" };
  }
  if (isIP(host) && !isPublicAddress(host)) return { ok: false, error: "webhook url must point to a public address" };
  return { ok: true };
}

export const MAX_WEBHOOK_AUTH_HEADER = 2048;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** The Authorization header sent with each webhook, checked when it is set (by the agent, POST /v1/webhook, or by a
 * person, PUT /v1/org/agents/:agentId/webhook): one header line, since a CR or LF would split it into a second header,
 * and no trigger key needs more than this. */
export function validateWebhookAuthHeader(raw: string): { ok: true } | { ok: false; error: string } {
  if (CONTROL_CHARACTER.test(raw) || raw.length > MAX_WEBHOOK_AUTH_HEADER) {
    return { ok: false, error: `authHeader must be one line with no control characters, at most ${MAX_WEBHOOK_AUTH_HEADER} characters` };
  }
  return { ok: true };
}

/** A dns.lookup replacement that refuses to hand a non-public address to the socket. */
function guardedLookup(hostname: string, options: unknown, callback: (...args: unknown[]) => void): void {
  dnsLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    const allowed = allowPrivate() ? addresses : addresses.filter((a) => isPublicAddress(a.address));
    if (allowed.length === 0) {
      return callback(Object.assign(new Error(`webhook host ${hostname} resolves only to non-public addresses`), { code: "EWEBHOOKBLOCKED" }));
    }
    const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    if (wantsAll) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
}

/** POSTs a body (JSON, or Web Push ciphertext) to a webhook or push endpoint through the guard. Resolves to the HTTP status; rejects on a blocked address,
 * a network error or the timeout. Redirects are not followed (a 3xx is returned as-is). */
export function postWebhook(rawUrl: string, headers: Record<string, string>, body: string | Buffer, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const check = validateWebhookUrl(rawUrl);
    if (!check.ok) return reject(new Error(check.error));
    const url = new URL(rawUrl);
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
        lookup: guardedLookup as never,
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    // A literal IP skips DNS lookup entirely, so check it here too.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !allowPrivate() && !isPublicAddress(host)) {
      request.destroy();
      return reject(new Error("webhook url must point to a public address"));
    }
    request.on("timeout", () => request.destroy(new Error(`webhook timed out after ${timeoutMs} ms`)));
    request.on("error", reject);
    request.end(body);
  });
}
