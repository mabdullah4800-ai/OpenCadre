// @vitest-environment happy-dom
// A refresh that fails says so. loadAndRender() used to catch and drop every error that was not an auth or pause error,
// so a render crash or a failed fetch left the page on a loading skeleton, or on stale content, with nothing on screen
// and nothing in the browser console (a harness-only ReferenceError hid for days that way; see #656). Now a failed
// refresh shows one quiet "Couldn't refresh" line that the next good refresh clears, keeps what this workspace already
// showed, replaces a first load's skeleton, and logs which step failed and the error's class, never its text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => { let r!: () => void; const promise = new Promise<void>((res) => { r = res; }); return { promise, resolve: r }; };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

// Values that must never reach the browser console: the session cookie, a key-looking string inside an error message,
// a hub error body, and task text.
const COOKIE_SECRET = "sess_SEEDEDCOOKIE9f3a";
const KEY_SECRET = "agt_SEEDEDKEY7c21";
const BODY_SECRET = "agt_BODYSECRET55e0";
const NET_SECRET = "agt_NETSECRET0b4d";
const TASK_SECRET = "SECRET-TASK-TEXT";
const SECRETS = [COOKIE_SECRET, KEY_SECRET, BODY_SECRET, NET_SECRET, TASK_SECRET];

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

type Failure = number | "network";

/** A hub for two workspaces. `fail[path]` (the path without its query) answers that endpoint with that status, or
 * rejects like a dropped connection for "network"; `hold[path]` keeps it pending until resolved. */
