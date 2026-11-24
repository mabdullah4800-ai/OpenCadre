// @vitest-environment happy-dom
// Dashboard phase 2, item B (B:\ai-work\temp\9d1f-ambient\plan-dashboard-phase2.md rev 2.1, Codex-OpenCadre-049a ruling
// Q2, Policy M): "Live agents" becomes a gauge, on Home and in Settings, only from the hub's workspace count
// (/v1/me billing.used.agents = countLiveAgents, the set the limit counts) and never from the roster this viewer can see
// (phase 1 ruling 1). Null is withheld and reads "Up to N"; an older hub without the field keeps phase 1's rows. The
// count rides /v1/me, a core read: a 403 drops it at once, a failure keeps it, a role change clears it with the rest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const APP_JS = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8").replace(/\r\n/g, "\n");
const INDEX_HTML = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8").replace(/\r\n/g, "\n");
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const PRO = {
  plan: "pro", planName: "Pro", subscriptionStatus: "active", trialEndsAt: null, readOnly: false, reason: null, graceEndsAt: null, seats: 1,
  limits: { key: "pro", name: "Pro", maxAgents: 10, maxMachines: 3, maxProjects: 5, maxWorkspaces: 1, maxWebhooks: 2, retentionDays: 90, trialDays: null },
  awaitingPlan: false, trialConvertsAt: null,
};
const billing = (agents: number | null | undefined, over: Record<string, unknown> = {}) =>
  (agents === undefined ? { ...PRO, ...over } : { ...PRO, ...over, used: { agents } });
const identity = (over: Record<string, unknown> = {}) => ({
  agentId: "me-ws-a", agentName: "Pat", role: "operator", memberRole: "owner", orgId: "ws-a", orgName: "ws-a Co",
  webhook_url: null, webhook_auth_set: false, workspace: { paused: false }, billing: billing(4), ...over,
});
const agent = (id: string, online = true) => ({ id, name: id, online, editing_files_parsed: [], collision_files: [], collision_agents: [], status: "active", kind: "named", key_class: "agent", role: "agent" });

type World = { me: Record<string, unknown>; meStatus?: number; authMe?: unknown; agents: unknown[]; holdNextMe?: number; holdNextAgents?: Promise<void>; planRefusal?: boolean };
function makeHub(world: World) {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const [path, query = ""] = url.split("?");
    if (path === "/v1/auth/me") return world.authMe ? json(200, world.authMe) : json(401, { error: "Sign in first." });
    if (path === "/v1/org/devices" && init?.method === "POST" && world.planRefusal) return json(402, { error: "Alpha private plan limit", code: "PLAN_LIMIT" });
    switch (path) {
      case "/v1/me":
        // holdNextMe: answer that many more reads, then park every later one (a refresh that never lands).
        if (world.holdNextMe !== undefined && world.holdNextMe-- <= 0) return new Promise(() => {});
        return world.meStatus ? json(world.meStatus, { error: "no" }) : json(200, world.me);
      case "/v1/agents": {
        const agents = world.agents;
        const hold = world.holdNextAgents;
        world.holdNextAgents = undefined;
        if (hold) await hold;
        return json(200, { agents });
      }
      case "/v1/approvals": return json(200, { approvals: [] });
      case "/v1/approval-grants": return json(200, { grants: [] });
      case "/v1/tasks": return json(200, { tasks: [], counts: { open: 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 } });
      case "/v1/events": return json(200, { events: [] });
      case "/v1/messages": return json(200, { messages: [] });
      case "/v1/org/devices": return json(200, { devices: [{ status: "connected" }] });
      case "/v1/org/sessions": return json(200, { sessions: [] });
      case "/v1/org/projects": return json(200, { projects: [{ enabled: true }] });
      default: return json(200, hubReadBody(url) ?? (query ? {} : {}));
    }
  });
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
      loadAndRender, planRows, planUsage, api, enterWorkspace,
      enter: (ws, identity) => { authMode = "session"; currentWorkspace = ws; currentWorkspaceRole = identity.memberRole ?? null; person = { id: "person-a", name: "Pat", email: "pat@example.test" }; me = identity; showPage("console"); },
      enterKey: (identity, key = "fixture-key") => { authMode = "key"; agentKey = key; currentWorkspace = null; currentWorkspaceRole = null; person = null; me = identity; $("org-name").textContent = identity.orgName ?? ""; renderSidebarIdentity(); showPage("console"); },
      state: () => ({ me, planRefusal, consoleGeneration, authMode, agentKey, currentWorkspace, fleetAgentIds: [...fleetAgentById.keys()] }),
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

