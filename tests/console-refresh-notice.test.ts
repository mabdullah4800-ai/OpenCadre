// @vitest-environment happy-dom
// Console dashboard phase 2, item A: stale and failed sources are announced through #refresh-notice (plan
// B:\ai-work\temp\9d1f-ambient\plan-dashboard-phase2.md rev 2.1 §1, as Codex-OpenCadre-049a ruled). Two nodes: the
// visible line (#refresh-notice, no live role) shows the top-priority sentence; a hidden polite announcer
// (#refresh-announce) is written ONLY with the sentence of a newly started episode. A failure that becomes a 403 is
// silent and removes its line; a good core read keeps an optional source's line; an open episode is never announced
// twice; a new generation (workspace switch, role change) empties both, and an old generation's late answer writes
// nothing. The harness follows console-home-dashboard-boundaries.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement | null;
const APP_JS = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8").replace(/\r\n/g, "\n");
const INDEX_HTML = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8").replace(/\r\n/g, "\n");
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

type Fail = { status: number };
type World = {
  me: Record<string, unknown>;
  sessions?: unknown[] | Fail; devices?: unknown[] | Fail; projects?: unknown[] | Fail; messages?: unknown[] | Fail; events?: unknown[] | Fail;
  approvals?: Fail;
};
const identity = (orgId: string, over: Record<string, unknown> = {}) => ({
  agentId: `me-${orgId}`, agentName: "Pat", role: "operator", memberRole: "owner", orgId, orgName: `${orgId} Co`,
  webhook_url: null, webhook_auth_set: false, workspace: { paused: false }, ...over,
});
const failed = (status: number): Fail => ({ status });
const ownerWorld = (orgId = "ws-a"): World => ({ me: identity(orgId) });

/** A hub for the console's refresh: per-workspace answers (a Fail answers with that status and a hub error body that
 * must never reach either node), and holds that park one request until released. */
