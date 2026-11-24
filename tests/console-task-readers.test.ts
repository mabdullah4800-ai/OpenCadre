// @vitest-environment happy-dom
// Complete app/HTML controls for selected task readers; fake hub/timers, no native acceptance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const row = (id = "t1", revision = 1) => ({ id, revision, title: `Task ${id}`, status: "open", has_description: true,
  has_completion_summary: false, has_review_note: false, created_by_agent_name: "Grace", created_at: "2026-10-01 10:00:00" });
const event = (seq: number) => ({ seq, type: "task.created", subject_id: "t1", actor_agent_name: `Worker${seq}`, payload: "{}", created_at: "2026-10-01 10:00:00" });
class Socket {
  static instances: Socket[] = []; static OPEN = 1; static CONNECTING = 0;
  readyState = 1; onmessage?: () => void; onopen?: () => void; onclose?: () => void;
  constructor(public url: string) { Socket.instances.push(this); }
  close() { this.readyState = 3; }
}
function hub() {
  const state = { revision: 1, text: "Description one", events: [event(1)], detailStatus: 200, historyStatus: 200,
    detailRevision: null as number | null, removed: false, retention: null as unknown,
    hold: null as ReturnType<typeof deferred> | null, heldReader: "", heldBody: false, holdOnce: true, captured: false,
    historyPages: null as unknown[][] | null };
  const fetchMock = vi.fn(async (path: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    const url = new URL(path, "http://hub");
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "ws-a";
    if (path === "/v1/auth/me") return json(200, { person: { id: "p1", email: "ada@example.com" }, workspaces: [
      { orgId: "ws-a", role: "owner" }, { orgId: "ws-b", role: "owner" }] });
    const identity = { orgId: ws, orgName: ws, agentId: `person-${ws}`, agentName: "Ada", role: "operator", memberRole: "owner", workspace: { paused: false } };
    if (url.pathname === "/v1/tasks") return json(200, { tasks: url.searchParams.get("column") === "open" && !state.removed
      ? [row("t1", state.revision), row("t2")] : [], nextCursor: null, counts: { open: 2, expired: 0, in_progress: 0, needs_review: 0, done: 0 }, projects: [] });
    const reader = url.pathname === "/v1/tasks/t1" ? "detail" : url.pathname === "/v1/events" && url.searchParams.get("subjectId") === "t1" ? "history" : "";
    if (reader) {
      const body = reader === "detail" ? { task: { ...row("t1", state.detailRevision ?? state.revision), description: state.text } }
        : { events: state.historyPages ? (state.historyPages[Number(url.searchParams.get("after")) / 200] ?? []) : [...state.events],
          nextAfter: Number(url.searchParams.get("after")) + 200, ...(state.retention ? { retention: state.retention } : {}) };
      const status = reader === "detail" ? state.detailStatus : state.historyStatus;
      const response = json(status, status === 200 ? body : { error: "reader refused" });
      if (state.hold && state.heldReader === reader && (!state.holdOnce || !state.captured)) {
        state.captured = true; const held = state.hold;
        if (state.heldBody) return { ...response, json: async () => { await held.promise; return status === 200 ? body : { error: "reader refused" }; } };
        await held.promise;
      }
      return response;
    }
    if (url.pathname.startsWith("/v1/tasks/")) return json(200, { task: { ...row("t2"), description: "Sibling description" } });
    return json(200, hubReadBody(path, identity) ?? {});
  });
  return { state, fetchMock };
}
function load(fetchMock: ReturnType<typeof hub>["fetchMock"]) {
  const source = readFileSync(resolve("public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${source};return {enterWorkspace,refreshNow,schedulePoll,selectTab,signOut,
    stopPoll:()=>clearTimeout(pollTimer)};`)(window, document, localStorage, fetchMock) as {
      enterWorkspace: (id: string) => Promise<void>; refreshNow: () => Promise<void>; schedulePoll: () => void; selectTab: (name: string) => void; stopPoll: () => void; signOut: () => void };
}
const card = (id = "t1") => document.querySelector(`.task[data-task-id="${id}"]`) as HTMLElement;
const details = (id = "t1") => card(id).querySelector(".task-details") as HTMLDetailsElement;
const text = () => card().querySelector(".task-detail-text") as HTMLElement;
const history = () => card().querySelector(".task-history") as HTMLElement;
const advance = () => vi.advanceTimersByTimeAsync(20);
async function open(id = "t1") { details(id).open = true; details(id).dispatchEvent(new Event("toggle")); await advance(); }
async function close(id = "t1") { details(id).open = false; details(id).dispatchEvent(new Event("toggle")); await advance(); }
async function start() {
  const h = hub(); const c = load(h.fetchMock); await vi.advanceTimersByTimeAsync(0);
  await c.enterWorkspace("ws-a"); await vi.advanceTimersByTimeAsync(300); c.stopPoll();
  document.querySelector<HTMLButtonElement>('[data-tab="tasks"]')!.click(); await advance();
  h.fetchMock.mockClear(); return { ...h, c };
}
const count = (fetchMock: ReturnType<typeof hub>["fetchMock"], reader: string) => fetchMock.mock.calls.filter(([p]) => reader === "detail"
  ? p === "/v1/tasks/t1" : reader === "history" ? p.includes("subjectId=t1") : p.includes("column=open")).length;
beforeEach(() => {
  document.documentElement.innerHTML = readFileSync(resolve("public/app/index.html"), "utf8").replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "#/");
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket); vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("owned task readers through app navigation and refresh", () => {
  it("known positive: opens authorized detail/history, retains detail cache and leaves closed sibling unread", async () => {
    const { fetchMock, c } = await start(); await open();
    expect(text().textContent).toContain("Description one"); expect(history().textContent).toContain("Worker1");
    await close(); await open(); await c.refreshNow(); await advance();
    expect(count(fetchMock, "detail")).toBe(1);
    expect(fetchMock.mock.calls.some(([p]) => p.includes("subjectId=t2"))).toBe(false);
  });
  it.each(["detail", "history"])("bounds %s headers and releases loading for retry while sibling reader succeeds", async reader => {
    const { state, c } = await start(); state.hold = deferred(); state.heldReader = reader;
    await open(); expect(state.captured).toBe(true);
    await vi.advanceTimersByTimeAsync(15001);
    expect((reader === "detail" ? text() : history()).dataset.loading).toBeUndefined();
    expect((reader === "detail" ? history() : text()).textContent).toContain(reader === "detail" ? "Worker1" : "Description one");
    state.hold = null; await c.refreshNow(); await advance();
    expect((reader === "detail" ? text() : history()).textContent).toContain(reader === "detail" ? "Description one" : "Worker1");
  });
  it.each(["detail", "history"])("bounds %s JSON body and rejects late old body after a successful retry", async reader => {
    const { state, c } = await start(); const held = deferred(); state.hold = held; state.heldReader = reader; state.heldBody = true;
    await open(); await vi.advanceTimersByTimeAsync(15001);
    expect((reader === "detail" ? text() : history()).dataset.loading).toBeUndefined();
    state.hold = null; state.text = "Recovered description"; state.events = [event(2)];
    await c.refreshNow(); await advance(); held.resolve(); await advance();
    expect((reader === "detail" ? text() : history()).textContent).toContain(reader === "detail" ? "Recovered description" : "Worker2");
    expect((reader === "detail" ? text() : history()).textContent).not.toContain(reader === "detail" ? "Description one" : "Worker1");
  });
  it("normal socket hint reconciles unchanged open history and preserves node, focus and scroll", async () => {
    const { state, c } = await start(); await open(); const before = card(); const summary = details().querySelector("summary")!;
    summary.focus(); history().scrollTop = 17; state.events.push(event(2));
    Socket.instances.at(-1)!.onmessage?.(); await vi.advanceTimersByTimeAsync(300); c.stopPoll();
    expect(card()).toBe(before); expect(details().open).toBe(true); expect(history().textContent).toContain("Worker2");
    expect(document.activeElement).toBe(summary); expect(history().scrollTop).toBe(17);
  });
  it("the real four-second poll reconciles history on an unchanged open card", async () => {
    const { state, c } = await start(); await open(); const before = card(); state.events.push(event(2));
    c.schedulePoll(); await vi.advanceTimersByTimeAsync(4010); c.stopPoll();
    expect(card()).toBe(before); expect(details().open).toBe(true); expect(history().textContent).toContain("Worker2");
  });
  it("closed and background task cards do not routinely fetch history", async () => {
    const { fetchMock, c } = await start(); await c.refreshNow(); expect(count(fetchMock, "history")).toBe(0);
    await open(); c.selectTab("overview"); await advance(); const n = count(fetchMock, "history");
    await c.refreshNow(); await advance(); expect(count(fetchMock, "history")).toBe(n);
    c.selectTab("tasks"); await advance(); expect(count(fetchMock, "history")).toBeGreaterThan(n);
  });
  it.each(["detail", "history"])("closing cancels held %s and reopening starts an owned read immediately", async reader => {
    const { state, fetchMock } = await start(); const held = deferred(); state.hold = held; state.heldReader = reader;
    await open(); await close(); state.hold = null; state.text = "After close"; state.events = [event(2)]; await open();
    expect(count(fetchMock, reader)).toBe(2); held.resolve(); await advance();
    expect((reader === "detail" ? text() : history()).textContent).toContain(reader === "detail" ? "After close" : "Worker2");
  });
  it("old same-generation revision cannot poison detail cache or revived card", async () => {
    const { state, fetchMock, c } = await start(); const held = deferred(); state.hold = held; state.heldReader = "detail";
    await open(); state.hold = null; state.revision = 2; state.text = "Revision two";
    await c.refreshNow(); await advance(); expect(text().textContent).toContain("Revision two");
    const n = count(fetchMock, "detail"); held.resolve(); await advance(); await close(); await open();
    expect(text().textContent).toContain("Revision two"); expect(count(fetchMock, "detail")).toBe(n);
  });
  it("newer detail revision requests one coalesced board refresh per stale summary revision", async () => {
    const { state, fetchMock, c } = await start(); state.detailRevision = 2; await open(); await vi.advanceTimersByTimeAsync(1100); c.stopPoll();
    const n = count(fetchMock, "board"); expect(n).toBe(1); expect(text().textContent).not.toContain("Description one");
    await close(); await open(); await vi.advanceTimersByTimeAsync(1100); c.stopPoll(); expect(count(fetchMock, "board")).toBe(n);
  });
  it("history-only403 clears history while authorized task detail and controls remain", async () => {
    const { state, c } = await start(); await open(); state.historyStatus = 403; await c.refreshNow(); await advance();
    expect(history().textContent).not.toContain("Worker1"); expect(history().textContent).toContain("Couldn't load");
    expect(text().textContent).toContain("Description one"); expect(card().querySelector(".task-actions")?.textContent).toContain("Claim");
  });
  it("current detail404 clears subject history and old protected text without signing out", async () => {
    const { state, c } = await start(); await open(); state.detailStatus = 404; state.revision = 2;
    await c.refreshNow(); await advance(); expect(text().textContent).not.toContain("Description one"); expect(history().textContent).not.toContain("Worker1");
    expect(document.getElementById("console")!.hidden).toBe(false);
  });
  it.each(["detail", "history"])("workspace switch releases old %s and ignores its late refusal", async reader => {
    const { state, c } = await start(); const held = deferred(); state.hold = held; state.heldReader = reader;
    if (reader === "detail") state.detailStatus = 404; else state.historyStatus = 403;
    await open(); state.hold = null; state.detailStatus = 200; state.historyStatus = 200; state.text = "New workspace"; state.events = [event(2)];
    await c.enterWorkspace("ws-b"); await vi.advanceTimersByTimeAsync(300); c.stopPoll(); c.selectTab("tasks"); await open();
    held.resolve(); await advance(); expect(text().textContent).toContain("New workspace"); expect(history().textContent).toContain("Worker2");
    expect(document.getElementById("console")!.hidden).toBe(false);
  });
  it("one history flight coalesces repeated board refreshes into one follow-up", async () => {
    const { state, fetchMock, c } = await start(); state.hold = deferred(); state.heldReader = "history"; await open();
    await Promise.all([c.refreshNow(), c.refreshNow()]); await advance(); expect(count(fetchMock, "history")).toBe(1);
    state.hold.resolve(); state.hold = null; await advance(); expect(count(fetchMock, "history")).toBe(2);
  });
  it("a replaced open card withdraws old same-generation history before its late success", async () => {
    const { state, c } = await start(); const held = deferred(); state.hold = held; state.heldReader = "history";
    await open(); const old = history(); state.hold = null; state.revision = 2; state.events = [event(2)];
    await c.refreshNow(); await advance(); expect(history().textContent).toContain("Worker2");
    held.resolve(); await advance(); expect(old.dataset.loading).toBeUndefined();
    expect(old.textContent).not.toContain("Worker1"); expect(history().textContent).toContain("Worker2");
  });
  it.each(["detail", "history"])("removal withdraws %s loading and late cache/paint", async reader => {
    const { state, c } = await start(); const held = deferred(); state.hold = held; state.heldReader = reader;
    await open(); const old = reader === "detail" ? text() : history(); state.removed = true; await c.refreshNow(); await advance();
    expect(card()).toBeNull(); expect(old.dataset.loading).toBeUndefined(); held.resolve(); await advance();
    expect(old.textContent).not.toContain(reader === "detail" ? "Description one" : "Worker1");
    state.removed = false; state.hold = null; state.revision = 2; state.text = "Returned subject"; await c.refreshNow(); await open();
    expect(text().textContent).toContain("Returned subject");
  });
  it("revision replacement retains summary focus and does not issue background scrollIntoView", async () => {
    const { state, c } = await start(); await open(); details().querySelector("summary")!.focus();
    const scrolling = vi.fn(); const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrolling;
    try {
      state.revision = 2; await c.refreshNow(); await advance(); expect(details().open).toBe(true);
      expect(document.activeElement).toBe(details().querySelector("summary")); expect(scrolling).not.toHaveBeenCalled();
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
  it("empty retained history uses retention wording without treating subject as deleted", async () => {
    const { state, c } = await start(); await open(); state.events = []; state.retention = { days: 30 };
    await c.refreshNow(); await advance(); expect(history().textContent).toContain("Nothing in the history your plan keeps.");
    expect(text().textContent).toContain("Description one"); expect(card().querySelector(".task-actions")?.textContent).toContain("Claim");
  });
  it("background revision replacement never starts task readers until Tasks returns", async () => {
    const { state, fetchMock, c } = await start(); await open(); c.selectTab("overview"); await advance();
    const n = count(fetchMock, "history"); const d = count(fetchMock, "detail"); state.revision = 2; state.text = "Background revision";
    await c.refreshNow(); await advance(); expect(count(fetchMock, "history")).toBe(n); expect(count(fetchMock, "detail")).toBe(d);
    c.selectTab("tasks"); await advance(); expect(text().textContent).toContain("Background revision");
  });
  it("history traversal shares a total deadline across pages and retains complete previous rows on transient failure", async () => {
    const { state, fetchMock, c } = await start(); await open();
    const original = fetchMock.getMockImplementation()!; const second = deferred();
    fetchMock.mockImplementation(async (p, init) => {
      if (p.includes("subjectId=t1") && p.includes("after=0")) { await new Promise(r => setTimeout(r, 10000)); return json(200, { events: Array.from({ length: 200 }, (_, i) => event(i + 1)), nextAfter: 200 }); }
      if (p.includes("subjectId=t1") && p.includes("after=200")) { await second.promise; return json(200, { events: [event(201)] }); }
      return original(p, init);
    });
    await c.refreshNow(); await vi.advanceTimersByTimeAsync(15001);
    expect(history().dataset.loading).toBeUndefined(); expect(history().textContent).toContain("Worker1");
    expect(history().textContent).not.toContain("Worker200"); expect(history().textContent).toContain("Couldn't load");
    state.events = [event(2)]; fetchMock.mockImplementation(original); await c.refreshNow(); await advance(); expect(history().textContent).toContain("Worker2");
  });
});
