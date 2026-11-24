import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import express from "express";
import { app } from "../src/rest.js";
import { createRateLimiter, rateLimitKey, rateLimitMiddleware } from "../src/ratelimit.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const ENV_KEYS = ["OPENCADRE_ADMIN_TOKEN", "NODE_ENV"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const createOrg = (headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/v1/orgs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name: "Sec Org" }) });

describe("POST /v1/orgs admin gate", () => {
  it("requires the admin token when OPENCADRE_ADMIN_TOKEN is set", async () => {
    process.env.OPENCADRE_ADMIN_TOKEN = "s3cret-admin";
    expect((await createOrg()).status).toBe(401);
    expect((await createOrg({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await createOrg({ authorization: "Bearer s3cret-admin" })).status).toBe(201);
  });

  it("is disabled in production when no admin token is configured", async () => {
    delete process.env.OPENCADRE_ADMIN_TOKEN;
    process.env.NODE_ENV = "production";
    expect((await createOrg()).status).toBe(503);
  });

  it("stays open for local development when no token is configured", async () => {
    delete process.env.OPENCADRE_ADMIN_TOKEN;
    process.env.NODE_ENV = "development";
    expect((await createOrg()).status).toBe(201);
  });
});

describe("rate limiting", () => {
  it("allows up to the limit per key, then rejects until the window resets", async () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 200 });
    expect([1, 2, 3].map(() => limiter.check("k").ok)).toEqual([true, true, true]);
    const blocked = limiter.check("k");
    expect(blocked.ok).toBe(false);
    expect(limiter.check("other").ok).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(limiter.check("k").ok).toBe(true);
  });

  it("uses the client IP budget even when an unverified bearer rotates", () => {
    const key = rateLimitKey("Bearer agt_abc", "1.2.3.4");
    expect(key).toBe("ip:1.2.3.4");
    expect(key).not.toContain("agt_abc");
    expect(rateLimitKey("Bearer agt_abc", "5.6.7.8")).not.toBe(key);
    expect(rateLimitKey("Bearer agt_other", "1.2.3.4")).toBe(key);
    expect(rateLimitKey(undefined, "1.2.3.4")).toBe("ip:1.2.3.4");
    // An empty bearer isn't a credential: two anonymous callers must not share a bucket.
    expect(rateLimitKey("Bearer ", "1.2.3.4")).toBe("ip:1.2.3.4");
  });

  it("middleware answers 429 with Retry-After", async () => {
    const small = express();
    small.use(rateLimitMiddleware(createRateLimiter({ limit: 2, windowMs: 60_000 })));
    small.get("/x", (_req, res) => res.json({ ok: true }));
    const s = http.createServer(small);
    await new Promise<void>((resolve) => s.listen(0, resolve));
    const addr = s.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/x`;
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(url, { headers: { authorization: `Bearer invalid-${i}` } })).status);
    const last = await fetch(url, { headers: { authorization: "Bearer t" } });
    expect(statuses).toEqual([200, 200, 429]);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });
  it("bounds attacker-controlled identities without evicting an active budget", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 100, maxKeys: 2 });
    expect(limiter.check("a").ok).toBe(true);
    expect(limiter.check("b").ok).toBe(true);
    expect(limiter.check("c").ok).toBe(false);
    expect(limiter.check("a").ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(limiter.check("c").ok).toBe(true);
  });
});
