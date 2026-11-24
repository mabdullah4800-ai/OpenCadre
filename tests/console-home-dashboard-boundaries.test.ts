// @vitest-environment happy-dom
// Console dashboard phase 1 (Home): the plan in B:\ai-work\temp\9d1f-ambient\plan-dashboard-phase1.md as
// Codex-OpenCadre-049a ruled on it (2026-10-01). Metric definitions against fixtures, one population across the tile,
// the list and the map, freshness from APPLIED successes only, clearing on sign-out / workspace switch / role change /
// 403, rejection of an abandoned generation's answers, the scope-honest plan gauge, DOM and CSP hygiene, and mutation
// checks that prove the key definitions' tests can fail.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const APP_JS = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8").replace(/\r\n/g, "\n"); // a Windows checkout (autocrlf) has CRLF; the multi-line anchors are LF
const INDEX_HTML = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8").replace(/\r\n/g, "\n"); // a Windows checkout (autocrlf) has CRLF; the multi-line anchors are LF
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

type Fail = { status: number };
type World = {
  me: Record<string, unknown>;
  agents?: unknown[]; sessions?: unknown[] | Fail; approvals?: unknown[]; grants?: unknown[]; messages?: unknown[] | Fail;
  devices?: unknown[] | Fail; projects?: unknown[] | Fail; counts?: Record<string, number>; events?: unknown[] | Fail;
};
const PRO = {
  plan: "pro", planName: "Pro", subscriptionStatus: "active", trialEndsAt: null, readOnly: false, reason: null, graceEndsAt: null, seats: 1,
  limits: { key: "pro", name: "Pro", maxAgents: 10, maxMachines: 3, maxProjects: 5, maxWorkspaces: 1, maxWebhooks: 2, retentionDays: 90, trialDays: null },
  awaitingPlan: false, trialConvertsAt: null,
};
const identity = (orgId: string, over: Record<string, unknown> = {}) => ({
  agentId: `me-${orgId}`, agentName: "Pat", role: "operator", memberRole: "owner", orgId, orgName: `${orgId} Co`,
  webhook_url: null, webhook_auth_set: false, workspace: { paused: false }, billing: PRO, ...over,
});
const session = (id: string, over: Record<string, unknown> = {}) => ({
  agentId: id, agentName: id, tool: "codex", project: "api", deviceName: "Mac", online: true, liveness: "chat", lastHeartbeatAt: new Date().toISOString(), ...over,
});
const failed = (status: number): Fail => ({ status });
/** A roster row as GET /v1/agents shapes it (src/service.ts listActiveAgents), with the fields the console reads. */
const agent = (over: Record<string, unknown>) => ({ editing_files_parsed: [], collision_files: [], collision_agents: [], status: "active", kind: "named", key_class: "agent", role: "agent", ...over });

/** A hub for the console's refresh: per-workspace answers, and holds that park one request until released. */
function makeHub(worlds: Record<string, World>) {
  const gates: Array<{ ws: string; prefix: string; skip: number; promise: Promise<void> }> = [];
  const state = { authed: false };
  const hold = (ws: string, prefix: string, skip = 0) => {
    let release!: () => void;
    const promise = new Promise<void>((r) => { release = r; });
    gates.push({ ws, prefix, skip, promise });
    return release;
  };
  const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "";
    // A prefix with a query matches that URL's start; one without matches the path exactly ("/v1/me" is not "/v1/messages").
    const gate = gates.find((g) => g.ws === ws && (g.prefix.includes("?") ? url.startsWith(g.prefix) : url.split("?")[0] === g.prefix));
    if (gate) {
      if (gate.skip > 0) gate.skip--;
      else { gates.splice(gates.indexOf(gate), 1); await gate.promise; }
    }
    const [path, query = ""] = url.split("?");
    if (path === "/v1/auth/me") {
      // No person until a test enters one: boot() would otherwise enter a workspace on its own and start a generation.
      if (!state.authed) return json(401, { error: "Sign in first." });
      return json(200, { person: { id: "p1", name: "Pat" }, workspaces: Object.entries(worlds).map(([orgId, w]) => ({ orgId, name: orgId, role: w.me.memberRole ?? "owner" })) });
    }
    const w = worlds[ws];
    if (!w) return json(200, hubReadBody(url) ?? {});
    const list = (v: unknown[] | Fail | undefined, key: string) => (v && !Array.isArray(v) ? json(v.status, { error: "no" }) : json(200, { [key]: v ?? [] }));
    switch (path) {
      case "/v1/me": return json(200, w.me);
      case "/v1/agents": return json(200, { agents: w.agents ?? [] });
      case "/v1/approvals": return json(200, { approvals: query.includes("pending") ? w.approvals ?? [] : [] });
      case "/v1/approval-grants": return json(200, { grants: w.grants ?? [] });
      case "/v1/tasks": return json(200, { tasks: [], counts: w.counts ?? { open: 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 } });
      case "/v1/events": return list(w.events, "events");
      case "/v1/messages": return list(w.messages, "messages");
      case "/v1/org/devices": return list(w.devices, "devices");
      case "/v1/org/sessions": return query.includes("ended") ? json(200, { sessions: [] }) : list(w.sessions, "sessions");
      case "/v1/org/projects": return list(w.projects, "projects");
      default: return json(200, hubReadBody(url) ?? {});
    }
  });
  return { fetchMock, hold, state };
}