const HUB_ERROR_BODY = "hub-error-body-must-not-show";
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
    const gate = gates.find((g) => g.ws === ws && (g.prefix.includes("?") ? url.startsWith(g.prefix) : url.split("?")[0] === g.prefix));
    if (gate) {
      if (gate.skip > 0) gate.skip--;
      else { gates.splice(gates.indexOf(gate), 1); await gate.promise; }
    }
    const [path, query = ""] = url.split("?");
    if (path === "/v1/auth/me") {
      if (!state.authed) return json(401, { error: "Sign in first." });
      return json(200, { person: { id: "p1", name: "Pat" }, workspaces: Object.entries(worlds).map(([orgId, w]) => ({ orgId, name: orgId, role: w.me.memberRole ?? "owner" })) });
    }
    const w = worlds[ws];
    if (!w) return json(200, hubReadBody(url) ?? {});
    const list = (v: unknown[] | Fail | undefined, key: string) => (v && !Array.isArray(v) ? json(v.status, { error: HUB_ERROR_BODY }) : json(200, { [key]: v ?? [] }));
    switch (path) {
      case "/v1/me": return json(200, w.me);
      case "/v1/approvals": return w.approvals && query.includes("pending") ? json(w.approvals.status, { error: HUB_ERROR_BODY }) : json(200, { approvals: [] });
      case "/v1/events": return list(w.events, "events");
      case "/v1/messages": return list(w.messages, "messages");
      case "/v1/org/devices": return list(w.devices, "devices");
      case "/v1/org/sessions": return query.includes("ended") ? json(200, { sessions: [] }) : list(w.sessions, "sessions");
      case "/v1/org/projects": return list(w.projects, "projects");
      default: return json(200, hubReadBody(url, w.me) ?? {});
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
      loadAndRender, enterWorkspace,
      enter: (ws, identity) => { authMode = "session"; currentWorkspace = ws; currentWorkspaceRole = identity.memberRole ?? null; me = identity; },
      state: () => ({ me, consoleGeneration, homeSources }),
    };`,
  )(window, document, window.localStorage, fetchMock, location) as Ui;
}

/** Every textContent write to the announcer, in order (the console writes both nodes with textContent only; the
 * hygiene test below pins that). Installed on the node itself, so a missing node records nothing and the counts fail. */
let writes: string[] = [];
function spyAnnouncer() {
  writes = [];
  const node = $("refresh-announce");
  if (!node) return;
  let proto: object | null = node;
  let desc: PropertyDescriptor | undefined;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, "textContent"))) proto = Object.getPrototypeOf(proto);
  Object.defineProperty(node, "textContent", {
    configurable: true,
    get() { return desc!.get!.call(this); },
    set(v: string) { writes.push(String(v)); desc!.set!.call(this, v); },
  });
}
const said = () => writes.filter((w) => w.trim() !== "");
const line = () => $("refresh-notice")?.textContent ?? "";
const announcer = () => $("refresh-announce")?.textContent ?? "";

class FakeSocket { readyState = 0; close() {} }
beforeEach(() => {
  document.documentElement.innerHTML = INDEX_HTML.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  window.localStorage.clear();
  window.sessionStorage.clear();
  history.replaceState(null, "", "/app/");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00"));
  spyAnnouncer();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Signed in as ws-a's owner with a clean first load at 12:00:00: both nodes empty, nothing said. */
async function signedIn(world: World = ownerWorld(), mutate?: (src: string) => string) {
  const hub = makeHub({ "ws-a": world });
  const ui = loadConsole(hub.fetchMock, mutate);
  await flush();
  ui.enter("ws-a", world.me);
  await ui.loadAndRender();
  expect(line()).toBe("");
  expect(said()).toEqual([]);
  return { hub, ui };
}
/** The next 4 s poll, with the clock moved on. */
async function poll(ui: Ui) {
  await vi.advanceTimersByTimeAsync(4000);
  await ui.loadAndRender();
  await flush(50);
}
const RECENT = "Recent activity couldn't refresh. Showing data from 12:00:00.";
const QUESTIONS = "Questions couldn't refresh. Showing data from 12:00:04.";
const PLAN = "Plan limits couldn't refresh. Showing data from 12:00:00.";
const CORE = "Couldn't refresh. Trying again every few seconds.";

describe("two nodes: a visible line and a polite announcer", () => {
  it("the visible line has no live role; the announcer is a hidden polite status, never assertive", () => {
    const visible = $("refresh-notice");
    const live = $("refresh-announce");
    expect(visible).not.toBeNull();
    expect(live).not.toBeNull();
    expect(visible!.getAttribute("role")).toBeNull();
    expect(visible!.getAttribute("aria-live")).toBeNull();
    expect(live!.getAttribute("role")).toBe("status");
    expect(live!.getAttribute("aria-live")).toBe("polite");
    expect(live!.classList.contains("visually-hidden")).toBe(true);
    expect(INDEX_HTML).not.toMatch(/aria-live="assertive"/);
  });
});

describe("a failing optional source", () => {
  it("is announced once, naming its card and its own time, and stays on the visible line while core reads are good", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.events = failed(500);
    for (let i = 0; i < 4; i++) await poll(ui);
    expect(ui.state().homeSources.events.status).toBe("failed");
    expect(ui.state().homeSources.core.failed).toBe(false);
    expect(line()).toBe(RECENT); // its own lastOkAt (12:00:00), not core's (12:00:16)
    expect(said()).toEqual([RECENT]);
  });

  it("a good core read does not erase it (the clear-on-every-good-read is split)", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.events = failed(500);
    await poll(ui);
    expect(said()).toEqual([RECENT]);
    world.events = failed(503); // still failing (another kind of failure): only the core reads are good
    await poll(ui);
    await poll(ui);
    expect(line()).toBe(RECENT);
    expect(said()).toEqual([RECENT]);
  });

  it("mutation: forgetting the open episodes on every good core read makes it speak again on every poll", async () => {
    // A good core pass that clears everything instead of ending only the failed refresh: the source's sentence comes
    // back as a NEW episode on the same pass and is announced again on every poll.
    const from = "    else refreshFailure = null;";
    expect(APP_JS).toContain(from);
    const mutate = (src: string) => src.replace(from, "    else { refreshFailure = null; noticeOpen = new Set(); }");
    expect(mutate(APP_JS)).not.toBe(APP_JS);
    const world = ownerWorld();
    const { ui } = await signedIn(world, mutate);
    world.events = failed(500);
    await poll(ui);
    await poll(ui);
    expect(said().length).toBeGreaterThan(1);
  });

  it("a newly failing optional source announces only itself while another source's line is up", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.events = failed(500);
    await poll(ui);
    world.messages = failed(500);
    await poll(ui);
    await poll(ui);
    expect(said()).toEqual([RECENT, QUESTIONS]); // Questions' own data is from the poll before it failed
    expect(line()).toBe(`${RECENT} ${QUESTIONS}`);
  });

  it("recovering ends the episode; failing again is a new episode, announced again", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.events = failed(500);
    await poll(ui);
    world.events = undefined;
    await poll(ui); // applied success at 12:00:08
    expect(line()).toBe("");
    expect(announcer()).toBe(""); // emptied, so it never holds a sentence about an episode that ended
    world.events = failed(500);
    await poll(ui);
    expect(said()).toEqual([RECENT, "Recent activity couldn't refresh. Showing data from 12:00:08."]);
  });
});

describe("a 403 is never announced", () => {
  it("failed then 403: the line goes, nothing is said, and nothing mentions the refusal", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.events = failed(500);
    await poll(ui);
    expect(said()).toEqual([RECENT]);
    world.events = failed(403);
    await poll(ui);
    await poll(ui);
    expect(ui.state().homeSources.events.status).toBe("forbidden");
    expect(line()).toBe("");
    expect(announcer()).toBe("");
    expect(said()).toEqual([RECENT]);
    for (const text of [line(), ...writes]) expect(text).not.toMatch(/403|permission|forbidden|not allowed/i);
  });

  it("ok then 403 is silent", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.events = failed(403); world.messages = failed(403);
    await poll(ui);
    expect(line()).toBe("");
    expect(said()).toEqual([]);
  });

  it("two failing, one becomes 403: the line names the other only, and nothing new is said", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.events = failed(500); world.devices = failed(500);
    await poll(ui);
    expect(line()).toBe(`${RECENT} ${PLAN}`);
    expect(said()).toEqual([`${RECENT} ${PLAN}`]); // one refresh opened both: said together, once
    const before = writes.length;
    world.devices = failed(403);
    await poll(ui);
    expect(line()).toBe(RECENT);
    expect(said()).toEqual([`${RECENT} ${PLAN}`]);
    expect(writes.slice(before).every((w) => w === "")).toBe(true);
  });

  it("a 403 that arrives while a core read is held removes the line at once", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    world.events = failed(500);
    await poll(ui);
    const release = hub.hold("ws-a", "/v1/agents");
    world.events = failed(403);
    const flight = ui.loadAndRender();
    await flush(100);
    try {
      expect(line()).toBe("");
      expect(said()).toEqual([RECENT]);
    } finally { release(); await flight; }
  });
});

describe("priority is re-evaluated without repeating an announcement", () => {
  it("core fails over a failing source: core is announced once; core recovers: the source line returns, not re-announced", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.events = failed(500);
    await poll(ui);
    world.approvals = failed(500); // a required read: the core refresh fails
    await poll(ui);
    await poll(ui);
    expect(line()).toBe(CORE);
    expect(said()).toEqual([RECENT, CORE]);
    world.approvals = undefined;
    await poll(ui);
    expect(line()).toBe(RECENT);
    expect(announcer()).toBe("");
    expect(said()).toEqual([RECENT, CORE]);
  });

  it("core stale on Home is announced once, not on every tick", async () => {
    const { ui } = await signedIn();
    await vi.advanceTimersByTimeAsync(30_000); // the 5 s tick runs; no poll lands
    expect(line()).toBe("Home may be out of date. Last updated 12:00:00.");
    expect(said()).toEqual(["Home may be out of date. Last updated 12:00:00."]);
    await ui.loadAndRender();
    expect(line()).toBe("");
    expect(announcer()).toBe("");
  });
});

describe("a viewer or generation change clears the notice state", () => {
  it("a workspace switch empties both nodes before the new workspace answers, and A's late failure writes nothing", async () => {
    const worlds = { "ws-a": ownerWorld("ws-a"), "ws-b": ownerWorld("ws-b") };
    const hub = makeHub(worlds);
    const ui = loadConsole(hub.fetchMock);
    await flush();
    hub.state.authed = true;
    await ui.enterWorkspace("ws-a");
    await flush(50);
    worlds["ws-a"].events = failed(500);
    await poll(ui);
    expect(line()).toBe(RECENT);
    expect(said()).toEqual([RECENT]);
    // A's next poll has a failing messages read parked; B's identity is held.
    worlds["ws-a"].messages = failed(500);
    const releaseA = hub.hold("ws-a", "/v1/messages");
    void ui.loadAndRender();
    await flush(50);
    const releaseB = hub.hold("ws-b", "/v1/me");
    const entering = ui.enterWorkspace("ws-b");
    await flush(50);
    try {
      expect(line()).toBe("");
      expect(announcer()).toBe("");
      releaseA(); // A's failure answers into B's generation
      await flush(100);
      expect(line()).toBe("");
      expect(said()).toEqual([RECENT]);
    } finally { releaseA(); releaseB(); await entering; await flush(100); }
    expect(line()).toBe("");
    expect(said()).toEqual([RECENT]);
  });

  it("a role change starts a new generation and empties both nodes at once", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    world.events = failed(500);
    await poll(ui);
    expect(line()).toBe(RECENT);
    const generation = ui.state().consoleGeneration;
    // The poll that sees the new role abandons its batch; the new generation's own /v1/me is held.
    world.me = identity("ws-a", { role: "agent", memberRole: "member" });
    world.events = undefined;
    const releaseNew = hub.hold("ws-a", "/v1/me", 1);
    const flight = ui.loadAndRender();
    await flush(100);
    try {
      expect(ui.state().consoleGeneration).toBeGreaterThan(generation);
      expect(line()).toBe("");
      expect(announcer()).toBe("");
    } finally { releaseNew(); await flight; await flush(100); }
    expect(said()).toEqual([RECENT]);
  });

  it("a late answer from an old generation is ignored, even a failure that would start an episode", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    world.events = failed(500);
    // Three events reads are parked: the gen-N poll's, the poll that sees the role change (asked under gen N), and
    // the new generation's own.
    const [releaseOld, releaseAsked, releaseNew] = [0, 1, 2].map(() => hub.hold("ws-a", "/v1/events"));
    void ui.loadAndRender();
    await flush(50);
    world.me = identity("ws-a", { role: "agent", memberRole: "member" });
    void ui.loadAndRender(); // sees the new role: a new generation begins
    await flush(100);
    try {
      expect(line()).toBe("");
      releaseOld(); releaseAsked(); // both failures answer into the new generation
      await flush(100);
      expect(ui.state().homeSources.events.status).toBe("pending");
      expect(line()).toBe("");
      expect(said()).toEqual([]);
    } finally { releaseOld(); releaseAsked(); releaseNew(); await flush(100); }
  });
});

describe("mutation: the 403 guard, which passes on origin/main, can fail", () => {
  it("counting a refusal as a failure makes 'ok then 403 is silent' speak", async () => {
    const mutate = (src: string) => src.replace(`homeSources[n]?.status === "failed"`, `!["ok", "pending", undefined].includes(homeSources[n]?.status)`);
    expect(mutate(APP_JS)).not.toBe(APP_JS);
    const world = ownerWorld();
    const { ui } = await signedIn(world, mutate);
    world.events = failed(403);
    await poll(ui);
    expect(said().length).toBeGreaterThan(0);
  });
});

describe("hygiene", () => {
  const body = APP_JS.slice(APP_JS.indexOf("const REFRESH_NOTICE_TEXT"), APP_JS.indexOf("/** Whose data the console shows is changing"))
    + APP_JS.slice(APP_JS.indexOf("function syncNotice("), APP_JS.indexOf("/** A card's own \"showing data from\""));
  it("writes both nodes with textContent only: no markup, no inline style, no hub error body", async () => {
    expect(body).toMatch(/refresh-announce/);
    expect(body).toMatch(/showRefreshFailure/);
    expect(body).not.toMatch(/innerHTML|insertAdjacentHTML|\.style\b|style:|setAttribute\(\s*["']style|assertive/);
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.events = failed(500); world.messages = failed(503);
    await poll(ui);
    expect(said()).toEqual([`${RECENT} Questions couldn't refresh. Showing data from 12:00:00.`]);
    for (const text of [line(), ...writes]) expect(text).not.toContain(HUB_ERROR_BODY);
  });
});

