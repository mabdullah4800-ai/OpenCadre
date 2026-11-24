// @vitest-environment happy-dom
// Fleet's source barrier: the follow-up Codex-OpenCadre-049a recorded on #682. Home applies a 403, a failure or a role
// change as soon as THAT read settles (loadAndRender's src wrapper, homeSources, permissionChanged); Fleet's
// project/computer grouping and its ended-sessions list read the same /v1/org/sessions and /v1/org/devices answers, so
// they must drop a refused source at once too, not after the slowest read in the batch, and must show what Home keeps.
// The harness follows console-home-dashboard-boundaries.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const APP_JS = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8").replace(/\r\n/g, "\n");
const INDEX_HTML = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8").replace(/\r\n/g, "\n");
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

type Fail = { status: number };
type World = {
  me: Record<string, unknown>; agents?: unknown[]; sessions?: unknown[] | Fail; ended?: unknown[] | Fail; devices?: unknown[] | Fail;
  /** The ended read answers on its own (w.ended), even when the live read is refused. */
  endedSplit?: boolean; openTasks?: number;
};
const identity = (orgId: string, over: Record<string, unknown> = {}) => ({
  agentId: `me-${orgId}`, agentName: "Pat", role: "operator", memberRole: "owner", orgId, orgName: `${orgId} Co`,
  webhook_url: null, webhook_auth_set: false, workspace: { paused: false }, ...over,
});
const failed = (status: number): Fail => ({ status });
const recent = () => new Date(Date.now() - 60_000).toISOString();

/** A hub for the console's refresh, with holds that park one request each until released (a hold path with a query
 * parks only that read). A refused sessions route refuses both of its reads (live and ended), as the hub does, unless
 * the world says the ended read answers on its own. */
function makeHub(worlds: Record<string, World>) {
  const gates: Array<{ ws: string; path: string; promise: Promise<void> }> = [];
  const hold = (ws: string, path: string) => {
    let release!: () => void;
    const promise = new Promise<void>((r) => { release = r; });
    gates.push({ ws, path, promise });
    return release;
  };
  const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "";
    const [path, query = ""] = url.split("?");
    const gate = gates.find((g) => g.ws === ws && (g.path === path || (g.path.includes("?") && url.startsWith(g.path))));
    if (gate) { gates.splice(gates.indexOf(gate), 1); await gate.promise; }
    if (path === "/v1/auth/me") return json(401, { error: "Sign in first." });
    const w = worlds[ws];
    if (!w) return json(200, hubReadBody(url) ?? {});
    const list = (v: unknown[] | Fail | undefined, key: string) => (v && !Array.isArray(v) ? json(v.status, { error: "no" }) : json(200, { [key]: v ?? [] }));
    switch (path) {
      case "/v1/me": return json(200, w.me);
      case "/v1/agents": return json(200, { agents: w.agents ?? [] });
      case "/v1/org/devices": return list(w.devices, "devices");
      case "/v1/org/sessions": return list(query.includes("ended") && (w.endedSplit || Array.isArray(w.sessions)) ? w.ended : w.sessions, "sessions");
      case "/v1/tasks": return json(200, { tasks: [], counts: { open: w.openTasks ?? 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 } });
      default: return json(200, hubReadBody(url) ?? {});
    }
  });
  return { fetchMock, hold };
}

