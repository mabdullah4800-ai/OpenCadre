// @vitest-environment happy-dom
// Refresh hygiene (plan 2026-09-30-console-refresh-tasks.md §2 item 2). Every socket frame called a full refresh()
// with no debounce, so a burst of 10 frames fired 10 x 15 GETs; two refreshes could run at once; and in session mode
// (where agentKey is null) nothing stopped workspace A's late response from rendering after a switch to workspace B.
// Now: one refresh at a time, a request while one runs queues exactly one more, and pushes, a return to the tab and
// actions coalesce behind a short trailing wait that a steady stream cannot starve.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => { let r!: () => void; const promise = new Promise<void>((res) => { r = res; }); return { promise, resolve: r }; };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  frame() { this.onmessage?.({ data: JSON.stringify({ type: "message" }) }); }
  close() { this.readyState = 3; }
}

/** A hub for two workspaces. Each workspace's /v1/tasks names it and counts its answers ("Task from ws-a (2)"), so a
 * render proves whose response it was, and which one. The board reads one page per column (tasks tranche 2): the task
 * is on the Open column's page, and that read is the one counted, so one refresh is still one count.
 * `hold[ws]`, when set, keeps that workspace's responses pending until it is resolved; `hold["<ws> <path>"]` holds only
 * that one request. */
