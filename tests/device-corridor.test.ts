import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { READ_ONLY_CODE, READ_TOOLS, assignPlan, readOnlyRefusal } from "../src/billing.js";
import { pauseWorkspace } from "../src/kill-switch.js";

/** THE DEVICE-DIRECT CORRIDOR (board 1a8eca9d, from lane 2's review of #387).
 *
 * A lapsed workspace is read-only: reads keep working, writes are refused with 402 (src/billing.ts).
 * That rule is applied by `admitAgent` (src/rest.ts:167) -- but a DEVICE credential does not have to
 * go through it. Three routes call `checkDeviceSession`/`computerFor` directly and never reach
 * `admitAgent` at all, so a device credential redeemed while the workspace was LIVE keeps WRITING
 * after it lapses. Measured on main before this test existed: enable-current created a projects row,
 * devices/tools rewrote the devices row, and sessions/join added a kind:"session" agent PER DISTINCT
 * SESSION ID (2 -> 3 -> 4 across two lapsed joins).
 *
 * The assertion that carries the fix is not the 402. It is that the 402 did not happen AFTER a row
 * was written -- a refusal that performs the write and then reports it is a refusal in the verdict
 * only. So every route below is checked twice: the status, and the ROW COUNT.
 *
 * The second control is the one that keeps the fix from being "pause under a new name": GET
 * /v1/devices/me must still be 200 on the lapsed workspace, and an EXISTING session must still
 * resolve. A read-only workspace creates no NEW session agent row; it does not lose the session a
 * read-capable client is already using. */

let server: ReturnType<typeof app.listen>;
let base: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// A per-call client address, so a rate limiter shared by every case in this file cannot turn one
// case's traffic into another case's 429.
let ipCounter = 0;
const nextIp = () => `10.81.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function call(method: string, path: string, { key, body, headers = {} }: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-forwarded-for": nextIp(),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

const PROJECT = { key: "github.com/acme/corridor", name: "Corridor" };
/** A project key this device has never enabled, so enable-current has a row to CREATE -- which is
 * the shape the defect was measured in (projects rows [] -> 1). */
const OTHER_PROJECT = { key: "github.com/acme/other", name: "Other" };

const chat = (sessionId: string, project: { key: string; name?: string } = PROJECT) => ({
  "x-opencadre-session": sessionId,
  "x-opencadre-client": "claude-code",
  "x-opencadre-project": project.key,
  ...(project.name ? { "x-opencadre-project-name": project.name } : {}),
});

const sessionAgents = (orgId: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND kind = 'session'`).get(orgId) as { n: number }).n;
const projectRows = (orgId: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE org_id = ?`).get(orgId) as { n: number }).n;
const deviceTools = (deviceId: string) => {
  const row = db.prepare(`SELECT tools, last_seen_at FROM devices WHERE id = ?`).get(deviceId) as { tools: string | null; last_seen_at: string | null } | undefined;
  return row ? (row.tools === null ? null : (JSON.parse(row.tools) as string[])) : undefined;
};

/** `session.joined` events that announce a REVIVAL. `revived:true` is written in exactly one place in
 * this repo -- the revive branch at src/devices.ts:565-578, the payload itself at :575 (`git grep -n
 * revived -- src/`; the creation path writes `revived:false` at :605) -- so this counts exactly the act
 * a refusal must not have performed. The payload is parsed rather than LIKE-matched: it is JSON written
 * elsewhere, and a substring test would be satisfied by a key order or a spacing this file does not
 * control. */
const revivedEvents = (orgId: string) =>
  (db.prepare(`SELECT payload FROM events WHERE org_id = ? AND type = 'session.joined'`).all(orgId) as { payload: string }[])
    .filter((r) => (JSON.parse(r.payload) as { revived?: boolean }).revived === true).length;

/** Move the workspace's clock. This column IS what the enforcement path reads, so setting it is
 * setting the subject of the test rather than routing around it (tests/billing.test.ts). */
const lapse = (orgId: string) =>
  db.prepare(`UPDATE organizations SET trial_ends_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), orgId);