const limitRow = (k: string) => $("home-limits-rows").querySelector(`[data-limit="${k}"]`) as HTMLElement | null;
const settingsAgents = () => {
  const dts = [...$("billing-usage").querySelectorAll("dt")];
  const dt = dts.find((d) => /^Live agents/.test(d.textContent ?? ""));
  return dt ? { label: dt.textContent, dd: dt.nextElementSibling as HTMLElement } : null;
};
/** Two online agents this viewer can see (the roster), whatever the workspace count says. */
const roster = [agent("a1"), agent("a2"), agent("off", false)];
async function signedIn(world: World, mutate?: (s: string) => string) {
  const ui = loadConsole(makeHub(world), mutate);
  await flush();
  ui.enter("ws-a", world.me);
  await ui.loadAndRender();
  return ui;
}

describe("planRows: the live-agent row measures the workspace count, never the roster", () => {
  const rows = (b: unknown, seen: number | null = 2) => Object.fromEntries(loadConsole(vi.fn()).planRows(b, { agents: seen, computers: 0, projects: 0 }).map((r: { key: string }) => [r.key, r]));
  it("a number is a gauge: neutral below 80%, near at 80%, full at the allowance, the same thresholds as the hub refusal", () => {
    expect(rows(billing(7)).agents).toMatchObject({ gauge: true, level: "", used: 7, max: 10, limitText: "7 / 10", label: "Live agents in this workspace", valueText: "7 of 10 live agents" });
    expect(rows(billing(8)).agents).toMatchObject({ gauge: true, level: "near", valueText: "8 of 10 live agents, near the limit for your plan" });
    expect(rows(billing(10)).agents).toMatchObject({ gauge: true, level: "full", valueText: "10 of 10 live agents, at the limit" });
    expect(rows(billing(12)).agents).toMatchObject({ gauge: true, level: "full", limitText: "12 / 10" });
  });
  it("the roster count appears as a second, labelled number only when it differs", () => {
    expect(rows(billing(8), 3).agents).toMatchObject({ note: "Near the limit for your plan · 3 that you can see" });
    expect(rows(billing(8), 8).agents).toMatchObject({ note: "Near the limit for your plan" });
    expect(rows(billing(4), null).agents).toMatchObject({ gauge: true, note: "" });
    expect(rows(billing(4), 2).agents).toMatchObject({ gauge: true, note: "2 that you can see" });
  });
  it("seats pool the allowance exactly as the hub does", () => {
    expect(rows(billing(25, { seats: 3 })).agents).toMatchObject({ gauge: true, level: "near", limitText: "25 / 30" });
  });
  it("null (withheld) is 'Up to N' text with no gauge, no zero and no roster fraction", () => {
    const r = rows(billing(null), 2).agents;
    expect(r).toMatchObject({ gauge: false, level: "", limitText: "Up to 10", note: "The workspace count isn't shown to you", used: null, label: "Live agents" });
    expect(JSON.stringify(r)).not.toMatch(/2 \/ 10|0 \/ 10/);
  });
  it("unlimited and not-included plans state the workspace count without a gauge", () => {
    expect(rows(billing(4, { limits: { ...PRO.limits, maxAgents: null } })).agents).toMatchObject({ gauge: false, limitText: "Unlimited", note: "4 live in this workspace · 2 that you can see" });
    expect(rows(billing(0, { limits: { ...PRO.limits, maxAgents: 0 } })).agents).toMatchObject({ gauge: false, limitText: "Not included", note: "" });
  });
  it("an older hub without the field keeps phase 1's row: the roster, never a fraction", () => {
    expect(rows(billing(undefined), 9).agents).toMatchObject({ gauge: false, limitText: "Up to 10", note: "9 online that you can see", label: "Live agents" });
  });
  it("mutation: feeding the roster length instead of the workspace count makes a differing fixture fail", () => {
    const mutated = loadConsole(vi.fn(), (s) => s.replace("const n = live === undefined ? seen : live;", "const n = live === undefined ? seen : seen;"));
    const r = mutated.planRows(billing(8), { agents: 3, computers: 0, projects: 0 })[0];
    expect(r.used).toBe(3); // the mutant measures what this viewer can see...
    expect(r.used).not.toBe(rows(billing(8), 3).agents.used); // ...which the real rows never do
  });
});

