// @vitest-environment happy-dom
// The full UI audit (2026-09-23), the fixes that change what a card says. Each arm is red on the console before it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
type Ui = { inboxStrip: (m: unknown) => HTMLElement; clearanceStrip: (a: unknown) => HTMLElement; sessionStrip: (s: unknown, ended: boolean) => HTMLElement };
function loadConsole(): Ui {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${appJs}; return { inboxStrip, clearanceStrip, sessionStrip };`)(
    window, document, window.localStorage, vi.fn(async () => json(200, {}))) as Ui;
}
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
const message = (over: Record<string, unknown> = {}) => ({
  id: "m1", thread_id: "t1", from_agent_name: "Release-Bot", body: "Deploy finished.", priority: "medium", kind: "message",
  created_at: new Date().toISOString(), read_at: null, ...over,
});

describe("Inbox cards say who, and flag only what matters", () => {
  it("a message is titled by its sender, with its kind as the small label", () => {
    const card = loadConsole().inboxStrip(message());
    expect(card.querySelector(".callsign")?.textContent).toBe("Release-Bot");
    expect(card.querySelector(".vendor-tag")?.textContent).toBe("Message");
  });

  it("an ordinary message carries no priority pill; a high one does", () => {
    const ui = loadConsole();
    expect(ui.inboxStrip(message()).textContent).not.toMatch(/priority/);
    expect(ui.inboxStrip(message({ priority: "high" })).textContent).toContain("high priority");
  });

  it("an approval says it is an approval, with its category", () => {
    const card = loadConsole().clearanceStrip({
      id: "a1", requested_by_agent_name: "Release-Bot", requested_by_agent_id: "rb", category: "rm-rf", risk: "high",
      action: "rm -rf ./dist", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 900_000).toISOString(),
    });
    expect(card.querySelector(".vendor-tag")?.textContent).toBe("Approval · rm-rf");
  });
});

describe("Agents rows", () => {
  // Changed 2026-09-30: a quiet LIVE session says how long it has been idle ("idle 12m"), the same words as Home,
  // instead of "offline" plus "seen 12m ago".
  it("say how long a session has been idle only once it has gone quiet", () => {
    const ui = loadConsole();
    const base = { agentId: "s1", agentName: "Codex-api", tool: "codex", liveness: "chat", lastHeartbeatAt: new Date(Date.now() - 12 * 60_000).toISOString() };
    expect(ui.sessionStrip({ ...base, online: true }, false).textContent).not.toMatch(/idle/);
    expect(ui.sessionStrip({ ...base, online: false }, false).textContent).toMatch(/idle 12m/);
    expect(ui.sessionStrip({ ...base, online: false }, false).textContent).not.toMatch(/offline|seen /);
  });
});

// The audit on #557 + #568 combined: each message appeared up to three times on Home and in the Inbox (the message,
// a Question update with the same text, and a "Heads up" in agent-facing words: "read it with get_messages; thread …").
describe("a message is listed once", () => {
  it("Home drops an update that only announces an unread message already listed, and labels a question", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const c = new Function("window", "document", "localStorage", "fetch", `${appJs}; return { renderOverview, setMe: (v) => { me = v; } };`)(
      window, document, window.localStorage, vi.fn(async () => json(200, {}))) as { renderOverview: (d: unknown) => void; setMe: (v: unknown) => void };
    c.setMe({ role: "member" });
    const t1 = "11111111-1111-1111-1111-111111111111";
    const t2 = "22222222-2222-2222-2222-222222222222";
    const now = new Date().toISOString();
    c.renderOverview({
      approvals: [], tasks: [], grants: [], agents: [], events: [], liveSessions: null,
      messages: [
        { id: "m1", thread_id: t1, kind: "question", body: "OK to roll to prod?", from_agent_name: "Release-Bot", created_at: now, read_at: null },
        { id: "m2", thread_id: t2, kind: "message", body: "Deploy finished.", from_agent_name: "Release-Bot", created_at: now, read_at: null },
      ],
      awarenessDigest: { items: [
        { seq: 1, type: "question.asked", priority: 1, directed: true, actor: "Release-Bot", summary: `Release-Bot asked you a question (reply on thread ${t1})`, reason: "q" },
        { seq: 2, type: "message.sent", priority: 2, directed: true, actor: "Release-Bot", summary: `Release-Bot sent you a message (read it with get_messages; thread ${t2})`, reason: "m" },
        { seq: 3, type: "conflict.detected", priority: 1, directed: true, actor: "Codex-api", summary: "Codex-api is editing a file you hold", reason: "c" },
      ] },
    });
    const text = document.getElementById("overview-attention")!.textContent ?? "";
    expect(text.match(/OK to roll to prod\?/g)?.length, "the question once").toBe(1);
    expect(text).not.toMatch(/get_messages|thread 2222/);
    expect(text).toContain("Codex-api is editing a file you hold"); // an update that is not a message stays
    const rows = [...document.querySelectorAll("#overview-attention .row-kind")].map((n) => n.textContent);
    expect(rows).toContain("Question");
  });
});
