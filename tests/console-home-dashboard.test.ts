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
  agents?: unknown[]; sessions?: unknown[] | Fail; tasks?: Fail; approvals?: unknown[]; grants?: unknown[]; messages?: unknown[] | Fail;
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
      case "/v1/tasks": return w.tasks ? json(w.tasks.status, { error: "no" }) : json(200, { tasks: [], counts: w.counts ?? { open: 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 } });
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

// ---- metric definitions (pure) -----------------------------------------------------------------------------------------

describe("the population (homeFleet)", () => {
  const agents = ownerWorld().agents!;
  it("sessions view: live chats and online named agents, without the viewer, people, ended chats or duplicates, online first", () => {
    const ui = loadConsole(vi.fn());
    ui.setMe(identity("ws-a"));
    const fleet = ui.homeFleet({ status: "ok", data: { sessions: ownerWorld().sessions }, lastOkAt: 1 }, agents);
    expect(fleet.view).toBe("sessions");
    expect(fleet.members.map((m: { agentId: string }) => m.agentId)).toEqual(["s1", "rb", "s2"]);
  });
  it("a 403 selects the agents this viewer can see, labelled as that; a failure or no answer selects nothing", () => {
    const ui = loadConsole(vi.fn());
    ui.setMe(identity("ws-a"));
    const roster = ui.homeFleet({ status: "forbidden", data: null, lastOkAt: 0 }, agents);
    expect(roster.view).toBe("roster");
    expect(roster.members.map((m: { agentId: string }) => m.agentId)).toEqual(["p2", "s1", "rb", "old"]);
    expect(ui.agentTileMetric(roster, new Set())).toMatchObject({ value: 3, total: 4, unit: "of 4 you can see", foot: "3 online · 1 offline" });
    expect(ui.homeFleet({ status: "failed", data: null, lastOkAt: 0 }, agents)).toEqual({ view: "unavailable", members: null });
    expect(ui.homeFleet({ status: "pending", data: null, lastOkAt: 0 }, agents)).toEqual({ view: "loading", members: null });
  });
  it("the tile's value, 'of N' and foot are counts over the population, and the foot sums to N", () => {
    const ui = loadConsole(vi.fn());
    ui.setMe(identity("ws-a"));
    const fleet = ui.homeFleet({ status: "ok", data: { sessions: ownerWorld().sessions }, lastOkAt: 1 }, agents);
    expect(ui.agentTileMetric(fleet, new Set(["rb"]))).toMatchObject({ value: 2, total: 3, unit: "of 3 live", foot: "2 online · 1 idle · 1 needs you" });
  });
});

describe("needs you (needsYouIds): only what this viewer can act on", () => {
  const members = [{ agentId: "rb" }, { agentId: "cx" }];
  const future = new Date(Date.now() + 600_000).toISOString();
  const ids = (approvals: unknown[], messages: unknown[] | null) => {
    const ui = loadConsole(vi.fn());
    ui.setMe(identity("ws-a"));
    return [...ui.needsYouIds(members, approvals, messages)].sort();
  };
  it("a 'waiting' state or phase alone is not a person needed", () => {
    expect(ids([], [])).toEqual([]);
  });
  it("a pending approval in the viewer's own list is; one for an agent outside the population, or expired, is not", () => {
    expect(ids([{ requested_by_agent_id: "rb", status: "pending", expires_at: future }], [])).toEqual(["rb"]);
    expect(ids([{ requested_by_agent_id: "elsewhere", status: "pending", expires_at: future }], [])).toEqual([]);
    expect(ids([{ requested_by_agent_id: "rb", status: "pending", expires_at: new Date(Date.now() - 1000).toISOString() }], [])).toEqual([]);
  });
  it("an unread question to the viewer awaiting a reply is (SQLite 1 and Postgres true); a replied, read or other person's one is not", () => {
    const q = (over: Record<string, unknown>) => ({ kind: "question", from_agent_id: "cx", to_agent_id: "me-ws-a", awaiting_reply: 1, read_at: null, ...over });
    expect(ids([], [q({})])).toEqual(["cx"]);
    expect(ids([], [q({ awaiting_reply: true })])).toEqual(["cx"]);
    expect(ids([], [q({ awaiting_reply: 0 })])).toEqual([]);
    expect(ids([], [q({ read_at: "2026-10-01 10:00:00" })])).toEqual([]);
    expect(ids([], [q({ to_agent_id: "someone-else" })])).toEqual([]);
    expect(ids([], [q({ kind: "message" })])).toEqual([]);
  });
  it("each member counts once, and no messages source means approvals only", () => {
    expect(ids([{ requested_by_agent_id: "rb", status: "pending", expires_at: future }, { requested_by_agent_id: "rb", status: "pending", expires_at: future }],
      [{ kind: "question", from_agent_id: "rb", to_agent_id: "me-ws-a", awaiting_reply: 1, read_at: null }])).toEqual(["rb"]);
    expect(ids([], null)).toEqual([]);
  });
});

