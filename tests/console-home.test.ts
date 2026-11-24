// @vitest-environment happy-dom
// Home as the dispatch board (docs/design/CONSOLE-V2.md §4.4, slice V3; bug B3; feature F3).
// Each describe fails on the card-based Overview it replaces.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function loadConsole(fetchMock = vi.fn(async () => json(200, {}))) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { renderOverview, renderOverviewHappening, renderGoal, refreshGoal, overviewAwarenessStrip, renderTimeline, renderOverviewActivity,
      setMe: (v) => { me = v; }, setWorkspace: (w) => { currentWorkspace = w; authMode = "session"; } };`,
  )(window, document, window.localStorage, fetchMock) as {
    renderOverview: (d: Record<string, unknown>) => void;
    renderOverviewHappening: (sessions: unknown[] | null, agents: unknown[]) => void;
    renderGoal: (goal: unknown) => void;
    refreshGoal: () => Promise<void>;
    overviewAwarenessStrip: (item: unknown) => HTMLElement;
    renderTimeline: (events: unknown[]) => void;
    renderOverviewActivity: (events: unknown[]) => void;
    setMe: (v: unknown) => void;
    setWorkspace: (w: string) => void;
  };
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("the tiles read as words", () => {
  // Was one status line ("2 agents online1 open task..."); the same four numbers are now four tiles, each a value with
  // its own label and a foot that says what the value counts.
  it("each tile carries its number, and its label and foot say what it counts", () => {
    const c = loadConsole();
    // Task counts are the hub's buckets since tasks tranche 2 (GET /v1/tasks' counts), not a list the console counts.
    c.renderOverview({ approvals: [], messages: [], awarenessDigest: null, liveSessions: null, grants: [{ agent_name: "Bot", category: "git", expires_at: new Date(Date.now() + 600_000).toISOString() }],
      agents: [{ id: "a", online: true }, { id: "b", online: true }], events: [], taskCounts: { open: 1, expired: 0, in_progress: 3, needs_review: 2, done: 9 } });
    const tile = (k: string) => document.querySelector(`[data-tile="${k}"]`) as HTMLElement;
    const value = (k: string) => tile(k).querySelector(".home-tile-number")?.textContent;
    expect(["agents", "tasks", "approvals", "grants"].map(value)).toEqual(["2", "1", "0", "1"]);
    expect(tile("agents").textContent).toContain("Agents online");
    expect(tile("agents").textContent).toContain("2 online · 0 offline");
    expect(tile("tasks").textContent).toContain("3 in progress · 2 waiting for review");
    expect(tile("approvals").textContent).toContain("Nothing is waiting");
    expect(tile("grants").textContent).toContain("Bot · git · 10m left");
  });
});

describe("Working now lists every live session, chats first (B3)", () => {
  const session = (name: string, liveness: string | null, over: Record<string, unknown> = {}) =>
    ({ agentId: name, agentName: name, tool: "codex", project: "api", deviceName: "MacBook", online: true, liveness, lastHeartbeatAt: new Date().toISOString(), ...over });

  it("a session that hasn't acted yet is listed, dimmed and last, never hidden", () => {
    const c = loadConsole();
    c.renderOverviewHappening([session("quiet", "process"), session("busy", "chat", { currentTask: "Fix the login test" })], []);
    const rows = [...$("overview-happening").querySelectorAll(".strip")];
    expect(rows.map((r) => r.querySelector(".callsign")?.textContent)).toEqual(["busy", "quiet"]);
    expect(rows[1].classList.contains("is-pending")).toBe(true);
    expect(rows[1].querySelector(".row-task")?.textContent).toBe("Waiting for its first action");
    expect(rows[0].querySelector(".row-task")?.textContent).toBe("Fix the login test");
  });

  it("each row says where the session runs", () => {
    const c = loadConsole();
    c.renderOverviewHappening([session("busy", "chat")], []);
    expect($("overview-happening").querySelector(".row-where")?.textContent).toBe("api · MacBook");
  });

  it("no sessions at all offers Add a computer", () => {
    const c = loadConsole();
    c.renderOverviewHappening([], []);
    expect($("overview-happening").textContent).toContain("Add a computer");
  });
});

describe("the fleet goal is on Home (F3)", () => {
  it("shows the goal with who set it, and a long one is clamped with Show all", () => {
    const c = loadConsole();
    c.renderGoal({ text: "Line one\nLine two\nLine three\nLine four", set_by_agent_name: "9d1f", set_at: new Date().toISOString() });
    expect($("overview-goal").hidden).toBe(false);
    expect($("overview-goal-text").classList.contains("is-clamped")).toBe(true);
    expect($("overview-goal-toggle").hidden).toBe(false);
    expect($("overview-goal-meta").textContent).toContain("set by 9d1f");
    $("overview-goal-toggle").click();
    expect($("overview-goal-text").classList.contains("is-clamped")).toBe(false);
    expect($("overview-goal-toggle").textContent).toBe("Show less");
  });

  it("no goal, no section", () => {
    const c = loadConsole();
    c.renderGoal(null);
    expect($("overview-goal").hidden).toBe(true);
  });
});

describe("a directed update on Home is labelled by what it is (f46c on 7dbb8f2)", () => {
  it("only a question says Question and Answer", () => {
    const c = loadConsole();
    const row = (type: string) => {
      const node = c.overviewAwarenessStrip({ type, summary: "x", actor: "Release-Bot" });
      return [node.querySelector(".row-kind")?.textContent, node.querySelector("button")?.textContent];
    };
    expect(row("question.asked")).toEqual(["Question", "Answer"]);
    expect(row("conflict.detected")).toEqual(["Conflict", "Open"]);
    expect(row("task.lease_expired")).toEqual(["Task", "Open"]);
    expect(row("goal.set")).toEqual(["Goal", "Open"]);
    expect(row("something.new")).toEqual(["Update", "Open"]);
  });
});

describe("the goal belongs to one workspace (f46c on 7dbb8f2)", () => {
  it("switching workspace clears the old goal at once and never shows a reply meant for the old one", async () => {
    let release: (v: unknown) => void = () => {};
    const replies: Record<string, unknown> = {};
    const fetchMock = vi.fn((url: string, init: { headers?: Record<string, string> }) => {
      const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "";
      if (url !== "/v1/goal") return Promise.resolve(json(200, {}));
      if (ws === "ws-a") return new Promise((r) => { release = r; }); // the old workspace's reply is slow
      return Promise.resolve(json(200, replies[ws] ?? { goal: null }));
    });
    const c = loadConsole(fetchMock as never);
    replies["ws-b"] = { goal: { text: "Ship billing", set_by_agent_name: "Owner-B", set_at: new Date().toISOString() } };
    c.setWorkspace("ws-a");
    const slow = c.refreshGoal();
    c.setWorkspace("ws-b");
    await c.refreshGoal();
    expect($("overview-goal-text").textContent).toBe("Ship billing");
    release(json(200, { goal: { text: "A's goal", set_by_agent_name: "Owner-A", set_at: new Date().toISOString() } }));
    await slow;
    expect($("overview-goal-text").textContent).toBe("Ship billing");
  });
});

describe("Home Recent activity uses sentences for common events", () => {
  it("names computer, project and chat changes without raw event codes", () => {
    const c = loadConsole();
    const created_at = new Date().toISOString();
    c.renderOverviewActivity([
      { seq: 1, type: "device.created", actor_agent_name: "Grace", payload: JSON.stringify({ name: "Studio PC" }), created_at },
      { seq: 2, type: "project.enabled", actor_agent_name: "Grace", payload: JSON.stringify({ name: "Website" }), created_at },
      { seq: 3, type: "session.joined", actor_agent_name: "Grace", payload: "{}", created_at },
    ]);
    const text = $("overview-activity").textContent ?? "";
    expect(text).toContain("Grace started connecting Studio PC");
    expect(text).toContain("Grace enabled project Website");
    expect(text).toContain("Grace started a chat");
    expect(text).not.toMatch(/device\\.created|project\\.enabled|session\\.joined/);
  });
});
describe("reviewed V5 navigation and Activity state", () => {
  it("a directed conflict, decision, or unknown update opens the actionable Inbox mention", () => {
    const c = loadConsole();
    for (const type of ["conflict.detected", "decision.recorded", "future.event"]) {
      const row = c.overviewAwarenessStrip({ type, priority: 1, directed: true, summary: "Needs review", actor: "Teammate" });
      row.querySelector<HTMLButtonElement>("button")!.click();
      expect(location.hash).toBe("#/inbox");
      expect(document.querySelector('[data-inbox-section="mentions"]')?.hasAttribute("hidden")).toBe(false);
      expect(document.querySelector('#inbox-filter-bar [data-filter="mentions"]')?.getAttribute("aria-pressed")).toBe("true");
    }
  });

  it("keeps an event's Details open when Activity refreshes the same event", () => {
    const c = loadConsole();
    const event = { seq: 42, type: "decision.recorded", actor_agent_name: "Grace", payload: JSON.stringify({ title: "Ship" }), created_at: new Date().toISOString() };
    c.renderTimeline([event]);
    const details = document.querySelector<HTMLDetailsElement>(".activity-event-details")!;
    details.open = true;
    c.renderTimeline([{ ...event, payload: JSON.stringify({ title: "Ship carefully" }) }]);
    expect(document.querySelector<HTMLDetailsElement>(".activity-event-details")?.open).toBe(true);
    expect(document.querySelector(".timeline-summary")?.textContent).toContain("Ship carefully");
  });
});

// Plan 2026-09-30-console-refresh-tasks.md §2 item 5: an idle live session (a chat still open, with no heartbeat for a
// while; Cursor sends none while idle) was silently dropped from Working now. It is shown, dimmed and last, saying how
// long it has been idle. An ended session is not shown.
describe("Working now keeps idle chats and leaves out ended ones", () => {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const session = (name: string, over: Record<string, unknown> = {}) =>
    ({ agentId: name, agentName: name, tool: "cursor", project: "api", deviceName: "MacBook", online: true, liveness: "chat", lastHeartbeatAt: at(0), ...over });

  it("an idle live session is listed after the active ones, dimmed, as idle for how long", () => {
    const c = loadConsole();
    c.renderOverviewHappening([session("quiet", { online: false, lastHeartbeatAt: at(12) }), session("busy", { currentTask: "Fix the login test" })], []);
    const rows = [...$("overview-happening").querySelectorAll(".strip")];
    expect(rows.map((r) => r.querySelector(".callsign")?.textContent)).toEqual(["busy", "quiet"]);
    expect(rows[1].classList.contains("is-idle")).toBe(true);
    expect(rows[1].querySelector(".state-word")?.textContent).toBe("idle 12m");
    expect(rows[0].classList.contains("is-idle")).toBe(false);
    expect($("overview-fleet-summary").textContent).toBe("1 of 2 online");
  });

  it("an ended session is not listed", () => {
    const c = loadConsole();
    c.renderOverviewHappening([session("busy"), session("gone", { online: false, endedAt: at(3), lastHeartbeatAt: at(4) })], []);
    const names = [...$("overview-happening").querySelectorAll(".callsign")].map((n) => n.textContent);
    expect(names).toEqual(["busy"]);
  });
});
