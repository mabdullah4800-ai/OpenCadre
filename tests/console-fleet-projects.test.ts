// @vitest-environment happy-dom
// Fleet: opt-in projects (operator decision, a347). A connected computer joins sessions only in
// projects the workspace has enabled; every other project it sees stays silent and invisible.
// Mocked ahead of the hub PR: GET /v1/org/projects -> {projects:[{projectKey, name, enabled,
// firstSeenAt, lastSeenAt, sessionCount}]}; PUT /v1/org/projects {projectKey, enabled}.
//
// docs/design/HUB_REDESIGN.md 1.8.1/5.5 (operator feedback: "why does this show on dashboard?
// it's useless"): the full enable/disable list lives in Settings -> Projects (renderSettingsProjects,
// #projects-card/#settings-projects). No sightings (Codex-OpenCadre-8160's plan, thread 4c76be48): the
// hub no longer records folders a computer merely had open, so there is no "seen, not enabled" section
// and no Fleet "N more projects detected" nudge; an operator adds a project by its git remote instead.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Project = { projectKey: string; name: string; enabled: boolean; firstSeenAt?: string | null; lastSeenAt?: string | null; sessionCount?: number };
type Console = {
  renderProjectsSection: (projectsData: { projects: Project[] } | null) => void;
  setMe: (v: { role: string } | null) => void;
};

function loadConsole(fetchMock: ReturnType<typeof vi.fn> = vi.fn()) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const wrapped = (url: string, ...rest: unknown[]) =>
    url.startsWith("/v1/auth/") ? json(401, { error: "no session" }) : fetchMock(url, ...rest);
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { renderProjectsSection, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, wrapped) as Console;
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const operator = { role: "operator" };

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("Settings -> Projects card: visibility", () => {
  it("hidden when there's no data at all (non-operator, or the hub doesn't have the route yet)", () => {
    const { renderProjectsSection, setMe } = loadConsole();
    setMe(operator);
    renderProjectsSection(null);
    expect($("projects-card").hidden).toBe(true);
  });

  it("hidden for a non-operator even with data", () => {
    const { renderProjectsSection, setMe } = loadConsole();
    setMe({ role: "member" });
    renderProjectsSection({ projects: [{ projectKey: "p1", name: "OpenCadre", enabled: true, sessionCount: 2 }] });
    expect($("projects-card").hidden).toBe(true);
  });

  it("shown to operators regardless of Fleet's By-project/By-computer toggle -- Settings isn't Fleet", () => {
    const { renderProjectsSection, setMe } = loadConsole();
    setMe(operator);
    document.querySelector<HTMLButtonElement>('.view-toggle-btn[data-view="computer"]')!.click();
    renderProjectsSection({ projects: [{ projectKey: "p1", name: "OpenCadre", enabled: true, sessionCount: 2 }] });
    expect($("projects-card").hidden).toBe(false);
  });
});

describe("no sightings: nothing on Fleet counts or names folders", () => {
  it("the 'N more projects detected' nudge is gone, even with disabled projects listed", () => {
    const { renderProjectsSection, setMe } = loadConsole();
    setMe(operator);
    renderProjectsSection({ projects: [{ projectKey: "p1", name: "OpenCadre", enabled: false, sessionCount: 0 }] });
    expect(document.getElementById("fleet-more-projects")).toBeNull();
    expect(document.body.textContent).not.toMatch(/detected/i);
  });
});

describe("renderSettingsProjects: listing", () => {
  it("no projects yet: says how to add one, never 'seen'", () => {
    const { renderProjectsSection, setMe } = loadConsole();
    setMe(operator);
    renderProjectsSection({ projects: [] });
    // The how-to sentence is gone. The empty state is the line and the action that focuses the add field.
    expect($("settings-projects").textContent).toContain("No projects yet");
    expect($("settings-projects").querySelector("button")?.textContent).toBe("Add project");
    expect($("settings-projects").textContent).not.toMatch(/\bseen\b/);
  });

  it("enabled projects list first, then a 'Switched off' section", () => {
    const { renderProjectsSection, setMe } = loadConsole();
    setMe(operator);
    renderProjectsSection({ projects: [
      { projectKey: "p1", name: "OpenCadre", enabled: true, sessionCount: 3, lastSeenAt: minutesAgo(1) },
      { projectKey: "p2", name: "Sidecar", enabled: false, sessionCount: 0, lastSeenAt: minutesAgo(60) },
      { projectKey: "p3", name: "storefront", enabled: false, sessionCount: 0, lastSeenAt: minutesAgo(90) },
    ] });
    const html = $("settings-projects").innerHTML;
    expect(html.indexOf("OpenCadre")).toBeLessThan(html.indexOf("Switched off"));
    expect(html.indexOf("Switched off")).toBeLessThan(html.indexOf("Sidecar"));
    expect($("settings-projects").textContent).not.toMatch(/seen on your computers/i);
    const chips = Array.from($("settings-projects").querySelectorAll(".status-chip")).map((c) => c.textContent);
    expect(chips).toEqual(["Enabled", "Disabled", "Disabled"]);
  });

  it("shows session count and last used", () => {
    const { renderProjectsSection, setMe } = loadConsole();
    setMe(operator);
    renderProjectsSection({ projects: [{ projectKey: "p1", name: "OpenCadre", enabled: true, sessionCount: 5, lastSeenAt: minutesAgo(2) }] });
    expect($("settings-projects").textContent).toContain("5 sessions");
    expect($("settings-projects").textContent).toMatch(/last used 2m ago/);
  });

  it("singular 'session' for a count of 1", () => {
    const { renderProjectsSection, setMe } = loadConsole();
    setMe(operator);
    renderProjectsSection({ projects: [{ projectKey: "p1", name: "OpenCadre", enabled: true, sessionCount: 1 }] });
    expect($("settings-projects").textContent).toContain("1 session");
    expect($("settings-projects").textContent).not.toContain("1 sessions");
  });
});

