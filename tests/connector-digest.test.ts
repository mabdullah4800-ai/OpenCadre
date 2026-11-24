// PR-E1b, through the real hub (PLAN-PR-E addendum §3.2(b), §4; amendment 2 §4.1-§4.2).
//
// 1. The awareness digest's per-computer connector item: mapped to a computer ONLY by the frozen org-scoped
//    session-to-device query, so a named agent, a no-device session, an ended session, a revoked or merged computer
//    and a cross-org id get nothing; two computers each get only their own; one item per computer per (package,
//    status) per 24 h; text from the hub's own snapshot with no credential, device id or installation id.
// 2. Hub-side refusal counts: the two refusal reasons a computer's credential meets, counted per computer and shown to
//    the console as observed reasons and counts, never as "broken".
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { tmpDir } from "./helpers/tmp.js";

const fixtureDir = tmpDir("oc-e1b-digest-");
const TARBALL = path.join(fixtureDir, "opencadre-cli.tgz");
process.env.OPENCADRE_CLI_TARBALL = TARBALL;
process.env.OPENCADRE_PUBLIC_HUB_URL = "https://hub.example.test";
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const { app } = await import("../src/rest.js");
const { db } = await import("../src/db.js");
const { createOrganization, registerAgent } = await import("../src/service.js");
const { assignPlan } = await import("../src/billing.js");
const { currentCliPackage } = await import("../src/cli-package.js");
const { deviceForSession, maybeEmitConnectorItem, SESSION_DEVICE_SQL } = await import("../src/connector-digest.js");

const H = (c: string) => c.repeat(64);
const TARGET_HELPERS = { "opencadre-config.mjs": H("a"), "opencadre-mcp.mjs": H("b") };

/** A ustar archive of `entries`, gzipped: the hub reads build.json and compat-policy.json back out of it. */
function tgz(entries: Array<{ name: string; body: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, body } of entries) {
    const data = Buffer.from(body, "utf8");
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write(`${"0".repeat(11)}\0`, 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    const sum = h.reduce((a, b) => a + b, 0);
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
let generation = 0;
/** Serves a package whose build names TARGET_HELPERS, with `compat` as its policy (null: no policy file at all). A new
 * mtime each time. */
function servePackage(compat: unknown = { schema: 1, cohorts: [], required: [] }) {
  const build = { schema: 1, provenance: "none", commit: null, dirty: [], inputsDigest: H("d"), helpers: TARGET_HELPERS, imports: {}, officialHistory: {}, generation: ++generation };
  const entries = [{ name: "package/build.json", body: JSON.stringify(build) }];
  if (compat !== null) entries.push({ name: "package/compat-policy.json", body: JSON.stringify(compat) });
  writeFileSync(TARBALL, tgz(entries));
  const later = new Date(Date.now() + generation * 60_000);
  utimesSync(TARBALL, later, later);
  return currentCliPackage()!;
}
/** Serves exactly `bytes` again (so the SAME stamp), with a new mtime so the hub re-reads the file. */
function serveBytes(bytes: Buffer) {
  writeFileSync(TARBALL, bytes);
  const later = new Date(Date.now() + ++generation * 60_000);
  utimesSync(TARBALL, later, later);
  return currentCliPackage()!;
}

let server: ReturnType<typeof app.listen>;
let base: string;
beforeAll(async () => {
  servePackage();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let ip = 0;
async function call(method: string, route: string, { key, body, headers = {} }: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-forwarded-for": `10.92.${Math.floor(++ip / 250)}.${ip % 250}`,
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const PROJECT = { key: "github.com/acme/e1b", name: "E1b" };
const chat = (sessionId: string, extra: Record<string, string> = {}) => ({
  "x-opencadre-session": sessionId, "x-opencadre-client": "claude-code",
  "x-opencadre-project": PROJECT.key, "x-opencadre-project-name": PROJECT.name, ...extra,
});
const report = (over: Record<string, unknown> = {}) => ({
  schema: 1, client: "claude-code", component: "hooks", installationId: "e".repeat(32), bundleId: "123456789abc",
  integrity: "matches-metadata", helpers: TARGET_HELPERS, ...over,
});

async function workspace(name: string) {
  const { orgId } = createOrganization(name);
  assignPlan(orgId, "internal");
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  return { orgId, operatorKey: operator.apiKey, operatorId: operator.agentId };
}
async function computer(ws: { operatorKey: string }, label = "Laptop") {
  const minted = await call("POST", "/v1/org/devices", { key: ws.operatorKey, body: { name: label } });
  expect(minted.status).toBe(201);
  const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: minted.body.code } });
  expect(redeemed.status).toBe(201);
  const credential = redeemed.body.deviceCredential as string;
  expect((await call("PUT", "/v1/devices/projects/enable-current", { key: credential, headers: chat("boot") })).status).toBe(200);
  return { deviceId: minted.body.deviceId as string, credential };
}
async function join(c: { credential: string }, sessionId: string) {
  const joined = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat(sessionId) });
  expect(joined.status).toBeLessThan(300);
  return joined.body.agentId as string;
}
const digest = (c: { credential: string }, sessionId: string) => call("GET", "/v1/awareness", { key: c.credential, headers: chat(sessionId, { "x-opencadre-resolve-only": "1" }) });
const connectorItems = (orgId: string, agentId?: string) =>
  (db.prepare(`SELECT target_agent_id, payload FROM events WHERE org_id = ? AND type = 'connector.notice' ${agentId ? "AND target_agent_id = ?" : ""}`)
    .all(...(agentId ? [orgId, agentId] : [orgId])) as Array<{ target_agent_id: string; payload: string }>);