type Ui = Record<string, (...a: any[]) => any>;
function loadConsole(fetchMock: unknown, mutate: (src: string) => string = (s) => s): Ui {
  const location = new Proxy(window.location, {
    get(target, key) {
      if (key === "replace") return () => {};
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Function("window", "document", "localStorage", "fetch", "location",
    `${mutate(APP_JS)}; return {
      loadAndRender, enterWorkspace, signOut, selectTab, renderOverview, renderBilling, homeUserRefresh,
      homeFleet, needsYouIds, agentTileMetric, openTaskMetric, approvalTileMetric, grantTileMetric, planUsage, planRows,
      enter: (ws, identity) => { authMode = "session"; currentWorkspace = ws; currentWorkspaceRole = identity.memberRole ?? null; me = identity; },
      setMe: (v) => { me = v; },
      state: () => ({ me, currentWorkspaceRole, consoleGeneration, homeSources, homeTick, homeRefreshing }),
    };`,
  )(window, document, window.localStorage, fetchMock, location) as Ui;
}

class FakeSocket { readyState = 0; close() {} }
beforeEach(() => {
  let html = INDEX_HTML.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  window.localStorage.clear();
  window.sessionStorage.clear();
  history.replaceState(null, "", "/app/");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tile = (k: string) => document.querySelector(`#overview-metrics [data-tile="${k}"]`) as HTMLElement | null;
const tileValue = (k: string) => tile(k)?.querySelector(".home-tile-number")?.textContent ?? null;
const tileUnit = (k: string) => tile(k)?.querySelector(".home-tile-unit")?.textContent ?? null;
const tileText = (k: string) => tile(k)?.textContent ?? "";
const listNames = () => [...$("overview-happening").querySelectorAll(".callsign")].map((n) => n.textContent);
const slabNames = () => [...$("home-fleet-map").querySelectorAll(".viz-slab-text")].map((n) => n.textContent);
const limitRow = (k: string) => $("home-limits-rows").querySelector(`[data-limit="${k}"]`) as HTMLElement | null;

/** A signed-in owner of ws-a with three in the population: s1 (online), Release-Bot (a named agent, online) and s2 (idle).
 * The viewer, another person, an ended session and an offline named agent are all left out. */
function ownerWorld(over: Partial<World> = {}): World {
  return {
    me: identity("ws-a"),
    agents: [
      agent({ id: "me-ws-a", name: "Pat", key_class: "human", role: "operator", online: true }),
      agent({ id: "p2", name: "Sam", key_class: "human", online: true }),
      agent({ id: "s1", name: "s1", kind: "session", online: true }),
      agent({ id: "rb", name: "Release-Bot", online: true, current_task: "deploying", state: "waiting", phase: "waiting" }),
      agent({ id: "old", name: "Old-Bot", online: false }),
    ],
    sessions: [session("s1"), session("s2", { online: false }), session("s3", { endedAt: new Date().toISOString() })],
    devices: [{ status: "connected" }, { status: "connected" }, { status: "revoked" }],
    projects: [{ enabled: true }],
    counts: { open: 1, expired: 2, in_progress: 3, needs_review: 4, done: 9 },
    ...over,
  };
}
async function signedIn(world: World) {
  const hub = makeHub({ "ws-a": world });
  const ui = loadConsole(hub.fetchMock);
  await flush();
  ui.enter("ws-a", world.me);
  await ui.loadAndRender();
  return { hub, ui };
}

describe("review boundary: permission denial is independent of batch completion", () => {
  it("drops denied sessions and computers while an unrelated required read is held", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    expect(ui.state().homeSources.sessions.data.sessions[0].agentId).toBe("s1");
    const release = hub.hold("ws-a", "/v1/agents");
    world.sessions = failed(403); world.devices = failed(403);
    const flight = ui.loadAndRender();
    await flush(100);
    try {
      expect(ui.state().homeSources.sessions).toMatchObject({ status: "forbidden", data: null, lastOkAt: 0 });
      expect(ui.state().homeSources.devices).toMatchObject({ status: "forbidden", data: null, lastOkAt: 0 });
      expect($("home-fleet-map").textContent).not.toContain("s1");
    } finally { release(); await flight; }
  });
  it("does not retain forbidden session data when another required read fails", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    world.sessions = failed(403); world.devices = failed(403);
    const serve = hub.fetchMock.getMockImplementation()!;
    hub.fetchMock.mockImplementation(async (url, init) => url === "/v1/agents" ? json(500, { error: "temporary failure" }) : serve(url, init));
    await ui.loadAndRender(); await flush(100);
    expect(ui.state().homeSources.sessions).toMatchObject({ status: "forbidden", data: null, lastOkAt: 0 });
    expect(ui.state().homeSources.devices).toMatchObject({ status: "forbidden", data: null, lastOkAt: 0 });
  });
  it("applies a known role downgrade before a different required read finishes", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    const release = hub.hold("ws-a", "/v1/agents");
    world.me = identity("ws-a", { role: "agent", memberRole: "member" });
    const flight = ui.loadAndRender(); await flush(100);
    try {
      expect(ui.state().me.memberRole).toBe("member");
      expect($("home-fleet-map").textContent).not.toContain("s1");
    } finally { release(); await flight; }
  });
});