describe("Enable", () => {
  it("PUTs enabled: true immediately, no confirmation needed", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/v1/org/projects" ? json(200, {}) : json(200, { projects: [] })));
    const { renderProjectsSection, setMe } = loadConsole(fetchMock);
    setMe(operator);
    renderProjectsSection({ projects: [{ projectKey: "p2", name: "Sidecar", enabled: false, sessionCount: 0 }] });
    (Array.from($("settings-projects").querySelectorAll("button")).find((b) => b.textContent === "Enable") as HTMLButtonElement).click();
    await flush();
    const putCall = fetchMock.mock.calls.find(([url, opts]) => url === "/v1/org/projects" && opts?.method === "PUT");
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall![1].body)).toEqual({ projectKey: "p2", enabled: true });
    expect($("toast").textContent).toBe("Sidecar enabled.");
  });
});

describe("Disable", () => {
  it("opens an inline warning first -- 'Sessions in this project stop working now' -- rather than disabling on the first click", () => {
    const fetchMock = vi.fn();
    const { renderProjectsSection, setMe } = loadConsole(fetchMock);
    setMe(operator);
    renderProjectsSection({ projects: [{ projectKey: "p1", name: "OpenCadre", enabled: true, sessionCount: 3 }] });
    (Array.from($("settings-projects").querySelectorAll("button")).find((b) => b.textContent === "Disable") as HTMLButtonElement).click();
    expect(fetchMock).not.toHaveBeenCalled();
    const warning = $("settings-projects").querySelector(".remove-warning")!;
    expect(warning.textContent).toBe("Sessions in this project stop working now.");
  });

  it("Confirm PUTs enabled: false; Cancel PUTs nothing", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/v1/org/projects" ? json(200, {}) : json(200, { projects: [] })));
    const { renderProjectsSection, setMe } = loadConsole(fetchMock);
    setMe(operator);
    renderProjectsSection({ projects: [{ projectKey: "p1", name: "OpenCadre", enabled: true, sessionCount: 3 }] });
    (Array.from($("settings-projects").querySelectorAll("button")).find((b) => b.textContent === "Disable") as HTMLButtonElement).click();

    const row = $("settings-projects").querySelector(".remove-confirm")!;
    const cancel = Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement;
    cancel.click();
    expect(fetchMock).not.toHaveBeenCalled();
    expect($("settings-projects").querySelector(".remove-confirm")).toBeNull();

    (Array.from($("settings-projects").querySelectorAll("button")).find((b) => b.textContent === "Disable") as HTMLButtonElement).click();
    const confirmBtn = Array.from($("settings-projects").querySelector(".remove-confirm")!.querySelectorAll("button")).find((b) => b.textContent === "Disable") as HTMLButtonElement;
    confirmBtn.click();
    await flush();
    const putCall = fetchMock.mock.calls.find(([url, opts]) => url === "/v1/org/projects" && opts?.method === "PUT");
    expect(JSON.parse(putCall![1].body)).toEqual({ projectKey: "p1", enabled: false });
    expect($("toast").textContent).toBe("OpenCadre disabled.");
  });

  it("a poll never replaces a row while its disable-confirm is open", () => {
    const { renderProjectsSection, setMe } = loadConsole();
    setMe(operator);
    renderProjectsSection({ projects: [{ projectKey: "p1", name: "OpenCadre", enabled: true, sessionCount: 3 }] });
    (Array.from($("settings-projects").querySelectorAll("button")).find((b) => b.textContent === "Disable") as HTMLButtonElement).click();
    const confirmRow = $("settings-projects").querySelector(".remove-confirm");

    renderProjectsSection({ projects: [{ projectKey: "p1", name: "OpenCadre", enabled: true, sessionCount: 3 }, { projectKey: "p2", name: "Sidecar", enabled: true, sessionCount: 1 }] });
    expect($("settings-projects").querySelector(".remove-confirm")).toBe(confirmRow);
    // Wedge A supersedes whole-list defer, retaining this exact confirmation node.
    expect($("settings-projects").textContent).toContain("Sidecar");

    const cancel = Array.from(confirmRow!.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement;
    cancel.click();
    expect($("settings-projects").textContent).toContain("Sidecar");
  });
});

