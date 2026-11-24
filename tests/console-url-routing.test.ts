// @vitest-environment happy-dom
// Every console view has its own address. Before this, views were switched in place with no URL: the browser's Back
// left the app, a reload always landed on Overview, and no view could be linked to. Each arm below fails on the
// in-place version (no hash is ever written, and a hash present at load is ignored).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { selectTab, activeTab: () => activeTab };`,
  )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as {
    selectTab: (name: string, opts?: { history?: "push" | "replace" | "none" }) => void;
    activeTab: () => string;
  };
}

const activePanel = () => document.querySelector(".panel.is-active")?.getAttribute("data-panel");

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  history.replaceState(null, "", "/app/");
});

describe("console views have addresses", () => {
  it("opening a view writes its address", () => {
    const { selectTab } = loadConsole();
    selectTab("fleet");
    expect(location.hash).toBe("#/agents");
    selectTab("settings");
    // Settings always opens on a page, and the address names it, so a reload returns to that page.
    expect(location.hash).toBe("#/settings/billing");
  });

  it("addresses use the nav's own words, and each one opens its view", () => {
    const routes: Array<[string, string]> = [
      ["home", "overview"], ["agents", "fleet"], ["activity", "timeline"], ["updates", "timeline"],
      ["add-computer", "connect"], ["inbox", "inbox"], ["tasks", "tasks"], ["settings", "settings"],
    ];
    for (const [route, tab] of routes) {
      history.replaceState(null, "", `/app/#/${route}`);
      expect(loadConsole().activeTab(), route).toBe(tab);
    }
  });

  it("a view's address at load is the view the console starts on", () => {
    history.replaceState(null, "", "/app/#/activity");
    expect(loadConsole().activeTab()).toBe("timeline");
  });

  it("an address naming no view falls back to Overview", () => {
    history.replaceState(null, "", "/app/#/no-such-view");
    expect(loadConsole().activeTab()).toBe("overview");
  });

  it("Back returns to the previous view (signed in; on the sign-in page Back is not the console's)", () => {
    const { selectTab } = loadConsole();
    (document.getElementById("console") as HTMLElement).hidden = false;
    selectTab("inbox");
    selectTab("tasks");
    history.replaceState(null, "", "/app/#/inbox");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(activePanel()).toBe("inbox");
  });

  it("the phone notification's #approval-<id> link is left alone", () => {
    history.replaceState(null, "", "/app/?workspace=o1#approval-a1");
    loadConsole().selectTab("inbox");
    expect(location.hash).toBe("#approval-a1");
  });
});

describe("a Settings section's address survives boot and Back (Codex-OpenCadre-f46c on c222b25)", () => {
  it("entering the console at #/settings/billing keeps that address, so Settings can open at the section", () => {
    history.replaceState(null, "", "/app/#/settings/billing");
    const { selectTab, activeTab } = loadConsole();
    expect(activeTab()).toBe("settings");
    selectTab("settings", { history: "replace" }); // what enterConsole() does
    expect(location.hash).toBe("#/settings/billing");
  });

  // Settings is one page per section now (the operator's call): Back between two sections switches the page shown,
  // although the view (Settings) doesn't change.
  it("Back between two Settings pages shows the page in the address, with its own title", () => {
    const { selectTab } = loadConsole();
    (document.getElementById("console") as HTMLElement).hidden = false;
    selectTab("settings");
    const current = () => [...document.querySelectorAll(".settings-card.is-current")].map((n) => n.id);
    history.replaceState(null, "", "/app/#/settings/notifications");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(current()).toContain("webhook-card");
    expect(current()).not.toContain("billing-card");
    expect(document.getElementById("h-settings")?.textContent).toBe("Notifications");
    history.replaceState(null, "", "/app/#/settings/billing");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(current()).toEqual(["billing-card"]);
    expect(document.getElementById("h-settings")?.textContent).toBe("Plan & usage");
  });

  it("entering Settings names the page it opened, in place: a reload returns to it, Back still leaves in one step", () => {
    const { selectTab } = loadConsole();
    (document.getElementById("console") as HTMLElement).hidden = false;
    (document.querySelector('#settings-subnav [data-settings-section="webhook-card"]') as HTMLElement).click();
    selectTab("tasks");
    const before = history.length;
    selectTab("settings");
    expect(location.hash).toBe("#/settings/notifications");
    expect(history.length).toBe(before + 1);
  });

  it("a Settings page link records a history entry, so Back returns to the previous page", () => {
    const { selectTab } = loadConsole();
    (document.getElementById("console") as HTMLElement).hidden = false;
    selectTab("settings");
    const before = history.length;
    (document.querySelector('#settings-subnav [data-settings-section="webhook-card"]') as HTMLElement).click();
    expect(location.hash).toBe("#/settings/notifications");
    expect(history.length).toBe(before + 1);
  });
});

// Subpages have addresses too (the operator: "build out the sidebar and pages and subpages properly").
describe("subpages have addresses", () => {
  it("Agents' views: clicking writes #/agents/computers or #/agents/named, and a deep link opens that view", () => {
    const { selectTab } = loadConsole();
    (document.getElementById("console") as HTMLElement).hidden = false;
    selectTab("fleet");
    (document.querySelector('.view-toggle-btn[data-view="computer"]') as HTMLElement).click();
    expect(location.hash).toBe("#/agents/computers");
    (document.querySelector('.view-toggle-btn[data-view="agents"]') as HTMLElement).click();
    expect(location.hash).toBe("#/agents/named");
    expect((document.getElementById("fleet-agents-view") as HTMLElement).hidden).toBe(false);
    history.replaceState(null, "", "/app/#/agents/computers");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(document.querySelector('.view-toggle-btn[data-view="computer"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("Inbox history is #/inbox/history, and Back returns to the queue", () => {
    const { selectTab } = loadConsole();
    (document.getElementById("console") as HTMLElement).hidden = false;
    selectTab("inbox");
    (document.querySelector('.inbox-view-tab[data-inbox-view="history"]') as HTMLElement).click();
    expect(location.hash).toBe("#/inbox/history");
    history.replaceState(null, "", "/app/#/inbox");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect((document.getElementById("inbox-queue-view") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("inbox-history-view") as HTMLElement).hidden).toBe(true);
  });
});
