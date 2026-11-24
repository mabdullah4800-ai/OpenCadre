// @vitest-environment happy-dom
// Codex on #657 at 067eabbe (privacy): with a message from workspace A open in the Inbox, entering workspace B while B's
// first load failed left A's full message and its reply control on screen, under B. The switch cleared the task board and
// the Agents lists but not the Inbox list, its focus pane, the open message, a reply draft or the caches a later local
// re-render reads, and the old workspace's inbox was only cleared by a SUCCESSFUL load. The same happened after signing
// out and signing back in as someone else on a shared browser. Now every change of whose data the console shows
// (a workspace switch, sign-out, sign-in) empties everything that belongs to the previous workspace at once, whether or
// not the new one ever loads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => { let r!: () => void; const promise = new Promise<void>((res) => { r = res; }); return { promise, resolve: r }; };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

// Everything workspace A (and its person) owns that the console can show. None of it may survive into B.
const A_MESSAGE = "A-PRIVATE-MESSAGE the deploy password rotates tonight";
const A_APPROVAL = "A-PRIVATE-APPROVAL rm -rf build";
const A_TASK = "A-PRIVATE-TASK";
const A_MARKERS = ["A-PRIVATE-MESSAGE", "A-PRIVATE-APPROVAL", "A-PRIVATE-TASK", "Grace-from-A"];

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code }); }
  close() { this.readyState = 3; }
}

/** Workspace A has one unread message, one pending approval and one task. Workspace B's /v1/tasks answers 500, at once
 * or (with `holdB`) only when released. `who` is the person /v1/auth/me answers for. `pageAtFirstB` is what the page
 * showed when the first request for B went out. */
function hub() {
  const state = { who: "ada", holdB: undefined as Deferred | undefined, pageAtFirstB: undefined as string | undefined, authHold: undefined as Deferred | undefined, onlyB: false, memberRole: "owner", agentRole: "operator", meRefused: false, authExpired: false };
  const fetchMock = vi.fn(async (path: string, init?: { method?: string; headers?: Record<string, string> }) => {
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "none";
    if (ws === "ws-b" && state.pageAtFirstB === undefined) state.pageAtFirstB = document.body.textContent ?? "";
    if (path === "/v1/auth/me") {
      const identity = state.authExpired ? json(401, { error: "session expired" }) : state.who === "ada"
        ? json(200, { person: { id: "p1", name: "Ada", email: "ada@example.com" }, workspaces: [
          ...(state.onlyB ? [] : [{ orgId: "ws-a", name: "Alpha", role: state.memberRole }]), { orgId: "ws-b", name: "Beta", role: "owner" }] })
        : json(200, { person: { id: "p2", name: "Bob", email: "bob@example.com" }, workspaces: [{ orgId: "ws-b", name: "Beta", role: "owner" }] });
      const hold = state.authHold; state.authHold = undefined;
      if (hold) await hold.promise;
      return identity;
    }
    if (init?.method && init.method !== "GET") return json(200, {});
    const bare = path.split("?")[0]; // the board reads one page per column (tasks tranche 2)
    if (ws === "ws-b" && bare === "/v1/tasks") {
      if (state.holdB) await state.holdB.promise;
      return json(500, { error: "boom" });
    }
    const a = ws === "ws-a";
    if (path === "/v1/me") return state.meRefused && a ? json(403, { error: "not a member of this workspace" }) : json(200, { orgId: ws, orgName: ws, agentId: `me-${ws}`, agentName: "Ada", role: state.agentRole, memberRole: a ? state.memberRole : "owner", workspace: { paused: false } });
    if (path === "/v1/agents") return json(200, { agents: [] });
    if (path === "/v1/approvals?status=pending") {
      return json(200, { approvals: a ? [{ id: "ap-a", status: "pending", category: "shell", command: A_APPROVAL, risk: "high",
        requested_by_agent_id: "ag-a", requested_by_agent_name: "Grace-from-A", created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString() }] : [] });
    }
    if (path.startsWith("/v1/approvals")) return json(200, { approvals: [] });
    if (path === "/v1/approval-grants") return json(200, { grants: [] });
    if (bare === "/v1/tasks") {
      const onPage = a && path.includes("column=open");
      return json(200, { tasks: onPage ? [{ id: "t-a", title: A_TASK, status: "open", created_by_agent_name: "Grace-from-A", created_at: new Date().toISOString() }] : [] });
    }
    if (path.startsWith("/v1/events")) return json(200, { events: [] });
    if (path === "/v1/awareness") return json(200, { items: [], background: {}, cursor: 0 });
    if (path.startsWith("/v1/messages")) {
      return json(200, { messages: a ? [{ id: "m-a", thread_id: "th-a", kind: "message", from_agent_name: "Grace-from-A", body: A_MESSAGE,
        priority: "normal", created_at: new Date().toISOString(), read_at: null }] : [] });
    }
    if (path === "/v1/org/devices") return json(200, { devices: [] });
    if (path.startsWith("/v1/org/sessions")) return json(200, { sessions: [] });
    if (path === "/v1/org/projects") return json(200, { projects: [] });
    if (path === "/v1/onboarding") return json(200, { completed: 1, total: 1, steps: [] });
    return json(200, {});
  });
  return { fetchMock, state };
}

