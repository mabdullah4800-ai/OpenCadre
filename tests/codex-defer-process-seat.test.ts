// A stamped Codex process never joins the roster itself: two chats are two agents, not four.
//
// THE BAR (docs/planning/LAUNCH-CLIENT-GATE.md §1 row 2): "Every chat is its own agent on the roster. Two chats on one
// machine are two agents, never one." MEASURED LIVE 2026-09-22 (HARNESS-CODEX.md §6.2 run I2): with the stamp
// trusted, two Codex chats were two agents AND each Codex process also joined as a "process seat" at launch, because
// its initialize went out under the process's own seat. The roster listed four Codex agents for two chats.
//
// THE FIX: once the stamp is trusted, the proxy sends its startup traffic with DEFER_SEAT_HEADER and the hub answers
// it statelessly under no agent (src/devices.ts checkDeviceWithoutSeat). The process's own seat is opened only by an
// UNSTAMPED tool call. Ruling #16116 ("a client whose only creator is the proxy still creates") holds "until a
// chat-scoped id exists"; the trusted stamp IS that id, and the untrusted arm below keeps the ruling's behaviour.
//
// Every describe has an arm that fails without the change, named in its comments.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFER_SEAT_HEADER, STAMP_FIELD, mintStamp } from "../scripts/opencadre-config.mjs";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const PROJECT_KEY = "local:defer-seat-proj";
let hub: Awaited<ReturnType<typeof startHub>>;
let operatorKey: string;
let deviceId: string;
let project: string;
const proxies: ProxyProcess[] = [];

/** A home connected for Codex against the test hub; `trusted` records Codex trust for the stamp where connect put it. */
async function connectedHome(trusted: boolean) {
  const home = tempDir("defer-seat-home-");
  const minted = await mintDevice(hub.url, operatorKey, "codex");
  const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "codex"], childEnv(home));
  expect(connected.code, connected.err).toBe(0);
  if (trusted) trustStamp(home);
  return { home, deviceId: minted.deviceId, proxyScript: path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs") };
}

/** Codex's own positional trust record for the stamp entry connect installed (the format doctor.mjs reads). */
function trustStamp(home: string) {
  const hooksFile = path.join(home, ".codex", "hooks.json");
  const groups = JSON.parse(readFileSync(hooksFile, "utf8")).hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
  const group = groups.findIndex((g) => g.hooks.some((h) => h.command.includes("opencadre-session-stamp")));
  expect(group, "connect installs the stamp").toBeGreaterThanOrEqual(0);
  const handler = groups[group].hooks.findIndex((h) => h.command.includes("opencadre-session-stamp"));
  const config = path.join(home, ".codex", "config.toml");
  const prior = (() => { try { return readFileSync(config, "utf8"); } catch { return ""; } })();
  writeFileSync(config, `${prior}\n[hooks.state.'${hooksFile}:pre_tool_use:${group}:${handler}']\ntrusted_hash = "sha256:test"\n`);
}

/** This device's live sessions in the test project, by agent id. */
async function rows(device: string): Promise<Map<string, string>> {
  const live = (await liveSessions(hub.url, operatorKey, device)).filter((s) => s.projectKey === PROJECT_KEY);
  return new Map(live.map((s) => [s.agentId, s.agentName]));
}

function start(proxyScript: string, home: string) {
  const proxy = new ProxyProcess(proxyScript, childEnv(home), project, "codex");
  proxies.push(proxy);
  return proxy;
}

const stamped = (credential: string, sid: string, task: string) => ({ task, [STAMP_FIELD]: mintStamp(credential, sid) });

beforeAll(async () => {
  project = gitProject("defer-seat-proj");
  hub = await startHub();
  ({ operatorKey } = await operatorWorkspace("Defer Seat Org"));
  await enableProject(hub.url, operatorKey, PROJECT_KEY);
}, 60_000);

afterAll(async () => {
  for (const p of proxies) p.child.kill();
  await hub?.close();
});

describe("CONTROL: an UNTRUSTED stamp keeps ruling #16116 (the process joins at initialize)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("initialize alone creates exactly one row", async () => {
    const { home, deviceId: device, proxyScript } = await connectedHome(false);
    const proxy = start(proxyScript, home);
    expect((await proxy.initialize()).error).toBeUndefined();
    proxy.notify("notifications/initialized");
    expect((await rows(device)).size).toBe(1);
  });
});

