import type { AddressInfo } from "node:net";
import http from "node:http";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { assignPlan } from "../src/billing.js";
import { MIGRATIONS, runMigrations } from "../src/migrations.js";

/** Reconnecting updates the same computer: an ocd_ code redeemed with the computer's own credential (same workspace,
 * valid, unrevoked) is merged into that computer instead of making a second one. Any other credential changes nothing. */

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let ipCounter = 0;
const nextIp = () => `10.79.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function call(method: string, path: string, { key, body }: { key?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-forwarded-for": nextIp(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

let orgCounter = 0;
async function workspace() {
  const orgName = `Reconnect Org ${++orgCounter}`;
  const { orgId } = createOrganization(orgName);
  const operatorKey = registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey;
  /**
   * Put the workspace on a plan with NO MACHINE CAP, and it is load-bearing rather than tidiness.
   *
   * `createOrganization` lands on `DEFAULT_PLAN` = `trial`, whose `max_machines` is 3 (`migrations.ts:1222`),
   * and `POST /v1/org/devices` now enforces that cap. This file's subject is CREDENTIAL STALENESS, and one of
   * its cases creates NINE devices (one `connect` plus a seven-iteration loop), so on `trial` the fourth mint
   * is refused 402 and the `expect(201)` inside `mint` fails for a reason with nothing to do with what is under
   * test. `team` (5 machines) is not enough either -- measured, not assumed: the loop alone exceeds it.
   *
   * `business` carries `max_machines = NULL`, and `planLimitRefusal` returns null for a NULL cap (`billing.ts:413`),
   * so no machine cap can confound this file at all. Assigning a bigger finite plan would work until someone
   * adds an eighth credential case to the loop; NULL is the choice that does not need revisiting.
   *
   * The alternative -- relaxing the gate so this file passes -- would stop the enforcement the gate exists for
   * in order to keep an unrelated test green, which is how enforcement quietly stops enforcing.
   */
  assignPlan(orgId, "business");
  const mint = async (name: string, client?: string) => {
    const minted = await call("POST", "/v1/org/devices", { key: operatorKey, body: { name, ...(client ? { client } : {}) } });
    expect(minted.status).toBe(201);
    return { deviceId: minted.body.deviceId as string, code: minted.body.code as string };
  };
  const connect = async (name: string, client?: string) => {
    const { deviceId, code } = await mint(name, client);
    const redeemed = await call("POST", "/v1/connect/redeem", { body: { code } });
    expect(redeemed.status).toBe(201);
    return { deviceId, credential: redeemed.body.deviceCredential as string };
  };
  const list = async () => (await call("GET", "/v1/org/devices", { key: operatorKey })).body.devices as Array<Record<string, any>>;
  return { orgId, orgName, operatorKey, mint, connect, list };
}

const row = (deviceId: string) =>
  db.prepare(`SELECT org_id, client, tools, credential_hash, code_redeemed_at, merged_into_device_id, revoked_at FROM devices WHERE id = ?`).get(deviceId) as Record<string, string | null>;
const liveCredentials = (orgId: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE org_id = ? AND credential_hash IS NOT NULL AND revoked_at IS NULL`).get(orgId) as { n: number }).n;