type Console = { enterWorkspace: (orgId: string) => Promise<void>; signOut: (message?: string) => void; rerenderInbox: () => void; refreshNow: () => Promise<void>; stopPoll: () => void };
function loadConsole(fetchMock: ReturnType<typeof hub>["fetchMock"]): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { enterWorkspace, signOut, rerenderInbox, refreshNow, stopPoll: () => clearTimeout(pollTimer) };`,
  )(window, document, window.localStorage, fetchMock) as Console;
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  window.localStorage.clear();
  window.sessionStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("confirm", () => true);
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const inbox = () => document.querySelector('[data-panel="inbox"]') as HTMLElement;
const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();

/** Workspace A loaded, its message opened into the focus pane, and a reply started in the list with a draft. */
async function withAMessageOpen() {
  const h = hub();
  const c = loadConsole(h.fetchMock);
  await vi.advanceTimersByTimeAsync(0);
  await c.enterWorkspace("ws-a");
  await vi.advanceTimersByTimeAsync(300);
  const strip = document.querySelector('#inbox-list .strip[data-inbox-id="m-a"]') as HTMLElement;
  strip.click(); // selects it into #inbox-focus and opens it
  await vi.advanceTimersByTimeAsync(10);
  [...document.querySelectorAll("#inbox-list button")].find((b) => b.textContent === "Reply")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const draft = document.querySelector("#inbox-list textarea") as HTMLTextAreaElement;
  draft.value = "A-PRIVATE-MESSAGE draft reply";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  // The precondition is real: A's message, its reply controls and the draft are all on screen.
  expect(document.getElementById("inbox-focus")!.textContent).toContain(A_MESSAGE);
  expect(document.querySelector("#inbox-focus textarea")).not.toBeNull();
  expect(document.getElementById("inbox-list")!.textContent).toContain("A-PRIVATE-MESSAGE");
  expect(document.querySelector("#inbox-list .inbox-reply-form")).not.toBeNull();
  return { ...h, c };
}

function expectNothingOfA(when: string) {
  for (const surface of ["inbox-list", "inbox-focus", "inbox-mentions", "clearances", "history", "grants"]) {
    const text = document.getElementById(surface)?.textContent ?? "";
    for (const marker of A_MARKERS) expect(text, `${when}: #${surface} still shows ${marker}`).not.toContain(marker);
  }
  expect(inbox().querySelector("textarea"), `${when}: a reply box is still in the Inbox`).toBeNull();
  expect(inbox().querySelector(".inbox-focus-reply, .inbox-reply-form"), `${when}: a reply form is still in the Inbox`).toBeNull();
  const buttons = [...inbox().querySelectorAll("button")].map((b) => b.textContent);
  expect(buttons, `${when}: a reply control is still in the Inbox`).not.toContain("Send reply");
  expect(buttons, `${when}: a reply control is still in the Inbox`).not.toContain("Reply");
  const page = document.body.textContent ?? "";
  for (const marker of A_MARKERS) expect(page, `${when}: the page still shows ${marker}`).not.toContain(marker);
  expect(document.title, `${when}: the tab title still counts A's approvals`).toBe("OpenCadre Console");
}

