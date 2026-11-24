// @vitest-environment happy-dom
// Overview page (docs/design/HUB_REDESIGN.md 2.3, Stage 2): the new home page, reading only
// endpoints refresh() already fetches. "Needs your attention" previews pending clearances +
// unread messages + all directed awareness items; "What's happening" (Fleet glance) is
// operator-only per 2.3.3/2.6, but Key metrics is not -- both used to be gated together as one
// row, which was wrong (a Member's Overview would lose Key metrics too).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadConsole(fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () => json(200, {}))) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { renderOverview, setMe: (v) => { me = v; } };`,
  )(window, document, window.localStorage, fetchMock) as {
    renderOverview: (data: {
      approvals: any[]; messages: any[]; awarenessDigest: any; liveSessions: any[] | null;
      taskCounts?: Record<string, number> | null; grants: any[]; agents: any[]; events: any[];
    }) => void;
    setMe: (v: { role: string; orgName?: string; agentName?: string } | null) => void;
  };
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const approval = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "a1", action: "rm -rf build", risk: "medium", category: "shell",
  requested_by_agent_name: "Codex", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
  ...over,
});

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

const emptyData = { approvals: [], messages: [], awarenessDigest: null, liveSessions: null, taskCounts: null, grants: [], agents: [], events: [] };

describe("Overview: Needs your attention", () => {
  it("a partial read names the source that failed instead of saying only Partial", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "member" });
    const ok = { status: "ok", data: null, lastOkAt: 1 };
    const failed = { status: "failed", data: null, lastOkAt: 0 };
    const render = (sources: Record<string, unknown>) => (renderOverview as (d: unknown) => void)({ ...emptyData, sources: { sessions: ok, ...sources } });
    render({ approvals: failed, messages: ok, awareness: ok });
    const empty = () => $("overview-attention").querySelector(".empty") as HTMLElement;
    expect(empty().textContent).toBe("Approvals couldn't refresh");
    render({ approvals: failed, messages: failed, awareness: ok });
    expect(empty().textContent).toBe("Approvals and messages couldn't refresh");
    render({ approvals: ok, messages: ok, awareness: { status: "loading", data: null, lastOkAt: 0 } });
    expect(empty().textContent).toBe("Checking updates…");
    // A source this person may not read is not a failure: it says so.
    render({ approvals: ok, messages: { status: "forbidden", data: null, lastOkAt: 0 }, awareness: ok });
    expect(empty().textContent).toBe("Messages unavailable for your access");
    expect(empty().querySelector("[title]")).toBeNull();
  });

  it("shows an 'All clear' empty state and no count badge when nothing needs attention", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "member" });
    renderOverview(emptyData);
    expect($("overview-attention-count").hidden).toBe(true);
    expect($("overview-attention").querySelector(".empty")).toBeTruthy();
  });

  it("merges pending approvals, unread messages, and all directed awareness items into one count", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "member" });
    renderOverview({
      ...emptyData,
      approvals: [approval()],
      messages: [
        { id: "m1", from_agent_name: "Claude", body: "hi", created_at: new Date().toISOString(), read_at: null },
        { id: "m2", from_agent_name: "Claude", body: "already read", created_at: new Date().toISOString(), read_at: new Date().toISOString() },
      ],
      awarenessDigest: { items: [{ seq: 1, priority: 1, directed: true, summary: "needs you" }, { seq: 2, priority: 2, directed: true, summary: "fyi" }] },
    });
    // 1 approval + 1 unread message (read one excluded) + 2 directed updates = 4
    expect($("overview-attention-count").hidden).toBe(false);
    expect($("overview-attention-count").textContent).toBe("4");
    expect($("overview-attention").querySelectorAll(".strip")).toHaveLength(4);
  });

  it("caps the preview at 5 rows even when more items need attention", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "member" });
    const approvals = Array.from({ length: 7 }, (_, i) => approval({ id: `a${i}` }));
    renderOverview({ ...emptyData, approvals });
    expect($("overview-attention-count").textContent).toBe("7");
    expect($("overview-attention").querySelectorAll(".strip")).toHaveLength(5);
  });
});

