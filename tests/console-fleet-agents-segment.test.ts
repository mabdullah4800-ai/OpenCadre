// @vitest-environment happy-dom
// Fleet restyle (docs/design/HUB_REDESIGN.md 1.8/5.5, Stage 4): Agents becomes a third segment of
// the view toggle (By project / By computer / Agents) instead of a separately-scrolled-to "Other
// agents" section always visible below the live sessions. Per operator feedback (1.8.2), the
// Agents segment holds only real named tool agents -- no people, no legacy operator key, no
// catch-all "Other" bucket.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Agent = { id: string; name: string; role?: string; key_class?: string; kind?: string; online: boolean; editing_files_parsed: string[]; last_heartbeat_at: string | null };
type Console = {
  renderOtherAgents: (agents: Agent[]) => void;
  setMe: (v: { role: string } | null) => void;
};

function loadConsole(fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () => json(200, {}))): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { renderOtherAgents, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, fetchMock) as Console;
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent =>
  ({ id, name, role: "agent", key_class: "agent", kind: "named", online: true, editing_files_parsed: [], last_heartbeat_at: null, ...extra });

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("Fleet view toggle: Agents is a third segment", () => {
  it("has exactly three segments: By project, By computer, Agents without a linked computer", () => {
    // The third segment carries a short form for phone widths (below), so its full label is its accessible name.
    const labels = Array.from(document.querySelectorAll(".view-toggle-btn")).map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(labels).toEqual(["By project", "By computer", "Agents without a linked computer"]);
  });

  it("the long segment label has a short form for phone widths, shown instead of wrapping", () => {
    const btn = document.querySelector('.view-toggle-btn[data-view="agents"]')!;
    expect(btn.querySelector(".label-long")?.textContent).toBe("Agents without a linked computer");
    // "Unlinked", not "No computer": the agent may well run on a computer, one the hub has no link to (Codex on #655).
    expect(btn.querySelector(".label-short")?.textContent).toBe("Unlinked");
    expect(btn.querySelector(".label-short")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("starts on By project, with the sessions view visible and the agents view hidden", () => {
    expect($("fleet-sessions-view").hidden).toBe(false);
    expect($("fleet-agents-view").hidden).toBe(true);
  });

  it("clicking Agents swaps to the agents view and marks the segment pressed", () => {
    loadConsole();
    document.querySelector<HTMLButtonElement>('.view-toggle-btn[data-view="agents"]')!.click();
    expect($("fleet-sessions-view").hidden).toBe(true);
    expect($("fleet-agents-view").hidden).toBe(false);
    expect(document.querySelector('.view-toggle-btn[data-view="agents"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('.view-toggle-btn[data-view="project"]')!.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking back to By project restores the sessions view", () => {
    loadConsole();
    document.querySelector<HTMLButtonElement>('.view-toggle-btn[data-view="agents"]')!.click();
    document.querySelector<HTMLButtonElement>('.view-toggle-btn[data-view="project"]')!.click();
    expect($("fleet-sessions-view").hidden).toBe(false);
    expect($("fleet-agents-view").hidden).toBe(true);
  });
});

describe("Agents segment content: real named tool agents only (1.8.2)", () => {
  it("excludes session-kind rows, a person's member agent, and the legacy operator-role key", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator" });
    ui.renderOtherAgents([
      agent("c1", "Coder"),
      agent("s1", "ClaudeCode-OpenCadre-3f2a", { kind: "session" }),
      agent("m1", "Ada", { key_class: "human" }),
      agent("op", "Operator", { role: "operator" }),
    ]);
    const names = Array.from($("fleet-other-agents").querySelectorAll(".callsign")).map((n) => n.textContent);
    expect(names).toEqual(["Coder"]);
  });

  it("never shows a 'Person' or 'Workspace key (legacy)' label -- those rows just don't render", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator" });
    ui.renderOtherAgents([agent("m1", "Ada", { key_class: "human" }), agent("op", "Operator", { role: "operator" })]);
    expect($("fleet-other-agents").textContent).toBe("No agents without a linked computer yet.");
  });

  // Changed 2026-09-30: this pinned a tool label ("Codex") guessed from the agent's NAME. The hub reports no tool for an
  // agent that connects with its own key, and Codex-OpenCadre-049a ruled "do not invent a device or vendor association",
  // so the row shows no tool at all (a session's tool, which the hub does report, is still shown on its own rows).
  it("shows no tool guessed from the agent's name", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator" });
    ui.renderOtherAgents([agent("c1", "Codex-1")]);
    const row = $("fleet-other-agents").querySelector(".strip") as HTMLElement;
    expect(row.querySelector(".vendor-tag")).toBeNull();
    expect(row.dataset.vendor).toBeUndefined();
    expect(row.textContent).not.toContain("Codex-1Codex");
  });
});

// Plan 2026-09-30-console-refresh-tasks.md §2 item 5: the list says when each agent was last seen, and offline agents
// sit apart from live ones.
describe("Agents without a linked computer: last seen, and offline apart", () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  it("live agents come first, offline ones under an Offline label, and every row says when it was last seen", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator" });
    ui.renderOtherAgents([
      agent("r1", "Reasonix-Old", { online: false, last_heartbeat_at: minutesAgo(3 * 24 * 60) }),
      agent("c1", "Cursor-Cloud", { last_heartbeat_at: minutesAgo(1) }),
      agent("n1", "Never-Here", { online: false, last_heartbeat_at: null }),
    ]);
    const list = $("fleet-other-agents");
    const order = [...list.querySelectorAll(".callsign, .session-device-label")].map((n) => n.textContent);
    expect(order).toEqual(["Cursor-Cloud", "Offline", "Never-Here", "Reasonix-Old"]);
    const meta = (name: string) => [...list.querySelectorAll(".strip")].find((s) => s.querySelector(".callsign")?.textContent === name)!.querySelector(".strip-meta")!.textContent;
    expect(meta("Cursor-Cloud")).toContain("last seen 1m ago");
    expect(meta("Reasonix-Old")).toContain("last seen 3d ago");
    expect(meta("Never-Here")).toContain("never connected");
    // An offline agent is not called "Idle": that word means a live agent with nothing to do.
    const body = (name: string) => [...list.querySelectorAll(".strip")].find((s) => s.querySelector(".callsign")?.textContent === name)!.querySelector(".strip-body")!.textContent;
    expect(body("Reasonix-Old")).toBe("Not connected");
  });

  it("with everyone live there is no Offline label", () => {
    const ui = loadConsole();
    ui.setMe({ role: "operator" });
    ui.renderOtherAgents([agent("c1", "Cursor-Cloud", { last_heartbeat_at: minutesAgo(1) })]);
    expect($("fleet-other-agents").querySelector(".session-device-label")).toBeNull();
  });
});