describe("the tile metrics", () => {
  const ui = () => loadConsole(vi.fn());
  it("Open tasks is open + expired, with in progress and in review named beside it; no counts is 'Not available'", () => {
    expect(ui().openTaskMetric({ open: 1, expired: 2, in_progress: 3, needs_review: 4, done: 9 })).toEqual({ value: 3, open: 1, expired: 2, inProgress: 3, review: 4 });
    expect(ui().openTaskMetric(null)).toBeNull();
  });
  it("Waiting for approval picks the oldest request and the soonest expiry from any order", () => {
    const m = ui().approvalTileMetric([
      { created_at: "2026-10-01T10:05:00Z", expires_at: "2026-10-01T11:00:00Z" },
      { created_at: "2026-10-01T10:00:00Z", expires_at: "2026-10-01T12:00:00Z" },
      { created_at: "2026-10-01T10:09:00Z", expires_at: "2026-10-01T10:30:00Z" },
    ]);
    expect(m).toEqual({ value: 3, oldest: "2026-10-01T10:00:00Z", soonest: "2026-10-01T10:30:00Z" });
  });
  it("Standing approvals names the grant that ends soonest, though the hub sends them latest first", () => {
    const m = ui().grantTileMetric([
      { agent_name: "A", expires_at: "2026-10-01T15:00:00Z" }, { agent_name: "B", expires_at: "2026-10-01T13:00:00Z" }, { agent_name: "C", expires_at: "2026-10-01T11:00:00Z" },
    ]);
    expect(m.value).toBe(3);
    expect(m.soonest.agent_name).toBe("C");
  });
});

describe("plan rows (planRows): one rule for Home and Settings", () => {
  const rows = (billing: unknown, used: Record<string, unknown>) => Object.fromEntries(loadConsole(vi.fn()).planRows(billing, used).map((r: { key: string }) => [r.key, r]));
  const withLimits = (limits: Record<string, unknown>, seats = 1) => ({ ...PRO, seats, limits: { ...PRO.limits, ...limits } });
  it("the live-agents count is never a fraction, track or verdict, even at or past the allowance", () => {
    for (const n of [0, 8, 10, 12]) {
      const r = rows(PRO, { agents: n, computers: 0, projects: 0 }).agents;
      expect(r).toMatchObject({ gauge: false, level: "", limitText: "Up to 10", note: `${n} online that you can see` });
    }
  });
  it("computers and projects are gauges at 79% neutral, 80% near, at the allowance full", () => {
    const at = (n: number, max: number) => rows(withLimits({ maxProjects: max }), { agents: 0, computers: 0, projects: n }).projects;
    expect(at(79, 100)).toMatchObject({ gauge: true, level: "", limitText: "79 / 100", note: "" });
    expect(at(80, 100)).toMatchObject({ gauge: true, level: "near", note: "Near the limit for your plan", valueText: "80 of 100 projects, near the limit for your plan" });
    expect(at(5, 5)).toMatchObject({ gauge: true, level: "full", note: "At the limit" });
  });
  it("Unlimited, Not included, a refused and an unavailable count each say so, with no zero and no track", () => {
    const r = rows(withLimits({ maxMachines: null, maxProjects: 0 }), { agents: null, computers: "forbidden", projects: 0 });
    expect(r.computers).toMatchObject({ gauge: false, limitText: "Unlimited", note: "Only owners and admins can see the count", forbidden: true });
    expect(r.projects).toMatchObject({ gauge: false, limitText: "Not included", note: "" });
    expect(r.agents).toMatchObject({ gauge: false, limitText: "Up to 10", note: "Count not available" });
    expect(rows(withLimits({ maxProjects: 0 }), { agents: 0, computers: null, projects: 2 }).projects.note).toBe("2 turned on");
    expect(rows(PRO, { agents: 0, computers: null, projects: 0 }).computers).toMatchObject({ gauge: false, limitText: "Up to 3", note: "Count not available" });
  });
  it("per-seat limits pool across seats; projects do not", () => {
    const r = rows(withLimits({}, 3), { agents: 1, computers: 1, projects: 1 });
    expect(r.agents.limitText).toBe("Up to 30");
    expect(r.computers.limitText).toBe("1 / 9");
    expect(r.projects.limitText).toBe("1 / 5");
  });
  it("Home and Settings show the same numbers for one fixture", async () => {
    const { ui } = await signedIn(ownerWorld());
    expect(limitRow("computers")!.querySelector(".limit-value")!.textContent).toBe("2 / 3");
    expect(limitRow("projects")!.querySelector(".limit-value")!.textContent).toBe("1 / 5");
    const settings = $("billing-usage").textContent ?? "";
    expect(settings).toContain("Computers2 of 3");
    expect(settings).toContain("Projects1 of 5");
    expect(ui.planUsage({ agents: ownerWorld().agents, devices: ownerWorld().devices, projects: ownerWorld().projects })).toEqual({ agents: 4, computers: 2, projects: 1 });
  });
});

// ---- one population across the tile, the list and the map -------------------------------------------------------------