function hub() {
  const fail: Record<string, Failure | undefined> = {};
  const hold: Record<string, Deferred | undefined> = {};
  const served: Record<string, number> = {};
  const fetchMock = vi.fn(async (path: string, init?: { headers?: Record<string, string> }) => {
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "none";
    if (path === "/v1/auth/me") {
      if (fail["/v1/auth/me"] === "network") throw new TypeError("Failed to fetch " + NET_SECRET);
      if (typeof fail["/v1/auth/me"] === "number") return json(fail["/v1/auth/me"]!, { error: "session unavailable" });
      return json(200, { person: { id: "p1", name: "Ada", email: "ada@example.com" }, workspaces: [
        { orgId: "ws-a", name: "Alpha", role: "owner" }, { orgId: "ws-b", name: "Beta", role: "owner" }] });
    }
    const bare = path.split("?")[0];
    if (hold[bare]) await hold[bare]!.promise;
    const f = fail[bare];
    if (f === "network") throw new TypeError(`Failed to fetch ${NET_SECRET}`);
    if (typeof f === "number") {
      return json(f, f === 401 ? { error: "unauthorized" } : f === 423 ? { error: "This workspace is paused." } : { error: `db exploded near ${BODY_SECRET}` });
    }
    if (path === "/v1/me") return json(200, { orgId: ws, orgName: ws, agentId: `me-${ws}`, agentName: "Ada", role: "operator", workspace: { paused: false } });
    if (path === "/v1/agents") return json(200, { agents: [] });
    if (path.startsWith("/v1/approvals")) return json(200, { approvals: [] });
    if (path === "/v1/approval-grants") return json(200, { grants: [] });
    // The board reads one page per column (tasks tranche 2). The task is on the Open column's page, and that read is the
    // one counted, so "(2)" still means the second refresh.
    if (bare === "/v1/tasks") {
      if (!path.includes("column=open")) return json(200, { tasks: [], nextCursor: null });
      served[ws] = (served[ws] ?? 0) + 1;
      return json(200, { tasks: [{ id: `t-${ws}`, title: `${TASK_SECRET} from ${ws} (${served[ws]})`, status: "open", created_by_agent_name: "Grace", created_at: new Date().toISOString() }], nextCursor: null });
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
  return { fetchMock, fail, hold };
}

type Console = {
  enterWorkspace: (orgId: string) => Promise<void>;
  /** Replaces one of app.js's top-level functions and returns the original. */
  swap: (name: string, fn: unknown) => unknown;
};

function loadConsole(fetchMock: ReturnType<typeof hub>["fetchMock"]): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { enterWorkspace, swap: (name, fn) => { const old = eval(name); eval(name + " = fn"); return old; } };`,
  )(window, document, window.localStorage, fetchMock) as Console;
}

const notice = () => document.getElementById("refresh-notice") as HTMLElement | null;
const noticeShown = () => Boolean(notice() && !notice()!.hidden && notice()!.textContent!.trim());
const board = () => document.getElementById("tasks")?.textContent ?? "";

let logged: unknown[][] = [];
const loggedText = () => JSON.stringify(logged);

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  window.localStorage.clear();
  document.cookie = `oc_session=${COOKIE_SECRET}`;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push([level, ...args.map(String), ...args]); });
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Signs into workspace A and lets the first load finish cleanly. */
async function signedIn() {
  const h = hub();
  const c = loadConsole(h.fetchMock);
  await vi.advanceTimersByTimeAsync(0);
  await c.enterWorkspace("ws-a");
  await vi.advanceTimersByTimeAsync(300);
  expect(board()).toContain("from ws-a (1)");
  expect(noticeShown()).toBe(false);
  return { ...h, c };
}

const poll = () => vi.advanceTimersByTimeAsync(4000);

describe("a render that throws", () => {
  it("shows the notice, keeps this workspace's content, logs a safe diagnostic, and clears on a good refresh", async () => {
    const { c } = await signedIn();
    const original = c.swap("renderOverview", () => { throw new TypeError(`cannot read ${KEY_SECRET} of ${TASK_SECRET}`); });
    await poll();
    expect(noticeShown()).toBe(true);
    expect(notice()!.textContent).toMatch(/^Couldn't refresh/);
    // Two nodes (phase 2 item A): the line is not a live region; the hidden announcer is, and it says this failure.
    expect(notice()!.getAttribute("aria-live")).toBeNull();
    const announcer = document.getElementById("refresh-announce")!;
    expect(announcer.getAttribute("role")).toBe("status");
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe(notice()!.textContent);
    expect(board()).toContain("from ws-a"); // what this workspace showed stays on screen
    expect(document.getElementById("toast")!.hidden).toBe(true); // a line, not a toast
    // The diagnostic names the step and the error's class, and nothing it was handed.
    expect(loggedText()).toContain("renderOverview");
    expect(loggedText()).toContain("TypeError");
    for (const secret of SECRETS) expect(loggedText()).not.toContain(secret);
    c.swap("renderOverview", original);
    await poll();
    expect(noticeShown()).toBe(false);
  });
});

describe("a fetch that fails", () => {
  for (const failure of [500, "network"] as const) {
    it(`${failure === 500 ? "a 500" : "a network error"} shows the notice, keeps the board, logs the path without its query, and clears on a good refresh`, async () => {
      const { fail } = await signedIn();
      fail["/v1/approvals"] = failure; // requested as /v1/approvals?status=pending
      await poll();
      expect(noticeShown()).toBe(true);
      expect(board()).toContain("from ws-a (2)");
      expect(loggedText()).toContain("/v1/approvals");
      expect(loggedText()).not.toContain("status=pending");
      expect(loggedText()).toContain(failure === 500 ? "Error" : "TypeError");
      for (const secret of SECRETS) expect(loggedText()).not.toContain(secret);
      fail["/v1/approvals"] = undefined;
      await poll();
      expect(noticeShown()).toBe(false);
      expect(board()).toContain("from ws-a (3)"); // Healthy task reads apply on their own poll.
    });
  }
});

describe("a first load that fails", () => {
  it("fails fast: shows the notice, and the skeleton never paints", async () => {
    const h = hub();
    h.fail["/v1/tasks"] = 500;
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(0);
    await c.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(noticeShown()).toBe(true);
    expect(document.querySelectorAll(".skeleton").length).toBe(0);
  });

  it("fails after the skeleton painted: the notice replaces it", async () => {
    const h = hub();
    h.fail["/v1/tasks"] = "network";
    h.hold["/v1/tasks"] = deferred();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(0);
    await c.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelectorAll(".skeleton").length).toBeGreaterThan(0); // still loading
    expect(noticeShown()).toBe(false);
    h.hold["/v1/tasks"]!.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(noticeShown()).toBe(true);
    expect(document.querySelectorAll(".skeleton").length).toBe(0);
    h.fail["/v1/tasks"] = undefined;
    h.hold["/v1/tasks"] = undefined;
    await poll();
    expect(noticeShown()).toBe(false);
    // The failed first task response never reaches the fixture counter; recovery is its first successful answer.
    expect(board()).toContain("from ws-a (1)");
  });
});

describe("no flood", () => {
  it("10 failing polls: one notice, written once, and one diagnostic", async () => {
    const { fail } = await signedIn();
    fail["/v1/tasks"] = 500;
    await poll();
    expect(noticeShown()).toBe(true);
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
    const watched = (m: MutationRecord) => notice()!.contains(m.target) || m.target === notice();
    for (let i = 0; i < 9; i++) await poll();
    await Promise.resolve();
    observer.disconnect();
    expect(document.querySelectorAll("#refresh-notice").length).toBe(1);
    expect(mutations.filter(watched)).toHaveLength(0);
    expect(document.getElementById("toast")!.hidden).toBe(true);
    expect(logged.filter(([level]) => level === "warn" || level === "error")).toHaveLength(1);
  });
});

describe("another workspace's failure is not carried over", () => {
  it("switching workspace hides A's notice and clears A's board", async () => {
    const { fail, c } = await signedIn();
    fail["/v1/agents"] = 500;
    await poll();
    expect(noticeShown()).toBe(true);
    fail["/v1/agents"] = undefined;
    await c.enterWorkspace("ws-b");
    expect(board()).not.toContain("from ws-a");
    expect(noticeShown()).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(board()).toContain("from ws-b");
    expect(noticeShown()).toBe(false);
  });
});

describe("auth and pause are unchanged", () => {
  it("a workspace 401 keeps the valid person session and returns to workspace choices", async () => {
    const { fail } = await signedIn();
    fail["/v1/me"] = 401;
    await poll();
    expect(document.getElementById("workspace-picker")!.hidden).toBe(false);
    expect(document.getElementById("signin")!.hidden).toBe(true);
    expect(document.getElementById("console")!.hidden).toBe(true);
    expect(document.getElementById("workspace-list")!.textContent).toContain("Alpha");
    expect(document.getElementById("workspace-list")!.textContent).toContain("Beta");
    expect(board()).not.toContain("from ws-a");
    expect(noticeShown()).toBe(false);
    expect(logged.filter(([level]) => level === "warn" || level === "error")).toHaveLength(0);
  });

  it("a workspace 423 keeps the valid person session at the picker without retaining its board", async () => {
    const { fail } = await signedIn();
    fail["/v1/me"] = 423;
    await poll();
    expect(document.getElementById("workspace-picker")!.hidden).toBe(false);
    expect(document.getElementById("signin")!.hidden).toBe(true);
    expect(document.getElementById("console")!.hidden).toBe(true);
    expect(document.getElementById("workspace-list")!.textContent).toContain("Alpha");
    expect(document.getElementById("workspace-list")!.textContent).toContain("Beta");
    expect(board()).not.toContain("from ws-a");
    expect(document.getElementById("paused-banner")!.hidden).toBe(true);
    expect(noticeShown()).toBe(false);
    expect(logged.filter(([level]) => level === "warn" || level === "error")).toHaveLength(0);
  });

  it("a 401 from both workspace and person-session reads signs out", async () => {
    const { fail } = await signedIn();
    fail["/v1/me"] = 401;
    fail["/v1/auth/me"] = 401;
    await poll();
    expect(document.getElementById("signin")!.hidden).toBe(false);
    expect(document.getElementById("workspace-picker")!.hidden).toBe(true);
    expect(document.getElementById("console")!.hidden).toBe(true);
    expect(document.getElementById("signin-error")!.textContent).toBe("Your session isn't valid. Sign in again.");
    expect(board()).not.toContain("from ws-a");
    expect(noticeShown()).toBe(false);
  });
});