describe("Rename (F5: the hub could rename a project, and no screen offered it)", () => {
  it("renames by PUTting ONLY the new name, never restating enabled (f46c on 5511d8f), and shows it", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/v1/org/projects" ? json(200, {}) : json(200, { projects: [] })));
    const { renderProjectsSection, setMe } = loadConsole(fetchMock);
    setMe(operator);
    renderProjectsSection({ projects: [{ projectKey: "github.com/x/api", name: "api", enabled: true, sessionCount: 2 }] });
    (Array.from($("settings-projects").querySelectorAll("button")).find((b) => b.textContent === "Rename") as HTMLButtonElement).click();
    const input = $("settings-projects").querySelector(".rename-form input") as HTMLInputElement;
    input.value = "Billing API";
    (Array.from($("settings-projects").querySelectorAll(".rename-form button")).find((b) => b.textContent === "Save") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/v1/org/projects" && (init as { method?: string })?.method === "PUT")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([url, i]) => url === "/v1/org/projects" && (i as { method?: string })?.method === "PUT")! as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ projectKey: "github.com/x/api", name: "Billing API" });
    await vi.waitFor(() => expect($("settings-projects").querySelector(".rename-form")).toBeNull());
    expect($("settings-projects").textContent).toContain("Billing API");
  });

  it("a poll doesn't replace the row while its name is being edited", () => {
    const { renderProjectsSection, setMe } = loadConsole();
    setMe(operator);
    renderProjectsSection({ projects: [{ projectKey: "k1", name: "api", enabled: true, sessionCount: 2 }] });
    (Array.from($("settings-projects").querySelectorAll("button")).find((b) => b.textContent === "Rename") as HTMLButtonElement).click();
    const input = $("settings-projects").querySelector(".rename-form input") as HTMLInputElement;
    input.value = "typing…";
    renderProjectsSection({ projects: [{ projectKey: "k1", name: "api", enabled: true, sessionCount: 2 }, { projectKey: "k2", name: "web", enabled: true, sessionCount: 1 }] });
    expect($("settings-projects").querySelector(".rename-form input")).toBe(input);
    // Wedge A supersedes whole-list defer; the original dirty input remains protected above.
    expect($("settings-projects").textContent).toContain("web");
  });
});

describe("Add a project by its git remote", () => {
  const addForm = () => $("project-add-form") as HTMLFormElement;
  const submit = () => addForm().dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

  it("PUTs the typed remote as enabled: true, clears the field and says so", async () => {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) =>
      url === "/v1/org/projects" && init?.method === "PUT"
        ? json(200, { project: { projectKey: "github.com/acme/widgets", name: "widgets", enabled: true } })
        : json(200, { projects: [] }));
    loadConsole(fetchMock);
    ($("project-add-key") as HTMLInputElement).value = "  https://github.com/acme/widgets.git ";
    submit();
    await vi.waitFor(() => expect($("toast").textContent).toBe("widgets added."));
    const put = fetchMock.mock.calls.find(([url, init]) => url === "/v1/org/projects" && (init as { method?: string })?.method === "PUT")!;
    expect(JSON.parse((put[1] as { body: string }).body)).toEqual({ projectKey: "https://github.com/acme/widgets.git", enabled: true });
    expect(($("project-add-key") as HTMLInputElement).value).toBe("");
    expect($("project-add-error").hidden).toBe(true);
  });

  it("an empty field sends nothing", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    loadConsole(fetchMock);
    ($("project-add-key") as HTMLInputElement).value = "   ";
    submit();
    await flush();
    expect(fetchMock.mock.calls.some(([url]) => url === "/v1/org/projects")).toBe(false);
  });

  it("shows the hub's refusal inline and keeps what was typed", async () => {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) =>
      url === "/v1/org/projects" && init?.method === "PUT"
        ? json(400, { error: "projectKey must be a git remote key such as github.com/owner/repo, or local:<folder>" })
        : json(200, { projects: [] }));
    loadConsole(fetchMock);
    ($("project-add-key") as HTMLInputElement).value = "not a remote";
    submit();
    await vi.waitFor(() => expect($("project-add-error").hidden).toBe(false));
    expect($("project-add-error").textContent).toContain("Couldn't add not a remote");
    expect($("project-add-error").textContent).toContain("git remote key");
    expect(($("project-add-key") as HTMLInputElement).value).toBe("not a remote");
  });
});
