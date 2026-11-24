import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { requestApproval } from "../src/approvals.js";
import { beginShutdown } from "../src/shutdown.js";
import { setDraining } from "../src/draining.js";

let server: http.Server;
let hub: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  setDraining(false);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("graceful shutdown", () => {
  it("releases held mail, timeline and approval waits, and new waits return at once while draining", async () => {
    const { orgId } = createOrganization("Shutdown Org");
    const coder = registerAgent(orgId, "Coder");
    const headers = { authorization: `Bearer ${coder.apiKey}` };
    const approval = await requestApproval(orgId, { id: coder.agentId, name: "Coder" }, { action: "rm -rf ./build-cache", risk: "high" });

    const waits = () => [
      `${hub}/v1/messages/wait?timeoutSeconds=30`,
      `${hub}/v1/events/wait?timeoutSeconds=30&after=999999999`,
      `${hub}/v1/approvals/${approval.id}/wait?timeoutSeconds=30`,
    ].map((url) => fetch(url, { headers }).then(async (res) => ({ status: res.status, body: await res.json() })));

    const held = waits();
    let settled = false;
    void Promise.all(held).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false); // genuinely holding before shutdown

    const started = Date.now();
    beginShutdown();
    const released = await Promise.all(held);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(released.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(released[2].body.approval.status).toBe("pending");

    const again = Date.now();
    const fresh = await Promise.all(waits());
    expect(Date.now() - again).toBeLessThan(2000);
    expect(fresh.map((r) => r.status)).toEqual([200, 200, 200]);
  }, 20_000);
});