describe("Overview: What's happening is operator-only, Key metrics is not", () => {
  it("hides the Fleet glance for a member but still renders Key metrics", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "member" });
    renderOverview({ ...emptyData, agents: [{ online: true }, { online: false }] });
    expect($("overview-happening-section").hidden).toBe(true);
    expect($("overview-metrics").querySelectorAll(".home-tile")).toHaveLength(4);
    // A member may not read live sessions: the tile counts the agents it can see, and says that is what it counts.
    expect($("overview-metrics").querySelector('[data-tile="agents"] .home-tile-number')?.textContent).toBe("1");
    expect($("overview-metrics").querySelector('[data-tile="agents"] .home-tile-unit')?.textContent).toBe("of 2 you can see");
  });

  it("shows the Fleet glance for an operator with live sessions", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "operator" });
    renderOverview({
      ...emptyData,
      agents: [{ id: "s1", kind: "session", online: true }],
      liveSessions: [{ agentName: "Codex-1", tool: "codex", online: true, agentId: "s1", currentTask: "building" }],
    });
    expect($("overview-happening-section").hidden).toBe(false);
    expect($("overview-happening").querySelectorAll(".strip")).toHaveLength(1);
  });

  // Audit 2026-09-23: "5 of 6 online" sat over 4 rows, because an online named agent (Release-Bot) was counted in the
  // summary and the stat but never listed. The list now includes it, so the count, the stat and the rows agree.
  it("lists an online named agent too, and its count, the stat and the rows agree", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "operator", agentId: "me" });
    renderOverview({
      ...emptyData,
      agents: [
        { id: "s1", kind: "session", online: true },
        { id: "rb", name: "Release-Bot", kind: "named", key_class: "agent", role: "agent", online: true, current_task: "deploying" },
        { id: "old", name: "Old-Bot", kind: "named", key_class: "agent", role: "agent", online: false },
        { id: "me", name: "Me", kind: "named", key_class: "human", role: "operator", online: true },
      ],
      liveSessions: [{ agentName: "Codex-1", tool: "codex", online: true, agentId: "s1", currentTask: "building" }],
    });
    const rows = [...$("overview-happening").querySelectorAll(".strip")].map((r) => r.querySelector(".callsign")?.textContent);
    expect(rows).toEqual(["Codex-1", "Release-Bot"]);
    expect($("overview-fleet-summary").textContent).toBe("2 of 2 online");
    expect($("overview-metrics").querySelector('[data-tile="agents"] .home-tile-number')?.textContent).toBe("2");
    expect($("overview-metrics").querySelector('[data-tile="agents"] .home-tile-unit')?.textContent).toBe("of 2 live");
  });

  // Codex-OpenCadre-f46c on 820ae2d: an operator-role key that is not the viewer is a working agent too (a self-serve
  // workspace hands out its first agent key with the operator role).
  it("an online operator-role agent that isn't the viewer is listed", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "operator", agentId: "me" });
    renderOverview({
      ...emptyData,
      agents: [{ id: "first", name: "First Agent", kind: "named", key_class: "agent", role: "operator", online: true }],
      liveSessions: [],
    });
    const rows = [...$("overview-happening").querySelectorAll(".strip")].map((r) => r.querySelector(".callsign")?.textContent);
    expect(rows).toEqual(["First Agent"]);
  });
});

describe("Overview: Key metrics", () => {
  it("counts open tasks the same way the Task board's Open column does (excludes leased claims)", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "member" });
    // The hub's five buckets (tasks tranche 2): Open is open + expired, as the board's Open column; a live lease is In progress.
    renderOverview({ ...emptyData, taskCounts: { open: 1, expired: 1, in_progress: 1, needs_review: 4, done: 7 } });
    const numbers = Array.from($("overview-metrics").querySelectorAll(".home-tile-number")).map((n) => n.textContent);
    expect(numbers[1]).toBe("2"); // open tasks: the open one + the claimed-but-lease-expired one
  });
});

describe("Overview: Recent activity", () => {
  it("shows an empty state with no events", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "member" });
    renderOverview(emptyData);
    expect($("overview-activity").querySelector(".empty")).toBeTruthy();
  });

  it("renders up to 8 recent events", () => {
    const { renderOverview, setMe } = loadConsole();
    setMe({ role: "member" });
    const events = Array.from({ length: 10 }, (_, i) => ({ type: "task.created", actor_agent_name: "Codex", payload: "{}", created_at: new Date().toISOString() }));
    renderOverview({ ...emptyData, events });
    expect($("overview-activity").querySelectorAll(".strip")).toHaveLength(8);
  });
});