const resetMarker = (deviceId: string) => db.prepare(`UPDATE devices SET connector_digest = '{}' WHERE id = ?`).run(deviceId);
/** Moves every claim this computer holds `ms` into the past, as if that much time had passed. */
const ageClaims = (deviceId: string, ms: number) => {
  const claims = JSON.parse((db.prepare(`SELECT connector_digest FROM devices WHERE id = ?`).get(deviceId) as { connector_digest: string }).connector_digest);
  for (const k of Object.keys(claims)) claims[k] -= ms;
  db.prepare(`UPDATE devices SET connector_digest = ? WHERE id = ?`).run(JSON.stringify(claims), deviceId);
};
const claimsOf = (deviceId: string) => (db.prepare(`SELECT connector_digest FROM devices WHERE id = ?`).get(deviceId) as { connector_digest: string }).connector_digest;

describe("the session-to-device mapping is the frozen org-scoped query (amendment 2 §4.2)", () => {
  it("is exactly the frozen SQL", () => {
    expect(SESSION_DEVICE_SQL.replace(/\s+/g, " ").trim()).toBe(
      "SELECT d.id FROM agents a JOIN devices d ON d.id = a.device_id AND d.org_id = a.org_id WHERE a.org_id = ? AND a.id = ? AND a.kind = 'session' AND a.ended_at IS NULL AND d.revoked_at IS NULL AND d.merged_into_device_id IS NULL");
  });

  it("two computers in one workspace each receive only their own item", async () => {
    const ws = await workspace("E1b two computers");
    const a = await computer(ws, "Laptop A"), b = await computer(ws, "Laptop B");
    const agentA = await join(a, "chat-a"), agentB = await join(b, "chat-b");
    expect(deviceForSession(ws.orgId, agentA)).toBe(a.deviceId);
    expect(deviceForSession(ws.orgId, agentB)).toBe(b.deviceId);
    // A reports a different build (an optional update); B reports the current one.
    expect((await call("POST", "/v1/devices/connector-build", { key: a.credential, body: report({ helpers: { ...TARGET_HELPERS, "opencadre-mcp.mjs": H("c") } }) })).status).toBe(200);
    expect((await call("POST", "/v1/devices/connector-build", { key: b.credential, body: report() })).status).toBe(200);
    const da = await digest(a, "chat-a"), dbb = await digest(b, "chat-b");
    expect(da.status).toBe(200);
    expect(da.body.items.map((i: { type: string }) => i.type)).toContain("connector.notice");
    expect(da.body.text).toContain("optional update, not a compatibility verdict");
    expect(dbb.body.items.map((i: { type: string }) => i.type)).not.toContain("connector.notice");
    expect(connectorItems(ws.orgId).map((r) => r.target_agent_id)).toEqual([agentA]);
  });

  it("a named agent, a no-device session, an ended session, and a revoked or merged computer get none", async () => {
    const ws = await workspace("E1b no item");
    const named = registerAgent(ws.orgId, "Named-Agent", {});
    const named0 = await call("GET", "/v1/awareness", { key: named.apiKey });
    expect(named0.status).toBe(200);
    expect(deviceForSession(ws.orgId, named.agentId)).toBeNull();
    expect(maybeEmitConnectorItem(ws.orgId, named.agentId)).toBeNull();
    expect(deviceForSession(ws.orgId, ws.operatorId)).toBeNull();

    // Each case is a computer that WOULD get an item (seen, no report): only the one condition differs.
    const control = await computer(ws, "Control");
    const controlAgent = await join(control, "control");
    expect(deviceForSession(ws.orgId, controlAgent)).toBe(control.deviceId);
    expect(maybeEmitConnectorItem(ws.orgId, controlAgent), "the control gets its item").toContain("no recent connector report");

    // A named (non-session) agent row that NAMES a computer is still not mapped: only a session agent is.
    db.prepare(`UPDATE agents SET device_id = ? WHERE id = ?`).run(control.deviceId, named.agentId);
    expect(deviceForSession(ws.orgId, named.agentId), "a named agent is never mapped, even with a device_id").toBeNull();
    expect(maybeEmitConnectorItem(ws.orgId, named.agentId)).toBeNull();

    const noDevice = await computer(ws, "No device");
    const noDeviceAgent = await join(noDevice, "nodevice");
    db.prepare(`UPDATE agents SET device_id = NULL WHERE id = ?`).run(noDeviceAgent);
    expect(deviceForSession(ws.orgId, noDeviceAgent)).toBeNull();
    expect(maybeEmitConnectorItem(ws.orgId, noDeviceAgent)).toBeNull();

    const ended = await computer(ws, "Ended");
    const endedAgent = await join(ended, "ended");
    db.prepare(`UPDATE agents SET ended_at = datetime('now') WHERE id = ?`).run(endedAgent);
    expect(deviceForSession(ws.orgId, endedAgent)).toBeNull();
    expect(maybeEmitConnectorItem(ws.orgId, endedAgent)).toBeNull();

    const revoked = await computer(ws, "Revoked");
    const revokedAgent = await join(revoked, "revoked");
    db.prepare(`UPDATE devices SET revoked_at = ? WHERE id = ?`).run(new Date().toISOString(), revoked.deviceId);
    expect(deviceForSession(ws.orgId, revokedAgent)).toBeNull();
    expect(maybeEmitConnectorItem(ws.orgId, revokedAgent)).toBeNull();

    const merged = await computer(ws, "Merged");
    const mergedAgent = await join(merged, "merged");
    db.prepare(`UPDATE devices SET merged_into_device_id = ? WHERE id = ?`).run(control.deviceId, merged.deviceId);
    expect(deviceForSession(ws.orgId, mergedAgent), "a merged computer is not followed to the one it merged into").toBeNull();
    expect(maybeEmitConnectorItem(ws.orgId, mergedAgent)).toBeNull();

    expect(connectorItems(ws.orgId).map((r) => r.target_agent_id)).toEqual([controlAgent]);
  });

  it("a cross-org id gets none: neither the other workspace's agent, nor an agent pointed at another workspace's computer", async () => {
    const one = await workspace("E1b org one"), two = await workspace("E1b org two");
    const c = await computer(one, "One");
    const agent = await join(c, "cross");
    expect(deviceForSession(two.orgId, agent)).toBeNull();
    expect(maybeEmitConnectorItem(two.orgId, agent)).toBeNull();
    // A session row in org two that names org one's computer: the join requires the SAME org on both sides.
    const twoComputer = await computer(two, "Two");
    const twoAgent = await join(twoComputer, "two");
    db.prepare(`UPDATE agents SET device_id = ? WHERE id = ?`).run(c.deviceId, twoAgent);
    expect(deviceForSession(two.orgId, twoAgent)).toBeNull();
    expect(maybeEmitConnectorItem(two.orgId, twoAgent)).toBeNull();
    expect(connectorItems(one.orgId)).toEqual([]);
    expect(connectorItems(two.orgId)).toEqual([]);
  });
});

