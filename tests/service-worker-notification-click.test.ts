// A tap on an approval push notification must never open another console window while one exists, controlled by the
// service worker or not. public/app/sw.js used to call client.navigate() (which rejects for an uncontrolled window) and
// fall back to clients.openWindow(): every tap added an installed-app window, and the operator ended with ~10.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ORIGIN = "https://console.example";
const source = readFileSync(resolve(process.cwd(), "public/app/sw.js"), "utf8");

type FakeClient = {
  url: string; focused: boolean; visibilityState: string;
  focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; navigate?: ReturnType<typeof vi.fn>;
};

/** A window the worker can see. `listens` = the page has the app.js message listener and acknowledges over the port it
 * is handed; `controlled` = navigate() exists and works (an uncontrolled window's navigate() rejects). */
function windowClient(url: string, opts: { focused?: boolean; visible?: boolean; listens?: boolean; controlled?: boolean; noNavigate?: boolean } = {}): FakeClient {
  const { focused = false, visible = false, listens = true, controlled = false, noNavigate = false } = opts;
  const client: FakeClient = {
    url, focused, visibilityState: visible || focused ? "visible" : "hidden",
    focus: vi.fn(async () => client),
    postMessage: vi.fn((_message: unknown, transfer?: MessagePort[]) => { if (listens) transfer?.[0]?.postMessage("ack"); }),
  };
  if (!noNavigate) client.navigate = vi.fn(async () => { if (!controlled) throw new TypeError("navigate() on an uncontrolled client"); return client; });
  return client;
}

