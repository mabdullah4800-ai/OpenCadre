// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
function loadConsole(fetchMock = vi.fn(async () => json(200, { ok: true }))) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { renderClearances, renderInbox, renderInboxMentions, syncInboxWorkspace, refresh,
      setView: (view) => { inboxView = view; }, setTab: (tab) => { activeTab = tab; },
      setSession: (workspace) => { authMode = "session"; currentWorkspace = workspace; },
      setMe: (value) => { me = value; } };`,
  )(window, document, window.localStorage, fetchMock) as {
    renderClearances: (items: unknown[]) => void;
    renderInbox: (items: unknown[]) => void;
    renderInboxMentions: (digest: unknown) => void;
    syncInboxWorkspace: () => void;
    refresh: () => Promise<void>;
    setView: (view: string) => void;
    setTab: (tab: string) => void;
    setSession: (workspace: string) => void;
    setMe: (value: unknown) => void;
  };
}
const approval = () => ({
  id: "a1", requested_by_agent_id: "agent-one", requested_by_agent_name: "Build-Agent",
  category: "shell-command", risk: "high", action: "rm -rf ./build", details: "Clear generated output",
  created_at: "2026-09-23T00:00:00Z", expires_at: "2026-09-24T00:00:00Z",
});
const message = () => ({
  id: "m1", thread_id: "thread-one", from_agent_name: "Build-Agent", kind: "message", priority: "low",
  body: "Please review the build", created_at: "2026-09-23T00:00:00Z", read_at: null,
});
const scopeLabels = (root: HTMLElement) => [...root.querySelectorAll('[role="radiogroup"] label')].map((l) => l.textContent);
/** Choose a scope as a person does: the radio becomes checked and fires change. */
function pickScope(root: HTMLElement, label: string) {
  const option = [...root.querySelectorAll('[role="radiogroup"] label')].find((l) => l.textContent === label);
  const radio = option?.querySelector("input") as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));
}
const chips = (root: HTMLElement) => [...root.querySelectorAll(".grant-chips .grant-chip")].map((c) => c.textContent);
const holdLabel = (root: HTMLElement) => root.querySelector(".hold .label")?.textContent;
beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("Inbox V4 focused queue", () => {
  it("selects an approval in the detail pane, with the scope as a visible Once | 30 min | 2 h | 8 h choice, Once by default", () => {
    const c = loadConsole();
    c.setMe({ agentId: "owner" });
    c.renderClearances([approval()]);
    expect($("inbox-focus").textContent).toContain("rm -rf ./build");
    ($("clearances").querySelector(".strip") as HTMLElement).click();
    expect($("inbox-focus").textContent).toContain("rm -rf ./build");
    const focus = $("inbox-focus");
    expect(focus.querySelector("select")).toBeNull();
    const group = focus.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute("aria-label")).toBe("What this approval allows");
    expect(scopeLabels(focus)).toEqual(["Once", "30 min", "2 h", "8 h"]);
    // Native radios sharing one name: Tab reaches the group once and the arrow keys move the choice.
    const radios = [...group.querySelectorAll("input")] as HTMLInputElement[];
    expect(radios.map((r) => r.type)).toEqual(["radio", "radio", "radio", "radio"]);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.map((r) => r.value)).toEqual(["0", "30", "120", "480"]);
    expect(radios.find((r) => r.checked)?.value).toBe("0");
    expect(chips(focus)).toEqual([]);
    expect(holdLabel(focus)).toBe("Hold to approve once");
    // The list card and the detail pane are two controls, so they never share a radio group.
    expect(($("clearances").querySelector('[role="radiogroup"] input') as HTMLInputElement).name).not.toBe(radios[0].name);
    expect($("clearances").querySelector(".strip")?.classList.contains("is-selected")).toBe(true);
  });

  it("each timed choice shows the grant activeGrant makes as chips (agent, kind of command, project, expiry), and names itself on the button", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T14:22:00Z"));
    try {
      const c = loadConsole();
      c.setMe({ agentId: "owner" });
      const until = (minutes: number) => `until ${new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      // A request in a project: the grant carries the request's project_key (src/approvals.ts decideApproval's INSERT).
      c.renderClearances([{ ...approval(), project_key: "github.com/acme/web" }]);
      ($("clearances").querySelector(".strip") as HTMLElement).click();
      const focus = $("inbox-focus");
      for (const [label, minutes] of [["30 min", 30], ["2 h", 120], ["8 h", 480]] as const) {
        pickScope(focus, label);
        expect(chips(focus), label).toEqual(["Build-Agent", "shell-command", "web", until(minutes)]);
        expect(holdLabel(focus), label).toBe(`Hold to approve for ${label}`);
        // The accessible name is the visible label, so a screen reader hears the scope and the hold too.
        expect(focus.querySelector(".hold")?.getAttribute("aria-label"), label).toBe(`Hold to approve for ${label}`);
        expect(focus.querySelector(".grant-chips")?.hasAttribute("hidden"), label).toBe(false);
        // The chips are what is approved from now on, not a description of this request: the lead says so.
        expect(focus.querySelector(".grant-chips-lead")?.textContent, label).toBe("Also auto-approves:");
        expect(focus.querySelector(".grant-chips")?.firstElementChild?.classList.contains("grant-chips-lead"), label).toBe(true);
      }
      // Back to Once: no grant, so no chips, and the button says once again.
      pickScope(focus, "Once");
      expect(chips(focus)).toEqual([]);
      expect(focus.querySelector(".grant-chips")?.hasAttribute("hidden")).toBe(true);
      expect(holdLabel(focus)).toBe("Hold to approve once");
      // A request outside any project matches only a grant made outside any project (project_key IS NULL).
      c.renderClearances([{ ...approval(), id: "a2" }]);
      ($("clearances").querySelector(".strip") as HTMLElement).click();
      pickScope($("inbox-focus"), "2 h");
      expect(chips($("inbox-focus"))).toEqual(["Build-Agent", "shell-command", "no project", until(120)]);
      // Nothing about the grant is kept in a tooltip.
      expect($("inbox-focus").querySelector(".grant-choice [title]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the approve request sends the scope that is selected", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => json(200, { ok: true }));
      const c = loadConsole(fetchMock);
      c.setMe({ agentId: "owner" });
      c.renderClearances([approval()]);
      ($("clearances").querySelector(".strip") as HTMLElement).click();
      pickScope($("inbox-focus"), "2 h");
      ($("inbox-focus").querySelector(".hold") as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.advanceTimersByTimeAsync(901);
      const call = fetchMock.mock.calls.find(([path]) => String(path).endsWith("/v1/approvals/a1/decide")) as unknown as [string, { body: string }] | undefined;
      expect(JSON.parse(call![1].body)).toEqual({ decision: "approve", grantMinutes: 120 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the expiry chip keeps up with the clock while the card is open, and the toast names the length", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T14:22:00Z"));
    try {
      const fetchMock = vi.fn(async (path: string) => (String(path).endsWith("/decide")
        ? json(200, { ok: true, grant: { id: "g1", agent_name: "Build-Agent", category: "shell-command", expires_at: new Date(Date.now() + 480 * 60_000).toISOString() } })
        : json(200, { ok: true })));
      const c = loadConsole(fetchMock);
      c.setMe({ agentId: "owner" });
      c.renderClearances([approval()]);
      ($("clearances").querySelector(".strip") as HTMLElement).click();
      const until = (minutes: number) => `until ${new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      pickScope($("inbox-focus"), "8 h");
      const first = until(480);
      expect(chips($("inbox-focus")).at(-1)).toBe(first);
      // The hub counts the 8 hours from the decision, so 20 minutes of reading later the chip says 20 minutes later.
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(chips($("inbox-focus")).at(-1)).toBe(until(480));
      expect(until(480)).not.toBe(first);
      ($("inbox-focus").querySelector(".hold") as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.advanceTimersByTimeAsync(901);
      expect($("toast").textContent).toBe("Approved. Build-Agent can run shell-command actions for 8 h.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refused decision puts the button back with the scope still named", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (path: string) => (String(path).endsWith("/decide") ? json(409, { ok: false, error: "already decided" }) : json(200, { ok: true })));
      const c = loadConsole(fetchMock);
      c.setMe({ agentId: "owner" });
      c.renderClearances([approval()]);
      ($("clearances").querySelector(".strip") as HTMLElement).click();
      pickScope($("inbox-focus"), "2 h");
      ($("inbox-focus").querySelector(".hold") as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.advanceTimersByTimeAsync(901);
      expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/decide"))).toBe(true);
      expect(holdLabel($("inbox-focus"))).toBe("Hold to approve for 2 h");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the timed grant is described as the hub applies it", () => {
    // The chips are only true while the hub's grant match is: same agent, category and project, unexpired, made by a person.
    const approvals = readFileSync(resolve(process.cwd(), "src/approvals.ts"), "utf8");
    const activeGrant = approvals.match(/function activeGrant\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(activeGrant).toContain("WHERE org_id = ? AND agent_id = ? AND category = ? AND project_key IS ? AND expires_at > ?");
    expect(activeGrant).toContain("AND (? = 'supervisor' OR granted_by_person_id IS NOT NULL)");
    expect(approvals).toMatch(/new Date\(Date\.now\(\) \+ minutes \* 60_000\)\.toISOString\(\), current\.project_key,/);
    // The old claim, a workspace-wide grant not limited to the project, is gone from every console page.
    for (const page of ["public/app/app.js", "public/app/index.html"]) {
      const text = readFileSync(resolve(process.cwd(), page), "utf8");
      expect(text, page).not.toContain("anywhere in this workspace");
      expect(text, page).not.toContain("not limited to this command or project");
      // Another standing grant, or a Notify/Off project, can let those through: the copy states what THIS approval
      // excludes, never that everything else waits (049a on #691).
      expect(text, page).not.toMatch(/still wait for a decision/i);
    }
  });

  it("requests full approval history only while Inbox History is the visible view (B4)", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/v1/me") return json(200, { orgId: "workspace-a", agentId: "owner", agentName: "Owner", role: "agent", workspace: { paused: false } });
      if (path === "/v1/agents") return json(200, { agents: [] });
      if (path.startsWith("/v1/approvals")) return json(200, { approvals: [] });
      if (path === "/v1/approval-grants") return json(200, { grants: [] });
      if (path === "/v1/tasks") return json(200, { tasks: [] });
      if (path.startsWith("/v1/events")) return json(200, { events: [] });
      if (path === "/v1/awareness") return json(200, { items: [], background: {}, cursor: 0 });
      if (path.startsWith("/v1/messages")) return json(200, { messages: [] });
      if (path === "/v1/org/devices") return json(200, { devices: [] });
      if (path.startsWith("/v1/org/sessions")) return json(200, { sessions: [] });
      if (path === "/v1/org/projects") return json(200, { projects: [] });
      if (path === "/v1/goal") return json(200, { goal: null });
      return json(200, {});
    });
    const c = loadConsole(fetchMock);
    c.setSession("workspace-a");
    const historyCalls = () => fetchMock.mock.calls.filter(([path]) => path === "/v1/approvals").length;
    c.setTab("inbox");
    c.setView("queue");
    await c.refresh();
    expect(historyCalls()).toBe(0);
    (document.querySelector(".inbox-view-tab[data-inbox-view=history]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(historyCalls()).toBe(1));
    c.setTab("overview");
    await c.refresh();
    expect(historyCalls()).toBe(1);
  });
  it("clears a completed approval and never carries its detail into another workspace", () => {
    const c = loadConsole();
    c.setMe({ orgId: "workspace-a", agentId: "owner" });
    c.syncInboxWorkspace();
    c.renderClearances([approval()]);
    expect($("inbox-focus").textContent).toContain("rm -rf ./build");
    c.renderClearances([]);
    expect($("inbox-focus").textContent).toContain("Select an item");
    c.renderClearances([approval()]);
    c.setMe({ orgId: "workspace-b", agentId: "other-owner" });
    c.syncInboxWorkspace();
    expect($("inbox-focus").textContent).not.toContain("rm -rf ./build");
  });
  it("opens a selected message without dropping it from the queue, and offers a reply in the detail pane", async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true, consumed: 1 }));
    const c = loadConsole(fetchMock);
    c.renderInbox([message()]);
    ($("inbox-list").querySelector(".strip") as HTMLElement).click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/v1/messages/consume")).toBe(true));
    expect($("inbox-focus").textContent).toContain("Please review the build");
    expect($("inbox-focus").querySelector("form.inbox-focus-reply")).toBeTruthy();
    c.renderInbox([]); // unread fetch no longer includes the consumed message
    expect($("inbox-list").textContent).toContain("Please review the build");
    expect($("inbox-list").querySelector(".strip")?.classList.contains("is-selected")).toBe(true);
  });
});