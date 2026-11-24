import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import https from "node:https";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CIMD_ATTEMPT_TIMEOUT_MS, CIMD_CACHE_MAX_ENTRIES, CIMD_CACHE_TTL_MS, CIMD_FETCH_ERROR, CIMD_MAX_BYTES, CIMD_NEGATIVE_TTL_MS,
  CIMD_RATE_LIMITED, CIMD_TIMEOUT_MS, DNS_RESOLVER_OPTIONS, clearCimdCache, createHttpsTransport, dnsResolver,
  httpsRequestOptions, httpsTransport, isCimdClientId, resolveClientMetadata, type CimdResolver, type CimdTarget,
  type CimdTransport,
} from "../src/oauth-cimd.js";
import { setLogSink } from "../src/log.js";

// Client ID Metadata Documents (docs/design/MCP-CONNECTOR.md §3 "Client identity", §4 CIMD bullet; plan §5 task 2; the
// Sonnet security review and the coordinator's rulings of 2026-09-29). The fetch is an SSRF surface: an outsider names
// the URL. The resolver and the transport are injected, so nothing here touches the network; the real transport is
// exercised only against TLS listeners on 127.0.0.1.

const CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const PUBLIC_V4 = "104.18.32.47";
const PUBLIC_V6 = "2606:4700::6812:202f";
const doc = (over: Record<string, unknown> = {}) => ({
  client_id: CLIENT_ID,
  client_name: "ChatGPT",
  redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  ...over,
});

const resolverOf = (...answers: Array<Array<{ address: string; family: 4 | 6 }>>) => {
  const fn = vi.fn<CimdResolver>();
  for (const a of answers) fn.mockResolvedValueOnce(a);
  return fn;
};
async function* chunks(...parts: Array<string | Buffer>) {
  for (const p of parts) yield typeof p === "string" ? Buffer.from(p) : p;
}
const transportOf = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn<CimdTransport>(async () => ({ status, headers, body: chunks(typeof body === "string" ? body : JSON.stringify(body)) }));
const publicResolver = () => resolverOf([{ address: PUBLIC_V4, family: 4 }]);