describe("TRUSTED stamp: the process never joins unless an unstamped call needs it", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  let home: string;
  let proxy: ProxyProcess;
  let credential: string;
  beforeAll(async () => {
    const connected = await connectedHome(true);
    home = connected.home;
    deviceId = connected.deviceId;
    credential = computerCredential(home);
    proxy = start(connected.proxyScript, home);
  }, 60_000);

  it("startup traffic (initialize, initialized, tools/list) creates NO row, and still lists every tool", async () => {
    // Without the change this is 1: the row the control above creates.
    expect((await proxy.initialize()).error).toBeUndefined();
    proxy.notify("notifications/initialized");
    const listed = await proxy.request("tools/list");
    const names = (listed.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toContain("set_status");
    expect(names).toContain("get_messages");
    expect((await rows(deviceId)).size).toBe(0);
  });

  it("two stamped chats are exactly two agents on the roster", async () => {
    // Without the change this is 3 (the process seat plus the two chats): HARNESS-CODEX.md §6.2 run I2.
    for (const r of await Promise.all([
      proxy.callTool("set_status", stamped(credential, "chat-A", "identity test A")),
      proxy.callTool("set_status", stamped(credential, "chat-B", "identity test B")),
    ])) expect(r.error, JSON.stringify(r.error)).toBeUndefined();
    const live = await rows(deviceId);
    expect(live.size).toBe(2);
  });

  it("an UNSTAMPED tool call opens this process's own seat, once, and is answered", async () => {
    const before = await rows(deviceId);
    const first = await proxy.callTool("set_status", { task: "unstamped" });
    expect(first.error, JSON.stringify(first.error)).toBeUndefined();
    const second = await proxy.callTool("set_status", { task: "unstamped again" });
    expect(second.error, JSON.stringify(second.error)).toBeUndefined();
    const after = await rows(deviceId);
    expect([...after.keys()].filter((id) => !before.has(id))).toHaveLength(1);
  });
});

