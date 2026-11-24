// @vitest-environment happy-dom
// Task cards (plan 2026-09-30-console-refresh-tasks.md §2 items 3 and 4). The board re-rendered every card on every
// 4 s poll, so an expanded card collapsed and lost its loaded history while someone was reading it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
type Ui = { renderTasks: (t: unknown[]) => void; setMe: (v: unknown) => void };
function loadConsole(fetchMock = vi.fn(async () => json(200, { events: [] }))): Ui {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${appJs}; return { renderTasks, setMe: (v) => { me = v; } };`)(
    window, document, window.localStorage, fetchMock) as Ui;
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
const task = (over: Record<string, unknown> = {}) => ({
  id: "t1", title: "Write the migration guide", status: "open", created_by_agent_name: "Grace", created_by_agent_id: "grace",
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
});
const card = (id: string) => document.querySelector(`.task[data-task-id="${id}"]`) as HTMLElement | null;
const details = (id: string) => card(id)?.querySelector(".task-details") as HTMLDetailsElement | null;

describe("keyed task render: a refresh keeps what the reader opened (item 3)", () => {
  it("an expanded card stays expanded, with its loaded history, across refreshes", async () => {
    const ui = loadConsole(vi.fn(async (url: string) => json(200, url.startsWith("/v1/events")
      ? { events: [{ seq: 1, type: "task.created", subject_id: "t1", actor_agent_name: "Grace", payload: "{}", created_at: new Date().toISOString() }] }
      : {})));
    ui.renderTasks([task(), task({ id: "t2", title: "Rotate the webhook secret" })]);
    details("t1")!.open = true;
    await vi.waitFor(() => expect(card("t1")!.querySelectorAll(".task-history-row").length).toBe(1));
    const before = card("t1");
    ui.renderTasks([task(), task({ id: "t2", title: "Rotate the webhook secret" })]);
    ui.renderTasks([task(), task({ id: "t2", title: "Rotate the webhook secret" })]);
    expect(details("t1")!.open).toBe(true);
    expect(card("t1")).toBe(before); // the same node: nothing reloads, nothing flickers
    expect(card("t1")!.querySelectorAll(".task-history-row").length).toBe(1);
    expect(details("t2")!.open).toBe(false);
  });

  it("a changed task's card updates, and stays open if it was open", () => {
    const ui = loadConsole();
    ui.renderTasks([task()]);
    details("t1")!.open = true;
    ui.renderTasks([task({ title: "Write the migration guide, with examples" })]);
    expect(card("t1")!.querySelector(".task-title")!.textContent).toBe("Write the migration guide, with examples");
    expect(details("t1")!.open).toBe(true);
  });

  it("a task that moves column is shown in its new column", () => {
    const ui = loadConsole();
    ui.renderTasks([task()]);
    ui.renderTasks([task({ status: "claimed", lease_active: true, claimed_by_agent_id: "codex", claimed_by_agent_name: "Codex", lease_expires_at: new Date(Date.now() + 60_000).toISOString() })]);
    const column = card("t1")!.closest(".column")!;
    expect(column.querySelector("h3")!.firstChild!.textContent).toBe("In progress");
    expect(document.querySelectorAll(".task").length).toBe(1);
  });

  it("a removed task's card goes", () => {
    const ui = loadConsole();
    ui.renderTasks([task(), task({ id: "t2", title: "Rotate the webhook secret" })]);
    details("t2")!.open = true;
    ui.renderTasks([task()]);
    expect(card("t2")).toBeNull();
    expect(document.querySelectorAll(".task").length).toBe(1);
  });
});

// Item 4. The hub refuses Complete and Release from anyone but the claimant, and Accept and Reject from the claimant,
// so the console offered buttons that could only fail with a toast. Each case below has the other viewer as control.
const buttons = (id: string) => [...(card(id)?.querySelectorAll(".task-actions button") ?? [])].map((b) => b.textContent);
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const claimedBy = (agentId: string, over: Record<string, unknown> = {}) =>
  task({ status: "claimed", lease_active: true, claimed_by_agent_id: agentId, claimed_by_agent_name: agentId === "me" ? "Ada" : "Codex", lease_expires_at: inAnHour(), ...over });
const doneBy = (agentId: string, over: Record<string, unknown> = {}) =>
  task({ status: "done", reviewed: 0, claimed_by_agent_id: agentId, claimed_by_agent_name: agentId === "me" ? "Ada" : "Codex", completed_at: new Date().toISOString(), ...over });

describe("a card opens from its title, a real button that says whether it is open", () => {
  it("the title is a <button> with aria-expanded, kept in step with the card however it is opened", async () => {
    const ui = loadConsole();
    ui.renderTasks([task()]);
    const title = card("t1")!.querySelector(".task-title") as HTMLButtonElement;
    expect(title.tagName).toBe("BUTTON");
    expect(title.type).toBe("button");
    expect(title.textContent).toBe("Write the migration guide");
    expect(title.getAttribute("aria-expanded")).toBe("false");
    expect(title.getAttribute("aria-controls")).toBe(details("t1")!.id);
    title.click();
    expect(details("t1")!.open).toBe(true);
    await vi.waitFor(() => expect(title.getAttribute("aria-expanded")).toBe("true"));
    title.click();
    expect(details("t1")!.open).toBe(false);
    await vi.waitFor(() => expect(title.getAttribute("aria-expanded")).toBe("false"));
    // Opened another way (a link to the task): the title still tells the truth.
    details("t1")!.open = true;
    details("t1")!.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(title.getAttribute("aria-expanded")).toBe("true"));
    // One tab stop for the toggle: the hidden summary is not a second, invisible one.
    expect(details("t1")!.querySelector("summary")!.getAttribute("tabindex")).toBe("-1");
  });
});
describe("task card buttons match what the hub allows this viewer (item 4)", () => {
  it("Complete and Release show only on the viewer's own claim", () => {
    const ui = loadConsole();
    ui.setMe({ agentId: "me" });
    ui.renderTasks([claimedBy("me"), claimedBy("codex", { id: "t2" })]);
    expect(buttons("t1")).toEqual(["Complete", "Release"]);
    expect(buttons("t2")).toEqual([]);
  });

  it("Accept and Reject never show for the task's claimant, and do for another viewer", () => {
    const ui = loadConsole();
    ui.setMe({ agentId: "me" });
    ui.renderTasks([doneBy("me"), doneBy("codex", { id: "t2" })]);
    expect(buttons("t1")).toEqual([]);
    expect(buttons("t2")).toEqual(["Accept", "Reject"]);
  });

  it("an expired claim names eligibility and offers this agent the Claim action", () => {
    const ui = loadConsole();
    ui.setMe({ agentId: "me" });
    ui.renderTasks([claimedBy("codex", { lease_active: false, lease_expires_at: daysAgo(0.01) })]);
    expect(card("t1")!.querySelector(".task-meta")!.textContent).toBe("claim by Codex expired · an eligible agent can claim it");
    expect(buttons("t1")).toEqual(["Claim"]);
  });
});

describe("superseded and stale badges (item 4)", () => {
  const badges = (id: string) => [...(card(id)?.querySelectorAll(".task-badge") ?? [])].map((b) => b.textContent);

  it("a superseded task says what replaced it and is greyed; a live one says nothing", () => {
    const ui = loadConsole();
    ui.renderTasks([
      task({ superseded: true, superseded_by: "t9", superseded_by_title: "Write the migration guide (v2)" }),
      task({ id: "t2", superseded: false, superseded_by: null, superseded_by_title: null }),
    ]);
    expect(badges("t1")).toEqual(["Replaced by Write the migration guide (v2)"]);
    expect(card("t1")!.classList.contains("is-superseded")).toBe(true);
    expect(badges("t2")).toEqual([]);
    expect(card("t2")!.classList.contains("is-superseded")).toBe(false);
  });

  it("a superseded task whose replacement this viewer cannot see still says it was replaced", () => {
    const ui = loadConsole();
    ui.renderTasks([task({ superseded: true, superseded_by: "t9", superseded_by_title: null })]);
    expect(badges("t1")).toEqual(["Replaced by a newer task"]);
  });

  it("a saved side request names the task it came from, with a way to open it only when that task is visible", () => {
    const ui = loadConsole();
    ui.renderTasks([
      task({ side_request_of: "t9", side_request_of_title: "Ship the footer" }),
      task({ id: "t2", side_request_of: "t8", side_request_of_title: null }),
    ]);
    const buttons = (id: string) => [...(card(id)?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
    expect(badges("t1")).toEqual(["Side request of Ship the footer"]);
    expect(buttons("t1")).toContain("Open the original task");
    expect(badges("t2")).toEqual(["Side request of another task"]);
    expect(buttons("t2")).not.toContain("Open the original task");
  });

  it("a task with no activity for 14 days or more says for how long; a quieter spell says nothing", () => {
    const ui = loadConsole();
    ui.renderTasks([
      task({ created_at: daysAgo(40), updated_at: daysAgo(20) }),
      task({ id: "t2", created_at: daysAgo(40), updated_at: daysAgo(13) }),
      claimedBy("codex", { id: "t3", created_at: daysAgo(40), updated_at: daysAgo(30), lease_active: false, lease_expires_at: daysAgo(29) }),
    ]);
    expect(badges("t1")).toEqual(["No activity for 20 days"]);
    expect(badges("t2")).toEqual([]);
    expect(badges("t3")).toEqual(["No activity for 30 days"]);
  });

  it("the latest of a task's timestamps counts, including SQLite's space-separated form", () => {
    const ui = loadConsole();
    const sqlite = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "");
    ui.renderTasks([doneBy("codex", { created_at: sqlite(daysAgo(60)), updated_at: sqlite(daysAgo(60)), completed_at: sqlite(daysAgo(2)) })]);
    expect(badges("t1")).toEqual([]);
  });

  it("finished work is not called stale: a done and accepted task, or a replaced one, gets no activity badge", () => {
    const ui = loadConsole();
    ui.renderTasks([
      doneBy("codex", { reviewed: 1, reviewed_by_agent_name: "Grace", created_at: daysAgo(60), updated_at: daysAgo(60), completed_at: daysAgo(60), reviewed_at: daysAgo(59) }),
      task({ id: "t2", created_at: daysAgo(60), updated_at: daysAgo(60), superseded: true, superseded_by: "t9", superseded_by_title: "Newer" }),
    ]);
    expect(badges("t1")).toEqual([]);
    expect(badges("t2")).toEqual(["Replaced by Newer"]);
  });
});

// Coordinator on item 4 (2026-09-30): a replaced task offers no Claim (presentation only: the hub still allows it), and
// when the viewer can see the newer task the card takes them to it.
describe("a replaced task points at the newer one instead of offering Claim", () => {
  const replaced = (over: Record<string, unknown> = {}) =>
    task({ superseded: true, superseded_by: "t9", superseded_by_title: "Write the migration guide (v2)", ...over });
  const newer = (over: Record<string, unknown> = {}) => task({ id: "t9", title: "Write the migration guide (v2)", ...over });

  it("has no Claim, and a live task beside it keeps its Claim", () => {
    const ui = loadConsole();
    ui.renderTasks([replaced(), newer()]);
    expect(buttons("t1")).toEqual(["Open the newer task"]);
    expect(buttons("t9")).toEqual(["Claim"]);
  });

  it("Open the newer task opens that card's details", () => {
    const ui = loadConsole();
    ui.renderTasks([replaced(), newer()]);
    (card("t1")!.querySelector(".task-actions button") as HTMLButtonElement).click();
    expect(details("t9")!.open).toBe(true);
    expect(card("t9")!.classList.contains("is-found")).toBe(true);
  });

  // Since tasks tranche 2 the board's pages and search are the hub's: a newer task on no loaded page is fetched and
  // pinned to its column (tests/console-task-paging.test.ts, "Open the newer task"). Here every task is loaded.
  it("clears a search that could hide the newer task, and opens it", () => {
    const ui = loadConsole();
    const filler = Array.from({ length: 25 }, (_, i) => task({ id: `f${i}`, title: `Filler ${i}` }));
    ui.renderTasks([replaced(), ...filler, newer()]);
    const search = document.getElementById("task-search") as HTMLInputElement;
    search.value = "Draft";
    search.dispatchEvent(new Event("input"));
    ui.renderTasks([replaced({ title: "Draft" }), ...filler, newer()]);
    (card("t1")!.querySelector(".task-actions button") as HTMLButtonElement).click();
    expect(search.value).toBe("");
    expect(card("t9")).not.toBeNull();
    expect(details("t9")!.open).toBe(true);
  });

  it("when the newer task is hidden from this viewer, there is no link and still no Claim", () => {
    const ui = loadConsole();
    ui.renderTasks([replaced({ superseded_by_title: null })]);
    expect(buttons("t1")).toEqual([]);
  });
});

// Codex on #655 at f065c4de (P2): the hub lets the current claimant complete or release after the lease expires, until
// someone takes the task over (src/tasks.ts completeTask/releaseTask match status 'claimed' and the claimant, not the
// lease). So the viewer's own expired claim keeps Complete and Release; a replaced task still offers no Claim.
describe("an expired claim still held by this viewer", () => {
  const expired = { lease_active: false, lease_expires_at: daysAgo(0.01) };

  it("keeps Complete and Release on a normal task", () => {
    const ui = loadConsole();
    ui.setMe({ agentId: "me" });
    ui.renderTasks([claimedBy("me", expired)]);
    expect(buttons("t1")).toEqual(expect.arrayContaining(["Complete", "Release"]));
  });

  it("keeps Complete and Release on a replaced task, without Claim", () => {
    const ui = loadConsole();
    ui.setMe({ agentId: "me" });
    ui.renderTasks([claimedBy("me", { ...expired, superseded: true, superseded_by: "t9", superseded_by_title: "Newer" }), task({ id: "t9", title: "Newer" })]);
    expect(buttons("t1")).toEqual(expect.arrayContaining(["Complete", "Release"]));
    expect(buttons("t1")).not.toContain("Claim");
  });

  it("someone else's expired claim offers neither Complete nor Release", () => {
    const ui = loadConsole();
    ui.setMe({ agentId: "me" });
    ui.renderTasks([claimedBy("codex", expired)]);
    expect(buttons("t1")).not.toContain("Complete");
    expect(buttons("t1")).not.toContain("Release");
  });
});
