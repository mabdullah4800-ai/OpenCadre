// @vitest-environment happy-dom
// A brand-new workspace's Home, found on the seeded first-run hub: both onboarding cards showed at once, and the
// counts included the person reading the page ("1 agent online" above "No one is working yet"). Red before the fix.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
function loadConsole(fetchMock: unknown) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { refreshOnboarding, renderOverview, updateFleetCount, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, fetchMock) as {
    refreshOnboarding: () => Promise<void>; renderOverview: (d: Record<string, unknown>) => void; updateFleetCount: (a: unknown[]) => void; setMe: (v: unknown) => void;
  };
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  localStorage.clear();
});

describe("one onboarding card at a time", () => {
  it("the checklist stays hidden if the first-run card appears while the checklist's request is out", async () => {
    let answer: (v: unknown) => void = () => {};
    const fetchMock = vi.fn((url: string) => (url === "/v1/onboarding" ? new Promise((r) => { answer = r; }) : Promise.resolve(json(200, {}))));
    const c = loadConsole(fetchMock);
    c.setMe({ orgId: "o1", agentId: "me" });
    const pending = c.refreshOnboarding();
    $("first-run-card").hidden = false; // renderFirstRun shows its card meanwhile
    answer(json(200, { completed: 0, total: 4, steps: [{ id: "first_agent", done: false }] }));
    await pending;
    expect($("onboarding-card").hidden).toBe(true);
  });
});

describe("'agents online' counts the agents, not the person reading", () => {
  it("excludes the signed-in agent from the status line and the sidebar count", () => {
    const c = loadConsole(vi.fn(async () => json(200, {})));
    c.setMe({ agentId: "me" });
    const agents = [{ id: "me", online: true }, { id: "a1", online: false }];
    c.renderOverview({ approvals: [], messages: [], awarenessDigest: null, liveSessions: null, taskCounts: null, grants: [], agents, events: [] });
    expect($("overview-metrics").querySelector('[data-tile="agents"] .home-tile-number')?.textContent).toBe("0");
    expect($("overview-metrics").querySelector('[data-tile="agents"] .home-tile-unit')?.textContent).toBe("of 1 you can see");
    c.updateFleetCount(agents);
    expect($("fleet-count").textContent).toBe("0 of 1 agents online");
  });
});
