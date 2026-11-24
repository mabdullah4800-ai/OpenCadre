// @vitest-environment happy-dom
// Selected Inbox status controls exercise the real app.js selection, consume, refresh and workspace-reset paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const flush = async (n = 50) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const statusPath = (thread: string) => `/v1/messages/${encodeURIComponent(thread)}/status`;

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

type StatusMessage = {
  id: string; kind: string; from: string; to: string; created_at: string;
  delivered_at: string | null; read_at: string | null; body: string;
};
type InboxMessage = {
  id: string; thread_id: string; kind: string; from_agent_id: string; from_agent_name: string;
  body: string; created_at: string; delivered_at: string | null; read_at: string | null;
};
function message(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: "message-a", thread_id: "thread-a", kind: "question", from_agent_id: "worker-a", from_agent_name: "Worker A",
    body: "The selected message body remains recoverable after consume.", created_at: "2026-10-08T12:00:00.000Z",
    delivered_at: null, read_at: null, ...over,
  };
}
function statusMessage(m: InboxMessage, over: Partial<StatusMessage> = {}): StatusMessage {
  return {
    id: m.id, kind: m.kind, from: m.from_agent_name, to: "Pat", created_at: m.created_at,
    delivered_at: m.delivered_at, read_at: m.read_at, body: m.body, ...over,
  };
}

