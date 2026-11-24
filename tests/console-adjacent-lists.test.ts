// @vitest-environment happy-dom
// Wedge A complete-app controls. Mocked reads/writes/timers; no native or release acceptance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const agent = (id: string, name = id) => ({ id, name, role: "agent", kind: "named", key_class: "agent", online: true, current_task: "Initial task", editing_files_parsed: [], last_heartbeat_at: "2026-10-01 10:00:00" });
const project = (projectKey: string, name = projectKey) => ({ projectKey, name, enabled: true, sessionCount: 1, lastSeenAt: "2026-10-01 10:00:00" });
class Socket { static OPEN = 1; static CONNECTING = 0; readyState = 1; close() {} }
function hub() {
  const state = { agents: [agent("a1"), agent("a2")], projects: [project("p1"), project("p2")], role: "owner", projectsStatus: 200,
    writeHold: null as ReturnType<typeof deferred> | null, writeStatus: 200 };
  const fetchMock = vi.fn(async (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "ws-a";
    if (init?.method && init.method !== "GET") {
      const hold = state.writeHold; const status = state.writeStatus; if (hold) await hold.promise;
      return json(status, status === 200 ? { ok: true, agentName: "Removed", project: {} } : { error: "write refused" });
    }
    if (path === "/v1/auth/me") return json(200, { person: { id: "p1", email: "ada@example.com" }, workspaces: [
      { orgId: "ws-a", role: state.role }, { orgId: "ws-b", role: "owner" }] });
    if (path === "/v1/agents") return json(200, { agents: state.agents });
    if (path === "/v1/org/projects") return json(state.projectsStatus, state.projectsStatus === 200 ? { projects: state.projects } : { error: "projects read refused" });
    const identity = { orgId: ws, orgName: ws, agentId: `person-${ws}`, agentName: "Ada", role: state.role === "member" ? "agent" : "operator", memberRole: state.role, workspace: { paused: false } };
    return json(200, hubReadBody(path, identity) ?? {});
  });
  return { state, fetchMock };
}
function load(fetchMock: ReturnType<typeof hub>["fetchMock"]) {
  const app = readFileSync(resolve("public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${app};return {enterWorkspace,refreshNow,renderOtherAgents,renderProjectsSection,
    stopPoll:()=>clearTimeout(pollTimer),projects:()=>lastFleetProjectsData};`)(window, document, localStorage, fetchMock) as {
      enterWorkspace: (id: string) => Promise<void>; refreshNow: () => Promise<void>; stopPoll: () => void;
      renderOtherAgents: (v: unknown) => void; renderProjectsSection: (v: unknown, sourceKind?: string) => void; projects: () => unknown };
}
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const buttons = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
const named = (id = "a1") => [...document.querySelectorAll("#fleet-other-agents .strip")].find(n => n.querySelector(".callsign")?.textContent === id) as HTMLElement;
const projects = (name = "p1") => [...document.querySelectorAll("#settings-projects .strip")].find(n => n.querySelector(".callsign")?.textContent === name || n.querySelector("input")?.getAttribute("aria-label") === `Rename ${name}`) as HTMLElement;
const advance = () => vi.advanceTimersByTimeAsync(20);
const writes = (h: ReturnType<typeof hub>, method = "PUT") => h.fetchMock.mock.calls.filter(([, init]) => init?.method === method);
async function start() {
  const h = hub(); const c = load(h.fetchMock); await vi.advanceTimersByTimeAsync(0); await c.enterWorkspace("ws-a");
  await vi.advanceTimersByTimeAsync(300); c.stopPoll();
  document.querySelector<HTMLButtonElement>('[data-tab="fleet"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-view="agents"]')!.click(); await advance();
  h.fetchMock.mockClear(); return { ...h, c };
}
async function showProjects() {
  document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-settings-page="projects"]')?.click(); await advance();
}
beforeEach(() => {
  document.documentElement.innerHTML = readFileSync(resolve("public/app/index.html"), "utf8").replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "#/"); vi.stubGlobal("WebSocket", Socket); vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("row-local protection and current-subject action ownership", () => {
  it.each(["Rotate key", "Remove"])("keeps focused named %s connected through healthy metadata refresh", async (label) => {
    const h = await start(); const button = buttons(named(), label); button.focus(); expect(document.activeElement).toBe(button);
    h.state.agents[0].current_task = "Fresh focused metadata"; h.state.agents[0].editing_files_parsed = ["src/updated.ts"] as never[];
    await h.c.refreshNow(); expect(buttons(named(), label)).toBe(button); expect(document.activeElement).toBe(button);
    expect(named().textContent).toContain("Fresh focused metadata"); expect(named().textContent).toContain("src/updated.ts");
  });
  it.each([200, 500])("canceled removal response%s cannot alter or refresh a newer confirmation owner", async (status) => {
    const h = await start(); h.state.writeHold = deferred(); h.state.writeStatus = status;
    const remove = buttons(named(), "Remove"); remove.click(); const oldHold = $("#fleet-other-agents .hold"), oldCancel = buttons(named(), "Cancel");
    oldHold.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(1000); expect(writes(h, "DELETE")).toHaveLength(1);
    oldCancel.click(); remove.click(); const newer = named().querySelector(".remove-confirm"), newerHold = $("#fleet-other-agents .hold");
    expect(newer).toBeTruthy(); expect(remove.hidden).toBe(true); oldCancel.click(); oldHold.dispatchEvent(new Event("pointerdown"));
    const reads = h.fetchMock.mock.calls.length; h.state.writeHold.resolve(); await advance();
    expect(named().querySelector(".remove-confirm")).toBe(newer); expect($("#fleet-other-agents .hold")).toBe(newerHold); expect(remove.hidden).toBe(true);
    expect(h.fetchMock.mock.calls).toHaveLength(reads); expect(writes(h, "DELETE")).toHaveLength(1);
    expect($("#toast").textContent).not.toMatch(/Removed|Remove failed/);
  });
  it("does not restore focus to a named control revoked by role loss", async () => {
    const h = await start(); const rotate = buttons(named(), "Rotate key"); rotate.focus(); h.state.role = "admin";
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(300); h.c.stopPoll(); expect(rotate.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(rotate); expect(named().querySelector("[data-rotate]")).toBeNull();
  });
  it("known positive: the current uncanceled removal can retry a refusal and complete once", async () => {
    const h = await start(); h.state.writeStatus = 500; buttons(named(), "Remove").click(); const hold = $("#fleet-other-agents .hold");
    hold.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(1000); expect(writes(h, "DELETE")).toHaveLength(1);
    expect($("#toast").textContent).toContain("Remove failed"); expect($("#fleet-other-agents .hold")).toBe(hold);
    h.state.writeStatus = 200; hold.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(1000);
    expect(writes(h, "DELETE")).toHaveLength(2); expect(named().querySelector(".remove-confirm")).toBeNull(); expect($("#toast").textContent).toContain("Removed");
  });
  it("known positive: named hold released early/cancelled issues no DELETE", async () => {
    const h = await start(); buttons(named(), "Remove").click(); const hold = $("#fleet-other-agents .hold");
    hold.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(200); hold.dispatchEvent(new Event("pointerup"));
    await vi.advanceTimersByTimeAsync(1000); buttons(named(), "Cancel").click(); expect(writes(h, "DELETE")).toHaveLength(0);
  });
  it("named removal protection keeps its node while healthy rows/status and additions apply", async () => {
    const h = await start(); buttons(named(), "Remove").click(); const node = named(); const hold = $("#fleet-other-agents .hold");
    h.state.agents = [{ ...agent("a1"), current_task: "Protected latest" }, { ...agent("a2"), current_task: "Healthy latest" }, agent("a3")];
    await h.c.refreshNow(); expect(named()).toBe(node); expect($("#fleet-other-agents .hold")).toBe(hold);
    expect(named().textContent).toContain("Protected latest"); expect(named("a2").textContent).toContain("Healthy latest"); expect(named("a3")).toBeTruthy();
    buttons(named(), "Cancel").click(); expect(writes(h, "DELETE")).toHaveLength(0);
  });
  it("complete subject absence revokes held DELETE and retained detached remove reference", async () => {
    const h = await start(); const remove = buttons(named(), "Remove"); remove.click(); const hold = $("#fleet-other-agents .hold");
    h.state.agents = [agent("a2")]; await h.c.refreshNow(); expect(named()).toBeUndefined();
    remove.click(); hold.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(1000); expect(writes(h, "DELETE")).toHaveLength(0);
  });
  it("role downgrade revokes named hold and detached rotate/remove invocations", async () => {
    const h = await start(); const remove = buttons(named(), "Remove"); const rotate = buttons(named(), "Rotate key"); remove.click(); const hold = $("#fleet-other-agents .hold");
    h.state.role = "admin"; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(300); h.c.stopPoll();
    vi.stubGlobal("confirm", () => true); rotate.click(); remove.click(); hold.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(1000);
    expect(writes(h, "DELETE")).toHaveLength(0); expect(writes(h, "POST")).toHaveLength(0);
  });
  it("undefined roster input retains protected subjects rather than implying absence", async () => {
    const h = await start(); buttons(named(), "Remove").click(); const hold = $("#fleet-other-agents .hold");
    h.c.renderOtherAgents(undefined); expect($("#fleet-other-agents .hold")).toBe(hold); expect(named("a2")).toBeTruthy();
  });
  it("known positive: a current hold survives a roster refresh and DELETEs exactly once", async () => {
    const h = await start(); buttons(named(), "Remove").click(); const hold = $("#fleet-other-agents .hold");
    hold.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(300);
    h.state.agents[1].current_task = "Updated during hold"; await h.c.refreshNow();
    await vi.advanceTimersByTimeAsync(700); expect(writes(h, "DELETE")).toHaveLength(1);
    expect(writes(h, "DELETE")[0][0]).toBe("/v1/org/agents/a1");
  });
  it("an in-flight named removal loses callback ownership when its subject disappears", async () => {
    const h = await start(); h.state.writeHold = deferred(); buttons(named(), "Remove").click();
    $("#fleet-other-agents .hold").dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(1000);
    expect(writes(h, "DELETE")).toHaveLength(1); h.state.agents = [agent("a2")]; await h.c.refreshNow();
    const reads = h.fetchMock.mock.calls.length; h.state.writeHold.resolve(); await advance();
    expect(h.fetchMock.mock.calls).toHaveLength(reads); expect($("#toast").textContent).not.toContain("Removed");
  });
  it("a current rotation retains its response owner across healthy roster refresh", async () => {
    const h = await start(); vi.stubGlobal("confirm", () => true); h.state.writeHold = deferred(); buttons(named(), "Rotate key").click(); await advance();
    expect(writes(h, "POST")).toHaveLength(1); h.state.agents[0].current_task = "While rotating"; await h.c.refreshNow();
    h.state.writeHold.resolve(); await advance(); expect($("#toast").textContent).toContain("Rotated Removed");
  });
  it("project dirty draft and selection survive while complete cache and other rows apply", async () => {
    const h = await start(); await showProjects(); buttons(projects(), "Rename").click(); const input = projects().querySelector("input")!;
    input.value = "My draft"; input.setSelectionRange(2, 5); input.focus();
    h.state.projects = [{ ...project("p1"), sessionCount: 9 }, { ...project("p2"), name: "Healthy rename", sessionCount: 4 }, project("p3")];
    await h.c.refreshNow(); expect(projects().querySelector("input")).toBe(input); expect(input.value).toBe("My draft"); expect(input.selectionStart).toBe(2);
    expect(document.activeElement).toBe(input); expect(projects().textContent).toContain("9 sessions"); expect(projects("Healthy rename")).toBeTruthy();
    expect(projects("p3")).toBeTruthy(); expect((h.c.projects() as { projects: unknown[] }).projects).toHaveLength(3);
    buttons(projects(), "Cancel").click(); expect(writes(h)).toHaveLength(0);
  });
  it("project save remains name-only after a remote enabled-state change", async () => {
    const h = await start(); await showProjects(); buttons(projects(), "Rename").click(); const input = projects().querySelector("input")!; input.value = "Mine";
    h.state.projects[0] = { ...project("p1"), enabled: false }; await h.c.refreshNow(); buttons(projects(), "Save").click(); await advance();
    expect(JSON.parse(writes(h)[0][1]!.body!)).toEqual({ projectKey: "p1", name: "Mine" });
  });
  it("disable confirmation protects only its row while other projects update", async () => {
    const h = await start(); await showProjects(); buttons(projects(), "Disable").click(); const confirm = projects().querySelector(".remove-confirm");
    h.state.projects.push(project("p3")); h.state.projects[1].sessionCount = 4; await h.c.refreshNow();
    expect(projects().querySelector(".remove-confirm")).toBe(confirm); expect(projects("p2").textContent).toContain("4 sessions"); expect(projects("p3")).toBeTruthy();
    buttons(projects(), "Cancel").click(); expect(writes(h)).toHaveLength(0);
  });
  it("complete project absence revokes detached rename-save and disable-confirm writes", async () => {
    const h = await start(); await showProjects(); buttons(projects(), "Rename").click(); const save = buttons(projects(), "Save"); projects().querySelector("input")!.value = "Stale";
    buttons(projects("p2"), "Disable").click(); const confirm = projects("p2").querySelector<HTMLButtonElement>(".remove-confirm .btn-halt")!;
    h.state.projects = []; await h.c.refreshNow(); save.click(); confirm.click(); await advance(); expect(writes(h)).toHaveLength(0);
  });
  it("remote disable revokes obsolete disable confirmation before action replay", async () => {
    const h = await start(); await showProjects(); buttons(projects(), "Disable").click(); const confirm = projects().querySelector<HTMLButtonElement>(".remove-confirm .btn-halt")!;
    h.state.projects[0].enabled = false; await h.c.refreshNow(); expect(projects().querySelector(".remove-confirm")).toBeNull();
    confirm.click(); await advance(); expect(writes(h)).toHaveLength(0);
  });
  it("transient project failure and undefined payload preserve the complete successful cache and draft", async () => {
    const h = await start(); await showProjects(); buttons(projects(), "Rename").click(); const input = projects().querySelector("input")!; input.value = "Keep";
    const complete = h.c.projects(); h.state.projectsStatus = 500; await h.c.refreshNow();
    expect(h.c.projects()).toBe(complete); expect(projects().querySelector("input")).toBe(input); expect($("#projects-card").hidden).toBe(false);
    h.c.renderProjectsSection(undefined); expect(h.c.projects()).toBe(complete); expect(input.value).toBe("Keep");
  });
  it("current project403 clears hidden protected DOM/cache and detached save cannot write", async () => {
    const h = await start(); await showProjects(); buttons(projects(), "Rename").click(); const save = buttons(projects(), "Save"); projects().querySelector("input")!.value = "Old";
    h.state.projectsStatus = 403; await h.c.refreshNow(); expect($("#settings-projects").children).toHaveLength(0); expect(h.c.projects()).toBeNull();
    save.click(); await advance(); expect(writes(h)).toHaveLength(0);
  });
  it("project role loss revokes old rename/toggle/save references before replay", async () => {
    const h = await start(); await showProjects(); const rename = buttons(projects(), "Rename"), toggle = buttons(projects("p2"), "Disable");
    rename.click(); const save = buttons(projects(), "Save"); projects().querySelector("input")!.value = "Old role";
    h.state.role = "member"; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(300); h.c.stopPoll();
    rename.click(); toggle.click(); save.click(); await advance(); expect(writes(h)).toHaveLength(0); expect(h.c.projects()).toBeNull();
  });
  it("known positive: refused rename preserves the draft for a current retry", async () => {
    const h = await start(); await showProjects(); buttons(projects(), "Rename").click(); const input = projects().querySelector("input")!; input.value = "Retry draft";
    h.state.writeStatus = 500; buttons(projects(), "Save").click(); await advance(); expect(input.value).toBe("Retry draft");
    expect(buttons(projects(), "Save").disabled).toBe(false); h.state.writeStatus = 200; buttons(projects(), "Save").click(); await advance();
    expect(writes(h)).toHaveLength(2); expect(JSON.parse(writes(h)[1][1]!.body!)).toEqual({ projectKey: "p1", name: "Retry draft" });
  });
  it("cancelled disable completion cannot refresh or alter a newer rename owner", async () => {
    const h = await start(); await showProjects(); h.state.writeHold = deferred(); buttons(projects(), "Disable").click();
    projects().querySelector<HTMLButtonElement>(".remove-confirm .btn-halt")!.click(); await advance(); buttons(projects(), "Cancel").click();
    buttons(projects(), "Rename").click(); const input = projects().querySelector("input")!; input.value = "New owner";
    const reads = h.fetchMock.mock.calls.length; h.state.writeHold.resolve(); await advance();
    expect(h.fetchMock.mock.calls).toHaveLength(reads); expect(projects().querySelector("input")).toBe(input); expect(input.value).toBe("New owner");
    expect($("#toast").textContent).not.toContain("disabled.");
  });
  it("workspace reset suppresses detached save/confirm and late in-flight callbacks", async () => {
    const h = await start(); await showProjects(); buttons(projects(), "Rename").click(); const save = buttons(projects(), "Save"); projects().querySelector("input")!.value = "Old";
    h.state.writeHold = deferred(); save.click(); await advance(); expect(writes(h)).toHaveLength(1);
    const old = projects(); await h.c.enterWorkspace("ws-b"); await vi.advanceTimersByTimeAsync(300); h.c.stopPoll();
    save.click(); h.state.writeHold.resolve(); await advance(); expect(writes(h)).toHaveLength(1); expect(old.textContent).not.toContain("Renamed");
  });
  it("cancelled in-flight rename cannot replace latest authorized row or drain another owner's data", async () => {
    const h = await start(); await showProjects(); buttons(projects(), "Rename").click(); projects().querySelector("input")!.value = "Old save";
    h.state.writeHold = deferred(); buttons(projects(), "Save").click(); await advance(); const cancel = buttons(projects(), "Cancel"); cancel.click();
    h.state.projects[0].name = "Latest remote"; await h.c.refreshNow(); const row = projects("Latest remote"); h.state.writeHold.resolve(); await advance();
    expect(projects("Latest remote")).toBe(row); expect($("#settings-projects").textContent).not.toContain("Old save");
  });
});