describe("the tile, Working now and the fleet map show one population", () => {
  it("same members, same order, same counts", async () => {
    await signedIn(ownerWorld());
    expect(tileValue("agents")).toBe("2");
    expect(tileUnit("agents")).toBe("of 3 live");
    expect(tileText("agents")).toContain("2 online · 1 idle");
    expect(listNames()).toEqual(["s1", "Release-Bot", "s2"]);
    expect(slabNames()).toEqual(["s1", "Release-Bot", "s2"]);
    expect($("overview-fleet-summary").textContent).toBe("2 of 3 online");
  });
  it("with twelve, the list and the map both show the same eight and both say four more", async () => {
    const sessions = Array.from({ length: 12 }, (_, i) => session(`chat-${String(i).padStart(2, "0")}`));
    await signedIn(ownerWorld({ sessions, agents: [] }));
    expect(tileValue("agents")).toBe("12");
    expect(listNames()).toHaveLength(8);
    expect(slabNames()).toEqual(listNames());
    expect($("overview-background").textContent).toBe("4 more online: see the Agents page.");
    expect($("home-fleet-more").textContent).toBe("+4 more on the Agents page");
    expect($("home-fleet-map").querySelector("svg")!.getAttribute("aria-label")).toContain("4 more not drawn.");
    expect(tile("agents")!.querySelector(".home-tile-glyphs")!.textContent).toBe("+4");
    expect(tile("agents")!.querySelectorAll(".viz-glyphs .viz-glyph")).toHaveLength(8);
  });
  it("needs you on the map comes from the viewer's approvals and questions, not from a 'waiting' state", async () => {
    await signedIn(ownerWorld());
    // Release-Bot says it is waiting, but nothing of it is in the viewer's lists.
    expect($("home-fleet-map").querySelectorAll(".viz-slab.is-needs")).toHaveLength(0);
    expect($("home-fleet-map").querySelector("svg")!.getAttribute("aria-label")).not.toContain("needs you");
    const { hub: _h } = await signedIn(ownerWorld({
      approvals: [{ id: "ap1", requested_by_agent_id: "rb", requested_by_agent_name: "Release-Bot", status: "pending", risk: "high", action: "rm -rf ./dist", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() }],
    }));
    const needs = [...$("home-fleet-map").querySelectorAll(".viz-slab.is-needs .viz-slab-text")].map((n) => n.textContent);
    expect(needs).toEqual(["Release-Bot"]);
    expect($("home-fleet-map").querySelectorAll(".viz-wire.is-needs")).toHaveLength(1);
    expect($("home-fleet-map").querySelector("svg")!.getAttribute("aria-label")).toContain("Release-Bot needs you.");
    expect(tileText("agents")).toContain("1 needs you");
  });
  it("a failed messages read says needs-you counts approvals only", async () => {
    await signedIn(ownerWorld({ messages: failed(500) }));
    expect($("home-fleet-map").querySelector("svg")!.getAttribute("aria-label")).toContain("Questions could not be checked");
  });
});

describe("a sessions read that fails never switches the population silently", () => {
  it("after a good read, a 500 keeps the same population, says since when, and does not become the roster", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    const firstOk = ui.state().homeSources.sessions.lastOkAt;
    world.sessions = failed(500);
    await ui.loadAndRender();
    expect(tileUnit("agents")).toBe("of 3 live");
    expect(listNames()).toEqual(["s1", "Release-Bot", "s2"]);
    expect(slabNames()).toEqual(["s1", "Release-Bot", "s2"]);
    expect($("overview-happening-caption").hidden).toBe(false);
    expect($("overview-happening-caption").textContent).toMatch(/Couldn't refresh who is working · showing data from \d\d:\d\d:\d\d/);
    expect(ui.state().homeSources.sessions).toMatchObject({ status: "failed", lastOkAt: firstOk });
    // The page itself did refresh: its chip is not stale.
    expect($("home-fresh").dataset.tone).toBe("fresh");
  });
  it("a first-load failure is 'Not available' with no list and no map, never the roster", async () => {
    await signedIn(ownerWorld({ sessions: failed(500) }));
    expect(tileValue("agents")).toBe("Not available");
    expect(tileText("agents")).not.toContain("you can see");
    expect(listNames()).toEqual([]);
    expect($("overview-happening-caption").textContent).toContain("Couldn't load who is working.");
    expect($("home-fleet-card").hidden).toBe(true);
  });
  it("a 403 is the roster view, for a viewer who may not read sessions, with no map", async () => {
    await signedIn(ownerWorld({ me: identity("ws-a", { role: "agent", memberRole: "member" }), sessions: failed(403) }));
    expect(tileUnit("agents")).toBe("of 4 you can see");
    expect(tileText("agents")).toContain("3 online · 1 offline");
    expect($("overview-happening-section").hidden).toBe(true);
    expect($("home-fleet-card").hidden).toBe(true);
  });
});

// ---- freshness ---------------------------------------------------------------------------------------------------------

