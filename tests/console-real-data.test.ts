// @vitest-environment happy-dom
// Fixes from looking at the LIVE console on the real fleet (2026-09-23): 124 open tasks in one column, offline agents
// listed under "Working now", upgrade buttons on an unlimited plan, and big empty cards in an empty Inbox.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
type Ui = {
  renderTasks: (t: unknown[]) => void; renderOverview: (d: unknown) => void; renderBilling: (d: unknown) => void;
  syncInboxEmpty: () => void; setMe: (v: unknown) => void;
};
function loadConsole(): Ui {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { renderTasks, renderOverview, renderBilling, syncInboxEmpty, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as Ui;
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
const task = (i: number, over: Record<string, unknown> = {}) => ({
  id: `t${i}`, title: `Task ${i}`, status: "open", created_by_agent_name: "Grace", created_at: new Date().toISOString(), ...over,
});

/** The hub's task list over `all`, as src/tasks.ts listTaskPage answers it: per column, search (here, the title), project,
 * limit and an offset cursor, with the five counts over search and project, and the projects among every task. Since
 * tasks tranche 2 the board pages, searches and filters on the hub, so this is what these checks run against. */
function taskHub(all: Array<Record<string, any>>) {
  const columnOf = (t: Record<string, any>) => (t.status === "done" ? "done" : t.status === "claimed" && t.lease_active ? "in_progress" : "open");
  return vi.fn(async (path: string) => {
    const url = new URL(path, "http://hub");
    if (url.pathname !== "/v1/tasks") return json(200, {});
    const p = url.searchParams;
    const q = (p.get("q") ?? "").toLowerCase();
    const scoped = all.filter((t) => (!q || String(t.title).toLowerCase().includes(q)) && (!p.get("project") || t.project_key === p.get("project")));
    const counts = { open: 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 };
    for (const t of scoped) {
      if (t.status === "open") counts.open++;
      else if (t.status === "claimed") counts[t.lease_active ? "in_progress" : "expired"]++;
      else counts[t.reviewed ? "done" : "needs_review"]++;
    }
    const projects = [...new Set(all.map((t) => t.project_key).filter(Boolean))].sort();
    let rows = scoped.filter((t) => columnOf(t) === p.get("column"));
    if (p.get("column") === "done") rows = [...rows].sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
    const start = Number(p.get("cursor") ?? 0);
    const limit = Number(p.get("limit"));
    const more = start + limit < rows.length;
    return json(200, { tasks: rows.slice(start, start + limit), nextCursor: more ? String(start + limit) : null, counts, projects });
  });
}
function loadBoard(all: Array<Record<string, any>>) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${appJs}; return { loadTaskBoard };`)(
    window, document, window.localStorage, taskHub(all)) as { loadTaskBoard: () => Promise<void> };
}

describe("Tasks at the live fleet's scale", () => {
  it("shows 20 per column with a Show more, and search narrows the board", async () => {
    const tasks = Array.from({ length: 124 }, (_, i) => task(i, { title: i === 77 ? "Rotate the webhook secret" : `Task ${i}` }));
    await loadBoard(tasks).loadTaskBoard();
    const open = () => document.querySelector("#tasks .column") as HTMLElement;
    expect(open().querySelectorAll(".task")).toHaveLength(20);
    expect(open().querySelector(".column-count")?.textContent).toBe("124");
    (open().querySelector(".task-more") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(open().querySelectorAll(".task")).toHaveLength(40));
    const search = $("task-search") as HTMLInputElement;
    search.value = "webhook";
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(open().querySelectorAll(".task")).toHaveLength(1), { timeout: 2000 });
    expect($("task-toolbar-count").textContent).toBe("1 of 124 tasks");
  });

  it("Done holds every matching task, newest first, reachable through Show more", async () => {
    const at = (i: number) => new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString();
    const tasks = Array.from({ length: 30 }, (_, i) => task(i, { status: "done", title: `Deploy step ${i}`, completed_at: at(i), claimed_by_agent_name: "Ada" }));
    await loadBoard(tasks).loadTaskBoard();
    const done = () => document.querySelectorAll("#tasks .column")[2] as HTMLElement;
    const titles = () => [...done().querySelectorAll(".task-title")].map((n) => n.textContent);
    expect(done().querySelector(".column-count")?.textContent).toBe("30");
    expect(titles()).toHaveLength(20);
    expect(titles()[0]).toBe("Deploy step 29");
    (done().querySelector(".task-more") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(titles()).toHaveLength(30));
    expect(titles()[29]).toBe("Deploy step 0");
  });

  it("filters by project when there is more than one", async () => {
    await loadBoard([task(1, { project_key: "github.com/acme/api" }), task(2, { project_key: "github.com/acme/web" })]).loadTaskBoard();
    const select = $("task-project-filter") as HTMLSelectElement;
    expect(select.hidden).toBe(false);
    select.value = "github.com/acme/web";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect([...document.querySelectorAll("#tasks .task-title")].map((n) => n.textContent)).toEqual(["Task 2"]));
  });
});

describe("Home: Working now", () => {
  // Plan 2026-09-30-console-refresh-tasks.md item 5: a live session with no recent heartbeat is an idle chat, not a gone
  // one, so it is listed (after the online ones, dimmed) instead of being folded into an "offline" count.
  it("lists online agents first, then idle live ones, dimmed", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator", agentId: "me" });
    const now = new Date().toISOString();
    ui.renderOverview({
      approvals: [], messages: [], tasks: [], grants: [], events: [], awarenessDigest: null,
      agents: [{ id: "a", kind: "session", online: true }, { id: "b", kind: "session", online: false }, { id: "c", kind: "session", online: false }],
      liveSessions: [
        { agentId: "a", agentName: "Codex-api", online: true, lastHeartbeatAt: now },
        { agentId: "b", agentName: "Claude-old", online: false, lastHeartbeatAt: now },
        { agentId: "c", agentName: "Claude-older", online: false, lastHeartbeatAt: now },
      ],
    });
    const rows = [...$("overview-happening").querySelectorAll(".callsign")].map((n) => n.textContent);
    expect(rows).toEqual(["Codex-api", "Claude-old", "Claude-older"]);
    const idle = [...$("overview-happening").querySelectorAll(".strip.is-idle .callsign")].map((n) => n.textContent);
    expect(idle).toEqual(["Claude-old", "Claude-older"]);
    expect($("overview-background").hidden).toBe(true);
  });
});

describe("Plan & usage on an unlimited internal plan", () => {
  it("offers nothing to buy", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator", billing: { plan: "internal", planName: "Internal", seats: 1, limits: { maxAgents: null, maxMachines: null, maxProjects: null, retentionDays: null } } });
    ui.renderBilling({ agents: [], devices: [], projects: [] });
    expect($("billing-card").querySelectorAll("button, a")).toHaveLength(0);
    expect($("billing-note").textContent).toContain("Internal plan");
  });
});

describe("Inbox when nothing is waiting", () => {
  it("is one line, with the detail pane hidden", () => {
    const ui = loadConsole();
    ui.syncInboxEmpty();
    expect($("inbox-all-clear").hidden).toBe(false);
    expect($("inbox-queue-view").classList.contains("is-empty")).toBe(true);
  });
});
