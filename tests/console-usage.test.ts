// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// An in-memory Storage, as in console-keys.test.ts: newer Node versions expose a partial localStorage global.
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

function loadConsole(): { renderOtherAgents: (agents: unknown[]) => void; summarizeEvent: (e: unknown) => string } {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${appJs}; return { renderOtherAgents, summarizeEvent };`)(
    window, document, memoryStorage(), vi.fn(),
  );
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

const agent = (name: string, usage: unknown) => ({
  id: name, name, online: false, current_task: null, editing_files_parsed: [], last_heartbeat_at: null, usage,
});
const usage = (fields: Record<string, unknown>) => ({
  usedPct: null, window: null, resetsAt: null, limited: false, plan: null, source: "codex", reportedAt: new Date().toISOString(), ...fields,
});
const chipOf = (name: string) =>
  [...document.querySelectorAll(".strip")].find((s) => s.querySelector(".callsign")?.textContent === name)?.querySelector(".usage-chip");

describe("console fleet usage chip", () => {
  it("shows usage in a neutral chip, amber from 80%", () => {
    loadConsole().renderOtherAgents([
      agent("Codex-Low", usage({ usedPct: 77.4, window: "7d" })),
      agent("Codex-High", usage({ usedPct: 80, window: "5h" })),
    ]);
    const low = chipOf("Codex-Low")!;
    expect(low.textContent).toBe("77% · 7d");
    expect(low.className).toBe("status-chip usage-chip");
    const high = chipOf("Codex-High")!;
    expect(high.textContent).toBe("80% · 5h");
    expect(high.className).toBe("status-chip usage-chip chip-waiting");
  });

  it("shows an out-of-usage agent in red with its reset time", () => {
    const resetsAt = new Date(Date.now() + 60 * 60_000);
    loadConsole().renderOtherAgents([
      agent("Antigravity-Out", usage({ limited: true, source: "antigravity" })),
      agent("Cursor-Out", usage({ limited: true, usedPct: 100, resetsAt: resetsAt.toISOString() })),
    ]);
    const unknown = chipOf("Antigravity-Out")!;
    expect(unknown.textContent).toBe("Out of usage · resets unknown");
    expect(unknown.className).toBe("status-chip usage-chip chip-limited");
    const hhmm = `${String(resetsAt.getHours()).padStart(2, "0")}:${String(resetsAt.getMinutes()).padStart(2, "0")}`;
    expect(chipOf("Cursor-Out")!.textContent).toMatch(new RegExp(`^Out of usage · resets (\\w{3} \\d{1,2} )?${hhmm}$`));
  });

  it("shows no chip without usage to report", () => {
    loadConsole().renderOtherAgents([agent("Claude-None", null), agent("Antigravity-Back", usage({ source: "antigravity" }))]);
    expect(document.querySelectorAll(".usage-chip")).toHaveLength(0);
  });

  it("labels usage transitions on the timeline", () => {
    const { summarizeEvent } = loadConsole();
    const event = (type: string, payload: unknown) => ({ type, actor_agent_name: "Cursor-Out", payload: JSON.stringify(payload) });
    expect(summarizeEvent(event("agent.usage_limited", { source: "manual", resetsAt: null }))).toBe("Cursor-Out is out of usage");
    expect(summarizeEvent(event("agent.usage_restored", { source: "manual" }))).toBe("Cursor-Out has usage again");
  });
});
