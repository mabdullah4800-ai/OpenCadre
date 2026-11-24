// @vitest-environment happy-dom
// The controls pass (operator request, 2026-09-23: tidy the checkboxes, dropdowns, buttons, hovers, remove buttons and menus,
// and drop the "live" labels). Each arm fails on the console before it: a "Live" badge in the sidebar and a "Connected, live" line in
// the account menu, a big red "Hold to remove" on every computer, "high risk" in the Inbox but "High risk" on Home,
// Home's Recent activity showing the oldest events of the window, and "Choose a plan" on an unlimited internal plan.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
type Ui = {
  computerCard: (d: unknown, sessions: unknown[]) => HTMLElement;
  clearanceStrip: (a: unknown) => HTMLElement;
  renderOverviewActivity: (events: unknown[]) => void;
  renderSidebarIdentity: () => void;
  setMe: (v: unknown) => void;
};
function loadConsole(): Ui {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { computerCard, clearanceStrip, renderOverviewActivity, renderSidebarIdentity,
      setMe: (v) => { me = v; authMode = "key"; } };`,
  )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as Ui;
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("no connection badge", () => {
  it("the sidebar shows no Live badge, and the account menu has no connection line", () => {
    loadConsole();
    expect($("live-status").hidden).toBe(true);
    expect(document.getElementById("user-menu-status")).toBeNull();
  });
});

describe("removing a computer is a quiet control", () => {
  it("is a small neutral Remove that still needs a hold, and names the computer for a screen reader", () => {
    const ui = loadConsole();
    const card = ui.computerCard({ deviceId: "d1", name: "Build server", status: "active", tools: ["claude-code"] }, []);
    const hold = card.querySelector(".computer-card-head .hold") as HTMLElement;
    expect(hold.classList.contains("hold-quiet-halt")).toBe(true);
    expect(hold.classList.contains("hold-halt")).toBe(false);
    expect(hold.querySelector(".label")?.textContent).toBe("Remove");
    expect(hold.getAttribute("aria-label")).toBe("Hold to remove Build server");
  });
});

describe("one wording for risk", () => {
  it("the Inbox says High risk, as Home does", () => {
    const ui = loadConsole();
    const strip = ui.clearanceStrip({ id: "a1", requested_by_agent_name: "Release-Bot", risk: "high", action: "rm -rf ./dist",
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 900_000).toISOString() });
    expect(strip.querySelector(".risk")?.textContent).toBe("High risk");
  });
});

describe("Home: Recent activity", () => {
  it("shows the newest 8 of the window, newest first (the hub returns it oldest-first)", () => {
    const ui = loadConsole();
    const events = Array.from({ length: 12 }, (_, i) => ({ seq: 100 + i, type: "agent.phase_changed", actor_agent_name: `A${i}`,
      payload: { phase: "editing" }, created_at: new Date(Date.now() - (12 - i) * 60_000).toISOString() }));
    ui.renderOverviewActivity(events);
    const rows = [...$("overview-activity").querySelectorAll(".strip-body")].map((n) => n.textContent ?? "");
    expect(rows).toHaveLength(8);
    expect(rows[0]).toContain("A11");
    expect(rows[7]).toContain("A4");
  });
});

describe("account menu on an internal plan", () => {
  it("offers nothing to buy", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator", orgName: "OpenCadre Fleet", agentName: "op", billing: { plan: "internal", planName: "Internal" } });
    ui.renderSidebarIdentity();
    expect(document.getElementById("user-menu-upgrade")).toBeNull();
  });
});

describe("controls stylesheet", () => {
  const css = readFileSync(resolve(process.cwd(), "public/app/console-v2.css"), "utf8");
  it("styles the open dropdown list where the browser allows it, and keeps a chevron where it doesn't", () => {
    expect(css).toMatch(/@supports \(appearance: base-select\)/);
    expect(css).toMatch(/\.board select::picker\(select\)/);
    expect(css).toMatch(/\.board select \{[^}]*appearance: none/);
  });
  // happy-dom has no layout, so this pins the rule; the overflow itself was measured in Chrome (257px -> 229px).
  it("lets the sidebar's top column shrink, so a long workspace name can't push Find past the sidebar", () => {
    expect(css).toContain(".sidebar-top { grid-template-columns: minmax(0, 1fr); }");
  });
  it("turns motion off for people who ask for less", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.row-menu\[open\] > \.row-menu-list/);
  });
});
