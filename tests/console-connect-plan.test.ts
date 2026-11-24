// @vitest-environment happy-dom
// Add a computer says where the workspace stands against its plan's computer limit, counted the way Plan & usage and
// the hub count it (computers that have connected). Red on the console before it: there was no such line.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { renderConnectPlanNote, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as { renderConnectPlanNote: (d: unknown[] | null) => void; setMe: (v: unknown) => void };
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
const devices = (connected: number) => [...Array(connected)].map(() => ({ status: "connected" })).concat([{ status: "revoked" }, { status: "waiting" }]);

describe("Add a computer shows the plan's computer limit", () => {
  it("counts only connected computers", () => {
    const c = loadConsole();
    c.setMe({ billing: { limits: { maxMachines: 3 } } });
    c.renderConnectPlanNote(devices(2));
    expect($("connect-plan-note").textContent).toBe("2 of 3 computers on your plan are in use.");
    expect($("connect-plan-note").classList.contains("is-full")).toBe(false);
  });
  it("at the limit, it says what to do", () => {
    const c = loadConsole();
    c.setMe({ billing: { limits: { maxMachines: 3 } } });
    c.renderConnectPlanNote(devices(3));
    expect($("connect-plan-note").textContent).toContain("all of them are in use");
    expect($("connect-plan-note").classList.contains("is-full")).toBe(true);
  });
  it("an unlimited plan shows nothing", () => {
    const c = loadConsole();
    c.setMe({ billing: { limits: { maxMachines: null } } });
    c.renderConnectPlanNote(devices(9));
    expect($("connect-plan-note").hidden).toBe(true);
  });
});
