// @vitest-environment happy-dom
// Settings → Safety, "Pause all agents": the state is visible, what pausing does is said where the control is, and the
// pause takes a deliberate hold, never a browser dialog (#771 had swapped the hold for window.confirm and dropped both).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function loadConsole(fetchMock: ReturnType<typeof vi.fn>) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { renderKillSwitch, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, fetchMock) as { renderKillSwitch: () => void; setMe: (v: unknown) => void };
}

beforeEach(() => {
  const html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  document.documentElement.innerHTML = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
});

describe("Pause all agents", () => {
  it("shows Running, says what pausing does, and pauses only after a hold, with no browser dialog", async () => {
    vi.useFakeTimers();
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
    window.confirm = confirmSpy;
    try {
      const fetchMock = vi.fn(async (path: string) => (path === "/v1/org/pause" ? json(200, { ok: true, changed: true, agentsCutOff: 3 }) : json(200, {})));
      const c = loadConsole(fetchMock);
      c.setMe({ orgId: "org-1", agentId: "me", role: "operator", workspace: { paused: false } });
      c.renderKillSwitch();
      const body = $("killswitch-body");
      expect(body.querySelector(".killswitch-status")?.textContent).toBe("Running");
      expect(body.querySelector(".killswitch-effect")?.textContent).toBe("Agents stop: no mail, no claims, no commands. Operator keys keep access. Waiting requests end.");
      const hold = body.querySelector(".hold") as HTMLElement;
      expect(hold.querySelector(".label")?.textContent).toBe("Hold to pause the workspace");
      // A tap is not a pause.
      hold.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      hold.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchMock.mock.calls.some(([p]) => p === "/v1/org/pause")).toBe(false);
      // A full hold is.
      hold.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.advanceTimersByTimeAsync(901);
      expect(fetchMock.mock.calls.filter(([p]) => p === "/v1/org/pause")).toHaveLength(1);
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("a paused workspace says who paused it and offers Resume", () => {
    const c = loadConsole(vi.fn(async () => json(200, {})));
    c.setMe({ orgId: "org-1", agentId: "me", role: "operator", workspace: { paused: true, pausedBy: "Ada" } });
    c.renderKillSwitch();
    const body = $("killswitch-body");
    expect(body.querySelector(".killswitch-status")?.textContent).toBe("Paused by Ada.");
    expect(body.querySelector("button")?.textContent).toBe("Resume the workspace");
  });

  it("no window.confirm stands in for the hold anywhere on this control", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const fn = appJs.match(/function renderKillSwitch\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).not.toMatch(/confirm\(/);
  });
});
