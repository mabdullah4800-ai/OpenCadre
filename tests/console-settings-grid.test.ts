// @vitest-environment happy-dom
// Settings as one column of sections under a short index (docs/design/CONSOLE-V2.md V8).
//
// This file used to pin a two-column grid and the "solo card" rule that kept the last narrow card from sitting alone
// in its row (docs/design/CONSOLE_AUDIT.md finding #5). Settings is one column now, so that rule has nothing left to
// fix; what replaces it is pinned here: one column, the sections in the order the plan sets, no fleet numbers that
// Home already shows, and an index whose links appear and disappear with the sections they point at.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function loadConsole(fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () => json(200, {}))) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { applyRole, layoutSettingsGrid, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, fetchMock) as {
    applyRole: () => void;
    layoutSettingsGrid: () => void;
    setMe: (v: { role: string; orgId?: string } | null) => void;
  };
}

const visibleIndex = () =>
  Array.from(document.querySelectorAll<HTMLAnchorElement>("#settings-index a")).filter((a) => !a.hidden).map((a) => a.textContent);

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("Settings is one column of sections, in the plan's order", () => {
  it("the sections come in order: plan, workspace, people, projects, safety, notifications", () => {
    const ids = Array.from($("settings-grid").children).map((c) => c.id);
    expect(ids).toEqual(["billing-card", "settings-org-card", "members-card", "projects-card", "policy-card", "killswitch-card", "webhook-card", "push-card"]);
  });

  it("the fleet numbers Home already shows are not repeated here", () => {
    expect($("settings-grid").textContent).not.toContain("Fleet overview");
    expect(document.getElementById("settings-stat-agents")).toBeNull();
  });

  it("console-v2.css lays Settings out in one column", () => {
    const css = readFileSync(resolve(process.cwd(), "public/app/console-v2.css"), "utf8");
    expect(css).toMatch(/\.panel\[data-panel="settings"\] \.settings-grid \{ grid-template-columns: minmax\(0, 1fr\);/);
  });
});

describe("the section index follows what this viewer can see", () => {
  it("signed in with a plain key: no People, Projects or Safety links, because those sections are hidden", () => {
    const ui = loadConsole();
    ui.setMe(null);
    ui.applyRole();
    expect(visibleIndex()).toEqual(["Plan & usage", "Workspace", "Notifications"]);
  });

  it("an operator's key also sees People and Safety (Projects appears once the hub lists them)", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator" });
    ui.applyRole();
    expect(visibleIndex()).toEqual(["Plan & usage", "Workspace", "People", "Safety", "Notifications"]);
    $("projects-card").hidden = false;
    ui.layoutSettingsGrid();
    expect(visibleIndex()).toEqual(["Plan & usage", "Workspace", "People", "Projects", "Safety", "Notifications"]);
  });

  it("each link names the section by its own address", () => {
    const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>("#settings-index a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#/settings/billing", "#/settings/workspace", "#/settings/people", "#/settings/projects", "#/settings/safety", "#/settings/notifications"]);
  });
});