/** A computer that finished the connect flow: minted, redeemed, project enabled and one session
 * joined -- ALL OF IT WHILE LIVE. That order is forced, not chosen: `POST /v1/connect/redeem` is
 * itself refused on a lapsed workspace (src/devices.ts:164), so a fixture built after the lapse
 * would fail to exist rather than fail to be refused. */
async function connectedComputer(name: string) {
  const { orgId } = createOrganization(name);
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const minted = await call("POST", "/v1/org/devices", { key: operator.apiKey, body: { name: "Laptop" } });
  expect(minted.status).toBe(201);
  const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: minted.body.code } });
  expect(redeemed.status).toBe(201);
  const credential = redeemed.body.deviceCredential as string;
  const deviceId = minted.body.deviceId as string;

  const enabled = await call("PUT", "/v1/devices/projects/enable-current", { key: credential, headers: chat("boot", PROJECT) });
  expect(enabled.status, "the fixture enables its project while live").toBe(200);
  const joined = await call("POST", "/v1/sessions/join", { key: credential, headers: chat("live-1", PROJECT) });
  expect(joined.status, "the fixture joins one session while live").toBe(201);

  return { orgId, operatorKey: operator.apiKey, operatorId: operator.agentId, credential, deviceId };
}

/** Three routes, in one place, so a test that guards them cannot guard two by accident. */
const corridor = (c: { credential: string }, sessionId = "probe-1", project = OTHER_PROJECT) => ({
  "PUT /v1/devices/projects/enable-current": () =>
    call("PUT", "/v1/devices/projects/enable-current", { key: c.credential, headers: chat(sessionId, project) }),
  "POST /v1/devices/tools": () =>
    call("POST", "/v1/devices/tools", { key: c.credential, body: { tools: ["codex"] } }),
  "POST /v1/sessions/join": () =>
    call("POST", "/v1/sessions/join", { key: c.credential, headers: chat(sessionId, project) }),
});

