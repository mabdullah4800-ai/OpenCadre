import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrganization, getMessages, registerAgent } from "../src/service.js";
import { resetHubHealth, sweepHubHealth } from "../src/ops-alerts.js";

const thresholds = { errorRate: 0.02, p95Ms: 1000, minRequests: 20, minLatencySamples: 3 };
const stats = (over: { errorRateHigh?: boolean; p95High?: boolean; stuck?: number }) => {
  const errorRateHigh = over.errorRateHigh ?? false;
  const p95High = over.p95High ?? false;
  const stuck = over.stuck ?? 0;
  return {
    window: { minutes: 5, requests: 200, errors5xx: errorRateHigh ? 9 : 0, errorRate: errorRateHigh ? 0.045 : 0, p50Ms: 20, p95Ms: p95High ? 2400 : 80 },
    inFlight: { requests: stuck, oldestSeconds: stuck ? 320 : 0, stuck },
    alerts: { healthy: !errorRateHigh && !p95High && stuck === 0, errorRateHigh, p95High, stuckRequests: stuck > 0, thresholds },
  };
};

const ops = createOrganization("Platform Ops");
const opsOperator = registerAgent(ops.orgId, "Ops-Operator", { role: "operator", system: true });
const opsAgent = registerAgent(ops.orgId, "Ops-Agent");
const customer = createOrganization("Customer Org");
const customerOperator = registerAgent(customer.orgId, "Customer-Operator", { role: "operator", system: true });

beforeEach(() => {
  resetHubHealth();
  vi.stubEnv("OPENCADRE_OPS_ORG_ID", ops.orgId);
  getMessages(ops.orgId, opsOperator.agentId);
});
afterEach(() => vi.unstubAllEnvs());

const inbox = (orgId: string, agentId: string) => getMessages(orgId, agentId).map((m) => m.body);

describe("hub health alerts", () => {
  it("alerts the platform org's operators once when the hub turns unhealthy, then once on recovery", async () => {
    const t0 = Date.UTC(2026, 8, 14, 12, 0, 0);
    expect(await sweepHubHealth(t0, stats({ errorRateHigh: true, stuck: 1 }))).toBe("alerted");
    const alert = inbox(ops.orgId, opsOperator.agentId);
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatch(/^HUB ALERT/);
    expect(alert[0]).toContain("5xx rate 4.5%");
    expect(alert[0]).toContain("in flight for over 5 min");

    expect(await sweepHubHealth(t0 + 60_000, stats({ errorRateHigh: true }))).toBeNull();
    expect(inbox(ops.orgId, opsOperator.agentId)).toHaveLength(0);

    expect(await sweepHubHealth(t0 + 7 * 60_000, stats({}))).toBe("recovered");
    expect(inbox(ops.orgId, opsOperator.agentId)).toEqual([expect.stringMatching(/^HUB RECOVERED .*after 7 min/)]);
  });

  // Review (opencadre-55): a deploy restarts the process mid-incident; the recovery notice must still come.
  it("still sends the recovery notice after a restart that happened during an incident", async () => {
    const t0 = Date.now();
    await sweepHubHealth(t0, stats({ errorRateHigh: true }));
    getMessages(ops.orgId, opsOperator.agentId);
    resetHubHealth(); // simulates the process restarting: in-memory state is gone
    expect(await sweepHubHealth(t0 + 3 * 60_000, stats({}))).toBe("recovered");
    expect(inbox(ops.orgId, opsOperator.agentId)).toEqual([expect.stringMatching(/^HUB RECOVERED/)]);
    resetHubHealth();
    expect(await sweepHubHealth(t0 + 4 * 60_000, stats({}))).toBeNull();
  });

  // Hub-wide numbers include every customer's traffic.
  it("never messages customers or non-operator agents", async () => {
    await sweepHubHealth(Date.now(), stats({ p95High: true }));
    expect(inbox(customer.orgId, customerOperator.agentId)).toHaveLength(0);
    expect(inbox(ops.orgId, opsAgent.agentId)).toHaveLength(0);
  });

  it("does nothing without OPENCADRE_OPS_ORG_ID", async () => {
    vi.stubEnv("OPENCADRE_OPS_ORG_ID", "");
    expect(await sweepHubHealth(Date.now(), stats({ errorRateHigh: true }))).toBeNull();
  });
});
