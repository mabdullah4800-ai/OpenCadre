import type { AddressInfo } from "node:net";
import http from "node:http";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.OPENCADRE_SIGNUP = "open";
process.env.OPENCADRE_WEBHOOK_ALLOW_PRIVATE = "1";
const { generateVapidKeys, fromB64url, b64url } = await import("../src/web-push.js");
const vapid = generateVapidKeys();
process.env.OPENCADRE_VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.OPENCADRE_VAPID_PRIVATE_KEY = vapid.privateKey;
process.env.OPENCADRE_VAPID_SUBJECT = "mailto:ops@example.com";

const { app } = await import("../src/rest.js");
const { db } = await import("../src/db.js");
const { upsertPerson, createSession, createWorkspace, createInvite, acceptInvite, getMembership } = await import("../src/accounts.js");
const { registerAgent } = await import("../src/service.js");
const { requestApproval } = await import("../src/approvals.js");
const { validateSubscription, MAX_DEVICES_PER_PERSON, APPROVAL_PUSHES_PER_WORKSPACE_PER_MIN } = await import("../src/push.js");

// --- A fake browser push service that records what it receives -------------------------
type Received = { path: string; headers: http.IncomingHttpHeaders; body: Buffer };
let received: Received[] = [];
const statusFor = new Map<string, number>();
let pushService: http.Server;
let pushBase: string;
let hub: http.Server;
let hubBase: string;

beforeAll(async () => {
  pushService = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(statusFor.get(req.url!) ?? 201).end();
  });
  await new Promise<void>((r) => pushService.listen(0, r));
  pushBase = `http://127.0.0.1:${(pushService.address() as AddressInfo).port}`;
  hub = http.createServer(app);
  await new Promise<void>((r) => hub.listen(0, r));
  hubBase = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => pushService.close(() => r()));
  await new Promise<void>((r) => hub.close(() => r()));
});
beforeEach(() => {
  received = [];
  statusFor.clear();
});

/** A browser's side of a subscription: its key pair and auth secret, and a decryptor for what arrives. */
function device(path: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, path.length);
  const subscription = { endpoint: `${pushBase}${path}`, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) } };
  const decrypt = (body: Buffer) => {
    const salt = body.subarray(0, 16);
    const idLen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idLen);
    const secret = ecdh.computeSecret(asPublic);
    const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync("sha256", secret, auth, keyInfo, 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const payload = body.subarray(21 + idLen);
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(payload.subarray(payload.length - 16));
    const plain = Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
    expect(plain.at(-1)).toBe(0x02);
    return JSON.parse(plain.subarray(0, -1).toString());
  };
  return { subscription, decrypt };
}

let seq = 0;
function person(label: string) {
  const p = upsertPerson({ id: `sub-${label}-${++seq}`, email: `${label}${seq}@example.com`, emailVerified: true, name: `${label} ${seq}`, avatarUrl: null });
  return { person: p, cookie: `oc_session=${createSession(p.id).token}` };
}

function workspace() {
  const owner = person("owner");
  const { orgId } = createWorkspace(owner.person, `Push Org ${seq}`);
  const ownerAgent = getMembership(orgId, owner.person.id)!.agent_id;
  const join = (role: "admin" | "member") => {
    const who = person(role);
    const { token } = createInvite(orgId, { id: ownerAgent, name: "owner" }, role, null);
    acceptInvite(token, who.person);
    return { ...who, agentId: getMembership(orgId, who.person.id)!.agent_id };
  };
  const admin = join("admin");
  const member = join("member");
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const coder = registerAgent(orgId, "Coder");
  return { orgId, owner, admin, member, operator, coder };
}

const api = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const { cookie, headers, ...rest } = init;
  return fetch(`${hubBase}${path}`, { ...rest, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers } });
};