// Codex-OpenCadre-049a's controls on a587ca63 (review of #696), copied verbatim: episodes are per SOURCE, and a
// simultaneous failure is one coherent polite update, not an overwrite.
describe('root independent source-episode and announcement controls',()=>{
 it('a second failing source under the same card starts its own announcement episode',async()=>{
 const world=ownerWorld();const {ui}=await signedIn(world);world.devices=failed(500);await poll(ui);
 expect(said()).toHaveLength(1);world.projects=failed(500);await poll(ui);
 expect(ui.state().homeSources.projects.status).toBe('failed');
 expect(said()).toHaveLength(2);
 });
 it('a simultaneous two-card failure leaves both new sentences in the live region',async()=>{
 const world=ownerWorld();const {ui}=await signedIn(world);world.events=failed(500);world.devices=failed(500);await poll(ui);
 expect(line()).toBe(RECENT+' '+PLAN);
 expect(announcer()).toBe(RECENT+' '+PLAN);
 });
});

describe("episodes are per source; one refresh's new failures are one polite update", () => {
  const planFrom = (t: string) => `Plan limits couldn't refresh. Showing data from ${t}.`;

  it("staggered same-card failures, then recovery, then refusal: each source opens its own episode, an open one is never said again", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.devices = failed(500);
    await poll(ui); // 12:00:04
    expect(said()).toEqual([PLAN]);
    world.projects = failed(500);
    await poll(ui); // 12:00:08: projects' own data is from 12:00:04; the card line keeps the oldest time
    await poll(ui); // both still failing
    expect(line()).toBe(PLAN);
    expect(said()).toEqual([PLAN, PLAN]);
    expect(announcer()).toBe(PLAN);
    world.devices = undefined;
    await poll(ui); // 12:00:16: devices recovers; projects' line remains, with its own time
    expect(line()).toBe(planFrom("12:00:04"));
    expect(announcer()).toBe("");
    world.projects = failed(403);
    await poll(ui); // 12:00:20
    expect(line()).toBe("");
    expect(announcer()).toBe("");
    world.devices = failed(500);
    await poll(ui); // 12:00:24: devices again, a new episode
    expect(said()).toEqual([PLAN, PLAN, planFrom("12:00:20")]);
    for (const text of [line(), ...writes]) expect(text).not.toMatch(/403|permission|forbidden|not allowed/i);
  });

  it("three cards failing in one refresh: the live region ends holding all three sentences, written once", async () => {
    const world = ownerWorld();
    const { ui } = await signedIn(world);
    world.events = failed(500); world.messages = failed(500); world.devices = failed(500);
    await poll(ui);
    const all = `${RECENT} Questions couldn't refresh. Showing data from 12:00:00. ${PLAN}`;
    expect(line()).toBe(all);
    expect(announcer()).toBe(all);
    expect(said()).toEqual([all]);
  });

  it("holds notices until the bounded core scope settles, then announces once and ignores its late answer", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    world.events = failed(500);
    world.devices = failed(500);
    const releaseApprovals = hub.hold("ws-a", "/v1/approvals?status=pending");
    const flight = ui.loadAndRender();
    const timeout = "Dashboard reads timed out. Trying again every few seconds.";
    const stale = "Home may be out of date. Last updated 12:00:00.";
    const expectedAnnouncements = [stale, `${timeout} ${RECENT} ${PLAN}`];
    let approvalLastOkAt = 0;
    try {
      await flush(100);
      expect(ui.state().homeSources.roster.status).toBe("ok");
      expect(ui.state().homeSources.tasks.status).toBe("ok"); // healthy peers applied independently
      expect(line()).toBe(`${RECENT} ${PLAN}`);
      expect(said()).toEqual([]);
      approvalLastOkAt = ui.state().homeSources.approvals.lastOkAt;

      await vi.advanceTimersByTimeAsync(14_999);
      expect(said()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1); // this read's 15 s deadline settles the held scope
      await flight;
      expect(ui.state().homeSources.approvals).toMatchObject({ status: "failed", lastOkAt: approvalLastOkAt });
      expect(line()).toBe(timeout);
      const announcement = `${timeout} ${RECENT} ${PLAN}`;
      expect(said()).toEqual(expectedAnnouncements); // stale freshness and the bounded failure are separate episodes
      expect(announcer()).toBe(announcement);

      releaseApprovals(); // this successful response arrives after its own bounded scope expired
      await flush(100);
      expect(ui.state().homeSources.approvals).toMatchObject({ status: "failed", lastOkAt: approvalLastOkAt });
      expect(said()).toEqual(expectedAnnouncements); // late answer does not repeat either announcement
      expect(line()).toBe(timeout);
    } finally { releaseApprovals(); await flight; await flush(50); }

    world.events = undefined;
    world.devices = undefined;
    await ui.loadAndRender();
    expect(line()).toBe("");
    expect(said()).toEqual(expectedAnnouncements); // recovery closes the episode quietly
  });
  it("a refusal clears at once while a core read is held; the held sentence names only the source that opened", async () => {
    const world = ownerWorld();
    const { hub, ui } = await signedIn(world);
    world.events = failed(500);
    await poll(ui); // 12:00:04
    expect(said()).toEqual([RECENT]);
    const release = hub.hold("ws-a", "/v1/agents");
    world.events = failed(403); world.devices = failed(500);
    await vi.advanceTimersByTimeAsync(4000);
    const flight = ui.loadAndRender();
    await flush(100);
    try {
      expect(line()).toBe(planFrom("12:00:04"));
      expect(announcer()).toBe(""); // the refused source's sentence is gone at once, not after the core read
      expect(said()).toEqual([RECENT]);
    } finally { release(); await flight; await flush(50); }
    expect(announcer()).toBe(planFrom("12:00:04"));
    expect(said()).toEqual([RECENT, planFrom("12:00:04")]);
    for (const text of [line(), ...writes]) expect(text).not.toMatch(/403|permission|forbidden|not allowed/i);
  });

  it("a held sentence from an old generation is dropped, and the new generation still speaks", async () => {
    const worlds = { "ws-a": ownerWorld("ws-a"), "ws-b": ownerWorld("ws-b") };
    const hub = makeHub(worlds);
    const ui = loadConsole(hub.fetchMock);
    await flush();
    hub.state.authed = true;
    await ui.enterWorkspace("ws-a");
    await flush(50);
    await poll(ui); // whatever entering scheduled has run
    worlds["ws-a"].events = failed(500);
    const releaseA = hub.hold("ws-a", "/v1/agents");
    await vi.advanceTimersByTimeAsync(4000); // the console's own poll runs, and its core read is held
    await flush(50);
    try {
      expect(line()).toMatch(/^Recent activity couldn't refresh\. Showing data from 12:00:\d\d\.$/);
      expect(said()).toEqual([]); // held: A's refresh is still out
      await ui.enterWorkspace("ws-b");
      await flush(50);
      expect(line()).toBe("");
      expect(announcer()).toBe("");
    } finally { releaseA(); await flush(100); }
    await poll(ui);
    expect(line()).toBe("");
    expect(said()).toEqual([]);
    worlds["ws-b"].messages = failed(500);
    await poll(ui);
    expect(said()).toEqual([line()]);
    expect(line()).toMatch(/^Questions couldn't refresh\. Showing data from 12:00:\d\d\.$/);
  });
});

