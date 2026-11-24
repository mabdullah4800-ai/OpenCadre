// @vitest-environment happy-dom
// Whole-console controls for independently bounded core refresh domains. These deliberately use the production app.js
// coordinator and DOM; each held read leaves the normal fetch path alive for its sibling domains.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const $ = (id: string) => document.getElementById(id) as HTMLElement;

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() { this.readyState = 3; }
}

type Message = Record<string, unknown>;
function makeHub() {
  const state = {
    agents: [] as Message[], tasks: [] as Message[], messages: [] as Message[], events: [] as Message[], approvals: [] as Message[],
    awareness: { items: [], background: {}, cursor: 0 } as Record<string, unknown>,
    fail: new Map<string, number>(), holdFetch: new Map<string, Deferred>(), holdBody: new Map<string, Deferred<unknown>>(),
    authWorkspaces: ["ws-a", "ws-b"], authNetworkFailure: false, identityStatus: 200, calls: [] as string[],
    requests: [] as Array<{ path: string; signal?: AbortSignal }>,
  };
  const matches = (path: string, key: string) => key === "board"
    ? path.startsWith("/v1/tasks?") && path.includes("column=")
    : path.split("?")[0] === key;
  const fetchMock = vi.fn(async (path: string, init?: { headers?: Record<string, string>; method?: string; signal?: AbortSignal }) => {
    state.calls.push(path);
    state.requests.push({ path, signal: init?.signal });
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "";
    const gate = [...state.holdFetch.entries()].find(([key]) => matches(path, key));
    if (gate) await gate[1].promise; // intentionally ignores AbortSignal
    if (path === "/v1/auth/me" && state.authNetworkFailure) throw new TypeError("Controlled person recheck network failure");
    if (path === "/v1/auth/me") return json(200, { person: { id: "person-a", name: "Pat", email: "pat@example.test" }, workspaces: state.authWorkspaces.map((orgId) => ({ orgId, name: orgId, role: "owner" })) });
    const status = state.fail.get(path.split("?")[0]);
    if (status) return json(status, { error: "fixture response" });
    let body: unknown;
    if (path === "/v1/me") return state.identityStatus === 200
      ? json(200, { orgId: ws, orgName: ws, agentId: `operator-${ws}`, agentName: "Pat", role: "operator", memberRole: "owner", workspace: { paused: false } })
      : json(state.identityStatus, { error: "fixture identity refusal" });
    else if (path === "/v1/agents") body = { agents: state.agents };
    else if (path.startsWith("/v1/approvals")) body = { approvals: state.approvals };
    else if (path === "/v1/approval-grants") body = { grants: [] };
    else if (path.startsWith("/v1/tasks?") && path.includes("limit=0")) body = { counts: { open: state.tasks.length, expired: 0, in_progress: 0, needs_review: 0, done: 0 } };
    else if (path.startsWith("/v1/tasks?") && path.includes("column=")) {
      const column = new URLSearchParams(path.split("?")[1]).get("column");
      body = { tasks: column === "open" ? state.tasks : [], counts: { open: state.tasks.length, expired: 0, in_progress: 0, needs_review: 0, done: 0 }, nextCursor: null, projects: [] };
    } else if (path.startsWith("/v1/tasks/")) body = { task: null };
    else if (path.startsWith("/v1/events")) body = { events: state.events };
    else if (path === "/v1/awareness") body = state.awareness;
    else if (path.startsWith("/v1/messages")) body = { messages: state.messages };
    else if (path === "/v1/org/devices") body = { devices: [] };
    else if (path.startsWith("/v1/org/sessions")) body = { sessions: [] };
    else if (path === "/v1/org/projects") body = { projects: [] };
    else if (path === "/v1/reliability/all") body = { reliability: [] };
    else if (path === "/v1/onboarding") body = { completed: 1, total: 1, steps: [] };
    else body = {};
    const bodyGate = [...state.holdBody.entries()].find(([key]) => matches(path, key));
    return bodyGate ? { ...json(200, body), json: () => bodyGate[1].promise } : json(200, body);
  });
  return { state, fetchMock };
}

