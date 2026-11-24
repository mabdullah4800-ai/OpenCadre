// @vitest-environment happy-dom
// The task board after tranche 2 (docs/superpowers/plans/2026-09-30-task-paging.md; §0 is Codex-OpenCadre-049a's
// binding ruling). The console used to fetch every task in full every 4 s and page, search and count on the client.
// Now each column asks for its first page of summaries, "Show more" pages with the hub's cursor, search goes to the hub,
// a card's description loads when it is opened, and Home's number comes from the hub's counts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => { let r!: () => void; const promise = new Promise<void>((res) => { r = res; }); return { promise, resolve: r }; };

type Task = Record<string, unknown> & { id: string; title: string; status: string };
const now = () => new Date().toISOString();
const summary = (id: string, over: Record<string, unknown> = {}): Task => ({
  id, title: `Task ${id}`, status: "open", created_by_agent_id: "grace", created_by_agent_name: "Grace", created_at: now(), updated_at: "2026-09-30 10:00:00",
  lease_active: false, reviewed: 0, review_count: 0, required_reviews: 1, required_capabilities_list: [], superseded: false, superseded_by: null,
  superseded_by_title: null, has_description: false, has_completion_summary: false, has_review_note: false, review_note: null, project_key: null, ...over,
});
const COUNTS = { open: 30, expired: 5, in_progress: 1, needs_review: 2, done: 3 };

/** A hub whose /v1/tasks answers per column. `pages[column]` is a list of pages; a request with a cursor gets the page the
 * cursor names ("<column>-<n>"). `details[id]` answers GET /v1/tasks/:id. Everything else is the hub's usual read shape. */
function boardHub() {
  const pages: Record<string, Task[][]> = { open: [[]], in_progress: [[]], done: [[]] };
  const details: Record<string, { status: number; body: unknown } | undefined> = {};
  let counts: Record<string, number> = { ...COUNTS };
  let totals: Record<string, number> = { ...COUNTS };
  let projects: string[] = [];
  let search: (q: string, column: string) => Task[] | null = () => null;
  const hold: Record<string, Deferred | undefined> = {};
  const fetchMock = vi.fn(async (path: string, init?: { method?: string }) => {
    const url = new URL(path, "http://hub");
    if (url.pathname === "/v1/tasks" && (!init?.method || init.method === "GET")) {
      const p = url.searchParams;
      const heldBy = Object.keys(hold).find((k) => path.includes(k) && hold[k]);
      if (heldBy) await hold[heldBy]!.promise;
      if (p.get("limit") === "0") return json(200, { tasks: [], nextCursor: null, counts: totals, projects });
      const column = p.get("column")!;
      const q = p.get("q") ?? "";
      const cursor = p.get("cursor");
      if (cursor === "refused") return json(400, { error: "That cursor isn't valid for this list. Start again from the first page." });
      const found = q ? search(q, column) : null;
      if (found) return json(200, { tasks: found, nextCursor: null, counts, projects });
      // The cursor here is "<column>-<offset>"; the real hub's is an opaque keyset, which the console never reads.
      const start = cursor ? Number(cursor.split("-").pop()) : 0;
      const limit = Number(p.get("limit"));
      const all = pages[column].flat();
      const more = start + limit < all.length;
      return json(200, { tasks: all.slice(start, start + limit), nextCursor: more ? `${column}-${start + limit}` : null, counts, projects });
    }
    const detail = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
    if (detail) {
      const held = hold[`detail:${detail[1]}`];
      if (held) await held.promise;
      const answer = details[detail[1]];
      return answer ? json(answer.status, answer.body) : json(404, { error: `No task found matching "${detail[1]}"` });
    }
    const body = hubReadBody(path);
    return json(200, body ?? {});
  });
  return {
    fetchMock, pages, details, hold,
    setCounts: (c: Record<string, number>) => { counts = c; },
    setTotals: (c: Record<string, number>) => { totals = c; },
    setProjects: (p: string[]) => { projects = p; },
    setSearch: (fn: typeof search) => { search = fn; },
  };
}