describe("Home and Settings render the gauge from /v1/me", () => {
  it("near the limit: a named meter with its value text on Home, and 'N of M' in Settings", async () => {
    await signedIn({ me: identity({ billing: billing(8) }), agents: roster });
    const row = limitRow("agents")!;
    const meter = row.querySelector('[role="meter"]')!;
    expect(meter.getAttribute("aria-label")).toBe("Live agents in this workspace");
    expect(meter.getAttribute("aria-valuenow")).toBe("8");
    expect(meter.getAttribute("aria-valuemax")).toBe("10");
    expect(meter.getAttribute("aria-valuetext")).toBe("8 of 10 live agents, near the limit for your plan");
    expect(row.classList.contains("is-near")).toBe(true);
    expect(row.querySelector(".limit-value")!.textContent).toBe("8 / 10");
    expect(row.textContent).toContain("2 that you can see");
    expect(row.textContent).not.toContain("The limit counts every agent in the workspace.");
    const s = settingsAgents()!;
    expect(s.label).toBe("Live agents in this workspace");
    expect(s.dd.classList.contains("is-near")).toBe(true);
    expect(s.dd.textContent).toBe("8 of 10");
    expect(s.dd.querySelector('.usage-meter[role="img"]')!.getAttribute("aria-label")).toBe("8 of 10 live agents, near the limit for your plan");
  });
  it("at the limit: full on both, with the warning", async () => {
    await signedIn({ me: identity({ billing: billing(10) }), agents: roster });
    const row = limitRow("agents")!;
    expect(row.classList.contains("is-full")).toBe(true);
    expect(row.querySelector(".viz-fill")!.getAttribute("width")).toBe("100%");
    expect(row.textContent).toContain("At the limit");
    expect(settingsAgents()!.dd.querySelector(".usage-meter")!.classList.contains("is-full")).toBe(true);
  });
  it("null renders 'Up to N' text, not a gauge, on both", async () => {
    await signedIn({ me: identity({ billing: billing(null) }), agents: roster });
    const row = limitRow("agents")!;
    expect(row.querySelector('[role="meter"]')).toBeNull();
    expect(row.querySelector(".viz-gauge")).toBeNull();
    expect(row.querySelector(".limit-value")!.textContent).toBe("Up to 10");
    expect(row.textContent).toContain("The workspace count isn't shown to you");
    expect(row.textContent).not.toMatch(/\d+ \/ 10/);
    const s = settingsAgents()!;
    expect(s.label).toBe("Live agents");
    expect(s.dd.querySelector(".usage-meter")).toBeNull();
    expect(s.dd.textContent).toBe("Up to 10 · The workspace count isn't shown to you");
  });
  it("a session /v1/me 403 withdraws the workspace and its gauge; picker recovery keeps the cookie identity", async () => {
    const world: World = {
      me: identity({ billing: billing(8) }), agents: roster,
      authMe: { person: { id: "person-a", name: "Pat", email: "pat@example.test" }, workspaces: [{ orgId: "ws-a", orgName: "ws-a Co", role: "owner" }] },
    };
    const ui = await signedIn(world);
    expect(limitRow("agents")!.querySelector('[role="meter"]')).not.toBeNull();
    let releaseLate!: () => void;
    world.agents = [agent("late-session-agent")];
    world.holdNextAgents = new Promise<void>(resolve => { releaseLate = resolve; });
    world.meStatus = 403;
    const refused = ui.loadAndRender();
    await flush();
    expect(ui.state().authMode).toBe("session");
    expect(ui.state().currentWorkspace).toBeNull();
    expect(ui.state().me).toBeNull();
    expect($("console").hidden).toBe(true);
    expect($("workspace-picker").hidden).toBe(false);
    expect(limitRow("agents")).toBeNull();
    expect($("home-limits-rows").textContent).toBe("");
    expect($("billing-usage").textContent).toBe("");
    world.meStatus = undefined;
    world.agents = [agent("fresh-session-agent")];
    ui.enter("ws-a", world.me);
    await ui.loadAndRender();
    expect(ui.state().currentWorkspace).toBe("ws-a");
    expect(limitRow("agents")!.querySelector('[role="meter"]')!.getAttribute("aria-valuenow")).toBe("8");
    expect(ui.state().fleetAgentIds).toEqual(["fresh-session-agent"]);
    releaseLate();
    await refused;
    await flush();
    expect(ui.state().fleetAgentIds).toEqual(["fresh-session-agent"]);
  });
  it("a key /v1/me 403 clears all protected workspace state, keeps the key, and ignores a late sibling before fresh recovery", async () => {
    const world: World = { me: identity({ billing: billing(8) }), agents: [agent("old-agent")] };
    const ui = loadConsole(makeHub(world));
    await flush();
    ui.enterKey(world.me);
    await ui.loadAndRender();
    expect(ui.state().authMode).toBe("key");
    expect(ui.state().agentKey).toBe("fixture-key");
    expect(limitRow("agents")!.querySelector('[role="meter"]')).not.toBeNull();
    expect(ui.state().fleetAgentIds).toContain("old-agent");
    expect($("fleet-groups").children.length).toBeGreaterThan(0);

    let releaseLate!: () => void;
    world.holdNextAgents = new Promise<void>(resolve => { releaseLate = resolve; });
    world.me = identity({ billing: billing(9) });
    world.meStatus = 403;
    const refused = ui.loadAndRender();
    await flush();
    expect(ui.state().me).toBeNull();
    expect(ui.state().authMode).toBe("key");
    expect(ui.state().agentKey).toBe("fixture-key");
    expect($("home-limits-rows").textContent).toBe("");
    expect($("billing-usage").textContent).toBe("");
    expect($("fleet-groups").children.length).toBe(0);
    expect(ui.state().fleetAgentIds).toEqual([]);

    world.meStatus = undefined;
    world.me = identity({ billing: billing(9) });
    world.agents = [agent("fresh-agent")];
    await ui.loadAndRender();
    expect(ui.state().me.billing.used).toEqual({ agents: 9 });
    expect(limitRow("agents")!.querySelector('[role="meter"]')!.getAttribute("aria-valuenow")).toBe("9");
    expect(ui.state().fleetAgentIds).toContain("fresh-agent");
    releaseLate();
    await refused;
    await flush();
    expect(ui.state().fleetAgentIds).toEqual(["fresh-agent"]);
  });
  it("a key-mode failure on /v1/me keeps the gauge with core's time", async () => {
    const world: World = { me: identity({ billing: billing(8) }), agents: roster };
    const ui = loadConsole(makeHub(world));
    await flush();
    ui.enterKey(world.me);
    await ui.loadAndRender();
    world.meStatus = 500;
    await ui.loadAndRender();
    expect(ui.state().authMode).toBe("key");
    expect(ui.state().agentKey).toBe("fixture-key");
    expect(limitRow("agents")!.querySelector('[role="meter"]')!.getAttribute("aria-valuenow")).toBe("8");
    expect($("home-fresh-text").textContent).toContain("showing data from");
  });
  it("a role change clears the gauge on Home and in Settings before the new role's answer applies", async () => {
    const world: World = { me: identity({ billing: billing(8) }), agents: roster };
    const ui = await signedIn(world);
    expect(settingsAgents()).not.toBeNull();
    const generation = ui.state().consoleGeneration;
    world.me = identity({ role: "agent", memberRole: "member", billing: billing(8) });
    // This read sees the role move (a new generation); the refresh that starts is parked, so the screen is the reset.
    world.holdNextMe = 1;
    await ui.loadAndRender();
    await flush();
    expect(ui.state().consoleGeneration).toBe(generation + 1);
    expect(limitRow("agents")).toBeNull();
    expect($("billing-usage").textContent).toBe("");
  });
});