type Console = {
  enterWorkspace: (orgId: string) => Promise<void>;
  refreshNow: () => Promise<void>;
  selectTab: (name: string) => void;
  stopPoll: () => void;
  swap: (name: string, fn: unknown) => unknown;
  state: () => { homeSources: Record<string, { status: string; data: any; lastOkAt: number }>; consoleGeneration: number; me: unknown; currentWorkspace: string | null; authMode: string };
};
function loadConsole(fetchMock: ReturnType<typeof makeHub>["fetchMock"]): Console {
  const source = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${source}; return { enterWorkspace, refreshNow, selectTab, stopPoll: () => clearTimeout(pollTimer),
      swap: (name, fn) => { const old = eval(name); eval(name + " = fn"); return old; },
      state: () => ({ homeSources, consoleGeneration, me, currentWorkspace, authMode }) };`,
  )(window, document, window.localStorage, fetchMock) as Console;
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  window.localStorage.clear();
  window.sessionStorage.clear();
  history.replaceState(null, "", "/app/");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function signedIn() {
  const hub = makeHub();
  hub.state.tasks = [{ id: "task-a", title: "Initial board task", status: "open", created_by_agent_name: "Worker", created_at: new Date().toISOString() }];
  const c = loadConsole(hub.fetchMock);
  await vi.advanceTimersByTimeAsync(0);
  await c.enterWorkspace("ws-a");
  await vi.advanceTimersByTimeAsync(300);
  c.stopPoll();
  hub.state.calls.length = 0;
  return { ...hub, c };
}
const count = (calls: string[], prefix: string) => calls.filter((path) => path.startsWith(prefix)).length;
const boardText = () => $("tasks").textContent ?? "";

describe("core refresh domain isolation", () => {
  it("shows a first mail failure as unavailable, recovers, and preserves later failed mail with its applied age", async () => {
    const { state, fetchMock } = makeHub();
    state.fail.set("/v1/messages", 503);
    const c = loadConsole(fetchMock);
    await vi.advanceTimersByTimeAsync(0);
    await c.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(300);
    c.stopPoll();
    expect(c.state().homeSources.messages).toMatchObject({ status: "failed", data: null, lastOkAt: 0 });
    expect($("inbox-list").textContent).toContain("Couldn't load your inbox");
    expect($("inbox-list").textContent).toContain("Retrying automatically.");
    expect($("inbox-list").querySelector(".skeleton")).toBeNull();

    state.fail.delete("/v1/messages");
    state.messages = [{ id: "mail-recovered", thread_id: "thread-recovered", kind: "message", from_agent_id: "worker", from_agent_name: "Worker", body: "Recovered authorized mail", created_at: new Date().toISOString(), read_at: null }];
    await c.refreshNow();
    expect($("inbox-list").textContent).toContain("Recovered authorized mail");
    const appliedAt = c.state().homeSources.messages.lastOkAt;
    state.fail.set("/v1/messages", 503);
    await c.refreshNow();
    expect(c.state().homeSources.messages).toMatchObject({ status: "failed", lastOkAt: appliedAt });
    expect($("inbox-list").textContent).toContain("Recovered authorized mail");
    expect($("inbox-list").textContent).not.toContain("Couldn't load your inbox");
  });

  it("applies healthy roster, mail, activity and digest while the complete task board is held", async () => {
    const { state, fetchMock, c } = await signedIn();
    const previousMessagesAppliedAt = c.state().homeSources.messages.lastOkAt;
    await vi.advanceTimersByTimeAsync(25);
    state.agents = [{ id: "worker-new", name: "Worker New", role: "builder", kind: "named", key_class: "agent", online: true, status: "active", editing_files_parsed: [] }];
    state.messages = [{ id: "message-new", thread_id: "thread-new", kind: "message", from_agent_id: "worker-new", from_agent_name: "Worker New", body: "Independent inbox answer", created_at: new Date().toISOString(), read_at: null }];
    state.events = [{ id: "event-new", seq: 42, type: "task.created", actor_agent_id: "worker-new", actor_agent_name: "Worker New", payload: {}, created_at: new Date().toISOString() }];
    state.awareness = { items: [], background: { "task.created": 2 }, cursor: 42 };
    state.tasks = [{ id: "task-new", title: "New board task", status: "open", created_by_agent_name: "Worker New", created_at: new Date().toISOString() }];
    const held = deferred();
    state.holdFetch.set("board", held);

    const flight = c.refreshNow();
    await flush();
    expect($("fleet-count").textContent).toBe("1 of 1 agents online");
    expect($("inbox-list").textContent).toContain("Independent inbox answer");
    expect($("timeline").textContent).toContain("created");
    expect($("awareness-summary").textContent).toContain("2 tasks created");
    expect(c.state().homeSources.messages.lastOkAt).toBeGreaterThan(previousMessagesAppliedAt);
    expect(boardText()).toContain("Initial board task");
    expect(boardText()).not.toContain("New board task");

    state.holdFetch.delete("board");
    held.resolve();
    await flight;
    expect(boardText()).toContain("New board task");
    expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith("/v1/tasks?"))).toBe(true);
  });

  it("does not publish sibling-domain results before current /me validates the workspace", async () => {
    const { state, c } = await signedIn();
    const beforeFleet = $("fleet-count").textContent;
    const beforeSubtitle = $("overview-subtitle").textContent;
    state.agents = [{ id: "worker-private", name: "Private Worker", role: "builder", kind: "named", key_class: "agent", online: true, status: "active", editing_files_parsed: [] }];
    state.approvals = [{ id: "approval-gated", action: "Controlled gated action", risk: "high", category: "shell", requested_by_agent_name: "Worker", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() }];
    const held = deferred();
    state.holdFetch.set("/v1/me", held);
    const flight = c.refreshNow();
    await flush();
    expect($("fleet-count").textContent).toBe(beforeFleet);
    expect($("overview-subtitle").textContent).toBe(beforeSubtitle);
    expect($("clearances").textContent).not.toContain("Controlled gated action");
    state.holdFetch.delete("/v1/me");
    held.resolve();
    await flight;
    expect($("fleet-count").textContent).toBe("1 of 1 agents online");
    expect($("clearances").textContent).toContain("Controlled gated action");
  });

  it("keeps task and mail domains moving while a roster response body ignores cancellation and remains pending", async () => {
    const { state, c } = await signedIn();
    const body = deferred<unknown>();
    state.holdBody.set("/v1/agents", body);
    state.tasks = [{ id: "task-independent", title: "Board survived roster wait", status: "open", created_by_agent_name: "Worker", created_at: new Date().toISOString() }];
    state.messages = [{ id: "message-independent", thread_id: "thread-independent", kind: "message", from_agent_id: "worker", from_agent_name: "Worker", body: "Mail survived roster wait", created_at: new Date().toISOString(), read_at: null }];

    const flight = c.refreshNow();
    await flush();
    expect(boardText()).toContain("Board survived roster wait");
    expect($("inbox-list").textContent).toContain("Mail survived roster wait");
    expect($("fleet-count").textContent).toBe("0 of 0 agents online");
    state.holdBody.delete("/v1/agents");
    body.resolve({ agents: [{ id: "worker", name: "Worker", role: "builder", kind: "named", key_class: "agent", online: true, status: "active", editing_files_parsed: [] }] });
    await flight;
    expect($("fleet-count").textContent).toBe("1 of 1 agents online");
  });

  it("times out only the held roster body, preserves its old applied value, then recovers without late paint", async () => {
    const { state, c } = await signedIn();
    const lastApplied = c.state().homeSources.messages.lastOkAt;
    const body = deferred<unknown>();
    state.holdBody.set("/v1/agents", body);
    state.tasks = [{ id: "task-after-timeout", title: "Task survives roster timeout", status: "open", created_by_agent_name: "Worker", created_at: new Date().toISOString() }];
    state.messages = [{ id: "message-after-timeout", thread_id: "thread-after-timeout", kind: "message", from_agent_id: "worker", from_agent_name: "Worker", body: "Mail survives roster timeout", created_at: new Date().toISOString(), read_at: null }];

    const flight = c.refreshNow();
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    await flight;
    expect(boardText()).toContain("Task survives roster timeout");
    expect($("inbox-list").textContent).toContain("Mail survives roster timeout");
    expect(c.state().homeSources.messages.lastOkAt).toBeGreaterThan(lastApplied);
    expect($("fleet-count").textContent).toBe("0 of 0 agents online");
    expect(state.requests.filter((request) => request.path === "/v1/agents").at(-1)?.signal?.aborted).toBe(true);

    state.holdBody.delete("/v1/agents");
    body.resolve({ agents: [{ id: "worker-late", name: "Late Worker", role: "builder", kind: "named", key_class: "agent", online: true, status: "active", editing_files_parsed: [] }] });
    await flush();
    expect($("fleet-count").textContent).toBe("0 of 0 agents online");
    state.agents = [{ id: "worker-recovered", name: "Recovered Worker", role: "builder", kind: "named", key_class: "agent", online: true, status: "active", editing_files_parsed: [] }];
    await c.refreshNow();
    expect($("fleet-count").textContent).toBe("1 of 1 agents online");
    expect($("fleet-count").textContent).not.toContain("Late Worker");
  });

  it("preserves a consumed selected message body and reply draft while a new message snapshot applies", async () => {
    const { state, c } = await signedIn();
    const consumed = { id: "message-consumed", thread_id: "thread-consumed", kind: "question", from_agent_id: "worker", from_agent_name: "Worker", body: "The selected body remains readable", created_at: new Date().toISOString(), read_at: null };
    state.messages = [consumed];
    await c.refreshNow();
    c.selectTab("inbox");
    const row = document.querySelector("#inbox-list .inbox-message") as HTMLElement;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush(); // openMessage consumes it; the selected copy remains until the person closes it
    const reply = row.querySelectorAll("button")[1] as HTMLButtonElement;
    reply.click();
    const textarea = document.querySelector("#inbox-list textarea") as HTMLTextAreaElement;
    textarea.value = "Unsent answer stays in the draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    state.messages = [{ id: "message-next", thread_id: "thread-next", kind: "message", from_agent_id: "worker-2", from_agent_name: "Worker Two", body: "A new inbox row arrives", created_at: new Date(Date.now() + 1000).toISOString(), read_at: null }];
    const held = deferred();
    state.holdFetch.set("board", held);
    const flight = c.refreshNow();
    await flush();
    expect($("inbox-list").textContent).toContain("The selected body remains readable");
    expect((document.querySelector("#inbox-list textarea") as HTMLTextAreaElement).value).toBe("Unsent answer stays in the draft");
    expect($("inbox-list").textContent).toContain("A new inbox row arrives");
    state.holdFetch.delete("board");
    held.resolve();
    await flight;
  });

  it("keeps the one-flight plus one-follow-up scheduler while sibling domains apply", async () => {
    const { state, fetchMock, c } = await signedIn();
    const held = deferred();
    state.holdFetch.set("board", held);
    state.agents = [{ id: "worker-during-flight", name: "Worker During Flight", role: "builder", kind: "named", key_class: "agent", online: true, status: "active", editing_files_parsed: [] }];
    const flight = c.refreshNow();
    await flush();
    const firstBoardReads = count(state.calls, "/v1/tasks?");
    c.refreshNow();
    c.refreshNow();
    c.refreshNow();
    await flush();
    expect(count(state.calls, "/v1/tasks?")).toBe(firstBoardReads);
    expect($("fleet-count").textContent).toBe("1 of 1 agents online");
    state.holdFetch.delete("board");
    held.resolve();
    await flight;
    expect(count(state.calls, "/v1/tasks?")).toBe(firstBoardReads * 2);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("isolates a roster renderer failure so complete task and mail snapshots still apply", async () => {
    const { state, c } = await signedIn();
    const previousRosterAppliedAt = c.state().homeSources.roster.lastOkAt;
    const previousMessagesAppliedAt = c.state().homeSources.messages.lastOkAt;
    await vi.advanceTimersByTimeAsync(25);
    state.tasks = [{ id: "task-render-isolation", title: "Task after roster paint error", status: "open", created_by_agent_name: "Worker", created_at: new Date().toISOString() }];
    state.messages = [{ id: "message-render-isolation", thread_id: "thread-render-isolation", kind: "message", from_agent_id: "worker", from_agent_name: "Worker", body: "Mail after roster paint error", created_at: new Date().toISOString(), read_at: null }];
    const original = c.swap("renderOtherAgents", () => { throw new TypeError("controlled roster renderer failure"); });
    try {
      await c.refreshNow();
      expect(boardText()).toContain("Task after roster paint error");
      expect($("inbox-list").textContent).toContain("Mail after roster paint error");
      expect(c.state().homeSources.roster.lastOkAt).toBe(previousRosterAppliedAt);
      expect(c.state().homeSources.messages.lastOkAt).toBeGreaterThan(previousMessagesAppliedAt);
    } finally { c.swap("renderOtherAgents", original); }
  });

  it("retains the last consistent board when one board column fails while roster and mail succeed", async () => {
    const { state, fetchMock, c } = await signedIn();
    state.tasks = [{ id: "task-partial", title: "Must not publish partial board", status: "open", created_by_agent_name: "Worker", created_at: new Date().toISOString() }];
    state.agents = [{ id: "worker-next", name: "Worker Next", role: "builder", kind: "named", key_class: "agent", online: true, status: "active", editing_files_parsed: [] }];
    state.messages = [{ id: "message-next", thread_id: "thread-next", kind: "message", from_agent_id: "worker-next", from_agent_name: "Worker Next", body: "Healthy while board fails", created_at: new Date().toISOString(), read_at: null }];
    const originalBoard = boardText();
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (path, init) => String(path).includes("column=done")
      ? json(503, { error: "one board column unavailable" }) : originalFetch(path as string, init));

    await c.refreshNow();
    expect($("fleet-count").textContent).toBe("1 of 1 agents online");
    expect($("inbox-list").textContent).toContain("Healthy while board fails");
    expect(boardText()).toBe(originalBoard);
    expect(c.state().homeSources.core.failed).toBe(true);
  });

  it("refreshes active Fleet locks on the shared tick even when the task domain fails", async () => {
    const { state, fetchMock, c } = await signedIn();
    c.selectTab("fleet");
    await flush();
    const before = count(state.calls, "/v1/resources");
    state.fail.set("/v1/tasks", 503);
    await c.refreshNow();
    expect(count(state.calls, "/v1/resources")).toBeGreaterThan(before);
    expect($("fleet-count").textContent).toBe("0 of 0 agents online");
  });

  it("treats a source 403 locally when /me still validates the workspace", async () => {
    const { state, c } = await signedIn();
    state.fail.set("/v1/agents", 403);
    state.tasks = [{ id: "task-after-source-403", title: "Task remains authorized", status: "open", created_by_agent_name: "Worker", created_at: new Date().toISOString() }];
    await c.refreshNow();
    expect($("console").hidden).toBe(false);
    expect(boardText()).toContain("Task remains authorized");
  });

  it("withdraws workspace data and returns to valid choices when current /me is forbidden", async () => {
    const { state, c } = await signedIn();
    state.tasks = [{ id: "task-before-me-forbidden", title: "Workspace data before refusal", status: "open", created_by_agent_name: "Worker", created_at: new Date().toISOString() }];
    await c.refreshNow();
    expect(boardText()).toContain("Workspace data before refusal");
    state.identityStatus = 403;
    state.authWorkspaces = ["ws-b"];
    await c.refreshNow();
    await flush(120);
    expect($("workspace-picker").hidden).toBe(false);
    expect($("console").hidden).toBe(true);
    expect(boardText()).not.toContain("Workspace data before refusal");
  });

  it("does not let an abort-ignoring old task body hold or paint over the next workspace", async () => {
    const { state, c } = await signedIn();
    const oldBody = deferred<unknown>();
    state.holdBody.set("board", oldBody);
    const oldFlight = c.refreshNow();
    let oldFlightSettled = false;
    void oldFlight.then(() => { oldFlightSettled = true; });
    await flush();
    const oldGeneration = c.state().consoleGeneration;
    state.holdBody.delete("board");
    const newEntry = c.enterWorkspace("ws-b");
    state.tasks = [{ id: "task-ws-b", title: "Current workspace board", status: "open", created_by_agent_name: "Worker B", created_at: new Date().toISOString() }];
    await newEntry;
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(c.state().consoleGeneration).toBeGreaterThan(oldGeneration);
    expect(boardText()).toContain("Current workspace board");
    expect(oldFlightSettled).toBe(true);
    oldBody.resolve({ tasks: [{ id: "task-old", title: "Obsolete workspace body", status: "open", created_by_agent_name: "Worker A", created_at: new Date().toISOString() }], nextCursor: null });
    await flush(80);
    expect(boardText()).not.toContain("Obsolete workspace body");
    expect($("overview-subtitle").textContent).toContain("ws-b");
  });

  it("marks a selected mention unknown when it falls out of the bounded digest without deleting its summary", async () => {
    const { state, c } = await signedIn();
    c.selectTab("inbox");
    c.stopPoll();
    state.awareness = { items: [{ seq: 42, type: "question.asked", priority: 1, directed: true, actor: "Worker", summary: "Earlier selected mention summary", reason: "Needs a response" }], background: {}, cursor: 42 };
    await c.refreshNow();
    const row = document.querySelector('#inbox-mentions [data-inbox-id="42"]') as HTMLElement;
    expect(row).toBeTruthy();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("inbox-focus").textContent).toContain("Earlier selected mention summary");

    state.awareness = { items: [], background: {}, cursor: 100 };
    await c.refreshNow();
    expect($("inbox-focus").textContent).toContain("Earlier selected mention summary");
    const status = $("inbox-focus").querySelector("[data-mention-status]") as HTMLElement | null;
    expect(status).not.toBeNull();
    expect(status!.dataset.state).toMatch(/stale|unknown/);
  });

  it("updates selected mention metadata in place and preserves the focused acknowledgement control", async () => {
    const { state, c } = await signedIn();
    c.selectTab("inbox");
    c.stopPoll();
    const item = { seq: 43, type: "question.asked", priority: 1, directed: true, actor: "Worker", summary: "Original selected mention summary", reason: "Original reason" };
    state.awareness = { items: [item], background: {}, cursor: 43 };
    await c.refreshNow();
    const row = document.querySelector('#inbox-mentions [data-inbox-id="43"]') as HTMLElement;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const focus = $("inbox-focus");
    const acknowledgement = focus.querySelector(".ack-actions button") as HTMLButtonElement;
    acknowledgement.focus();
    expect(document.activeElement).toBe(acknowledgement);

    state.awareness = { items: [{ ...item, summary: "Updated selected mention summary", reason: "Updated reason" }], background: {}, cursor: 44 };
    await c.refreshNow();
    expect(focus.textContent).toContain("Updated selected mention summary");
    expect(focus.textContent).toContain("Updated reason");
    expect(focus.textContent).not.toContain("Original reason");
    expect(acknowledgement.isConnected).toBe(true);
    expect(document.activeElement).toBe(acknowledgement);
  });

  it("withdraws a selected mention on source 403 while retaining the valid workspace", async () => {
    const { state, c } = await signedIn();
    c.selectTab("inbox");
    c.stopPoll();
    state.awareness = { items: [{ seq: 44, type: "question.asked", priority: 1, directed: true, actor: "Worker", summary: "Protected mention summary", reason: "Private response needed" }], background: {}, cursor: 44 };
    await c.refreshNow();
    const row = document.querySelector('#inbox-mentions [data-inbox-id="44"]') as HTMLElement;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("inbox-focus").textContent).toContain("Protected mention summary");
    expect($("inbox-focus").querySelector(".ack-actions")).not.toBeNull();

    state.fail.set("/v1/awareness", 403);
    await c.refreshNow();
    expect($("console").hidden).toBe(false);
    expect(boardText()).toContain("Initial board task");
    expect($("inbox-focus").textContent).not.toContain("Protected mention summary");
    expect($("inbox-focus").querySelector(".ack-actions")).toBeNull();
  });
});

describe("workspace identity recheck failure", () => {
  it("keeps the old workspace withdrawn after current /me401 and a person-recheck network failure", async () => {
    const { state, c } = await signedIn();
    expect(boardText()).toContain("Initial board task");
    expect(c.state().currentWorkspace).toBe("ws-a");
    const generation = c.state().consoleGeneration;
    state.identityStatus = 401;
    state.authNetworkFailure = true;
    await c.refreshNow();
    await flush(120);
    expect(state.calls).toContain("/v1/auth/me");
    expect(c.state().consoleGeneration).toBeGreaterThan(generation);
    expect(c.state().me).toBeNull();
    expect(c.state().currentWorkspace).toBeNull();
    expect(c.state().authMode).toBe("session");
    expect(c.state().homeSources.tasks.data).toBeNull();
    expect($("console").hidden).toBe(true);
    expect($("workspace-picker").hidden).toBe(false);
    expect($("workspace-list").textContent).toContain("Couldn't check workspace access.");
    expect($("workspace-list").querySelector("button")?.textContent).toBe("Retry");
    expect(boardText()).not.toContain("Initial board task");
    expect($("org-name").textContent).toBe("");
    expect($("ws-plan").hidden).toBe(true);
  });
});