describe("freshness comes from applied successes only", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00"));
  });
  it("nothing before the first success, 'just now' after it, stale after three missed polls, and failed keeps the numbers", async () => {
    const world = ownerWorld();
    const hub = makeHub({ "ws-a": world });
    const ui = loadConsole(hub.fetchMock);
    await flush();
    ui.enter("ws-a", world.me);
    ui.renderOverview({ approvals: [], messages: [], awarenessDigest: null, liveSessions: [], taskCounts: null, grants: [], agents: [], events: [] });
    expect($("home-fresh").hidden).toBe(true);
    await ui.loadAndRender();
    expect($("home-fresh").hidden).toBe(false);
    expect($("home-fresh-text").textContent).toBe("Updated just now");
    expect($("home-fresh-action").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000); // the tick runs every 5 s; no poll is scheduled in this harness
    expect($("home-fresh").dataset.tone).toBe("stale");
    expect($("home-fresh-text").textContent).toBe("Updated 15 s ago · may be out of date");
    expect($("home-fresh-action").textContent).toBe("Refresh");
    world.me = { ...world.me };
    hub.fetchMock.mockImplementationOnce(async () => json(503, { error: "down" }));
    await ui.loadAndRender();
    expect($("home-fresh").dataset.tone).toBe("failed");
    expect($("home-fresh-text").textContent).toBe("Couldn't refresh · showing data from 12:00:00");
    expect($("home-fresh-action").textContent).toBe("Retry");
    expect(tileValue("agents")).toBe("2");
    expect(tileValue("tasks")).toBe("3");
  });
  it("a slow required read has its own 15 s bound, healthy peers apply, and core age is the oldest applied source", async () => {
    const world = ownerWorld();
    const hub = makeHub({ "ws-a": world });
    const ui = loadConsole(hub.fetchMock);
    await flush();
    ui.enter("ws-a", world.me);
    await ui.loadAndRender();
    const first = ui.state().homeSources.core.lastOkAt;
    const firstRoster = ui.state().homeSources.roster.lastOkAt;
    await vi.advanceTimersByTimeAsync(1_000);
    world.counts = { open: 7, expired: 2, in_progress: 0, needs_review: 0, done: 0 };
    const release = hub.hold("ws-a", "/v1/agents");
    const slow = ui.loadAndRender();
    try {
      await flush(100);
      expect(ui.state().homeSources.roster.lastOkAt).toBe(firstRoster);
      expect(ui.state().homeSources.tasks.lastOkAt).toBeGreaterThan(first);
      expect(tileValue("tasks")).toBe("9"); // the healthy task source applied while roster is held
      expect(ui.state().homeSources.core.lastOkAt).toBe(firstRoster);
      await vi.advanceTimersByTimeAsync(5_000); // below the per-read 15 s deadline
      expect(ui.state().homeSources.core.lastOkAt).toBe(firstRoster);
    } finally { release(); }
    await slow;
    const required = ["identity", "roster", "tasks", "approvals", "grants"].map(name => ui.state().homeSources[name].lastOkAt);
    expect(ui.state().homeSources.roster.lastOkAt).toBe(Date.now());
    expect(ui.state().homeSources.core.lastOkAt).toBe(Math.min(...required));
    expect(ui.state().homeSources.core.lastOkAt).toBeLessThan(ui.state().homeSources.roster.lastOkAt);
    expect(ui.state().homeSources.core.lastOkAt).toBeGreaterThan(first);
  });
  it("a task metric stays unknown before any good read, then retains its last known value on a failed read", async () => {
    const world = ownerWorld({ tasks: failed(500) });
    const { ui } = await signedIn(world);
    expect(ui.state().homeSources.tasks).toMatchObject({ status: "failed", data: null, lastOkAt: 0 });
    expect(tileValue("tasks")).toBe("Not available");

    world.tasks = undefined;
    await ui.loadAndRender();
    const known = tileValue("tasks");
    const appliedAt = ui.state().homeSources.tasks.lastOkAt;
    expect(known).toBe("3");
    expect(appliedAt).toBeGreaterThan(0);

    world.tasks = failed(503);
    await ui.loadAndRender();
    expect(ui.state().homeSources.tasks).toMatchObject({ status: "failed", lastOkAt: appliedAt });
    expect(tileValue("tasks")).toBe(known);
    expect([...tile("tasks")!.querySelectorAll(".home-tile-foot")].map((node) => node.textContent).join(" ")).toContain("Could not refresh · showing data from");
  });
  it("a source freshness time is not advanced until its renderer has written the DOM", async () => {
    const world = ownerWorld();
    const hub = makeHub({ "ws-a": world });
    const ui = loadConsole(hub.fetchMock);
    await flush();
    ui.enter("ws-a", world.me);
    await ui.loadAndRender();
    const previous = ui.state().homeSources.roster.lastOkAt;
    await vi.advanceTimersByTimeAsync(1_000);

    const observed: number[] = [];
    const count = $("fleet-count");
    let proto: object | null = count;
    let descriptor: PropertyDescriptor | undefined;
    while (proto && !(descriptor = Object.getOwnPropertyDescriptor(proto, "textContent"))) proto = Object.getPrototypeOf(proto);
    if (!descriptor?.get || !descriptor.set) throw new Error("fleet-count textContent descriptor unavailable");
    Object.defineProperty(count, "textContent", {
      configurable: true,
      get() { return descriptor!.get!.call(this); },
      set(value: string) {
        observed.push(ui.state().homeSources.roster.lastOkAt);
        descriptor!.set!.call(this, value);
      },
    });
    await ui.loadAndRender();
    expect(observed.length).toBeGreaterThan(0);
    expect(observed).toEqual(observed.map(() => previous));
    expect(ui.state().homeSources.roster.lastOkAt).toBe(Date.now());
    expect(ui.state().homeSources.roster.lastOkAt).toBeGreaterThan(previous);
  });
  it("a background refresh never says 'Updating…'; a Refresh the person pressed does, until it settles", async () => {
    const world = ownerWorld();
    const hub = makeHub({ "ws-a": world });
    const ui = loadConsole(hub.fetchMock);
    await flush();
    ui.enter("ws-a", world.me);
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push($("home-fresh-text").textContent ?? ""));
    observer.observe($("home-fresh-text"), { childList: true, characterData: true, subtree: true });
    await ui.loadAndRender();
    await ui.loadAndRender();
    await flush();
    expect(seen.some((t) => t.includes("Updating"))).toBe(false);
    const release = hub.hold("ws-a", "/v1/me");
    ui.homeUserRefresh();
    expect($("home-fresh-text").textContent).toBe("Updating…");
    await vi.advanceTimersByTimeAsync(1_000); // refresh() waits out its settle window, then its flight is held
    expect($("home-fresh-text").textContent).toBe("Updating…");
    release();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect($("home-fresh-text").textContent).toBe("Updated just now");
    observer.disconnect();
  });
  it("the chip's tick runs only while Home is on screen", async () => {
    const { ui } = await signedIn(ownerWorld());
    expect(ui.state().homeTick).not.toBeNull();
    ui.selectTab("tasks");
    expect(ui.state().homeTick).toBeNull();
    ui.selectTab("overview");
    expect(ui.state().homeTick).not.toBeNull();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ui.state().homeTick).toBeNull();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ui.state().homeTick).not.toBeNull();
  });
});