describe("the device-direct corridor", () => {
  it("LIVE still succeeds on all three routes -- the fixture is valid, so the refusals below mean something", async () => {
    const c = await connectedComputer("Corridor Live");
    for (const [name, hit] of Object.entries(corridor(c, "live-2", OTHER_PROJECT))) {
      const res = await hit();
      expect(res.status, `${name} while live`).toBe(name === "POST /v1/sessions/join" ? 201 : 200);
    }
    // "live-1" from the fixture plus "live-2" here: enable-current and devices/tools create no agent,
    // so the live count is exactly the number of distinct session ids that have joined.
    expect(sessionAgents(c.orgId)).toBe(2);
  });

  it("refuses PUT /v1/devices/projects/enable-current on a lapsed workspace, and creates no projects row", async () => {
    const c = await connectedComputer("Corridor Enable");
    const before = projectRows(c.orgId);
    lapse(c.orgId);

    const res = await call("PUT", "/v1/devices/projects/enable-current", { key: c.credential, headers: chat("probe", OTHER_PROJECT) });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe(READ_ONLY_CODE);
    expect(res.body.readOnly).toBe(true);
    expect(projectRows(c.orgId), "the refusal must not create the row it was refusing to create").toBe(before);
  });

  it("refuses POST /v1/devices/tools on a lapsed workspace, and does not rewrite the devices row", async () => {
    const c = await connectedComputer("Corridor Tools");
    const before = db.prepare(`SELECT tools, last_seen_at FROM devices WHERE id = ?`).get(c.deviceId) as { tools: string | null; last_seen_at: string | null };
    lapse(c.orgId);

    const res = await call("POST", "/v1/devices/tools", { key: c.credential, body: { tools: ["claude-code", "codex"] } });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe(READ_ONLY_CODE);
    const after = db.prepare(`SELECT tools, last_seen_at FROM devices WHERE id = ?`).get(c.deviceId) as { tools: string | null; last_seen_at: string | null };
    expect(after.tools, "tools must be untouched").toBe(before.tools);
    expect(after.last_seen_at, "last_seen_at must be untouched").toBe(before.last_seen_at);
    expect(deviceTools(c.deviceId), "tools must never have been recorded at all").toBeNull();
  });

  it("refuses POST /v1/sessions/join on a lapsed workspace, and adds no session agent", async () => {
    const c = await connectedComputer("Corridor Join");
    const before = sessionAgents(c.orgId);
    lapse(c.orgId);

    const first = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("probe-a", PROJECT) });
    expect(first.status).toBe(402);
    expect(first.body.code).toBe(READ_ONLY_CODE);

    // The defect grew by one row per DISTINCT session id, so one refusal is not enough to pin it.
    const second = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("probe-b", PROJECT) });
    expect(second.status).toBe(402);
    expect(sessionAgents(c.orgId), "two lapsed joins must add zero agents").toBe(before);
  });

  it("keeps GET /v1/devices/me at 200 on a lapsed workspace -- reads keep working", async () => {
    const c = await connectedComputer("Corridor Reads");
    lapse(c.orgId);

    const res = await call("GET", "/v1/devices/me", { key: c.credential });
    expect(res.status, "the read the corridor fix must not break").toBe(200);
    expect(res.body.deviceId).toBe(c.deviceId);
  });

  it("still resolves an EXISTING session on a lapsed workspace, so a read-capable client keeps its session", async () => {
    const c = await connectedComputer("Corridor Existing");
    const before = sessionAgents(c.orgId);
    lapse(c.orgId);

    // "live-1" is the session the fixture joined while live. It is a session, not a NEW session.
    const res = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("live-1", PROJECT) });
    expect(res.status, "an existing session is a read, and reads keep working").toBe(200);
    expect(res.body.created).toBe(false);
    expect(sessionAgents(c.orgId), "resolving an existing session creates no row").toBe(before);
  });

  it("refuses to REVIVE an ended session on a lapsed workspace -- the one path above the refusal that is not a read", async () => {
    // The revive branch (src/devices.ts:565-578) sits ABOVE the billing refusal, and it is not a read:
    // it clears ended_at, takes the seat back and emits session.joined{revived:true}. A lapsed workspace
    // keeps serving a session that is ALREADY LIVE (the test above); bringing a dead one back is the
    // same kind of act as creating one, and it is reachable from the same lapsed join -- the caller
    // computes the refusal at src/devices.ts:672 and passes it in at :673, and this branch returns
    // before anything reads it.
    const c = await connectedComputer("Corridor Revive");
    const ended = await call("POST", "/v1/sessions/leave", { key: c.credential, headers: chat("live-1", PROJECT) });
    expect(ended.status, "the fixture ends its own session while the workspace is still live").toBe(200);

    const agentId = (db.prepare(`SELECT id FROM agents WHERE org_id = ? AND kind = 'session'`).get(c.orgId) as { id: string }).id;
    const endedAt = () => (db.prepare(`SELECT ended_at FROM agents WHERE id = ?`).get(agentId) as { ended_at: string | null }).ended_at;
    const before = endedAt();
    // Premises, asserted rather than assumed: an ENDED row is what puts this request on the revive
    // branch at all (a live one returns at :549), and sessionTtlMs() is 12h by default, so an ending
    // made here is inside the TTL by a margin no clock can close.
    expect(before, "the session must be ENDED, or this request takes the resolve branch instead").not.toBeNull();
    expect(revivedEvents(c.orgId), "nothing has revived this session yet").toBe(0);
    lapse(c.orgId);

    const res = await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("live-1", PROJECT) });
    expect(res.status, "reviving a dead session on a lapsed workspace is a write").toBe(402);
    expect(res.body.code).toBe(READ_ONLY_CODE);
    expect(res.body.readOnly).toBe(true);
    expect(endedAt(), "a refusal that revives the row and then reports it is a refusal in the verdict only").toBe(before);
    expect(revivedEvents(c.orgId), "and it must not announce a revival it refused to perform").toBe(0);
  });

  it("creates no session agent on a lapsed workspace through the general middleware either", async () => {
    // `requireAgentAuth` (src/rest.ts:136) resolves the device session BEFORE `admitAgent` applies the
    // billing guard, so a request on any ordinary route would create the row and then be refused.
    // Guarding only the three named routes would leave this open.
    const c = await connectedComputer("Corridor Middleware");
    const before = sessionAgents(c.orgId);
    lapse(c.orgId);

    const res = await call("POST", "/v1/tasks", {
      key: c.credential,
      headers: chat("mid-1", PROJECT),
      body: { title: "written by a lapsed device" },
    });
    expect(res.status).toBe(402);
    expect(sessionAgents(c.orgId), "the general middleware must not create a session agent either").toBe(before);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ?`).get(c.orgId) as { n: number }).n).toBe(0);
  });

  it("is still 423 on all three routes while the workspace is PAUSED -- the corridor fix changes nothing about pause", async () => {
    const c = await connectedComputer("Corridor Paused");
    pauseWorkspace(c.orgId, { id: c.operatorId, name: "Operator" });

    for (const [name, hit] of Object.entries(corridor(c, "paused-1"))) {
      const res = await hit();
      expect(res.status, `${name} while paused`).toBe(423);
    }
  });

  it("still lets a device END its own session on a lapsed workspace -- a deliberate exception, pinned here", async () => {
    // POST /v1/sessions/leave is a fourth device-direct route that never reaches admitAgent
    // (src/rest.ts:871 -> leaveDeviceSession, src/devices.ts:804), and it is left UNGUARDED on purpose.
    // The rule this fix enforces is "a read-only workspace creates no NEW session agent row"; leave
    // creates nothing and destroys nothing -- it sets ended_at, which is the same reclassification the
    // idle sweep already performs on every workspace. Refusing it would trap a client in a session it
    // is trying to leave, on a workspace where nothing else works, and there is no escalation in
    // ending your own seat. Pinned so a later reader finds a decision rather than an oversight.
    const c = await connectedComputer("Corridor Leave");
    lapse(c.orgId);

    const res = await call("POST", "/v1/sessions/leave", { key: c.credential, headers: chat("live-1", PROJECT) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ended: true });
    expect(sessionAgents(c.orgId), "leaving ends a session; it does not add one").toBe(1);
  });

  it("reverses completely when the workspace is put back on a plan", async () => {
    const c = await connectedComputer("Corridor Reversal");
    lapse(c.orgId);
    expect((await call("POST", "/v1/devices/tools", { key: c.credential, body: { tools: ["codex"] } })).status).toBe(402);

    assignPlan(c.orgId, "pro");
    expect((await call("POST", "/v1/devices/tools", { key: c.credential, body: { tools: ["codex"] } })).status, "paying again resumes writes").toBe(200);
    expect((await call("POST", "/v1/sessions/join", { key: c.credential, headers: chat("after-pay", PROJECT) })).status).toBe(201);
  });
});

describe("ack_event is a read of the caller's own bookkeeping", () => {
  // Board 1a8eca9d finding 3. get_awareness TELLS an agent to "Ack what you've handled with
  // ack_event(seq, outcome)", and every reader of event_deliveries is scoped `d.agent_id = ?`
  // (src/deliveries.ts:59/71/94), so acking changes only which of the CALLER's OWN rows it has
  // already seen. Refusing it on a lapsed workspace leaves that advice un-followable and a
  // non-message kind directed event (task.accepted, approval.*, ...) with no read-based closure at
  // all -- SUBJECT_STILL_OPEN (src/deliveries.ts:31) is type-gated -- so it returns at every
  // checkpoint forever. Same argument READ_TOOLS already makes for consume_messages.

  it("lists ack_event as a read tool", () => {
    expect(READ_TOOLS.has("ack_event")).toBe(true);
  });

  it("is not refused on a lapsed workspace, while a genuine write still is", () => {
    const { orgId } = createOrganization("Ack Event Read Tool");
    db.prepare(`UPDATE organizations SET trial_ends_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), orgId);

    expect(readOnlyRefusal(orgId, "ack_event")).toBeNull();
    expect(readOnlyRefusal(orgId, "send_message")?.status).toBe(402);
    expect(readOnlyRefusal(orgId, "POST")?.status).toBe(402);
  });
});
