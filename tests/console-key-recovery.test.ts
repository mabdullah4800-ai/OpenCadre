// @vitest-environment happy-dom
// UX batch 1, fix 1 (Codex audit): a returning self-serve owner whose first agent key was shown once was told to
// "Rotate it in Settings → Connect". There is no Connect in Settings; Rotate key lives on Agents, under Named agents,
// and the workspace's first agent (role operator) was filtered out of that list, so the path did not exist at all.
// Red before the fix: the note named Settings → Connect and nothing on the card led anywhere.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Console = {
  renderFirstRun: () => Promise<void>;
  renderOtherAgents: (agents: unknown[]) => void;
  setMe: (v: unknown) => void;
  activeTab: () => string;
};

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function loadConsole(fetchMock: ReturnType<typeof vi.fn>): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { renderFirstRun, renderOtherAgents, setMe: (v) => { me = v; }, activeTab: () => activeTab };`,
  )(window, document, window.localStorage, fetchMock) as Console;
}

// The hub's own first agent (src/accounts.ts createWorkspace: FIRST_AGENT_NAME, role operator, a plain agent key).
const FIRST_AGENT = { id: "first", name: "First Agent", kind: "named", key_class: "agent", role: "operator", online: false, editing_files_parsed: [] };
const ME = { id: "me", name: "Ada", kind: "named", key_class: "human", role: "operator", online: true, editing_files_parsed: [] };

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  localStorage.clear();
  // A workspace this browser created on an earlier page load: the self-serve marker is on disk, the key is not.
  localStorage.setItem("opencadre.selfserve.org-1", "1");
});

describe("recovering the first agent key on a later visit", () => {
  it("names the real path, and its button opens Agents at that agent's Rotate key", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/v1/org/devices") return json(200, { devices: [] });
      if (path === "/v1/agents") return json(200, { agents: [ME, FIRST_AGENT] });
      return json(200, {});
    });
    const c = loadConsole(fetchMock);
    c.setMe({ orgId: "org-1", agentId: "me", role: "operator" });
    await c.renderFirstRun();

    const note = $("first-run-key-note").textContent ?? "";
    expect(note).not.toContain("Settings → Connect");
    expect(note).toContain("Agents → Agents without a linked computer → First Agent → Rotate key");

    const go = $("first-run-key-go") as HTMLButtonElement;
    expect(go).toBeTruthy();
    expect(go.hidden).toBe(false);
    go.click();
    expect(c.activeTab()).toBe("fleet");
    expect($("fleet-agents-view").hidden).toBe(false);
    expect(location.hash).toBe("#/agents/named");

    // The list lands on the next poll: the row it was sent for is marked and its Rotate key button takes focus.
    c.renderOtherAgents([ME, FIRST_AGENT]);
    const rotate = document.querySelector<HTMLButtonElement>('[data-rotate="first"]');
    expect(rotate).toBeTruthy();
    expect(rotate!.closest(".strip")!.classList.contains("is-found")).toBe(true);
    expect(document.activeElement).toBe(rotate);
  });

  it("lists an operator-role agent that isn't the viewer under Named agents, and still hides the viewer's own", () => {
    const c = loadConsole(vi.fn(async () => json(200, {})));
    c.setMe({ orgId: "org-1", agentId: "op", role: "operator" });
    const operatorKey = { ...FIRST_AGENT, id: "op", name: "Operator" };
    c.renderOtherAgents([operatorKey, FIRST_AGENT]);
    const names = [...document.querySelectorAll("#fleet-other-agents .callsign")].map((n) => n.textContent);
    expect(names).toEqual(["First Agent"]);
  });
});