type Ui = Record<string, (...a: any[]) => any>;
function loadConsole(fetchMock: unknown): Ui {
  const location = new Proxy(window.location, {
    get(target, key) {
      if (key === "replace") return () => {};
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Function("window", "document", "localStorage", "fetch", "location",
    `${APP_JS}; return {
      loadAndRender, setAgentsView,
      enter: (ws, identity) => { authMode = "session"; currentWorkspace = ws; currentWorkspaceRole = identity.memberRole ?? null; me = identity; },
      state: () => ({ me, homeSources, taskBoard }),
    };`,
  )(window, document, window.localStorage, fetchMock, location) as Ui;
}

class FakeSocket { readyState = 0; close() {} }
beforeEach(() => {
  document.documentElement.innerHTML = INDEX_HTML.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  window.localStorage.clear();
  window.sessionStorage.clear();
  history.replaceState(null, "", "/app/");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OPERATOR_ONLY = "Operators only";
const groups = () => $("fleet-groups").textContent ?? "";
const endedShown = () => !$("sessions-ended").hidden && ($("sessions-ended-list").textContent ?? "").includes("old-chat");

/** An owner of ws-a with one computer (Studio-Mac), one live chat (s1) on it, and one chat that ended an hour ago. */
function ownerWorld(): World {
  return {
    me: identity("ws-a"),
    agents: [{ id: "me-ws-a", name: "Pat", key_class: "human", role: "operator", online: true, status: "active", kind: "named", editing_files_parsed: [], collision_files: [], collision_agents: [] }],
    devices: [{ deviceId: "d1", name: "Studio-Mac", status: "connected", tools: ["codex"], lastSeenAt: recent() }],
    sessions: [{ agentId: "s1", agentName: "s1", tool: "codex", deviceId: "d1", deviceName: "Studio-Mac", projectKey: "api", projectName: "api", online: true, lastHeartbeatAt: recent() }],
    ended: [{ agentId: "old", agentName: "old-chat", tool: "codex", deviceId: "d1", deviceName: "Studio-Mac", projectName: "api", endedAt: recent() }],
  };
}
/** Signed in, first load applied, and the positive control: both groupings and the ended list show the owner's data. */
async function signedIn(world: World) {
  const hub = makeHub({ "ws-a": world });
  const ui = loadConsole(hub.fetchMock);
  await flush();
  ui.enter("ws-a", world.me);
  await ui.loadAndRender();
  expect(groups()).toContain("s1");
  ui.setAgentsView("computer", { record: false });
  expect(groups()).toContain("Studio-Mac");
  ui.setAgentsView("project", { record: false });
  expect(endedShown()).toBe(true);
  return { hub, ui };
}
/** Neither grouping, nor the ended list, shows anything the refused sources answered before. */
function expectFleetDropped(ui: Ui) {
  expect(groups()).not.toContain("s1");
  expect(groups()).toContain(OPERATOR_ONLY);
  ui.setAgentsView("computer", { record: false });
  expect(groups()).not.toContain("Studio-Mac");
  ui.setAgentsView("project", { record: false });
  expect(endedShown()).toBe(false);
}

describe("Fleet source barrier: a refused source leaves Fleet when its answer arrives", () => {
  it("drops denied sessions and computers from Fleet while /v1/agents is held", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    const release = hub.hold("ws-a", "/v1/agents");
    world.sessions = failed(403); world.devices = failed(403);
    const flight = ui.loadAndRender();
    await flush(100);
    try {
      expect(ui.state().homeSources.sessions).toMatchObject({ status: "forbidden", data: null });
      expectFleetDropped(ui);
    } finally { release(); await flight; }
    expectFleetDropped(ui); // and the batch, once it lands, agrees
  });

  it("drops denied sessions and computers from Fleet when a required read fails", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    world.sessions = failed(403); world.devices = failed(403);
    const serve = hub.fetchMock.getMockImplementation()!;
    hub.fetchMock.mockImplementation(async (url, init) => url === "/v1/agents" ? json(500, { error: "temporary failure" }) : serve(url, init));
    await ui.loadAndRender(); await flush(100);
    expect(ui.state().homeSources.devices).toMatchObject({ status: "forbidden", data: null });
    expectFleetDropped(ui);
  });

  it("clears Fleet's operator-only surfaces on a role downgrade while a core read is held, and the new role's 403 applies at once", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    // Both the abandoned batch's /v1/agents and the new generation's are held: nothing in either batch completes.
    const releaseOld = hub.hold("ws-a", "/v1/agents");
    const releaseNew = hub.hold("ws-a", "/v1/agents");
    world.me = identity("ws-a", { role: "agent", memberRole: "member" });
    world.sessions = failed(403); world.devices = failed(403);
    const flight = ui.loadAndRender();
    await flush(200);
    try {
      expect(ui.state().me.memberRole).toBe("member");
      expectFleetDropped(ui);
    } finally { releaseOld(); releaseNew(); await flight; await flush(200); }
    expectFleetDropped(ui);
  });
});

describe("Fleet and Home read one copy of each source", () => {
  it("a failed (not refused) sessions read keeps the last good grouping, as Home keeps its data", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.sessions = failed(500);
    await ui.loadAndRender(); await flush(100);
    expect(ui.state().homeSources.sessions).toMatchObject({ status: "failed" });
    expect(ui.state().homeSources.sessions.data.sessions[0].agentId).toBe("s1");
    expect(groups()).toContain("s1");
    expect(groups()).not.toContain(OPERATOR_ONLY);
  });

  it("a later successful read replaces a refused one in Fleet (the drop is not sticky)", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    const sessions = world.sessions; const devices = world.devices;
    world.sessions = failed(403); world.devices = failed(403);
    await ui.loadAndRender(); await flush(100);
    expectFleetDropped(ui);
    world.sessions = sessions; world.devices = devices;
    await ui.loadAndRender(); await flush(100);
    expect(groups()).toContain("s1");
    expect(endedShown()).toBe(true); // the ended chats come back with the scope that allows them
    expect(ui.state().homeSources.sessions.status).toBe("ok");
  });
});