// ---- clearing and generations ------------------------------------------------------------------------------------------

/** Everything Home painted from a workspace, as one string, to look for its names and numbers. */
const homePaint = () => [$("overview-metrics").textContent, $("home-fleet-map").textContent, $("home-limits-rows").textContent,
  $("overview-happening").textContent, $("home-fresh").hidden ? "" : $("home-fresh-text").textContent].join("|");

describe("Home clears with the identity it showed", () => {
  const worldB = () => ownerWorld({ me: identity("ws-b"), sessions: [session("b-chat")], agents: [], devices: [], projects: [] });
  it("a workspace switch empties A's tiles, map, gauges and chip at once, before B answers", async () => {
    const worlds = { "ws-a": ownerWorld({ sessions: [session("a-chat")], agents: [] }), "ws-b": worldB() };
    const hub = makeHub(worlds);
    const ui = loadConsole(hub.fetchMock);
    await flush();
    hub.state.authed = true;
    await ui.enterWorkspace("ws-a");
    await flush();
    expect(slabNames()).toEqual(["a-chat"]);
    expect(limitRow("computers")!.textContent).toContain("2 / 3");
    const release = hub.hold("ws-b", "/v1/me");
    const entering = ui.enterWorkspace("ws-b");
    await flush();
    expect(homePaint()).not.toMatch(/a-chat|2 \/ 3|Updated/);
    expect($("overview-metrics").children).toHaveLength(0);
    expect($("home-fleet-card").hidden).toBe(true);
    expect($("home-limits-card").hidden).toBe(true);
    release();
    await entering;
    await flush();
    expect(slabNames()).toEqual(["b-chat"]);
  });
  it("A's late sessions answer never paints into B", async () => {
    const worlds = { "ws-a": ownerWorld({ sessions: [session("a-chat")], agents: [] }), "ws-b": worldB() };
    const hub = makeHub(worlds);
    const ui = loadConsole(hub.fetchMock);
    await flush();
    hub.state.authed = true;
    await ui.enterWorkspace("ws-a");
    await flush();
    const release = hub.hold("ws-a", "/v1/org/sessions?status=live");
    void ui.loadAndRender(); // A's poll, its sessions read parked
    await flush();
    await ui.enterWorkspace("ws-b");
    await flush();
    release();
    await flush();
    expect(slabNames()).toEqual(["b-chat"]);
    expect(listNames()).toEqual(["b-chat"]);
    expect(document.getElementById("main")!.textContent).not.toContain("a-chat");
  });
  it("sign-out empties Home in the same step", async () => {
    const { ui } = await signedIn(ownerWorld());
    expect(slabNames()).toHaveLength(3);
    ui.signOut();
    expect($("overview-metrics").children).toHaveLength(0);
    expect($("home-fleet-map").children).toHaveLength(0);
    expect($("home-limits-rows").children).toHaveLength(0);
    expect($("home-fresh").hidden).toBe(true);
    expect(ui.state().homeSources.core.lastOkAt).toBe(0);
  });
  it("owner -> admin (the same agent role) is a permission change: the page takes the new role and drops the batch", async () => {
    const world = ownerWorld({ counts: { open: 7, expired: 0, in_progress: 0, needs_review: 0, done: 0 } });
    const hub = makeHub({ "ws-a": world });
    const ui = loadConsole(hub.fetchMock);
    await flush();
    ui.enter("ws-a", world.me);
    await ui.loadAndRender();
    expect(ui.state().currentWorkspaceRole).toBe("owner");
    const generation = ui.state().consoleGeneration;
    world.me = identity("ws-a", { memberRole: "admin" });
    world.counts = { open: 99, expired: 0, in_progress: 0, needs_review: 0, done: 0 }; // read under the old role: never shown
    const release = hub.hold("ws-a", "/v1/me", 1); // the re-read after the change waits, so the cleared page can be seen
    await ui.loadAndRender();
    expect(ui.state().currentWorkspaceRole).toBe("admin");
    expect(ui.state().consoleGeneration).toBe(generation + 1);
    expect($("overview-metrics").children).toHaveLength(0);
    expect(homePaint()).not.toMatch(/99|7/);
    release();
    await flush(60);
    expect(tileValue("tasks")).toBe("99"); // read again under the new role
    expect(document.getElementById("home-limits-upgrade")).toBeNull(); // Home has no plan-change control for any role
  });
  it("admin -> owner is one too", async () => {
    const world = ownerWorld({ me: identity("ws-a", { memberRole: "admin" }) });
    const { ui } = await signedIn(world);
    const generation = ui.state().consoleGeneration;
    world.me = identity("ws-a", { memberRole: "owner" });
    await ui.loadAndRender();
    expect(ui.state().currentWorkspaceRole).toBe("owner");
    expect(ui.state().consoleGeneration).toBe(generation + 1);
  });
  it("operator -> agent drops the sessions population and the map in that same batch", async () => {
    const world = ownerWorld();
    const hub = makeHub({ "ws-a": world });
    const ui = loadConsole(hub.fetchMock);
    await flush();
    ui.enter("ws-a", world.me);
    await ui.loadAndRender();
    expect(slabNames()).toHaveLength(3);
    world.me = identity("ws-a", { role: "agent", memberRole: "member" });
    // This batch still answers sessions (it was asked as it went out); every later read is refused, as the hub does
    // once the member agent's role is "agent".
    const oldList = world.sessions;
    let reads = 0;
    Object.defineProperty(world, "sessions", { configurable: true, get: () => (reads++ === 0 ? oldList : failed(403)) });
    const release = hub.hold("ws-a", "/v1/me", 1);
    await ui.loadAndRender();
    expect($("home-fleet-card").hidden).toBe(true);
    expect(slabNames()).toEqual([]);
    expect(listNames()).toEqual([]);
    release();
    await flush(60);
    expect(tileUnit("agents")).toBe("of 4 you can see");
    expect($("home-fleet-card").hidden).toBe(true);
    expect($("overview-happening-section").hidden).toBe(true);
  });
  it("an agent -> operator promotion is a change too", async () => {
    const world = ownerWorld({ me: identity("ws-a", { role: "agent", memberRole: "member" }), sessions: failed(403) });
    const { ui } = await signedIn(world);
    const generation = ui.state().consoleGeneration;
    world.me = identity("ws-a", { role: "operator", memberRole: "admin" });
    await ui.loadAndRender();
    expect(ui.state().consoleGeneration).toBe(generation + 1);
    expect(ui.state().currentWorkspaceRole).toBe("admin");
  });
  it("a 403 on computers clears the gauge at once, with no zero left behind", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    expect(limitRow("computers")!.querySelector('[role="meter"]')).not.toBeNull();
    world.devices = failed(403);
    await ui.loadAndRender();
    const row = limitRow("computers")!;
    expect(row.querySelector('[role="meter"]')).toBeNull();
    expect(row.textContent).toBe("ComputersUp to 3Only owners and admins can see the count");
    expect(ui.state().homeSources.devices).toMatchObject({ status: "forbidden", data: null });
  });
  it("a 500 on computers keeps the counts and says since when", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.devices = failed(500);
    await ui.loadAndRender();
    expect(limitRow("computers")!.querySelector(".limit-value")!.textContent).toBe("2 / 3");
    expect($("home-limits-caption").hidden).toBe(false);
    expect($("home-limits-caption").textContent).toContain("showing data from");
  });
});

