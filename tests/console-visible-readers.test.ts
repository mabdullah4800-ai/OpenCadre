// @vitest-environment happy-dom
// Full shipped console/HTML through authorized entry, navigation, hints and actual fallback poll.
// Controlled local REST/socket/timers; not native browser or production acceptance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

const json = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const $ = <T extends HTMLElement = HTMLElement & { value: string }>(selector: string) => document.querySelector(selector) as T;
class FakeSocket {
  static instances: FakeSocket[] = []; static OPEN = 1; static CONNECTING = 0;
  readyState = 0; onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null; onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  frame() { this.onmessage?.({ data: JSON.stringify({ type: "workspace.changed" }) }); }
  close() { this.readyState = 3; }
}
const checkpoint = (detail = "Initial checklist") => ({ completed: 1, total: 4, steps: [
  { id: "first_agent", done: true, detail }, { id: "second_agent", done: false },
  { id: "first_message", done: false }, { id: "first_clearance", done: false },
] });
const membersPath = "/v1/workspaces/ws-a/members";
const paths = { people: membersPath, projects: "/v1/org/project-links", safety: "/v1/clearance-policies",
  notifications: "/v1/push/devices", checklist: "/v1/onboarding", goal: "/v1/goal" };
type Reader = keyof typeof paths;
function hub() {
  const state = { role: "owner", meStatus: 200, tasksFail: false, keyMode: false,
    bodies: {
      [membersPath]: { members: [{ personId: "person", name: "Ada", role: "owner" },
        { personId: "m2", name: "Initial person", role: "member" }, { personId: "m3", name: "Another person", role: "member" }], invites: [] },
      "/v1/org/project-isolation": { enabled: false },
      "/v1/org/project-links": { links: [{ projectA: "p1", projectB: "p2", nameA: "Initial project", nameB: "Web", createdBy: "Ada", createdAt: new Date().toISOString() }] },
      "/v1/clearance-policies": { policies: [{ project: "", mode: "ask", source: "workspace", updatedBy: "Initial policy" },
        { project: "p1", mode: "ask", source: "project", updatedBy: "Another policy" }] },
      "/v1/push/devices": { enabled: true, devices: [{ endpoint: "https://push.example.invalid/one", deviceLabel: "Initial phone", createdAt: new Date().toISOString() }] },
      "/v1/onboarding": checkpoint(), "/v1/goal": { goal: { text: "Initial goal", set_by_agent_name: "Ada" } },
      "/v1/org/projects": { projects: [{ projectKey: "p1", name: "API", enabled: true }, { projectKey: "p2", name: "Web", enabled: true }, { projectKey: "p3", name: "Other", enabled: true }] },
    } as Record<string, any>, statuses: {} as Record<string, number>,
    writeBodies: {} as Record<string, any>, writeStatuses: {} as Record<string, number>,
    writeHolds: {} as Record<string, { phase: "fetch" | "body"; latch: ReturnType<typeof deferred> } | undefined>,
    holds: {} as Record<string, { phase: "fetch" | "body"; latch: ReturnType<typeof deferred> } | undefined> };
  const fetchMock = vi.fn(async (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "ws-a";
    if (path === "/v1/auth/me" && state.keyMode) return json(401, { error: "No person session" });
    if (path === "/v1/auth/me") return json(200, { person: { id: "person", name: "Ada", email: "ada@example.invalid" },
      workspaces: [{ orgId: "ws-a", name: "Alpha", role: state.role }, { orgId: "ws-b", name: "Beta", role: "owner" }] });
    if (path === "/v1/me" && state.meStatus !== 200) return json(state.meStatus, { error: "membership refused" });
    if (state.tasksFail && path.startsWith("/v1/tasks")) return json(500, { error: "tasks unavailable" });
    if (init?.method && init.method !== "GET") {
      const body = copy(state.writeBodies[path] ?? { ok: true }), status = state.writeStatuses[path] ?? 200;
      const hold = state.writeHolds[path];
      if (hold?.phase === "fetch") await hold.latch.promise;
      return { ...json(status, body), json: async () => { if (hold?.phase === "body") await hold.latch.promise; return body; } };
    }
    const identity = { orgId: ws, orgName: ws, agentId: `person-${ws}`, agentName: "Ada", role: state.role === "member" ? "agent" : "operator",
      ...(state.keyMode ? {} : { memberRole: state.role }), workspace: { paused: false } };
    const captured = copy(state.bodies[path] ?? (path.startsWith("/v1/workspaces/ws-b/") ? { members: [], invites: [] } : hubReadBody(path, identity)) ?? {});
    const hold = state.holds[path]; const status = state.statuses[path] ?? 200;
    if (hold?.phase === "fetch") await hold.latch.promise;
    return { ...json(status, captured), json: async () => { if (hold?.phase === "body") await hold.latch.promise; return captured; } };
  });
  return { state, fetchMock };
}
function load(fetchMock: ReturnType<typeof hub>["fetchMock"]) {
  return new Function("window", "document", "localStorage", "fetch", `${readFileSync(process.env.OPENCADRE_VISIBLE_READER_BASELINE ?? resolve("public/app/app.js"), "utf8")};
    return { enterWorkspace, refreshNow, openSettingsPage, selectTab, connectLiveWs, schedulePoll, signOut,
      stopPoll: () => clearTimeout(pollTimer) };`)(window, document, localStorage, fetchMock) as {
    enterWorkspace: (id: string) => Promise<void>; refreshNow: () => Promise<void>; openSettingsPage: (id: string) => void;
    selectTab: (id: string) => void; connectLiveWs: () => void; schedulePoll: () => void; signOut: () => void; stopPoll: () => void;
  };
}
beforeEach(() => {
  document.documentElement.innerHTML = readFileSync(resolve("public/app/index.html"), "utf8")
    .replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, "", "/app/#/home");
  FakeSocket.instances = []; vi.stubGlobal("WebSocket", FakeSocket); vi.stubGlobal("confirm", () => true);
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: vi.fn(async () => null) } });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (navigator as any).serviceWorker; delete (navigator as any).clipboard; });
async function start() {
  const h = hub(); const c = load(h.fetchMock);
  await vi.advanceTimersByTimeAsync(0); await c.enterWorkspace("ws-a"); await vi.advanceTimersByTimeAsync(300);
  return { ...h, c };
}
async function visit(c: ReturnType<typeof load>, reader: Reader) {
  if (reader === "goal" || reader === "checklist") c.selectTab("overview"); else c.openSettingsPage(reader);
  await vi.advanceTimersByTimeAsync(300);
}
const content = (reader: Reader) => $(reader === "people" ? "#members-list" : reader === "projects" ? "#project-links-list" : reader === "safety" ? "#policy-list"
  : reader === "notifications" ? "#push-devices-list" : reader === "checklist" ? "#onboarding-steps" : "#overview-goal-text").textContent;
