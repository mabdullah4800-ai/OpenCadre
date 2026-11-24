import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { pauseWorkspace } from "../src/kill-switch.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startHub, operatorWorkspace, mintDevice, CLI, childEnv, computerCredential, enableProject, gitProject, ProxyProcess, runNode, tempDir } from "./helpers/device-hub.js";
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
let hub: Awaited<ReturnType<typeof startHub>>;
beforeAll(async () => { hub = await startHub(); });
afterAll(async () => { await hub.close(); });
const payload = () => ({ schema: 1, client: "codex", component: "hooks", installationId: "a".repeat(32), bundleId: "123456789abc", integrity: "matches-metadata", helpers: { "opencadre-config.mjs": "a".repeat(64) } });
let ip = 0;
async function call(path: string, key: string, body?: unknown) {
  const res = await fetch(hub.url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-forwarded-for": `10.88.0.${++ip}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
}
async function computer(name: string) {
  const fleet = await operatorWorkspace(name);
  const minted = await mintDevice(hub.url, fleet.operatorKey, "codex");
  const res = await fetch(hub.url + "/v1/connect/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: minted.code }) });
  expect(res.status).toBe(201);
  return { ...fleet, deviceId: minted.deviceId, credential: (await res.json()).deviceCredential as string };
}
const stored = (id: string) => (db.prepare("SELECT connector_reports FROM devices WHERE id = ?").get(id) as any).connector_reports;
describe("computer inventory route is independent of chat identity", () => {
  it("targets only the bearer computer, creates no chat or heartbeat, and exposes no path, credential or installation identifier", async () => {
    const a = await computer("build report A"), b = await computer("build report B");
    const before = db.prepare("SELECT last_seen_at FROM devices WHERE id = ?").get(a.deviceId);
    expect((await call("/v1/devices/connector-build", a.credential, payload())).status).toBe(200);
    expect(JSON.parse(stored(a.deviceId))).toHaveLength(1);
    expect(stored(b.deviceId)).toBe("[]");
    expect(db.prepare("SELECT last_seen_at FROM devices WHERE id = ?").get(a.deviceId)).toEqual(before);
    expect((db.prepare("SELECT count(*) n FROM agents WHERE device_id = ?").get(a.deviceId) as any).n).toBe(0);
    const view = await call("/v1/org/devices", a.operatorKey);
    expect(view.body.devices[0].connector.reports[0]).toMatchObject({ client: "codex", component: "hooks" });
    expect(JSON.stringify(view.body).includes(a.credential)).toBe(false);
    expect(view.body.devices[0].connector.reports[0]).not.toHaveProperty("installationId");
    expect((await call("/v1/devices/connector-build", a.credential, { ...payload(), deviceId: b.deviceId })).status).toBe(400);
    expect((await call("/v1/devices/connector-build", a.operatorKey, payload())).status).toBe(401);
  });
  it("current installed Cursor proxy reports its own build without creating a chat, then native calls still work", async () => {
    const fleet = await operatorWorkspace("current proxy inventory");
    const project = gitProject("ReportedProject");
    await enableProject(hub.url, fleet.operatorKey, "local:ReportedProject");
    const home = tempDir("current-report-home-");
    const minted = await mintDevice(hub.url, fleet.operatorKey, "cursor");
    const env = childEnv(home, { OPENCADRE_AWARENESS_STATE_DIR: join(home, "state") });
    const install = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "cursor"], env, project);
    expect(install.code, install.err).toBe(0);
    const bin = join(home, ".opencadre", "bin");
    const proxy = new ProxyProcess(join(bin, "opencadre-mcp.mjs"), env, project, "cursor");
    try {
      await proxy.initialize();
      await vi.waitFor(() => expect(JSON.parse(stored(minted.deviceId))).toHaveLength(1));
      expect(JSON.parse(stored(minted.deviceId))[0]).toMatchObject({ component: "proxy", integrity: "matches-metadata" });
      expect((db.prepare("SELECT count(*) n FROM agents WHERE device_id = ?").get(minted.deviceId) as any).n).toBe(0);
      const generation = readFileSync(join(bin, ".gen", "current"), "utf8").trim();
      const config = await import(/* @vite-ignore */ pathToFileURL(join(bin, ".gen", generation, "opencadre-config.mjs")).href);
      const credential = computerCredential(home);
      await proxy.callTool("opencadre_get_active_agents", { _opencadre_stamp: config.mintStamp(credential, "current-chat") });
      expect((db.prepare("SELECT count(*) n FROM agents WHERE device_id = ?").get(minted.deviceId) as any).n).toBe(1);
      expect((proxy.out + proxy.err).includes(credential)).toBe(false);
    } finally { await proxy.close(); }
  }, 30000);
  it("computer removal clears inventory, including idempotent repeated removal", async () => {
    const c = await computer("removed inventory");
    expect((await call("/v1/devices/connector-build", c.credential, payload())).status).toBe(200);
    expect(JSON.parse(stored(c.deviceId))).toHaveLength(1);
    const remove = () => fetch(hub.url + "/v1/org/devices/" + c.deviceId, { method: "DELETE", headers: { authorization: `Bearer ${c.operatorKey}` } });
    expect((await remove()).ok).toBe(true);
    expect(stored(c.deviceId)).toBe("[]");
    expect((await call("/v1/devices/connector-build", c.credential, payload())).status).toBe(401);
    expect((await remove()).ok).toBe(true);
    expect(stored(c.deviceId)).toBe("[]");
  });
  it("refuses lapsed, paused and revoked writes before changing inventory", async () => {
    const lapsed = await computer("lapsed inventory");
    db.prepare("UPDATE organizations SET plan = 'trial', trial_ends_at = ? WHERE id = ?").run(new Date(Date.now() - 10000).toISOString(), lapsed.orgId);
    expect((await call("/v1/devices/connector-build", lapsed.credential, payload())).status).toBe(402);
    expect(stored(lapsed.deviceId)).toBe("[]");
    const paused = await computer("paused inventory");
    pauseWorkspace(paused.orgId, { id: "test", name: "Operator" });
    expect((await call("/v1/devices/connector-build", paused.credential, payload())).status).toBe(423);
    expect(stored(paused.deviceId)).toBe("[]");
    const revoked = await computer("revoked inventory");
    db.prepare("UPDATE devices SET revoked_at = datetime('now') WHERE id = ?").run(revoked.deviceId);
    expect((await call("/v1/devices/connector-build", revoked.credential, payload())).status).toBe(401);
    expect(stored(revoked.deviceId)).toBe("[]");
  });
});