/** Local view changes that re-read the console's own caches, never the hub. */
async function toggleViews() {
  click('#inbox-filter-bar .filter-chip[data-filter="messages"]');
  click('#inbox-filter-bar .filter-chip[data-filter="all"]');
  click('.inbox-view-tab[data-inbox-view="history"]');
  click('.inbox-view-tab[data-inbox-view="queue"]');
  await vi.advanceTimersByTimeAsync(1500);
}

type Timing = "fast" | "late" | "pending";
const TIMINGS: Record<Timing, string> = { fast: "fails at once", late: "fails after the skeleton painted", pending: "is still pending" };

async function afterB(c: Console, state: ReturnType<typeof hub>["state"], timing: Timing, enter: () => Promise<void>) {
  if (timing !== "fast") state.holdB = deferred(); // "pending" is never released
  await enter();
  // Cleared at the change of identity itself, before any request for B went out.
  for (const marker of A_MARKERS) expect(state.pageAtFirstB, `when B's first request went out, the page still showed ${marker}`).not.toContain(marker);
  if (timing !== "fast") {
    await vi.advanceTimersByTimeAsync(300); // B's first load is still out; the skeleton timer has run
    expectNothingOfA("while B's first load is pending");
    if (timing === "late") state.holdB!.resolve();
  }
  await vi.advanceTimersByTimeAsync(300);
  if (timing !== "pending") expect(document.getElementById("refresh-notice")!.textContent).toMatch(/^Couldn't refresh/);
  expectNothingOfA(timing === "pending" ? "with B's first load still pending" : "after B's first load failed");
  c.rerenderInbox();
  await toggleViews();
  expectNothingOfA("after local view toggles");
}

describe("a workspace switch clears the previous workspace's inbox at once, whether the new one loads, fails or hangs", () => {
  for (const timing of ["fast", "late", "pending"] as const) {
    it(`A to B with a message open; B's first load ${TIMINGS[timing]}`, async () => {
      const { c, state } = await withAMessageOpen();
      await afterB(c, state, timing, () => c.enterWorkspace("ws-b"));
    });
  }
});

describe("signing out and in as someone else clears the previous person's inbox", () => {
  for (const timing of ["fast", "late", "pending"] as const) {
    it(`Ada with a message open signs out; Bob signs in and his first load ${TIMINGS[timing]}`, async () => {
      const { c, state } = await withAMessageOpen();
      c.signOut();
      await vi.advanceTimersByTimeAsync(10);
      for (const marker of A_MARKERS) expect(document.body.textContent, `signed out, the page still holds ${marker}`).not.toContain(marker);
      state.who = "bob";
      await afterB(c, state, timing, () => c.enterWorkspace("ws-b"));
    });
  }
});

describe("within one workspace nothing is lost", () => {
  it("a failed refresh in A keeps A's open message and the draft", async () => {
    const { c, fetchMock } = await withAMessageOpen();
    fetchMock.mockImplementationOnce(async () => { throw new TypeError("offline"); });
    await vi.advanceTimersByTimeAsync(4000);
    expect(document.getElementById("inbox-focus")!.textContent).toContain(A_MESSAGE);
    expect((document.querySelector("#inbox-list textarea") as HTMLTextAreaElement).value).toBe("A-PRIVATE-MESSAGE draft reply");
    void c;
  });
});

const signoutWrites = (fetchMock: ReturnType<typeof hub>["fetchMock"]) => fetchMock.mock.calls.filter(([path, init]) => path === "/v1/auth/signout" && init?.method === "POST");
const quarantines = () => Object.keys(window.localStorage).filter((k) => k.startsWith("opencadre.signOutQuarantine.v1.entry."));

describe("live workspace access changes preserve valid person sign-in", () => {
  it("removal clears private A synchronously while identity reread hangs; B remains selectable without cookie sign-out", async () => {
    const { c, state, fetchMock } = await withAMessageOpen(); c.stopPoll();
    state.onlyB = true; const hold = deferred(); state.authHold = hold;
    FakeSocket.instances.at(-1)!.serverClose(4004);
    expectNothingOfA("at access close before an auth answer");
    expect(quarantines()).toEqual([]); expect(signoutWrites(fetchMock)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300); expectNothingOfA("while identity hangs");
    hold.resolve(); await vi.advanceTimersByTimeAsync(300);
    expect(document.getElementById("workspace-picker")!.hidden).toBe(false);
    expect(document.getElementById("workspace-list")!.textContent).toContain("Beta");
    expect(document.getElementById("workspace-list")!.textContent).not.toContain("Alpha");
    await c.enterWorkspace("ws-b"); c.stopPoll(); await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.instances.at(-1)!.url).toContain("workspace=ws-b");
    expect(signoutWrites(fetchMock)).toHaveLength(0); expect(quarantines()).toEqual([]);
  });
  it("valid role close clears privileged caches and reconnects same workspace under real new membership role", async () => {
    const { c, state, fetchMock } = await withAMessageOpen(); c.stopPoll();
    const old = FakeSocket.instances.at(-1)!; const count = FakeSocket.instances.length;
    state.memberRole = "member"; state.agentRole = "agent";
    old.serverClose(4004); expectNothingOfA("role changes before fresh authorized reads");
    await vi.advanceTimersByTimeAsync(300); c.stopPoll();
    expect(FakeSocket.instances).toHaveLength(count + 1);
    expect(FakeSocket.instances.at(-1)!.url).toContain("workspace=ws-a");
    expect(signoutWrites(fetchMock)).toHaveLength(0); expect(quarantines()).toEqual([]);
  });
  it("pause close clears A and shows valid workspace choices without an automatic paused-workspace reconnect", async () => {
    const { c, fetchMock } = await withAMessageOpen(); c.stopPoll();
    const count = FakeSocket.instances.length;
    FakeSocket.instances.at(-1)!.serverClose(4003); expectNothingOfA("workspace pause");
    await vi.advanceTimersByTimeAsync(6000);
    expect(FakeSocket.instances).toHaveLength(count);
    expect(document.getElementById("workspace-picker")!.hidden).toBe(false);
    expect(document.getElementById("workspace-list")!.textContent).toContain("Beta");
    expect(signoutWrites(fetchMock)).toHaveLength(0); expect(quarantines()).toEqual([]);
  });
  it("obsolete access reconciliation and old socket callbacks cannot clear a newer B entry", async () => {
    const { c, state, fetchMock } = await withAMessageOpen(); c.stopPoll();
    const old = FakeSocket.instances.at(-1)!; const hold = deferred(); state.authHold = hold;
    old.serverClose(4004); expectNothingOfA("old A cutoff before new entry"); await vi.advanceTimersByTimeAsync(1);
    await c.enterWorkspace("ws-b"); c.stopPoll(); await vi.advanceTimersByTimeAsync(300);
    const current = FakeSocket.instances.at(-1)!; expect(current.url).toContain("workspace=ws-b");
    hold.resolve(); old.serverClose(4001); old.onopen?.(); old.onmessage?.({ data: "{}" });
    await vi.advanceTimersByTimeAsync(6000);
    expect(document.getElementById("console")!.hidden).toBe(false);
    expect(FakeSocket.instances.at(-1)).toBe(current); expect(current.readyState).not.toBe(3);
    expect(signoutWrites(fetchMock)).toHaveLength(0); expect(quarantines()).toEqual([]);
  });
  it("required me403 clears all workspace data before a held identity check, without turning scoped refusals into sign-out", async () => {
    const { c, state, fetchMock } = await withAMessageOpen(); c.stopPoll();
    const hold = deferred(); state.authHold = hold; state.onlyB = true; state.meRefused = true;
    void c.refreshNow(); await vi.advanceTimersByTimeAsync(1);
    expectNothingOfA("me refused before auth settles");
    expect(quarantines()).toEqual([]); expect(signoutWrites(fetchMock)).toHaveLength(0);
    hold.resolve(); await vi.advanceTimersByTimeAsync(300);
    expect(document.getElementById("workspace-picker")!.hidden).toBe(false);
    expect(document.getElementById("workspace-list")!.textContent).toContain("Beta");
  });
});