function makeHub() {
  const a = message();
  const b = message({ id: "message-b", thread_id: "thread-b", from_agent_id: "worker-b", from_agent_name: "Worker B", body: "Workspace B selected body." });
  const state = {
    unread: { "ws-a": [a], "ws-b": [b] } as Record<string, InboxMessage[]>,
    statuses: { "thread-a": [statusMessage(a)], "thread-b": [statusMessage(b)] } as Record<string, StatusMessage[]>,
    statusCode: new Map<string, number>(), holds: new Map<string, Deferred>(), calls: [] as Array<{ path: string; method: string; workspace: string }> ,
  };
  const fetchMock = vi.fn(async (path: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => {
    const workspace = init?.headers?.["X-OpenCadre-Workspace"] ?? "";
    const method = init?.method ?? "GET";
    state.calls.push({ path, method, workspace });
    const held = state.holds.get(`${workspace} ${path}`) ?? state.holds.get(`* ${path}`);
    if (held) await held.promise; // ignores AbortSignal so generation suppression is observable
    if (path === "/v1/auth/me") return response(200, { person: { id: "person-a", name: "Pat", email: "pat@example.test" }, workspaces: [
      { orgId: "ws-a", name: "Alpha", role: "owner" }, { orgId: "ws-b", name: "Beta", role: "owner" },
    ] });
    if (path === "/v1/me") return response(200, { orgId: workspace, orgName: workspace, agentId: `operator-${workspace}`, agentName: "Pat", role: "operator", memberRole: "owner", workspace: { paused: false } });
    const statusMatch = path.match(/^\/v1\/messages\/([^/]+)\/status$/);
    if (statusMatch) {
      const code = state.statusCode.get(path) ?? 200;
      return response(code, code === 200 ? { ok: true, messages: state.statuses[decodeURIComponent(statusMatch[1])] ?? [] } : { error: "status unavailable" });
    }
    if (method === "POST" && path === "/v1/messages/consume") {
      const body = JSON.parse(String(init && (init as any).body || "{}"));
      const ids = new Set<string>(body.messageIds ?? []);
      state.unread[workspace] = (state.unread[workspace] ?? []).filter((m) => !ids.has(m.id));
      return response(200, { ok: true, consumed: ids.size });
    }
    if (method === "POST" && /\/v1\/messages\/[^/]+\/reply$/.test(path)) return response(200, { ok: true });
    if (path.startsWith("/v1/approvals")) return response(200, { approvals: [] });
    if (path === "/v1/approval-grants") return response(200, { grants: [] });
    if (path === "/v1/agents") return response(200, { agents: [] });
    if (path.startsWith("/v1/tasks?") && path.includes("limit=0")) return response(200, { counts: { open: 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 } });
    if (path.startsWith("/v1/tasks?") && path.includes("column=")) return response(200, { tasks: [], counts: { open: 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 }, nextCursor: null, projects: [] });
    if (path.startsWith("/v1/tasks/")) return response(404, { error: "missing" });
    if (path.startsWith("/v1/events")) return response(200, { events: [] });
    if (path === "/v1/awareness") return response(200, { items: [], background: {}, cursor: 0 });
    if (path === "/v1/messages?peek=true") return response(200, { messages: state.unread[workspace] ?? [] });
    if (path === "/v1/org/devices") return response(200, { devices: [] });
    if (path.startsWith("/v1/org/sessions")) return response(200, { sessions: [] });
    if (path === "/v1/org/projects") return response(200, { projects: [] });
    if (path === "/v1/reliability/all") return response(200, { reliability: [] });
    if (path === "/v1/onboarding") return response(200, { completed: 1, total: 1, steps: [] });
    return response(200, {});
  });
  return { state, fetchMock, a, b };
}

type Console = { enterWorkspace: (org: string) => Promise<void>; refreshNow: () => Promise<void>; selectTab: (name: string) => void; stopPoll: () => void };
function loadConsole(fetchMock: ReturnType<typeof makeHub>["fetchMock"]): Console {
  const app = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${app}; return { enterWorkspace, refreshNow, selectTab, stopPoll: () => clearTimeout(pollTimer) };`,
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

async function enterSelected() {
  const hub = makeHub();
  const c = loadConsole(hub.fetchMock);
  await vi.advanceTimersByTimeAsync(0);
  await c.enterWorkspace("ws-a");
  await vi.advanceTimersByTimeAsync(300);
  c.stopPoll();
  c.selectTab("inbox");
  await flush();
  const row = document.querySelector('#inbox-list [data-inbox-id="message-a"]') as HTMLElement;
  expect(row, "fixture must render the unread message before selection").toBeTruthy();
  row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flush();
  expect(hub.state.unread["ws-a"]).toHaveLength(0); // actual consume path ran
  expect($("inbox-focus").textContent).toContain(hub.a.body);
  hub.state.calls.length = 0;
  return { ...hub, c };
}
const focusedBody = () => $("inbox-focus").querySelector(".inbox-focus-body")?.textContent ?? "";
const statusView = () => $("inbox-focus").querySelector("[data-message-status]") as HTMLElement | null;
const selectedReply = () => $("inbox-focus").querySelector("textarea") as HTMLTextAreaElement | null;

describe("selected Inbox thread status", () => {
  it("applies delivered/read metadata without replacing the protected body or reply draft/caret", async () => {
    const { state, c, a } = await enterSelected();
    const textarea = selectedReply()!;
    textarea.value = "Draft answer stays here";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(6, 12);
    const deliveredAt = "2026-10-08T12:03:00.000Z";
    const readAt = "2026-10-08T12:04:00.000Z";
    state.statuses[a.thread_id] = [statusMessage(a, { delivered_at: deliveredAt, read_at: readAt })];
    await c.refreshNow();

    expect(focusedBody()).toBe(a.body);
    expect(state.unread["ws-a"]).toHaveLength(0); // the unread endpoint no longer returns this consumed row
    expect(selectedReply()!.value).toBe("Draft answer stays here");
    expect(selectedReply()!.selectionStart).toBe(6);
    expect(selectedReply()!.selectionEnd).toBe(12);
    expect(document.activeElement).toBe(selectedReply());
    expect(state.calls.some((call) => call.path === statusPath(a.thread_id))).toBe(true);
    const current = statusView();
    expect(current).not.toBeNull();
    expect(current!.dataset.state).toBe("current");
    expect(current!.textContent).toMatch(/delivered/i);
    expect(current!.textContent).toMatch(/read/i);
  });

  it("keeps a consumed selected body while the unread response omits it and status is bounded-pending", async () => {
    const { state, c, a } = await enterSelected();
    const held = deferred();
    state.holds.set(`ws-a ${statusPath(a.thread_id)}`, held);
    const flight = c.refreshNow();
    await flush();
    expect(state.unread["ws-a"]).toHaveLength(0); // selected copy is retained independently of the unread list
    expect(focusedBody()).toBe(a.body);
    expect(state.calls.some((call) => call.path === statusPath(a.thread_id))).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await flight;
    expect(focusedBody()).toBe(a.body);
    expect(statusView()?.dataset.state).toBe("stale");
    held.resolve();
  });

  it("retains the body but marks status stale and the reply decision explicitly uncertain on transient failure", async () => {
    const { state, c, a } = await enterSelected();
    const textarea = selectedReply()!;
    const send = $("inbox-focus").querySelector("button[type=submit]") as HTMLButtonElement;
    expect(send.disabled).toBe(false); // positive: current status permits a deliberate reply
    textarea.value = "Retained answer during status outage";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(4, 12);
    state.statusCode.set(statusPath(a.thread_id), 503);
    await c.refreshNow();
    expect(focusedBody()).toBe(a.body);
    expect(selectedReply()).not.toBeNull();
    expect(selectedReply()).toBe(textarea);
    expect(textarea.value).toBe("Retained answer during status outage");
    expect(textarea.selectionStart).toBe(4);
    expect(textarea.selectionEnd).toBe(12);
    expect(document.activeElement).toBe(textarea);
    expect(send.disabled).toBe(true);
    const stale = statusView();
    expect(stale).not.toBeNull();
    expect(stale!.dataset.state).toBe("stale");
    expect(stale!.textContent).toMatch(/status.*(unavailable|unknown|stale)/i);
    expect(state.calls.some(call => call.method === "POST" && call.path.endsWith("/reply"))).toBe(false);
    state.statusCode.delete(statusPath(a.thread_id));
    await c.refreshNow();
    expect(statusView()?.dataset.state).toBe("current");
    expect(send.disabled).toBe(false);
    expect(focusedBody()).toBe(a.body);
    expect(selectedReply()).toBe(textarea);
    expect(textarea.value).toBe("Retained answer during status outage");
    expect(textarea.selectionStart).toBe(4);
    expect(textarea.selectionEnd).toBe(12);
    expect(document.activeElement).toBe(textarea);
    expect(state.calls.some(call => call.method === "POST" && call.path.endsWith("/reply"))).toBe(false);
  });

  it.each([403, 404])("withdraws protected selected body and reply action when thread status returns %i", async (status) => {
    const { state, c, a } = await enterSelected();
    expect(focusedBody()).toBe(a.body);
    expect(selectedReply()).not.toBeNull();
    state.statusCode.set(statusPath(a.thread_id), status);
    await c.refreshNow();
    expect(state.calls.some((call) => call.path === statusPath(a.thread_id))).toBe(true);
    expect(focusedBody()).not.toContain(a.body);
    expect(selectedReply()).toBeNull();
    expect($("inbox-focus").textContent).not.toContain("Send answer");
  });

  it("does not let an old workspace status response replace the new workspace selection", async () => {
    const { state, c, a, b } = await enterSelected();
    const held = deferred();
    state.holds.set(`ws-a ${statusPath(a.thread_id)}`, held);
    const oldRefresh = c.refreshNow();
    let oldRefreshSettled = false;
    void oldRefresh.then(() => { oldRefreshSettled = true; });
    await flush();
    const enteredB = c.enterWorkspace("ws-b");
    await enteredB;
    c.selectTab("inbox");
    await vi.advanceTimersByTimeAsync(100);
    const bRow = document.querySelector('#inbox-list [data-inbox-id="message-b"]') as HTMLElement;
    expect(bRow).toBeTruthy();
    bRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(oldRefreshSettled).toBe(true);
    expect(focusedBody()).toBe(b.body);
    held.resolve();
    await flush(100);
    expect(focusedBody()).toBe(b.body);
    expect($("inbox-focus").textContent).not.toContain("selected message body remains recoverable");
    expect(state.calls.some((call) => call.path === statusPath(a.thread_id))).toBe(true);
  });
});
