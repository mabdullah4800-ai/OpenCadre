// @vitest-environment happy-dom
// The sidebar, rebuilt on the operator's reference (Vercel): the workspace and its plan at the top, Find, the nav, the
// plan alert, and the person at the bottom with a menu holding Theme and Sign out. Settings swaps the nav for its own
// section list; Add a computer lists the computers already connected. Every arm is red on the sidebar before it:
// none of these elements existed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
type Console = {
  selectTab: (name: string) => void;
  setMe: (v: unknown) => void;
  setPerson: (v: unknown) => void;
  renderSidebarIdentity: () => void;
  renderSidebarAlert: () => void;
  renderConnectComputers: (d: unknown[] | null, s: unknown[] | null) => void;
};
function loadConsole(): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { selectTab, renderSidebarIdentity, renderSidebarAlert, renderConnectComputers,
      setMe: (v) => { me = v; }, setPerson: (v) => { person = v; } };`,
  )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as Console;
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  window.localStorage.clear();
  history.replaceState(null, "", "/app/");
});

describe("the top and bottom of the sidebar name the workspace, its plan and the person", () => {
  it("shows the workspace's initial and plan, and the person's name and email", () => {
    const c = loadConsole();
    c.setMe({ orgName: "acme Robotics", agentName: "Owner", billing: { planName: "Trial", plan: "trial" } });
    c.setPerson({ name: "Grace Byte", email: "grace@example.com" });
    c.renderSidebarIdentity();
    expect($("ws-avatar").textContent).toBe("A");
    expect($("ws-plan").hidden).toBe(false);
    expect($("ws-plan").textContent).toBe("Trial");
    expect($("whoami").textContent).toBe("Grace Byte");
    expect($("user-avatar").textContent).toBe("G");
    expect($("user-menu-email").textContent).toBe("grace@example.com");
  });

  it("a paused workspace says so in the pill, in the risk tone", () => {
    const c = loadConsole();
    c.setMe({ orgName: "Acme", workspace: { paused: true }, billing: { planName: "Pro", plan: "pro" } });
    c.renderSidebarIdentity();
    expect($("ws-plan").textContent).toBe("Paused");
    expect($("ws-plan").dataset.tone).toBe("risk");
  });

  it("the plan alert mirrors the billing banner", () => {
    const c = loadConsole();
    $("billing-banner").hidden = false;
    $("billing-banner-title").textContent = "Your trial has ended";
    $("billing-banner-meta").textContent = "The workspace is read-only.";
    c.renderSidebarAlert();
    expect($("sidebar-alert").hidden).toBe(false);
    expect($("sidebar-alert-title").textContent).toBe("Your trial has ended");
    $("billing-banner").hidden = true;
    c.renderSidebarAlert();
    expect($("sidebar-alert").hidden).toBe(true);
  });
});

describe("the account menu", () => {
  it("opens on its button and closes on Escape", () => {
    loadConsole();
    $("user-menu-btn").click();
    expect($("user-menu").hidden).toBe(false);
    expect($("user-menu-btn").getAttribute("aria-expanded")).toBe("true");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect($("user-menu").hidden).toBe(true);
  });

  it("Theme forces dark by rewriting the page's dark-mode rules, remembers it, and System restores them", () => {
    const style = document.createElement("style");
    style.textContent = "@media (prefers-color-scheme: dark) { body { color: white; } }";
    document.head.append(style);
    loadConsole();
    const rule = () => [...(style.sheet as CSSStyleSheet).cssRules].find((r) => "media" in r) as CSSMediaRule;
    (document.querySelector('#user-menu [data-theme-choice="dark"]') as HTMLElement).click();
    expect(rule().media.mediaText).toBe("all");
    expect(window.localStorage.getItem("opencadre.theme")).toBe("dark");
    (document.querySelector('#user-menu [data-theme-choice="light"]') as HTMLElement).click();
    expect(rule().media.mediaText).toBe("not all");
    (document.querySelector('#user-menu [data-theme-choice="system"]') as HTMLElement).click();
    expect(rule().media.mediaText).toContain("prefers-color-scheme: dark");
    expect(window.localStorage.getItem("opencadre.theme")).toBeNull();
  });
});

describe("Settings has its own list in the sidebar", () => {
  it("opening Settings swaps the nav for the section list, and Back restores it", () => {
    const c = loadConsole();
    c.selectTab("settings");
    expect($("tabs-nav").hidden).toBe(true);
    expect($("settings-subnav").hidden).toBe(false);
    $("settings-back").click();
    expect($("tabs-nav").hidden).toBe(false);
    expect($("settings-subnav").hidden).toBe(true);
  });
});

describe("Find", () => {
  it("F opens it, typing narrows it, Enter goes there", () => {
    const c = loadConsole();
    ($("console") as HTMLElement).hidden = false;
    c.selectTab("overview");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    const input = document.querySelector("#find-dialog input") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "tasks";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(document.getElementById("find-dialog")).toBeNull();
    expect(location.hash).toBe("#/tasks");
  });
});

describe("Find after the Activity merge", () => {
  it("does not offer the retired Updates page", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const { findEntries } = new Function("window", "document", "localStorage", "fetch",
      `${appJs}; return { findEntries };`,
    )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as {
      findEntries: () => Array<{ label: string; hint: string }>;
    };
    const pages = findEntries().filter((entry) => entry.hint === "Page").map((entry) => entry.label);
    expect(pages).toContain("Activity");
    expect(pages).not.toContain("Updates");
  });
});
describe("Add a computer lists the computers already connected", () => {
  it("one row per live computer, with its open chats; removed and merged ones are left out", () => {
    const c = loadConsole();
    c.renderConnectComputers(
      [
        { deviceId: "d1", name: "MacBook-Pro", status: "connected", tools: ["claude-code", "codex"] },
        { deviceId: "d2", name: "Old-PC", status: "revoked" },
        { deviceId: "d3", name: "Dup", status: "merged" },
        { deviceId: "d4", name: "New-Box", status: "waiting" },
      ],
      [{ deviceId: "d1", liveness: "chat" }, { deviceId: "d1", liveness: "chat" }, { deviceId: "d1", liveness: "process" }],
    );
    expect($("connect-computers").hidden).toBe(false);
    const rows = [...document.querySelectorAll("#connect-computers-list .computer-row")];
    expect(rows.map((r) => r.querySelector(".computer-row-name")?.textContent)).toEqual(["MacBook-Pro", "New-Box"]);
    expect(rows[0].textContent).toContain("Claude Code, Codex");
    expect(rows[0].textContent).toContain("2 chats open");
    expect(rows[1].textContent).toContain("Waiting to connect");
  });

  it("no computers, no section", () => {
    const c = loadConsole();
    c.renderConnectComputers([], []);
    expect($("connect-computers").hidden).toBe(true);
  });
});

describe("Find locates an agent (f46c on d69583f)", () => {
  it("choosing an agent opens Agents at that agent's row and marks it", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const ui = new Function("window", "document", "localStorage", "fetch",
      `${appJs}; return { findEntries, setSessions: (s) => { lastFleetSessions = s; } };`,
    )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as {
      findEntries: () => Array<{ label: string; hint: string; go: () => void }>;
      setSessions: (s: unknown[]) => void;
    };
    ui.setSessions([{ agentName: "Codex-api-eb45" }]);
    const panel = document.querySelector('[data-panel="fleet"]')!;
    const row = document.createElement("article");
    row.className = "strip";
    row.innerHTML = '<p class="callsign">Codex-api-eb45</p>';
    panel.append(row);
    const entry = ui.findEntries().find((e) => e.hint === "Agent" && e.label === "Codex-api-eb45")!;
    entry.go();
    expect(location.hash).toBe("#/agents");
    expect(row.classList.contains("is-found")).toBe(true);
  });
});

describe("the Settings list follows the cards a refresh reveals", () => {
  it("Projects appears in the list once the refresh shows an operator its card", async () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const bodies: Record<string, unknown> = {
      "/v1/me": { agentId: "op", agentName: "Operator", role: "operator", orgName: "Acme" },
      "/v1/agents": { agents: [] }, "/v1/approvals?status=pending": { approvals: [] }, "/v1/approvals": { approvals: [] },
      "/v1/approval-grants": { grants: [] }, "/v1/tasks": { tasks: [] },
      "/v1/org/projects": { projects: [{ projectKey: "github.com/acme/api", name: "api", enabled: true }] },
    };
    const fetchMock = vi.fn(async (url: string) => json(200, bodies[url] ?? {}));
    const ui = new Function("window", "document", "localStorage", "fetch",
      `${appJs}; return { refresh, selectTab, setKey: (k) => { agentKey = k; } };`,
    )(window, document, window.localStorage, fetchMock) as { refresh: () => Promise<void>; selectTab: (t: string) => void; setKey: (k: string) => void };
    ui.setKey("agt_test");
    ui.selectTab("settings");
    const link = () => document.querySelector('#settings-subnav [data-settings-section="projects-card"]') as HTMLElement;
    expect(link().hidden).toBe(true); // the card is hidden until the hub says who you are
    await ui.refresh();
    expect($("projects-card").hidden).toBe(false);
    expect(link().hidden).toBe(false);
  });
});