// The hub's own log carries the reason a fetch failed; the caller only ever sees CIMD_FETCH_ERROR.
let logLines: string[] = [];
let restoreLog: () => void = () => {};
beforeEach(() => {
  clearCimdCache();
  logLines = [];
  vi.stubEnv("OPENCADRE_LOG_LEVEL", "info");
  restoreLog = setLogSink((line) => logLines.push(line));
});
afterEach(() => {
  restoreLog();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const loggedReason = () => logLines.map((l) => JSON.parse(l) as { msg: string; reason?: string }).filter((l) => l.msg === "client metadata fetch failed").map((l) => l.reason).join(" | ");

/** A failure the caller sees: exactly the generic message, never the host. */
function expectGenericFailure(result: Awaited<ReturnType<typeof resolveClientMetadata>>) {
  expect(result).toEqual({ ok: false, error: CIMD_FETCH_ERROR });
  if (!result.ok) expect(result.error).not.toContain("chatgpt.com");
}

describe("the client_id URL", () => {
  it("is recognised as CIMD only when it is an https URL", () => {
    expect(isCimdClientId(CLIENT_ID)).toBe(true);
    expect(isCimdClientId("dcr_0123456789abcdef")).toBe(false);
    expect(isCimdClientId("http://chatgpt.com/oauth/client.json")).toBe(false);
  });

  it.each([
    ["http://chatgpt.com/oauth/client.json", "https"],
    ["https://chatgpt.com/", "path"],
    ["https://chatgpt.com/oauth/client.json#x", "fragment"],
    ["https://user:pw@chatgpt.com/oauth/client.json", "credentials"],
    ["https://chatgpt.com/oauth/../client.json", "canonical"],
    ["https://ChatGPT.com/oauth/client.json", "canonical"],
    ["https://chatgpt.com:443/oauth/client.json", "canonical"],
    ["https://chatgpt.com:8443/oauth/client.json", "default https port"],
    ["https://chatgpt.com:22/oauth/client.json", "default https port"],
    ["https://chatgpt.com./oauth/client.json", "trailing dot"],
    ["https://104.18.32.47/client.json", "host name"],
    ["https://[2606:4700::1111]/client.json", "host name"],
    ["not a url", "URL"],
  ])("refuses %s before any lookup (%s)", async (clientId, reason) => {
    const resolve = publicResolver();
    const transport = transportOf(200, doc({ client_id: clientId }));
    const result = await resolveClientMetadata(clientId, { resolve, transport });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(reason);
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps a query string: it is part of the path sent, and the Host header stays the bare host", async () => {
    const withQuery = "https://chatgpt.com/oauth/client.json?v=2&x=a%20b";
    const transport = transportOf(200, doc({ client_id: withQuery }));
    expect((await resolveClientMetadata(withQuery, { resolve: publicResolver(), transport })).ok).toBe(true);
    expect(transport.mock.calls[0][0]).toMatchObject({ path: "/oauth/client.json?v=2&x=a%20b", hostHeader: "chatgpt.com", hostname: "chatgpt.com", port: 443 });
  });
});

describe("the SSRF guard (design §4)", () => {
  it.each([
    ["loopback v4", "127.0.0.1", 4], ["private v4", "10.0.0.5", 4], ["private v4", "192.168.1.10", 4],
    ["CGNAT", "100.64.0.1", 4], ["link-local / cloud metadata", "169.254.169.254", 4], ["multicast v4", "224.0.0.1", 4],
    ["loopback v6", "::1", 6], ["unique-local v6", "fd00::1", 6], ["link-local v6", "fe80::1", 6], ["multicast v6", "ff02::1", 6],
    ["v4-mapped v6", "::ffff:127.0.0.1", 6], ["v4-mapped v6 (hex)", "::ffff:a9fe:a9fe", 6], ["v4-compatible v6", "::10.0.0.1", 6],
    ["Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2", 6],
  ] as const)("refuses a host that resolves to %s (%s), with a message that names nothing", async (_label, address, family) => {
    const transport = transportOf(200, doc());
    expectGenericFailure(await resolveClientMetadata(CLIENT_ID, { resolve: resolverOf([{ address, family }]), transport }));
    expect(transport).not.toHaveBeenCalled();
    expect(loggedReason()).toContain("non-public");
  });

  it("refuses when ANY answer is non-public, not only the first, in a mixed v4/v6 set too", async () => {
    for (const answers of [
      [{ address: PUBLIC_V4, family: 4 as const }, { address: "10.0.0.5", family: 4 as const }],
      [{ address: PUBLIC_V4, family: 4 as const }, { address: "fd00::1", family: 6 as const }],
      [{ address: PUBLIC_V6, family: 6 as const }, { address: "127.0.0.1", family: 4 as const }],
    ]) {
      clearCimdCache();
      const transport = transportOf(200, doc());
      expect((await resolveClientMetadata(CLIENT_ID, { resolve: resolverOf(answers), transport })).ok).toBe(false);
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it("accepts an all-public mixed v4/v6 set and connects to the first answer", async () => {
    const transport = transportOf(200, doc());
    const resolve = resolverOf([{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }]);
    expect((await resolveClientMetadata(CLIENT_ID, { resolve, transport })).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toMatchObject({ address: PUBLIC_V6, family: 6 });
  });

  it("resolves ONCE and connects to the validated address with SNI and Host = the hostname", async () => {
    // A second answer (DNS rebinding) would say 127.0.0.1; it must never be asked for.
    const resolve = resolverOf([{ address: PUBLIC_V4, family: 4 }], [{ address: "127.0.0.1", family: 4 }]);
    const transport = transportOf(200, doc());
    const result = await resolveClientMetadata(CLIENT_ID, { resolve, transport });
    expect(result).toEqual({ ok: true, clientId: CLIENT_ID, clientName: "ChatGPT", redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"] });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("chatgpt.com");
    expect(transport).toHaveBeenCalledTimes(1);
    const target = transport.mock.calls[0][0];
    expect(target).toMatchObject({ address: PUBLIC_V4, family: 4, hostname: "chatgpt.com", hostHeader: "chatgpt.com", port: 443, path: "/oauth/client.json" });
  });

  it("a dual-stack host reachable only over IPv4: the unreachable IPv6 answer is skipped for the next", async () => {
    const resolve = resolverOf([{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }]);
    const transport = vi.fn<CimdTransport>(async (t) => {
      if (t.family === 6) throw Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });
      return { status: 200, headers: {}, body: chunks(JSON.stringify(doc())) };
    });
    expect((await resolveClientMetadata(CLIENT_ID, { resolve, transport })).ok).toBe(true);
    expect(transport.mock.calls.map(([t]) => t.address)).toEqual([PUBLIC_V6, PUBLIC_V4]);
  });

  it("an answer that hangs is abandoned for the next after the per-address time, inside the overall deadline", async () => {
    vi.useFakeTimers();
    const resolve = resolverOf([{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }]);
    const signals: AbortSignal[] = [];
    const transport = vi.fn<CimdTransport>((t) => {
      signals.push(t.signal);
      if (t.family === 6) return new Promise(() => {}); // blackholed
      return Promise.resolve({ status: 200, headers: {}, body: chunks(JSON.stringify(doc())) });
    });
    const pending = resolveClientMetadata(CLIENT_ID, { resolve, transport });
    await vi.advanceTimersByTimeAsync(CIMD_ATTEMPT_TIMEOUT_MS);
    expect((await pending).ok).toBe(true);
    expect(CIMD_ATTEMPT_TIMEOUT_MS).toBeLessThan(CIMD_TIMEOUT_MS);
    expect(signals[0].aborted, "the abandoned attempt is aborted").toBe(true);
  });

  it("the last answer gets the rest of the deadline, not the per-address time", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<CimdTransport>(() => new Promise((done) =>
      setTimeout(() => done({ status: 200, headers: {}, body: chunks(JSON.stringify(doc())) }), CIMD_ATTEMPT_TIMEOUT_MS + 500)));
    const pending = resolveClientMetadata(CLIENT_ID, { resolve: publicResolver(), transport });
    await vi.advanceTimersByTimeAsync(CIMD_ATTEMPT_TIMEOUT_MS + 500);
    expect((await pending).ok).toBe(true);
  });

  it("when every answer fails, the caller gets the generic message and the log names each address", async () => {
    const resolve = resolverOf([{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }]);
    const transport = vi.fn<CimdTransport>(async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); });
    expectGenericFailure(await resolveClientMetadata(CLIENT_ID, { resolve, transport }));
    expect(loggedReason()).toContain(`${PUBLIC_V6}: ECONNREFUSED`);
    expect(loggedReason()).toContain(`${PUBLIC_V4}: ECONNREFUSED`);
  });

  it("does not follow a redirect", async () => {
    const transport = vi.fn<CimdTransport>(async () => ({ status: 302, headers: { location: "https://127.0.0.1/x" }, body: chunks("") }));
    expectGenericFailure(await resolveClientMetadata(CLIENT_ID, { resolve: publicResolver(), transport }));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(loggedReason()).toContain("redirects are not followed");
  });
});

describe("DNS (Sonnet S1: c-ares with its own timeout, never dns.lookup on the libuv pool)", () => {
  it("the system resolver is built with a 2 s timeout and one try", () => {
    expect(DNS_RESOLVER_OPTIONS).toEqual({ timeout: 2000, tries: 1 });
  });

  it("asks A and AAAA, IPv4 first, and keeps whichever family answers", async () => {
    const both = dnsResolver({ resolve4: async () => [PUBLIC_V4], resolve6: async () => [PUBLIC_V6] });
    expect(await both("chatgpt.com")).toEqual([{ address: PUBLIC_V4, family: 4 }, { address: PUBLIC_V6, family: 6 }]);
    const noData = Object.assign(new Error("queryAaaa ENODATA"), { code: "ENODATA" });
    const v4Only = dnsResolver({ resolve4: async () => [PUBLIC_V4], resolve6: async () => { throw noData; } });
    expect(await v4Only("chatgpt.com")).toEqual([{ address: PUBLIC_V4, family: 4 }]);
    const v6Only = dnsResolver({ resolve4: async () => { throw noData; }, resolve6: async () => [PUBLIC_V6] });
    expect(await v6Only("chatgpt.com")).toEqual([{ address: PUBLIC_V6, family: 6 }]);
    const neither = dnsResolver({ resolve4: async () => { throw noData; }, resolve6: async () => { throw noData; } });
    await expect(neither("chatgpt.com")).rejects.toThrow();
  });

  it("every answer from both families is validated", async () => {
    const resolve = dnsResolver({ resolve4: async () => [PUBLIC_V4], resolve6: async () => ["fd00::1"] });
    const transport = transportOf(200, doc());
    expect((await resolveClientMetadata(CLIENT_ID, { resolve, transport })).ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });
});

// --- The real transport, against local TLS listeners ------------------------------------------------------------------
// A minimal X.509 builder (DER by hand; node:crypto signs but cannot issue certificates), so the test needs no
// committed key and no openssl on the machine.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * a + b];
  for (const v of rest) {
    const out = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) out.unshift((x & 0x7f) | 0x80);
    bytes.push(...out);
  }
  return der(0x06, Buffer.from(bytes));
}
const utcTime = (d: Date) => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
function selfSignedCert(dnsName: string): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, Buffer.from(dnsName)))));
  const now = Date.now();
  const extensions = der(0xa3, seq(
    seq(oid("2.5.29.17"), der(0x04, seq(der(0x82, Buffer.from(dnsName))))), // subjectAltName: dNSName
    seq(oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, seq(der(0x01, Buffer.from([0xff]))))), // basicConstraints CA
  ));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(8)])),
    ecdsaSha256, name, seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))), name,
    publicKey.export({ type: "spki", format: "der" }), extensions,
  );
  const signature = sign("sha256", tbs, privateKey as KeyObject);
  const cert = seq(tbs, ecdsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

describe("the real transport", () => {
  it("builds a request for the validated address, with the hostname as SNI and Host, and a lookup that refuses", () => {
    const target: CimdTarget = {
      address: PUBLIC_V4, family: 4, hostname: "chatgpt.com", hostHeader: "chatgpt.com", port: 443, path: "/oauth/client.json",
      signal: new AbortController().signal,
    };
    const options = httpsRequestOptions(target);
    expect(options).toMatchObject({ host: PUBLIC_V4, port: 443, path: "/oauth/client.json", method: "GET", servername: "chatgpt.com", rejectUnauthorized: true, agent: false });
    expect(options.headers).toMatchObject({ host: "chatgpt.com" });
    expect(options).not.toHaveProperty("ca");
    expect(typeof options.lookup, "a lookup that refuses, not the default resolver").toBe("function");
    expect(() => (options.lookup as unknown as (...a: unknown[]) => void)("chatgpt.com", {}, () => {})).toThrow(/never looks a name up/);
  });

  it("sends the hostname as TLS SNI to the address it was given (a local TLS listener sees it)", async () => {
    let sni: string | undefined;
    const listener = tls.createServer({ SNICallback: (name, cb) => { sni = name; cb(new Error("handshake stops here")); } });
    listener.on("tlsClientError", () => {});
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      // client.invalid can never resolve (RFC 6761), so reaching the listener proves no lookup happened.
      await expect(httpsTransport({
        address: "127.0.0.1", family: 4, hostname: "client.invalid", hostHeader: "client.invalid",
        port: (listener.address() as AddressInfo).port, path: "/c.json", signal: new AbortController().signal,
      })).rejects.toThrow();
      expect(sni).toBe("client.invalid");
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  describe("checks the certificate against the hostname (T1)", () => {
    const { cert, key } = selfSignedCert("metadata.test");
    let server: https.Server;
    let port: number;
    const seen: Array<{ host?: string; url?: string }> = [];
    beforeEach(async () => {
      server = https.createServer({ cert, key }, (req, res) => {
        seen.push({ host: req.headers.host, url: req.url });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const target = (hostname: string): CimdTarget => ({
      address: "127.0.0.1", family: 4, hostname, hostHeader: hostname, port, path: "/client.json?v=1", signal: new AbortController().signal,
    });

    it("control: the name on the certificate, with its CA trusted, is accepted (Host and path arrive as sent)", async () => {
      const response = await createHttpsTransport({ ca: cert })(target("metadata.test"));
      expect(response.status).toBe(200);
      for await (const _ of response.body) { /* drain */ }
      expect(seen.at(-1)).toEqual({ host: "metadata.test", url: "/client.json?v=1" });
    });

    it("a certificate for a DIFFERENT name fails with ERR_TLS_CERT_ALTNAME_INVALID", async () => {
      await expect(createHttpsTransport({ ca: cert })(target("chatgpt.test"))).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    });

    it("without the test CA, the self-signed certificate is not trusted at all", async () => {
      await expect(httpsTransport(target("metadata.test"))).rejects.toMatchObject({ code: expect.stringMatching(/SELF_SIGNED/) });
    });
  });
});

describe("the document", () => {
  it(`is refused above ${CIMD_MAX_BYTES} bytes, however it arrives`, async () => {
    const big = JSON.stringify(doc({ padding: "x".repeat(CIMD_MAX_BYTES) }));
    const streamed = vi.fn<CimdTransport>(async () => ({ status: 200, headers: {}, body: chunks(big.slice(0, 40_000), big.slice(40_000)) }));
    expectGenericFailure(await resolveClientMetadata(CLIENT_ID, { resolve: publicResolver(), transport: streamed }));
    expect(loggedReason()).toContain("64 KB");
    clearCimdCache();
    const declared = transportOf(200, doc(), { "content-length": String(CIMD_MAX_BYTES + 1) });
    expect((await resolveClientMetadata(CLIENT_ID, { resolve: publicResolver(), transport: declared })).ok).toBe(false);
  });

  it("at exactly the cap is read", async () => {
    const base = JSON.stringify(doc({ padding: "" }));
    const exact = JSON.stringify(doc({ padding: "x".repeat(CIMD_MAX_BYTES - base.length) }));
    expect(Buffer.byteLength(exact)).toBe(CIMD_MAX_BYTES);
    expect((await resolveClientMetadata(CLIENT_ID, { resolve: publicResolver(), transport: transportOf(200, exact) })).ok).toBe(true);
  });

  it("must name itself: a client_id that differs from the URL is refused", async () => {
    for (const other of ["https://chatgpt.com/oauth/other.json", "https://evil.example/oauth/client.json", `${CLIENT_ID}/`]) {
      clearCimdCache();
      const result = await resolveClientMetadata(CLIENT_ID, { resolve: publicResolver(), transport: transportOf(200, doc({ client_id: other })) });
      expect(result.ok, other).toBe(false);
      if (!result.ok) expect(result.error).toContain("client_id");
    }
  });

  it.each([
    ["not JSON", "<html>hi</html>"],
    ["a JSON array", "[]"],
    ["no redirect_uris", doc({ redirect_uris: undefined })],
    ["empty redirect_uris", doc({ redirect_uris: [] })],
    ["a non-loopback http redirect", doc({ redirect_uris: ["http://chatgpt.com/cb"] })],
    ["a redirect with a fragment", doc({ redirect_uris: ["https://chatgpt.com/cb#x"] })],
    ["a confidential client", doc({ token_endpoint_auth_method: "private_key_jwt" })],
    ["a document with a client_secret", doc({ client_secret: "s3cr3t" })],
    ["a document with an empty client_secret", doc({ client_secret: "" })],
    ["a non-string client_name", doc({ client_name: 42 })],
  ])("is refused when it is %s", async (_label, body) => {
    expect((await resolveClientMetadata(CLIENT_ID, { resolve: publicResolver(), transport: transportOf(200, body) })).ok).toBe(false);
  });

  it("with no client_name is named by its host; a loopback redirect is allowed (RFC 8252)", async () => {
    const result = await resolveClientMetadata(CLIENT_ID, {
      resolve: publicResolver(), transport: transportOf(200, doc({ client_name: undefined, redirect_uris: ["http://localhost/callback"] })),
    });
    expect(result).toEqual({ ok: true, clientId: CLIENT_ID, clientName: "chatgpt.com", redirectUris: ["http://localhost/callback"] });
  });

  it("is refused on a non-200 answer", async () => {
    expectGenericFailure(await resolveClientMetadata(CLIENT_ID, { resolve: publicResolver(), transport: transportOf(404, doc()) }));
    expect(loggedReason()).toContain("answered 404");
  });
});

describe(`the ${CIMD_TIMEOUT_MS / 1000} s deadline`, () => {
  it("covers a transport that never answers, and aborts it", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const transport = vi.fn<CimdTransport>((t) => { signal = t.signal; return new Promise(() => {}); });
    const pending = resolveClientMetadata(CLIENT_ID, { resolve: publicResolver(), transport });
    await vi.advanceTimersByTimeAsync(CIMD_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expectGenericFailure(await pending);
    expect(loggedReason()).toContain("timed out");
    expect(signal?.aborted).toBe(true);
  });

  it("covers a body that trickles", async () => {
    vi.useFakeTimers();
    async function* slow() { yield Buffer.from("{"); await new Promise(() => {}); }
    const transport = vi.fn<CimdTransport>(async () => ({ status: 200, headers: {}, body: slow() }));
    const pending = resolveClientMetadata(CLIENT_ID, { resolve: publicResolver(), transport });
    await vi.advanceTimersByTimeAsync(CIMD_TIMEOUT_MS);
    expectGenericFailure(await pending);
  });

  it("a resolver that answers after the deadline does not start a connection", async () => {
    vi.useFakeTimers();
    const resolve = vi.fn<CimdResolver>(() => new Promise((done) => setTimeout(() => done([{ address: PUBLIC_V4, family: 4 }]), CIMD_TIMEOUT_MS + 1000)));
    const transport = transportOf(200, doc());
    const pending = resolveClientMetadata(CLIENT_ID, { resolve, transport });
    await vi.advanceTimersByTimeAsync(CIMD_TIMEOUT_MS + 2000);
    expect((await pending).ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it("covers a resolver that never answers", async () => {
    vi.useFakeTimers();
    const resolve = vi.fn<CimdResolver>(() => new Promise(() => {}));
    const pending = resolveClientMetadata(CLIENT_ID, { resolve, transport: transportOf(200, doc()) });
    await vi.advanceTimersByTimeAsync(CIMD_TIMEOUT_MS);
    expectGenericFailure(await pending);
  });
});

describe("the cache, in-flight sharing and the per-network limit", () => {
  it("serves a hit without a second fetch, and refetches after the TTL", async () => {
    let now = 1_000_000;
    const transport = vi.fn<CimdTransport>(async () => ({ status: 200, headers: {}, body: chunks(JSON.stringify(doc())) }));
    const resolve = vi.fn<CimdResolver>(async () => [{ address: PUBLIC_V4, family: 4 }]);
    const deps = { resolve, transport, now: () => now };
    expect((await resolveClientMetadata(CLIENT_ID, deps)).ok).toBe(true);
    now += CIMD_CACHE_TTL_MS - 1;
    expect((await resolveClientMetadata(CLIENT_ID, deps)).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await resolveClientMetadata(CLIENT_ID, deps)).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it(`remembers a failure for ${CIMD_NEGATIVE_TTL_MS / 1000} s, then tries again`, async () => {
    let now = 5_000_000;
    let status = 503;
    const transport = vi.fn<CimdTransport>(async () => ({ status, headers: {}, body: chunks(JSON.stringify(doc())) }));
    const deps = { resolve: vi.fn<CimdResolver>(async () => [{ address: PUBLIC_V4, family: 4 }]), transport, now: () => now };
    expect((await resolveClientMetadata(CLIENT_ID, deps)).ok).toBe(false);
    status = 200;
    now += CIMD_NEGATIVE_TTL_MS - 1;
    expect((await resolveClientMetadata(CLIENT_ID, deps)).ok, "still the remembered failure").toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await resolveClientMetadata(CLIENT_ID, deps)).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("concurrent requests for one URL share one fetch", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transport = vi.fn<CimdTransport>(async () => {
      await gate;
      return { status: 200, headers: {}, body: chunks(JSON.stringify(doc())) };
    });
    const resolve = vi.fn<CimdResolver>(async () => [{ address: PUBLIC_V4, family: 4 }]);
    const all = Promise.all([1, 2, 3].map(() => resolveClientMetadata(CLIENT_ID, { resolve, transport })));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await all;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("every caller gets its own copy, so one cannot change what the cache hands the next", async () => {
    const deps = { resolve: vi.fn<CimdResolver>(async () => [{ address: PUBLIC_V4, family: 4 }]), transport: transportOf(200, doc()) };
    const first = await resolveClientMetadata(CLIENT_ID, deps);
    if (!first.ok) throw new Error("fetch failed");
    first.redirectUris.push("https://evil.example/fetched");
    const second = await resolveClientMetadata(CLIENT_ID, deps); // a cache hit
    if (!second.ok) throw new Error("fetch failed");
    second.redirectUris.push("https://evil.example/cached");
    const third = await resolveClientMetadata(CLIENT_ID, deps);
    if (!third.ok) throw new Error("fetch failed");
    expect(third.redirectUris).toEqual(["https://chatgpt.com/connector_platform_oauth_redirect"]);
    expect(deps.transport).toHaveBeenCalledTimes(1);
  });

  it(`holds at most ${CIMD_CACHE_MAX_ENTRIES} URLs; the oldest goes first`, async () => {
    const urlOf = (i: number) => `https://c${i}.example/client.json`;
    const transport = vi.fn<CimdTransport>(async (t) => ({
      status: 200, headers: {}, body: chunks(JSON.stringify(doc({ client_id: `https://${t.hostname}/client.json` }))),
    }));
    const deps = { resolve: vi.fn<CimdResolver>(async () => [{ address: PUBLIC_V4, family: 4 }]), transport };
    for (let i = 0; i <= CIMD_CACHE_MAX_ENTRIES; i++) expect((await resolveClientMetadata(urlOf(i), deps)).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(CIMD_CACHE_MAX_ENTRIES + 1);
    await resolveClientMetadata(urlOf(CIMD_CACHE_MAX_ENTRIES), deps);
    await resolveClientMetadata(urlOf(1), deps);
    expect(transport, "the newest and the second-oldest are still cached").toHaveBeenCalledTimes(CIMD_CACHE_MAX_ENTRIES + 1);
    await resolveClientMetadata(urlOf(0), deps);
    expect(transport, "the oldest was evicted").toHaveBeenCalledTimes(CIMD_CACHE_MAX_ENTRIES + 2);
  });

  it("with a rateLimitKey, only fetches that go out count against that network", async () => {
    const limit = Number(process.env.OPENCADRE_OAUTH_CIMD_FETCH_PER_MIN) || 10;
    const key = `ip:test-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 8)}`;
    const transport = vi.fn<CimdTransport>(async (t) => ({
      status: 200, headers: {}, body: chunks(JSON.stringify(doc({ client_id: `https://${t.hostname}/client.json` }))),
    }));
    const deps = { resolve: vi.fn<CimdResolver>(async () => [{ address: PUBLIC_V4, family: 4 }]), transport, rateLimitKey: key };
    for (let i = 0; i < limit; i++) expect((await resolveClientMetadata(`https://r${i}.example/client.json`, deps)).ok).toBe(true);
    expect(await resolveClientMetadata("https://r-over.example/client.json", deps)).toEqual({ ok: false, error: CIMD_RATE_LIMITED });
    expect((await resolveClientMetadata("https://r0.example/client.json", deps)).ok, "a cache hit costs nothing").toBe(true);
    expect((await resolveClientMetadata("https://r-over.example/client.json", { ...deps, rateLimitKey: `${key}-other` })).ok, "another network").toBe(true);
    expect(transport).toHaveBeenCalledTimes(limit + 1);
  });
});
