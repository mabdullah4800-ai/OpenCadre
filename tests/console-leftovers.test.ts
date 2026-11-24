// @vitest-environment happy-dom
// What the live walk-through (2026-09-23) still showed after the controls pass. Each arm is red on the console before
// this change: a named agent's status filled a screen with raw **markdown**, a done task's result sat unclamped in its
// meta line, a claim that lapsed days ago read "held" and "expiring", a question opened as "Message", and opening a
// message moved it to the top of the list.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
type Ui = {
  renderOtherAgents: (a: unknown[]) => void; renderTasks: (t: unknown[]) => void; renderFileLocks: (l: unknown[] | null) => void;
  messageFocus: (m: unknown) => HTMLElement; renderInbox: (m: unknown[]) => void; openAs: (m: unknown) => void;
};
function loadConsole(): Ui {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; me = { role: "operator", agentId: "me" }; authMode = "key";
     return { renderOtherAgents, renderTasks, renderFileLocks, messageFocus, renderInbox,
       openAs: (m) => { openMessageId = m.id; openMessageData = m; } };`,
  )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as Ui;
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const LONG = `LEAD / HEAD OPERATOR **NOBODY IS PAUSED** (operator ruling) - ${"merged #311, #320, #316; ".repeat(20)}`;

describe("a named agent's long status", () => {
  it("is plain text, clamped, with a Show more that opens and closes it", () => {
    const ui = loadConsole();
    ui.renderOtherAgents([{ id: "a1", name: "Agent-FFH9", kind: "named", key_class: "agent", role: "agent", online: false,
      current_task: LONG, editing_files_parsed: [], last_heartbeat_at: at(-60 * 72) }]);
    const body = $("fleet-other-agents").querySelector(".strip-body.clamp") as HTMLElement;
    expect(body.textContent).not.toContain("**");
    expect(body.textContent).toContain("NOBODY IS PAUSED");
    const toggle = $("fleet-other-agents").querySelector(".clamp-toggle") as HTMLButtonElement;
    expect(toggle.textContent).toBe("Show more");
    toggle.click();
    expect(body.classList.contains("is-open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("a short status gets no toggle", () => {
    const ui = loadConsole();
    ui.renderOtherAgents([{ id: "a1", name: "Agent-X", kind: "named", key_class: "agent", role: "agent", online: true,
      current_task: "deploying", editing_files_parsed: [], last_heartbeat_at: at(0) }]);
    expect($("fleet-other-agents").querySelector(".clamp-toggle")).toBeNull();
  });
});

describe("a done task's result", () => {
  it("is its own clamped paragraph, not part of the meta line", () => {
    const ui = loadConsole();
    ui.renderTasks([{ id: "t1", title: "Wire checkout", status: "done", claimed_by_agent_name: "Codex", completed_at: at(-180),
      completion_summary: LONG, created_by_agent_name: "Ada", created_at: at(-600) }]);
    const card = document.querySelectorAll("#tasks .column")[2].querySelector(".task") as HTMLElement;
    expect(card.querySelector(".task-meta")?.textContent).toBe("done by Codex · 3h ago · unreviewed");
    expect(card.querySelector(".task-summary.clamp")?.textContent).toContain("NOBODY IS PAUSED");
  });
});

describe("a claim that lapsed", () => {
  it("is not counted as held, sorts after held ones, and says when it lapsed", () => {
    const ui = loadConsole();
    ui.renderFileLocks([
      { resource_key: "public/site/index.html", holder_agent_name: "ClaudeCode-46f9", note: "waitlist", acquired_at: at(-60 * 24 * 4), lease_expires_at: at(-60 * 24 * 4 + 30) },
      { resource_key: "src/rest.ts", holder_agent_name: "Codex-api", note: "API half", acquired_at: at(-5), lease_expires_at: at(25) },
    ]);
    expect($("fleet-locks-summary").textContent).toBe("1 held · 1 lapsed");
    const rows = [...$("fleet-locks-list").querySelectorAll(".strip")];
    expect(rows[0].querySelector(".row-command")?.textContent).toBe("src/rest.ts");
    expect(rows[1].classList.contains("is-lapsed")).toBe(true);
    expect(rows[1].querySelector(".row-seen")?.textContent).toMatch(/^lapsed \d+d ago$/);
  });
});

describe("Inbox", () => {
  it("a question opens as a Question, answered with Send answer, without 'medium priority' noise", () => {
    const ui = loadConsole();
    const pane = ui.messageFocus({ id: "m1", thread_id: "t1", kind: "question", from_agent_name: "Release-Bot", priority: "medium",
      body: "OK to roll it to prod?", created_at: at(0) });
    expect(pane.querySelector(".row-kind")?.textContent).toBe("Question");
    expect(pane.querySelector("button[type=submit]")?.textContent).toBe("Send answer");
    expect(pane.querySelector(".inbox-focus-meta")?.textContent).not.toContain("priority");
  });

  it("opening a message keeps its place in the list", () => {
    const ui = loadConsole();
    const same = at(0);
    const msgs = [
      { id: "q", thread_id: "t1", kind: "question", from_agent_name: "Release-Bot", priority: "medium", body: "Q", created_at: same },
      { id: "m", thread_id: "t2", kind: "message", from_agent_name: "Release-Bot", priority: "medium", body: "M", created_at: same },
    ];
    ui.renderInbox(msgs);
    const order = () => [...$("inbox-list").querySelectorAll(".strip")].map((n) => (n as HTMLElement).dataset.inboxId);
    const before = order();
    ui.openAs({ ...msgs.find((m) => m.id === before[1])!, read_at: at(0) });
    ui.renderInbox(msgs);
    expect(order()).toEqual(before);
  });
});