function change(state: ReturnType<typeof hub>["state"], reader: Reader) {
  const data = state.bodies[paths[reader]];
  if (reader === "people") data.members[1].name = "Remote person";
  if (reader === "projects") data.links[0].nameA = "Remote project";
  if (reader === "safety") data.policies[0].updatedBy = "Remote policy";
  if (reader === "notifications") data.devices[0].deviceLabel = "Remote phone";
  if (reader === "checklist") data.steps[0].detail = "Remote checklist";
  if (reader === "goal") data.goal.text = "Remote goal";
}
const readers = Object.keys(paths) as Reader[];
const sourceNames = { people: "members", projects: "isolation", safety: "policy", notifications: "push", checklist: "onboarding", goal: "goal" };
const count = (h: ReturnType<typeof hub>, reader: Reader) => h.fetchMock.mock.calls.filter(([p]) => p === paths[reader]).length;
const invitePath = "/v1/workspaces/ws-a/invites";
const inviteUrl = "https://fixture.example.invalid/app/?invite=controlled-fixture-link";
function submitInvite(h: ReturnType<typeof hub>) {
  h.state.writeBodies[invitePath] ??= { url: inviteUrl };
  $("#invite-email-input").value = "invite@example.invalid";
  $("#invite-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("authorized active ancillary readers", () => {
  it("current authorized person invite creates a usable link and copies it", async () => {
    const h = await start(); await visit(h.c, "people"); expect($("#invite-form").hidden).toBe(false);
    submitInvite(h); await vi.advanceTimersByTimeAsync(0);
    expect($("#invite-link-result").hidden).toBe(false); expect($("#invite-link-result code").textContent).toBe(inviteUrl);
    $("#invite-link-result button").click(); await vi.advanceTimersByTimeAsync(0);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(inviteUrl);
  });
  it("members403 destroys issued invitation material and fences a retained Copy callback", async () => {
    const h = await start(); await visit(h.c, "people"); submitInvite(h); await vi.advanceTimersByTimeAsync(0);
    const copyButton = $("#invite-link-result button"); h.state.statuses[membersPath] = 403;
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect($("#invite-link-result").hidden).toBe(true); expect($("#invite-link-result").childNodes.length).toBe(0);
    copyButton.click(); await vi.advanceTimersByTimeAsync(0); expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect($("#console").hidden).toBe(false);
  });
  it("operator-key entry can revoke an invite but cannot invoke person-only creation", async () => {
    const h = hub(); h.state.keyMode = true;
    h.state.bodies[membersPath].invites = [{ id: "invite-one", role: "member", email: "pending@example.invalid", expiresAt: new Date(Date.now() + 60_000).toISOString() }];
    localStorage.setItem("opencadre.agentKey", "controlled-fixture-credential"); const c = load(h.fetchMock);
    await vi.advanceTimersByTimeAsync(300); await visit(c, "people");
    expect($("#console").hidden).toBe(false); expect($("#invites-list").textContent).toContain("pending@example.invalid");
    const revoke = [...document.querySelectorAll<HTMLButtonElement>("#invites-list button")].find(b => b.textContent === "Revoke");
    expect(revoke).toBeDefined();
    expect($("#invite-form").hidden).toBe(true); submitInvite(h); await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchMock.mock.calls.some(([p, init]) => p === invitePath && init?.method === "POST")).toBe(false);
    revoke!.click(); await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchMock.mock.calls.some(([p, init]) => p === `${invitePath}/invite-one` && init?.method === "DELETE")).toBe(true);
  });
  it("a retained Revoke node works after navigation, but an obsolete detached node cannot invoke or complete", async () => {
    const h = await start(); h.state.bodies[membersPath].invites = [{ id: "invite-one", role: "member", email: "pending@example.invalid", expiresAt: new Date(Date.now() + 60_000).toISOString() }];
    await visit(h.c, "people"); const button = $("#invites-list button"); button.focus();
    await visit(h.c, "safety"); await visit(h.c, "people"); expect($("#invites-list button")).toBe(button);
    const path = `${invitePath}/invite-one`, latch = deferred(); h.state.writeHolds[path] = { phase: "body", latch };
    button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchMock.mock.calls.filter(([p, init]) => p === path && init?.method === "DELETE")).toHaveLength(1);
    h.state.statuses[membersPath] = 403; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    h.state.statuses[membersPath] = 200; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    const before = count(h, "people"), toast = $("#toast").textContent;
    button.click(); latch.release(); await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchMock.mock.calls.filter(([p, init]) => p === path && init?.method === "DELETE")).toHaveLength(1);
    expect(count(h, "people")).toBe(before); expect($("#toast").textContent).toBe(toast);
  });
  it("an old-workspace invitation completion cannot paint or clear the new workspace draft", async () => {
    const h = await start(); await visit(h.c, "people"); const latch = deferred(); h.state.writeHolds[invitePath] = { phase: "body", latch };
    submitInvite(h); await vi.advanceTimersByTimeAsync(0); await h.c.enterWorkspace("ws-b"); await vi.advanceTimersByTimeAsync(300);
    await visit(h.c, "people"); $("#invite-email-input").value = "workspace-b-draft@example.invalid";
    latch.release(); await vi.advanceTimersByTimeAsync(0);
    expect($("#invite-link-result").childNodes.length).toBe(0); expect($("#invite-email-input").value).toBe("workspace-b-draft@example.invalid");
  });
  it.each(["fetch", "body"] as const)("a held invite %s completion cannot repaint after members403, even after access recovers", async phase => {
    const h = await start(); await visit(h.c, "people"); const latch = deferred(); h.state.writeHolds[invitePath] = { phase, latch };
    submitInvite(h); await vi.advanceTimersByTimeAsync(0); h.state.statuses[membersPath] = 403;
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); h.state.statuses[membersPath] = 200;
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); $("#invite-email-input").value = "new-draft@example.invalid";
    const before = count(h, "people"); latch.release(); await vi.advanceTimersByTimeAsync(0);
    expect($("#invite-link-result").childNodes.length).toBe(0); expect($("#invite-link-result").hidden).toBe(true);
    expect($("#invite-email-input").value).toBe("new-draft@example.invalid"); expect(count(h, "people")).toBe(before);
  });
  it("an obsolete invite error cannot toast or mutate the plan banner after source withdrawal", async () => {
    const h = await start(); await visit(h.c, "people"); const latch = deferred(); h.state.writeHolds[invitePath] = { phase: "body", latch };
    h.state.writeStatuses[invitePath] = 402; h.state.writeBodies[invitePath] = { error: "Obsolete invite plan refusal", code: "OLD_PLAN" };
    submitInvite(h); await vi.advanceTimersByTimeAsync(0); h.state.statuses[membersPath] = 403;
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); const before = document.body.textContent;
    latch.release(); await vi.advanceTimersByTimeAsync(0); expect(document.body.textContent).toBe(before);
    expect(document.body.textContent).not.toContain("Obsolete invite plan refusal");
  });
  it("current invite completion survives a transient members500 but not a superseding submission", async () => {
    const h = await start(); await visit(h.c, "people"); const latch = deferred(); h.state.writeHolds[invitePath] = { phase: "body", latch };
    submitInvite(h); await vi.advanceTimersByTimeAsync(0); h.state.statuses[membersPath] = 500;
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); latch.release(); await vi.advanceTimersByTimeAsync(0);
    expect($("#invite-link-result code").textContent).toBe(inviteUrl);
    h.state.statuses[membersPath] = 200; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    const older = deferred(); h.state.writeHolds[invitePath] = { phase: "fetch", latch: older };
    submitInvite(h); await vi.advanceTimersByTimeAsync(0); h.state.writeHolds[invitePath] = undefined;
    const newerUrl = `${inviteUrl}-newer`; h.state.writeBodies[invitePath] = { url: newerUrl };
    submitInvite(h); await vi.advanceTimersByTimeAsync(0); expect($("#invite-link-result code").textContent).toBe(newerUrl);
    $("#invite-email-input").value = "newer-draft@example.invalid"; older.release(); await vi.advanceTimersByTimeAsync(0);
    expect($("#invite-link-result code").textContent).toBe(newerUrl); expect($("#invite-email-input").value).toBe("newer-draft@example.invalid");
  });
  it("leaving and re-entering People cannot revive an older invite completion", async () => {
    const h = await start(); await visit(h.c, "people"); const latch = deferred(); h.state.writeHolds[invitePath] = { phase: "fetch", latch };
    submitInvite(h); await vi.advanceTimersByTimeAsync(0); await visit(h.c, "safety"); await visit(h.c, "people");
    $("#invite-email-input").value = "returned-draft@example.invalid"; latch.release(); await vi.advanceTimersByTimeAsync(0);
    expect($("#invite-link-result").childNodes.length).toBe(0); expect($("#invite-email-input").value).toBe("returned-draft@example.invalid");
  });
  it.each([500, 403])("first Safety read%d settles Loading and exposes an honest failure, then recovers", async status => {
    const h = await start(); h.state.statuses[paths.safety] = status; await visit(h.c, "safety");
    expect($("#policy-loading").hidden).toBe(true); expect($("#reader-policy-status").textContent).toBe(status === 403 ? "Safety policy unavailable for your access." : "Safety policy couldn't refresh. Trying again on the next refresh."); expect($("#reader-policy-status [title]")).toBeNull();
    expect($("#policy-list select")).toBeNull(); h.state.statuses[paths.safety] = 200;
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); expect(content("safety")).toContain("Initial policy");
    expect($("#policy-loading").hidden).toBe(true);
  });
  it("a failed Safety refresh after a good read says how old the shown policy is", async () => {
    const h = await start(); await visit(h.c, "safety"); expect(content("safety")).toContain("Initial policy");
    // Reads keep failing for three minutes, so the last good one ages.
    h.state.statuses[paths.safety] = 500; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(3 * 60_000);
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    // The policy on screen is the last good read: the caption names the reader, the failure, and that read's age.
    expect(content("safety")).toContain("Initial policy");
    expect($("#reader-policy-status").textContent).toMatch(/^Safety policy couldn't refresh\. Trying again on the next refresh\. Last applied \d+m ago\.$/);
  });
  it.each(readers)("known-positive instrument renders %s from real entry/navigation", async reader => {
    const h = await start(); await visit(h.c, reader); expect(content(reader)).toContain("Initial");
  });
  it.each(readers.flatMap(reader => ["hint", "poll"].map(trigger => ({ reader, trigger }))))("$reader updates via $trigger without role change/reload", async ({ reader, trigger }) => {
    const h = await start(); await visit(h.c, reader); h.c.connectLiveWs(); const socket = FakeSocket.instances.at(-1)!;
    socket.open(); await vi.advanceTimersByTimeAsync(300); const before = count(h, reader); change(h.state, reader);
    if (trigger === "hint") { socket.frame(); await vi.advanceTimersByTimeAsync(300); }
    else { h.c.schedulePoll(); await vi.advanceTimersByTimeAsync(4500); }
    expect(count(h, reader)).toBeGreaterThan(before); expect(content(reader)).toContain("Remote");
  });
  it("subsection entry reads People and remote edits while hidden make no routine People request", async () => {
    const h = await start(); h.c.openSettingsPage("billing"); await vi.advanceTimersByTimeAsync(300);
    const before = count(h, "people"); h.c.schedulePoll(); await vi.advanceTimersByTimeAsync(4500); expect(count(h, "people")).toBe(before);
    change(h.state, "people"); await visit(h.c, "people"); expect(content("people")).toContain("Remote person");
  });
  it("a People answer whose page ownership was withdrawn cannot repaint or stamp current visible freshness", async () => {
    const h = await start(); await visit(h.c, "people"); const before = content("people");
    change(h.state, "people"); const latch = deferred(); h.state.holds[membersPath] = { phase: "body", latch };
    void h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); h.c.openSettingsPage("safety"); await vi.advanceTimersByTimeAsync(300);
    latch.release(); await vi.advanceTimersByTimeAsync(0); expect(content("people")).toBe(before);
    h.state.holds[membersPath] = undefined; await visit(h.c, "people"); expect(content("people")).toContain("Remote person");
  });
  it.each(["fetch", "body"] as const)("bounded goal %s failure leaves checklist/core healthy and permits recovery", async phase => {
    const h = await start(); h.c.stopPoll(); const latch = deferred(); h.state.holds[paths.goal] = { phase, latch };
    change(h.state, "goal"); change(h.state, "checklist"); void h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect(content("checklist")).toContain("Remote checklist"); expect(content("goal")).toContain("Initial goal");
    await vi.advanceTimersByTimeAsync(15_001); expect($("#reader-goal-status").textContent).toMatch(/timed out|couldn't refresh/i);
    h.state.holds[paths.goal] = undefined; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect(content("goal")).toContain("Remote goal"); latch.release(); await vi.advanceTimersByTimeAsync(0); expect(content("goal")).toContain("Remote goal");
  });
  it("goal reconnect refresh bypasses a younger-than-60-second cache and preserves expansion", async () => {
    const h = await start(); h.state.bodies[paths.goal].goal.text = "Initial long goal ".repeat(30);
    h.c.selectTab("fleet"); await vi.advanceTimersByTimeAsync(300); await visit(h.c, "goal");
    $("#overview-goal-toggle").click(); const button = $("#overview-goal-toggle"); button.focus();
    h.state.bodies[paths.goal].goal.text = "Remote long goal ".repeat(30); h.c.connectLiveWs(); FakeSocket.instances.at(-1)!.open();
    await vi.advanceTimersByTimeAsync(300); expect(content("goal")).toContain("Remote long goal");
    expect(button.getAttribute("aria-expanded")).toBe("true"); expect(document.activeElement).toBe(button);
  });
  it("transient policy failure retains the last authorized data with honest failure caption, then recovers", async () => {
    const h = await start(); await visit(h.c, "safety"); h.state.statuses[paths.safety] = 500;
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect($("#policy-list").hidden).toBe(false); expect(content("safety")).toContain("Initial policy");
    expect($("#reader-policy-status").textContent).toMatch(/couldn't refresh/i);
    h.state.statuses[paths.safety] = 200; change(h.state, "safety"); await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect(content("safety")).toContain("Remote policy");
  });
  it("source-only People refusal clears private rows/actions but keeps valid identity and other readers", async () => {
    const h = await start(); await visit(h.c, "people"); h.state.statuses[membersPath] = 403;
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect(content("people")).not.toContain("Initial person"); expect($("#members-list select")).toBeNull();
    expect($("#invite-form").hidden).toBe(true); expect($("#console").hidden).toBe(false);
    await visit(h.c, "goal"); change(h.state, "goal"); await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); expect(content("goal")).toContain("Remote goal");
  });
  it("member downgrade cancels old privileged reader jobs before applying their bodies", async () => {
    const h = await start(); await visit(h.c, "people"); const latch = deferred(); h.state.holds[membersPath] = { phase: "body", latch };
    void h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); h.state.role = "member"; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(300);
    latch.release(); await vi.advanceTimersByTimeAsync(0); expect($("#members-card").hidden).toBe(true); expect(content("people")).toBe("");
  });
  it("late browser subscription answer cannot restore old-person phone rows after sign-out", async () => {
    const h = await start(); await visit(h.c, "notifications"); const latch = deferred();
    (navigator.serviceWorker.getRegistration as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { await latch.promise; return null; });
    void h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); h.c.signOut(); await vi.advanceTimersByTimeAsync(0);
    latch.release(); await vi.advanceTimersByTimeAsync(0); expect($("#push-devices-list").textContent).toBe(""); expect($("#push-card").hidden).toBe(true);
  });
  it("dirty member role and invite role/email/focus survive while another row updates", async () => {
    const h = await start(); await visit(h.c, "people"); const select = $<HTMLSelectElement>('#members-list select[aria-label="Role for Initial person"]');
    select.value = "admin"; select.dispatchEvent(new Event("change")); select.focus();
    $("#invite-role-select").value = "owner"; $("#invite-email-input").value = "draft@example.invalid";
    h.state.bodies[membersPath].members[2].name = "Other updated"; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect($('select[aria-label="Role for Initial person"]')).toBe(select); expect(select.value).toBe("admin"); expect(document.activeElement).toBe(select);
    expect($("#invite-role-select").value).toBe("owner"); expect($("#invite-email-input").value).toBe("draft@example.invalid"); expect(content("people")).toContain("Other updated");
  });
  it("dirty policy row does not freeze unrelated rows; remote conflict disables stale Save until cancellation", async () => {
    const h = await start(); await visit(h.c, "safety"); const select = $<HTMLSelectElement>('#policy-list select[aria-label="Clearance mode for the workspace default"]');
    select.value = "strict"; select.dispatchEvent(new Event("change")); select.focus();
    h.state.bodies[paths.safety].policies[0].mode = "notify"; h.state.bodies[paths.safety].policies[1].updatedBy = "Remote unaffected policy";
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); expect(select.value).toBe("strict"); expect(document.activeElement).toBe(select);
    expect(content("safety")).toContain("Remote unaffected policy"); expect(content("safety")).toMatch(/changed remotely/i);
    const row = select.closest(".policy-row")!; expect((row.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    const cancel = [...row.querySelectorAll("button")].find(b => b.textContent === "Cancel"); expect(cancel).toBeDefined(); cancel!.click();
    expect($<HTMLSelectElement>('#policy-list select[aria-label="Clearance mode for the workspace default"]').value).toBe("notify");
  });
  it("removed dirty member loses actions rather than saving to a disappeared subject", async () => {
    const h = await start(); await visit(h.c, "people"); const select = $<HTMLSelectElement>('select[aria-label="Role for Initial person"]'); select.value = "admin";
    h.state.bodies[membersPath].members.splice(1, 1); await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); expect($('select[aria-label="Role for Initial person"]')).toBeNull();
  });
  it("project-link choices and webhook draft/focus survive unchanged authorized refresh", async () => {
    const h = await start(); await visit(h.c, "projects"); const choice = $<HTMLSelectElement>("#link-project-a"); choice.value = "p3"; choice.focus();
    $("#link-project-b").value = "p1"; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect(choice.value).toBe("p3"); expect($("#link-project-b").value).toBe("p1"); expect(document.activeElement).toBe(choice);
    await visit(h.c, "notifications"); const draft = $<HTMLInputElement>("#webhook-url"); draft.value = "https://notify.example.invalid/draft"; draft.dispatchEvent(new Event("input")); draft.focus();
    change(h.state, "notifications"); await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect(draft.value).toBe("https://notify.example.invalid/draft"); expect(document.activeElement).toBe(draft); expect(content("notifications")).toContain("Remote phone");
  });
  it("eligible checklist completion hides card, then explicit dismissal prevents further checklist reads", async () => {
    const h = await start(); expect($("#onboarding-card").hidden).toBe(false);
    h.state.bodies[paths.checklist].completed = 4; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); expect($("#onboarding-card").hidden).toBe(true);
    h.state.bodies[paths.checklist] = checkpoint(); await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); $("#onboarding-hide").click();
    const before = count(h, "checklist"); await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); expect(count(h, "checklist")).toBe(before);
  });
  it.each(readers.flatMap(reader => (["fetch", "body"] as const).map(phase => ({ reader, phase }))))("$reader $phase deadline releases its own flight, not approvals or subsequent refresh", async ({ reader, phase }) => {
    const h = await start(); await visit(h.c, reader); h.c.stopPoll(); const latch = deferred();
    h.state.holds[paths[reader]] = { phase, latch }; const before = count(h, reader); change(h.state, reader);
    h.state.bodies["/v1/approvals?status=pending"] = { approvals: [{ id: "remote", action: "Unrelated approval", status: "pending", risk: "high",
      requested_by_agent_name: "Builder", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() }] };
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); expect(count(h, reader)).toBe(before + 1);
    expect($("#inbox-badge").textContent).toBe("1"); expect(content(reader)).toContain("Initial");
    await vi.advanceTimersByTimeAsync(15_001); expect($(`#reader-${sourceNames[reader]}-status`).textContent).toMatch(/couldn't refresh/i);
    h.state.holds[paths[reader]] = undefined; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); expect(content(reader)).toContain("Remote");
    latch.release(); await vi.advanceTimersByTimeAsync(0); expect(content(reader)).toContain("Remote");
  });
  it("one held People flight coalesces a burst into one follow-up without a timer storm", async () => {
    const h = await start(); await visit(h.c, "people"); h.c.stopPoll(); const before = count(h, "people"), latch = deferred();
    h.state.holds[membersPath] = { phase: "body", latch }; await h.c.refreshNow();
    for (let n = 0; n < 10; n++) await h.c.refreshNow();
    expect(count(h, "people")).toBe(before + 1); h.state.holds[membersPath] = undefined; change(h.state, "people");
    latch.release(); await vi.advanceTimersByTimeAsync(0); expect(count(h, "people")).toBe(before + 2); expect(content("people")).toContain("Remote person");
  });
  it("source-only policy403 immediately removes held controls while identity and healthy approval stay valid", async () => {
    const h = await start(); await visit(h.c, "safety"); const select = $<HTMLSelectElement>("#policy-list select"); select.value = "strict"; select.focus();
    h.state.statuses[paths.safety] = 403; h.state.tasksFail = true; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect($("#policy-list select")).toBeNull(); expect($("#policy-add-form").hidden).toBe(true); expect($("#console").hidden).toBe(false);
    expect($("#reader-policy-status").textContent).toContain("unavailable");
  });
  it("late old-workspace People body cannot revive protected rows on the new Home", async () => {
    const h = await start(); await visit(h.c, "people"); const latch = deferred(); h.state.holds[membersPath] = { phase: "body", latch };
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0); await h.c.enterWorkspace("ws-b"); await vi.advanceTimersByTimeAsync(300);
    const request = h.fetchMock.mock.calls.filter(([p]) => p === membersPath).at(-1)!;
    expect(request[1]?.signal?.aborted).toBe(true); latch.release(); await vi.advanceTimersByTimeAsync(0); expect(content("people")).not.toContain("Initial person");
  });
  it("phone GET is person-scoped, and disabled configuration clears prior device actions", async () => {
    const h = await start(); await visit(h.c, "notifications");
    expect(h.fetchMock.mock.calls.filter(([p]) => p === paths.notifications).at(-1)?.[1]?.headers?.["X-OpenCadre-Workspace"]).toBeUndefined();
    h.state.bodies[paths.notifications].enabled = false; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect($("#push-card").hidden).toBe(true); expect($("#push-devices-list button")).toBeNull();
  });
  it("late policy snapshot before local Save cannot overwrite successful acknowledged choice", async () => {
    const h = await start(); await visit(h.c, "safety"); const latch = deferred(); h.state.holds[paths.safety] = { phase: "body", latch };
    await h.c.refreshNow(); const select = $<HTMLSelectElement>("#policy-list select"); select.value = "strict";
    h.state.bodies[paths.safety].policies[0].mode = "strict"; h.state.holds[paths.safety] = undefined;
    (select.closest(".policy-row")!.querySelector("button") as HTMLElement).click(); await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(h.fetchMock.mock.calls.find(([p, init]) => p === "/v1/clearance-policy" && init?.method === "PUT")![1]!.body!)).toEqual({ project: "", mode: "strict" });
    latch.release(); await vi.advanceTimersByTimeAsync(0);
    const current = $<HTMLSelectElement>("#policy-list select");
    expect({ value: current.value, original: current.dataset.original,
      options: [...current.options].map(o => [o.value, o.selected, o.hasAttribute("selected")]) }).toEqual({ value: "strict", original: "strict",
      options: [["off", false, false], ["notify", false, false], ["ask", false, false], ["strict", true, true]] });
  });
  it("first-load core failure does not prevent authorized navigation to People", async () => {
    const h = hub(); h.state.tasksFail = true; const c = load(h.fetchMock);
    await vi.advanceTimersByTimeAsync(0); await c.enterWorkspace("ws-a"); await vi.advanceTimersByTimeAsync(300);
    change(h.state, "people"); await visit(c, "people"); expect(content("people")).toContain("Remote person");
  });
  it("first-run pending/visible card suppresses duplicate checklist GET until dismissal", async () => {
    const h = hub(); localStorage.setItem("opencadre.selfserve.ws-a", "1"); const c = load(h.fetchMock);
    await vi.advanceTimersByTimeAsync(0); await c.enterWorkspace("ws-a"); await vi.advanceTimersByTimeAsync(300);
    expect($("#first-run-card").hidden).toBe(false); expect(count(h, "checklist")).toBe(0); expect($("#onboarding-card").hidden).toBe(true);
    $("#first-run-hide").click(); c.schedulePoll(); await vi.advanceTimersByTimeAsync(4500);
    expect($("#first-run-card").hidden).toBe(true); expect($("#onboarding-card").hidden).toBe(false); expect(count(h, "checklist")).toBeGreaterThan(0);
  });
});
