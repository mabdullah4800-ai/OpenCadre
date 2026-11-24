// @vitest-environment happy-dom
// Tasks (docs/design/CONSOLE-V2.md V7, F6). A task showed only its title before Claim / Complete / Accept
// (Codex-OpenCadre-f46c's finding 7), and the console could only create a task with a title although the hub takes a
// description. Red on the console before it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
function loadConsole(fetchMock = vi.fn(async () => json(200, {}))) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${appJs}; return { renderTasks };`)(
    window, document, window.localStorage, fetchMock) as { renderTasks: (t: unknown[]) => void };
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
const open = (over: Record<string, unknown> = {}) => ({ id: "t1", title: "Write the migration guide", status: "open", created_by_agent_name: "Grace", created_at: new Date().toISOString(), ...over });

describe("a task says what it asks for before anyone claims it", () => {
  it("an expired claim still names eligibility and preserves the claim action and requirements", () => {
    loadConsole().renderTasks([open({
      status: "claimed", lease_active: false, claimed_by_agent_name: "Cursor-Editor",
      lease_expires_at: new Date(Date.now() - 60000).toISOString(),
      required_capabilities_list: ["shell", "git-write"],
    })]);
    const card = document.querySelector(".task")!;
    expect(card.textContent).toContain("expired");
    expect(card.textContent).toMatch(/eligible agent can claim/);
    expect(card.textContent).not.toMatch(/anyone can take/);
    expect(card.querySelector(".task-details")?.textContent).toContain("shell, git-write");
    expect([...card.querySelectorAll("button")].some((b) => b.textContent === "Claim")).toBe(true);
  });
  it("shows the description, project, reviews needed and required abilities, before the actions", () => {
    loadConsole().renderTasks([open({
      description: "Cover every flag.\nDone when the guide builds.", project_key: "github.com/acme/api",
      required_reviews: 2, review_count: 1, required_capabilities_list: ["shell", "git-write"],
    })]);
    const card = document.querySelector(".task")!;
    const details = card.querySelector(".task-details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.querySelector(".task-description")?.textContent).toBe("Cover every flag.\nDone when the guide builds.");
    expect(details.textContent).toContain("Projectapi");
    expect(details.textContent).toContain("Reviews1 of 2 accepts");
    expect(details.textContent).toContain("shell, git-write");
    // Read before acting: the details come before the buttons.
    const kids = [...card.children];
    expect(kids.indexOf(details)).toBeLessThan(kids.indexOf(card.querySelector(".task-actions")!));
  });

  it("a task sent back says why", () => {
    loadConsole().renderTasks([open({ status: "claimed", lease_active: true, claimed_by_agent_name: "Codex", lease_expires_at: new Date(Date.now() + 60000).toISOString(), review_note: "tests missing" })]);
    expect(document.querySelector(".task-details")?.textContent).toContain("Sent back becausetests missing");
  });

  it("a bare task still has its history behind the toggle, and nothing else", () => {
    loadConsole().renderTasks([open()]);
    const details = document.querySelector(".task-details")!;
    expect(details.querySelector(".task-description")).toBeNull();
    expect(details.querySelector(".task-fact")).toBeNull();
    expect(details.querySelector(".task-history")).toBeTruthy();
  });

  it("columns say their name and count in sentence case", () => {
    loadConsole().renderTasks([open()]);
    const h3 = document.querySelector(".column h3")!;
    expect(h3.firstChild?.textContent).toBe("Open");
    expect(h3.querySelector(".column-count")?.textContent).toBe("1");
  });
});

describe("a task can be created with a description (F6)", () => {
  it("sends the description when one is written, and only the title when not", async () => {
    const fetchMock = vi.fn(async () => json(201, { task: {} }));
    loadConsole(fetchMock);
    ($("task-title") as HTMLInputElement).value = "Rotate the webhook secret";
    ($("task-description") as HTMLTextAreaElement).value = "Old one leaked in a log.";
    $("task-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === "/v1/tasks" && (i as { method?: string })?.method === "POST")).toBe(true));
    const post = () => (fetchMock.mock.calls as unknown as Array<[string, { body: string }]>).filter(([u, i]) => u === "/v1/tasks" && (i as unknown as { method?: string })?.method === "POST").pop()!;
    expect(JSON.parse(post()[1].body)).toEqual({ title: "Rotate the webhook secret", description: "Old one leaked in a log." });
    // After a successful add the description is cleared, so the next task starts empty.
    await vi.waitFor(() => expect(($("task-description") as HTMLTextAreaElement).value).toBe(""));
    ($("task-title") as HTMLInputElement).value = "Second";
    $("task-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(JSON.parse(post()[1].body)).toEqual({ title: "Second" }));
  });
});

// Codex-OpenCadre-f46c on ecdd301: F6 is full create (project, reviews), and V7 includes the task history.
describe("full create and history (f46c on ecdd301)", () => {
  it("creating a task can set its project and how many reviews it needs", async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => json(url === "/v1/tasks" && opts?.method === "POST" ? 201 : 200, { task: {} }));
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const ui = new Function("window", "document", "localStorage", "fetch", `${appJs}; return { renderProjectsSection, setMe: (value) => { me = value; } };`)(
      window, document, window.localStorage, fetchMock) as { renderProjectsSection: (d: unknown, sourceKind?: string) => void; setMe: (value: unknown) => void };
    ui.setMe({ role: "operator" });
    ui.renderProjectsSection({ projects: [
      { projectKey: "github.com/acme/api", name: "api", enabled: true },
      { projectKey: "github.com/acme/old", name: "old", enabled: false },
    ] });
    const options = [...($("task-project") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["", "github.com/acme/api"]);
    ($("task-title") as HTMLInputElement).value = "Ship it";
    ($("task-project") as HTMLSelectElement).value = "github.com/acme/api";
    ($("task-reviews") as HTMLSelectElement).value = "2";
    $("task-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    const post = fetchMock.mock.calls.find(([url, opts]) => url === "/v1/tasks" && opts?.method === "POST");
    expect(JSON.parse(post![1]!.body!)).toEqual({ title: "Ship it", project: "github.com/acme/api", requiredReviews: 2 });
  });

  it.each(["member", "refused"])("withdraws operator project choices for a %s response", (condition) => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const ui = new Function("window", "document", "localStorage", "fetch", `${appJs}; return { renderProjectsSection, setMe: (value) => { me = value; } };`)(
      window, document, window.localStorage, vi.fn(async () => json(200, {}))) as { renderProjectsSection: (d: unknown, sourceKind?: string) => void; setMe: (value: unknown) => void };
    const data = { projects: [{ projectKey: "github.com/acme/api", name: "api", enabled: true }] };
    ui.setMe({ role: "operator" });
    ui.renderProjectsSection(data, "ok");
    expect([...($("task-project") as HTMLSelectElement).options].map((option) => option.value)).toEqual(["", "github.com/acme/api"]);
    if (condition === "member") ui.setMe({ role: "member" });
    ui.renderProjectsSection(data, condition === "refused" ? "forbidden" : "ok");
    expect([...($("task-project") as HTMLSelectElement).options].map((option) => option.value)).toEqual([""]);
  });

  it("opening a task's details asks the hub for that task's events, from its start, and shows them in order", async () => {
    const events = [
      { seq: 3, type: "task.created", subject_id: "t1", actor_agent_name: "Grace", payload: JSON.stringify({ title: "Write the migration guide" }), created_at: new Date().toISOString() },
      { seq: 9, type: "task.claimed", subject_id: "t1", actor_agent_name: "Codex-api", payload: JSON.stringify({ title: "Write the migration guide" }), created_at: new Date().toISOString() },
    ];
    const fetchMock = vi.fn(async (url: string) => json(200, url.startsWith("/v1/events") ? { events, nextAfter: 9 } : {}));
    loadConsole(fetchMock).renderTasks([open()]);
    const details = document.querySelector(".task-details") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await new Promise((r) => setTimeout(r, 0));
    const rows = [...details.querySelectorAll(".task-history-row")].map((r) => r.firstChild?.textContent ?? "");
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain("Grace");
    expect(rows[1]).toContain("Codex-api");
    const url = String(fetchMock.mock.calls.find(([u]) => String(u).startsWith("/v1/events"))![0]);
    expect(url).toContain("subjectType=task&subjectId=t1");
    expect(url).toContain("latest=false");
    expect(url).toContain("after=0");
  });

  // Codex-OpenCadre-f46c on 492aa5e: the hub caps a page at 200, so a history longer than one page must be paged.
  it("a history longer than one page is read page by page, with after", async () => {
    const make = (seq: number) => ({ seq, type: "task.review_recorded", subject_id: "t1", actor_agent_name: "Reviewer", payload: "{}", created_at: new Date().toISOString() });
    const pages = [Array.from({ length: 200 }, (_, i) => make(i + 1)), [make(201), make(202), make(203)]];
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.startsWith("/v1/events")) return json(200, {});
      const page = pages.shift() ?? [];
      return json(200, { events: page, nextAfter: page.at(-1)?.seq ?? 0 });
    });
    loadConsole(fetchMock).renderTasks([open()]);
    const details = document.querySelector(".task-details") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(details.querySelectorAll(".task-history-row").length).toBe(203));
    const eventCalls = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/v1/events"));
    expect(eventCalls.length).toBe(2);
    expect(eventCalls[1]).toContain("after=200");
  });
  // Codex-OpenCadre-f46c on 70dc022: past the cap the page must not promise a fuller history somewhere else.
  it("past five full pages it says it shows the first events for this task, and nothing more", async () => {
    let seq = 0;
    const page = () => Array.from({ length: 200 }, () => ({ seq: ++seq, type: "task.review_recorded", subject_id: "t1", actor_agent_name: "R", payload: "{}", created_at: new Date().toISOString() }));
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.startsWith("/v1/events")) return json(200, {});
      const events = page();
      return json(200, { events, nextAfter: events.at(-1)!.seq });
    });
    loadConsole(fetchMock).renderTasks([open()]);
    const details = document.querySelector(".task-details") as HTMLDetailsElement;
    details.open = true;
    await vi.waitFor(() => expect(details.querySelectorAll(".task-history-row").length).toBe(1000));
    const note = [...details.querySelectorAll(".task-history p.muted")].map((p) => p.textContent).join(" ");
    expect(note).toContain("Showing the first 1000 events for this task.");
    expect(note).not.toMatch(/Activity|full history/i);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/v1/events")).length).toBe(5);
  });
});
