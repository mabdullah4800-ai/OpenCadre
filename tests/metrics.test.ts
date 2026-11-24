import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { MIGRATIONS } from "../src/migrations.js";
import { recordRequest, requestFinished, requestStarted, resetMetrics, windowStats, isLongPoll } from "../src/metrics.js";

const thresholds = { errorRate: 0.02, p95Ms: 1000, minRequests: 20, minLatencySamples: 3 };
const NOW = Date.UTC(2026, 8, 14, 12, 0, 30);

beforeEach(() => resetMetrics());

describe("metrics window", () => {
  it("computes requests, 5xx rate and latency percentiles over the last five minutes", () => {
    for (let i = 1; i <= 100; i++) recordRequest("/v1/messages", i <= 3 ? 500 : 200, i, NOW);
    const { window, alerts } = windowStats(NOW, thresholds);
    expect(window).toMatchObject({ minutes: 5, requests: 100, errors5xx: 3, errorRate: 0.03, p50Ms: 50, p95Ms: 95 });
    expect(alerts).toMatchObject({ healthy: false, errorRateHigh: true, p95High: false });
  });

  it("leaves long-polls out of latency but counts them as requests", () => {
    expect(isLongPoll("/v1/messages/wait")).toBe(true);
    expect(isLongPoll("/v1/approvals/abc/wait")).toBe(true);
    expect(isLongPoll("/v1/messages")).toBe(false);
    recordRequest("/v1/messages/wait", 200, 55_000, NOW);
    recordRequest("/v1/messages", 200, 12, NOW);
    expect(windowStats(NOW, thresholds).window).toMatchObject({ requests: 2, p95Ms: 12 });
  });

  it("drops requests older than five minutes", () => {
    recordRequest("/v1/messages", 500, 5, NOW - 6 * 60_000);
    recordRequest("/v1/messages", 200, 5, NOW);
    expect(windowStats(NOW, thresholds).window).toMatchObject({ requests: 1, errors5xx: 0 });
  });

  // Review (opencadre-55): at low traffic a real outage must still page.
  it("needs 20 requests for the error-rate alert but only 3 slow samples for the latency alert", () => {
    for (let i = 0; i < 5; i++) recordRequest("/v1/messages", 500, 10, NOW);
    expect(windowStats(NOW, thresholds).alerts).toMatchObject({ errorRateHigh: false });
    resetMetrics();
    for (let i = 0; i < 3; i++) recordRequest("/v1/messages", 200, 5000, NOW);
    expect(windowStats(NOW, thresholds).alerts).toMatchObject({ healthy: false, p95High: true });
    resetMetrics();
    for (let i = 0; i < 2; i++) recordRequest("/v1/messages", 200, 5000, NOW);
    expect(windowStats(NOW, thresholds).alerts).toMatchObject({ healthy: true, p95High: false });
  });

  // A hung long-poll or deadlock never finishes, so it never reaches the window; in-flight age catches it.
  it("flags a request that has been in flight longer than any legitimate long-poll", () => {
    const hung = requestStarted(NOW - 301_000);
    const normal = requestStarted(NOW - 60_000);
    expect(windowStats(NOW, thresholds)).toMatchObject({ inFlight: { requests: 2, stuck: 1, oldestSeconds: 301 }, alerts: { healthy: false, stuckRequests: true } });
    requestFinished(hung);
    requestFinished(normal);
    expect(windowStats(NOW, thresholds)).toMatchObject({ inFlight: { requests: 0, stuck: 0 }, alerts: { healthy: true } });
  });
});

describe("GET /v1/metrics", () => {
  let base: string;
  let server: ReturnType<typeof app.listen>;
  const { orgId } = createOrganization("Metrics Org");
  const operator = registerAgent(orgId, "Metrics-Operator", { role: "operator", system: true });
  const agent = registerAgent(orgId, "Metrics-Agent");

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    vi.unstubAllEnvs();
  });

  const get = (key?: string) => fetch(`${base}/v1/metrics`, { headers: key ? { authorization: `Bearer ${key}` } : {} });

  // Metrics cover every org's traffic, so no org key (not even an operator's) may read them.
  it("accepts only the metrics or admin token, never an org key", async () => {
    vi.stubEnv("OPENCADRE_METRICS_TOKEN", "monitor-token-1234567890");
    vi.stubEnv("OPENCADRE_ADMIN_TOKEN", "admin-token-0987654321");
    expect((await get()).status).toBe(401);
    expect((await get(agent.apiKey)).status).toBe(401);
    expect((await get(operator.apiKey)).status).toBe(401);
    expect((await get("monitor-token-123456789X")).status).toBe(401);
    expect((await get("monitor-token-1234567890")).status).toBe(200);
    expect((await get("admin-token-0987654321")).status).toBe(200);
  });

  it("returns version, schema, window, alerts, totals and live gauges, and never a key", async () => {
    vi.stubEnv("OPENCADRE_METRICS_TOKEN", "monitor-token-1234567890");
    const res = await get("monitor-token-1234567890");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      schemaVersion: MIGRATIONS.at(-1)!.version,
      window: { minutes: 5 },
      alerts: { healthy: expect.any(Boolean) },
      totals: { requests: expect.any(Number) },
      live: { sockets: expect.any(Number), inboxWaiters: expect.any(Number), eventWaiters: expect.any(Number) },
    });
    expect(JSON.stringify(body)).not.toMatch(/agt_|org_/);
  });
});
