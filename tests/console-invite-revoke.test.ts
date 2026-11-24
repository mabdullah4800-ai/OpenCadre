// @vitest-environment happy-dom
// Regression for current invitation dispatch ownership. Full shipped app/HTML; controlled local REST/timers only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

const membersPath = "/v1/workspaces/ws-a/members";
const revokePath = "/v1/workspaces/ws-a/invites/invite-one";
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const response = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
beforeEach(() => {
  document.documentElement.innerHTML = readFileSync(resolve("public/app/index.html"), "utf8")
    .replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, "", "/app/#/home");
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  vi.stubGlobal("confirm", () => true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: vi.fn(async () => null) } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (navigator as any).serviceWorker; });
async function start(keyMode: boolean) {
  const first = deferred(), duplicate = deferred(), read = deferred();
  const state = { deletes: 0, simulatedMutations: 0, blockRead: true, reads: 0, firstStatus: 200, membersStatus: 200,
    invites: [{ id: "invite-one", role: "member", email: "pending@example.invalid", expiresAt: "2026-10-09T12:00:00Z" }] as any[] };
  const identity = { orgId: "ws-a", orgName: "Alpha", agentId: "person", agentName: "Ada", role: "operator",
    ...(keyMode ? {} : { memberRole: "owner" }), workspace: { paused: false } };
  const fetchMock = vi.fn(async (path: string, init?: { method?: string }) => {
    if (path === "/v1/auth/me") return keyMode ? response(401, { error: "No person session" }) : response(200, {
      person: { id: "person", name: "Ada", email: "ada@example.invalid" }, workspaces: [{ orgId: "ws-a", name: "Alpha", role: "owner" }] });
    if (path === revokePath && init?.method === "DELETE") {
      const ordinal = ++state.deletes, status = ordinal === 1 ? state.firstStatus : 200;
      const changed = status < 400 && state.invites.length > 0;
      if (changed) { state.invites = []; state.simulatedMutations++; }
      return { ok: changed, status: status >= 400 ? status : changed ? 200 : 404, json: async () => {
        await (ordinal === 1 ? first : duplicate).promise;
        return status >= 400 ? { error: "Controlled current revoke failure" } : changed ? { ok: true } : { error: "No open invite with that id." };
      } };
    }
    if (path === membersPath) {
      state.reads++;
      if (state.membersStatus !== 200) return response(state.membersStatus, { error: "Controlled members refusal" });
      const body = { members: [{ personId: "person", name: "Ada", role: "owner" }], invites: structuredClone(state.invites) };
      return { ...response(200, body), json: async () => {
        if (state.deletes > 0 && state.blockRead) await read.promise;
        return body;
      } };
    }
    if (init?.method && init.method !== "GET") throw new Error(`Unexpected diagnostic write: ${init.method} ${path}`);
    if (path === "/v1/org/project-isolation") return response(200, { enabled: false });
    return response(200, hubReadBody(path, identity) ?? {});
  });
  if (keyMode) localStorage.setItem("opencadre.agentKey", "controlled-fixture-credential");
  const c = new Function("window", "document", "localStorage", "fetch", `${readFileSync(process.env.OPENCADRE_REVOKE_BASELINE ?? resolve("public/app/app.js"), "utf8")};
    return { enterWorkspace, openSettingsPage, refreshNow };`)(window, document, localStorage, fetchMock);
  await vi.advanceTimersByTimeAsync(0);
  if (!keyMode) await c.enterWorkspace("ws-a");
  await vi.advanceTimersByTimeAsync(300); c.openSettingsPage("people"); await vi.advanceTimersByTimeAsync(300);
  const button = $("#invites-list button") as HTMLButtonElement;
  expect(button?.textContent).toBe("Revoke"); expect(button.isConnected).toBe(true);
  return { state, first, duplicate, read, button, fetchMock, c };
}