type Ui = {
  loadTaskBoard: () => Promise<void>;
  loadAndRender: () => Promise<void>;
  renderTasks: (t: unknown[]) => void;
  beginConsoleGeneration: () => void;
  setMe: (v: unknown) => void;
};
function loadConsole(fetchMock: ReturnType<typeof boardHub>["fetchMock"]): Ui {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { loadTaskBoard, loadAndRender, renderTasks, beginConsoleGeneration, setMe: (v) => { me = v; } };`)(
    window, document, window.localStorage, fetchMock) as Ui;
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

const card = (id: string) => document.querySelector(`.task[data-task-id="${id}"]`) as HTMLElement | null;
const column = (name: string) => [...document.querySelectorAll("#tasks .column")].find((c) => c.querySelector("h3")?.firstChild?.textContent === name) as HTMLElement;
const cardIds = (name: string) => [...column(name).querySelectorAll(".task")].map((n) => (n as HTMLElement).dataset.taskId);
const headCount = (name: string) => column(name).querySelector(".column-count")!.textContent;
const taskGets = (h: ReturnType<typeof boardHub>) =>
  h.fetchMock.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith("/v1/tasks?"));
const many = (prefix: string, n: number, over: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => summary(`${prefix}${i}`, over));
const inProgress = { status: "claimed", lease_active: true, claimed_by_agent_id: "codex", claimed_by_agent_name: "Codex", lease_expires_at: new Date(Date.now() + 3_600_000).toISOString() };
const doneRow = { status: "done", claimed_by_agent_id: "codex", claimed_by_agent_name: "Codex", completed_at: now() };

describe("each column pages from the hub", () => {
  it("asks for each column's first page of summaries, and counts each column from the hub's counts", async () => {
    const h = boardHub();
    h.pages.open = [many("o", 20), many("o-late", 5)];
    h.pages.in_progress = [[summary("p0", inProgress)]];
    h.pages.done = [many("d", 3, doneRow)];
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    const gets = taskGets(h);
    for (const col of ["open", "in_progress", "done"]) {
      const url = gets.find((g) => g.includes(`column=${col}`))!;
      expect(url).toContain("summary=1");
      expect(url).toContain("limit=20");
      expect(url).not.toContain("cursor=");
    }
    expect(headCount("Open")).toBe("35"); // open + expired
    expect(headCount("In progress")).toBe("1");
    expect(headCount("Done")).toBe("5"); // needs_review + done
    expect(cardIds("Open")).toHaveLength(20);
    expect(column("Open").querySelector(".task-more")!.textContent).toBe("Show 15 more (15 hidden)");
    expect(column("Done").querySelector(".task-more")).toBeNull(); // no cursor, no button
  });

  it("Show more asks for that column's next page with the cursor, appends it without duplicates, and leaves the others alone", async () => {
    const h = boardHub();
    h.pages.open = [many("o", 20), [summary("o19"), ...many("n", 3)]]; // the hub repeats o19: a row that moved between pages
    h.pages.done = [many("d", 2, doneRow)];
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    const before = taskGets(h).length;
    (column("Open").querySelector(".task-more") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(cardIds("Open")).toHaveLength(23));
    const more = taskGets(h).slice(before);
    expect(more).toHaveLength(1);
    expect(more[0]).toContain("column=open");
    expect(more[0]).toContain("cursor=open-20");
    expect(new Set(cardIds("Open")).size).toBe(23);
    expect(cardIds("Done")).toHaveLength(2);
  });

  it("a refresh reloads each column as far as it was paged, from the start, instead of appending", async () => {
    const h = boardHub();
    h.pages.open = [many("o", 20), many("n", 5)];
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    (column("Open").querySelector(".task-more") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(cardIds("Open")).toHaveLength(25));
    const before = taskGets(h).length;
    await ui.loadTaskBoard();
    const again = taskGets(h).slice(before).find((g) => g.includes("column=open"))!;
    expect(again).toContain("limit=25");
    expect(again).not.toContain("cursor=");
    expect(cardIds("Open")).toHaveLength(25);
    expect(new Set(cardIds("Open")).size).toBe(25);
  });

  it("a refused cursor starts that column again from the top", async () => {
    const h = boardHub();
    h.pages.open = [many("o", 20), many("n", 5)];
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    const button = column("Open").querySelector(".task-more") as HTMLButtonElement;
    // The hub restarted (a new per-process key) or the list changed shape: it refuses the cursor.
    h.pages.open = [many("o", 20), many("n", 5)];
    const original = h.fetchMock.getMockImplementation()!;
    h.fetchMock.mockImplementation(async (p: string, i?: { method?: string }) => original(p.replace(/cursor=[^&]+/, "cursor=refused"), i));
    const before = taskGets(h).length;
    button.click();
    await vi.waitFor(() => expect(taskGets(h).slice(before).some((g) => g.includes("column=open") && !g.includes("cursor="))).toBe(true));
    await vi.waitFor(() => expect(cardIds("Open")).toHaveLength(20));
  });
});

describe("search and the project filter go to the hub", () => {
  it("typing searches on the hub (debounced), shows exactly what it returns, and counts against the unfiltered total", async () => {
    const h = boardHub();
    h.pages.open = [many("o", 3)];
    h.setSearch((q, col) => (q === "login" && col === "open" ? [summary("m1", { title: "Fix the flaky test", has_description: true })] : []));
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    const search = document.getElementById("task-search") as HTMLInputElement;
    const before = taskGets(h).length;
    search.value = "login";
    search.dispatchEvent(new Event("input"));
    expect(taskGets(h).length).toBe(before); // debounced: nothing yet
    h.setCounts({ open: 1, expired: 0, in_progress: 0, needs_review: 0, done: 0 });
    await vi.waitFor(() => expect(cardIds("Open")).toEqual(["m1"]), { timeout: 2000 });
    const sent = taskGets(h).slice(before);
    for (const col of ["open", "in_progress", "done"]) expect(sent.some((g) => g.includes(`column=${col}`) && g.includes("q=login"))).toBe(true);
    // The matching card's title does not contain the word: the hub matched its description, and the console did not re-filter.
    expect(card("m1")!.querySelector(".task-title")!.textContent).toBe("Fix the flaky test");
    expect(sent.some((g) => g.includes("limit=0") && !g.includes("q="))).toBe(true);
    expect(document.getElementById("task-toolbar-count")!.textContent).toBe("1 of 41 tasks");
  });

  it("typing drops the old list's Show more at once, and a search that didn't change asks the hub nothing", async () => {
    const h = boardHub();
    h.pages.open = [many("o", 20), many("n", 5)];
    h.setSearch((q, col) => (col === "open" ? many("hit", 25).slice(0, 20) : []));
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    const search = document.getElementById("task-search") as HTMLInputElement;
    const before = taskGets(h).length;
    search.value = " ";
    search.dispatchEvent(new Event("input")); // still no search
    await new Promise((r) => setTimeout(r, 300));
    expect(taskGets(h).length).toBe(before);
    expect(column("Open").querySelector(".task-more")).not.toBeNull();
    search.value = "hit";
    search.dispatchEvent(new Event("input"));
    // The cards stay until the hub answers, but their Show more would page the old list, so it goes now.
    expect(cardIds("Open")).toHaveLength(20);
    expect(column("Open").querySelector(".task-more")).toBeNull();
    await vi.waitFor(() => expect(cardIds("Open")[0]).toBe("hit0"), { timeout: 2000 });
  });

  it("an answer for an earlier search never paints over a later one", async () => {
    const h = boardHub();
    h.setSearch((q, col) => (col === "open" ? [summary(`hit-${q}`)] : []));
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    const search = document.getElementById("task-search") as HTMLInputElement;
    h.hold["q=lo&"] = deferred();
    search.value = "lo";
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(taskGets(h).some((g) => g.includes("q=lo&"))).toBe(true), { timeout: 2000 });
    search.value = "log";
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(cardIds("Open")).toEqual(["hit-log"]), { timeout: 2000 });
    h.hold["q=lo&"]!.resolve();
    await new Promise((r) => setTimeout(r, 50));
    expect(cardIds("Open")).toEqual(["hit-log"]);
  });

  it("the project filter's options come from the hub's metadata, not from the projects on page 1", async () => {
    const h = boardHub();
    h.pages.open = [[summary("o1", { project_key: "github.com/acme/api" })]];
    h.setProjects(["github.com/acme/api", "github.com/acme/web", "local:Docs"]);
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    const select = document.getElementById("task-project-filter") as HTMLSelectElement;
    expect(select.hidden).toBe(false);
    expect([...select.options].map((o) => o.value)).toEqual(["", "github.com/acme/api", "github.com/acme/web", "local:Docs"]);
    const before = taskGets(h).length;
    select.value = "github.com/acme/web";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(taskGets(h).slice(before).filter((g) => g.includes("project=github.com%2Facme%2Fweb")).length).toBe(3));
  });
});

describe("Home counts from the hub", () => {
  it("Home's open tasks are open + expired from the hub's counts, and a board search does not change them", async () => {
    const h = boardHub();
    h.pages.open = [many("o", 2)];
    h.setSearch(() => []);
    const ui = loadConsole(h.fetchMock);
    ui.setMe({ agentId: "op", role: "operator" });
    await ui.loadAndRender();
    const openStat = () => document.querySelector('#overview-metrics [data-tile="tasks"] .home-tile-number')?.textContent;
    expect(openStat()).toBe("35");
    const search = document.getElementById("task-search") as HTMLInputElement;
    search.value = "nothing matches";
    search.dispatchEvent(new Event("input"));
    h.setCounts({ open: 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 });
    await vi.waitFor(() => expect(document.getElementById("task-toolbar-count")!.textContent).toBe("0 of 41 tasks"), { timeout: 2000 });
    await ui.loadAndRender();
    expect(openStat()).toBe("35");
  });
});

describe("a card's details load when opened", () => {
  const withText = () => summary("t1", { ...doneRow, has_description: true, has_completion_summary: true });
  const full = (over: Record<string, unknown> = {}) => ({ task: { ...withText(), description: "Cover every flag.", completion_summary: "Wrote it; see PR 12.", ...over } });
  const open = (id: string) => {
    const d = card(id)!.querySelector(".task-details") as HTMLDetailsElement;
    d.open = true;
    d.dispatchEvent(new Event("toggle"));
    return d;
  };
  const close = (id: string) => { const d = card(id)!.querySelector(".task-details") as HTMLDetailsElement; d.open = false; d.dispatchEvent(new Event("toggle")); };
  const detailGets = (h: ReturnType<typeof boardHub>, id: string) => h.fetchMock.mock.calls.filter(([p]) => p === `/v1/tasks/${id}`).length;

  it("fetches the full task once, shows the description and the completion summary, and reuses it while the task is unchanged", async () => {
    const h = boardHub();
    h.pages.done = [[withText()]];
    h.details.t1 = { status: 200, body: full() };
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    const d = open("t1");
    await vi.waitFor(() => expect(d.querySelector(".task-description")?.textContent).toBe("Cover every flag."));
    expect(d.textContent).toContain("Wrote it; see PR 12.");
    close("t1");
    open("t1");
    await ui.loadTaskBoard(); // unchanged task: same card, same details
    open("t1");
    expect(detailGets(h, "t1")).toBe(1);
  });

  it("a changed task loads again, and a failed load shows an error, never the earlier text", async () => {
    const h = boardHub();
    h.pages.done = [[withText()]];
    h.details.t1 = { status: 200, body: full() };
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    open("t1");
    await vi.waitFor(() => expect(card("t1")!.querySelector(".task-description")?.textContent).toBe("Cover every flag."));
    // The task changed (reviewed now) and the viewer lost access to it.
    h.pages.done = [[{ ...withText(), reviewed: 1, reviewed_by_agent_name: "Grace", updated_at: "2026-09-30 11:00:00" }]];
    h.details.t1 = { status: 404, body: { error: 'No task found matching "t1"' } };
    await ui.loadTaskBoard();
    const d = card("t1")!.querySelector(".task-details") as HTMLDetailsElement;
    if (!d.open) open("t1");
    await vi.waitFor(() => expect(card("t1")!.querySelector(".task-detail-error")).not.toBeNull());
    expect(card("t1")!.textContent).not.toContain("Cover every flag.");
    expect(card("t1")!.textContent).not.toContain("Wrote it; see PR 12.");
    expect(detailGets(h, "t1")).toBe(2);
  });

  it("a workspace switch drops the cached details, and an answer for the previous workspace never paints", async () => {
    const h = boardHub();
    h.pages.done = [[withText()]];
    h.details.t1 = { status: 200, body: full() };
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    open("t1");
    await vi.waitFor(() => expect(card("t1")!.querySelector(".task-description")).not.toBeNull());
    ui.beginConsoleGeneration();
    expect(document.querySelectorAll("#tasks .task")).toHaveLength(0);
    // The new workspace happens to have a task with the same id; its details must be fetched again.
    h.details.t1 = { status: 200, body: full({ description: "Workspace B's text." }) };
    await ui.loadTaskBoard();
    h.hold["detail:t1"] = deferred();
    open("t1");
    await vi.waitFor(() => expect(detailGets(h, "t1")).toBe(2));
    ui.beginConsoleGeneration(); // and switch again while that answer is out
    await ui.loadTaskBoard();
    h.hold["detail:t1"]!.resolve();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.body.textContent).not.toContain("Workspace B's text.");
  });

  it("a task with nothing more to show does not ask the hub", async () => {
    const h = boardHub();
    h.pages.open = [[summary("bare")]];
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    open("bare");
    await new Promise((r) => setTimeout(r, 20));
    expect(detailGets(h, "bare")).toBe(0);
  });

  it("a long review note the summary withholds is read from the full task", async () => {
    const h = boardHub();
    h.pages.in_progress = [[summary("t2", { ...inProgress, has_review_note: true, review_note: null })]];
    h.details.t2 = { status: 200, body: { task: { ...summary("t2", inProgress), review_note: "n".repeat(600) } } };
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    expect(card("t2")!.querySelector(".task-meta")!.textContent).toContain("sent back");
    open("t2");
    await vi.waitFor(() => expect(card("t2")!.textContent).toContain("n".repeat(600)));
  });
});

describe("Open the newer task", () => {
  it("finds a task that isn't in the loaded pages, shows it in its column and opens it", async () => {
    const h = boardHub();
    h.pages.open = [[summary("old", { superseded: true, superseded_by: "new", superseded_by_title: "The newer one" }), ...many("o", 19)], many("later", 5)];
    h.details.new = { status: 200, body: { task: { ...summary("new", { title: "The newer one", description: "Its text." }) } } };
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    expect(card("new")).toBeNull();
    (card("old")!.querySelector(".task-actions button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(card("new")).not.toBeNull());
    expect(card("new")!.closest(".column")!.querySelector("h3")!.firstChild!.textContent).toBe("Open");
    expect((card("new")!.querySelector(".task-details") as HTMLDetailsElement).open).toBe(true);
    // It stays through the next refresh although it still isn't on a loaded page.
    await ui.loadTaskBoard();
    expect(card("new")).not.toBeNull();
  });

  it("clears a search, and still reaches the task", async () => {
    const h = boardHub();
    h.setSearch((q, col) => (col === "open" ? [summary("old", { title: "Draft", superseded: true, superseded_by: "new", superseded_by_title: "Final" })] : []));
    h.details.new = { status: 200, body: { task: summary("new", { title: "Final" }) } };
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    const search = document.getElementById("task-search") as HTMLInputElement;
    search.value = "Draft";
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(card("old")).not.toBeNull(), { timeout: 2000 });
    (card("old")!.querySelector(".task-actions button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(card("new")).not.toBeNull());
    expect(search.value).toBe("");
    await vi.waitFor(() => expect(taskGets(h).at(-1)).not.toContain("q="));
  });
});

describe("an identity change resets the board", () => {
  it("drops pages, cursors, search and filter, so the next workspace starts at its own first page", async () => {
    const h = boardHub();
    h.pages.open = [many("o", 20), many("n", 5)];
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    (column("Open").querySelector(".task-more") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(cardIds("Open")).toHaveLength(25));
    (document.getElementById("task-search") as HTMLInputElement).value = "x";
    ui.beginConsoleGeneration();
    expect((document.getElementById("task-search") as HTMLInputElement).value).toBe("");
    const before = taskGets(h).length;
    await ui.loadTaskBoard();
    const first = taskGets(h).slice(before).find((g) => g.includes("column=open"))!;
    expect(first).toContain("limit=20");
    expect(first).not.toContain("q=");
  });
});

// --- Codex-OpenCadre-049a's review of #660 at d236df40 (pr660-ui-repro.test-snippet.ts) --------------------------------
describe("review regressions", () => {
  it("review: refresh preserves all loaded tasks beyond one server request cap", async () => {
    const h = boardHub();
    h.pages.open = [Array.from({ length: 560 }, (_, i) => summary(`bulk-${i}`))];
    h.setCounts({ open: 560, expired: 0, in_progress: 0, needs_review: 0, done: 0 });
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const ui = new Function("window", "document", "localStorage", "fetch",
      `${appJs}; return { loadTaskBoard, loadMoreTasks };`)(window, document, window.localStorage, h.fetchMock) as {
        loadTaskBoard: () => Promise<void>; loadMoreTasks: (column: string) => Promise<void>;
      };
    await ui.loadTaskBoard();
    for (let i = 0; i < 26; i++) await ui.loadMoreTasks("open");
    expect(cardIds("Open")).toHaveLength(540);
    expect(card("bulk-539")).not.toBeNull();
    await ui.loadTaskBoard(); // the same board read the 4-second poll performs
    expect(cardIds("Open"), "a regular refresh discarded loaded tasks past 500").toHaveLength(540);
    expect(card("bulk-539"), "the task the reader reached vanished").not.toBeNull();
    // Each request stayed within the hub's cap, and the reader's next Show more continues after 540.
    const limits = taskGets(h).map((g) => Number(new URL(g, "http://hub").searchParams.get("limit")));
    expect(Math.max(...limits)).toBeLessThanOrEqual(500);
    await ui.loadMoreTasks("open");
    expect(cardIds("Open")).toHaveLength(560);
  }, 20_000);

  // Found by console-shots after the review fixes: a poll that began before a Show more landed was sized for the shorter
  // column, and replaced it afterwards, taking the new page away.
  it("a refresh that began before a Show more landed does not take the new page away", async () => {
    const h = boardHub();
    h.pages.open = [many("o", 45)];
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const ui = new Function("window", "document", "localStorage", "fetch",
      `${appJs}; return { loadTaskBoard, loadMoreTasks };`)(window, document, window.localStorage, h.fetchMock) as {
        loadTaskBoard: () => Promise<void>; loadMoreTasks: (column: string) => Promise<void>;
      };
    await ui.loadTaskBoard();
    const gate = deferred();
    h.hold["column=open&limit=20"] = gate;
    const poll = ui.loadTaskBoard(); // sized for the 20 loaded, and held
    h.hold["column=open&limit=20"] = undefined; // the Show more's own request goes through
    await ui.loadMoreTasks("open");
    expect(cardIds("Open")).toHaveLength(40);
    gate.resolve(); // the poll answers now, with the 20 rows it asked for
    await poll;
    expect(cardIds("Open"), "the refresh cut the column back to what it had asked for").toHaveLength(40);
    await ui.loadTaskBoard(); // the next refresh reads the whole extent
    expect(cardIds("Open")).toHaveLength(40);
    expect(taskGets(h).at(-3)).toContain("limit=40");
  });

  // Codex's snippet gave both snapshots no revision, so nothing in them could tell the two results apart: the fix is the
  // hub's revision (migration 54), which a rejection and a re-completion each bump. The snapshots here carry it, as the
  // hub's summaries now do; everything else is the snippet as written.
  it("review: a re-completion in the same timestamp second cannot reuse the previous result", async () => {
    const h = boardHub();
    const row = summary("recomplete", { status: "done", completed_at: "2026-09-30 10:00:00", has_completion_summary: true, claimed_by_agent_id: "worker", revision: 7 });
    h.pages.done = [[row]];
    h.details.recomplete = { status: 200, body: { task: { ...row, completion_summary: "First completion result." } } };
    const ui = loadConsole(h.fetchMock);
    await ui.loadTaskBoard();
    const first = card("recomplete")!.querySelector(".task-details") as HTMLDetailsElement;
    first.open = true; first.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(first.textContent).toContain("First completion result."));
    first.open = false; first.dispatchEvent(new Event("toggle"));
    // rejectTask + completeTask can both occur within the same SQLite datetime('now') second between board polls.
    // Final summary fields are identical except the revision, and the result is new.
    const later = { ...row, revision: 9 };
    h.pages.done = [[later]];
    h.details.recomplete = { status: 200, body: { task: { ...later, completion_summary: "Corrected completion result." } } };
    await ui.loadTaskBoard();
    const again = card("recomplete")!.querySelector(".task-details") as HTMLDetailsElement;
    again.open = true; again.dispatchEvent(new Event("toggle"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(again.textContent, "the revision missed a changed result and reused cached prior work").toContain("Corrected completion result.");
    expect(again.textContent).not.toContain("First completion result.");
  });
});
