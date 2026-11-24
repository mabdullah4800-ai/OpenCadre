// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

describe("Console Headless DOM Interaction & Event Handling", () => {
  beforeEach(() => {
    // Setup clean DOM from public/app/index.html without external network stylesheet requests
    let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
    html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    document.documentElement.innerHTML = html;
  });

  it("renders real timeline events and filters dynamically by type and agent", async () => {
    // Dynamically evaluate app.js helpers and functions in the happy-dom window
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const scriptFn = new Function(
      "window",
      "document",
      "localStorage",
      "fetch",
      `${appJs}; return { renderTimeline, currentTimelineEvents: () => currentTimelineEvents };`
    );

    const apiFetch = vi.fn();
    const { renderTimeline } = scriptFn(window, document, window.localStorage, apiFetch);

    const mockEvents = [
      {
        seq: 1,
        type: "task.created",
        actor_agent_name: "Agent-Alpha",
        payload: JSON.stringify({ title: "Build core pipeline" }),
        created_at: new Date().toISOString(),
      },
      {
        seq: 2,
        type: "agent.phase_changed",
        actor_agent_name: "Agent-Alpha",
        payload: JSON.stringify({ to: "editing" }),
        created_at: new Date().toISOString(),
      },
      {
        seq: 3,
        type: "message.sent",
        actor_agent_name: "Agent-Beta",
        payload: JSON.stringify({ priority: "high" }),
        created_at: new Date().toISOString(),
      },
    ];

    // 1. Initial render of all events
    renderTimeline(mockEvents);

    const feed = document.getElementById("timeline");
    expect(feed).toBeTruthy();
    const entries = feed?.querySelectorAll(".timeline-entry");
    expect(entries?.length).toBe(3);

    // Check DOM contents
    expect(entries?.[0].textContent).toContain("#3");
    expect(entries?.[0].textContent).toContain("Agent-Beta");
    expect(entries?.[1].textContent).toContain("#2");
    expect(entries?.[2].textContent).toContain("#1");
    expect(entries?.[2].textContent).toContain("Build core pipeline");

    // Check agent filter dropdown was populated
    const agentFilter = document.getElementById("timeline-agent-filter") as HTMLSelectElement;
    expect(agentFilter).toBeTruthy();
    const agentOptions = Array.from(agentFilter.options).map((o) => o.value);
    expect(agentOptions).toContain("");
    expect(agentOptions).toContain("Agent-Alpha");
    expect(agentOptions).toContain("Agent-Beta");

    // 2. Filter by agent: Agent-Beta only
    agentFilter.value = "Agent-Beta";
    agentFilter.dispatchEvent(new Event("change"));

    const betaEntries = feed?.querySelectorAll(".timeline-entry");
    expect(betaEntries?.length).toBe(1);
    expect(betaEntries?.[0].textContent).toContain("Agent-Beta");

    // 3. Filter by type: tasks only
    agentFilter.value = "";
    agentFilter.dispatchEvent(new Event("change"));

    const typeFilter = document.getElementById("timeline-filter") as HTMLSelectElement;
    typeFilter.value = "task.";
    typeFilter.dispatchEvent(new Event("change"));

    const taskEntries = feed?.querySelectorAll(".timeline-entry");
    expect(taskEntries?.length).toBe(1);
    expect(taskEntries?.[0].textContent).toContain("task.created");
    expect(taskEntries?.[0].textContent).toContain("Build core pipeline");
  });

  it("shows ambient updates in Activity and keeps directed ack actions in Inbox", async () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, delivery: { state: "acknowledged" } }),
    });

    const scriptFn = new Function(
      "window",
      "document",
      "localStorage",
      "fetch",
      `${appJs}; return { renderAwareness, renderInboxMentions, updateInboxBadge, ackDigestEvent };`
    );

    const { renderAwareness, renderInboxMentions, updateInboxBadge } = scriptFn(window, document, window.localStorage, mockFetch);

    const mockDigest = {
      text: "[P1] #42 Security alert",
      cursor: 42,
      background: { "agent.phase_changed": 3, "task.created": 1 },
      items: [
        {
          seq: 42,
          priority: 1,
          actor: "Supervisor",
          directed: true,
          summary: "Please review PR #44 immediately",
          reason: "directed message",
        },
        {
          seq: 43,
          priority: 2,
          actor: "Supervisor",
          directed: true,
          summary: "A teammate answered your question",
          reason: "directed update",
        },
      ],
    };

    renderAwareness(mockDigest);
    renderInboxMentions(mockDigest);
    updateInboxBadge([], [], mockDigest);

    expect(document.querySelector(".activity-updates")?.hidden).toBe(false);
    expect(document.getElementById("awareness-items")?.textContent).not.toContain("Please review PR #44");
    expect(document.getElementById("inbox-mentions")?.textContent).toContain("A teammate answered your question");
    expect(document.getElementById("inbox-badge")?.textContent).toBe("2");

    // 2. Verify background summary pills
    const summary = document.getElementById("awareness-summary");
    expect(summary?.textContent).toContain("3 phase changes");
    expect(summary?.textContent).toContain("1 tasks created");

    // 3. Verify item card and interactive action buttons
    const itemsFeed = document.getElementById("awareness-items");
    const itemCard = document.getElementById("inbox-mentions")?.querySelector("article.strip.priority-1");
    expect(itemCard).toBeTruthy();
    expect(itemCard?.textContent).toContain("Needs you");
    expect(itemCard?.textContent).not.toContain("#42");
    expect(itemCard?.textContent).toContain("Please review PR #44 immediately");

    const ackButtons = itemCard?.querySelectorAll(".ack-actions button");
    expect(ackButtons?.length).toBe(3); // Mark seen, Done, Dismiss

    const [ackSeenBtn, handledBtn, dismissBtn] = Array.from(ackButtons ?? []) as HTMLButtonElement[];
    expect([ackSeenBtn.textContent, handledBtn.textContent, dismissBtn.textContent]).toEqual(["Mark seen", "Done", "Dismiss"]);

    // 4. Mark seen acknowledges the event
    ackSeenBtn.click();
    expect(ackSeenBtn.textContent).toBe("✓ Seen");
    expect(mockFetch).toHaveBeenCalledWith(
      "/v1/events/42/ack",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ outcome: "acknowledged" }),
      })
    );

    // 5. Done records that the operator handled it
    handledBtn.click();
    expect(handledBtn.textContent).toBe("✓ Done");
    expect(mockFetch).toHaveBeenCalledWith(
      "/v1/events/42/ack",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ outcome: "acted" }),
      })
    );

    // 6. Click 'Dismiss' button -> asserts fetch call
    dismissBtn.click();
    expect(dismissBtn.textContent).toBe("✓ Dismissed");
    expect(mockFetch).toHaveBeenCalledWith(
      "/v1/events/42/ack",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ outcome: "dismissed" }),
      })
    );
  });

  it("shows the question itself when its unread message is in the Inbox", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const c = new Function("window", "document", "localStorage", "fetch",
      `${appJs}; return { renderInbox, renderInboxMentions, overviewAwarenessStrip };`,
    )(window, document, window.localStorage, vi.fn()) as {
      renderInbox: (messages: unknown[]) => void;
      renderInboxMentions: (digest: unknown) => void;
      overviewAwarenessStrip: (item: unknown) => HTMLElement;
    };
    const threadId = "12345678-1234-1234-1234-123456789abc";
    c.renderInbox([{ id: "message-1", thread_id: threadId, body: "Can you review the launch checklist by noon?",
      from_agent_name: "Release-Bot", created_at: new Date().toISOString(), priority: "high", kind: "question" }]);
    const item = { seq: 51, type: "question.asked", priority: 1, directed: true, actor: "Release-Bot",
      summary: `Release-Bot asked you a question (reply on thread ${threadId})`, reason: "question" };
    c.renderInboxMentions({ items: [item] });
    // The unread question is already in the queue as a message carrying its text, so the update announcing it is not
    // listed a second time (9d1f's audit on #568: each message showed up to three times).
    expect(document.getElementById("inbox-mentions")?.children.length).toBe(0);
    expect(c.overviewAwarenessStrip(item).textContent).toContain("Can you review the launch checklist by noon?");
    // Once the message is read it leaves the unread list, and the update shows the question itself, never the thread id.
    c.renderInbox([{ id: "message-1", thread_id: threadId, body: "Can you review the launch checklist by noon?",
      from_agent_name: "Release-Bot", created_at: new Date().toISOString(), priority: "high", kind: "question", read_at: new Date().toISOString() }]);
    c.renderInboxMentions({ items: [item] });
    expect(document.getElementById("inbox-mentions")?.textContent).toContain("Can you review the launch checklist by noon?");
    expect(document.getElementById("inbox-mentions")?.textContent).not.toContain(threadId);
  });
  it("hides the checkpoint summary when there are no ambient updates", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const scriptFn = new Function(
      "window",
      "document",
      "localStorage",
      "fetch",
      `${appJs}; return { renderAwareness };`
    );

    const { renderAwareness } = scriptFn(window, document, window.localStorage, vi.fn());

    renderAwareness({ items: [], background: {} });

    expect(document.querySelector(".activity-updates")?.hidden).toBe(true);
  });

  it("switches tabs when in-app navigation jump buttons are clicked", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const scriptFn = new Function(
      "window",
      "document",
      "localStorage",
      "fetch",
      `${appJs}; return { renderTimeline, selectTab };`
    );

    const { renderTimeline } = scriptFn(window, document, window.localStorage, vi.fn());

    renderTimeline([
      {
        seq: 10,
        type: "task.created",
        actor_agent_name: "Agent-1",
        payload: JSON.stringify({ title: "Write tests" }),
        created_at: new Date().toISOString(),
      },
    ]);

    const jumpBtn = document.querySelector(".timeline-entry button") as HTMLButtonElement;
    expect(jumpBtn).toBeTruthy();
    expect(jumpBtn.textContent).toContain("View tasks");

    // Click jump button
    jumpBtn.click();

    // Verify task panel is active
    const tasksPanel = document.querySelector('.panel[data-panel="tasks"]');
    expect(tasksPanel?.classList.contains("is-active")).toBe(true);
  });

  it("renders semantic rail dots and delivery tracker micro-progress on timeline entries", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const scriptFn = new Function(
      "window",
      "document",
      "localStorage",
      "fetch",
      `${appJs}; return { renderTimeline };`
    );

    const { renderTimeline } = scriptFn(window, document, window.localStorage, vi.fn());

    renderTimeline([
      {
        seq: 1,
        type: "message.sent",
        actor_agent_name: "ClaudeCode-Session",
        payload: JSON.stringify({ priority: "high" }),
        created_at: new Date().toISOString(),
      },
      {
        seq: 2,
        type: "task.created",
        actor_agent_name: "Antigravity-Session",
        payload: JSON.stringify({ title: "Build feature" }),
        created_at: new Date().toISOString(),
      },
      {
        seq: 3,
        type: "conflict.detected",
        actor_agent_name: "Conflict-Detector",
        payload: JSON.stringify({ files: ["src/rest.ts"] }),
        created_at: new Date().toISOString(),
      },
    ]);

    const entries = document.querySelectorAll(".timeline-entry");
    expect(entries.length).toBe(3);

    // Conflict (seq 3): red dot
    const conflictDot = entries[0].querySelector(".rail-dot");
    expect(conflictDot?.className).toContain("dot-red");

    // Task (seq 2): muted dot
    const taskDot = entries[1].querySelector(".rail-dot");
    expect(taskDot?.className).toContain("dot-muted");

    // Message (seq 1): ink dot + delivery tracker, one dot per persisted delivery state (tests/console-delivery-tracker.test.ts)
    const messageDot = entries[2].querySelector(".rail-dot");
    expect(messageDot?.className).toContain("dot-ink");

    const tracker = entries[2].querySelector(".delivery-tracker");
    expect(tracker).toBeTruthy();
    const dots = tracker?.querySelectorAll(".d-dot");
    expect(dots?.length).toBe(3);
    expect(tracker?.querySelector(".d-label")).toBeTruthy();
  });

  it("renders interactive operator controls on task cards and dispatches claims and completions", async () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const scriptFn = new Function(
      "window",
      "document",
      "localStorage",
      "fetch",
      `${appJs}; return { renderTasks, setMe: (v) => { me = v; } };`
    );

    const { renderTasks, setMe } = scriptFn(window, document, window.localStorage, mockFetch);
    // Complete and Release are the claimant's own actions (the hub refuses anyone else), so the viewer is the claimant.
    setMe({ agentId: "agent-antigravity" });

    renderTasks([
      {
        id: "task-101",
        title: "Unclaimed task",
        status: "open",
        created_by_agent_name: "Operator",
        created_at: new Date().toISOString(),
      },
      {
        id: "task-102",
        title: "Active task",
        status: "claimed",
        lease_active: true,
        claimed_by_agent_id: "agent-antigravity",
        claimed_by_agent_name: "Antigravity",
        lease_expires_at: new Date(Date.now() + 60000).toISOString(),
      },
    ]);

    // Check Open column has Claim button
    const openTasks = document.querySelectorAll(".column")[0];
    // The card title is its own button (it opens Details), so the actions are read from the action row.
    const claimBtn = openTasks.querySelector(".task-actions button") as HTMLButtonElement;
    expect(claimBtn).toBeTruthy();
    expect(claimBtn.textContent).toBe("Claim");

    claimBtn.click();
    expect(mockFetch).toHaveBeenCalledWith(
      "/v1/tasks/task-101/claim",
      expect.objectContaining({ method: "POST" })
    );

    // Check In Progress column has Complete and Release buttons
    const inProgressTasks = document.querySelectorAll(".column")[1];
    const inProgressBtns = inProgressTasks.querySelectorAll(".task-actions button");
    expect(inProgressBtns.length).toBe(2);
    expect(inProgressBtns[0].textContent).toBe("Complete");
    expect(inProgressBtns[1].textContent).toBe("Release");

    inProgressBtns[0].click();
    expect(mockFetch).toHaveBeenCalledWith(
      "/v1/tasks/task-102/complete",
      expect.objectContaining({ method: "POST" })
    );
  });
  it("filters decisions and keeps the protocol type inside Details", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const scriptFn = new Function("window", "document", "localStorage", "fetch",
      `${appJs}; return { renderTimeline };`);
    const { renderTimeline } = scriptFn(window, document, window.localStorage, vi.fn());
    const created_at = new Date().toISOString();
    const events = [
      { seq: 10, type: "task.created", actor_agent_name: "Scout", payload: JSON.stringify({ title: "Check deploy" }), created_at },
      { seq: 11, type: "decision.recorded", actor_agent_name: "Grace", payload: JSON.stringify({ title: "Use staged rollout", rationale: "Limit blast radius" }), created_at },
    ];
    renderTimeline(events);
    const row = document.querySelectorAll(".timeline-entry")[0] as HTMLElement;
    expect(row.querySelector(".timeline-summary")?.textContent).toContain("Grace recorded decision");
    expect(row.querySelector(".activity-entry-main")?.firstElementChild?.textContent).not.toContain("decision.recorded");
    expect(row.querySelector(".activity-event-details")?.textContent).toContain("decision.recorded");
    expect(row.querySelector(".activity-event-details")?.textContent).toContain("Limit blast radius");

    const filter = document.getElementById("timeline-filter") as HTMLSelectElement;
    filter.value = "decision.recorded";
    filter.dispatchEvent(new Event("change"));
    expect(document.querySelectorAll(".timeline-entry")).toHaveLength(1);
    expect(document.querySelector(".timeline-entry .timeline-summary")?.textContent).toContain("Use staged rollout");
  });
  it("an event's Details has a visible toggle, and the row's jump ignores selecting text and clicks inside Details", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const scriptFn = new Function("window", "document", "localStorage", "fetch",
      `${appJs}; return { renderTimeline, activeTab: () => activeTab };`);
    const c = scriptFn(window, document, window.localStorage, vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    const created_at = new Date().toISOString();
    // A conflict's file list and an approval's details live only in Details.
    c.renderTimeline([
      { seq: 21, type: "approval.requested", actor_agent_name: "Builder", payload: JSON.stringify({ category: "shell", details: "Clears the build cache" }), created_at },
      { seq: 20, type: "conflict.detected", actor_agent_name: "Builder", payload: JSON.stringify({ files: ["src/a.ts", "src/b.ts"] }), created_at },
    ]);
    const [approvalRow, conflictRow] = [...document.querySelectorAll(".timeline-entry")] as HTMLElement[];
    for (const row of [approvalRow, conflictRow]) {
      const summary = row.querySelector(".activity-event-details > summary") as HTMLElement;
      // A <summary> is a native, focusable toggle; it is shown, not visually hidden.
      expect(summary.textContent).toBe("Details");
      expect(summary.classList.contains("visually-hidden")).toBe(false);
    }
    expect(conflictRow.querySelector(".activity-event-details")?.textContent).toContain("src/a.ts, src/b.ts");
    expect(approvalRow.querySelector(".activity-event-details")?.textContent).toContain("Clears the build cache");
    const start = c.activeTab();
    // A click inside the open Details (reading or copying the rationale) stays on Activity.
    (approvalRow.querySelector(".activity-event-details") as HTMLDetailsElement).open = true;
    (approvalRow.querySelector(".activity-event-details-body p") as HTMLElement).click();
    expect(c.activeTab()).toBe(start);
    // Selecting text in the row stays on Activity too.
    const range = document.createRange();
    range.selectNodeContents(approvalRow.querySelector(".timeline-summary")!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    (approvalRow.querySelector(".timeline-summary") as HTMLElement).click();
    expect(c.activeTab()).toBe(start);
    // A plain click on the row still jumps (the control).
    window.getSelection()!.removeAllRanges();
    (approvalRow.querySelector(".timeline-summary") as HTMLElement).click();
    expect(c.activeTab()).toBe("inbox");
  });
  it("asks the server for decisions instead of filtering only the latest mixed events", async () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const scriptFn = new Function("window", "document", "localStorage", "fetch",
      `${appJs}; return {
        selectTab,
        setAuth: () => { authMode = "key"; agentKey = "fixture"; },
        setApi: (fn) => { api = fn; },
      };`);
    const c = scriptFn(window, document, window.localStorage, vi.fn());
    const paths: string[] = [];
    // Let the console's own boot() finish first: it runs at load, and a key set before it settles makes it sign in
    // with that key, fail against the stub below and sign out again, so the coalesced refresh would find no one signed in.
    await new Promise((r) => setTimeout(r, 0));
    c.setAuth();
    // Answered with the shapes the hub returns (src/rest.ts), so the refresh completes rather than failing on its first request.
    c.setApi((path: string) => { paths.push(path); return Promise.resolve(hubReadBody(path) ?? {}); });
    c.selectTab("timeline");
    const filter = document.getElementById("timeline-filter") as HTMLSelectElement;
    filter.value = "decision.recorded";
    filter.dispatchEvent(new Event("change"));
    // refresh() is coalesced (app.js REFRESH_SETTLE_MS), so the requests go out a moment later, not synchronously.
    await vi.waitFor(() => expect(paths).toContain("/v1/events?limit=40"));
    expect(paths).toContain("/v1/events?types=decision.recorded&limit=200");
  });
});