describe("the connector item: once per computer per (package, status) per 24 h, from the hub's own snapshot", () => {
  it("reaches the hook's digest as an item (old hooks render text only when items exist), then not again", async () => {
    const ws = await workspace("E1b dedupe");
    const c = await computer(ws);
    const agent = await join(c, "one");
    const first = await digest(c, "one");
    const item = first.body.items.find((i: { type: string }) => i.type === "connector.notice");
    expect(item).toMatchObject({ priority: 2, directed: true });
    expect(first.body.text).toContain(item.summary);
    expect((await digest(c, "one")).body.items.some((i: { type: string }) => i.type === "connector.notice")).toBe(false);
    // A second chat on the SAME computer inside 24 h: nothing new.
    const other = await join(c, "two");
    expect((await digest(c, "two")).body.items.some((i: { type: string }) => i.type === "connector.notice")).toBe(false);
    expect(connectorItems(ws.orgId).map((r) => r.target_agent_id)).toEqual([agent]);
    // 24 h later the same (package, status) is carried once more.
    ageClaims(c.deviceId, 24 * 3600_000 + 1);
    expect((await digest(c, "two")).body.items.some((i: { type: string }) => i.type === "connector.notice")).toBe(true);
    expect(connectorItems(ws.orgId).map((r) => r.target_agent_id)).toEqual([agent, other]);
  });

  it("a new status or a new package is a new item; a re-read with `since` never emits one", async () => {
    const ws = await workspace("E1b status change");
    const c = await computer(ws);
    const agent = await join(c, "s");
    expect((await call("GET", "/v1/awareness?since=0", { key: c.credential, headers: chat("s", { "x-opencadre-resolve-only": "1" }) })).status).toBe(200);
    expect(connectorItems(ws.orgId)).toEqual([]);
    await digest(c, "s"); // no-recent-report
    await call("POST", "/v1/devices/connector-build", { key: c.credential, body: report({ integrity: "modified-or-missing" }) });
    await digest(c, "s"); // check-installation
    servePackage(); // a new package: the same status is new again
    await digest(c, "s");
    const statuses = connectorItems(ws.orgId, agent).map((r) => JSON.parse(r.payload).status);
    expect(statuses).toEqual(["no-recent-report", "check-installation", "check-installation"]);
    const stamps = connectorItems(ws.orgId, agent).map((r) => JSON.parse(r.payload).stamp);
    expect(new Set(stamps).size).toBe(2);
  });

  it("simultaneous chats on one computer: exactly one carries the item", async () => {
    const ws = await workspace("E1b concurrent");
    const c = await computer(ws);
    const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
    for (const id of ids) await join(c, id);
    const answers = await Promise.all(ids.map((id) => digest(c, id)));
    const carried = answers.filter((a) => a.body.items.some((i: { type: string }) => i.type === "connector.notice"));
    expect(carried).toHaveLength(1);
    expect(connectorItems(ws.orgId)).toHaveLength(1);
  });

  it("says what the evidence shows, carries the stamped command, and no credential, device id or installation id", async () => {
    const ws = await workspace("E1b wording");
    const c = await computer(ws);
    const agent = await join(c, "w");
    const pkg = currentCliPackage()!;
    const missing = (await digest(c, "w")).body.text as string;
    expect(missing).toContain("no recent connector report from this computer. Possible causes: helpers that predate build reports; a report that failed or was offline at its checkpoint; a named-agent configuration. This is missing telemetry, not a verdict on the installation.");
    expect(missing).toContain(`npx -y https://hub.example.test/cli/${pkg.stamp}/opencadre-cli.tgz connect --upgrade`);
    for (const forbidden of [/too old/i, /broken/i, /old hooks/i, /outdated/i, /unsupported/i]) expect(missing).not.toMatch(forbidden);
    resetMarker(c.deviceId);
    await call("POST", "/v1/devices/connector-build", { key: c.credential, body: report({ helpers: { "opencadre-config.mjs": H("f") } }) });
    const optional = (await digest(c, "w")).body.text as string;
    expect(optional).toContain("This is an optional update, not a compatibility verdict.");
    expect(optional).toContain("an agent must not approve it");
    const everything = JSON.stringify(connectorItems(ws.orgId, agent)) + missing + optional;
    for (const secret of [c.credential, c.deviceId, "e".repeat(32), agent]) {
      // The agent id is the event's target column, never in the payload text.
      if (secret === agent) expect(JSON.stringify(connectorItems(ws.orgId, agent).map((r) => r.payload))).not.toContain(secret);
      else expect(everything).not.toContain(secret);
    }
  });

  it("no item while the hub has no package to name a command from", async () => {
    const ws = await workspace("E1b no package");
    const c = await computer(ws);
    const agent = await join(c, "np");
    process.env.OPENCADRE_CLI_TARBALL = path.join(fixtureDir, "absent.tgz");
    try {
      expect(maybeEmitConnectorItem(ws.orgId, agent)).toBeNull();
    } finally { process.env.OPENCADRE_CLI_TARBALL = TARBALL; }
    expect(maybeEmitConnectorItem(ws.orgId, agent)).toContain("no recent connector report");
  });

  it("a required entry (fixture policy only) names its feature; the shipped empty policy never does", async () => {
    const ws = await workspace("E1b required");
    const c = await computer(ws);
    const agent = await join(c, "r");
    const old = { "opencadre-config.mjs": H("1"), "opencadre-mcp.mjs": H("3") };
    await call("POST", "/v1/devices/connector-build", { key: c.credential, body: report({ helpers: old }) });
    servePackage({
      schema: 1,
      cohorts: [{ id: "c-fixture", helpers: old, status: "supported", evidence: "tests/connector-previous-bundle.test.ts", contracts: ["identity"] }],
      required: [{ id: "r-fixture", cohorts: ["c-fixture"], class: "security", feature: "per-chat identity on stamp clients", reason: "fixture", decision: "fixture #0", recovery: "connect --upgrade" }],
    });
    try {
      expect(maybeEmitConnectorItem(ws.orgId, agent)).toContain("a security update is required for per-chat identity on stamp clients");
      const devices = await call("GET", "/v1/org/devices", { key: ws.operatorKey });
      expect(devices.body.devices[0].connector).toMatchObject({ status: "security-update-required", requiredFeature: "per-chat identity on stamp clients", cohort: { id: "c-fixture", required: true } });
      // The manifest serves the same snapshot's policy as its additive `compat` field.
      const manifest = await call("GET", "/cli/manifest.json");
      expect(manifest.body.compat.required[0].id).toBe("r-fixture");
    } finally { servePackage(); }
    resetMarker(c.deviceId);
    expect(maybeEmitConnectorItem(ws.orgId, agent)).not.toContain("security update");
    expect((await call("GET", "/cli/manifest.json")).body.compat).toEqual({ schema: 1, cohorts: [], required: [] });
    // A package without a policy, or with a malformed one, serves no compat field at all.
    servePackage(null);
    expect((await call("GET", "/cli/manifest.json")).body).not.toHaveProperty("compat");
    servePackage({ schema: 1, cohorts: [], required: [{ id: "r-bad" }] });
    expect((await call("GET", "/cli/manifest.json")).body).not.toHaveProperty("compat");
    servePackage();
  });
});