// Codex-OpenCadre-049a's controls on 84a0e08c (review of #696), copied verbatim: the 5 s freshness tick respects
// the refresh's announcement hold, so it neither says a partial update early nor leaves the final region partial.
describe('root refresh-boundary tick control',()=>{
 it('freshness ticks do not flush a partial held announcement before the refresh settles',async()=>{
 const world=ownerWorld();const {hub,ui}=await signedIn(world);
 const releaseCore=hub.hold('ws-a','/v1/agents');const releaseDevice=hub.hold('ws-a','/v1/org/devices');
 world.events=failed(500);world.devices=failed(500);const flight=ui.loadAndRender();await flush(100);
 try {expect(said()).toEqual([]);
 await vi.advanceTimersByTimeAsync(5000);await flush(100);
 expect(said()).toEqual([]);
 } finally {releaseDevice();releaseCore();await flight;await flush(100);}
 expect(announcer()).toBe(RECENT+' '+PLAN);
 expect(said()).toEqual([RECENT+' '+PLAN]);
 });
});

describe('root held-refresh final live-region control',()=>{
 it('the final region preserves both new source failures even when a freshness tick occurs',async()=>{
 const world=ownerWorld();const {hub,ui}=await signedIn(world);const releaseCore=hub.hold('ws-a','/v1/agents');const releaseDevice=hub.hold('ws-a','/v1/org/devices');world.events=failed(500);world.devices=failed(500);const flight=ui.loadAndRender();await flush(100);
 expect(said()).toEqual([]);await vi.advanceTimersByTimeAsync(5000);await flush(100);const during=[...said()];releaseDevice();releaseCore();await flight;await flush(100);
 console.log(JSON.stringify({during,after:said(),visible:line(),live:announcer()}));
 expect(line()).toBe(RECENT+' '+PLAN);expect(announcer()).toBe(RECENT+' '+PLAN);
 });
});