async function addDevice(cookie: string, path: string) {
  const d = device(path);
  const res = await api("/v1/push/devices", { method: "POST", cookie, body: JSON.stringify({ ...d.subscription, deviceLabel: "Pixel" }) });
  expect(res.status).toBe(201);
  return d;
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("phone notification devices", () => {
  it("publishes the VAPID public key, and only a signed-in person can add or list devices", async () => {
    expect(await (await api("/v1/push/config")).json()).toEqual({ enabled: true, publicKey: vapid.publicKey });
    const d = device("/anon");
    expect((await api("/v1/push/devices", { method: "POST", body: JSON.stringify(d.subscription) })).status).toBe(401);
    expect((await api("/v1/push/devices")).status).toBe(401);
    const { cookie } = person("solo");
    expect((await fetch(`${hubBase}/v1/push/devices`, { method: "POST", headers: { cookie, "content-type": "text/plain" }, body: JSON.stringify(d.subscription) })).status).toBe(415);
  });

  it("rejects malformed subscriptions and lists, moves and removes devices", async () => {
    const a = person("a");
    const b = person("b");
    const d = device("/shared-browser");
    const bad = [
      { ...d.subscription, keys: { ...d.subscription.keys, p256dh: b64url(Buffer.alloc(65)) } },
      { ...d.subscription, keys: { ...d.subscription.keys, auth: "short" } },
      { ...d.subscription, endpoint: "not a url" },
      { keys: d.subscription.keys },
    ];
    for (const body of bad) expect((await api("/v1/push/devices", { method: "POST", cookie: a.cookie, body: JSON.stringify(body) })).status).toBe(400);

    expect((await api("/v1/push/devices", { method: "POST", cookie: a.cookie, body: JSON.stringify(d.subscription) })).status).toBe(201);
    const listed = await (await api("/v1/push/devices", { cookie: a.cookie })).json();
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0]).toMatchObject({ endpoint: d.subscription.endpoint, service: "127.0.0.1", failing: false });

    // The same browser signs in as b: the device follows the new person.
    expect((await api("/v1/push/devices", { method: "POST", cookie: b.cookie, body: JSON.stringify(d.subscription) })).status).toBe(201);
    expect((await (await api("/v1/push/devices", { cookie: a.cookie })).json()).devices).toHaveLength(0);

    // a can't remove b's device; b can.
    expect((await api("/v1/push/devices", { method: "DELETE", cookie: a.cookie, body: JSON.stringify({ endpoint: d.subscription.endpoint }) })).status).toBe(404);
    expect((await api("/v1/push/devices", { method: "DELETE", cookie: b.cookie, body: JSON.stringify({ endpoint: d.subscription.endpoint }) })).status).toBe(204);
    expect((await (await api("/v1/push/devices", { cookie: b.cookie })).json()).devices).toHaveLength(0);
  });

  it(`keeps at most ${MAX_DEVICES_PER_PERSON} devices per person, dropping the oldest`, async () => {
    const p = person("many");
    const first = device("/many-0");
    await api("/v1/push/devices", { method: "POST", cookie: p.cookie, body: JSON.stringify(first.subscription) });
    for (let i = 1; i <= MAX_DEVICES_PER_PERSON; i++) {
      await new Promise((r) => setTimeout(r, 2));
      await addDevice(p.cookie, `/many-${i}`);
    }
    const devices = (await (await api("/v1/push/devices", { cookie: p.cookie })).json()).devices as Array<{ endpoint: string }>;
    expect(devices).toHaveLength(MAX_DEVICES_PER_PERSON);
    expect(devices.map((x) => x.endpoint)).not.toContain(first.subscription.endpoint);
  });

  it("outside development, only https endpoints at the real browser push services are accepted", () => {
    const keys = device("/x").subscription.keys;
    process.env.OPENCADRE_WEBHOOK_ALLOW_PRIVATE = "0";
    try {
      expect(validateSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys }).ok).toBe(true);
      expect(validateSubscription({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc", keys }).ok).toBe(true);
      expect(validateSubscription({ endpoint: "https://web.push.apple.com/abc", keys }).ok).toBe(true);
      expect(validateSubscription({ endpoint: "https://wns2-par02p.notify.windows.com/w/?token=abc", keys }).ok).toBe(true);
      for (const endpoint of ["http://fcm.googleapis.com/fcm/send/abc", "https://127.0.0.1/push", "https://169.254.169.254/latest", "https://evil.example.com/push", "https://fcm.googleapis.com.evil.example/x", "https://push.apple.com.evil.example/x"]) {
        expect(validateSubscription({ endpoint, keys }).ok, endpoint).toBe(false);
      }
    } finally {
      process.env.OPENCADRE_WEBHOOK_ALLOW_PRIVATE = "1";
    }
  });
});

