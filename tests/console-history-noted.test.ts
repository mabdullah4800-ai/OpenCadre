// @vitest-environment happy-dom
// Board task cf34b4c2: Inbox > History reads GET /v1/approvals, the reader list_approvals shares, and its 15 newest
// non-pending rows were all notify-only "noted" records once a gate reported a few hundred commands. The hub now leaves
// those out by default; History says so with a visible "Show noted commands" toggle that asks for includeNoted=true.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function loadConsole(fetchMock: ReturnType<typeof vi.fn>) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { selectTab, setAgentKey: (v) => { agentKey = v; } };`,
  )(window, document, window.localStorage, fetchMock) as { selectTab: (n: string) => void; setAgentKey: (v: string) => void };
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("Inbox History and notify-only records", () => {
  it("reads History without noted records, and the toggle asks for them", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/v1/me") return json(200, { orgId: "ws", orgName: "ws", agentId: "me", agentName: "Ada", role: "operator", workspace: { paused: false } });
      if (path === "/v1/agents") return json(200, { agents: [] });
      if (path.startsWith("/v1/approvals")) return json(200, { approvals: [], notedHidden: 0 });
      if (path === "/v1/approval-grants") return json(200, { grants: [] });
      if (path.startsWith("/v1/tasks")) return json(200, { tasks: [], nextCursor: null });
      if (path.startsWith("/v1/events")) return json(200, { events: [] });
      if (path.startsWith("/v1/messages")) return json(200, { messages: [] });
      if (path === "/v1/awareness") return json(200, { items: [], background: {}, cursor: 0 });
      if (path === "/v1/org/devices") return json(200, { devices: [] });
      if (path.startsWith("/v1/org/sessions")) return json(200, { sessions: [] });
      if (path === "/v1/org/projects") return json(200, { projects: [] });
      if (path === "/v1/onboarding") return json(200, { completed: 1, total: 1, steps: [] });
      if (path.startsWith("/v1/reliability")) return json(200, { agents: [] });
      return json(200, {});
    });
    const c = loadConsole(fetchMock);
    c.setAgentKey("test-key");
    c.selectTab("inbox");
    document.querySelector<HTMLButtonElement>('.inbox-view-tab[data-inbox-view="history"]')!.click();
    const urls = () => fetchMock.mock.calls.map(([url]) => url as string);
    await vi.waitFor(() => expect(urls()).toContain("/v1/approvals"));
    expect(urls()).not.toContain("/v1/approvals?includeNoted=true");

    const toggle = $("history-show-noted");
    expect(toggle.textContent).toBe("Show noted commands");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await vi.waitFor(() => expect(urls()).toContain("/v1/approvals?includeNoted=true"), { timeout: 5000 });
  });
});