// The key-entry fixture seeds the authorized labels just as enterConsole does, without starting an extra poll.
// Refusal and recovery then use the complete production loadAndRender path and sidebar renderer.
const identityLabels = () => ({
  organization: $("org-name").textContent,
  whoami: $("whoami").textContent,
  menuName: $("user-menu-name").textContent,
  workspaceAvatar: $("ws-avatar").textContent,
  userAvatar: $("user-avatar").textContent,
  plan: $("ws-plan").textContent,
  planHidden: $("ws-plan").hidden,
});
const alphaLabels = { organization: "Alpha Fleet", whoami: "Pat", menuName: "Pat", workspaceAvatar: "A", userAvatar: "P", plan: "Pro", planHidden: false };

describe("key identity labels", () => {
  it("withdraws all old identity labels on current /me403 and restores current labels after a successful retry", async () => {
    const world: World = { me: identity({ orgName: "Alpha Fleet" }), agents: roster };
    const ui = loadConsole(makeHub(world));
    await flush();
    ui.enterKey(world.me);
    await ui.loadAndRender();
    expect(identityLabels()).toEqual(alphaLabels);

    world.meStatus = 403;
    await ui.loadAndRender();
    expect(ui.state().me).toBeNull();
    expect($("billing-plan").textContent).toBe("");
    expect(ui.state().authMode).toBe("key");
    expect(ui.state().agentKey).toBe("fixture-key");
    expect(identityLabels()).toEqual({ organization: "", whoami: "", menuName: "", workspaceAvatar: "?", userAvatar: "?", plan: "", planHidden: true });
    expect($("user-menu-email").textContent).toBe("Signed in with an agent key");

    world.meStatus = undefined;
    world.me = identity({ orgName: "Beta Fleet", agentName: "Rae", billing: billing(9, { planName: "Team" }) });
    await ui.loadAndRender();
    expect(identityLabels()).toEqual({ organization: "Beta Fleet", whoami: "Rae", menuName: "Rae", workspaceAvatar: "B", userAvatar: "R", plan: "Team", planHidden: false });
    expect(ui.state().authMode).toBe("key");
    expect(ui.state().agentKey).toBe("fixture-key");
    expect(limitRow("agents")!.querySelector('[role="meter"]')!.getAttribute("aria-valuenow")).toBe("9");
    expect(settingsAgents()!.dd.textContent).toContain("9 of 10");
    expect($("billing-plan").textContent).toBe("Team");
  });

  it("retains the last authorized identity labels and gauge on current /me500 with an honest stale notice", async () => {
    const world: World = { me: identity({ orgName: "Alpha Fleet" }), agents: roster };
    const ui = loadConsole(makeHub(world));
    await flush();
    ui.enterKey(world.me);
    await ui.loadAndRender();
    expect(identityLabels()).toEqual(alphaLabels);
    world.me = identity({ orgName: "Unaccepted Fleet", agentName: "Unaccepted User", billing: billing(9) });
    world.meStatus = 500;
    await ui.loadAndRender();
    expect(identityLabels()).toEqual(alphaLabels);
    expect(ui.state().me.orgName).toBe("Alpha Fleet");
    expect(ui.state().authMode).toBe("key");
    expect(ui.state().agentKey).toBe("fixture-key");
    expect(limitRow("agents")!.querySelector('[role="meter"]')!.getAttribute("aria-valuenow")).toBe("4");
    expect(settingsAgents()!.dd.textContent).toContain("4 of 10");
    expect($("billing-plan").textContent).toBe("Pro");
    expect($("home-fresh-text").textContent).toContain("showing data from");
  });
});

