// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

type Console = {
  renderInbox: (messages: unknown[]) => void;
  renderInboxError: () => void;
  openMessage: (m: unknown) => Promise<void>;
  toggleReply: (threadId: string) => void;
  setAgentKey: (v: string) => void;
};

function loadConsole(fetchMock: ReturnType<typeof vi.fn>): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return {
      renderInbox, renderInboxError, openMessage, toggleReply,
      setAgentKey: (v) => { agentKey = v; },
    };`,
  )(window, document, window.localStorage, fetchMock) as Console;
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const msg = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "m1", thread_id: "t1", from_agent_id: "a1", from_agent_name: "Operator", to_agent_id: "me",
  to_agent_name: "Me", body: "HUB ALERT: something happened", kind: "message", priority: "high",
  awaiting_reply: 0, created_at: "2026-09-15T02:00:00.000Z", read_at: null, delivered_at: null, file_id: null,
  ...overrides,
});

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("renderInbox: empty and badge", () => {
  it("shows the empty state and hides the badge and Mark all read when there's nothing", () => {
    const { renderInbox } = loadConsole(vi.fn());
    renderInbox([]);
    expect($("inbox-badge").hidden).toBe(true);
    expect($("inbox-mark-all-read").hidden).toBe(true);
    expect($("inbox-list").textContent).toContain("All caught up");
  });

  it("shows the unread count on the badge and lists messages newest first", () => {
    const { renderInbox } = loadConsole(vi.fn());
    const older = msg({ id: "m1", created_at: "2026-09-15T01:00:00.000Z", body: "older" });
    const newer = msg({ id: "m2", created_at: "2026-09-15T02:00:00.000Z", body: "newer" });
    renderInbox([older, newer]);
    expect($("inbox-badge").hidden).toBe(false);
    expect($("inbox-badge").textContent).toBe("2");
    expect($("inbox-mark-all-read").hidden).toBe(false);
    const bodies = Array.from(document.querySelectorAll("#inbox-list .strip-body")).map((n) => n.textContent);
    expect(bodies[0]).toBe("newer");
    expect(bodies[1]).toBe("older");
  });

  it("still puts the later-arriving message first when two share the same (second-precision) timestamp", () => {
    // A burst of alerts in the same second is the exact scenario this feature exists for; created_at
    // ties would otherwise fall back to whatever Array.sort's stability happens to preserve.
    const { renderInbox } = loadConsole(vi.fn());
    const sameSecond = "2026-09-15T02:00:00.000Z";
    const first = msg({ id: "m1", created_at: sameSecond, body: "sent first" }); // server order: oldest first
    const second = msg({ id: "m2", created_at: sameSecond, body: "sent second" });
    renderInbox([first, second]);
    const bodies = Array.from(document.querySelectorAll("#inbox-list .strip-body")).map((n) => n.textContent);
    expect(bodies[0]).toBe("sent second");
    expect(bodies[1]).toBe("sent first");
  });
});

describe("renderInbox: high priority gets the halt/amber treatment", () => {
  it("adds inbox-message-high for a high-priority message, not for medium/low", () => {
    const { renderInbox } = loadConsole(vi.fn());
    renderInbox([
      msg({ id: "m1", priority: "high", body: "the high one", created_at: "2026-09-15T02:00:00.000Z" }),
      msg({ id: "m2", priority: "low", body: "the low one", created_at: "2026-09-15T02:00:01.000Z" }),
    ]);
    // Find each strip by its body text rather than assuming a position -- ordering isn't what this test is about.
    const strips = Array.from(document.querySelectorAll("#inbox-list .strip"));
    const byBody = (text: string) => strips.find((s) => s.querySelector(".strip-body")?.textContent === text)!;
    expect(byBody("the high one").classList.contains("inbox-message-high")).toBe(true);
    expect(byBody("the low one").classList.contains("inbox-message-high")).toBe(false);
  });
});

describe("renderInbox: never renders a message body as HTML", () => {
  it("a body containing markup shows as literal text, not injected markup", () => {
    const { renderInbox } = loadConsole(vi.fn());
    renderInbox([msg({ body: "<img src=x onerror=alert(1)>ignore me" })]);
    const bodyEl = document.querySelector("#inbox-list .strip-body")!;
    expect(bodyEl.querySelector("img")).toBeNull();
    expect(bodyEl.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("openMessage", () => {
  it("opening a message consumes it, shows the full body, and marks it Read", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true, consumed: 1 }));
    const { renderInbox, openMessage } = loadConsole(fetchMock);
    const long = "x".repeat(300);
    const m = msg({ body: long });
    renderInbox([m]);
    await openMessage(m);

    expect(fetchMock).toHaveBeenCalledWith("/v1/messages/consume", expect.objectContaining({
      method: "POST", body: JSON.stringify({ messageIds: ["m1"] }),
    }));
    expect(document.querySelector("#inbox-list .strip-body")!.textContent).toBe(long);
    expect(document.querySelector("#inbox-list .strip-meta")!.textContent).toContain("Read");
    expect($("inbox-badge").hidden).toBe(true); // nothing unread left once the only message is opened
  });

  it("keeps the open message visible even after it drops out of the next unread fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true, consumed: 1 }));
    const { renderInbox, openMessage } = loadConsole(fetchMock);
    const m = msg();
    renderInbox([m]);
    await openMessage(m);

    // The next poll's peek=true fetch no longer includes m1 (it's read now) -- simulate that.
    renderInbox([]);
    expect($("inbox-list").textContent).not.toContain("All caught up");
    expect(document.querySelector("#inbox-list .strip-meta")!.textContent).toContain("Read");
  });

  it("closing an open message clears the kept-alive state, so a later empty fetch really is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true, consumed: 1 }));
    const { renderInbox, openMessage } = loadConsole(fetchMock);
    const m = msg();
    renderInbox([m]);
    await openMessage(m); // open
    await openMessage(m); // close
    renderInbox([]);
    expect($("inbox-list").textContent).toContain("All caught up");
  });
});

describe("reply", () => {
  it("toggleReply shows a reply form only for the open message's thread", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true, consumed: 1 }));
    const { renderInbox, openMessage, toggleReply } = loadConsole(fetchMock);
    const m = msg();
    renderInbox([m]);
    await openMessage(m);
    toggleReply(m.thread_id);
    expect($("inbox-list").querySelector("form.inbox-reply-form")).toBeTruthy();
    toggleReply(m.thread_id);
    expect($("inbox-list").querySelector("form.inbox-reply-form")).toBeNull();
  });

  it("submitting the reply form posts to the thread's reply endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true }));
    const { renderInbox, openMessage, toggleReply } = loadConsole(fetchMock);
    const m = msg();
    renderInbox([m]);
    await openMessage(m);
    toggleReply(m.thread_id);

    const textarea = $(`inbox-reply-${m.id}`) as HTMLTextAreaElement;
    textarea.value = "On it.";
    $("inbox-list").querySelector("form.inbox-reply-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve(); // let the async handler's fetch resolve

    const call = fetchMock.mock.calls.find(([url]) => url === "/v1/messages/t1/reply");
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({ method: "POST", body: JSON.stringify({ body: "On it." }) });
  });

  it("replying works without opening the message first (Reply used to silently do nothing then)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true }));
    const { renderInbox, toggleReply } = loadConsole(fetchMock);
    const m = msg();
    renderInbox([m]);
    toggleReply(m.thread_id); // never called openMessage

    const form = $("inbox-list").querySelector("form.inbox-reply-form");
    expect(form).toBeTruthy(); // the form actually renders, unlike before the fix

    const textarea = $(`inbox-reply-${m.id}`) as HTMLTextAreaElement;
    textarea.value = "Quick reply without reading first.";
    form!.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();

    const call = fetchMock.mock.calls.find(([url]) => url === "/v1/messages/t1/reply");
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({ body: JSON.stringify({ body: "Quick reply without reading first." }) });
  });

  it("survives a background re-render mid-draft (renderInbox rebuilds the form fresh on every poll/push)", () => {
    const { renderInbox, toggleReply } = loadConsole(vi.fn());
    const m = msg();
    renderInbox([m]);
    toggleReply(m.thread_id);

    const textarea = $(`inbox-reply-${m.id}`) as HTMLTextAreaElement;
    textarea.value = "Half-typed rep";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    renderInbox([m]); // simulates the next poll tick re-rendering everything from scratch

    expect(($(`inbox-reply-${m.id}`) as HTMLTextAreaElement).value).toBe("Half-typed rep");
  });

  it("keeps keyboard focus and the caret in the reply box across two background re-renders", () => {
    const { renderInbox, toggleReply } = loadConsole(vi.fn());
    const m = msg();
    renderInbox([m]);
    toggleReply(m.thread_id);

    const first = $(`inbox-reply-${m.id}`) as HTMLTextAreaElement;
    first.focus();
    first.value = "Typing a longer reply";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    first.setSelectionRange(6, 6); // caret mid-text, as if the person moved it back

    renderInbox([m]); // poll tick 1
    renderInbox([m]); // poll tick 2

    const now = $(`inbox-reply-${m.id}`) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(now);
    expect([now.selectionStart, now.selectionEnd]).toEqual([6, 6]);
    expect(now.value).toBe("Typing a longer reply");
  });

  it("does not steal focus into the reply box when it wasn't focused before the re-render", () => {
    const { renderInbox, toggleReply } = loadConsole(vi.fn());
    const m = msg();
    renderInbox([m]);
    toggleReply(m.thread_id);
    (document.activeElement as HTMLElement | null)?.blur();

    renderInbox([m]);

    expect(document.activeElement).not.toBe($(`inbox-reply-${m.id}`));
  });
});

describe("Mark all read", () => {
  it("consumes every currently-unread message and refreshes", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      url === "/v1/messages/consume" ? json(200, { ok: true, consumed: 2 }) : json(200, hubReadBody(url) ?? {}));
    const { renderInbox, setAgentKey } = loadConsole(fetchMock);
    setAgentKey("agt_test");
    renderInbox([msg({ id: "m1" }), msg({ id: "m2" })]);

    $("inbox-mark-all-read").click();
    await Promise.resolve();
    await Promise.resolve();

    const call = fetchMock.mock.calls.find(([url]) => url === "/v1/messages/consume");
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body).messageIds.sort()).toEqual(["m1", "m2"]);
  });
});

describe("renderInboxError", () => {
  it("shows a retry-oriented message instead of leaving the panel blank", () => {
    const { renderInboxError } = loadConsole(vi.fn());
    renderInboxError();
    expect($("inbox-list").textContent).toContain("Couldn't load your inbox");
    expect($("inbox-mark-all-read").hidden).toBe(true);
  });
});
