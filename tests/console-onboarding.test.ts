// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Console = {
  refreshOnboarding: () => Promise<void>;
  setMe: (v: { orgId: string } | null) => void;
};

// An in-memory Storage: window.localStorage varies by runtime (newer Node versions
// expose their own partial localStorage global, where clear() is missing).
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}
let storage: Storage;

function loadConsole(fetchMock: ReturnType<typeof vi.fn>): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { refreshOnboarding, setMe: (v) => { me = v; } };`,
  )(window, document, storage, fetchMock) as Console;
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const stepsPayload = (overrides: Partial<Record<string, boolean>> = {}) => ({
  completed: Object.values(overrides).filter(Boolean).length,
  total: 4,
  steps: [
    { id: "first_agent", done: Boolean(overrides.first_agent), doneAt: overrides.first_agent ? "2026-01-01T00:00:00Z" : null, detail: overrides.first_agent ? "Claude Code" : null },
    { id: "second_agent", done: Boolean(overrides.second_agent), doneAt: null, detail: null },
    { id: "first_message", done: Boolean(overrides.first_message), doneAt: null, detail: null },
    { id: "first_clearance", done: Boolean(overrides.first_clearance), doneAt: null, detail: null },
  ],
});

beforeEach(() => {
  storage = memoryStorage();
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("first-run checklist card", () => {
  it("shows undone steps with a next-action button and done steps with their detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, stepsPayload({ first_agent: true })));
    const { refreshOnboarding, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1" });
    await refreshOnboarding();

    expect($("onboarding-card").hidden).toBe(false);
    expect($("onboarding-progress-text").textContent).toBe("1/4");
    const items = document.querySelectorAll("#onboarding-steps .onboarding-step");
    expect(items.length).toBe(4);
    expect(items[0].classList.contains("is-done")).toBe(true);
    expect(items[0].textContent).toContain("Claude Code");
    expect(items[0].querySelector("button")).toBeNull();
    expect(items[1].classList.contains("is-done")).toBe(false);
    expect(items[1].querySelector("button")?.textContent).toBe("Go to Connect");
  });

  it("hides the card once every step is done", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, stepsPayload({ first_agent: true, second_agent: true, first_message: true, first_clearance: true })),
    );
    const { refreshOnboarding, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1" });
    await refreshOnboarding();
    expect($("onboarding-card").hidden).toBe(true);
  });

  it("stays hidden for this workspace after Hide, across a later refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, stepsPayload({})));
    const { refreshOnboarding, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1" });
    await refreshOnboarding();
    expect($("onboarding-card").hidden).toBe(false);

    $("onboarding-hide").click();
    expect($("onboarding-card").hidden).toBe(true);

    await refreshOnboarding();
    expect($("onboarding-card").hidden).toBe(true);
    expect(storage.getItem("opencadre.onboarding.hidden.org-1")).toBe("1");
  });

  it("degrades quietly when the request fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const { refreshOnboarding, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1" });
    await refreshOnboarding();
    expect($("onboarding-card").hidden).toBe(true);
  });
});