// Codex-OpenCadre-d193's review: the seatless path must not turn a refusal into a usable channel. A refusal that
// belongs to a SEAT (billing, the agent cap, a removed seat) now lands on the first real call, which opens its seat
// through checkDeviceSession; one that belongs to the WORKSPACE or DEVICE (paused, disabled project) lands at startup.
// Each fixture asserts its own precondition first, so a fixture that failed to take effect cannot pass as a refusal.
describe("refusals: the deferred startup never becomes a usable ghost-free channel", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  /** A fresh workspace (so a cap or lapse touches nothing else), its trusted Codex home, and a started proxy. */
  async function fresh(name: string) {
    const { db } = await import("../src/db.js");
    const { createOrganization, registerAgent } = await import("../src/service.js");
    const { assignPlan } = await import("../src/billing.js");
    const { orgId } = createOrganization(`Defer refusal ${name}`);
    assignPlan(orgId, "internal");
    const opKey = registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey;
    await enableProject(hub.url, opKey, PROJECT_KEY);
    const home = tempDir("defer-refusal-home-");
    const minted = await mintDevice(hub.url, opKey, "codex");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "codex"], childEnv(home));
    expect(connected.code, connected.err).toBe(0);
    trustStamp(home);
    const proxy = start(path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs"), home);
    const live = async () => (await liveSessions(hub.url, opKey, minted.deviceId)).filter((s) => s.projectKey === PROJECT_KEY);
    return { db, orgId, opKey, proxy, credential: computerCredential(home), live };
  }

  it("a PAUSED workspace refuses the deferred startup itself", async () => {
    const f = await fresh("paused");
    f.db.prepare(`UPDATE organizations SET paused_at = datetime('now') WHERE id = ?`).run(f.orgId);
    const init = await f.proxy.initialize();
    expect(init.error, "startup must be refused, not answered").toBeDefined();
    expect(await f.live()).toHaveLength(0);
  });

  it("a LAPSED workspace: startup is answered (a read), but the first real call, stamped or not, is refused and creates nothing", async () => {
    const f = await fresh("lapsed");
    const { assignPlan, workspaceBilling, GRACE_DAYS } = await import("../src/billing.js");
    assignPlan(f.orgId, "pro");
    f.db.prepare(`UPDATE organizations SET subscription_status = 'canceled', lapsed_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - (GRACE_DAYS + 1) * 86_400_000).toISOString(), f.orgId);
    expect(workspaceBilling(f.orgId).readOnly, "fixture: the workspace really is read-only").toBe(true);
    expect((await f.proxy.initialize()).error).toBeUndefined();
    await expect(f.proxy.callTool("set_status", { task: "unstamped" })).rejects.toThrow(/read-only/);
    await expect(f.proxy.callTool("set_status", stamped(f.credential, "chat-L", "stamped"))).rejects.toThrow(/read-only/);
    expect(await f.live()).toHaveLength(0);
  });

  it("AT THE AGENT CAP: startup is answered, but the first real call is refused and creates nothing", async () => {
    const f = await fresh("capped");
    const { assignPlan, agentLimitRefusal } = await import("../src/billing.js");
    const { registerAgent, heartbeat } = await import("../src/service.js");
    assignPlan(f.orgId, "trial");
    for (let i = 0; i < 60 && !agentLimitRefusal(f.orgId); i++) heartbeat(f.orgId, registerAgent(f.orgId, `Filler ${i}`).agentId);
    expect(agentLimitRefusal(f.orgId), "fixture: the workspace really is at its cap").not.toBeNull();
    expect((await f.proxy.initialize()).error).toBeUndefined();
    await expect(f.proxy.callTool("set_status", { task: "unstamped" })).rejects.toThrow(/limit|plan|agents/i);
    expect(await f.live()).toHaveLength(0);
  });

  it("a REMOVED process seat: its next unstamped call is refused, and nothing is revived", async () => {
    const f = await fresh("removed");
    expect((await f.proxy.initialize()).error).toBeUndefined();
    expect((await f.proxy.callTool("set_status", { task: "opens the seat" })).error).toBeUndefined();
    const [seat] = await f.live();
    expect(seat, "fixture: the unstamped call opened exactly this seat").toBeDefined();
    const removed = await fetch(`${hub.url}/v1/org/agents/${seat.agentId}`, { method: "DELETE", headers: { authorization: `Bearer ${f.opKey}` } });
    expect(removed.status).toBe(200);
    await expect(f.proxy.callTool("set_status", { task: "after removal" })).rejects.toThrow(/removed this session/);
    expect(await f.live()).toHaveLength(0);
  });
});

describe("the hub's seatless path keeps every gate but the seat", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  let credential: string;
  let device: string;
  beforeAll(async () => {
    const connected = await connectedHome(true);
    credential = computerCredential(connected.home);
    device = connected.deviceId;
  }, 60_000);

  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(`${hub.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`, "content-type": "application/json", accept: "application/json, text/event-stream",
      "x-opencadre-session": "codex-raw-probe", "x-opencadre-project": PROJECT_KEY, "x-opencadre-project-name": "defer-seat-proj",
      [DEFER_SEAT_HEADER]: "1", ...extra,
    },
    body: JSON.stringify(body),
  });
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

  it("answers initialize with no MCP session id and no row", async () => {
    const res = await post(initialize);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    await res.text();
    expect((await rows(device)).size).toBe(0);
  });

  it("a tools/call never rides the header seatless: it takes the normal path and creates its row", async () => {
    // Without wantsNoSeat's tool-call check, this call would run under the placeholder agent.
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "set_status", arguments: { task: "raw" } } });
    await res.text();
    expect(res.status).toBe(200);
    expect((await rows(device)).size).toBe(1);
  });

  it("a bad credential is refused, as on the normal path", async () => {
    const res = await fetch(`${hub.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer dev_${"f".repeat(48)}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-opencadre-session": "x", "x-opencadre-project": PROJECT_KEY, [DEFER_SEAT_HEADER]: "1" },
      body: JSON.stringify(initialize),
    });
    await res.text();
    expect(res.status).toBe(401);
  });

  it("a disabled project is refused, as on the normal path", async () => {
    await enableProject(hub.url, operatorKey, PROJECT_KEY, false);
    try {
      const res = await post(initialize);
      await res.text();
      expect(res.status).toBe(403);
    } finally {
      await enableProject(hub.url, operatorKey, PROJECT_KEY, true);
    }
  });
});