describe("access reconciliation ownership and recovery", () => {
  it("bounds a hanging identity read, keeps workspace empty and retries without cookie invalidation", async () => {
    const { c, state, fetchMock } = await withAMessageOpen(); c.stopPoll();
    const old = FakeSocket.instances.at(-1)!; const count = FakeSocket.instances.length;
    const hold = deferred(); state.authHold = hold;
    old.serverClose(4004); expectNothingOfA("before hung auth check");
    await vi.advanceTimersByTimeAsync(16000);
    expectNothingOfA("after nominal auth read budget");
    expect(document.getElementById("workspace-list")!.textContent).toContain("Couldn't check workspace access");
    expect(FakeSocket.instances).toHaveLength(count);
    expect(quarantines()).toEqual([]); expect(signoutWrites(fetchMock)).toHaveLength(0);
    state.onlyB = true;
    const retry = [...document.querySelectorAll<HTMLButtonElement>("#workspace-list button")].find((b) => b.textContent === "Retry")!;
    retry.click(); await vi.advanceTimersByTimeAsync(300);
    hold.resolve(); await vi.advanceTimersByTimeAsync(300);
    expect(document.getElementById("workspace-list")!.textContent).toContain("Beta");
    expect(document.getElementById("workspace-list")!.textContent).not.toContain("Alpha");
    expect(quarantines()).toEqual([]); expect(signoutWrites(fetchMock)).toHaveLength(0);
  });
  it("late expired-session auth answer cannot sign out a newer same-workspace entry", async () => {
    const { c, state, fetchMock } = await withAMessageOpen(); c.stopPoll();
    const old = FakeSocket.instances.at(-1)!; const hold = deferred();
    state.authExpired = true; state.authHold = hold; old.serverClose(4001);
    expectNothingOfA("old expired socket before newer entry"); await vi.advanceTimersByTimeAsync(1);
    state.authExpired = false; await c.enterWorkspace("ws-a"); c.stopPoll(); await vi.advanceTimersByTimeAsync(300);
    const current = FakeSocket.instances.at(-1)!;
    hold.resolve(); old.serverClose(4001); await vi.advanceTimersByTimeAsync(6000);
    expect(document.getElementById("console")!.hidden).toBe(false);
    expect(FakeSocket.instances.at(-1)).toBe(current); expect(current.readyState).not.toBe(3);
    expect(quarantines()).toEqual([]); expect(signoutWrites(fetchMock)).toHaveLength(0);
  });
  it("a current expired person session follows existing sign-in cleanup rather than retrying a workspace socket", async () => {
    const { c, state } = await withAMessageOpen(); c.stopPoll();
    const count = FakeSocket.instances.length; state.authExpired = true;
    FakeSocket.instances.at(-1)!.serverClose(4001);
    expectNothingOfA("expired session immediately"); await vi.advanceTimersByTimeAsync(300);
    expect(document.getElementById("signin")!.hidden).toBe(false);
    expect(document.getElementById("signin-error")!.textContent).toContain("session isn't valid");
    expect(FakeSocket.instances).toHaveLength(count);
  });
  it("a scoped source403 leaves still-authorized A and its draft usable", async () => {
    const { c, fetchMock } = await withAMessageOpen(); c.stopPoll();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (path, init) => path.startsWith("/v1/events") ? json(403, { error: "source forbidden" }) : original(path, init));
    await c.refreshNow(); await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById("console")!.hidden).toBe(false);
    expect(document.getElementById("inbox-focus")!.textContent).toContain(A_MESSAGE);
    expect((document.querySelector("#inbox-list textarea") as HTMLTextAreaElement).value).toBe("A-PRIVATE-MESSAGE draft reply");
    expect(quarantines()).toEqual([]); expect(signoutWrites(fetchMock)).toHaveLength(0);
  });
});

describe("valid cookie after a socket authentication refusal", () => {
  it("keeps valid identity at picker without an automatic refusal-reconnect loop", async () => {
    const { c, fetchMock } = await withAMessageOpen(); c.stopPoll();
    const count = FakeSocket.instances.length;
    FakeSocket.instances.at(-1)!.serverClose(4001); expectNothingOfA("socket refuses before cookie check");
    await vi.advanceTimersByTimeAsync(6000);
    expect(document.getElementById("workspace-picker")!.hidden).toBe(false);
    expect(document.getElementById("workspace-list")!.textContent).toContain("Alpha");
    expect(document.getElementById("workspace-list")!.textContent).toContain("Beta");
    expect(FakeSocket.instances).toHaveLength(count);
    expect(quarantines()).toEqual([]); expect(signoutWrites(fetchMock)).toHaveLength(0);
  });
});
