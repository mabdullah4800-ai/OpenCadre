import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// The connect-time guard is only reachable through a name that RESOLVES to a non-public address, and
// the test used to get one by trusting the machine's resolver to map the root-dotted "localhost." to
// loopback. A resolver that returns ENOTFOUND for it (containers and some CI images do) made the call
// reject with the DNS error instead of the guard's, so the test failed while the property it guards
// still held -- it asserted the REASON rather than the OUTCOME, and reported a machine's DNS setup as
// a security-guard failure.
//
// node:dns is stubbed for one sentinel hostname so the guard's own filtering is what decides, on every
// machine. Everything else delegates to the real resolver, so no other test in this file changes
// behaviour. The stub replaces the module only for importers in this graph (src/webhook-guard.ts),
// not for node's internal net lookups.
const LOOPBACK_NAME = "webhook-guard-loopback.example";
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    default: actual,
    lookup: (hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
      if (hostname === "webhook-guard-loopback.example") return callback(null, [{ address: "127.0.0.1", family: 4 }]);
      return (actual.lookup as unknown as (...args: unknown[]) => void)(hostname, options, callback);
    },
  };
});
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { isPublicAddress, postWebhook, validateWebhookAuthHeader, validateWebhookUrl } from "../src/webhook-guard.js";

afterEach(() => vi.unstubAllEnvs());

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe",
  ])("blocks %s", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) =>
    expect(isPublicAddress(ip)).toBe(true));

  // The CIMD fetch (docs/design/MCP-CONNECTOR.md §4) resolves a host an outsider names, so every way IPv6 can carry an
  // IPv4 address is read through to the IPv4 rules, not only ::ffff:0:0/96.
  it.each([
    "::127.0.0.1", "::7f00:1", "::a9fe:a9fe", "::8.8.8.8", // IPv4-compatible ::/96 (deprecated; routed over a tunnel where one exists)
    "::ffff:0:127.0.0.1", "::ffff:0:a9fe:a9fe", // IPv4-translated ::ffff:0:0/96 (RFC 2765)
    "2002:7f00:1::1", "2002:a9fe:a9fe::", "2002:0a00:0001::", // 6to4 2002::/16 wrapping a private IPv4
    "64:ff9b:1::a00:1", "64:ff9b:1::808:808", // local-use NAT64 64:ff9b:1::/48 (RFC 8215): the translator is on our side
    "fec0::1", // deprecated site-local fec0::/10
  ])("blocks the embedded or private IPv6 form %s", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(["::ffff:0:8.8.8.8", "2002:808:808::1", "64:ff9b::808:808"])("allows the public IPv6 form %s", (ip) =>
    expect(isPublicAddress(ip)).toBe(true));

  // Coordinator's ruling on the CIMD review: the remaining special-purpose ranges a public host never answers from.
  it.each([
    "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo 2001::/32 (a tunnel whose far end is an IPv4 host)
    "2001:10::1", "2001:1f:ffff::1", // ORCHID 2001:10::/28
    "2001:20::1", "2001:2f:ffff::1", // ORCHIDv2 2001:20::/28
    "100::1", "100::ffff:ffff:ffff:ffff", // discard-only 100::/64
    "192.88.99.1", "::ffff:192.88.99.1", // 6to4 relay anycast 192.88.99.0/24
  ])("blocks the special-purpose address %s", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(["2001:4860:4860::8888", "2001:30::1", "2001:f::1", "100:0:0:1::1", "192.88.98.1", "192.88.100.1"])(
    "allows %s, just outside those ranges", (ip) => expect(isPublicAddress(ip)).toBe(true));

  it("rejects things that aren't addresses", () => expect(isPublicAddress("example.com")).toBe(false));
});

describe("validateWebhookUrl", () => {
  it.each([
    ["http://example.com/hook", "https"],
    ["https://localhost/hook", "public host"],
    ["https://metadata.internal/hook", "public host"],
    ["https://169.254.169.254/latest/meta-data/", "public address"],
    ["https://[::1]/hook", "public address"],
    ["https://user:pass@example.com/hook", "credentials"],
    ["not a url", "valid URL"],
  ])("rejects %s", (url, reason) => {
    const result = validateWebhookUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(reason);
  });

  it("accepts a public https URL", () => expect(validateWebhookUrl("https://hooks.example.com/opencadre")).toEqual({ ok: true }));

  // Review (opencadre-55): a local env file copied to production must not switch the guard off.
  it("ignores the local-development switch in production", () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(validateWebhookUrl("http://127.0.0.1:8787/v1/metrics").ok).toBe(false);
    vi.stubEnv("NODE_ENV", "test");
    expect(validateWebhookUrl("http://127.0.0.1:8787/hook").ok).toBe(true);
  });
});

