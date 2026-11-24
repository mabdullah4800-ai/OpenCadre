// @vitest-environment happy-dom
// Settings › Projects: keep projects apart, and linked projects (docs/design/CONSOLE-V2.md F5). The hub has had
// GET/PUT /v1/org/project-isolation and GET/POST/DELETE /v1/org/project-links, but no console surface: an operator
// could not see or change either. Every arm is red on the console before it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const flush = () => new Promise((r) => setTimeout(r, 0));
type Call = [string, { method?: string; body?: string } | undefined];
type Ui = { refreshIsolation: () => Promise<void>; setMe: (v: unknown) => void; renderProjectsSection: (d: unknown) => void };

const PROJECTS = { projects: [
  { projectKey: "github.com/acme/api", name: "api", enabled: true },
  { projectKey: "github.com/acme/web", name: "web", enabled: true },
] };
const LINK = { projectA: "github.com/acme/api", projectB: "github.com/acme/web", nameA: "api", nameB: "web", createdBy: "Grace", createdAt: new Date().toISOString() };

function loadConsole(route: (url: string, opts?: { method?: string; body?: string }) => unknown): { ui: Ui; calls: Call[] } {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => { calls.push([url, opts]); return route(url, opts); });
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const ui = new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { refreshIsolation, renderProjectsSection, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, fetchMock) as Ui;
  return { ui, calls };
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("keep projects apart", () => {
  it("an operator sees the switch in the hub's state and the linked projects", async () => {
    const { ui } = loadConsole((url) => url === "/v1/org/project-isolation" ? json(200, { enabled: true })
      : url === "/v1/org/project-links" ? json(200, { links: [LINK] }) : json(200, {}));
    ui.setMe({ role: "operator" });
    ui.renderProjectsSection(PROJECTS);
    await ui.refreshIsolation();
    expect($("isolation-section").hidden).toBe(false);
    expect(($("isolation-toggle") as HTMLInputElement).checked).toBe(true);
    expect($("isolation-status").textContent).toMatch(/^On:/);
    expect($("project-links-list").textContent).toContain("api and web");
  });

  it("a refused switch stays off and says which repository is split, under which keys", async () => {
    const { ui } = loadConsole((url, opts) => {
      if (url === "/v1/org/project-isolation" && opts?.method === "PUT") {
        return json(409, { error: "Project isolation can't be switched on yet.", report: { splits: [
          { name: "opencadre", keys: [{ projectKey: "OpenCadre", liveAgents: ["Codex-a"] }, { projectKey: "github.com/mabdullah4800-ai/opencadre", liveAgents: [] }] },
        ] } });
      }
      if (url === "/v1/org/project-isolation") return json(200, { enabled: false });
      if (url === "/v1/org/project-links") return json(200, { links: [] });
      return json(200, {});
    });
    ui.setMe({ role: "operator" });
    await ui.refreshIsolation();
    const toggle = $("isolation-toggle") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    await flush();
    expect(toggle.checked).toBe(false);
    expect($("isolation-refusal").hidden).toBe(false);
    expect($("isolation-refusal").textContent).toContain('"opencadre" is in use under 2 project keys');
    expect($("isolation-refusal").textContent).toContain("github.com/mabdullah4800-ai/opencadre (no live agents)");
  });

  it("linking and unlinking send the pair to the hub", async () => {
    const { ui, calls } = loadConsole((url) => url === "/v1/org/project-isolation" ? json(200, { enabled: true })
      : url === "/v1/org/project-links" ? json(200, { links: [LINK] }) : json(200, {}));
    ui.setMe({ role: "operator" });
    ui.renderProjectsSection(PROJECTS);
    await ui.refreshIsolation();
    ($("link-project-a") as HTMLSelectElement).value = "github.com/acme/api";
    ($("link-project-b") as HTMLSelectElement).value = "github.com/acme/web";
    $("project-link-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const post = calls.find(([url, o]) => url === "/v1/org/project-links" && o?.method === "POST");
    expect(JSON.parse(post![1]!.body!)).toEqual({ projectA: "github.com/acme/api", projectB: "github.com/acme/web" });
    ($("project-links-list").querySelector("button") as HTMLElement).click();
    await flush();
    expect(calls.some(([url, o]) => url === "/v1/org/project-links" && o?.method === "DELETE")).toBe(true);
  });

  it("an agent key that isn't an operator sees nothing and asks nothing", async () => {
    const { ui, calls } = loadConsole(() => json(200, {}));
    ui.setMe({ role: "agent" });
    await ui.refreshIsolation();
    expect($("isolation-section").hidden).toBe(true);
    expect(calls.some(([url]) => url.includes("project-isolation"))).toBe(false);
  });
});

// Codex-OpenCadre-f46c on 0615d4f: two races on first load.
describe("isolation reads that race", () => {
  const deferred = () => { let resolve!: (v: unknown) => void; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

  it("the link form appears once the projects arrive, even when the isolation reads land first", async () => {
    const { ui } = loadConsole((url) => url === "/v1/org/project-isolation" ? json(200, { enabled: true })
      : url === "/v1/org/project-links" ? json(200, { links: [] }) : json(200, {}));
    ui.setMe({ role: "operator" });
    await ui.refreshIsolation(); // lands before any projects are known
    expect($("project-link-form").hidden).toBe(true);
    ui.renderProjectsSection(PROJECTS); // the main refresh arrives
    expect($("project-link-form").hidden).toBe(false);
    expect(($("link-project-a") as HTMLSelectElement).options.length).toBe(2);
  });

  it("a read that started before a change cannot undo it", async () => {
    const slow = deferred();
    let reads = 0;
    const { ui } = loadConsole(async (url, opts) => {
      if (url === "/v1/org/project-isolation" && opts?.method === "PUT") return json(200, { enabled: true, changed: true });
      if (url === "/v1/org/project-isolation") { reads++; if (reads === 1) { await slow.promise; } return json(200, { enabled: false }); }
      if (url === "/v1/org/project-links") return json(200, { links: [] });
      return json(200, {});
    });
    ui.setMe({ role: "operator" });
    const stale = ui.refreshIsolation(); // held
    const toggle = $("isolation-toggle") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    await flush();
    expect(toggle.checked).toBe(true);
    slow.resolve(undefined); // the old read now says "off"
    await stale;
    await flush();
    expect(toggle.checked, "the older read is dropped").toBe(true);
    expect($("isolation-status").textContent).toMatch(/^On:/);
  });
});