const billingAlertState = () => ({
  bannerHidden: $("billing-banner").hidden,
  sidebarHidden: $("sidebar-alert").hidden,
  bannerTitle: $("billing-banner-title").textContent,
  bannerMeta: $("billing-banner-meta").textContent,
  bannerAction: $("billing-banner-action").textContent,
  sidebarTitle: $("sidebar-alert-title").textContent,
  sidebarMeta: $("sidebar-alert-meta").textContent,
  sidebarAction: $("sidebar-alert-action").textContent,
  bannerTone: $("billing-banner").dataset.tone,
  sidebarTone: $("sidebar-alert").dataset.tone,
});
const neutralBillingAlerts = {
  bannerHidden: true, sidebarHidden: true, bannerTitle: "", bannerMeta: "", bannerAction: "",
  sidebarTitle: "", sidebarMeta: "", sidebarAction: "", bannerTone: undefined, sidebarTone: undefined,
};
async function keyWithBillingAlert(kind: string) {
  const world: World = {
    me: identity({ orgName: "Alpha Fleet", billing: billing(4, kind === "read-only" ? { readOnly: true, reason: "Alpha private trial expired" } : {}) }),
    agents: roster, planRefusal: kind === "plan-limit",
  };
  const ui = loadConsole(makeHub(world));
  await flush();
  ui.enterKey(world.me);
  await ui.loadAndRender();
  if (kind === "plan-limit") {
    // Real api() PlanError handling, entirely within the controlled fetch mock; no real mutation is sent.
    await expect(ui.api("/v1/org/devices", { method: "POST", body: { name: "fixture-computer" } })).rejects.toMatchObject({ code: "PLAN_LIMIT" });
    expect(ui.state().planRefusal).toMatchObject({ code: "PLAN_LIMIT", message: "Alpha private plan limit" });
  }
  expect($("billing-plan").textContent).toMatch(/^Pro/);
  const prior = billingAlertState();
  expect(prior.bannerHidden).toBe(false);
  expect(prior.sidebarHidden).toBe(false);
  expect(prior.bannerTitle).not.toBe("");
  expect(prior.bannerMeta).toContain(kind === "read-only" ? "Alpha private trial expired" : "Alpha private plan limit");
  expect(prior.sidebarTitle).toBe(prior.bannerTitle);
  expect(prior.sidebarMeta).toBe(prior.bannerMeta);
  return { world, ui, prior };
}
describe("key billing alerts", () => {
  it.each(["read-only", "plan-limit"])("withdraws prior %s alerts and plan refusal on current /me403 before fresh recovery", async kind => {
    const { world, ui } = await keyWithBillingAlert(kind);
    world.meStatus = 403;
    await ui.loadAndRender();
    expect(ui.state().me).toBeNull();
    expect($("billing-plan").textContent).toBe("");
    expect(ui.state().planRefusal).toBeNull();
    expect(billingAlertState()).toEqual(neutralBillingAlerts);
    expect(identityLabels().organization).toBe("");
    expect(ui.state().authMode).toBe("key");
    expect(ui.state().agentKey).toBe("fixture-key");

    world.meStatus = undefined;
    world.planRefusal = false;
    world.me = identity({ orgName: "Beta Fleet", agentName: "Rae", billing: billing(9, { planName: "Team" }) });
    await ui.loadAndRender();
    expect(identityLabels()).toEqual({ organization: "Beta Fleet", whoami: "Rae", menuName: "Rae", workspaceAvatar: "B", userAvatar: "R", plan: "Team", planHidden: false });
    expect(billingAlertState()).toEqual(neutralBillingAlerts);
    expect(ui.state().planRefusal).toBeNull();
  });
  it.each(["read-only", "plan-limit"])("retains authorized %s alert state on current /me500", async kind => {
    const { world, ui, prior } = await keyWithBillingAlert(kind);
    const priorIdentity = identityLabels();
    const priorRefusal = ui.state().planRefusal;
    world.meStatus = 500;
    await ui.loadAndRender();
    expect(identityLabels()).toEqual(priorIdentity);
    expect(billingAlertState()).toEqual(prior);
    expect(ui.state().planRefusal).toEqual(priorRefusal);
    expect(ui.state().agentKey).toBe("fixture-key");
    expect($("home-fresh-text").textContent).toContain("showing data from");
  });
});