// ---- the scope-honest gauge --------------------------------------------------------------------------------------------

describe("a roster the viewer sees only part of is never a fraction of the workspace's limit", () => {
  it("Home and Settings show the allowance and the visible count apart, with no meter", async () => {
    // A project-scoped viewer: the roster holds only the agents it can reach, 9 of them online, against a limit of 10.
    const agents = Array.from({ length: 9 }, (_, i) => agent({ id: `p${i}`, name: `proj-${i}`, online: true }));
    await signedIn(ownerWorld({ agents, me: identity("ws-a", { role: "agent", memberRole: "member" }), sessions: failed(403), devices: failed(403), projects: failed(403) }));
    const row = limitRow("agents")!;
    expect(row.querySelector('[role="meter"]')).toBeNull();
    expect(row.querySelector(".viz-gauge")).toBeNull();
    expect(row.classList.contains("is-near")).toBe(false);
    expect(row.querySelector(".limit-value")!.textContent).toBe("Up to 10");
    expect(row.textContent).toContain("9 online that you can see");
    expect(row.textContent).not.toMatch(/9 \/ 10|Near the limit/);
    expect($("billing-usage").textContent).toContain("Live agentsUp to 10 · 9 online that you can see");
    expect($("billing-usage").textContent).not.toContain("9 of 10");
  });
});

