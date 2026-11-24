// @vitest-environment happy-dom
// Plan & usage in the console (docs/design/CONSOLE-V2.md §5 S1/S2, and bug B1).
//
// Before this, the console showed no plan at all: /v1/me's `billing` was fetched every poll and ignored, a 402 from a
// plan limit arrived as a bare toast, the checkout/portal routes had no caller, and the pause switch was shown to
// admins although pausing needs the owner. Every describe below fails on that console.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Billing = Record<string, unknown>;
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const limits = (over: Record<string, unknown> = {}) => ({
  key: "trial", name: "Trial", maxAgents: 10, maxMachines: 3, maxProjects: 3, maxWorkspaces: 1, maxWebhooks: 1,
  retentionDays: 14, trialDays: 7, ...over,
});
const trial = (days: number): Billing => ({
  plan: "trial", planName: "Trial", subscriptionStatus: "active", trialEndsAt: inDays(days),
  readOnly: false, reason: null, graceEndsAt: null, limits: limits(),
});

function loadConsole(fetchMock = vi.fn(async () => json(200, {}))) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return {
      renderBilling, renderBillingBanner, api, activeTab: () => activeTab,
      setMe: (v) => { me = v; }, setRole: (mode, role) => { authMode = mode; currentWorkspaceRole = role; },
      PlanError,
    };`,
  )(window, document, window.localStorage, fetchMock) as {
    renderBilling: (d: { agents?: unknown[]; devices?: unknown[]; projects?: unknown[] }) => void;
    renderBillingBanner: () => void;
    api: (path: string, opts?: object) => Promise<unknown>;
    activeTab: () => string;
    setMe: (v: unknown) => void;
    setRole: (mode: "key" | "session", role: string | null) => void;
    PlanError: new (m: string) => Error;
  };
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const usageText = () => $("billing-usage").textContent ?? "";

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  history.replaceState(null, "", "/app/");
  // A pending checkout is kept in storage across reloads, so one case's wait must not leak into the next.
  localStorage.clear();
  sessionStorage.clear();
});

describe("Plan & billing shows the plan the hub enforces", () => {
  const counts = {
    agents: [{ online: true }, { online: true }, { online: false }],
    devices: [{ status: "connected" }, { status: "connected" }, { status: "revoked" }],
    projects: [{ enabled: true }, { enabled: false }],
  };

  it("names the plan and the days left on its trial", () => {
    const c = loadConsole();
    c.setRole("session", "owner");
    c.setMe({ role: "operator", billing: trial(5) });
    c.renderBilling(counts);
    expect($("billing-plan").textContent).toMatch(/^Trial · [45] days left$/);
  });

  it("measures each enforced limit against what counts toward it", () => {
    const c = loadConsole();
    c.setRole("session", "owner");
    c.setMe({ role: "operator", billing: trial(5) });
    c.renderBilling(counts);
    // Connected computers and enabled projects: the same sets the hub counts, so they are measured against the limit.
    // Live agents are counted from the roster this viewer can see, which is not the set countLiveAgents counts (a
    // project-scoped viewer sees part of it), so that row shows the allowance and the visible count apart, with no
    // meter (Codex-OpenCadre-049a's ruling, 2026-10-01, item 1).
    expect(usageText()).toContain("Live agentsUp to 10 · 2 online that you can see");
    expect(usageText()).not.toContain("2 of 10");
    expect(usageText()).toContain("Computers2 of 3");
    expect(usageText()).toContain("Projects1 of 3");
    expect(usageText()).toContain("History kept14 days");
    // The width is set through the DOM: the hub's CSP drops inline style attributes, which drew every meter full.
    const fills = [...$("billing-usage").querySelectorAll<HTMLElement>(".usage-meter-fill")].map((f) => f.style.width);
    expect(fills).toEqual(["67%", "33%"]);
  });

  it("an unlimited limit says so, and a full one is marked", () => {
    const c = loadConsole();
    c.setRole("session", "owner");
    c.setMe({ role: "operator", billing: { ...trial(5), limits: limits({ maxAgents: null, maxMachines: 2 }) } });
    c.renderBilling(counts);
    expect(usageText()).toContain("Unlimited · 2 online that you can see");
    expect($("billing-usage").querySelector("dd.is-full")?.textContent).toContain("2 of 2");
  });

  it("shows the plan and its usage only: no purchase, plan-choice or billing-portal controls anywhere on the card", () => {
    const c = loadConsole();
    c.setRole("session", "owner");
    c.setMe({ role: "operator", billing: trial(5) });
    c.renderBilling(counts);
    expect($("billing-card").querySelectorAll("button, a")).toHaveLength(0);
    expect($("billing-card").textContent).not.toMatch(/choose|upgrade|checkout|subscribe|paddle|manage billing/i);
  });

  it("a workspace with no plan says so plainly, with no meters and nothing to buy", () => {
    const c = loadConsole();
    c.setRole("session", "owner");
    c.setMe({ role: "operator", billing: { ...trial(0), plan: "none", planName: "No plan", awaitingPlan: true, trialEndsAt: null } });
    c.renderBilling(counts);
    expect($("billing-plan").textContent).toBe("No plan yet");
    expect($("billing-usage").hidden).toBe(true);
    expect($("billing-card").querySelectorAll("button, a")).toHaveLength(0);
  });
});

describe("the plan banner says what is wrong, most urgent first", () => {
  const banner = () => ({ hidden: $("billing-banner").hidden, title: $("billing-banner-title").textContent });

  it("a read-only workspace is named, with the reason", () => {
    const c = loadConsole();
    c.setRole("session", "owner");
    c.setMe({ role: "operator", billing: { ...trial(-1), readOnly: true, reason: "its trial ended on 2026-09-20" } });
    c.renderBillingBanner();
    expect(banner()).toEqual({ hidden: false, title: "This workspace is read-only" });
    expect($("billing-banner-meta").textContent).toContain("its trial ended on 2026-09-20");
  });

  it("a trial in its last three days warns; one with longer left does not", () => {
    const c = loadConsole();
    c.setRole("session", "owner");
    c.setMe({ role: "operator", billing: trial(2) });
    c.renderBillingBanner();
    expect(banner()).toEqual({ hidden: false, title: "Your trial ends in 2 days" });
    c.setMe({ role: "operator", billing: trial(6) });
    c.renderBillingBanner();
    expect(banner().hidden).toBe(true);
  });

  it("a grace period gives the date everything keeps working until", () => {
    const c = loadConsole();
    c.setRole("session", "owner");
    c.setMe({ role: "operator", billing: { plan: "pro", planName: "Pro", trialEndsAt: null, readOnly: false, graceEndsAt: "2026-09-30T00:00:00.000Z", limits: limits({ trialDays: null }) } });
    c.renderBillingBanner();
    expect(banner()).toEqual({ hidden: false, title: "Grace period" });
    expect($("billing-banner-meta").textContent).toContain("2026-09-30");
    expect($("billing-banner-action").textContent).toBe("View plan");
  });

  it("a 402 TRIAL_EXPIRED is named as read-only, not as a limit, even before billing has refreshed", async () => {
    // Codex-OpenCadre-f46c on e75527d: the hub answers every read-only write with code TRIAL_EXPIRED; titling it
    // "limit reached" was wrong whenever the poll's billing hadn't caught up yet.
    const c = loadConsole(vi.fn(async () => json(402, { error: "This workspace is read-only: its trial ended on 2026-09-20.", code: "TRIAL_EXPIRED" })));
    c.setRole("session", "owner");
    c.setMe({ role: "operator", billing: trial(6) });
    await expect(c.api("/v1/tasks", { method: "POST", body: {} })).rejects.toBeInstanceOf(c.PlanError);
    expect(banner()).toEqual({ hidden: false, title: "This workspace is read-only" });
    expect($("billing-banner").dataset.tone).toBe("risk");
  });

  it("a 402 from a plan limit becomes a typed error and the banner names it", async () => {
    const c = loadConsole(vi.fn(async () => json(402, { error: "Your plan allows 3 computers.", code: "PLAN_LIMIT" })));
    c.setRole("session", "owner");
    c.setMe({ role: "operator", billing: trial(6) });
    await expect(c.api("/v1/org/devices", { method: "POST", body: {} })).rejects.toBeInstanceOf(c.PlanError);
    expect(banner()).toEqual({ hidden: false, title: "Your plan's limit was reached" });
    expect($("billing-banner-meta").textContent).toBe("Your plan allows 3 computers.");
  });
});

describe("the pause switch shows only to someone who can pause (B1)", () => {
  // Pausing needs the OWNER (permissions.ts org.pause). An admin's agent has role "operator", so gating on that alone
  // showed admins a switch that answered 403.
  function killswitchHiddenFor(role: string) {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const c = new Function("window", "document", "localStorage", "fetch",
      `${appJs}; return { applyRole, setMe: (v) => { me = v; }, setRole: (m, r) => { authMode = m; currentWorkspaceRole = r; } };`,
    )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as {
      applyRole: () => void; setMe: (v: unknown) => void; setRole: (m: string, r: string) => void;
    };
    c.setRole("session", role);
    c.setMe({ role: "operator", workspace: { paused: false }, billing: trial(6) });
    c.applyRole();
    return $("killswitch-card").hidden;
  }
  it("an admin does not see it", () => expect(killswitchHiddenFor("admin")).toBe(true));
  it("the owner does", () => expect(killswitchHiddenFor("owner")).toBe(false));
});

// The hub enforces per-seat limits at the plan's seat floor (src/billing.ts enforcedSeats, #561): a Team workspace
// may hold two seats' worth. The card must show what the hub allows, or it tells a Team customer half.
describe("per-seat allowances follow the seats the hub enforces", () => {
  it("Team with two seats shows two seats' worth of computers and agents; projects are not per seat", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator", billing: { ...trial(7), plan: "team", planName: "Team", seats: 2, limits: { ...limits(), maxMachines: 5, maxAgents: 25, maxProjects: 3 } } });
    ui.renderBilling({ agents: [{ online: true }], devices: [{ status: "connected" }], projects: [{ enabled: true }] });
    expect(usageText()).toContain("1 of 10");
    expect(usageText()).toContain("Up to 50");
    expect(usageText()).toContain("1 of 3");
  });

  it("a hub that does not send seats counts one", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator", billing: { ...trial(7), limits: { ...limits(), maxMachines: 3 } } });
    ui.renderBilling({ agents: [], devices: [{ status: "connected" }], projects: [] });
    expect(usageText()).toContain("1 of 3");
  });
});