describe("key identity refusal follow-up controls", () => {
  it("shows the paused banner for current /me423 while retaining the key and last authorized identity", async () => {
    const world: World = { me: identity({ orgName: "Alpha Fleet" }), agents: roster };
    const ui = loadConsole(makeHub(world));
    await flush();
    ui.enterKey(world.me);
    await ui.loadAndRender();
    expect($("paused-banner").hidden).toBe(true);
    expect(identityLabels()).toEqual(alphaLabels);
    world.meStatus = 423;
    await ui.loadAndRender();
    expect($("console").hidden).toBe(false);
    expect($("paused-banner").hidden).toBe(false);
    expect($("paused-banner-meta").textContent).toBe("no");
    expect(ui.state().me.workspace.paused).toBe(true);
    expect(ui.state().me.orgName).toBe("Alpha Fleet");
    expect(ui.state().authMode).toBe("key");
    expect(ui.state().agentKey).toBe("fixture-key");
  });

  it.each(["read-only", "plan-limit"])("does not resurrect withdrawn %s identity or alerts after /me403 followed by /me500", async kind => {
    const { world, ui } = await keyWithBillingAlert(kind);
    world.meStatus = 403;
    await ui.loadAndRender();
    expect(ui.state().me).toBeNull();
    expect($("billing-plan").textContent).toBe("");
    expect(billingAlertState()).toEqual(neutralBillingAlerts);
    const withdrawn = identityLabels();
    expect(withdrawn).toEqual({ organization: "", whoami: "", menuName: "", workspaceAvatar: "?", userAvatar: "?", plan: "", planHidden: true });
    world.me = identity({ orgName: "Unaccepted Fleet", billing: billing(9) });
    world.meStatus = 500;
    await ui.loadAndRender();
    expect(ui.state().me).toBeNull();
    expect($("billing-plan").textContent).toBe("");
    expect(ui.state().planRefusal).toBeNull();
    expect(identityLabels()).toEqual(withdrawn);
    expect(billingAlertState()).toEqual(neutralBillingAlerts);
    expect($("home-limits-rows").textContent).toBe("");
    expect($("billing-usage").textContent).toBe("");
    expect(ui.state().authMode).toBe("key");
    expect(ui.state().agentKey).toBe("fixture-key");
  });
});