describe("current invitation Revoke dispatch ownership", () => {
  it.each([false, true])("known-positive single Revoke keyMode=%s dispatches once and removes the invite", async keyMode => {
    const h = await start(keyMode); h.button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(h.state.deletes).toBe(1); expect(h.state.simulatedMutations).toBe(1);
    h.first.release(); await vi.advanceTimersByTimeAsync(0); expect($("#toast").textContent).toBe("Invite revoked.");
    h.read.release(); await vi.advanceTimersByTimeAsync(0); expect($("#invites-list button")).toBeNull();
  });
  it.each([false, true])("keyMode=%s guards programmatic repeat and remains disabled through held success refresh", async keyMode => {
    const h = await start(keyMode); h.button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(h.button.disabled).toBe(true);
    h.button.click(); h.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0); expect(h.state.deletes).toBe(1);
    h.first.release(); await vi.advanceTimersByTimeAsync(0);
    expect($("#toast").textContent).toBe("Invite revoked."); expect(h.button.disabled).toBe(true);
    h.button.dispatchEvent(new MouseEvent("click", { bubbles: true })); await vi.advanceTimersByTimeAsync(0);
    expect(h.state.deletes).toBe(1); h.read.release(); await vi.advanceTimersByTimeAsync(0);
    expect($("#invites-list button")).toBeNull(); expect($("#toast").textContent).toBe("Invite revoked.");
  });
  it.each([false, true])("keyMode=%s current failure re-enables a genuine retry without a duplicate mutation", async keyMode => {
    const h = await start(keyMode); h.state.firstStatus = 500;
    h.button.click(); await vi.advanceTimersByTimeAsync(0); expect(h.button.disabled).toBe(true);
    h.button.dispatchEvent(new MouseEvent("click", { bubbles: true })); await vi.advanceTimersByTimeAsync(0); expect(h.state.deletes).toBe(1);
    h.first.release(); await vi.advanceTimersByTimeAsync(0);
    expect($("#toast").textContent).toBe("Controlled current revoke failure"); expect(h.button.disabled).toBe(false);
    h.button.click(); await vi.advanceTimersByTimeAsync(0); expect(h.state.deletes).toBe(2); expect(h.state.simulatedMutations).toBe(1);
    h.duplicate.release(); h.read.release(); await vi.advanceTimersByTimeAsync(0);
    expect($("#toast").textContent).toBe("Invite revoked."); expect($("#invites-list button")).toBeNull();
  });
  it.each([false, true])("keyMode=%s obsolete navigation completion cannot re-enable a new retained-node action", async keyMode => {
    const h = await start(keyMode); h.state.firstStatus = 500;
    h.button.click(); await vi.advanceTimersByTimeAsync(0); expect(h.button.disabled).toBe(true);
    h.c.openSettingsPage("safety"); await vi.advanceTimersByTimeAsync(300);
    h.c.openSettingsPage("people"); await vi.advanceTimersByTimeAsync(300);
    expect($("#invites-list button")).toBe(h.button); expect(h.button.disabled).toBe(false);
    h.button.click(); await vi.advanceTimersByTimeAsync(0); expect(h.button.disabled).toBe(true); expect(h.state.deletes).toBe(2);
    const toast = $("#toast").textContent; h.first.release(); await vi.advanceTimersByTimeAsync(0);
    expect(h.button.disabled).toBe(true); expect($("#toast").textContent).toBe(toast);
    h.duplicate.release(); h.read.release(); await vi.advanceTimersByTimeAsync(0); expect($("#toast").textContent).toBe("Invite revoked.");
  });
  it.each([false, true])("keyMode=%s source403 recovery fences old finally while a new node is busy", async keyMode => {
    const h = await start(keyMode); h.state.firstStatus = 500;
    h.button.click(); await vi.advanceTimersByTimeAsync(0); expect(h.button.disabled).toBe(true);
    h.state.membersStatus = 403; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect($("#invites-list button")).toBeNull(); h.state.membersStatus = 200; h.state.blockRead = false;
    await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    const newer = $("#invites-list button") as HTMLButtonElement; expect(newer).not.toBe(h.button); expect(newer.disabled).toBe(false);
    newer.click(); await vi.advanceTimersByTimeAsync(0); expect(newer.disabled).toBe(true);
    const toast = $("#toast").textContent; h.first.release(); await vi.advanceTimersByTimeAsync(0);
    expect(newer.disabled).toBe(true); expect($("#toast").textContent).toBe(toast);
    h.duplicate.release(); await vi.advanceTimersByTimeAsync(0); expect($("#toast").textContent).toBe("Invite revoked.");
  });
  it.each([false, true])("keyMode=%s healthy keyed reread keeps the pending guard and focused node", async keyMode => {
    const h = await start(keyMode); h.state.firstStatus = 500; h.state.blockRead = false;
    h.button.focus(); h.button.click(); await vi.advanceTimersByTimeAsync(0); expect(h.button.disabled).toBe(true);
    h.state.invites[0].expiresAt = "2026-10-10T12:00:00Z"; await h.c.refreshNow(); await vi.advanceTimersByTimeAsync(0);
    expect($("#invites-list button")).toBe(h.button); expect(h.button.disabled).toBe(true);
    h.button.dispatchEvent(new MouseEvent("click", { bubbles: true })); await vi.advanceTimersByTimeAsync(0); expect(h.state.deletes).toBe(1);
    h.first.release(); await vi.advanceTimersByTimeAsync(0); expect(h.button.disabled).toBe(false);
  });
});