const endedHidden = () => $("sessions-ended").hidden;
const fleetGroups = () => $("fleet-groups");
/** A refusal of live sessions and computers with /v1/agents held: what is on screen while the batch cannot finish. */
async function refuseWhileHeld(hub: ReturnType<typeof makeHub>, ui: Ui, world: World) {
  const release = hub.hold("ws-a", "/v1/agents");
  world.sessions = failed(403); world.devices = failed(403);
  const flight = ui.loadAndRender();
  await flush(100);
  return async () => { release(); await flight; await flush(100); };
}

describe("Fleet source barrier: a refusal is not held back by an open menu or form", () => {
  it("an open row menu: the refused rows go, the menu with them, and By computer does not paint them back", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    (fleetGroups().querySelector(".row-menu") as HTMLDetailsElement).open = true;
    const finish = await refuseWhileHeld(hub, ui, world);
    try {
      expect(fleetGroups().querySelector(".row-menu")).toBeNull();
      expectFleetDropped(ui);
    } finally { await finish(); }
    expectFleetDropped(ui);
  });

  for (const [form, open] of [
    ["a rename in progress", "Rename"],
    ["a message being written", "Message"],
    ["a removal being confirmed", "Remove"],
  ] as const) {
    it(`${form}: the refused rows go, the form with them, and focus stays in Fleet`, async () => {
      const world = ownerWorld();
      const { hub, ui } = await signedIn(world);
      const btn = [...fleetGroups().querySelectorAll("button")].find((b) => b.textContent === open) as HTMLButtonElement;
      btn.click();
      expect(fleetGroups().querySelector(".rename-form, .message-form, .remove-confirm")).not.toBeNull();
      (fleetGroups().querySelector(".rename-form input, .message-form textarea, .remove-confirm button") as HTMLElement).focus();
      const finish = await refuseWhileHeld(hub, ui, world);
      try {
        expect(fleetGroups().querySelector(".rename-form, .message-form, .remove-confirm")).toBeNull();
        expect(fleetGroups().contains(document.activeElement)).toBe(true);
        expectFleetDropped(ui);
      } finally { await finish(); }
      expectFleetDropped(ui);
    });
  }

  it("keeps an open menu on an ordinary refresh, and a failed (500) sessions read keeps the last good grouping", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    (fleetGroups().querySelector(".row-menu") as HTMLDetailsElement).open = true;
    world.sessions = failed(500);
    await ui.loadAndRender(); await flush(100);
    expect(fleetGroups().querySelector(".row-menu[open]")).not.toBeNull();
    expect(groups()).toContain("s1");
  });

  it("leaves unrelated allowed data alone: other agents, tasks and Home's other sources", async () => {
    const world = ownerWorld();
    world.agents = [...world.agents!, { id: "helper", name: "Helper", key_class: "agent", role: "agent", online: true, status: "active", kind: "named", editing_files_parsed: [], collision_files: [], collision_agents: [] }];
    world.openTasks = 3;
    const { hub, ui } = await signedIn(world);
    (fleetGroups().querySelector(".row-menu") as HTMLDetailsElement).open = true;
    const finish = await refuseWhileHeld(hub, ui, world);
    expect(ui.state().homeSources.events.status).toBe("ok");
    expect(ui.state().homeSources.messages.status).toBe("ok");
    await finish();
    expectFleetDropped(ui);
    expect($("fleet-other-agents").textContent).toContain("Helper");
    expect(ui.state().taskBoard.counts.open).toBe(3);
    expect(ui.state().homeSources.projects.status).toBe("ok");
  });
});