describe("POST /v1/connect/redeem with currentCredential", () => {
  it("merges a code into the computer that proves it is already connected: no new credential, the same id, one active computer", async () => {
    const w = await workspace();
    const laptop = await w.connect("Laptop");
    const before = row(laptop.deviceId);
    const again = await w.mint("Laptop again");

    const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: again.code, currentCredential: laptop.credential } });
    expect(redeemed.status).toBe(201);
    expect(redeemed.body).toMatchObject({ deviceCredential: null, deviceId: laptop.deviceId, merged: true, computerName: "Laptop", client: "auto", orgName: w.orgName });
    expect(redeemed.body.hubUrl).toEqual(expect.any(String));
    expect(redeemed.body.cliUrl).toEqual(expect.any(String));
    // Nothing shaped like a credential comes back, not even the one that was sent.
    expect(redeemed.text).not.toMatch(/dev_[0-9a-f]/);

    // The fresh row never gets a credential; it is spent and points at the computer.
    expect(row(again.deviceId)).toMatchObject({ credential_hash: null, merged_into_device_id: laptop.deviceId, code_redeemed_at: expect.any(String), revoked_at: null });
    // The computer and its credential are unchanged, and the credential still works.
    expect(row(laptop.deviceId)).toEqual(before);
    expect((await call("POST", "/v1/devices/tools", { key: laptop.credential, body: { tools: ["codex"] } })).status).toBe(200);
    expect(liveCredentials(w.orgId)).toBe(1);

    const devices = await w.list();
    expect(devices.find((d) => d.deviceId === again.deviceId)).toMatchObject({ status: "merged", mergedIntoDeviceId: laptop.deviceId, sessionCount: 0, tools: [] });
    expect(devices.find((d) => d.deviceId === laptop.deviceId)).toMatchObject({ status: "connected", mergedIntoDeviceId: null, tools: ["codex"] });
    expect(devices.filter((d) => d.status !== "merged")).toHaveLength(1);

    const event = db.prepare(`SELECT subject_type, subject_id, payload FROM events WHERE org_id = ? AND type = 'device.reconnected'`).get(w.orgId) as { subject_type: string; subject_id: string; payload: string };
    expect(event).toMatchObject({ subject_type: "device", subject_id: laptop.deviceId });
    expect(JSON.parse(event.payload)).toEqual({ deviceId: laptop.deviceId, name: "Laptop", mergedDeviceId: again.deviceId });
    expect(event.payload).not.toContain("dev_");
  });

  it("sessions stay on the one computer, and only it counts them", async () => {
    const w = await workspace();
    const laptop = await w.connect("Laptop");
    const again = await w.mint("Laptop again");
    await call("POST", "/v1/connect/redeem", { body: { code: again.code, currentCredential: laptop.credential } });
    await call("PUT", "/v1/org/projects", { key: w.operatorKey, body: { projectKey: "github.com/acme/widgets", enabled: true } });
    const joined = await fetch(`${base}/v1/sessions/join`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${laptop.credential}`, "content-type": "application/json", "x-forwarded-for": nextIp(),
        "x-opencadre-session": "codex-1", "x-opencadre-client": "codex", "x-opencadre-project": "github.com/acme/widgets", "x-opencadre-project-name": "widgets",
      },
      body: "{}",
    });
    expect(joined.status).toBe(201);
    const devices = await w.list();
    expect(devices.find((d) => d.deviceId === laptop.deviceId)).toMatchObject({ sessionCount: 1 });
    expect(devices.find((d) => d.deviceId === again.deviceId)).toMatchObject({ sessionCount: 0 });
  });

  it("an older single-tool computer becomes a computer for every tool, keeping its own tool", async () => {
    const w = await workspace();
    const old = await w.connect("Old laptop", "claude-code");
    const again = await w.mint("Add Codex");
    const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: again.code, currentCredential: old.credential } });
    expect(redeemed.body).toMatchObject({ merged: true, deviceId: old.deviceId, client: "auto" });
    expect(row(old.deviceId)).toMatchObject({ client: "auto", tools: JSON.stringify(["claude-code"]) });
  });

  it("a foreign credential can't take over or merge into another workspace's computer: the code makes a normal new one", async () => {
    const a = await workspace();
    const b = await workspace();
    const aLaptop = await a.connect("A laptop");
    const aBefore = row(aLaptop.deviceId);
    const bCode = await b.mint("B laptop");

    const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: bCode.code, currentCredential: aLaptop.credential } });
    expect(redeemed.status).toBe(201);
    expect(redeemed.body).toMatchObject({ merged: false, deviceId: bCode.deviceId, computerName: "B laptop", orgName: b.orgName });
    expect(redeemed.body.deviceCredential).toMatch(/^dev_[0-9a-f]{48}$/);
    expect(redeemed.body.deviceCredential).not.toBe(aLaptop.credential);

    // B's row is a computer of its own in B, and A's computer is untouched.
    expect(row(bCode.deviceId)).toMatchObject({ org_id: b.orgId, merged_into_device_id: null, credential_hash: expect.any(String) });
    expect(row(aLaptop.deviceId)).toEqual(aBefore);
    expect((await b.list()).map((d) => [d.deviceId, d.status])).toEqual([[bCode.deviceId, "connected"]]);
    expect((await a.list()).map((d) => [d.deviceId, d.status])).toEqual([[aLaptop.deviceId, "connected"]]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'device.reconnected' AND org_id IN (?, ?)`).get(a.orgId, b.orgId)).toEqual({ n: 0 });

    // Each credential still answers only for its own computer.
    const me = async (key: string) => (await call("GET", "/v1/devices/me", { key })).body;
    expect(await me(aLaptop.credential)).toMatchObject({ deviceId: aLaptop.deviceId, name: "A laptop" });
    expect(await me(redeemed.body.deviceCredential)).toMatchObject({ deviceId: bCode.deviceId, name: "B laptop" });
  });

  it("a stale (revoked), unknown, malformed or non-string credential gives a normal new computer", async () => {
    const w = await workspace();
    const gone = await w.connect("Gone");
    expect((await call("DELETE", `/v1/org/devices/${gone.deviceId}`, { key: w.operatorKey })).status).toBe(200);
    for (const currentCredential of [gone.credential, `dev_${"0".repeat(48)}`, "dev_short", "agt_nope", 42, { credential: gone.credential }, null]) {
      const fresh = await w.mint("Fresh");
      const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: fresh.code, currentCredential } });
      expect(redeemed.status).toBe(201);
      expect(redeemed.body).toMatchObject({ merged: false, deviceId: fresh.deviceId });
      expect(redeemed.body.deviceCredential).toMatch(/^dev_[0-9a-f]{48}$/);
      expect(row(fresh.deviceId).merged_into_device_id).toBeNull();
    }
  });

  it("a revoked computer is never merged into, even if its hash were somehow still stored", async () => {
    const w = await workspace();
    const laptop = await w.connect("Laptop");
    // revokeDevice clears the hash too; this pins the revoked_at guard on its own.
    db.prepare(`UPDATE devices SET revoked_at = ? WHERE id = ?`).run(new Date().toISOString(), laptop.deviceId);
    const fresh = await w.mint("Fresh");
    const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: fresh.code, currentCredential: laptop.credential } });
    expect(redeemed.body).toMatchObject({ merged: false, deviceId: fresh.deviceId });
  });

  it("a merged code can't merge into a merged row, and a repeat redeem is 410 whether it merged or not", async () => {
    const w = await workspace();
    const laptop = await w.connect("Laptop");
    const merging = await w.mint("Merging");
    expect((await call("POST", "/v1/connect/redeem", { body: { code: merging.code, currentCredential: laptop.credential } })).body.merged).toBe(true);
    const plain = await w.mint("Plain");
    const plainRedeemed = await call("POST", "/v1/connect/redeem", { body: { code: plain.code } });
    expect(plainRedeemed.body.merged).toBe(false);

    for (const code of [merging.code, plain.code]) {
      for (const body of [{ code }, { code, currentCredential: laptop.credential }, { code, currentCredential: plainRedeemed.body.deviceCredential }]) {
        const repeat = await call("POST", "/v1/connect/redeem", { body });
        expect(repeat.status).toBe(410);
        expect(repeat.body).toEqual({ error: "this connect code was already used; generate a new command in the console" });
      }
    }
    expect(row(merging.deviceId)).toMatchObject({ credential_hash: null, merged_into_device_id: laptop.deviceId });
    expect(liveCredentials(w.orgId)).toBe(2);
  });

  it("a paused workspace refuses before merging, and the code stays unspent", async () => {
    const w = await workspace();
    const laptop = await w.connect("Laptop");
    const again = await w.mint("Again");
    await call("POST", "/v1/org/pause", { key: w.operatorKey });
    expect((await call("POST", "/v1/connect/redeem", { body: { code: again.code, currentCredential: laptop.credential } })).status).toBe(423);
    expect(row(again.deviceId)).toMatchObject({ code_redeemed_at: null, merged_into_device_id: null });
  });
});