// The plan card shows the plan name and usage rows. Known-positive DOM seeds put another workspace's note and usage rows
// on it, so the withdrawal tests can show they are gone (and not merely re-rendered over).
function seedOldBillingCard() {
  expect($("billing-plan").textContent).toBe("Pro");
  $("billing-note").textContent = "Alpha private plan note";
  $("billing-note").hidden = false;
  $("billing-usage-note").hidden = false;
  const usageRow = $("billing-usage").querySelector("dd")!;
  expect(usageRow.isConnected).toBe(true);
  const staticMarkup = { usage: $("billing-usage-note").innerHTML };
  expect(staticMarkup.usage).toContain("Live agents");
  return { usageRow, staticMarkup };
}
function expectBillingCardWithdrawn(prior: ReturnType<typeof seedOldBillingCard>) {
  for (const id of ["billing-plan", "billing-note", "billing-usage"]) expect($(id).textContent, id).toBe("");
  for (const id of ["billing-note", "billing-usage-note"]) expect($(id).hidden, id).toBe(true);
  expect(prior.usageRow.isConnected).toBe(false);
  expect($("billing-usage-note").innerHTML).toBe(prior.staticMarkup.usage);
}
describe("complete existing plan card withdrawal", () => {
  it("withdraws the seeded plan card content on key403, stays neutral through500, and restores current billing", async () => {
    const world: World = { me: identity({ orgName: "Alpha Fleet" }), agents: roster };
    const ui=loadConsole(makeHub(world));
    await flush(); ui.enterKey(world.me); await ui.loadAndRender();
    const prior=seedOldBillingCard();
    world.meStatus=403; await ui.loadAndRender();
    expectBillingCardWithdrawn(prior);
    world.meStatus=500; await ui.loadAndRender();
    expectBillingCardWithdrawn(prior);
    world.meStatus=undefined;
    world.me=identity({orgName:"Beta Fleet",agentName:"Rae",billing:billing(9,{planName:"Team"})});
    await ui.loadAndRender();
    expect($("billing-plan").textContent).toBe("Team");
    expect(settingsAgents()!.dd.textContent).toContain("9 of 10");
    expect($("billing-usage-note").hidden).toBe(false);
    expect($("billing-usage-note").innerHTML).toBe(prior.staticMarkup.usage);
    expect($("billing-card").textContent).not.toContain("Alpha private");
  });
  it("withdraws all old billing card content before a valid-person A-to-B entry whose first identity read fails", async () => {
    const world: World = { me:identity({orgName:"Alpha Fleet"}), agents:roster, authMe:{
      person:{id:"person-a",name:"Pat",email:"pat@example.test"},
      workspaces:[{orgId:"ws-a",name:"Alpha Fleet",role:"owner"},{orgId:"ws-b",name:"Beta Fleet",role:"owner"}],
    }};
    const ui=loadConsole(makeHub(world)); await flush();
    ui.enter("ws-a",world.me); await ui.loadAndRender();
    const prior=seedOldBillingCard();
    world.meStatus=500;
    await expect(ui.enterWorkspace("ws-b")).rejects.toThrow();
    expect(ui.state().currentWorkspace).toBe("ws-b");
    expect(ui.state().authMode).toBe("session");
    expectBillingCardWithdrawn(prior);
  });
});