describe("every way into the notice waits for this generation's refresh", () => {
  const STALE = "Home may be out of date. Last updated 12:00:00.";
  // This console's own visibilitychange listener, called alone: dispatching on the shared document would also wake the
  // consoles earlier tests loaded, and they write the same two nodes.
  let onVisibility: () => void = () => {};
  const hide = (hidden: boolean) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    onVisibility();
  };
  beforeEach(() => {
    const add = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type: string, fn: any, opts?: any) => {
      if (type === "visibilitychange") onVisibility = fn;
      return add(type, fn, opts);
    });
  });
  afterEach(() => { delete (document as { hidden?: boolean }).hidden; });
  const entries: Record<string, () => Promise<void>> = {
    "the real 5 s freshness tick": async () => {
      await vi.advanceTimersByTimeAsync(4999);
      expect(said()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1); // the interval's own 5 s, not a direct call
    },
    "a Retry the person pressed": async () => { (document.querySelector("[data-home-retry]") as HTMLElement).click(); },
    "the page hidden, then shown and ticked": async () => {
      hide(true);
      await vi.advanceTimersByTimeAsync(5000);
      hide(false);
      await vi.advanceTimersByTimeAsync(5000);
    },
  };
  for (const [name, enter] of Object.entries(entries)) {
    it(`${name}: says nothing while the refresh is out, then the whole refresh once`, async () => {
      const world = ownerWorld();
      const { hub, ui } = await signedIn(world);
      const releaseCore = hub.hold("ws-a", "/v1/agents");
      const releaseDevices = hub.hold("ws-a", "/v1/org/devices");
      world.events = failed(500); world.devices = failed(500);
      const flight = ui.loadAndRender();
      await flush(100);
      try {
        expect(line()).toBe(RECENT); // the visible line is immediate
        await enter();
        await flush(100);
        expect(said()).toEqual([]);
      } finally { releaseDevices(); releaseCore(); await flight; await flush(100); }
      expect(line()).toBe(`${RECENT} ${PLAN}`);
      expect(announcer()).toBe(`${RECENT} ${PLAN}`);
      expect(said()).toEqual([`${RECENT} ${PLAN}`]);
    });
  }

  it("a stale transition is announced during a held read before its 15 s deadline; the source failure follows on settle", async () => {
    const world = ownerWorld();
    const mutateStaleThreshold = (src: string) => src.replace("const HOME_STALE_MS = 3 * POLL_MS;", "const HOME_STALE_MS = 4_000;");
    expect(mutateStaleThreshold(APP_JS)).not.toBe(APP_JS); // test stale while a bounded read is still pending
    const { hub, ui } = await signedIn(world, mutateStaleThreshold);
    const release = hub.hold("ws-a", "/v1/agents");
    world.events = failed(500);
    const flight = ui.loadAndRender();
    try {
      await vi.advanceTimersByTimeAsync(5_000); // first tick crosses the test-only 4 s threshold, below the 15 s deadline
      expect(ui.state().homeSources.roster.lastOkAt).toBeGreaterThan(0); // old roster still supplies the freshness age
      expect(line()).toBe(RECENT); // source line outranks stale on the visible node
      expect(said()).toEqual([STALE]); // stale is not this refresh's pending response
    } finally { release(); await flight; await flush(100); }
    expect(line()).toBe(RECENT);
    expect(said()).toEqual([STALE, RECENT]);
  });
});
