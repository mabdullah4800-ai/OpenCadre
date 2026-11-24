// @vitest-environment happy-dom
// Agents show each agent's reviewed-work record and what it can do. The hub has had GET /v1/reliability/all
// (src/reliability.ts) and per-agent capabilities with no console surface. Red on the console before it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
type Ui = {
  setTrustData: (r: unknown, a: unknown[]) => void;
  renderOtherAgents: (a: unknown[]) => void;
  setMe: (v: unknown) => void;
};
function loadConsole(): Ui {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { setTrustData, renderOtherAgents, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as Ui;
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
const agent = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, kind: "named", key_class: "agent", role: "agent", online: true, usage: null, editing_files_parsed: [], ...over,
});

describe("an agent's reviewed-work record and capabilities", () => {
  it("shows accepted of reviewed, and what the agent can do", () => {
    const ui = loadConsole();
    ui.setMe({ agentId: "op", role: "operator" });
    const agents = [agent("a1", "Codex-api", { capabilities: JSON.stringify(["shell", "git-write"]) })];
    ui.setTrustData({ reliability: [{ agent_id: "a1", agent_name: "Codex-api", accepted: 3, rejected: 1, total: 4, accept_rate: 0.75 }] }, agents);
    ui.renderOtherAgents(agents);
    const text = document.getElementById("fleet-other-agents")!.textContent ?? "";
    expect(text).toContain("3 of 4 reviewed tasks accepted");
    expect(text).toContain("can: shell, git-write");
  });

  it("no reviewed task says nothing, never 0%", () => {
    const ui = loadConsole();
    ui.setMe({ agentId: "op", role: "operator" });
    const agents = [agent("a2", "Claude-web")];
    ui.setTrustData({ reliability: [{ agent_id: "a2", agent_name: "Claude-web", accepted: 0, rejected: 0, total: 0, accept_rate: null }] }, agents);
    ui.renderOtherAgents(agents);
    const text = document.getElementById("fleet-other-agents")!.textContent ?? "";
    expect(text).not.toMatch(/reviewed tasks accepted|0%/);
    expect(document.querySelector(".trust-chip")).toBeNull();
  });

  it("a record under half accepted is marked", () => {
    const ui = loadConsole();
    ui.setMe({ agentId: "op", role: "operator" });
    const agents = [agent("a3", "Codex-web")];
    ui.setTrustData({ reliability: [{ agent_id: "a3", agent_name: "Codex-web", accepted: 1, rejected: 3, total: 4, accept_rate: 0.25 }] }, agents);
    ui.renderOtherAgents(agents);
    expect(document.querySelector(".trust-chip")?.classList.contains("is-low")).toBe(true);
  });
});