// ---- DOM, accessibility and CSP hygiene --------------------------------------------------------------------------------

describe("accessibility", () => {
  it("tiles are named, their figures hidden from the reader, and nothing on them is a live region", async () => {
    await signedIn(ownerWorld());
    for (const t of document.querySelectorAll<HTMLElement>("#overview-metrics .home-tile")) {
      const label = document.getElementById(t.getAttribute("aria-labelledby")!);
      expect(label?.textContent?.length).toBeGreaterThan(0);
    }
    const svgs = [...$("overview-metrics").querySelectorAll("svg")];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) expect(svg.closest('[aria-hidden="true"]')).not.toBeNull();
    expect($("overview-metrics").querySelector("[aria-live]")).toBeNull();
    expect($("home-fresh").getAttribute("aria-live")).toBeNull();
  });
  it("gauges are meters with words; the map is an image with a sentence and nothing to focus", async () => {
    await signedIn(ownerWorld());
    const meter = limitRow("computers")!.querySelector('[role="meter"]')!;
    expect(meter.getAttribute("aria-valuenow")).toBe("2");
    expect(meter.getAttribute("aria-valuemax")).toBe("3");
    expect(meter.getAttribute("aria-valuetext")).toBe("2 of 3 computers");
    const map = $("home-fleet-map").querySelector("svg")!;
    expect(map.getAttribute("role")).toBe("img");
    expect(map.getAttribute("aria-label")).toBe("Fleet map: 3 working now, 2 online, 1 idle.");
    expect($("home-fleet-card").querySelectorAll("a, button, input, select, textarea, [tabindex]")).toHaveLength(0);
    expect(map.getAttribute("focusable")).toBe("false");
  });
  it("the map is absent whenever Working now is", async () => {
    await signedIn(ownerWorld({ me: identity("ws-a", { role: "agent", memberRole: "member" }), sessions: failed(403) }));
    expect($("overview-happening-section").hidden).toBe(true);
    expect($("home-fleet-card").hidden).toBe(true);
    await signedIn(ownerWorld({ sessions: [] , agents: [] }));
    expect($("home-fleet-card").hidden).toBe(true); // an empty population draws no map
  });
  it("a focused Review button is the same node after two refreshes", async () => {
    const approvals = [{ id: "ap1", requested_by_agent_id: "rb", requested_by_agent_name: "Release-Bot", status: "pending", risk: "high", action: "x", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() }];
    const { ui } = await signedIn(ownerWorld({ approvals }));
    const review = tile("approvals")!.querySelector("button")!;
    expect(review.hidden).toBe(false);
    review.focus();
    await ui.loadAndRender();
    await ui.loadAndRender();
    expect(tile("approvals")!.querySelector("button")).toBe(review);
    expect(document.activeElement).toBe(review);
  });
  it("status is a shape and a word as well as a colour", async () => {
    await signedIn(ownerWorld());
    const glyphs = [...$("home-fleet-map").querySelectorAll(".viz-slab")].map((s) => s.querySelector(".viz-glyph")!.getAttribute("class"));
    expect(glyphs).toEqual(["viz-glyph viz-glyph--online", "viz-glyph viz-glyph--waiting is-ring", "viz-glyph viz-glyph--idle is-ring"]);
    expect($("home-fleet-card").querySelector(".home-legend")!.textContent!.replace(/\s+/g, " ").trim()).toBe("online waiting idle needs you");
  });
});

describe("CSP and markup hygiene", () => {
  // The dashboard's code, without its comments (which name what it must not do).
  const section = APP_JS.slice(APP_JS.indexOf("// ---------- home dashboard"), APP_JS.indexOf("// ---------- fleet ----------"))
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("no style attribute in the page, and the dashboard code writes none, nor any markup", () => {
    expect(section.length).toBeGreaterThan(5000);
    expect(INDEX_HTML).not.toMatch(/\sstyle="/);
    for (const banned of ['setAttribute("style"', ".style.", "cssText", "innerHTML", "insertAdjacentHTML"]) expect(section).not.toContain(banned);
  });
  it("the figures are real SVG, and an agent's name is text, never markup", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    await signedIn(ownerWorld({ sessions: [session("s-evil", { agentName: evil })], agents: [] }));
    const svg = $("home-fleet-map").querySelector("svg")!;
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.querySelector("text")!.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(slabNames()).toEqual(["<img src=x o…"]); // 12 characters and an ellipsis: the slab's right end is its tool's logo
    expect(listNames()).toEqual([evil]);

    expect(document.querySelector("#main img")).toBeNull();
  });
  it("no history, trend, outcome card or 'Live' promise on Home", async () => {
    await signedIn(ownerWorld());
    const home = document.querySelector('[data-panel="overview"]')!.textContent ?? "";
    expect(home).not.toMatch(/last (14|30) days|vs last|sparkline|Activity, last|Expired, treated as denied|needs series endpoint/i);
    expect($("home-fresh-text").textContent).not.toMatch(/\bLive\b/);
  });
});