describe("every (package, status) claim lives for the whole rolling 24 h (review of #703 at 801bdfec, Olive P2)", () => {
  const itemsOf = (orgId: string) => connectorItems(orgId).map((r) => JSON.parse(r.payload) as { status: string; stamp: string });
  const reportAs = (c: { credential: string }, integrity: string) =>
    call("POST", "/v1/devices/connector-build", { key: c.credential, body: report({ integrity, helpers: { ...TARGET_HELPERS, "opencadre-mcp.mjs": H("c") } }) });

  it("status A -> B -> A inside 24 h on one package: exactly 2 items, and A again only after 24 h", async () => {
    const ws = await workspace("E1b status flip");
    const c = await computer(ws);
    const agent = await join(c, "flip");
    await reportAs(c, "matches-metadata");
    // After the report, so the report is not dated after the emits below.
    const t = Date.now();
    expect(maybeEmitConnectorItem(ws.orgId, agent, t)).toContain("optional update");
    expect(maybeEmitConnectorItem(ws.orgId, agent, t + 1000)).toBeNull();
    await reportAs(c, "modified-or-missing");
    expect(maybeEmitConnectorItem(ws.orgId, agent, t + 2000)).toContain("modified or missing");
    await reportAs(c, "matches-metadata");
    expect(maybeEmitConnectorItem(ws.orgId, agent, t + 3000), "A came back inside 24 h: still claimed").toBeNull();
    expect(itemsOf(ws.orgId).map((p) => p.status)).toEqual(["update-available", "check-installation"]);
    expect(new Set(itemsOf(ws.orgId).map((p) => p.stamp)).size).toBe(1);
    // 24 h after A was claimed, A is carried again, once. (The report is re-sent so it is still recent at that time.)
    const day = 24 * 3600_000;
    const kept = JSON.parse((db.prepare(`SELECT connector_reports FROM devices WHERE id = ?`).get(c.deviceId) as { connector_reports: string }).connector_reports) as Array<Record<string, unknown>>;
    expect(kept.map((r) => r.integrity)).toEqual(["matches-metadata"]);
    db.prepare(`UPDATE devices SET connector_reports = ? WHERE id = ?`)
      .run(JSON.stringify(kept.map((r) => ({ ...r, reportedAt: new Date(t + day - 1).toISOString() }))), c.deviceId);
    expect(maybeEmitConnectorItem(ws.orgId, agent, t + day - 1)).toBeNull();
    expect(maybeEmitConnectorItem(ws.orgId, agent, t + day)).toContain("optional update");
    expect(maybeEmitConnectorItem(ws.orgId, agent, t + day + 1)).toBeNull();
    expect(itemsOf(ws.orgId).map((p) => p.status)).toEqual(["update-available", "check-installation", "update-available"]);
  });

  it("package A -> B -> A inside 24 h with one status: exactly 2 items", async () => {
    const ws = await workspace("E1b package flip");
    const c = await computer(ws);
    const agent = await join(c, "pkgflip");
    const a = servePackage();
    try {
      const aBytes = Buffer.from(a.bytes);
      expect(maybeEmitConnectorItem(ws.orgId, agent)).toContain("no recent connector report");
      const b = servePackage();
      expect(b.stamp).not.toBe(a.stamp);
      expect(maybeEmitConnectorItem(ws.orgId, agent)).toContain("no recent connector report");
      expect(serveBytes(aBytes).stamp).toBe(a.stamp);
      expect(maybeEmitConnectorItem(ws.orgId, agent), "package A came back inside 24 h: still claimed").toBeNull();
      expect(itemsOf(ws.orgId).map((p) => p.stamp)).toEqual([a.stamp, b.stamp]);
      ageClaims(c.deviceId, 24 * 3600_000);
      expect(maybeEmitConnectorItem(ws.orgId, agent)).toContain("no recent connector report");
      expect(itemsOf(ws.orgId).map((p) => p.stamp)).toEqual([a.stamp, b.stamp, a.stamp]);
    } finally { servePackage(); }
  });

  it("at the claim cap a NEW item is refused and no live claim is evicted; expired claims free the room", async () => {
    const { CONNECTOR_DIGEST_MAX_CLAIMS, claimDigestKey } = await import("../src/connector-digest.js");
    const day = 24 * 3600_000;
    const t = 10 * day;
    const keyOf = (i: number) => `${i.toString(16).padStart(12, "0")}:update-available`;
    const full = Object.fromEntries(Array.from({ length: CONNECTOR_DIGEST_MAX_CLAIMS }, (_, i) => [keyOf(i), t - i]));
    const raw = JSON.stringify(full);
    expect(claimDigestKey(raw, "ffffffffffff:update-available", t), "a new key at the cap is refused").toBeNull();
    expect(claimDigestKey(raw, keyOf(0), t), "a live key stays claimed").toBeNull();
    // The oldest claim reaches 24 h: it, and only it, is dropped, and the new key fits.
    const later = t - (CONNECTOR_DIGEST_MAX_CLAIMS - 1) + day;
    const next = JSON.parse(claimDigestKey(raw, "ffffffffffff:update-available", later)!);
    expect(Object.keys(next)).toHaveLength(CONNECTOR_DIGEST_MAX_CLAIMS);
    expect(next).not.toHaveProperty(keyOf(CONNECTOR_DIGEST_MAX_CLAIMS - 1));
    expect(next[keyOf(0)]).toBe(t);
    expect(next["ffffffffffff:update-available"]).toBe(later);
    // Unreadable claims refuse every emit rather than reading as "nothing claimed".
    for (const bad of ["not json", "[]", JSON.stringify({ "../x": 1 }), JSON.stringify({ [keyOf(0)]: "1" })]) {
      expect(claimDigestKey(bad, "ffffffffffff:update-available", t), bad).toBeNull();
    }
    // Through the hub: a computer whose claims are full gets no item, and its claims are unchanged.
    const ws = await workspace("E1b claim cap");
    const c = await computer(ws);
    const agent = await join(c, "cap");
    const now = Date.now();
    const held = JSON.stringify(Object.fromEntries(Object.keys(full).map((k) => [k, now])));
    db.prepare(`UPDATE devices SET connector_digest = ? WHERE id = ?`).run(held, c.deviceId);
    expect(maybeEmitConnectorItem(ws.orgId, agent, now)).toBeNull();
    expect(claimsOf(c.deviceId)).toBe(held);
    expect(connectorItems(ws.orgId)).toEqual([]);
  });

  it("a failed event insert leaves the claims exactly as they were", async () => {
    const ws = await workspace("E1b rollback");
    const c = await computer(ws);
    const agent = await join(c, "rb");
    const before = claimsOf(c.deviceId);
    db.exec("CREATE TRIGGER e1b_deny_notice BEFORE INSERT ON events WHEN NEW.type = 'connector.notice' BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    try {
      expect(() => maybeEmitConnectorItem(ws.orgId, agent)).toThrow(/injected/);
    } finally { db.exec("DROP TRIGGER e1b_deny_notice"); }
    expect(claimsOf(c.deviceId)).toBe(before);
    expect(maybeEmitConnectorItem(ws.orgId, agent)).toContain("no recent connector report");
  });
});