describe("Fleet source barrier: the ended-sessions read has its own barrier", () => {
  it("clears withdrawn ended content and summary, then restores a later accepted list", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    const previous = world.ended;
    expect($("sessions-ended-summary").textContent).toBe("1 ended in the last 24 hours");
    world.ended = [];
    await ui.loadAndRender();
    expect(endedHidden()).toBe(true);
    expect($("sessions-ended-list").textContent).toBe("");
    expect($("sessions-ended-list").children).toHaveLength(0);
    expect($("sessions-ended-summary").textContent).toBe("");
    world.ended = previous;
    await ui.loadAndRender();
    expect(endedShown()).toBe(true);
    expect($("sessions-ended-summary").textContent).toBe("1 ended in the last 24 hours");
  });

  it("withdraws retained names and summary when every ended row ages beyond one day", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.ended = [{ agentId: "old", agentName: "old-chat", endedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }];
    await ui.loadAndRender();
    expect(endedHidden()).toBe(true);
    expect($("sessions-ended-list").textContent).toBe("");
    expect($("sessions-ended-summary").textContent).toBe("");
    expect(groups()).toContain("s1");
  });

  it("an ended-only 403 clears the old ended chats while /v1/agents is held", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    const release = hub.hold("ws-a", "/v1/agents");
    world.ended = failed(403);
    const flight = ui.loadAndRender();
    await flush(100);
    try {
      expect(endedHidden()).toBe(true);
      expect(groups()).toContain("s1"); // the live grouping was allowed: it stays
    } finally { release(); await flight; await flush(100); }
    expect(endedHidden()).toBe(true);
    expect(groups()).toContain("s1");
  });

  for (const first of ["live", "ended"] as const) {
    it(`a live 403 with an ended 200 (${first} answers first) never shows a chat from the refused scope`, async () => {
      const world = ownerWorld();
      const { hub, ui } = await signedIn(world);
      const releaseCore = hub.hold("ws-a", "/v1/agents");
      const releaseLive = hub.hold("ws-a", "/v1/org/sessions?status=live");
      const releaseEnded = hub.hold("ws-a", "/v1/org/sessions?status=ended");
      world.sessions = failed(403); world.endedSplit = true;
      world.ended = [{ agentId: "new", agentName: "new-chat", tool: "codex", deviceId: "d1", deviceName: "Studio-Mac", projectName: "api", endedAt: recent() }];
      const flight = ui.loadAndRender();
      await flush(100);
      try {
        if (first === "live") {
          releaseLive(); await flush(100);
          expect(endedHidden()).toBe(true);
          releaseEnded(); await flush(100);
        } else {
          releaseEnded(); await flush(100);
          releaseLive(); await flush(100);
        }
        expect(endedHidden()).toBe(true);
      } finally { releaseLive(); releaseEnded(); releaseCore(); await flight; await flush(100); }
      expect(ui.state().homeSources.sessions.status).toBe("forbidden");
      expect(endedHidden()).toBe(true);
      expect($("sessions-ended-list").textContent).not.toContain("new-chat");
    });
  }
});

describe("Fleet source barrier: source hygiene", () => {
  const body = APP_JS.slice(APP_JS.indexOf("async function loadAndRender()"), APP_JS.indexOf("// ---------- overview ----------"));
  it("adds no inline style and no el.style write to the refresh", () => {
    expect(body).not.toMatch(/\.style\b|style:|setAttribute\(\s*["']style/);
  });
});