function hub() {
  const hold: Record<string, Deferred | undefined> = {};
  const served: Record<string, number> = {};
  let approvals: unknown[] = [];
  let agents: unknown[] = [];
  let meRole = "operator";
  const fetchMock = vi.fn(async (path: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => {
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "none";
    if (path === "/v1/auth/me") {
      return json(200, { person: { id: "p1", name: "Ada", email: "ada@example.com" }, workspaces: [
        { orgId: "ws-a", name: "Alpha", role: "owner" }, { orgId: "ws-b", name: "Beta", role: "owner" }] });
    }
    const bare = path.split("?")[0];
    if (hold[`${ws} ${path}`]) await hold[`${ws} ${path}`]!.promise;
    if (hold[ws]) await hold[ws]!.promise;
    if (hold[`${ws} ${bare}`]) await hold[`${ws} ${bare}`]!.promise;
    if (path === "/v1/me") return json(200, { orgId: ws, orgName: ws, agentId: `me-${ws}`, agentName: "Ada", role: meRole, workspace: { paused: false } });
    if (path === "/v1/agents") return json(200, { agents });
    if (path.startsWith("/v1/approvals")) return json(200, { approvals });
    if (path === "/v1/approval-grants") return json(200, { grants: [] });
    if (path === "/v1/tasks/task-pinned") return json(200, { task: { id: "task-pinned", title: "Pinned task", status: "open", created_by_agent_name: "Grace", created_at: new Date().toISOString() } });
    if (path.startsWith("/v1/tasks?") && path.includes("limit=0")) return json(200, { counts: { open: 4, expired: 0, in_progress: 0, needs_review: 0, done: 0 } });
    if (bare === "/v1/tasks") {
      if (!path.includes("column=open")) return json(200, { tasks: [], nextCursor: null });
      served[ws] = (served[ws] ?? 0) + 1;
      return json(200, { tasks: [{ id: `t-${ws}`, title: `Task from ${ws} (${served[ws]})`, status: "open", created_by_agent_name: "Grace", created_at: new Date().toISOString() }], nextCursor: null });
    }
    if (path.startsWith("/v1/events")) return json(200, { events: [] });
    if (path === "/v1/awareness") return json(200, { items: [], background: {}, cursor: 0 });
    if (path.startsWith("/v1/messages")) return json(200, { messages: [] });
    if (path === "/v1/org/devices") return json(200, { devices: [] });
    if (path.startsWith("/v1/org/sessions")) return json(200, { sessions: [] });
    if (path === "/v1/org/projects") return json(200, { projects: [] });
    if (path === "/v1/onboarding") return json(200, { completed: 1, total: 1, steps: [] });
    return json(200, {});
  });
  return { fetchMock, hold, setApprovals: (value: unknown[]) => { approvals = value; }, setAgents: (value: unknown[]) => { agents = value; }, setMeRole: (role: string) => { meRole = role; } };
}

function loadConsole(fetchMock: ReturnType<typeof hub>["fetchMock"]) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { refresh, refreshNow, enterWorkspace, connectLiveWs, schedulePoll, stopPoll: () => clearTimeout(pollTimer), api, signOut, setTaskFilter, seedPinnedTask: (task) => taskBoard.pinned.set(task.id, task), selectTab, homeSources: () => homeSources, refreshFileLocks };`,
  )(window, document, window.localStorage, fetchMock) as {
    refresh: () => Promise<void>;
    refreshNow: () => Promise<void>;
    enterWorkspace: (orgId: string, options?: { wanted?: () => boolean }) => Promise<void>;
    connectLiveWs: () => void;
    schedulePoll: () => void;
    stopPoll: () => void;
    api: (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>;
    signOut: (message?: string, options?: { reload?: boolean }) => void;
    setTaskFilter: (change: { q?: string; project?: string }) => void;
    seedPinnedTask: (task: { id: string }) => void;
    selectTab: (name: string) => void;
    homeSources: () => Record<string, { status: string; data: unknown }>;
    refreshFileLocks: () => Promise<void>;
  };
}

/** One per refresh: the board's Open column read (tasks tranche 2 reads each column; Open is the one counted). */
const isBoardRead = (path: unknown) => String(path).startsWith("/v1/tasks?") && String(path).includes("column=open");
const taskGets = (fetchMock: ReturnType<typeof hub>["fetchMock"]) =>
  fetchMock.mock.calls.filter(([path, init]) => isBoardRead(path) && !(init as { method?: string } | undefined)?.method?.match(/POST/)).length;

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  window.localStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Signs into workspace A and lets the first load finish, then forgets the calls it made. */
async function signedIn() {
  const h = hub();
  const c = loadConsole(h.fetchMock);
  await vi.advanceTimersByTimeAsync(0);
  await c.enterWorkspace("ws-a");
  await vi.advanceTimersByTimeAsync(300);
  const socket = FakeSocket.instances.at(-1)!;
  socket.readyState = FakeSocket.OPEN;
  h.fetchMock.mockClear();
  return { ...h, c, socket };
}

describe("socket frames coalesce", () => {
  it("ignores a late open from a socket owned by the previous workspace", async () => {
    const { fetchMock, socket, c } = await signedIn();
    c.stopPoll();
    await c.enterWorkspace("ws-b");
    c.stopPoll();
    fetchMock.mockClear();
    socket.open();
    await vi.advanceTimersByTimeAsync(1500);
    expect(taskGets(fetchMock)).toBe(0);
  });

  it("reconciles the console when a live socket opens after a gap", async () => {
    const { fetchMock, socket, c, setApprovals, setAgents } = await signedIn();
    c.stopPoll();
    fetchMock.mockClear();
    setApprovals([{ id: "approval-socket", requested_by_agent_id: "worker-socket", requested_by_agent_name: "Worker", action: "inspect", risk: "low", category: null, details: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString() }]);
    setAgents([{ id: "worker-socket", name: "Worker", role: "builder", online: true, kind: "agent", key_class: "agent", editing_files_parsed: [], last_heartbeat_at: new Date().toISOString() }]);
    socket.close();
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(5000);
    const reopened = FakeSocket.instances.at(-1)!;
    expect(reopened).not.toBe(socket);
    reopened.open();
    await vi.advanceTimersByTimeAsync(1500);
    expect(taskGets(fetchMock)).toBe(1);
    expect(document.title).toBe("(1) OpenCadre Console");
    expect(document.getElementById("fleet-count")!.textContent).toBe("1 of 1 agents online");
  });

  it.each([["CONNECTING", FakeSocket.CONNECTING], ["OPEN", FakeSocket.OPEN]] as const)(
    "retires the previous %s socket on workspace switch; old callbacks cannot own B",
    async (_state, readyState) => {
      const { fetchMock, socket: old, c, setApprovals, setAgents } = await signedIn();
      c.stopPoll();
      old.readyState = readyState;
      const before = FakeSocket.instances.length;
      await c.enterWorkspace("ws-b");
      c.stopPoll();
      const current = FakeSocket.instances.at(-1)!;
      expect(FakeSocket.instances).toHaveLength(before + 1);
      expect(current.url).toContain("workspace=ws-b");
      expect(old.readyState).toBe(3);
      fetchMock.mockClear();

      old.open();
      old.frame();
      old.onerror?.();
      old.onclose?.();
      await vi.advanceTimersByTimeAsync(1500);
      expect(document.getElementById("live-dot")!.className).toBe("live-dot is-polling");
      expect(taskGets(fetchMock)).toBe(0);
      expect(FakeSocket.instances.at(-1)).toBe(current);

      setApprovals([{ id: "approval-b", requested_by_agent_id: "worker-b", requested_by_agent_name: "Worker B", action: "inspect", risk: "low", category: null, details: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString() }]);
      setAgents([{ id: "worker-b", name: "Worker B", role: "builder", online: true, kind: "agent", key_class: "agent", editing_files_parsed: [], last_heartbeat_at: new Date().toISOString() }]);
      current.open();
      current.frame();
      await vi.advanceTimersByTimeAsync(1500);
      expect(taskGets(fetchMock)).toBe(1);
      expect(document.getElementById("live-dot")!.className).toBe("live-dot is-live");
      expect(document.title).toBe("(1) OpenCadre Console");
      expect(document.getElementById("fleet-count")!.textContent).toBe("1 of 1 agents online");

      current.close();
      current.onclose?.();
      await vi.advanceTimersByTimeAsync(5000);
      expect(FakeSocket.instances.at(-1)).not.toBe(current);
      expect(FakeSocket.instances.at(-1)!.url).toContain("workspace=ws-b");
    },
  );

  it("recreates the current workspace socket after a role change found in /v1/me", async () => {
    const { fetchMock, socket: old, c, setMeRole, setApprovals } = await signedIn();
    c.stopPoll();
    old.open();
    await vi.advanceTimersByTimeAsync(1200);
    fetchMock.mockClear();
    const before = FakeSocket.instances.length;
    setMeRole("agent");
    const changed = c.refreshNow();
    await vi.advanceTimersByTimeAsync(100);
    await changed;
    const current = FakeSocket.instances.at(-1)!;
    expect(FakeSocket.instances).toHaveLength(before + 1);
    expect(old.readyState).toBe(3);
    expect(current.url).toContain("workspace=ws-a");
    expect(document.getElementById("live-dot")!.className).toBe("live-dot is-polling");

    old.open();
    old.frame();
    old.onerror?.();
    old.onclose?.();
    await vi.advanceTimersByTimeAsync(1500);
    expect(document.getElementById("live-dot")!.className).toBe("live-dot is-polling");
    expect(taskGets(fetchMock)).toBeGreaterThanOrEqual(1);

    setApprovals([{ id: "approval-role", requested_by_agent_id: "worker-role", requested_by_agent_name: "Worker", action: "inspect", risk: "low", category: null, details: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString() }]);
    current.open();
    await vi.advanceTimersByTimeAsync(1200);
    expect(document.getElementById("live-dot")!.className).toBe("live-dot is-live");
    expect(document.title).toBe("(1) OpenCadre Console");
  });

  it("reconnects the restored workspace when a wanted entry rolls back", async () => {
    const { fetchMock, hold, c, socket: old } = await signedIn();
    c.stopPoll();
    const release = deferred();
    hold["ws-b /v1/me"] = release;
    let wanted = true;
    const switching = c.enterWorkspace("ws-b", { wanted: () => wanted });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/v1/me" &&
      (init as { headers?: Record<string, string> } | undefined)?.headers?.["X-OpenCadre-Workspace"] === "ws-b")).toBe(true);
    wanted = false;
    release.resolve();
    await switching;
    c.stopPoll();

    const restored = FakeSocket.instances.at(-1)!;
    expect(FakeSocket.instances).toHaveLength(2); // B never entered; A owns the one replacement socket
    expect(old.readyState).toBe(3);
    expect(restored.url).toContain("workspace=ws-a");
    old.open();
    old.frame();
    old.onerror?.();
    old.onclose?.();
    await vi.advanceTimersByTimeAsync(1200);
    expect(document.getElementById("live-dot")!.className).toBe("live-dot is-polling");
    expect(document.getElementById("tasks")!.textContent).toContain("Task from ws-a");
    restored.open();
    await vi.advanceTimersByTimeAsync(1200);
    expect(document.getElementById("live-dot")!.className).toBe("live-dot is-live");
  });

  it("does not reconnect after sign-out leaves no live identity", async () => {
    const { c, socket: old } = await signedIn();
    c.stopPoll();
    c.signOut("test", { reload: false });
    expect(old.readyState).toBe(3);
    old.open();
    old.frame();
    old.onerror?.();
    old.onclose?.();
    await vi.advanceTimersByTimeAsync(6000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(document.getElementById("live-dot")!.className).toBe("live-dot is-polling");
  });

  it("10 frames in 50 ms give one refresh", async () => {
    const { fetchMock, socket } = await signedIn();
    for (let i = 0; i < 10; i++) {
      socket.frame();
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(1500);
    expect(taskGets(fetchMock)).toBe(1);
  });

  it("a steady stream of frames still refreshes about once a second, not never", async () => {
    const { fetchMock, socket } = await signedIn();
    for (let t = 0; t < 3000; t += 100) {
      socket.frame();
      await vi.advanceTimersByTimeAsync(100);
    }
    const during = taskGets(fetchMock);
    expect(during).toBeGreaterThanOrEqual(2);
    expect(during).toBeLessThanOrEqual(4);
  });

  it("returning to the tab coalesces with frames that arrive alongside it", async () => {
    const { fetchMock, socket } = await signedIn();
    socket.frame();
    document.dispatchEvent(new Event("visibilitychange"));
    socket.frame();
    await vi.advanceTimersByTimeAsync(1500);
    expect(taskGets(fetchMock)).toBe(1);
  });
});

describe("one refresh at a time", () => {
  it("calls during an in-flight refresh give exactly one follow-up", async () => {
    const { fetchMock, hold, c } = await signedIn();
    hold["ws-a"] = deferred();
    c.refresh();
    await vi.advanceTimersByTimeAsync(1100);
    expect(taskGets(fetchMock)).toBe(1); // in flight, held
    c.refresh();
    c.refresh();
    c.refresh();
    await vi.advanceTimersByTimeAsync(1100);
    expect(taskGets(fetchMock)).toBe(1); // still only the one in flight
    const release = hold["ws-a"]!;
    hold["ws-a"] = undefined;
    release.resolve();
    await vi.advanceTimersByTimeAsync(1100);
    expect(taskGets(fetchMock)).toBe(2);
  });

  it("a response for workspace A never renders after a switch to workspace B", async () => {
    const { hold, c } = await signedIn();
    const board = () => document.getElementById("tasks")?.textContent ?? "";
    expect(board()).toContain("Task from ws-a (1)");
    hold["ws-a"] = deferred();
    c.refresh();
    await vi.advanceTimersByTimeAsync(1100); // A's second refresh is in flight
    hold["ws-b"] = deferred();
    const switching = c.enterWorkspace("ws-b");
    await vi.advanceTimersByTimeAsync(10);
    hold["ws-a"]!.resolve(); // A answers late, after the switch
    await vi.advanceTimersByTimeAsync(10);
    expect(board()).not.toContain("Task from ws-a (2)");
    hold["ws-b"]!.resolve();
    await switching;
    await vi.advanceTimersByTimeAsync(1500);
    expect(board()).toContain("Task from ws-b");
    expect(board()).not.toContain("Task from ws-a (2)");
  });
});

describe("refresh read deadline", () => {
  it("settles the original deadline without joining a queued successor, which remains single-flight", async () => {
    const { fetchMock, hold, c } = await signedIn();
    c.stopPoll();
    hold["ws-a /v1/approval-grants"] = deferred();
    let firstDone = false;
    let queuedDone = false;
    const first = c.refreshNow().then(() => { firstDone = true; });
    await vi.advanceTimersByTimeAsync(0);
    const queued = c.refreshNow();
    expect(c.refreshNow()).toBe(queued);
    void queued.then(() => { queuedDone = true; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(firstDone).toBe(true);
    await first;
    expect(queuedDone).toBe(false);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/approval-grants")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    await queued;
    expect(queuedDone).toBe(true);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/approval-grants")).toHaveLength(2);
    hold["ws-a /v1/approval-grants"] = undefined;
    await c.refreshNow();
    expect(document.getElementById("refresh-notice")!.textContent).not.toMatch(/timed out/i);
  });

  it("a debounced refresh waiter joins its successor, never a read started before the request", async () => {
    const { fetchMock, c } = await signedIn();
    c.stopPoll();
    const firstHold = deferred();
    const secondHold = deferred();
    const original = fetchMock.getMockImplementation()!;
    let grantsReads = 0;
    fetchMock.mockImplementation(async (path, init) => {
      if (path === "/v1/approval-grants") {
        const gate = ++grantsReads === 1 ? firstHold : secondHold;
        await gate.promise;
      }
      return original(path, init);
    });
    let firstDone = false;
    let waiterDone = false;
    const first = c.refreshNow().then(() => { firstDone = true; });
    await vi.advanceTimersByTimeAsync(0);
    const waiter = c.refresh().then(() => { waiterDone = true; });
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/approval-grants")).toHaveLength(1);
    firstHold.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstDone).toBe(true);
    await first;
    expect(waiterDone).toBe(false);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/approval-grants")).toHaveLength(2);
    secondHold.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await waiter;
    expect(waiterDone).toBe(true);
  });

  it.each(["signout", "workspace switch"])("does not run an obsolete queued successor after %s", async (change) => {
    const { fetchMock, hold, c } = await signedIn();
    c.stopPoll();
    hold["ws-a /v1/approval-grants"] = deferred();
    const first = c.refreshNow();
    await vi.advanceTimersByTimeAsync(0);
    const queued = c.refreshNow();
    if (change === "signout") c.signOut(undefined, { reload: false });
    else await c.enterWorkspace("ws-b");
    await vi.advanceTimersByTimeAsync(300);
    c.stopPoll();
    await Promise.all([first, queued]);
    const oldReads = fetchMock.mock.calls.filter(([path, init]) => path === "/v1/approval-grants" && init?.headers?.["X-OpenCadre-Workspace"] === "ws-a");
    expect(oldReads).toHaveLength(1);
  });

  it("joins a valid second flight started by an earlier subscriber rather than creating a third", async () => {
    const { fetchMock, c } = await signedIn();
    c.stopPoll();
    const firstHold = deferred();
    const secondHold = deferred();
    const original = fetchMock.getMockImplementation()!;
    let reads = 0;
    fetchMock.mockImplementation(async (path, init) => {
      if (path === "/v1/approval-grants") {
        const gate = ++reads === 1 ? firstHold : reads === 2 ? secondHold : null;
        if (gate) await gate.promise;
      }
      return original(path, init);
    });
    const first = c.refreshNow();
    const earlierSubscriber = first.then(() => c.refreshNow());
    const queued = c.refreshNow();
    firstHold.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(2);
    secondHold.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([earlierSubscriber, queued]);
    expect(reads).toBe(2);
  });

  const approval = {
    id: "approval-1", requested_by_agent_id: "worker-1", requested_by_agent_name: "Worker",
    action: "rm -rf ./dist", risk: "high", category: null, details: null,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString(),
  };
  const onlineAgent = { id: "worker-1", name: "Worker", role: "builder", online: true, kind: "agent", key_class: "agent", editing_files_parsed: [], last_heartbeat_at: new Date().toISOString() };

  it("bounds a never-settling read and lets the next poll apply approvals and liveness", async () => {
    const { fetchMock, hold, setApprovals, setAgents, c } = await signedIn();
    c.stopPoll();
    const never = deferred();
    hold["ws-a /v1/approval-grants"] = never;
    setApprovals([approval]);
    setAgents([onlineAgent]);

    const first = c.refreshNow();
    await vi.advanceTimersByTimeAsync(14_999);
    // Approval data is independently authorized/applied; a held grants read must not hide it.
    expect(document.title).toBe("(1) OpenCadre Console");
    expect(document.getElementById("clearances")!.textContent).toContain(approval.action);
    expect(document.getElementById("fleet-count")!.textContent).toBe("1 of 1 agents online");
    expect(document.getElementById("tasks")!.textContent).toContain("Task from ws-a (2)");
    await vi.advanceTimersByTimeAsync(1);
    await first;

    const request = fetchMock.mock.calls.find(([path]) => path === "/v1/approval-grants");
    expect((request?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(true);
    expect(document.getElementById("refresh-notice")!.textContent).toMatch(/timed out/i);
    expect(document.title).toBe("(1) OpenCadre Console");

    hold["ws-a /v1/approval-grants"] = undefined;
    c.schedulePoll();
    await vi.advanceTimersByTimeAsync(4000);
    expect(document.title).toBe("(1) OpenCadre Console");
    expect(document.getElementById("fleet-count")!.textContent).toBe("1 of 1 agents online");
    expect(document.getElementById("refresh-notice")!.textContent).not.toMatch(/timed out/i);
  });

  it("automatically retries on the next real poll after a held read times out", async () => {
    const { fetchMock, hold, setApprovals, setAgents } = await signedIn();
    const never = deferred();
    hold["ws-a /v1/approval-grants"] = never;
    setApprovals([approval]);
    setAgents([onlineAgent]);

    // Keep the poll started by sign-in. Do not call refreshNow() or schedulePoll() ourselves.
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/approval-grants")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(document.getElementById("refresh-notice")!.textContent).toMatch(/timed out/i);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/approval-grants")).toHaveLength(1);

    hold["ws-a /v1/approval-grants"] = undefined;
    never.resolve(); // let the ignored-abort transport settle; it cannot change the timed-out flight
    await vi.advanceTimersByTimeAsync(4000); // the poll rescheduled by the expired poll starts
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/approval-grants").length).toBeGreaterThanOrEqual(2);
    expect(document.title).toBe("(1) OpenCadre Console");
    expect(document.getElementById("fleet-count")!.textContent).toBe("1 of 1 agents online");
    expect(document.getElementById("refresh-notice")!.textContent).not.toMatch(/timed out/i);
  });

  it("keeps the approval scope alive through an unrelated required-source failure until its own deadline", async () => {
    const { fetchMock, hold, c } = await signedIn();
    c.stopPoll();
    const original = fetchMock.getMockImplementation()!;
    const approvalRead = deferred();
    hold["ws-a /v1/approvals"] = approvalRead;
    fetchMock.mockImplementation(async (path, init) =>
      path === "/v1/agents" ? json(503, { error: "controlled roster failure" }) : original(path, init));

    let settled = false;
    const refresh = c.refreshNow().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    const request = fetchMock.mock.calls.find(([path]) => String(path).startsWith("/v1/approvals"));
    expect(request).toBeDefined();
    expect((request?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    expect((request?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await refresh;
    expect(settled).toBe(true);
    expect((request?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(true);
    hold["ws-a /v1/approvals"] = undefined;
    approvalRead.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not duplicate Fleet lock reads while one is held and coalesces calls into one follow-up", async () => {
    const { fetchMock, hold, c } = await signedIn();
    c.stopPoll();
    c.selectTab("fleet");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/resources")).toHaveLength(1);
    fetchMock.mockClear();

    const held = deferred();
    hold["ws-a /v1/resources"] = held;
    const first = c.refreshFileLocks();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/resources")).toHaveLength(1);

    const second = c.refreshFileLocks();
    c.refreshFileLocks();
    c.refreshFileLocks();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/resources")).toHaveLength(1);

    hold["ws-a /v1/resources"] = undefined;
    held.resolve();
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/resources")).toHaveLength(2);
  });

  it("keeps the task skeleton visible while healthy first-render domains apply", async () => {
    const { hold, setAgents, c } = await signedIn();
    c.stopPoll();
    setAgents([onlineAgent]);
    const heldBoard = deferred();
    hold["ws-a /v1/tasks"] = heldBoard;
    const entering = c.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector("#tasks .skeleton")).toBeTruthy();
    expect(document.getElementById("fleet-count")!.textContent).toBe("1 of 1 agents online");

    hold["ws-a /v1/tasks"] = undefined;
    heldBoard.resolve();
    await entering;
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("#tasks .skeleton")).toBeNull();
    expect(document.getElementById("tasks")!.textContent).toContain("Task from ws-a");
  });

  it("covers response JSON parsing and reports its timeout instead of treating it as an empty body", async () => {
    const { fetchMock, setApprovals, setAgents, c } = await signedIn();
    c.stopPoll();
    const original = fetchMock.getMockImplementation()!;
    let bodyHeld = true;
    fetchMock.mockImplementation(async (path, init) => {
      const response = await original(path, init);
      if (path === "/v1/approval-grants" && bodyHeld) return { ...response, json: () => new Promise(() => {}) };
      return response;
    });
    setApprovals([approval]);
    setAgents([onlineAgent]);

    const first = c.refreshNow();
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    const request = fetchMock.mock.calls.find(([path]) => path === "/v1/approval-grants");
    expect((request?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(true);
    expect(document.getElementById("refresh-notice")!.textContent).toMatch(/timed out/i);
    // JSON-body timeout is still surfaced, without discarding the separately answered approvals.
    expect(document.title).toBe("(1) OpenCadre Console");
    expect(document.getElementById("clearances")!.textContent).toContain(approval.action);

    bodyHeld = false;
    c.schedulePoll();
    await vi.advanceTimersByTimeAsync(4000);
    expect(document.title).toBe("(1) OpenCadre Console");
    expect(document.getElementById("fleet-count")!.textContent).toBe("1 of 1 agents online");
    expect(document.getElementById("refresh-notice")!.textContent).not.toMatch(/timed out/i);
  });

  it("does not apply the refresh deadline to an unrelated write", async () => {
    const { fetchMock, hold, c } = await signedIn();
    c.stopPoll();
    const never = deferred();
    hold["ws-a /v1/test-write"] = never;
    let settled = false;
    const write = c.api("/v1/test-write", { method: "POST", body: {} }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);
    const request = fetchMock.mock.calls.find(([path]) => path === "/v1/test-write");
    expect((request?.[1] as { signal?: AbortSignal } | undefined)?.signal).toBeUndefined();
    hold["ws-a /v1/test-write"] = undefined;
    never.resolve();
    await write;
  });

  it("does not apply the refresh deadline to an unrelated long-poll GET", async () => {
    const { fetchMock, hold, c } = await signedIn();
    c.stopPoll();
    const never = deferred();
    hold["ws-a /v1/messages/wait"] = never;
    let settled = false;
    const wait = c.api("/v1/messages/wait").then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);
    const request = fetchMock.mock.calls.find(([path]) => path === "/v1/messages/wait");
    expect((request?.[1] as { signal?: AbortSignal } | undefined)?.signal).toBeUndefined();
    hold["ws-a /v1/messages/wait"] = undefined;
    never.resolve();
    await wait;
  });

  it("bounds secondary task totals, pinned-task, and readSource reads in the refresh graph", async () => {
    const { fetchMock, hold, c } = await signedIn();
    c.stopPoll();
    c.setTaskFilter({ q: "filtered" });
    c.seedPinnedTask({ id: "task-pinned" });
    hold["ws-a /v1/tasks?summary=1&limit=0"] = deferred();
    hold["ws-a /v1/tasks/task-pinned"] = deferred();
    hold["ws-a /v1/org/devices"] = deferred();

    const refresh = c.refreshNow();
    await vi.advanceTimersByTimeAsync(15_000);
    await refresh;
    for (const path of ["/v1/tasks?summary=1&limit=0", "/v1/tasks/task-pinned", "/v1/org/devices"]) {
      const request = fetchMock.mock.calls.find(([called]) => called === path);
      expect(request, `expected nested refresh read ${path}`).toBeDefined();
      expect((request?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted, path).toBe(true);
    }
    expect(document.getElementById("refresh-notice")!.textContent).toMatch(/timed out/i);
  });

  it("keeps the optional Fleet lock read from delaying approvals and liveness", async () => {
    const { fetchMock, hold, setApprovals, setAgents, c } = await signedIn();
    c.stopPoll();
    const never = deferred();
    hold["ws-a /v1/resources"] = never;
    c.selectTab("fleet"); // the tab's independent lock read is held
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/resources")).toHaveLength(1);
    setApprovals([approval]);
    setAgents([onlineAgent]);
    fetchMock.mockClear();

    await c.refreshNow();
    expect(document.title).toBe("(1) OpenCadre Console");
    expect(document.getElementById("fleet-count")!.textContent).toBe("1 of 1 agents online");
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/resources")).toHaveLength(0);
    hold["ws-a /v1/resources"] = undefined;
    never.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/resources")).toHaveLength(1);
  });

  it("keeps each source read alive until its own deadline and suppresses its late result after the next good refresh", async () => {
    const { fetchMock, c } = await signedIn();
    c.stopPoll();
    const original = fetchMock.getMockImplementation()!;
    const heldDevices = deferred();
    let failAgents = true;
    let heldDevicesOnce = false;
    fetchMock.mockImplementation(async (path, init) => {
      if (path === "/v1/agents" && failAgents) return json(503, { error: "controlled failure" });
      if (path === "/v1/org/devices" && !heldDevicesOnce) {
        heldDevicesOnce = true;
        await heldDevices.promise;
        return json(403, { error: "late refusal" });
      }
      return original(path, init);
    });

    const failed = c.refreshNow();
    await vi.advanceTimersByTimeAsync(0);
    const pendingSourceRequest = fetchMock.mock.calls.find(([path]) => path === "/v1/org/devices");
    expect((pendingSourceRequest?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(14_999);
    expect((pendingSourceRequest?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect((pendingSourceRequest?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(true);
    expect(c.homeSources().devices.status).toBe("failed"); // preserve the last data, but never report a timed-out read as fresh

    failAgents = false;
    await c.refreshNow();
    expect(c.homeSources().devices.status).toBe("ok");
    heldDevices.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.homeSources().devices.status).toBe("ok");
    expect(document.getElementById("refresh-notice")!.textContent).not.toMatch(/couldn't refresh/i);
  });

  it("cancels a held source JSON body after a required failure and suppresses its later refusal", async () => {
    const { fetchMock, c } = await signedIn();
    c.stopPoll();
    const original = fetchMock.getMockImplementation()!;
    const heldBody = deferred();
    let failAgents = true;
    let heldBodyOnce = false;
    let bodyStarted = false;
    fetchMock.mockImplementation(async (path, init) => {
      if (path === "/v1/agents" && failAgents) return json(503, { error: "controlled failure" });
      const response = await original(path, init);
      if (path === "/v1/org/devices" && !heldBodyOnce) {
        heldBodyOnce = true;
        return { ...response, ok: false, status: 403, json: () => { bodyStarted = true; return heldBody.promise.then(() => ({ error: "late refusal" })); } };
      }
      return response;
    });

    const failed = c.refreshNow();
    await vi.advanceTimersByTimeAsync(0);
    const pendingSourceRequest = fetchMock.mock.calls.find(([path]) => path === "/v1/org/devices");
    expect(bodyStarted).toBe(true);
    expect((pendingSourceRequest?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(14_999);
    expect((pendingSourceRequest?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect((pendingSourceRequest?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(true);
    expect(c.homeSources().devices.status).toBe("failed"); // the old good data may remain, but its current read timed out

    failAgents = false;
    await c.refreshNow();
    expect(c.homeSources().devices.status).toBe("ok");
    heldBody.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.homeSources().devices.status).toBe("ok");
    expect(document.getElementById("refresh-notice")!.textContent).not.toMatch(/couldn't refresh/i);
  });
});

// A refresh asked for while signed out (an action finishing just as someone signs out, or a test that never signed
// in) does nothing: without a signed-in identity there is nothing to load, and a late render would paint whatever the
// hub answered for no one over the page.
describe("signed out", () => {
  it("a requested refresh makes no request", async () => {
    const { fetchMock } = hub();
    const c = loadConsole(fetchMock);
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockClear();
    c.refresh();
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Codex on #655 at f065c4de (P2): the single-flight scheduler let a new identity JOIN the old one's flight. With workspace
// A's /v1/tasks still pending, entering workspace B sent none of B's requests until A answered, and the board kept
// showing A's tasks to someone signed into B. A new identity now starts its own flight at once, the old flight can no
// longer touch the new one's state, and the previous workspace's board is cleared on the switch.
describe("a new identity never waits on the old one's refresh", () => {
  const board = () => document.getElementById("tasks")?.textContent ?? "";
  const tasksFor = (fetchMock: ReturnType<typeof hub>["fetchMock"], ws: string) => fetchMock.mock.calls.filter(([path, init]) =>
    isBoardRead(path) && (init as { headers?: Record<string, string> } | undefined)?.headers?.["X-OpenCadre-Workspace"] === ws).length;

  it("switching A to B while A's tasks never answer: B loads, and only B's tasks show", async () => {
    const { hold, c } = await signedIn();
    hold["ws-a /v1/tasks"] = deferred(); // never resolved
    c.refresh();
    await vi.advanceTimersByTimeAsync(1100); // A's second refresh is stuck on /v1/tasks
    await c.enterWorkspace("ws-b");
    expect(board()).not.toContain("Task from ws-a"); // cleared on the switch, before B has answered
    await vi.advanceTimersByTimeAsync(300);
    expect(board()).toContain("Task from ws-b");
    expect(board()).not.toContain("Task from ws-a");
  });

  it("signing out and back in while the old refresh never answers: the new sign-in loads", async () => {
    const { hold, c } = await signedIn();
    hold["ws-a /v1/tasks"] = deferred(); // never resolved
    c.refresh();
    await vi.advanceTimersByTimeAsync(1100);
    c.signOut();
    await vi.advanceTimersByTimeAsync(10);
    await c.enterWorkspace("ws-b");
    await vi.advanceTimersByTimeAsync(300);
    expect(board()).toContain("Task from ws-b");
    expect(board()).not.toContain("Task from ws-a");
  });

  it("cancels the old refresh deadline on identity change without letting it affect the new workspace", async () => {
    const { hold, c } = await signedIn();
    c.stopPoll();
    const never = deferred();
    hold["ws-a /v1/approval-grants"] = never;
    let oldSettled = false;
    c.refreshNow().then(() => { oldSettled = true; });
    await vi.advanceTimersByTimeAsync(1000);
    const switching = c.enterWorkspace("ws-b");
    await vi.advanceTimersByTimeAsync(300);
    await switching;
    c.stopPoll();
    expect(board()).toContain("Task from ws-b");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(board()).toContain("Task from ws-b");
    expect(document.getElementById("refresh-notice")!.textContent).not.toMatch(/timed out/i);
    // The approval scope settles the abandoned flight; api() still suppresses obsolete effects,
    // and neither its cancelled deadline nor its late failure may paint in workspace B.
    expect(oldSettled).toBe(true);
  });

  it("A's late answer, after B has loaded, never paints and does not disturb B's own refresh", async () => {
    const { fetchMock, hold, c } = await signedIn();
    const lateA = deferred();
    hold["ws-a /v1/tasks"] = lateA;
    c.refresh();
    await vi.advanceTimersByTimeAsync(1100);
    await c.enterWorkspace("ws-b");
    await vi.advanceTimersByTimeAsync(300);
    expect(board()).toContain("Task from ws-b (1)");
    // B's next refresh is in flight, held on its own tasks.
    const heldB = deferred();
    hold["ws-b /v1/tasks"] = heldB;
    c.refresh();
    await vi.advanceTimersByTimeAsync(1100);
    const bInFlight = tasksFor(fetchMock, "ws-b");
    lateA.resolve(); // A answers now
    await vi.advanceTimersByTimeAsync(10);
    expect(board()).not.toContain("Task from ws-a");
    // A's flight ending must not have cleared B's: another request queues behind B's, it does not start a second one.
    c.refresh();
    await vi.advanceTimersByTimeAsync(1100);
    expect(tasksFor(fetchMock, "ws-b")).toBe(bInFlight);
    hold["ws-b /v1/tasks"] = undefined;
    heldB.resolve();
    await vi.advanceTimersByTimeAsync(1100);
    expect(tasksFor(fetchMock, "ws-b")).toBe(bInFlight + 1); // exactly the one queued follow-up
    expect(board()).toContain("Task from ws-b");
    expect(board()).not.toContain("Task from ws-a");
  });
});