describe("postWebhook", () => {
  let server: http.Server;
  let port: number;
  let hits = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // A name that resolves to loopback must be stopped when the connection is made, not merely reported:
  // the assertion is that NOTHING was sent (hits stays 0), with the guard's own error as the reason.
  it("refuses a name that resolves to a non-public address, at connect time", async () => {
    await expect(postWebhook(`https://${LOOPBACK_NAME}:${port}/hook`, {}, "{}")).rejects.toThrow(/non-public/);
    await expect(postWebhook(`https://${LOOPBACK_NAME}:${port}/hook`, {}, "{}")).rejects.toMatchObject({ code: "EWEBHOOKBLOCKED" });
    expect(hits).toBe(0);
  });

  // Why the connect-time guard has to exist at all: the name check deliberately does NOT catch this
  // one. "localhost." is not `localhost`, does not end in `.localhost` or `.internal`, and is not an
  // IP, so validateWebhookUrl passes it and only the lookup can stop it. This assertion needs no
  // resolver -- it is about the name rule, not about what the name resolves to.
  it("does not catch a root-dotted loopback name at registration time", () => {
    expect(validateWebhookUrl("https://localhost./hook")).toEqual({ ok: true });
  });

  it("never follows a redirect", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    await expect(postWebhook(`http://127.0.0.1:${port}/hook`, {}, "{}")).resolves.toBe(302);
    expect(hits).toBe(1);
  });
});

describe("registering a webhook", () => {
  let base: string;
  let rest: ReturnType<typeof app.listen>;
  beforeAll(async () => {
    rest = app.listen(0);
    await new Promise((r) => rest.once("listening", r));
    base = `http://127.0.0.1:${(rest.address() as AddressInfo).port}`;
  });
  afterAll(() => rest.close());

  it("rejects an internal URL with a clear error and accepts a public one", async () => {
    const { orgId } = createOrganization("Webhook Guard Org");
    const agent = registerAgent(orgId, "Guarded-Agent");
    const register = (url: string) =>
      fetch(`${base}/v1/webhook`, { method: "POST", headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ url }) });
    const blocked = await register("http://169.254.169.254/latest/meta-data/");
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toMatch(/https|public/);
    expect((await register("https://hooks.example.com/opencadre")).status).toBe(200);
  });

  // The same rule as a person's PUT /v1/org/agents/:agentId/webhook (validateWebhookAuthHeader): one header line.
  it("refuses an auth header with a line break or any control character, or over 2048 characters", async () => {
    const { orgId } = createOrganization("Webhook Header Org");
    const agent = registerAgent(orgId, "Header-Agent");
    const register = (authHeader: unknown) =>
      fetch(`${base}/v1/webhook`, { method: "POST", headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ url: "https://hooks.example.com/opencadre", authHeader }) });
    const stored = () => (db.prepare(`SELECT webhook_url, webhook_auth_header FROM agents WHERE id = ?`).get(agent.agentId) as { webhook_url: string | null; webhook_auth_header: string | null });
    for (const bad of ["Bearer a\r\nX-Injected: 1", "Bearer a\n", "Bearer a\u0000", "Bearer\ta", "Bearer a\u007f", `Bearer ${"a".repeat(2042)}`]) {
      const res = await register(bad);
      expect(res.status, JSON.stringify(bad.slice(0, 16))).toBe(400);
      expect((await res.json()).error).toMatch(/control characters/);
    }
    expect(stored()).toEqual({ webhook_url: null, webhook_auth_header: null });
    const longest = `Bearer ${"a".repeat(2041)}`;
    expect((await register(longest)).status).toBe(200);
    expect(stored()).toEqual({ webhook_url: "https://hooks.example.com/opencadre", webhook_auth_header: longest });
  });
});

describe("validateWebhookAuthHeader", () => {
  it("accepts one printable line of at most 2048 characters, and nothing else", () => {
    expect(validateWebhookAuthHeader("Bearer abc")).toEqual({ ok: true });
    expect(validateWebhookAuthHeader("x".repeat(2048))).toEqual({ ok: true });
    for (const bad of ["a\rb", "a\nb", "a\u0000", "a\u001f", "a\u007f", "a\tb", "x".repeat(2049)]) {
      expect(validateWebhookAuthHeader(bad).ok, JSON.stringify(bad.slice(0, 8))).toBe(false);
    }
  });
});
