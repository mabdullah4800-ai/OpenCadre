// @vitest-environment happy-dom
// PR1 (urgent usability, Codex-OpenCadre-049a): a brand-new owner's first screen read as broken. The switcher said a red
// "Read-only", Plan & billing showed "1 of 0" meters in red, the banner was an amber warning, and Home offered "Add a
// computer" and a "Go to Connect" checklist that could only be refused. Before a plan exists, the console now says what
// to do next, in the neutral tone, and hides what cannot work yet. Each describe fails on the console before PR1.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

function loadConsole(fetchMock: unknown) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return {
      renderBilling, renderBillingBanner, renderSidebarIdentity, renderSidebarAlert, renderOverviewHappening,
      renderHomeNext: typeof renderHomeNext === "function" ? renderHomeNext : () => {},
      refreshOnboarding, renderOverview,
      setMe: (v) => { me = v; }, setRole: (mode, role) => { authMode = mode; currentWorkspaceRole = role; },
    };`,
  )(window, document, window.localStorage, fetchMock) as Record<string, (...a: unknown[]) => unknown> & {
    setMe: (v: unknown) => void;
    setRole: (mode: "key" | "session", role: string | null) => void;
  };
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const zero = { key: "pending", name: "No plan yet", maxAgents: 0, maxMachines: 0, maxProjects: 0, maxWorkspaces: 1, maxWebhooks: 0, retentionDays: null, trialDays: null };
const PENDING = {
  plan: "pending", planName: "No plan yet", subscriptionStatus: "active", trialEndsAt: null, readOnly: true,
  reason: "it has no plan yet", graceEndsAt: null, seats: 1, limits: zero,
  awaitingPlan: true, trialConvertsAt: null,
};
const LAPSED = { ...PENDING, plan: "pro", planName: "Pro", reason: "its subscription ended", awaitingPlan: false };
const PRO = {
  plan: "pro", planName: "Pro", subscriptionStatus: "active", trialEndsAt: null, readOnly: false, reason: null, graceEndsAt: null, seats: 1,
  limits: { key: "pro", name: "Pro", maxAgents: 10, maxMachines: 3, maxProjects: 0, maxWorkspaces: 1, maxWebhooks: 2, retentionDays: 90, trialDays: null },
  awaitingPlan: false, trialConvertsAt: null,
};

function consoleFor(billing: unknown, { owner = true }: { owner?: boolean } = {}) {
  const fetchMock = vi.fn(async (path: string) => {
    if (path === "/v1/onboarding") return json(200, { completed: 0, total: 4, steps: [{ id: "first_agent", done: false }] });
    return json(200, {});
  });
  const c = loadConsole(fetchMock);
  c.setRole("session", owner ? "owner" : "member");
  c.setMe({ role: owner ? "operator" : "agent", orgId: "org-1", orgName: "Sam's team", agentName: "Sam", billing });
  return { c, fetchMock };
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  history.replaceState(null, "", "/app/");
  localStorage.clear();
});

describe("the workspace switcher", () => {
  it("says 'No plan yet' in the neutral tone before a plan, never a red 'Read-only'", () => {
    const { c } = consoleFor(PENDING);
    c.renderSidebarIdentity();
    expect($("ws-plan").textContent).toBe("No plan yet");
    expect($("ws-plan").dataset.tone).toBe("plain");
  });
  it("still says a red 'Read-only' when a plan lapsed", () => {
    const { c } = consoleFor(LAPSED);
    c.renderSidebarIdentity();
    expect($("ws-plan").textContent).toBe("Read-only");
    expect($("ws-plan").dataset.tone).toBe("risk");
  });
});

describe("Plan & usage", () => {
  it("shows no meters before a plan: there are no limits yet to measure against", () => {
    const { c } = consoleFor(PENDING);
    c.renderBilling({ agents: [{ online: true }], devices: [], projects: [] });
    expect($("billing-usage").hidden).toBe(true);
    expect($("billing-usage").querySelector(".usage-meter")).toBeNull();
    expect($("billing-card").textContent).not.toMatch(/1 of 0|0 of 0/);
  });
  it("a limit of 0 on a real plan reads 'Not included', with no meter and no red", () => {
    const { c } = consoleFor(PRO);
    c.renderBilling({ agents: [], devices: [], projects: [] });
    const rows = [...$("billing-usage").querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling as HTMLElement]);
    const projects = rows.find(([label]) => label === "Projects")![1] as HTMLElement;
    expect(projects.textContent).toBe("Not included");
    expect(projects.querySelector(".usage-meter")).toBeNull();
    expect(projects.classList.contains("is-full")).toBe(false);
    expect($("billing-usage").hidden).toBe(false);
  });
});

describe("the plan banner and sidebar card", () => {
  it("before a plan: the setup tone (no amber warning), and the sidebar card drops its warning sign", () => {
    const { c } = consoleFor(PENDING);
    c.renderBillingBanner();
    expect($("billing-banner-title").textContent).toBe("No plan yet");
    expect($("billing-banner").dataset.tone).toBe("setup");
    // It states the limit plainly: nothing to buy, no trial promise.
    expect($("billing-banner-meta").textContent).not.toMatch(/trial|charge|choose|upgrade|card/i);
    c.renderSidebarAlert();
    expect($("sidebar-alert").dataset.tone).toBe("setup");
  });
  it("a lapsed plan keeps the risk tone", () => {
    const { c } = consoleFor(LAPSED);
    c.renderBillingBanner();
    expect($("billing-banner").dataset.tone).toBe("risk");
  });
});

describe("Home's next action", () => {
  it("says there is no plan, plainly: no trial promise, no charge, no purchase and no button", () => {
    for (const owner of [true, false]) {
      const { c } = consoleFor(PENDING, { owner });
      c.renderHomeNext();
      expect($("home-next").hidden).toBe(false);
      expect($("home-next-title").textContent).toBe("No plan yet");
      expect($("home-next-meta").textContent).toContain("no computer or agent can connect");
      expect($("home-next").textContent).not.toMatch(/trial|charge|choose|upgrade|card|step 1/i);
      expect($("home-next-action").hidden).toBe(true);
    }
  });
  it("is gone once the workspace has a plan", () => {
    const { c } = consoleFor(PRO);
    c.renderHomeNext();
    expect($("home-next").hidden).toBe(true);
  });
  it("nothing else on Home dead-ends: no 'Add a computer' and no Connect checklist before a plan", async () => {
    const { c, fetchMock } = consoleFor(PENDING);
    c.renderOverviewHappening([], []);
    expect($("overview-happening").textContent).toContain("once your plan has started");
    expect([...$("overview-happening").querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Add a computer");
    await c.refreshOnboarding();
    expect($("onboarding-card").hidden).toBe(true);
    expect(fetchMock.mock.calls.some(([p]) => p === "/v1/onboarding")).toBe(false);
  });
  it("Home's counts are four separate tiles, 2 x 2 on a tablet and compact rows on a phone", () => {
    const { c } = consoleFor(PENDING);
    c.renderOverview({ approvals: [], messages: [], awarenessDigest: null, liveSessions: [], taskCounts: { open: 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 }, grants: [], agents: [], events: [] });
    const tiles = [...$("overview-metrics").querySelectorAll(".home-tile")].map((t) => [t.querySelector(".home-tile-label")?.textContent, t.querySelector(".home-tile-number")?.textContent]);
    expect(tiles).toEqual([["Agents online", "0"], ["Open tasks", "0"], ["Waiting for approval", "0"], ["Standing approvals", "0"]]);
    // Before a plan the agents tile does not point at "Connect a computer": Home's next action is the plan.
    expect($("overview-metrics").textContent).not.toContain("Connect a computer");
    const css = readFileSync(resolve(process.cwd(), "public/app/console-v2.css"), "utf8");
    const two = css.indexOf(".home-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }");
    expect(two).toBeGreaterThan(-1);
    expect(css.slice(css.lastIndexOf("@media", two)).startsWith("@media (max-width: 1023px)")).toBe(true);
    const one = css.indexOf(".home-tiles { grid-template-columns: minmax(0, 1fr); gap: 8px; }");
    expect(one).toBeGreaterThan(-1);
    expect(css.slice(css.lastIndexOf("@media", one)).startsWith("@media (max-width: 559px)")).toBe(true);
  });
  it("with a plan, the empty state still offers 'Add a computer'", () => {
    const { c } = consoleFor(PRO);
    c.renderOverviewHappening([], []);
    expect([...$("overview-happening").querySelectorAll("button")].map((b) => b.textContent)).toContain("Add a computer");
  });
});
