// @vitest-environment happy-dom
// Inbox merge (docs/design/HUB_REDESIGN.md 2.4, Stage 3): Clearances + Inbox + directed Awareness
// items live in one page now. Clearances is no longer its own nav item/panel -- its capability
// (approve/deny, via the existing clearanceStrip()/decide()) moved into Inbox's "Approvals" filter,
// unchanged internally, just re-homed. Directed P1 Awareness items get a second, fully-actionable
// view here too (Inbox's "Mentions" filter, via the existing renderAwarenessItem()/ackDigestEvent())
// -- Awareness's own page is intentionally left running unchanged this stage (see the comment above
// renderInboxMentions() in app.js for why), so this is a disclosed duplicate, not a capability move.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadConsole(fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () => json(200, {}))) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return {
      renderClearances, renderInbox, renderInboxMentions, updateInboxBadge, goToInbox,
      applyInboxFilter, applyInboxView, paintSkeleton, setMe: (v) => { me = v; },
    };`,
  )(window, document, window.localStorage, fetchMock) as {
    renderClearances: (approvals: any[]) => void;
    renderInbox: (messages: any[]) => void;
    renderInboxMentions: (digest: any) => void;
    updateInboxBadge: (approvals: any[], messages: any[], digest: any) => void;
    goToInbox: (filter: string) => void;
    applyInboxFilter: () => void;
    applyInboxView: () => void;
    paintSkeleton: (id: string, count?: number) => void;
    setMe: (v: { role: string } | null) => void;
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

describe("Clearances is no longer its own nav item or panel", () => {
  it("has exactly one nav item/panel for the merged queue, under Inbox", () => {
    expect(document.querySelector('.sidebar-nav [data-tab="clearances"]')).toBeNull();
    expect(document.querySelector('.panel[data-panel="clearances"]')).toBeNull();
    expect(document.querySelector('.sidebar-nav [data-tab="inbox"]')).toBeTruthy();
    expect(document.querySelector('.panel[data-panel="inbox"]')).toBeTruthy();
  });

  it("renderClearances still renders approval strips into the #clearances container inside Inbox", () => {
    const { renderClearances } = loadConsole();
    renderClearances([approval()]);
    expect(document.querySelector('.panel[data-panel="inbox"] #clearances .strip')).toBeTruthy();
  });
});

// QA #185: renderClearances() patches #clearances incrementally (append/update only, never
// replaceChildren()) so an in-progress hold-to-approve never gets clobbered -- but that meant
// paintSkeleton()'s placeholder rows, appended before the first real approvals ever arrive, were
// never removed once real data showed up.
describe("renderClearances clears stale skeleton rows (QA #185)", () => {
  it("removes paintSkeleton()'s placeholder rows once real approvals render", () => {
    const { renderClearances, paintSkeleton } = loadConsole();
    paintSkeleton("clearances", 3);
    expect($("clearances").querySelectorAll(".skeleton")).toHaveLength(3);
    renderClearances([approval()]);
    expect($("clearances").querySelectorAll(".skeleton")).toHaveLength(0);
    expect($("clearances").querySelectorAll(".strip")).toHaveLength(1);
  });

  it("removes them even when the real state is zero approvals (the 'All clear' empty state)", () => {
    const { renderClearances, paintSkeleton } = loadConsole();
    paintSkeleton("clearances", 3);
    renderClearances([]);
    expect($("clearances").querySelectorAll(".skeleton")).toHaveLength(0);
    expect($("clearances").querySelector(".empty")).toBeTruthy();
  });
});

describe("Inbox filter bar", () => {
  it("defaults to All, with every section visible", () => {
    expect(document.querySelector('.filter-chip[data-filter="all"]')!.getAttribute("aria-pressed")).toBe("true");
    expect($("clearances").hidden).toBe(false);
    expect($("inbox-list").hidden).toBe(false);
    expect($("inbox-mentions").hidden).toBe(false);
  });

  it("clicking a chip shows only that section and marks it pressed", () => {
    loadConsole();
    document.querySelector<HTMLButtonElement>('.filter-chip[data-filter="approvals"]')!.click();
    expect($("clearances").hidden).toBe(false);
    expect($("inbox-list").hidden).toBe(true);
    expect($("inbox-mentions").hidden).toBe(true);
    expect(document.querySelector('.filter-chip[data-filter="approvals"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('.filter-chip[data-filter="all"]')!.getAttribute("aria-pressed")).toBe("false");
  });

  it("goToInbox() sets the filter and switches to the Inbox tab", () => {
    const { goToInbox } = loadConsole();
    goToInbox("messages");
    expect($("inbox-list").hidden).toBe(false);
    expect($("clearances").hidden).toBe(true);
    expect(document.querySelector('.nav-item[data-tab="inbox"]')!.getAttribute("aria-current")).toBe("page");
  });
});

describe("Inbox view tabs: Queue vs. History", () => {
  it("starts on Queue, with History hidden", () => {
    expect($("inbox-queue-view").hidden).toBe(false);
    expect($("inbox-history-view").hidden).toBe(true);
  });

  it("switching to History hides the Queue view and its filter bar", () => {
    loadConsole();
    document.querySelector<HTMLButtonElement>('.inbox-view-tab[data-inbox-view="history"]')!.click();
    expect($("inbox-queue-view").hidden).toBe(true);
    expect($("inbox-history-view").hidden).toBe(false);
    expect(document.querySelector('.inbox-view-tab[data-inbox-view="history"]')!.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('.inbox-view-tab[data-inbox-view="queue"]')!.getAttribute("aria-selected")).toBe("false");
  });
});

describe("Inbox Mentions: all directed checkpoint items", () => {
  it("renders directed P1 and P2 items with full ack actions, ignores ambient items", () => {
    const { renderInboxMentions } = loadConsole();
    renderInboxMentions({
      items: [
        { seq: 1, priority: 1, directed: true, summary: "needs you", actor: "Codex" },
        { seq: 2, priority: 1, directed: false, summary: "background only" },
        { seq: 3, priority: 2, directed: true, summary: "heads up only" },
      ],
    });
    const strips = $("inbox-mentions").querySelectorAll(".strip");
    expect(strips).toHaveLength(2);
    expect(strips[0].querySelector(".ack-actions")).toBeTruthy();
    expect(strips[1].querySelector(".ack-actions")).toBeTruthy();
  });

  it("renders nothing when there's no digest yet", () => {
    const { renderInboxMentions } = loadConsole();
    renderInboxMentions(null);
    expect($("inbox-mentions").children).toHaveLength(0);
  });
});

describe("Inbox badge: one combined count", () => {
  it("sums pending approvals, unread messages, and every directed update", () => {
    const { updateInboxBadge } = loadConsole();
    updateInboxBadge(
      [approval()],
      [{ read_at: null }, { read_at: new Date().toISOString() }],
      { items: [{ priority: 1, directed: true }, { priority: 2, directed: true }] },
    );
    // 1 approval + 1 unread message + 2 directed updates = 4
    expect($("inbox-badge").hidden).toBe(false);
    expect($("inbox-badge").textContent).toBe("4");
  });

  it("hides the badge when nothing needs attention", () => {
    const { updateInboxBadge } = loadConsole();
    updateInboxBadge([], [], null);
    expect($("inbox-badge").hidden).toBe(true);
  });
});