// ---- mutation checks: the definitions' tests can fail ------------------------------------------------------------------

describe("mutation checks", () => {
  const mutant = (from: string, to: string) => {
    expect(APP_JS).toContain(from);
    return loadConsole(vi.fn(), (s) => s.replace(from, to));
  };
  it("counting in-progress work as open is caught", () => {
    const m = mutant('value: n("open") + n("expired")', 'value: n("open") + n("expired") + n("in_progress")');
    expect(m.openTaskMetric({ open: 1, expired: 2, in_progress: 3, needs_review: 4 }).value).not.toBe(3);
  });
  it("flagging an approval from outside the population is caught", () => {
    const m = mutant("&& ids.has(a.requested_by_agent_id)) out.add", ") out.add");
    m.setMe(identity("ws-a"));
    const approvals = [{ requested_by_agent_id: "elsewhere", status: "pending", expires_at: new Date(Date.now() + 60_000).toISOString() }];
    expect([...m.needsYouIds([{ agentId: "rb" }], approvals, [])]).not.toEqual([]);
  });
  it("measuring the visible roster against the limit is caught", () => {
    const m = mutant('perSeat: true, complete: false', 'perSeat: true, complete: true');
    expect(m.planRows(PRO, { agents: 9, computers: 0, projects: 0 })[0].gauge).toBe(true);
  });
  it("falling back to the roster when sessions failed is caught", () => {
    const m = mutant('if (sessions?.status === "forbidden") {', 'if (sessions?.status === "forbidden" || sessions?.status === "failed") {');
    m.setMe(identity("ws-a"));
    expect(m.homeFleet({ status: "failed", data: null, lastOkAt: 0 }, []).view).toBe("roster");
  });
  it("keeping a source's data after a 403 is caught", async () => {
    const world = ownerWorld();
    const hub = makeHub({ "ws-a": world });
    const from = 'if (read.kind === "forbidden") return { status: "forbidden", data: null, lastOkAt: 0 };';
    expect(APP_JS).toContain(from);
    const m = loadConsole(hub.fetchMock, (s) => s.replace(from, 'if (read.kind === "forbidden") return { ...source, status: "forbidden" };'));
    await flush();
    m.enter("ws-a", world.me);
    await m.loadAndRender();
    world.devices = failed(403);
    await m.loadAndRender();
    // The mutant still measures the refused count; the real code drops it and says who may see it.
    expect(limitRow("computers")!.textContent).toContain("2 / 3");
    expect(limitRow("computers")!.textContent).not.toContain("Only owners and admins");
  });
  it("stamping a source candidate before its renderer is caught by the DOM-bound observation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00"));
    const world = ownerWorld();
    const hub = makeHub({ "ws-a": world });
    const from = "        homeSources[name] = candidate;";
    expect(APP_JS).toContain(from);
    const m = loadConsole(hub.fetchMock, (s) => s.replace(from, "        homeSources[name] = { ...candidate, lastOkAt: Date.now() };"));
    await flush();
    m.enter("ws-a", world.me);
    await m.loadAndRender();
    const previous = m.state().homeSources.roster.lastOkAt;
    await vi.advanceTimersByTimeAsync(1_000);
    const observed: number[] = [];
    const count = $("fleet-count");
    let proto: object | null = count;
    let descriptor: PropertyDescriptor | undefined;
    while (proto && !(descriptor = Object.getOwnPropertyDescriptor(proto, "textContent"))) proto = Object.getPrototypeOf(proto);
    if (!descriptor?.get || !descriptor.set) throw new Error("fleet-count textContent descriptor unavailable");
    Object.defineProperty(count, "textContent", {
      configurable: true,
      get() { return descriptor!.get!.call(this); },
      set(value: string) {
        observed.push(m.state().homeSources.roster.lastOkAt);
        descriptor!.set!.call(this, value);
      },
    });
    await m.loadAndRender();
    expect(observed.some(at => at > previous)).toBe(true); // the mutant publishes freshness before its DOM write
  });
  it("using the latest core completion instead of the oldest required application is caught", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00"));
    const world = ownerWorld();
    const hub = makeHub({ "ws-a": world });
    const from = "Math.min(...applied)";
    expect(APP_JS).toContain(from);
    const m = loadConsole(hub.fetchMock, (s) => s.replace(from, "Math.max(...applied)"));
    await flush();
    m.enter("ws-a", world.me);
    await m.loadAndRender();
    await vi.advanceTimersByTimeAsync(1_000);
    const release = hub.hold("ws-a", "/v1/agents");
    const slow = m.loadAndRender();
    try {
      await flush(100);
      await vi.advanceTimersByTimeAsync(5_000);
    } finally { release(); }
    await slow;
    const required = ["identity", "roster", "tasks", "approvals", "grants"].map(name => m.state().homeSources[name].lastOkAt);
    expect(m.state().homeSources.core.lastOkAt).toBe(Math.max(...required));
    expect(m.state().homeSources.core.lastOkAt).toBeGreaterThan(Math.min(...required));
  });
});