describe("GET /v1/devices/me", () => {
  it("names the computer for its own credential only, with no hash or credential in the answer", async () => {
    const w = await workspace();
    const laptop = await w.connect("Laptop", "claude-code");
    const me = await call("GET", "/v1/devices/me", { key: laptop.credential });
    expect(me).toMatchObject({ status: 200, body: { deviceId: laptop.deviceId, name: "Laptop", client: "claude-code", tools: ["claude-code"] } });
    // cliUrl (Q1g): a re-run `connect` learns the current CLI stamp from this answer. The URL, never a credential.
    expect(Object.keys(me.body).sort()).toEqual(["cliUrl", "client", "deviceId", "name", "tools"]);
    expect(me.body.cliUrl).toMatch(/\/cli\/(?:[0-9a-f]{12}\/)?opencadre-cli\.tgz$/);
    expect(me.text).not.toMatch(/dev_|hash/);
    expect((await call("GET", "/v1/devices/me", { key: `dev_${"1".repeat(48)}` })).status).toBe(401);
    expect((await call("GET", "/v1/devices/me", { key: w.operatorKey })).status).toBe(401);
    expect((await call("GET", "/v1/devices/me")).status).toBe(401);
    await call("DELETE", `/v1/org/devices/${laptop.deviceId}`, { key: w.operatorKey });
    expect((await call("GET", "/v1/devices/me", { key: laptop.credential })).status).toBe(401);
  });
});

describe("migration 11", () => {
  it("adds devices.merged_into_device_id to an existing database, keeping its rows", () => {
    const legacy = new Database(":memory:");
    runMigrations(legacy, MIGRATIONS.filter((m) => m.version < 11));
    legacy.exec(`
      INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Org', 'h');
      INSERT INTO devices (id, org_id, name, client, code_hash, code_expires_at, created_by_agent_id, created_at)
        VALUES ('d1', 'o1', 'Laptop', 'claude-code', 'c', '2026-09-15T00:00:00Z', 'a', '2026-09-15T00:00:00Z');
    `);
    const upTo11 = MIGRATIONS.filter((m) => m.version <= 11);
    expect(runMigrations(legacy, upTo11).applied).toEqual([11]);
    expect(legacy.prepare(`SELECT name, merged_into_device_id FROM devices WHERE id = 'd1'`).get()).toEqual({ name: "Laptop", merged_into_device_id: null });
    expect(runMigrations(legacy, upTo11).applied).toEqual([]);
  });
});
