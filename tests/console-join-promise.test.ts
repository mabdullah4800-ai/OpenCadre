// @vitest-environment happy-dom
// UX batch 1, fix 2 (Codex audit): "Add a computer" and the old public site promised that EVERY Claude Code or Codex chat on
// a connected computer joins, while Settings → Projects says only chats in ENABLED projects do (src/devices.ts refuses a
// session in any other project). The copy now says which chats join and where projects are enabled, and the setup
// success state links there. Red before the fix: the broad promise was on both pages and the success state had no link.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appHtml = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { setWizardStep, renderFirstRun, renderProjectsSection, rememberSelfServe, setConnected: () => { firstRunConnected = true; }, setMe: (v) => { me = v; }, activeTab: () => activeTab, settingsPage: () => settingsPage };`,
  )(window, document, window.localStorage, vi.fn(async (path: string) => {
    if (path === "/v1/org/devices") return json(200, { devices: [{ deviceId: "dev-1", status: "connected" }] });
    return json(200, {});
  })) as {
    setWizardStep: (step: string, name?: string, device?: unknown) => void;
    setMe: (v: unknown) => void;
    activeTab: () => string;
    settingsPage: () => string;
  };
}

beforeEach(() => {
  document.documentElement.innerHTML = appHtml.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  localStorage.clear();
});

describe("which chats join, said the same everywhere", () => {
  it("the console's Add a computer page says, in what a sighted person reads, per computer and per tool, and where chats join from", () => {
    const wizard = document.getElementById("connect-wizard")!;
    expect(wizard.textContent).not.toMatch(/every Claude Code or Codex chat you open on it joins/i);
    // Codex-049a's ruling (2026-10-01): setup is per computer and per tool, never framed as done once. It is in the
    // visible headings, not in a label only a screen reader gets.
    expect(wizard.hasAttribute("aria-label")).toBe(false);
    const headings = [...wizard.querySelectorAll(":scope > li h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Connect each computer", "Run the connect command on that computer", "Finish setup for each tool"]);
    // One row per tool under "Finish setup for each tool".
    expect([...wizard.querySelectorAll("#wizard-client-steps > li > b")].map((b) => b.textContent))
      .toEqual(["Claude Code:", "Codex desktop:", "Codex CLI:", "Cursor:"]);
    const projects = $("wizard-projects");
    expect(projects.textContent).toMatch(/^Chats join from: /);
    expect(projects.querySelector('a[href="#/settings/projects"]')?.textContent).toBe("Manage projects");
    // "Works once" on the code chip is about the code; the setup copy itself never says once.
    const setupCopy = [...headings, projects.textContent, $("wizard-client-steps").textContent].join(" ");
    expect(setupCopy).not.toMatch(/\bonce\b|one-time/i);
    expect(wizard.querySelectorAll(":scope > li")).toHaveLength(3);
  });

  it("which projects chats join from is state: the enabled ones, or none yet with the folder you connect from", () => {
    const c = loadConsole() as ReturnType<typeof loadConsole> & { renderProjectsSection: (data: unknown, kind: string) => void };
    c.setMe({ orgId: "org-1", agentId: "me", role: "operator" });
    c.renderProjectsSection({ projects: [
      { projectKey: "github.com/acme/web", name: "web", enabled: true },
      { projectKey: "github.com/acme/api", name: "api", enabled: true },
      { projectKey: "github.com/acme/old", name: "old", enabled: false },
    ] }, "ok");
    expect($("wizard-projects").textContent).toBe("Chats join from: web, api · Manage projects");
    c.renderProjectsSection({ projects: [{ projectKey: "github.com/acme/old", name: "old", enabled: false }] }, "ok");
    expect($("wizard-projects").textContent).toBe("Chats join from: none yet (the folder you connect from is enabled for you) · Manage projects");
    // Someone who can't read the workspace's projects gets what is true for them, without a link to a page they lack.
    c.setMe({ orgId: "org-1", agentId: "me", role: "agent" });
    c.renderProjectsSection(null, "forbidden");
    expect($("wizard-projects-list").textContent).toBe("the folder you connect from");
    expect(($("wizard-projects-link") as HTMLElement).hidden).toBe(true);
  });

  it("the check step copies exactly what it shows, and says in sight what the check does not prove", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    loadConsole();
    const check = $("wizard-chat-check");
    const shown = check.querySelector("code")!.textContent;
    expect(shown).toBe("Use OpenCadre to show the active agents in this workspace.");
    ($("wizard-copy-check") as HTMLButtonElement).click();
    expect(writeText).toHaveBeenCalledWith(shown);
    const note = check.querySelector(".wizard-check-note") as HTMLElement;
    expect(note.textContent).toBe("Passes when the call succeeds and the chat appears on Agents. It does not verify approvals or idle wake.");
    expect(check.querySelector(".visually-hidden")).toBeNull();
  });

  it("the setup success state links straight to Settings → Projects", () => {
    const c = loadConsole();
    c.setMe({ orgId: "org-1", agentId: "me", role: "operator" });
    $("projects-card").hidden = false; // an operator's Projects page, as applyRole leaves it
    c.setWizardStep("chat", "Work laptop", { name: "Work laptop", tools: ["claude-code"] });
    expect($("wizard-chat-hint").textContent).toMatch(/project you've enabled/);
    // Connecting the computer proves the computer, not the chat: the hint says so in one line.
    expect($("wizard-chat-hint").textContent).toContain("A computer connection does not confirm hook trust or a working chat.");
    const link = $("wizard-go-projects") as HTMLAnchorElement;
    expect(link.hidden).toBe(false);
    expect(link.getAttribute("href")).toBe("#/settings/projects");
    link.click();
    expect(c.activeTab()).toBe("settings");
    expect(c.settingsPage()).toBe("projects");
  });

  it("the first-run card's connected state links there too", async () => {
    const c = loadConsole() as ReturnType<typeof loadConsole> & { renderFirstRun: () => Promise<void>; rememberSelfServe: (o: string, a: unknown) => void; setConnected: () => void };
    c.setMe({ orgId: "org-1", agentId: "me", role: "operator" });
    c.rememberSelfServe("org-1", { apiKey: "agt_first_run", agentName: "First Agent" });
    c.setConnected();
    await c.renderFirstRun();
    expect($("first-run-status").textContent).toBe("Connected ✓");
    expect(($("first-run-projects") as HTMLAnchorElement).hidden).toBe(false);
    expect($("first-run-projects").getAttribute("href")).toBe("#/settings/projects");
  });
});