describe("hub-side refusal counts (addendum §4.1, amendment 2 §4.1)", () => {
  it("counts no-session and ambiguous-session refusals on the computer's own row, and the console shows them as observed", async () => {
    const ws = await workspace("E1b refusals");
    const c = await computer(ws), quiet = await computer(ws, "Quiet");
    // no session: a resolve-only hook for a chat the hub has never seen.
    const noSession = await call("GET", "/v1/awareness", { key: c.credential, headers: chat("never-joined", { "x-opencadre-resolve-only": "1" }) });
    expect(noSession.status).toBe(401);
    // ambiguous: two live chats of the same tool in the project, and a resolve-only caller asking to adopt one.
    await join(c, "live-1");
    await join(c, "live-2");
    const ambiguous = await call("GET", "/v1/awareness", { key: c.credential, headers: chat("adopter", { "x-opencadre-resolve-only": "1", "x-opencadre-adopt-live": "1" }) });
    expect(ambiguous.status).toBe(409);
    const row = db.prepare(`SELECT connector_refusals FROM devices WHERE id = ?`).get(c.deviceId) as { connector_refusals: string };
    const stored = JSON.parse(row.connector_refusals);
    expect(Object.keys(stored).sort()).toEqual(["ambiguous_session", "no_session"]);
    for (const leak of ["never-joined", "adopter", PROJECT.key, c.credential]) expect(row.connector_refusals).not.toContain(leak);
    expect((db.prepare(`SELECT connector_refusals FROM devices WHERE id = ?`).get(quiet.deviceId) as { connector_refusals: string }).connector_refusals).toBe("{}");
    const view = await call("GET", "/v1/org/devices", { key: ws.operatorKey });
    const mine = view.body.devices.find((d: { deviceId: string }) => d.deviceId === c.deviceId);
    expect(mine.connector.refusals).toEqual({ noSession: 1, ambiguousSession: 1, selfReportedStamp: null });
    expect(view.body.devices.find((d: { deviceId: string }) => d.deviceId === quiet.deviceId).connector.refusals).toBeNull();
    expect(view.text).not.toMatch(/broken|refusing/i);
  });

  it("a refusal that is not one of the two reasons, or that never reaches a computer, counts nothing", async () => {
    const ws = await workspace("E1b refusals other");
    const c = await computer(ws);
    // Not an enabled project: refused before any session lookup, and not one of the two reasons.
    const other = await call("GET", "/v1/awareness", { key: c.credential, headers: { ...chat("x"), "x-opencadre-project": "github.com/acme/not-enabled" } });
    expect(other.status).toBe(403);
    // No session header at all: the credential is never looked up.
    expect((await call("GET", "/v1/awareness", { key: c.credential })).status).toBe(401);
    expect((db.prepare(`SELECT connector_refusals FROM devices WHERE id = ?`).get(c.deviceId) as { connector_refusals: string }).connector_refusals).toBe("{}");
  });

  it("removing the computer clears its counts", async () => {
    const ws = await workspace("E1b refusals removed");
    const c = await computer(ws);
    await call("GET", "/v1/awareness", { key: c.credential, headers: chat("ghost", { "x-opencadre-resolve-only": "1" }) });
    expect((db.prepare(`SELECT connector_refusals FROM devices WHERE id = ?`).get(c.deviceId) as { connector_refusals: string }).connector_refusals).not.toBe("{}");
    expect((await call("DELETE", `/v1/org/devices/${c.deviceId}`, { key: ws.operatorKey })).status).toBe(200);
    expect((db.prepare(`SELECT connector_refusals FROM devices WHERE id = ?`).get(c.deviceId) as { connector_refusals: string }).connector_refusals).toBe("{}");
  });
});
