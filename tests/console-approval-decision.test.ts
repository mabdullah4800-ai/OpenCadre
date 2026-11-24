// @vitest-environment happy-dom
// Whole shipped app/HTML, real UI actions, controlled session REST and socket responses.
// These are local regression controls, not a real browser/production approval receipt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const approval = (id: string, action = `request ${id}`) => ({ id, action, status: "pending", risk: "high", category: "shell",
  requested_by_agent_id: "builder", requested_by_agent_name: "Builder", created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 600_000).toISOString(), decided_by_person_name: null as string | null, decided_at: null as string | null });
type Approval = ReturnType<typeof approval>;
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  frame() { this.onmessage?.({ data: JSON.stringify({ type: "workspace.changed" }) }); }
  close() { this.readyState = 3; }
}
function hub() {
  const state = { records: { "ws-a": [approval("a1"), approval("a2")], "ws-b": [approval("a1", "B current request")] } as Record<string, Approval[]>,
    tasksHold: null as ReturnType<typeof deferred> | null, grantsHold: null as ReturnType<typeof deferred> | null,
    decisionHold: null as ReturnType<typeof deferred> | null,
    pendingHold: null as ReturnType<typeof deferred> | null, singleHold: null as ReturnType<typeof deferred> | null,
    pendingBodyHold: null as ReturnType<typeof deferred> | null, authHold: null as ReturnType<typeof deferred> | null, meStatus: 200,
    decisionStatus: 200, pendingStatus: 200, tasksFail: false, messages: [] as Record<string, unknown>[], grants: [] as Record<string, unknown>[] };
  const fetchMock = vi.fn(async (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "ws-a";
    if (path === "/v1/auth/me") {
      if (state.authHold) await state.authHold.promise;
      return json(200, { person: { id: "person", name: "Ada", email: "ada@example.com" },
        workspaces: [{ orgId: "ws-a", name: "Alpha", role: "owner" }, { orgId: "ws-b", name: "Beta", role: "owner" }] });
    }
    const records = state.records[ws] ?? [];
    const match = path.match(/^\/v1\/approvals\/([^/]+)\/decide$/);
    if (match && init?.method === "POST") {
      const hold = state.decisionHold;
      if (hold) await hold.promise;
      if (state.decisionStatus !== 200) return json(state.decisionStatus, { ok: false, error: "decision refused" });
      const row = records.find(a => a.id === match[1])!;
      if (row.status !== "pending") return json(409, { ok: false, error: "already decided" });
      row.status = JSON.parse(init.body!).decision === "approve" ? "approved" : "denied";
      row.decided_by_person_name = "Ada"; row.decided_at = new Date().toISOString();
      const minutes = JSON.parse(init.body!).grantMinutes;
      const grant = row.status === "approved" && minutes > 0 ? { id: `g-${row.id}`, agent_id: "builder", agent_name: "Builder", category: "shell",
        granted_by_person_name: "Ada", expires_at: new Date(Date.now() + minutes * 60_000).toISOString() } : null;
      if (grant) state.grants.push(grant);
      return json(200, { ok: true, approval: { ...row, decided_by_person_name: "Ada" }, ...(grant ? { grant } : {}) });
    }
    if (path === "/v1/approvals?status=pending") {
      const captured = records.filter(a => a.status === "pending").map(a => ({ ...a }));
      const hold = state.pendingHold; if (hold) await hold.promise;
      const bodyHold = state.pendingBodyHold;
      if (bodyHold) return { ...json(200, {}), json: async () => { await bodyHold.promise; return { approvals: captured }; } };
      return state.pendingStatus === 200 ? json(200, { approvals: captured }) : json(state.pendingStatus, { error: "pending read unavailable" });
    }
    if (path === "/v1/approvals") return json(200, { approvals: records.map(a => ({ ...a })) });
    if (path === "/v1/approval-grants") {
      const hold = state.grantsHold; if (hold) await hold.promise;
      return json(200, { grants: state.grants.map(g => ({ ...g })) });
    }
    if (path.startsWith("/v1/approvals/")) {
      const captured = { ...records.find(a => a.id === path.split("/").at(-1)), decided_by_person_name: "Ada" };
      const hold = state.singleHold; if (hold) await hold.promise;
      return json(200, { approval: captured });
    }
    if (path.startsWith("/v1/tasks")) {
      const hold = state.tasksHold;
      if (hold) await hold.promise;
      if (state.tasksFail) return json(500, { error: "tasks unavailable" });
    }
    if (path.startsWith("/v1/messages") && (!init?.method || init.method === "GET")) return json(200, { messages: state.messages });
    if (init?.method && init.method !== "GET") return json(200, { ok: true });
    if (path === "/v1/me" && state.meStatus !== 200) return json(state.meStatus, { error: "not a member of this workspace" });
    const identity = { orgId: ws, orgName: ws, agentId: `person-${ws}`, agentName: "Ada", role: "operator", memberRole: "owner", workspace: { paused: false } };
    return json(200, hubReadBody(path, identity) ?? {});
  });
  return { state, fetchMock };
}
function loadConsole(fetchMock: ReturnType<typeof hub>["fetchMock"]) {
  const source = readFileSync(resolve("public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${source}; return { enterWorkspace, refreshNow,
    showFocusedApproval, selectTab, connectLiveWs, schedulePoll, signOut,
    approvalState: () => ({ scopes: refreshReadScopes.size, fence: approvalReadDecisions }),
    stopPoll: () => clearTimeout(pollTimer) };`)(window, document, localStorage, fetchMock) as {
      enterWorkspace: (id: string) => Promise<void>; refreshNow: () => Promise<void>;
      showFocusedApproval: (id: string) => Promise<void>; selectTab: (id: string) => void;
      connectLiveWs: () => void; schedulePoll: () => void; stopPoll: () => void;
      signOut: () => void; approvalState: () => { scopes: number; fence: unknown };
    };
}
beforeEach(() => {
  document.documentElement.innerHTML = readFileSync(resolve("public/app/index.html"), "utf8")
    .replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  localStorage.clear(); sessionStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("confirm", () => true);
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
const queue = (id: string) => document.querySelector(`#clearances [data-inbox-id="${id}"]`);
const number = () => $('[data-tile="approvals"] .home-tile-number').textContent;
const deny = (scope: string) => $(scope + " .btn-halt").click();
async function start() {
  const h = hub(); const c = loadConsole(h.fetchMock);
  await vi.advanceTimersByTimeAsync(0); await c.enterWorkspace("ws-a"); await vi.advanceTimersByTimeAsync(300);
  expect(queue("a1")).not.toBeNull(); expect(queue("a2")).not.toBeNull();
  expect(number()).toBe("2"); expect(document.title).toBe("(2) OpenCadre Console");
  expect($("#inbox-focus").textContent).toContain("request a1");
  return { ...h, c };
}
function expectOnePending() {
  expect(queue("a1"), "queue copy must be removed, not merely unregistered").toBeNull();
  expect(queue("a2")).not.toBeNull();
  expect($("#inbox-focus").textContent).not.toContain("request a1");
  expect(number()).toBe("1"); expect($("#inbox-badge").textContent).toBe("1");
  expect(document.title).toBe("(1) OpenCadre Console");
  expect($("#overview-attention").textContent).not.toContain("request a1");
}
describe("successful session decisions reconcile every approval copy without reload", () => {
  it("Deny in selected pane removes queue copy/counts despite unrelated required GET failure", async () => {
    const { state, fetchMock } = await start(); state.tasksFail = true;
    deny("#inbox-focus"); await vi.advanceTimersByTimeAsync(300);
    expect(state.records["ws-a"][0].status).toBe("denied"); expectOnePending();
    expect(fetchMock.mock.calls.find(([p]) => p.endsWith("/decide"))?.[1]?.headers?.["X-OpenCadre-Workspace"]).toBe("ws-a");
  });
  it("keyboard hold-to-Approve reconciles on successful response while task read hangs", async () => {
    const { state } = await start(); state.tasksHold = deferred();
    const button = $("#inbox-focus .hold"); button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await vi.advanceTimersByTimeAsync(901);
    expect(state.records["ws-a"][0].status).toBe("approved"); expectOnePending();
  });
  it("queue decision clears the corresponding selected pane and cached counts immediately", async () => {
    const { state } = await start(); state.tasksHold = deferred();
    deny('#clearances [data-inbox-id="a1"]'); await vi.advanceTimersByTimeAsync(0); expectOnePending();
  });
  it("notification-overlay decision also removes the separate queue copy", async () => {
    const { state, c } = await start(); await c.showFocusedApproval("a1"); state.tasksFail = true;
    deny("#focused-approval-overlay"); await vi.advanceTimersByTimeAsync(300);
    expect($("#focused-approval-overlay").hidden).toBe(true); expectOnePending();
  });
  it("a pending snapshot captured before a decision cannot resurrect it when slower reads finish", async () => {
    const { state, c } = await start(); state.tasksHold = deferred(); const hold = state.tasksHold;
    const oldRead = c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    deny("#inbox-focus"); await vi.advanceTimersByTimeAsync(0);
    hold.release(); state.tasksHold = null; await oldRead;
    expectOnePending();
    state.records["ws-a"].push(approval("a3")); await vi.advanceTimersByTimeAsync(300);
    expect(queue("a3"), "next authoritative read still admits genuinely new requests").not.toBeNull();
    expect(queue("a1")).toBeNull(); expect(number()).toBe("2");
  });
  it("an older pending response arriving after acknowledgement cannot resurrect the card", async () => {
    const { state, c } = await start(); state.pendingHold = deferred(); const held = state.pendingHold;
    const read = c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    deny("#inbox-focus"); await vi.advanceTimersByTimeAsync(0); expectOnePending();
    state.pendingHold = null; held.release(); await read; expectOnePending();
  });
  it("successful decision updates visible History immediately and survives an older history batch", async () => {
    const { state, c } = await start(); c.selectTab("inbox"); $('.inbox-view-tab[data-inbox-view="history"]').click();
    await vi.advanceTimersByTimeAsync(300); await c.showFocusedApproval("a1");
    state.tasksHold = deferred(); const held = state.tasksHold; const read = c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    deny("#focused-approval-overlay"); await vi.advanceTimersByTimeAsync(0);
    expect($("#history").textContent).toContain("denied"); expect($("#history").textContent).toContain("by Ada");
    state.tasksHold = null; held.release(); await read;
    expect($("#history").textContent).toContain("request a1"); expect($("#history").textContent).toContain("by Ada");
    await vi.advanceTimersByTimeAsync(300); expect($("#history").textContent).toContain("request a1"); expectOnePending();
  });
  it("the notification's approval card offers the same visible scope choice, Once by default, and sends the one picked", async () => {
    const { fetchMock, c } = await start(); await c.showFocusedApproval("a1");
    const card = $("#focused-approval-overlay") as HTMLElement;
    expect(card.querySelector("select")).toBeNull();
    expect(card.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("What this approval allows");
    expect([...card.querySelectorAll('[role="radiogroup"] label')].map(l => l.textContent)).toEqual(["Once", "30 min", "2 h", "8 h"]);
    expect((card.querySelector('[role="radiogroup"] input:checked') as HTMLInputElement).value).toBe("0");
    expect(card.querySelector(".hold .label")?.textContent).toBe("Hold to approve once");
    const thirty = card.querySelector('[role="radiogroup"] input[value="30"]') as HTMLInputElement;
    thirty.checked = true; thirty.dispatchEvent(new Event("change", { bubbles: true }));
    expect([...card.querySelectorAll(".grant-chip")].map(n => n.textContent).slice(0, 3)).toEqual(["Builder", "shell", "no project"]);
    expect(card.querySelector(".hold .label")?.textContent).toBe("Hold to approve for 30 min");
    card.querySelector(".hold")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.advanceTimersByTimeAsync(901);
    const sent = fetchMock.mock.calls.find(([p]) => p.endsWith("/decide"))?.[1]?.body;
    expect(JSON.parse(sent!)).toMatchObject({ decision: "approve", grantMinutes: 30 });
  });
  it("a person-issued timed approval updates grants/counts before unrelated reads can finish", async () => {
    const { state } = await start(); state.tasksHold = deferred();
    const scope = $('#inbox-focus [role="radiogroup"] input[value="30"]') as HTMLInputElement; scope.checked = true; scope.dispatchEvent(new Event("change", { bubbles: true }));
    $("#inbox-focus .hold").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.advanceTimersByTimeAsync(901);
    expect(state.grants).toHaveLength(1); expectOnePending();
    expect($('[data-tile="grants"] .home-tile-number').textContent).toBe("1"); expect($("#grants").textContent).toContain("Builder may run shell");
  });
  // Fleet coordination slice B: the agent that asked withdrew it. The pending read no longer returns it, so it leaves the
  // queue, and History names it Withdrawn, with no decider (nobody decided it).
  it("a request its agent withdrew leaves the pending list and shows as Withdrawn in History", async () => {
    const { state, c } = await start(); c.selectTab("inbox"); $('.inbox-view-tab[data-inbox-view="history"]').click();
    await vi.advanceTimersByTimeAsync(300);
    const row = state.records["ws-a"][0]; row.status = "withdrawn"; row.decided_at = new Date().toISOString();
    await c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expectOnePending();
    const item = [...document.querySelectorAll("#history li")].find((li) => li.textContent!.includes("request a1"))!;
    expect(item.querySelector(".outcome")!.textContent).toBe("Withdrawn");
    expect(item.querySelector(".outcome")!.className).toBe("outcome outcome-withdrawn");
    expect(item.textContent).not.toContain(" by ");
  });
  it.each(["failure", "hang"])("remote decision History updates despite unrelated core %s", async mode => {
    const { state, c } = await start(); c.selectTab("inbox"); $('.inbox-view-tab[data-inbox-view="history"]').click();
    await vi.advanceTimersByTimeAsync(300);
    const row = state.records["ws-a"][0]; row.status = "denied"; row.decided_by_person_name = "Ada"; row.decided_at = new Date().toISOString();
    state.tasksFail = mode === "failure"; if (mode === "hang") state.tasksHold = deferred();
    void c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect($("#history").textContent).toContain("request a1"); expect($("#history").textContent).toContain("by Ada");
    expectOnePending();
  });
  it("an authorized timed-grant read updates its count while another core read hangs", async () => {
    const { state, c } = await start(); state.tasksHold = deferred();
    state.grants.push({ id: "remote-grant", agent_name: "Builder", category: "shell", expires_at: new Date(Date.now() + 600_000).toISOString() });
    void c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect($('[data-tile="grants"] .home-tile-number').textContent).toBe("1");
  });
  it("a fast unrelated required failure does not cancel a slower authorized approvals response", async () => {
    const { state, c } = await start(); state.pendingHold = deferred(); const held = state.pendingHold;
    state.tasksFail = true; state.records["ws-a"][0].status = "denied";
    const read = c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect(queue("a1")).not.toBeNull(); held.release(); state.pendingHold = null;
    await read; await vi.advanceTimersByTimeAsync(0); expectOnePending();
  });
  it("fast core failure retains a single approval flight and coalesces its requested follow-up", async () => {
    const { state, c, fetchMock } = await start(); c.stopPoll(); state.pendingHold = deferred(); const held = state.pendingHold;
    state.tasksFail = true; const before = fetchMock.mock.calls.filter(([p]) => p === "/v1/approvals?status=pending").length;
    const read = c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    const queued = c.refreshNow(); await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock.mock.calls.filter(([p]) => p === "/v1/approvals?status=pending")).toHaveLength(before + 1);
    state.records["ws-a"][0].status = "denied"; state.pendingHold = null; held.release(); await read; await queued;
    expect(fetchMock.mock.calls.filter(([p]) => p === "/v1/approvals?status=pending")).toHaveLength(before + 2); expectOnePending();
  });
  it("a separate late approval scope cannot paint across a workspace transition", async () => {
    const { state, c } = await start(); state.pendingHold = deferred(); const held = state.pendingHold; state.tasksFail = true;
    void c.refreshNow(); await vi.advanceTimersByTimeAsync(0); state.pendingHold = null; state.tasksFail = false;
    await c.enterWorkspace("ws-b"); await vi.advanceTimersByTimeAsync(300);
    expect(queue("a1")!.textContent).toContain("B current request"); held.release(); await vi.advanceTimersByTimeAsync(300);
    expect(queue("a1")!.textContent).toContain("B current request"); expect(number()).toBe("1");
  });
  it.each(["fetch", "body"])("a permanently unresolved approval %s releases its old flight on workspace switch", async phase => {
    const { state, c } = await start(); c.stopPoll();
    if (phase === "fetch") state.pendingHold = deferred(); else state.pendingBodyHold = deferred();
    let finished = false; void c.refreshNow().then(() => { finished = true; }); await vi.advanceTimersByTimeAsync(0);
    state.pendingHold = state.pendingBodyHold = null; await c.enterWorkspace("ws-b"); await vi.advanceTimersByTimeAsync(300);
    expect(finished, "old approval flight must settle without releasing its transport").toBe(true);
    expect(c.approvalState()).toEqual({ scopes: 0, fence: null });
    expect(queue("a1")!.textContent).toContain("B current request"); expect(number()).toBe("1");
  });
  it.each(["fetch", "body"])("a permanently unresolved approval %s releases its old flight on sign-out", async phase => {
    const { state, c } = await start(); c.stopPoll();
    if (phase === "fetch") state.pendingHold = deferred(); else state.pendingBodyHold = deferred();
    let finished = false; void c.refreshNow().then(() => { finished = true; }); await vi.advanceTimersByTimeAsync(0);
    c.signOut(); await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true); expect(c.approvalState()).toEqual({ scopes: 0, fence: null });
    expect(queue("a1")).toBeNull(); expect(document.title).toBe("OpenCadre Console");
  });
  it("membership refusal clears old approvals before a hanging person identity check", async () => {
    const { state, c, fetchMock } = await start(); c.stopPoll(); state.pendingHold = deferred(); state.authHold = deferred(); state.meStatus = 403;
    let finished = false; void c.refreshNow().then(() => { finished = true; }); await vi.advanceTimersByTimeAsync(0);
    expect(queue("a1")).toBeNull(); expect($("#inbox-focus").textContent).not.toContain("request a1");
    expect(document.title).toBe("OpenCadre Console"); expect(finished).toBe(true);
    // Only the new bounded person-identity reconciliation may remain; not the old approval flight.
    expect(c.approvalState()).toEqual({ scopes: 1, fence: null });
    const oldPending = fetchMock.mock.calls.filter(([path]) => path === "/v1/approvals?status=pending").at(-1);
    expect(oldPending?.[1]?.signal?.aborted).toBe(true);
    expect(fetchMock.mock.calls.some(([path]) => path === "/v1/auth/signout")).toBe(false);
  });
  it("an older grants batch cannot erase a successfully acknowledged timed grant", async () => {
    const { state, c } = await start(); state.tasksHold = deferred(); const held = state.tasksHold;
    const read = c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    const scope = $('#inbox-focus [role="radiogroup"] input[value="30"]') as HTMLInputElement; scope.checked = true; scope.dispatchEvent(new Event("change", { bubbles: true }));
    $("#inbox-focus .hold").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.advanceTimersByTimeAsync(901); held.release(); state.tasksHold = null; await read;
    expect($('[data-tile="grants"] .home-tile-number').textContent).toBe("1"); expectOnePending();
    await vi.advanceTimersByTimeAsync(300); expect($('[data-tile="grants"] .home-tile-number').textContent).toBe("1");
  });
});
describe("automatic authoritative refresh and safety controls", () => {
  it.each(["age", "content"])("Home keeps one row per approval when adjacent %s changes replace both rows", async change => {
    const { state, c } = await start(); c.stopPoll();
    $('button[data-tab="overview"]').click();
    expect(document.querySelectorAll('#overview-attention [data-attention-key]')).toHaveLength(2);
    if (change === "age") await vi.advanceTimersByTimeAsync(61_000);
    else for (const row of state.records["ws-a"]) row.action += " changed remotely";
    await c.refreshNow();
    const keys = [...document.querySelectorAll('#overview-attention [data-attention-key]')].map(n => (n as HTMLElement).dataset.attentionKey);
    expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(2);
    expect(keys.sort()).toEqual(["approval:a1", "approval:a2"]);
    expect(number()).toBe("2"); expect($("#overview-attention-count").textContent).toBe("2");
  });
  it("selected Deny then Home has exactly two remaining rows after the rendered age changes", async () => {
    const { state, c } = await start(); c.stopPoll(); state.records["ws-a"].push(approval("a3"));
    await c.refreshNow(); expect(number()).toBe("3");
    $('button[data-tab="inbox"]').click(); deny("#inbox-focus"); await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(61_000); await c.refreshNow();
    $('button[data-tab="overview"]').click();
    expect(state.records["ws-a"][0].status).toBe("denied");
    const keys = [...document.querySelectorAll('#overview-attention [data-attention-key]')].map(n => (n as HTMLElement).dataset.attentionKey);
    expect(keys.sort()).toEqual(["approval:a2", "approval:a3"]);
    expect(number()).toBe("2"); expect($("#inbox-badge").textContent).toBe("2");
  });
  it("one answered pending read removes adjacent obsolete rows while keeping the remaining focused action", async () => {
    const { state, c } = await start(); c.stopPoll(); state.records["ws-a"].push(approval("a3")); await c.refreshNow();
    $('button[data-tab="overview"]').click(); const action = $('[data-attention-key="approval:a3"] button'); action.focus();
    state.records["ws-a"][0].status = state.records["ws-a"][1].status = "denied";
    state.tasksHold = deferred(); state.grantsHold = deferred();
    void c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    const rows = document.querySelectorAll('#overview-attention [data-attention-key]');
    expect(rows).toHaveLength(1); expect((rows[0] as HTMLElement).dataset.attentionKey).toBe("approval:a3");
    expect($('[data-attention-key="approval:a3"] button')).toBe(action); expect(document.activeElement).toBe(action);
    expect(number()).toBe("1");
  });
  it("an unchanged Home action retains its exact node and focus through repeated authorized reads", async () => {
    const { c } = await start(); c.stopPoll(); $('button[data-tab="overview"]').click();
    const action = $('[data-attention-key="approval:a2"] button'); action.focus();
    await c.refreshNow(); await c.refreshNow();
    expect(document.querySelectorAll('#overview-attention [data-attention-key]')).toHaveLength(2);
    expect($('[data-attention-key="approval:a2"] button')).toBe(action); expect(document.activeElement).toBe(action);
  });
  it.each(["denied", "approved", "expired"])("frame refresh removes a remotely %s queue and selected card", async status => {
    const { state, c } = await start(); c.connectLiveWs(); const socket = FakeSocket.instances.at(-1)!;
    socket.open(); await vi.advanceTimersByTimeAsync(300);
    state.records["ws-a"][0].status = status; socket.frame(); await vi.advanceTimersByTimeAsync(300); expectOnePending();
  });
  it("fallback poll reconciles an externally decided open notification overlay without reopening", async () => {
    const { state, c } = await start(); await c.showFocusedApproval("a1");
    state.records["ws-a"][0].status = "denied"; c.schedulePoll(); await vi.advanceTimersByTimeAsync(4500);
    expectOnePending(); expect($("#focused-approval-overlay .hold")).toBeNull();
    expect($("#focused-approval-overlay").textContent).toMatch(/denied|no longer pending/i);
  });
  it.each(["failure", "hang"])("remote decision applies queue/overlay/counts despite unrelated core %s", async mode => {
    const { state, c } = await start(); await c.showFocusedApproval("a1"); c.connectLiveWs();
    const socket = FakeSocket.instances.at(-1)!; socket.open(); await vi.advanceTimersByTimeAsync(300);
    state.tasksFail = mode === "failure"; if (mode === "hang") state.tasksHold = deferred();
    state.records["ws-a"][0].status = "approved"; socket.frame(); await vi.advanceTimersByTimeAsync(300);
    expectOnePending(); expect($("#focused-approval-overlay .hold")).toBeNull();
  });
  it.each(["approved", "expired"])("an externally %s overlay terminates on automatic frame refresh", async status => {
    const { state, c } = await start(); await c.showFocusedApproval("a1"); c.connectLiveWs();
    const socket = FakeSocket.instances.at(-1)!; socket.open(); await vi.advanceTimersByTimeAsync(300);
    state.records["ws-a"][0].status = status; socket.frame(); await vi.advanceTimersByTimeAsync(300);
    expect($("#focused-approval-overlay .hold")).toBeNull(); expectOnePending();
  });
  it("a pending overlay GET captured before expiry cannot restore the obsolete controls", async () => {
    const { state, c } = await start(); state.singleHold = deferred(); const held = state.singleHold;
    const opening = c.showFocusedApproval("a1"); await vi.advanceTimersByTimeAsync(0);
    state.records["ws-a"][0].status = "expired"; await c.refreshNow();
    expect($("#focused-approval-overlay").textContent).toContain("No longer pending");
    held.release(); await opening; expect($("#focused-approval-overlay .hold")).toBeNull();
  });
  it("a read begun before a newer notification cannot invalidate that new card", async () => {
    const { state, c } = await start(); state.pendingHold = deferred(); const held = state.pendingHold;
    const read = c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    state.records["ws-a"].push(approval("a3")); await c.showFocusedApproval("a3");
    held.release(); state.pendingHold = null; await read;
    expect($("#focused-approval-overlay").textContent).toContain("request a3"); expect($("#focused-approval-overlay .hold")).not.toBeNull();
  });
  it("an externally decided active card terminates safely while its failed write is still out", async () => {
    const { state, c } = await start(); await c.showFocusedApproval("a1"); state.decisionHold = deferred(); const held = state.decisionHold;
    deny("#focused-approval-overlay"); await vi.advanceTimersByTimeAsync(0);
    state.records["ws-a"][0].status = "denied"; await c.refreshNow();
    expect($("#focused-approval-overlay .hold")).toBeNull(); expectOnePending();
    state.decisionStatus = 409; held.release(); await vi.advanceTimersByTimeAsync(0);
    expect($("#focused-approval-overlay").hidden).toBe(false); expect($("#focused-approval-overlay").textContent).toContain("No longer pending");
  });
  it("failed pending reads do not manufacture an empty queue or a resolved overlay", async () => {
    const { state, c } = await start(); await c.showFocusedApproval("a1"); state.pendingStatus = 500; await c.refreshNow();
    expect(queue("a1")).not.toBeNull(); expect(number()).toBe("2"); expect($("#focused-approval-overlay .hold")).not.toBeNull();
  });
  it("an obsolete timed-out pending read cannot override a newer good read", async () => {
    const { state, c } = await start(); state.pendingHold = deferred(); const held = state.pendingHold; state.tasksFail = true;
    c.stopPoll(); // isolate one deadline; automatic poll coalescing/recovery is covered separately
    const failed = c.refreshNow(); await vi.advanceTimersByTimeAsync(15_000); await failed;
    state.tasksFail = false; state.pendingHold = null; state.records["ws-a"][0].status = "denied";
    await c.refreshNow(); expectOnePending(); held.release(); await vi.advanceTimersByTimeAsync(0); expectOnePending();
  });
  it("remote removal keeps a focused unrelated Home action and its original node", async () => {
    const { state, c } = await start();
    const action = $('[data-attention-key="approval:a2"] button'); action.focus();
    state.records["ws-a"][0].status = "approved"; await c.refreshNow();
    expect($('[data-attention-key="approval:a2"] button')).toBe(action); expect(document.activeElement).toBe(action);
  });
  it.each([403, 409, 500])("a refused %s decision keeps cards/counts and permits retry", async status => {
    const { state } = await start(); state.decisionStatus = status;
    deny("#inbox-focus"); await vi.advanceTimersByTimeAsync(300);
    expect(queue("a1")).not.toBeNull(); expect(number()).toBe("2");
    expect($("#inbox-focus .is-deciding")).toBeNull(); expect($("#inbox-focus .hold")).not.toBeNull();
  });
  it("deciding another row preserves a still-held focused card and keyboard focus", async () => {
    const { state } = await start(); queue("a2")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const card = $("#inbox-focus .clearance"), hold = $("#inbox-focus .hold"); hold.focus();
    hold.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); state.tasksHold = deferred();
    deny('#clearances [data-inbox-id="a1"]'); await vi.advanceTimersByTimeAsync(100);
    expect($("#inbox-focus .clearance")).toBe(card); expect(hold.classList.contains("is-holding")).toBe(true);
    expect(document.activeElement).toBe(hold); expect(queue("a1")).toBeNull(); expect(number()).toBe("1");
  });
  it("decision acknowledgement preserves an unrelated reply draft and focused textarea", async () => {
    const { state, c } = await start(); state.messages = [{ id: "m1", thread_id: "th1", kind: "message", body: "Unrelated mail",
      from_agent_name: "Builder", priority: "normal", read_at: null, created_at: new Date().toISOString() }];
    await c.refreshNow(); $("#inbox-list .strip").click(); await vi.advanceTimersByTimeAsync(0);
    const draft = $("#inbox-focus textarea") as HTMLTextAreaElement; draft.value = "Keep my draft"; draft.focus(); state.tasksHold = deferred();
    deny('#clearances [data-inbox-id="a1"]'); await vi.advanceTimersByTimeAsync(0);
    expect($("#inbox-focus textarea")).toBe(draft); expect(draft.value).toBe("Keep my draft"); expect(document.activeElement).toBe(draft);
    expect(queue("a1")).toBeNull(); expect(number()).toBe("1");
  });
  it("a late old-workspace successful decision cannot remove a new-workspace card with the same id", async () => {
    const { state, c } = await start(); state.decisionHold = deferred(); const held = state.decisionHold;
    deny("#inbox-focus"); await vi.advanceTimersByTimeAsync(0); await c.enterWorkspace("ws-b"); await vi.advanceTimersByTimeAsync(300);
    expect(queue("a1")!.textContent).toContain("B current request"); held.release(); await vi.advanceTimersByTimeAsync(300);
    expect(queue("a1")!.textContent).toContain("B current request"); expect(number()).toBe("1");
  });
});