describe("clearance requests reach the deciders' phones", () => {
  it("an Operator-bound request notifies owners and admins (encrypted, VAPID-signed), not members", async () => {
    const w = workspace();
    const ownerPhone = await addDevice(w.owner.cookie, "/owner-phone");
    const adminPhone = await addDevice(w.admin.cookie, "/admin-phone");
    await addDevice(w.member.cookie, "/member-phone");

    const longAction = `rm -rf ./dist && ${"x".repeat(300)}`;
    const approval = await requestApproval(w.orgId, { id: w.coder.agentId, name: "Coder" }, { action: longAction, risk: "high", approver: "Operator", category: "rm-rf" });
    await until(() => received.length >= 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(received.map((r) => r.path).sort()).toEqual(["/admin-phone", "/owner-phone"]);

    const toOwner = received.find((r) => r.path === "/owner-phone")!;
    expect(toOwner.headers).toMatchObject({ "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "600", urgency: "high" });
    expect(toOwner.headers.authorization).toMatch(new RegExp(`^vapid t=[^.]+\\.[^.]+\\.[^,]+, k=${vapid.publicKey}$`));
    const claims = JSON.parse(fromB64url(toOwner.headers.authorization!.split(" t=")[1].split(".")[1]).toString());
    expect(claims.aud).toBe(pushBase);
    // The push service sees ciphertext only.
    expect(toOwner.body.toString("latin1")).not.toContain("rm -rf");

    const message = ownerPhone.decrypt(toOwner.body);
    expect(message).toMatchObject({
      type: "approval",
      approvalId: approval.id,
      workspaceId: w.orgId,
      risk: "high",
      tag: `approval-${approval.id}`,
      url: `/app/?workspace=${w.orgId}#approval-${approval.id}`,
    });
    expect(message.title).toMatch(/^Approval needed · Push Org/);
    expect(message.body.startsWith("Coder wants to run: rm -rf ./dist && ")).toBe(true);
    expect(message.body.length).toBeLessThan(200);
    expect(adminPhone.decrypt(received.find((r) => r.path === "/admin-phone")!.body).approvalId).toBe(approval.id);
  });

  it("a request naming a member as approver notifies only that member", async () => {
    const w = workspace();
    await addDevice(w.owner.cookie, "/o2");
    await addDevice(w.member.cookie, "/m2");
    const memberName = (db.prepare(`SELECT name FROM agents WHERE id = ?`).get(w.member.agentId) as { name: string }).name;
    await requestApproval(w.orgId, { id: w.coder.agentId, name: "Coder" }, { action: "terraform destroy", risk: "high", approver: memberName });
    await until(() => received.length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(received.map((r) => r.path)).toEqual(["/m2"]);
  });

  it("notify-only records send nothing", async () => {
    const w = workspace();
    await addDevice(w.owner.cookie, "/o3");
    await requestApproval(w.orgId, { id: w.coder.agentId, name: "Coder" }, { action: "git push --force", notifyOnly: true, approver: "Operator" });
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toEqual([]);
  });

  it("drops a device the push service says is gone, and marks one that errors as failing", async () => {
    const w = workspace();
    await addDevice(w.owner.cookie, "/gone");
    await addDevice(w.admin.cookie, "/flaky");
    statusFor.set("/gone", 410);
    statusFor.set("/flaky", 500);
    await requestApproval(w.orgId, { id: w.coder.agentId, name: "Coder" }, { action: "DROP TABLE users", risk: "high" });
    await until(() => received.length >= 2);
    await until(() => (db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?`).get(`${pushBase}/gone`) as { n: number }).n === 0);
    await until(() => ((db.prepare(`SELECT failure_count FROM push_subscriptions WHERE endpoint = ?`).get(`${pushBase}/flaky`) as { failure_count: number } | undefined)?.failure_count ?? 0) === 1);
    const flaky = (await (await api("/v1/push/devices", { cookie: w.admin.cookie })).json()).devices;
    expect(flaky[0].failing).toBe(true);
  });

  it(`a workspace whose agents loop on requests sends at most ${APPROVAL_PUSHES_PER_WORKSPACE_PER_MIN} phone pushes a minute`, async () => {
    const w = workspace();
    await addDevice(w.owner.cookie, "/loop");
    const other = workspace();
    await addDevice(other.owner.cookie, "/other-org");
    for (let i = 0; i < APPROVAL_PUSHES_PER_WORKSPACE_PER_MIN + 5; i++) {
      await requestApproval(w.orgId, { id: w.coder.agentId, name: "Coder" }, { action: `rm -rf ./cache-${i}`, risk: "medium" });
    }
    await until(() => received.length >= APPROVAL_PUSHES_PER_WORKSPACE_PER_MIN);
    // Another workspace isn't affected by the first one's burst.
    await requestApproval(other.orgId, { id: other.coder.agentId, name: "Coder" }, { action: "rm -rf ./x", risk: "medium" });
    await until(() => received.some((r) => r.path === "/other-org"));
    await new Promise((r) => setTimeout(r, 200));
    expect(received.filter((r) => r.path === "/loop")).toHaveLength(APPROVAL_PUSHES_PER_WORKSPACE_PER_MIN);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND status = 'pending'`).get(w.orgId) as { n: number }).n).toBe(APPROVAL_PUSHES_PER_WORKSPACE_PER_MIN + 5);
  });

  it("a test notification goes only to the caller's own devices, and is rate limited", async () => {
    const a = person("tester");
    const other = person("bystander");
    const mine = await addDevice(a.cookie, "/test-mine");
    await addDevice(other.cookie, "/test-other");
    const res = await api("/v1/push/test", { method: "POST", cookie: a.cookie, body: "{}" });
    expect(await res.json()).toEqual({ sent: 1, gone: 0, failed: 0 });
    expect(received.map((r) => r.path)).toEqual(["/test-mine"]);
    expect(mine.decrypt(received[0].body)).toMatchObject({ type: "test", url: "/app/" });
    await api("/v1/push/test", { method: "POST", cookie: a.cookie, body: "{}" });
    await api("/v1/push/test", { method: "POST", cookie: a.cookie, body: "{}" });
    expect((await api("/v1/push/test", { method: "POST", cookie: a.cookie, body: "{}" })).status).toBe(429);
  });
});