function loadWorker(clients: FakeClient[], opts: { openDelay?: number; listed?: boolean } = {}) {
  let opened_ = 0;
  const openedById = new Map<string, FakeClient>();
  const listeners: Record<string, (event: unknown) => void> = {};
  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; },
    skipWaiting: () => {},
    registration: {},
    clients: {
      matchAll: vi.fn(async () => [...clients]),
      // A window that openWindow() creates: `listed` = matchAll already sees it; otherwise only get(id) does (it is not
      // in matchAll's answer until it has loaded).
      openWindow: vi.fn(async (url: string) => {
        await new Promise((r) => setTimeout(r, opts.openDelay ?? 0));
        const opened = windowClient(url, { visible: true });
        (opened as FakeClient & { id: string }).id = `opened-${++opened_}`;
        openedById.set((opened as FakeClient & { id: string }).id, opened);
        if (opts.listed !== false) clients.push(opened);
        return opened;
      }),
      get: vi.fn(async (id: string) => openedById.get(id)),
      claim: vi.fn(async () => {}),
    },
  };
  new Function("self", source)(scope);
  const click = async (data: unknown) => {
    const waits: Promise<unknown>[] = [];
    const close = vi.fn();
    listeners.notificationclick({ notification: { close, data }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    return { close };
  };
  return { scope, click };
}

const APPROVAL = `${ORIGIN}/app/?workspace=org_1#approval-appr_9`;
afterEach(() => vi.useRealTimers());

describe("notificationclick with a console window already open", () => {
  it("an uncontrolled window is focused and told where to go; no window is opened", async () => {
    const stale = windowClient(`${ORIGIN}/app/`, { controlled: false, visible: true });
    const { scope, click } = loadWorker([stale]);
    await click({ url: APPROVAL });
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
    expect(stale.focus).toHaveBeenCalledTimes(1);
    expect(stale.postMessage).toHaveBeenCalledTimes(1);
    expect(stale.postMessage.mock.calls[0][0]).toEqual({ type: "opencadre:open", url: APPROVAL });
    expect(stale.navigate).not.toHaveBeenCalled(); // it answered, so no reload is needed
  });

  it("with ten windows open (the operator's case) it still opens none and messages exactly one", async () => {
    const windows = Array.from({ length: 10 }, (_, i) => windowClient(`${ORIGIN}/app/?n=${i}`, { controlled: false }));
    const { scope, click } = loadWorker(windows);
    await click({ url: APPROVAL });
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
    expect(windows.filter((w) => w.postMessage.mock.calls.length > 0)).toHaveLength(1);
    expect(windows[0].postMessage).toHaveBeenCalledTimes(1); // no focus, none visible: the most recently used (matchAll order)
  });

  it("two windows, one focused: the focused one is chosen, wherever it sits in the list", async () => {
    const first = windowClient(`${ORIGIN}/app/`, { visible: true });
    const second = windowClient(`${ORIGIN}/app/`, { focused: true });
    const { scope, click } = loadWorker([first, second]);
    await click({ url: APPROVAL });
    expect(second.postMessage).toHaveBeenCalledTimes(1);
    expect(second.focus).toHaveBeenCalledTimes(1);
    expect(first.postMessage).not.toHaveBeenCalled();
    expect(first.focus).not.toHaveBeenCalled();
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it("with none focused, a visible window beats a hidden one that came first", async () => {
    const hidden = windowClient(`${ORIGIN}/app/`);
    const visible = windowClient(`${ORIGIN}/app/`, { visible: true });
    const { click } = loadWorker([hidden, visible]);
    await click({ url: APPROVAL });
    expect(visible.postMessage).toHaveBeenCalledTimes(1);
    expect(hidden.postMessage).not.toHaveBeenCalled();
  });

  it("a page of the same origin outside /app/ is not a console window", async () => {
    const site = windowClient(`${ORIGIN}/pricing`, { focused: true });
    const other = windowClient(`https://elsewhere.example/app/`, { focused: true });
    const consoleWindow = windowClient(`${ORIGIN}/app/`);
    const { scope, click } = loadWorker([site, other, consoleWindow]);
    await click({ url: APPROVAL });
    expect(consoleWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(site.postMessage).not.toHaveBeenCalled();
    expect(other.postMessage).not.toHaveBeenCalled();
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it("a page that never answers (an old app.js) is navigated when it can be; still never a new window", async () => {
    vi.useFakeTimers();
    const old = windowClient(`${ORIGIN}/app/`, { listens: false, controlled: true });
    const { scope, click } = loadWorker([old]);
    const clicked = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(5000);
    await clicked;
    expect(old.navigate).toHaveBeenCalledWith(APPROVAL);
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it("an old uncontrolled page that never answers is just focused: navigate rejects and no window opens", async () => {
    vi.useFakeTimers();
    const old = windowClient(`${ORIGIN}/app/`, { listens: false, controlled: false });
    const { scope, click } = loadWorker([old]);
    const clicked = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(clicked).resolves.toBeDefined();
    expect(old.focus).toHaveBeenCalled();
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it("a focus() the browser refuses does not stop the message or open a window", async () => {
    const w = windowClient(`${ORIGIN}/app/`, { focused: true });
    w.focus.mockRejectedValue(new Error("not allowed"));
    const { scope, click } = loadWorker([w]);
    await click({ url: APPROVAL });
    expect(w.postMessage).toHaveBeenCalledTimes(1);
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });
});

describe("notificationclick with no console window", () => {
  it("opens one window at the notification's url", async () => {
    const { scope, click } = loadWorker([]);
    await click({ url: APPROVAL });
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
    expect(scope.clients.openWindow).toHaveBeenCalledWith(APPROVAL);
  });

  it("a tab of the public site or another origin does not count as a console window", async () => {
    const { scope, click } = loadWorker([windowClient(`${ORIGIN}/`, { focused: true }), windowClient("https://elsewhere.example/app/")]);
    await click({ url: APPROVAL });
    expect(scope.clients.openWindow).toHaveBeenCalledWith(APPROVAL);
  });

  it("a relative url resolves against the console's origin", async () => {
    const { scope, click } = loadWorker([]);
    await click({ url: "/app/?workspace=org_1#approval-appr_9" });
    expect(scope.clients.openWindow).toHaveBeenCalledWith(APPROVAL);
  });
});

describe("notificationclick url validation", () => {
  const front = `${ORIGIN}/app/`;
  for (const [label, url] of [
    ["another origin", "https://evil.example/app/?workspace=o#approval-a"],
    ["a protocol-relative url", "//evil.example/app/"],
    ["this origin but not under /app/", `${ORIGIN}/v1/me`],
    ["a path that only starts with /app", `${ORIGIN}/application/x`],
    ["a javascript: url", "javascript:alert(1)"],
    ["a non-string", 42],
    ["nothing at all", undefined],
  ] as const) {
    it(`${label} falls back to /app/ when opening a window`, async () => {
      const { scope, click } = loadWorker([]);
      await click({ url });
      expect(scope.clients.openWindow).toHaveBeenCalledWith(front);
    });

    it(`${label} falls back to /app/ in the message to an existing window`, async () => {
      const w = windowClient(`${ORIGIN}/app/`);
      const { click } = loadWorker([w]);
      await click({ url });
      expect(w.postMessage.mock.calls[0][0]).toEqual({ type: "opencadre:open", url: front });
    });
  }

  it("a click with no data at all still closes the notification and reaches /app/", async () => {
    const { scope, click } = loadWorker([]);
    const { close } = await click(undefined);
    expect(close).toHaveBeenCalled();
    expect(scope.clients.openWindow).toHaveBeenCalledWith(front);
  });
});

describe("notificationclick: what counts as a console window", () => {
  it("a public-site window (same origin, /pricing or /) never counts, even focused; another origin's /app/ neither", async () => {
    const pricing = windowClient(`${ORIGIN}/pricing`, { focused: true });
    const home = windowClient(`${ORIGIN}/`, { visible: true });
    const lookalike = windowClient(`${ORIGIN}/application`, { visible: true });
    const foreign = windowClient("https://opencadre.example/pricing", { focused: true });
    const { scope, click } = loadWorker([pricing, home, lookalike, foreign]);
    await click({ url: APPROVAL });
    for (const w of [pricing, home, lookalike, foreign]) {
      expect(w.postMessage).not.toHaveBeenCalled();
      expect(w.focus).not.toHaveBeenCalled();
    }
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
  });

  it("asks matchAll for windows including uncontrolled ones", async () => {
    const { scope, click } = loadWorker([]);
    await click({ url: APPROVAL });
    expect(scope.clients.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
  });
});

describe("notificationclick: taps in a burst", () => {
  it("two taps in the same instant with no window: the latest opens the one window, at its own url", async () => {
    const { scope, click } = loadWorker([], { openDelay: 10 });
    await Promise.all([click({ url: APPROVAL }), click({ url: `${ORIGIN}/app/?workspace=org_1#approval-appr_10` })]);
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
    expect(scope.clients.openWindow.mock.calls[0][0]).toContain("appr_10");
  });

  it("a second tap while the first tap's window is still opening waits for it and uses it (listed at once)", async () => {
    vi.useFakeTimers();
    const { scope, click } = loadWorker([], { openDelay: 10 });
    const first = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(1);
    const second = click({ url: `${ORIGIN}/app/?workspace=org_1#approval-appr_10` });
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, second]);
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
    const opened = (await scope.clients.openWindow.mock.results[0].value) as FakeClient;
    expect(opened.postMessage).toHaveBeenCalledTimes(1);
    expect(opened.postMessage.mock.calls[0][0].url).toContain("appr_10");
  });

  it("the window openWindow just made may not be in matchAll yet: later taps find it by id and open no other", async () => {
    vi.useFakeTimers();
    const { scope, click } = loadWorker([], { openDelay: 5, listed: false });
    const taps = [click({ url: APPROVAL })];
    await vi.advanceTimersByTimeAsync(1);
    taps.push(click({ url: APPROVAL }));
    await vi.advanceTimersByTimeAsync(1000);
    taps.push(click({ url: APPROVAL }));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(taps);
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
    expect(scope.clients.get).toHaveBeenCalled();
  });

  it("many taps in the same instant while windows are open open none, and only the latest reaches the best window", async () => {
    const focused = windowClient(`${ORIGIN}/app/`, { focused: true });
    const other = windowClient(`${ORIGIN}/app/`);
    const { scope, click } = loadWorker([other, focused]);
    const urls = [1, 2, 3].map((n) => `${ORIGIN}/app/?workspace=org_1#approval-appr_${n}`);
    await Promise.all(urls.map((url) => click({ url })));
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
    expect(focused.postMessage).toHaveBeenCalledTimes(1);
    expect(focused.postMessage.mock.calls[0][0].url).toBe(urls[2]);
    expect(other.postMessage).not.toHaveBeenCalled();
  });

  it("a tap whose window opening never settles does not block the next tap for ever: it uses the window that appears", async () => {
    vi.useFakeTimers();
    const shown: FakeClient[] = [];
    const { scope, click } = loadWorker(shown);
    scope.clients.openWindow.mockImplementationOnce(() => new Promise(() => {}));
    const first = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(0);
    const second = click({ url: APPROVAL });
    const appeared = windowClient(`${ORIGIN}/app/`, { visible: true });
    await vi.advanceTimersByTimeAsync(5000);
    shown.push(appeared); // the window the first tap asked for turns up in matchAll on its own
    await vi.advanceTimersByTimeAsync(60_000);
    await first;
    await second;
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
    expect(appeared.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("notificationclick: a failure never opens a window while one exists", () => {
  it("postMessage throwing (window closing, port gone) and focus refused: no openWindow, no rejection", async () => {
    vi.useFakeTimers();
    const w = windowClient(`${ORIGIN}/app/`, { focused: true, controlled: false });
    w.postMessage.mockImplementation(() => { throw new Error("DataCloneError"); });
    w.focus.mockRejectedValue(new Error("not allowed"));
    const { scope, click } = loadWorker([w]);
    const clicked = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(clicked).resolves.toBeDefined();
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it("matchAll returning a window that then vanishes (navigate rejects, focus rejects) still opens nothing", async () => {
    vi.useFakeTimers();
    const w = windowClient(`${ORIGIN}/app/`, { listens: false, controlled: false });
    w.focus.mockRejectedValue(new TypeError("Invalid client"));
    const { scope, click } = loadWorker([w]);
    const clicked = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(5000);
    await clicked;
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });
});

describe("notificationclick: credentials never survive in the url", () => {
  it("user:password@ in a same-origin url is stripped before it is sent or opened", async () => {
    const withCreds = ORIGIN.replace("//", "//user:secret@") + "/app/?workspace=org_1#approval-appr_9";
    const w = windowClient(`${ORIGIN}/app/`);
    const one = loadWorker([w]);
    await one.click({ url: withCreds });
    expect(JSON.stringify(w.postMessage.mock.calls[0][0])).not.toContain("secret");
    const two = loadWorker([]);
    await two.click({ url: withCreds });
    expect(two.scope.clients.openWindow.mock.calls[0][0]).toBe(APPROVAL);
  });
});

describe("notificationclick: an unfinished openWindow blocks every other open", () => {
  it("a 40 s openWindow and a second tap at 1 s: one openWindow call, and the second tap targets that window once it resolves", async () => {
    vi.useFakeTimers();
    const { scope, click } = loadWorker([], { openDelay: 40_000, listed: false });
    const first = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(1000);
    const second = click({ url: `${ORIGIN}/app/?workspace=org_1#approval-appr_10` });
    await vi.advanceTimersByTimeAsync(120_000);
    await Promise.all([first, second]);
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
    const opened = (await scope.clients.openWindow.mock.results[0].value) as FakeClient;
    expect(opened.postMessage).toHaveBeenCalledTimes(1);
    expect(opened.postMessage.mock.calls[0][0].url).toContain("appr_10");
  });

  it("an openWindow that never resolves: later taps never start another, and they finish", async () => {
    vi.useFakeTimers();
    const { scope, click } = loadWorker([]);
    scope.clients.openWindow.mockImplementation(() => new Promise(() => {}));
    const taps = [click({ url: APPROVAL })];
    await vi.advanceTimersByTimeAsync(1000);
    taps.push(click({ url: APPROVAL }), click({ url: APPROVAL }));
    await vi.advanceTimersByTimeAsync(300_000);
    await Promise.all(taps);
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
  });

  it("an openWindow that fails frees the way: the next tap may open one", async () => {
    const { scope, click } = loadWorker([]);
    scope.clients.openWindow.mockRejectedValueOnce(new Error("blocked"));
    await click({ url: APPROVAL }).catch(() => {});
    await click({ url: APPROVAL });
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(2);
  });
});

// Regressions from Codex's independent review of #665 (pr665-sw-race-probe.ts), verbatim.
describe("review: expired notification work", () => {
  it("a timed-out matchAll answer cannot open a duplicate after a later click opened the console", async () => {
    vi.useFakeTimers();
    const { scope, click } = loadWorker([]);
    let release!: (clients: FakeClient[]) => void;
    scope.clients.matchAll.mockImplementationOnce(() => new Promise<FakeClient[]>((resolve) => { release = resolve; }));
    const first = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(0);
    const second = click({ url: `${ORIGIN}/app/?workspace=org_1#approval-appr_10` });
    await vi.advanceTimersByTimeAsync(31_000);
    await second;
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
    release([]); // the first enumeration finally answers with its old empty snapshot
    await vi.advanceTimersByTimeAsync(10);
    await first;
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
  });
});

it("review: an openWindow taking longer than the hang release must not spawn a second window", async () => {
  vi.useFakeTimers();
  const { scope, click } = loadWorker([], { openDelay: 40_000 });
  const first = click({ url: APPROVAL });
  await vi.advanceTimersByTimeAsync(0);
  const second = click({ url: `${ORIGIN}/app/?workspace=org_1#approval-appr_10` });
  await vi.advanceTimersByTimeAsync(80_000);
  await Promise.all([first, second]);
  expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
});

describe("notificationclick: the latest click owns the worker's work", () => {
  it("an old click whose matchAll stalls past the release cannot post its url to the window a newer click opened", async () => {
    vi.useFakeTimers();
    const { scope, click } = loadWorker([]);
    let release!: (clients: FakeClient[]) => void;
    scope.clients.matchAll.mockImplementationOnce(() => new Promise<FakeClient[]>((resolve) => { release = resolve; }));
    const first = click({ url: APPROVAL }); // the old click: its enumeration stalls
    await vi.advanceTimersByTimeAsync(0);
    const second = click({ url: `${ORIGIN}/app/?workspace=org_1#approval-appr_10` });
    await vi.advanceTimersByTimeAsync(31_000);
    await second;
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
    const opened = (await scope.clients.openWindow.mock.results[0].value) as FakeClient;
    expect(scope.clients.openWindow.mock.calls[0][0]).toContain("appr_10");
    release([opened]); // the old enumeration finally answers, and now lists the new window
    await vi.advanceTimersByTimeAsync(10);
    await first;
    expect(opened.postMessage).not.toHaveBeenCalled(); // the new window was opened AT the new url; the old url never reaches it
    expect(opened.focus).not.toHaveBeenCalled();
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
  });

  it("a superseded click does not navigate an old page either", async () => {
    vi.useFakeTimers();
    const old = windowClient(`${ORIGIN}/app/`, { listens: false, controlled: true });
    const { scope, click } = loadWorker([old]);
    const first = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(100); // waiting for an acknowledgement that will not come
    const second = click({ url: `${ORIGIN}/app/?workspace=org_1#approval-appr_10` });
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([first, second]);
    expect(old.navigate).not.toHaveBeenCalledWith(APPROVAL);
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it("a superseded click that owns an in-flight openWindow still clears the block when that open settles", async () => {
    vi.useFakeTimers();
    const { scope, click } = loadWorker([], { openDelay: 5_000, listed: false });
    const first = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(1); // the first tap has asked for its window
    const second = click({ url: `${ORIGIN}/app/?workspace=org_1#approval-appr_10` }); // and is now superseded
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([first, second]);
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
    // the open settled, so the block is gone: once the window is gone too, a later click may open again
    scope.clients.get.mockResolvedValue(undefined);
    const third = click({ url: APPROVAL });
    await vi.advanceTimersByTimeAsync(20_000);
    await third;
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(2);
  });
});

// Regression from Codex's re-review of #665 at 5a18e214 (pr665-5a18-worker-stale-probe.ts), verbatim.
it("review: an expired worker enumeration cannot deliver an older click after the newer click opened a window", async () => {
  vi.useFakeTimers();
  const { scope, click } = loadWorker([]);
  let release!: (clients: FakeClient[]) => void;
  scope.clients.matchAll.mockImplementationOnce(() => new Promise<FakeClient[]>((resolve) => { release = resolve; }));
  const first = click({ url: APPROVAL });
  await vi.advanceTimersByTimeAsync(0);
  const latest = `${ORIGIN}/app/?workspace=org_1#approval-appr_10`;
  const second = click({ url: latest });
  await vi.advanceTimersByTimeAsync(31_000);
  await second;
  const opened = await scope.clients.openWindow.mock.results[0].value as FakeClient;
  release([]);
  await vi.advanceTimersByTimeAsync(10);
  await first;
  const destination = opened.postMessage.mock.calls.at(-1)?.[0]?.url ?? opened.url;
  expect(destination).toBe(latest);
});
