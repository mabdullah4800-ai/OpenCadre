// The sign-out quarantine is shared by every tab of the browser (Codex-OpenCadre-049a's ruling after #657).
//
// #657 wrote the quarantine of a signed-out cookie to sessionStorage, which only the tab that signed out can read.
// Another tab of the same browser had no marker: if the hub never confirmed the invalidation, reloading that tab (or the
// browser after a restart) entered the old, still valid cookie, and a tab already open kept showing the old person's
// workspace. The quarantine now lives in localStorage; this tab's key fingerprint stays in sessionStorage; a `storage`
// event resets another tab showing the cookie's identity at once; every proof that lifts it is checked against the
// quarantine in force (tabs race); and a lease keeps open tabs from all sending the invalidation.
//
// These are genuine two-page tests: each page is its own Window running the real app.js, the pages share one
// localStorage, each tab has its own sessionStorage (kept across its reloads), and a localStorage write reaches the other
// pages as a `storage` event (tests/helpers/browser-tabs.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browser, type Page, type Tab } from "./helpers/browser-tabs.js";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => { let r!: () => void; const promise = new Promise<void>((res) => { r = res; }); return { promise, resolve: r }; };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

// The shared quarantine, schema v1: one write-once key per pending sign-out, and a backoff key per entry.
const PREFIX = "opencadre.signOutQuarantine.v1.";
const ENTRY = `${PREFIX}entry.`;
const BACKOFF = `${PREFIX}backoff.`;
const TAB_RECORD = "opencadre.signedOut";
// What the old person's workspace shows. None of it may stay on another tab's screen once they sign out.
const P1_TASK = "P1-PRIVATE-TASK";
const P1_MARKERS = [P1_TASK];

/** `bare` is the path without its query: the task board reads one page per column (`/v1/tasks?summary=1&column=...`,
 * tasks tranche 2), and "a /v1/tasks request" means any of them. */
type Call = { page: string; path: string; bare: string; method: string; ws: string; auth: string; at: number };

/** One hub, and one browser cookie jar: `state.session` says whether the browser's cookie is a live session, and
 * `state.personId` whose it is. The cookie belongs to the browser, so every tab sends the same one. `hold[key]` and
 * `answer[key]` (key = "<METHOD> <path>", "<METHOD> <path> <bearer>" or "<page> <METHOD> <path>") hold a request
 * before the hub handles it, or override its status; `late[key]` lets the hub handle it at once but holds the ANSWER
 * on its way back (it says what was true when it was sent); `state.latency` is how long every answer takes. */
function hub() {
  const state = { session: true, personId: "p1", latency: 0 };
  const hold: Record<string, Deferred | undefined> = {};
  const late: Record<string, Deferred | undefined> = {};
  const answer: Record<string, number | undefined> = {};
  const calls: Call[] = [];
  const forPage = (page: string) => async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ws = headers["X-OpenCadre-Workspace"] ?? "none";
    const auth = (headers.authorization ?? "").replace("Bearer ", "");
    const bare = path.split("?")[0];
    calls.push({ page, path, bare, method, ws, auth, at: Date.now() });
    if (state.latency) await new Promise((done) => setTimeout(done, state.latency));
    // Held and answered by exact path, and by the path without its query ("GET /v1/tasks" holds every board read).
    const keys = [...new Set([`${page} ${method} ${path}`, `${method} ${path} ${auth}`, `${method} ${path}`,
      `${page} ${method} ${bare}`, `${method} ${bare} ${auth}`, `${method} ${bare}`])];
    const res = await handle(keys, method, path, ws, auth);
    for (const key of keys) if (late[key]) await late[key]!.promise;
    return res;
  };
  const handle = async (keys: string[], method: string, path: string, ws: string, auth: string) => {
    for (const key of keys) {
      if (hold[key]) await hold[key]!.promise;
      if (answer[key]) return json(answer[key]!, { error: "nope" });
    }
    if (path === "/v1/auth/me") {
      if (!state.session) return json(401, { error: "no session" });
      return json(200, { person: { id: state.personId, name: "Ada", email: "ada@example.com" }, workspaces: [
        { orgId: "ws-a", name: "Alpha", role: "owner" }, { orgId: "ws-b", name: "Beta", role: "owner" }] });
    }
    if (path === "/v1/auth/config") return json(200, { enabled: true, methods: {}, signup: "closed" });
    if (path === "/v1/auth/signout") { state.session = false; return json(200, { ok: true }); }
    if (method !== "GET") return json(200, {});
    // A key session, or the cookie's workspace. Only the cookie's workspace (p1's) carries the private task.
    const cookie = !auth && ws !== "none";
    if (path === "/v1/me") {
      const org = auth ? `key-${auth}` : ws;
      return json(200, { orgId: org, orgName: org, agentId: `me-${org}`, agentName: "Ada", role: "operator", workspace: { paused: false } });
    }
    if (path === "/v1/agents") return json(200, { agents: [] });
    if (path.startsWith("/v1/approvals")) return json(200, { approvals: [] });
    if (path === "/v1/approval-grants") return json(200, { grants: [] });
    if (path.split("?")[0] === "/v1/tasks") {
      // The paged shape (src/tasks.ts listTaskPage); the private task is on the Open column's page.
      const onPage = cookie && path.includes("column=open");
      return json(200, {
        tasks: onPage ? [{ id: "t-a", title: P1_TASK, status: "open", created_by_agent_name: "Grace", created_at: new Date().toISOString() }] : [],
        nextCursor: null, counts: { open: onPage ? 1 : 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 }, projects: [],
      });
    }
    if (path.startsWith("/v1/events")) return json(200, { events: [] });
    if (path === "/v1/awareness") return json(200, { items: [], background: {}, cursor: 0 });
    if (path.startsWith("/v1/messages")) return json(200, { messages: [] });
    if (path === "/v1/org/devices") return json(200, { devices: [] });
    if (path.startsWith("/v1/org/sessions")) return json(200, { sessions: [] });
    if (path === "/v1/org/projects") return json(200, { projects: [] });
    if (path === "/v1/onboarding") return json(200, { completed: 1, total: 1, steps: [] });
    return json(200, {});
  };
  const signouts = (page?: string) => calls.filter((c) => c.method === "POST" && c.path === "/v1/auth/signout" && (!page || c.page === page));
  /** A page used the cookie to ENTER a workspace (looking at /v1/auth/me is allowed; /v1/me for a workspace is not). */
  const enteredWithCookie = (page: string, from = 0) => calls.slice(from).some((c) => c.page === page && c.path === "/v1/me" && c.ws !== "none" && !c.auth);
  return { state, hold, late, answer, calls, forPage, signouts, enteredWithCookie };
}
type Hub = ReturnType<typeof hub>;

type App = {
  signOut: (message?: string) => void;
  signIn: (key: string) => Promise<void>;
  enterWorkspace: (orgId: string) => Promise<void>;
  whoIsIn: () => string | null;
  mode: () => string;
  q: { add: (e: { personId: string | null }) => string; lift: (ids: string[]) => void; backOff: (ids: string[]) => void; read: () => unknown };
};
const RETURNS = "{ signOut, signIn, enterWorkspace, whoIsIn: () => me?.orgId ?? null, mode: () => authMode, "
  + "q: { add: addQuarantineEntry, lift: liftQuarantine, backOff, read: readQuarantine } }";

let browser: Browser;
beforeEach(() => {
  browser = new Browser();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  browser.closeAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function load(tab: Tab, h: Hub, ms = 300) {
  const page = tab.open<App>(h.forPage(tab.name), RETURNS);
  await vi.advanceTimersByTimeAsync(ms);
  return page;
}
/** A tab signed in with the browser's cookie, in workspace A (the person has two workspaces, so boot shows the picker). */
async function inWorkspaceA(tab: Tab, h: Hub) {
  const page = await load(tab, h);
  expect(page.shown("workspace-picker")).toBe(true);
  await page.app.enterWorkspace("ws-a");
  await vi.advanceTimersByTimeAsync(300);
  expect(page.app.whoIsIn()).toBe("ws-a");
  expect(page.document.body.textContent, "the setup shows p1's workspace").toContain(P1_TASK);
  return page;
}
type Entry = { personId: string | null; signOutId: string; attempts: number; nextAt: number };
/** The pending sign-outs in shared storage, read straight from their keys (unparseable values show as null), by id. */
const entries = (): Entry[] => browser.localStorage.entries().filter(([k]) => k.startsWith(ENTRY)).map(([k, v]) => {
  const signOutId = k.slice(ENTRY.length);
  let personId: string | null = null;
  try { personId = typeof JSON.parse(v)?.personId === "string" ? JSON.parse(v).personId : null; } catch { /* unknown */ }
  const backoff = JSON.parse(browser.localStorage.getItem(BACKOFF + signOutId) ?? "{}");
  return { personId, signOutId, attempts: backoff.attempts ?? 0, nextAt: backoff.nextAt ?? 0 };
}).sort((a, b) => (a.signOutId < b.signOutId ? -1 : 1));
const quarantine = () => (entries().length ? { entries: entries() } : null);
/** Pending sign-outs whose tabs are long gone, written straight to storage (no events); their ids sort first. */
const seedEntries = (people: Array<string | null>, nextAt = 0): Entry[] => people.map((personId, i) => {
  const signOutId = `${(Date.now() - 60_000).toString(36)}-seed${String(i).padStart(2, "0")}`;
  browser.localStorage.setItem(ENTRY + signOutId, JSON.stringify({ personId }));
  if (nextAt) browser.localStorage.setItem(BACKOFF + signOutId, JSON.stringify({ attempts: 0, nextAt }));
  return { personId, signOutId, attempts: 0, nextAt };
});
/** Whose cookies are quarantined (null: an unknown person, which matches every cookie). */
const pendingFor = () => entries().map((e) => e.personId).sort();
const privateOnScreen = (page: Page<App>) => P1_MARKERS.filter((m) => (page.document.body.textContent ?? "").includes(m));
/** The key fingerprint is a SHA-256 digest, which completes off the (faked) timers: wait for it in real time. */
const tabKeyWritten = (tab: Tab) => vi.waitFor(() => {
  expect(JSON.parse(tab.sessionStorage.getItem(TAB_RECORD) ?? "{}").tabKey).toMatch(/^[0-9a-f]{64}$/);
});
const signInWithKey = (page: Page<App>, key: string) => {
  (page.$("signin-key") as HTMLInputElement).value = key;
  (page.$("signin-key-form") as HTMLFormElement).requestSubmit();
};

describe("tab A signs out while tab B shows the same cookie session", () => {
  for (const failure of ["fails", "hangs"] as const) {
    it(`B's page is reset at once, and no reload of B (or a new tab) enters the old cookie, when the invalidation ${failure}`, async () => {
      const h = hub();
      const a = browser.tab("A"), b = browser.tab("B");
      const pageA = await inWorkspaceA(a, h);
      const pageB = await inWorkspaceA(b, h);
      if (failure === "fails") h.answer["POST /v1/auth/signout"] = 500;
      else h.hold["POST /v1/auth/signout"] = deferred(); // never answers
      // B has a refresh out for p1's workspace when A signs out: it must never paint afterwards.
      const lateTasks = deferred();
      h.hold["GET /v1/tasks"] = lateTasks;
      await vi.advanceTimersByTimeAsync(4100); // B's (and A's) poll: its tasks request is now held
      expect(h.calls.some((c) => c.page === "B" && c.bare === "/v1/tasks" && c.at >= Date.now() - 4100)).toBe(true);

      pageA.app.signOut();
      expect(pendingFor(), "the quarantine is shared the moment signOut returns").toEqual(["p1"]);
      await vi.advanceTimersByTimeAsync(1); // the storage event is a task: B handles it next
      expect(pageB.app.whoIsIn(), "B still has the old identity").toBeNull();
      expect(pageB.shown("console")).toBe(false);
      expect(pageB.shown("signin")).toBe(true);
      expect(pageB.$("signin-error").textContent).toBe("You signed out in another tab. Sign in again to continue.");
      expect(privateOnScreen(pageB), "B still shows p1's workspace").toEqual([]);
      h.hold["GET /v1/tasks"] = undefined;
      lateTasks.resolve();
      await vi.advanceTimersByTimeAsync(300);
      expect(privateOnScreen(pageB), "B's refresh for the old identity painted after the reset").toEqual([]);
      expect(pageB.replace, "B is reset in place, not reloaded").not.toHaveBeenCalled();

      // B reloads, while the hub has still not confirmed anything.
      let from = h.calls.length;
      const reloadedB = await load(b, h, 10_000);
      expect(h.enteredWithCookie("B", from), "B's reload entered the old cookie").toBe(false);
      expect(reloadedB.app.whoIsIn()).toBeNull();
      expect(reloadedB.shown("signin")).toBe(true);
      // So does a tab that never saw any of this (a new tab, or the browser after a restart: localStorage stays).
      from = h.calls.length;
      const c = await load(browser.tab("C"), h, 10_000);
      expect(h.enteredWithCookie("C", from), "a new tab entered the old cookie").toBe(false);
      expect(c.app.whoIsIn()).toBeNull();
      expect(pendingFor()).toEqual(["p1"]);
    });
  }

  it("B on the workspace picker is reset too: the person's workspace list goes", async () => {
    const h = hub();
    const pageA = await inWorkspaceA(browser.tab("A"), h);
    const pageB = await load(browser.tab("B"), h);
    expect(pageB.shown("workspace-picker")).toBe(true);
    h.answer["POST /v1/auth/signout"] = 500;
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(1);
    expect(pageB.shown("workspace-picker")).toBe(false);
    expect(pageB.shown("signin")).toBe(true);
  });

  it("a confirmed sign-out still resets B, even though A lifts the quarantine before B hears of it", async () => {
    const h = hub();
    const pageA = await inWorkspaceA(browser.tab("A"), h);
    const pageB = await inWorkspaceA(browser.tab("B"), h);
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(100);
    expect(quarantine(), "the hub confirmed: the quarantine lifted").toBeNull();
    expect(pageB.app.whoIsIn()).toBeNull();
    expect(pageB.shown("signin")).toBe(true);
    expect(privateOnScreen(pageB)).toEqual([]);
  });
});

describe("proofs are checked against the quarantine in force: tabs race", () => {
  it("a stale retry in A that completes after B wrote a newer quarantine does not lift it", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const a = browser.tab("A"), b = browser.tab("B");
    const pageA = await inWorkspaceA(a, h);
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    const [first] = entries();
    expect(pendingFor()).toEqual(["p1"]);
    // A reloads onto the sign-in page; its retry sends the invalidation, and the answer is slow.
    h.answer["POST /v1/auth/signout"] = undefined;
    const slow = deferred();
    h.hold["POST /v1/auth/signout"] = slow;
    const from = h.calls.length;
    await load(a, h, 20_000);
    expect(h.signouts("A").some((c) => h.calls.indexOf(c) >= from), "A's retry is out").toBe(true);
    // Meanwhile, in B, a different person completes a sign-in (the cookie is theirs: that proof lifts the old
    // quarantine), opens a workspace and signs out; that invalidation fails, so B's quarantine is pending.
    h.state.personId = "p2";
    const pageB = await load(b, h);
    expect(quarantine(), "a different person's session lifted p1's quarantine").toBeNull();
    await pageB.app.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(300);
    h.hold["POST /v1/auth/signout"] = undefined;
    h.answer["POST /v1/auth/signout"] = 500;
    pageB.app.signOut();
    await vi.advanceTimersByTimeAsync(100); // B's own invalidation has failed
    const [newer] = entries();
    expect(pendingFor()).toEqual(["p2"]);
    expect(newer.signOutId).not.toBe(first.signOutId);
    // A's old invalidation now answers: confirmed. It was about p1's quarantine, which is not the one in force.
    h.answer["POST /v1/auth/signout"] = undefined;
    slow.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.state.session, "A's request was answered (2xx)").toBe(false);
    expect(entries(), "a stale retry lifted a newer quarantine").toEqual([newer]);
  });

  it("a stale retry in A that FAILS after B wrote a newer quarantine writes no backoff onto it", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const a = browser.tab("A"), b = browser.tab("B");
    const pageA = await inWorkspaceA(a, h);
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    const slow = deferred();
    h.hold["POST /v1/auth/signout"] = slow;
    const from = h.calls.length;
    await load(a, h, 20_000);
    expect(h.signouts("A").some((c) => h.calls.indexOf(c) >= from), "A's retry is out").toBe(true);
    h.state.personId = "p2";
    const pageB = await load(b, h);
    await pageB.app.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(300);
    h.hold["POST /v1/auth/signout"] = undefined;
    pageB.app.signOut();
    await vi.advanceTimersByTimeAsync(100);
    const newer = entries();
    expect(newer).toEqual([expect.objectContaining({ personId: "p2", attempts: 0 })]);
    slow.resolve(); // A's stale request fails (500): A would now write its backoff
    await vi.advanceTimersByTimeAsync(10);
    expect(entries(), "A's stale retry wrote onto the newer quarantine").toEqual(newer);
  });

  it("A's own sign-out sends no invalidation once another tab has lifted its quarantine (the cookie is someone else's now)", async () => {
    const h = hub();
    const a = browser.tab("A");
    // A has a push subscription, so its sign-out first removes this browser's push device, and only then invalidates.
    const pushing = { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/sub" }) } }) } };
    const pageA = a.open<App>(h.forPage("A"), RETURNS, { navigator: pushing });
    await vi.advanceTimersByTimeAsync(300);
    await pageA.app.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(300);
    const pushRemoval = deferred();
    h.hold["DELETE /v1/push/devices"] = pushRemoval;
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls.some((c) => c.page === "A" && c.method === "DELETE" && c.path === "/v1/push/devices"), "the push removal is out").toBe(true);
    // Meanwhile a different person completes a sign-in in tab B: the cookie is theirs, which lifts A's quarantine.
    h.state.personId = "p2";
    const pageB = await load(browser.tab("B"), h);
    expect(quarantine()).toBeNull();
    expect(pageB.shown("workspace-picker")).toBe(true);
    const from = h.calls.length;
    pushRemoval.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.signouts().filter((c) => h.calls.indexOf(c) >= from), "A invalidated the new person's session").toEqual([]);
    expect(h.state.session, "p2's session was ended").toBe(true);
  });

  it("A's retry, having looked at the cookie (still p1's), sends nothing once another tab lifted the quarantine meanwhile", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const a = browser.tab("A");
    const pageA = await inWorkspaceA(a, h);
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    await load(a, h, 1000); // A's new page: its retry waits for the old page's lease to lapse
    // A's next look at the cookie is answered "p1" (true when the hub handled it), but the answer is slow to arrive.
    const lookAnswer = deferred();
    h.late["A GET /v1/auth/me"] = lookAnswer;
    await vi.advanceTimersByTimeAsync(20_000);
    const look = h.calls.findLastIndex((c) => c.page === "A" && c.path === "/v1/auth/me");
    expect(look, "A's retry is looking").toBeGreaterThan(-1);
    // Meanwhile a different person completes a sign-in in tab B: that lifts the quarantine.
    h.state.personId = "p2";
    await load(browser.tab("B"), h);
    expect(quarantine()).toBeNull();
    const from = h.calls.length;
    h.late["A GET /v1/auth/me"] = undefined;
    lookAnswer.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.signouts().filter((c) => h.calls.indexOf(c) >= from), "A sent its invalidation to the new person's session").toEqual([]);
    expect(h.state.session).toBe(true);
  });
});

describe("what lifts the quarantine, for every tab", () => {
  it("a different person replacing the cookie in one tab lifts it for all tabs: the others enter normally, and nothing invalidates the new session", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const a = browser.tab("A"), b = browser.tab("B");
    const pageA = await inWorkspaceA(a, h);
    const pageB = await inWorkspaceA(b, h);
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    expect(pageB.shown("signin")).toBe(true);
    // An emailed link or OAuth completes as p2 in tab B (the cookie is now p2's): B's page load proves it.
    h.state.personId = "p2";
    const from = h.calls.length;
    const reloadedB = await load(b, h);
    expect(quarantine(), "the quarantine did not lift").toBeNull();
    expect(reloadedB.shown("workspace-picker"), "the new person's session was not used").toBe(true);
    // Tab A (still open on its sign-in page, with its retry timer) and a reload of it: the new session is theirs.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.signouts().filter((c) => h.calls.indexOf(c) >= from), "p2's session was sent an invalidation").toEqual([]);
    const reloadedA = await load(a, h);
    expect(reloadedA.shown("workspace-picker"), "tab A still treats the cookie as quarantined").toBe(true);
  });

  it("the SAME person signing in again fails closed, in every tab (documented: the hub names the person, not the session)", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const a = browser.tab("A"), b = browser.tab("B");
    const pageA = await inWorkspaceA(a, h);
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    // p1 completes a new sign-in in tab B: the cookie is a new session, but the same person's. It cannot be told from
    // the old one, so it stays quarantined: no tab enters it.
    for (const tab of [b, a, browser.tab("C")]) {
      const from = h.calls.length;
      const page = await load(tab, h, 10_000);
      expect(h.enteredWithCookie(tab.name, from), `${tab.name} entered the same person's cookie`).toBe(false);
      expect(page.app.whoIsIn()).toBeNull();
      expect(page.shown("signin")).toBe(true);
    }
    expect(pendingFor()).toEqual(["p1"]);
  });
});

describe("an explicit key session in another tab is not the cookie's", () => {
  it("B's bearer-key session survives A's sign-out, and keeps working", async () => {
    const h = hub();
    h.state.session = true;
    h.answer["POST /v1/auth/signout"] = 500;
    const pageA = await inWorkspaceA(browser.tab("A"), h);
    const b = browser.tab("B");
    const pageB = await load(b, h);
    // B sits on the picker; it signs in with a key instead.
    await pageB.app.signIn("agt_b_key");
    await vi.advanceTimersByTimeAsync(300);
    expect(pageB.app.whoIsIn()).toBe("key-agt_b_key");
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pageB.app.whoIsIn(), "A's sign-out knocked out B's key session").toBe("key-agt_b_key");
    expect(pageB.app.mode()).toBe("key");
    expect(pageB.shown("console")).toBe(true);
    expect(pageB.shown("signin")).toBe(false);
    const from = h.calls.length;
    await vi.advanceTimersByTimeAsync(4100);
    expect(h.calls.slice(from).some((c) => c.page === "B" && c.bare === "/v1/tasks" && c.auth === "agt_b_key"), "B's key session stopped refreshing").toBe(true);
  });

  it("a key session started in B during the quarantine is B's alone: B's reload keeps it, a new tab does not get it", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const pageA = await inWorkspaceA(browser.tab("A"), h);
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    const b = browser.tab("B");
    const pageB = await load(b, h, 1000);
    signInWithKey(pageB, "agt_b_key");
    await vi.advanceTimersByTimeAsync(3000);
    expect(pageB.app.whoIsIn()).toBe("key-agt_b_key");
    await tabKeyWritten(b);
    const reloadedB = await load(b, h, 1000);
    // Recognising the key takes a SHA-256 digest, which completes off the (faked) timers: wait for it in real time.
    await vi.waitFor(() => expect(reloadedB.app.whoIsIn(), "B's own key, recognised by B's fingerprint").toBe("key-agt_b_key"));
    const c = await load(browser.tab("C"), h, 1000);
    expect(c.app.whoIsIn(), "a key B saved was used by another tab during the quarantine").toBeNull();
    expect(pendingFor()).toEqual(["p1"]);
  });
});

describe("no credential is ever kept in either storage", () => {
  it("across sign-out, key sign-ins in two tabs, a rejected key and reloads, the markers hold allowlisted fields only", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    h.answer["GET /v1/me agt_rejected_secret"] = 401;
    const a = browser.tab("A"), b = browser.tab("B");
    const pageA = await inWorkspaceA(a, h);
    const pageB = await load(b, h);
    await pageB.app.signIn("agt_b_secret_key");
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    const reloadedA = await load(a, h, 1000);
    signInWithKey(reloadedA, "agt_a_secret_key");
    await vi.advanceTimersByTimeAsync(3000);
    await tabKeyWritten(a);
    signInWithKey(await load(browser.tab("C"), h, 1000), "agt_rejected_secret");
    await vi.advanceTimersByTimeAsync(3000);
    await load(a, h, 1000);
    const secrets = ["agt_b_secret_key", "agt_a_secret_key", "agt_rejected_secret", "ada@example.com", "Ada"];
    const stores: Array<[string, Array<[string, string]>]> = [
      ["localStorage", browser.localStorage.entries().filter(([k]) => k !== "opencadre.agentKey")], // the saved key is its own, older feature
      ["A's sessionStorage", a.sessionStorage.entries()],
      ["B's sessionStorage", b.sessionStorage.entries()],
    ];
    for (const [where, entries] of stores) {
      for (const [key, value] of entries) {
        for (const secret of secrets) expect(value, `${where} ${key} holds ${secret}`).not.toContain(secret);
      }
    }
    expect(entries().length, "the sign-out is pending").toBeGreaterThan(0);
    for (const [key, value] of browser.localStorage.entries()) {
      if (key === "opencadre.agentKey") continue; // the saved key is its own, older feature
      expect(key.startsWith(PREFIX), `${key} is not one of the quarantine's keys`).toBe(true);
      const fields = Object.keys(JSON.parse(value)).sort();
      if (key.startsWith(ENTRY)) expect(fields, key).toEqual(["personId"]);
      else if (key.startsWith(BACKOFF)) expect(fields, key).toEqual(["attempts", "nextAt"]);
      else expect([key, fields]).toEqual([`${PREFIX}lease`, ["owner", "until"]]);
    }
    for (const tab of [a, b]) {
      const record = JSON.parse(tab.sessionStorage.getItem(TAB_RECORD) ?? "{}");
      for (const key of Object.keys(record)) expect(["reason", "tabKey"], `${tab.name}'s tab record has ${key}`).toContain(key);
      expect(tab.sessionStorage.entries().some(([k]) => k.startsWith(PREFIX)), `the quarantine is in ${tab.name}'s sessionStorage`).toBe(false);
    }
    const tabKey = JSON.parse(a.sessionStorage.getItem(TAB_RECORD) ?? "{}").tabKey;
    expect(tabKey, "A's key fingerprint").toMatch(/^[0-9a-f]{64}$/);
    expect(browser.localStorage.entries().some(([, v]) => v.includes(tabKey)), "a tab's key fingerprint is shared").toBe(false);
  });
});

describe("a quarantine #657 left in a tab's sessionStorage", () => {
  const OLD = { reason: "key-rejected", pending: true, attempts: 2, nextAt: 0, personId: "p1", tabKey: "a".repeat(64), signOutId: "m0abc-legacy" };

  it("moves into the shared quarantine at that tab's next load: other tabs are protected from then on", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const a = browser.tab("A");
    a.sessionStorage.setItem(TAB_RECORD, JSON.stringify(OLD));
    const pageA = await load(a, h, 1000);
    expect(pageA.app.whoIsIn()).toBeNull();
    expect(entries()).toEqual([expect.objectContaining({ personId: "p1" })]);
    expect(entries()[0].signOutId, "the migrated entry reuses the old marker's id").not.toBe("m0abc-legacy");
    expect(entries()[0].attempts).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(a.sessionStorage.getItem(TAB_RECORD)!), "A's own record keeps only its own fields")
      .toEqual({ reason: null, tabKey: "a".repeat(64) });
    expect(pageA.$("signin-error").textContent, "the reason is shown once").toBe("Your key was rejected. Sign in again.");
    const from = h.calls.length;
    const pageB = await load(browser.tab("B"), h, 10_000);
    expect(h.enteredWithCookie("B", from), "another tab entered the cookie the old marker quarantined").toBe(false);
    expect(pageB.app.whoIsIn()).toBeNull();
  });

  it("an old marker with no quarantine (a key-mode exit) just carries its reason", async () => {
    const h = hub();
    const a = browser.tab("A");
    a.sessionStorage.setItem(TAB_RECORD, JSON.stringify({ reason: "key-rejected", pending: false, tabKey: null }));
    h.state.session = false;
    const pageA = await load(a, h, 1000);
    expect(quarantine()).toBeNull();
    expect(pageA.$("signin-error").textContent).toBe("Your key was rejected. Sign in again.");
  });
});

// Codex-OpenCadre-049a on #659 at 2b896bb1 (P1): the shared quarantine held ONE pending sign-out, and adopting a #657
// marker overwrote it when the old marker named another person with a later timestamp. Boot then read the cookie as the
// overwritten person's, took it for "a different person", lifted the quarantine and entered a session whose sign-out
// was never confirmed. Timestamps are not proof. The quarantine is now a set of pending sign-outs, one entry each:
// nothing overwrites or evicts an entry, a cookie matching any entry (an unknown-person entry matches every cookie) is
// never entered, and each entry lifts only on evidence about that entry.
describe("several pending sign-outs at once", () => {
  /** A #657 tab marker (sessionStorage), written `offsetMs` after now. */
  const oldMarker = (personId: string | null, offsetMs: number) => ({ reason: null, pending: true, attempts: 0, nextAt: 0,
    ...(personId ? { personId } : {}), tabKey: null, signOutId: `${(Date.now() + offsetMs).toString(36)}-old657` });
  /** Tab `name` shows `who`'s workspace (the cookie is `who`'s when it loads) and later signs out from that view. */
  async function showing(h: Hub, name: string, who: string) {
    h.state.personId = who;
    return inWorkspaceA(browser.tab(name), h);
  }
  /** No tab of this browser enters the cookie, whoever's it is among `cookies`, on a reload or in a new tab. */
  async function noTabEnters(h: Hub, tabs: Tab[], cookies: string[]) {
    for (const cookie of cookies) {
      h.state.personId = cookie;
      for (const tab of [...tabs, browser.tab(`new-${cookie}`)]) {
        const from = h.calls.length;
        const page = await load(tab, h, 10_000);
        expect(h.enteredWithCookie(tab.name, from), `${tab.name} entered ${cookie}'s cookie`).toBe(false);
        expect(page.shown("workspace-picker"), `${tab.name} listed ${cookie}'s workspaces`).toBe(false);
        expect(page.app.whoIsIn()).toBeNull();
      }
    }
  }

  for (const [order, offset] of [["NEWER", 60_000], ["OLDER", -60_000]] as const) {
    it(`a #657 marker for p1 ${order} than the shared entry for p2: both stay pending, and neither person's cookie enters any tab`, async () => {
      const h = hub();
      h.answer["POST /v1/auth/signout"] = 500;
      const pageC = await showing(h, "C", "p2");
      pageC.app.signOut();
      await vi.advanceTimersByTimeAsync(6000);
      const a = browser.tab("A");
      a.sessionStorage.setItem(TAB_RECORD, JSON.stringify(oldMarker("p1", offset)));
      await noTabEnters(h, [a], ["p2", "p1"]);
      expect(pendingFor(), "an entry was overwritten").toEqual(["p1", "p2"]);
    });
  }

  it("a #657 marker with no person id next to a known entry: the unknown entry matches every cookie, a person outside the set included", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const pageC = await showing(h, "C", "p2");
    pageC.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    const a = browser.tab("A");
    a.sessionStorage.setItem(TAB_RECORD, JSON.stringify(oldMarker(null, -60_000)));
    await noTabEnters(h, [a], ["p3", "p2"]);
    expect(pendingFor()).toEqual([null, "p2"]);
  });

  it("an identity answer from before a new entry was added lifts nothing new and enters no one", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const pageC = await showing(h, "C", "p1");
    pageC.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    // Tab A loads while the cookie is p9's (outside the set). The hub answers A's look at once, but the answer is slow.
    h.state.personId = "p9";
    const slowLook = deferred();
    h.late["A GET /v1/auth/me"] = slowLook;
    const a = browser.tab("A");
    const pageA = a.open<App>(h.forPage("A"), RETURNS);
    await vi.advanceTimersByTimeAsync(50);
    // Meanwhile tab B: p9's session lifts p1's entry, p9 opens a workspace and signs out, unconfirmed: p9 is pending.
    const pageB = await load(browser.tab("B"), h);
    expect(pendingFor()).toEqual([]);
    await pageB.app.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(300);
    pageB.app.signOut();
    await vi.advanceTimersByTimeAsync(100);
    expect(pendingFor()).toEqual(["p9"]);
    // A's stale answer ("p9, a person outside the set") arrives now: p9 is in the set.
    const from = h.calls.length;
    h.late["A GET /v1/auth/me"] = undefined;
    slowLook.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pendingFor(), "a stale answer lifted the newer entry").toEqual(["p9"]);
    expect(h.enteredWithCookie("A", from), "A entered p9's quarantined cookie").toBe(false);
    expect(pageA.shown("workspace-picker")).toBe(false);
    expect(pageA.app.whoIsIn()).toBeNull();
  });

  it("the set is bounded without evicting anyone: past the parsing bound, a new sign-out is an unknown entry that matches every cookie", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const pageA = await showing(h, "A", "p17");
    // Sixteen other sign-outs are already pending (written directly: their tabs are long gone).
    const sixteen = seedEntries(Array.from({ length: 16 }, (_, i) => `k${i + 1}`));
    pageA.app.signOut();
    expect(entries().filter((e) => sixteen.some((s) => s.signOutId === e.signOutId)), "an entry was evicted or changed").toEqual(sixteen);
    expect(entries()).toHaveLength(17);
    expect(entries().find((e) => !sixteen.some((s) => s.signOutId === e.signOutId))!.personId, "the new entry is an unknown person").toBeNull();
    await vi.advanceTimersByTimeAsync(6000);
    await noTabEnters(h, [browser.tab("B")], ["p17", "p42"]);
  });

  it("entries past the parsing bound are read as unknown, never skipped", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    seedEntries(Array.from({ length: 17 }, (_, i) => `k${i + 1}`)); // the seventeenth is not parsed: it fails closed
    await noTabEnters(h, [browser.tab("A")], ["p42"]);
  });

  // Codex-OpenCadre-049a on #659 at 0306228c (P1): a later sign-out folded into the one unknown overflow entry kept
  // that entry's id, so an older confirmation about it (p8's) lifted it after it had come to stand for p9 as well. With
  // a key per sign-out there is nothing to fold into: each is its own key under a fresh id, and a proof lifts only the
  // keys it captured.
  it("a sign-out past the bound is its own new key: an older confirmation about another entry does not lift it", async () => {
    const h = hub();
    const pageA = await showing(h, "A", "p8");
    seedEntries(Array.from({ length: 16 }, (_, i) => `k${i + 1}`));
    // A signs p8 out, past the bound: an unknown entry. The hub ends p8's session, but the answer is held.
    const confirmation = deferred();
    h.late["A POST /v1/auth/signout"] = confirmation;
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.state.session, "the hub has ended p8's session").toBe(false);
    // p9 signs in; a tab holding a #657 marker for p9 loads: p9 gets its own new key (an unknown person, past the bound).
    h.state.session = true;
    h.state.personId = "p9";
    h.answer["POST /v1/auth/signout"] = 500; // p9's invalidations fail
    const e = browser.tab("E");
    e.sessionStorage.setItem(TAB_RECORD, JSON.stringify({ reason: null, pending: true, attempts: 0, nextAt: 0, personId: "p9", tabKey: null,
      signOutId: `${Date.now().toString(36)}-old657` }));
    await load(e, h, 100);
    expect(entries().filter((x) => x.personId === null)).toHaveLength(2);
    // Only A's old confirmation (about p8) now arrives, inside its 5 s cleanup.
    h.late["A POST /v1/auth/signout"] = undefined;
    confirmation.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(pendingFor(), "p8's confirmation lifted the entry standing for p9").toContain(null);
    const from = h.calls.length;
    const fresh = await load(browser.tab("F"), h, 1000);
    expect(fresh.shown("workspace-picker"), "p9's workspaces were listed").toBe(false);
    expect(h.enteredWithCookie("F", from)).toBe(false);
  });

  // Codex-OpenCadre-049a's executable reproduction at 0306228c (B:\ai-work\temp\049a-pr659-review\
  // overflow-proof-repro.test-snippet.ts). Adapted to the per-key layout: it seeds 16 entries (the parsing bound)
  // instead of 7 (the old set's bound), through seedEntries instead of one JSON value, so the sign-outs land past the
  // bound; its steps and assertions are otherwise as written.
  it("Codex's reproduction: an older confirmation cannot lift a newer sign-out past the bound", async () => {
    const h = hub();
    h.state.personId = "p8";
    const pageA = await inWorkspaceA(browser.tab("A"), h);
    seedEntries(Array.from({ length: 16 }, (_, i) => `p${i + 1}x`), Date.now() + 120_000);
    const oldConfirmation = deferred();
    h.late["A POST /v1/auth/signout"] = oldConfirmation;
    pageA.app.signOut();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.state.session, "the old invalidation completed on the hub").toBe(false);
    expect(entries()).toHaveLength(17);
    expect(entries().filter((x) => x.personId === null)).toHaveLength(1);
    h.state.session = true;
    h.state.personId = "p9";
    h.answer["POST /v1/auth/signout"] = 500;
    const e = browser.tab("legacy-p9");
    e.sessionStorage.setItem(TAB_RECORD, JSON.stringify({ pending: true, personId: "p9", signOutId: "later-p9", attempts: 0, nextAt: Date.now() + 120_000 }));
    await load(e, h, 50);
    expect(entries()).toHaveLength(18);
    expect(entries().some((x) => x.personId === null), "p9 is protected by an overflow entry").toBe(true);
    oldConfirmation.resolve();
    await vi.advanceTimersByTimeAsync(50);
    const from = h.calls.length;
    const fresh = await load(browser.tab("fresh-p9"), h, 50);
    expect(fresh.shown("workspace-picker"), "the earlier confirmation allowed the unconfirmed p9 cookie to list its workspaces").toBe(false);
    expect(h.enteredWithCookie("fresh-p9", from)).toBe(false);
    expect(entries().some((x) => x.personId === null || x.personId === "p9"), "p9's pending sign-out was lifted without its own evidence").toBe(true);
  });

  it("an older 'gone' answer cannot lift a newer sign-out past the bound either", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const pageA = await showing(h, "A", "p8");
    seedEntries(Array.from({ length: 16 }, (_, i) => `k${i + 1}`), Date.now() + 120_000);
    pageA.app.signOut(); // p8, past the bound: an unknown entry; its invalidation fails
    await vi.advanceTimersByTimeAsync(100);
    expect(pendingFor()).toContain(null);
    // p8's session then ends at the hub. Tab R's boot looks at the cookie: "no session" (401), but the answer is slow.
    h.state.session = false;
    const slowGone = deferred();
    h.late["R GET /v1/auth/me"] = slowGone;
    browser.tab("R").open<App>(h.forPage("R"), RETURNS);
    await vi.advanceTimersByTimeAsync(50);
    // p9 signs in; a #657 tab's pending p9 sign-out becomes a new key; p9's invalidations fail.
    h.state.session = true;
    h.state.personId = "p9";
    const e = browser.tab("legacy-p9");
    e.sessionStorage.setItem(TAB_RECORD, JSON.stringify({ pending: true, personId: "p9", signOutId: "later-p9", attempts: 0, nextAt: Date.now() + 120_000 }));
    await load(e, h, 50);
    // R's old "gone" arrives: true of the cookies it looked at, not of the sign-out added since.
    h.late["R GET /v1/auth/me"] = undefined;
    slowGone.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(pendingFor(), "the older 'gone' lifted the entry standing for p9").toContain(null);
    const from = h.calls.length;
    const fresh = await load(browser.tab("fresh-p9"), h, 1000);
    expect(fresh.shown("workspace-picker"), "p9's workspaces were listed").toBe(false);
    expect(h.enteredWithCookie("fresh-p9", from)).toBe(false);
  });

  it("a malformed entry is an unknown entry whose id is its key: evidence about it cannot lift a newer malformed key", async () => {
    const h = hub();
    browser.localStorage.setItem(`${ENTRY}damaged-1`, "{damaged");
    // A reads the damaged entry as an unknown person and invalidates the cookie (p1's); the hub ends it, the answer is held.
    const confirmation = deferred();
    h.late["A POST /v1/auth/signout"] = confirmation;
    await load(browser.tab("A"), h, 100);
    expect(h.calls.some((c) => c.page === "A" && c.method === "POST" && c.path === "/v1/auth/signout"), "A sent its invalidation").toBe(true);
    // p9 signs in, and another damaged entry appears; p9's invalidations fail.
    h.state.session = true;
    h.state.personId = "p9";
    h.answer["POST /v1/auth/signout"] = 500;
    browser.localStorage.setItem(`${ENTRY}damaged-2`, "{damaged");
    h.late["A POST /v1/auth/signout"] = undefined;
    confirmation.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(entries().map((e) => e.signOutId), "evidence about the first damaged entry lifted the second").toEqual(["damaged-2"]);
    const from = h.calls.length;
    const fresh = await load(browser.tab("F"), h, 1000);
    expect(fresh.shown("workspace-picker"), "p9's workspaces were listed").toBe(false);
    expect(h.enteredWithCookie("F", from)).toBe(false);
  });

  it("an entry value that is unreadable, oversized or not of the schema is an unknown entry: no cookie enters", async () => {
    const bad = ["{not json", "null", "[]", "{}", JSON.stringify({ personId: 42 }), JSON.stringify({ personId: "p1", pad: "x".repeat(300) }),
      JSON.stringify({ personId: "x".repeat(65) })];
    for (const value of bad) {
      browser.closeAll();
      browser = new Browser();
      const h = hub();
      h.answer["POST /v1/auth/signout"] = 500;
      browser.localStorage.setItem(`${ENTRY}bad`, value);
      await noTabEnters(h, [browser.tab("A")], ["p1"]);
    }
  });

  it("a person outside the set completing a sign-in lifts every known entry, and nothing invalidates their session", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const pageC = await showing(h, "C", "p2");
    const pageD = await showing(h, "D", "p1"); // C's view of p2 is now stale: the cookie is p1's
    pageD.app.signOut();
    await vi.advanceTimersByTimeAsync(1);
    expect(pageC.app.whoIsIn(), "C shows p2: p1's sign-out is not C's identity").toBe("ws-a");
    pageC.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    expect(pendingFor()).toEqual(["p1", "p2"]);
    h.state.personId = "p3";
    const from = h.calls.length;
    const pageB = await load(browser.tab("B"), h);
    expect(pageB.shown("workspace-picker"), "p3's session was not used").toBe(true);
    expect(quarantine()).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.signouts().filter((c) => h.calls.indexOf(c) >= from), "p3's session was sent an invalidation").toEqual([]);
  });

  it("a confirmation lifts only the entries its look captured: a sign-out added meanwhile stays until its own evidence", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const pageC = await showing(h, "C", "p1");
    pageC.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    const [captured] = entries();
    // Tab A's retry looks at the cookie (p1's); the answer is slow to arrive.
    const slowLook = deferred();
    h.late["A GET /v1/auth/me"] = slowLook;
    await load(browser.tab("A"), h, 20_000);
    expect(h.calls.some((c) => c.page === "A" && c.path === "/v1/auth/me"), "A's retry is looking").toBe(true);
    // Meanwhile a tab still holding a #657 marker for p1 loads: its sign-out joins the set.
    const e = browser.tab("E");
    e.sessionStorage.setItem(TAB_RECORD, JSON.stringify({ reason: null, pending: true, attempts: 0, nextAt: 0, personId: "p1", tabKey: null,
      signOutId: `${Date.now().toString(36)}-old657` }));
    await load(e, h, 100);
    const added = entries().find((x) => x.signOutId !== captured.signOutId)!;
    expect(added.personId).toBe("p1");
    // A's look arrives, and its invalidation is confirmed.
    h.answer["POST /v1/auth/signout"] = undefined;
    h.late["A GET /v1/auth/me"] = undefined;
    slowLook.resolve();
    h.late["A GET /v1/auth/me"] = deferred(); // A's NEXT look (the evidence about the added entry) stays out
    for (let waited = 0; h.state.session && waited < 10_000; waited += 10) await vi.advanceTimersByTimeAsync(10);
    expect(h.state.session, "A's invalidation was never sent").toBe(false);
    expect(entries().map((x) => x.signOutId), "A's confirmation lifted a sign-out its look never saw").toEqual([added.signOutId]);
  });

  it("each entry lifts on its own evidence: p1's confirmed sign-out leaves p2 pending", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const pageC = await showing(h, "C", "p2");
    const pageD = await showing(h, "D", "p1");
    pageD.app.signOut();
    await vi.advanceTimersByTimeAsync(1);
    pageC.app.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    const p2 = entries().find((e) => e.personId === "p2")!;
    // The cookie is still p1's, and the hub now answers: a retry invalidates it.
    h.answer["POST /v1/auth/signout"] = undefined;
    await load(browser.tab("A"), h, 0);
    for (let waited = 0; h.state.session && waited < 60_000; waited += 100) await vi.advanceTimersByTimeAsync(100);
    expect(h.state.session, "the retry never confirmed p1's sign-out").toBe(false);
    expect(entries().map((e) => [e.personId, e.signOutId]), "p1's confirmation lifted p2's entry").toEqual([["p2", p2.signOutId]]);
    // p2's entry lifts on its own evidence: the next look finds the browser's cookie is no session (401).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quarantine()).toBeNull();
  });
});

// Codex-OpenCadre-049a on #659 at 0306228c (P1): the quarantine was one JSON value, read, modified and written back,
// and two tabs (two processes) can interleave between a read and a write: the later write dropped the other tab's
// sign-out. Now each pending sign-out is its own write-once key, removed only by evidence naming it, and backoff and
// lease live on their own keys. These tests run another tab's step INSIDE a storage write, before it lands.
describe("tabs writing at the same moment never lose a pending sign-out", () => {
  const QUARANTINE_KEYS = "opencadre.signOutQuarantine";
  /** Runs `during` inside the first matching storage call, before that call lands; returns a restore that says whether
   * it ran. */
  function inside(op: "setItem" | "removeItem", match: (key: string) => boolean, during: () => void) {
    const store = browser.localStorage as unknown as Record<string, (key: string, value?: string) => void>;
    const actual = store[op].bind(browser.localStorage);
    let ran = false;
    const spy = vi.spyOn(store, op).mockImplementation((key: string, value?: string) => {
      if (!ran && match(key)) { ran = true; during(); }
      return actual(key, value);
    });
    return () => { spy.mockRestore(); return ran; };
  }
  async function twoPages() {
    const h = hub();
    h.state.session = false;
    const pageA = await load(browser.tab("A"), h, 100);
    const pageB = await load(browser.tab("B"), h, 100);
    return { h, pageA, pageB };
  }

  // Codex's executable reproduction (B:\ai-work\temp\049a-pr659-review\interleaved-writes-repro.test-snippet.ts): its
  // write matcher is widened from the old single key to every quarantine key; otherwise as written.
  it("Codex's reproduction: interleaved tab writes cannot drop either pending sign-out", async () => {
    const h = hub();
    h.state.personId = "p2";
    const pageB = await inWorkspaceA(browser.tab("B"), h);
    h.state.personId = "p1";
    const pageA = await inWorkspaceA(browser.tab("A"), h);
    h.answer["POST /v1/auth/signout"] = 500;
    // Two browser processes can interleave between a Storage getItem and setItem.
    // A has computed its set from the old value. B commits before A's write lands.
    const actualSet = browser.localStorage.setItem.bind(browser.localStorage);
    let interleaved = false;
    const writer = vi.spyOn(browser.localStorage, "setItem").mockImplementation((key, value) => {
      if (key.startsWith(QUARANTINE_KEYS) && !interleaved) {
        interleaved = true;
        pageB.app.signOut();
      }
      actualSet(key, value);
    });
    pageA.app.signOut();
    writer.mockRestore();
    expect(interleaved).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    h.state.personId = "p2";
    const fresh = await load(browser.tab("fresh-p2"), h, 100);
    expect(fresh.shown("workspace-picker"), "A's stale storage write discarded B's p2 barrier and allowed the unconfirmed cookie to list workspaces").toBe(false);
    expect(pendingFor(), "both failed sign-outs must stay pending").toEqual(["p1", "p2"]);
  });

  it("an add and another entry's lift, interleaved: the lift holds and the add lands", async () => {
    const { pageA, pageB } = await twoPages();
    const [x] = seedEntries(["p1"]);
    const restore = inside("setItem", (k) => k.startsWith(QUARANTINE_KEYS), () => pageB.app.q.lift([x.signOutId]));
    pageA.app.q.add({ personId: "p2" });
    expect(restore(), "the interleaving ran").toBe(true);
    expect(pendingFor()).toEqual(["p2"]);
  });

  it("a lift and a backoff of the same entry, interleaved inside the lift: the entry stays lifted", async () => {
    const { pageA, pageB } = await twoPages();
    const [x] = seedEntries(["p1"]);
    const restore = inside("removeItem", (k) => k.startsWith(QUARANTINE_KEYS), () => pageB.app.q.backOff([x.signOutId]));
    pageA.app.q.lift([x.signOutId]);
    expect(restore(), "the interleaving ran").toBe(true);
    expect(entries(), "a backoff brought a lifted entry back").toEqual([]);
  });

  it("a backoff and a lift of the same entry, interleaved inside the backoff write: the entry stays lifted", async () => {
    const { pageA, pageB } = await twoPages();
    const [x] = seedEntries(["p1"]);
    const restore = inside("setItem", (k) => k.startsWith(QUARANTINE_KEYS), () => pageA.app.q.lift([x.signOutId]));
    pageB.app.q.backOff([x.signOutId]);
    expect(restore(), "the interleaving ran").toBe(true);
    expect(entries(), "a backoff brought a lifted entry back").toEqual([]);
    pageA.app.q.read();
    expect(browser.localStorage.entries().filter(([k]) => k.startsWith(QUARANTINE_KEYS) && !k.endsWith(".lease")), "an orphaned backoff key stayed").toEqual([]);
  });

  it("a backoff and an add, interleaved inside the backoff write: both entries stay", async () => {
    const { pageA, pageB } = await twoPages();
    const [x] = seedEntries(["p1"]);
    const restore = inside("setItem", (k) => k.startsWith(QUARANTINE_KEYS), () => pageA.app.q.add({ personId: "p2" }));
    pageB.app.q.backOff([x.signOutId]);
    expect(restore(), "the interleaving ran").toBe(true);
    expect(pendingFor()).toEqual(["p1", "p2"]);
  });

  it("a key removed while a tab lists the entries never hides another pending entry", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const [p1] = seedEntries(["p1", "p2"]);
    h.state.personId = "p2";
    // While tab F walks the keys, another tab lifts p1's entry right after F has listed it: the indexes shift.
    const actualKey = browser.localStorage.key.bind(browser.localStorage);
    let removed = false;
    const walker = vi.spyOn(browser.localStorage, "key").mockImplementation((i) => {
      const key = actualKey(i);
      if (!removed && key === `${ENTRY}${p1.signOutId}`) { removed = true; browser.localStorage.removeItem(key); }
      return key;
    });
    const from = h.calls.length;
    const fresh = await load(browser.tab("F"), h, 1000);
    walker.mockRestore();
    expect(removed, "the removal ran during the walk").toBe(true);
    expect(fresh.shown("workspace-picker"), "p2's pending sign-out was missed and p2's workspaces were listed").toBe(false);
    expect(h.enteredWithCookie("F", from)).toBe(false);
    expect(pendingFor()).toEqual(["p2"]);
  });
});

// Codex-OpenCadre-049a on #659 at 7afd79f4 (P1 and P2): its executable probes (B:\ai-work\temp\049a-pr659-review\
// review-7afd79f4-race-probes.test-snippet.ts), kept as written apart from their titles.
describe("an unstable listing and an effective overflow fail closed", () => {
  it("Codex's reproduction: unstable enumeration must not classify a captured matching cookie as replaced", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const seeded = seedEntries([...Array.from({ length: 8 }, (_, i) => `other-${i}`), "p1"], Date.now() + 120_000);
    const target = seeded.at(-1)!;
    const heldLook = deferred();
    h.late["A GET /v1/auth/me"] = heldLook;
    const a = browser.tab("A");
    const page = a.open<App>(h.forPage("A"), RETURNS);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.calls.some((c) => c.page === "A" && c.path === "/v1/auth/me")).toBe(true);
    const actualKey = browser.localStorage.key.bind(browser.localStorage);
    let removed = 0;
    const walker = vi.spyOn(browser.localStorage, "key").mockImplementation((i) => {
      const key = actualKey(i);
      // At the key immediately preceding p1 in each pass, another page's already-confirmed lift removes
      // the first other entry (and its backoff). p1 shifts backwards and is missed by that pass.
      const targetIndex = browser.localStorage.entries().findIndex(([k]) => k === ENTRY + target.signOutId);
      if (removed < 8 && i === targetIndex - 1) {
        const victim = seeded[removed++];
        browser.localStorage.removeItem(ENTRY + victim.signOutId);
        browser.localStorage.removeItem(BACKOFF + victim.signOutId);
      }
      return key;
    });
    h.late["A GET /v1/auth/me"] = undefined;
    heldLook.resolve();
    await vi.advanceTimersByTimeAsync(50);
    walker.mockRestore();
    expect(removed, "eight concurrent removals exercised the retry cap").toBe(8);
    expect(page.shown("workspace-picker"), "an incomplete enumeration classified p1 as replaced and lifted its captured entry").toBe(false);
    expect(browser.localStorage.getItem(ENTRY + target.signOutId), "p1 has no gone or confirmed evidence").not.toBeNull();
  });

  it("Codex's reproduction: concurrent additions crossing the parsing bound reset a cookie matched by the resulting unknown entry", async () => {
    const h = hub();
    h.state.personId = "p17";
    const pageB = await inWorkspaceA(browser.tab("B"), h);
    h.state.personId = "p16";
    const pageA = await inWorkspaceA(browser.tab("A"), h);
    h.state.personId = "p99";
    const pageC = await inWorkspaceA(browser.tab("C"), h);
    seedEntries(Array.from({ length: 15 }, (_, i) => `other-${i}`), Date.now() + 120_000);
    h.answer["POST /v1/auth/signout"] = 500;
    const actualSet = browser.localStorage.setItem.bind(browser.localStorage);
    let interleaved = false;
    const writer = vi.spyOn(browser.localStorage, "setItem").mockImplementation((key, value) => {
      if (key.startsWith(ENTRY) && !interleaved) { interleaved = true; pageB.app.signOut(); }
      actualSet(key, value);
    });
    pageA.app.signOut();
    writer.mockRestore();
    await vi.advanceTimersByTimeAsync(50);
    expect(interleaved).toBe(true);
    expect(entries()).toHaveLength(17);
    const observed = pageC.app.q.read() as { entries: Entry[] };
    expect(observed.entries.some((e) => e.personId === null), "the seventeenth entry is unknown for every cookie").toBe(true);
    expect(pageC.shown("console"), "C remains in a cookie workspace while the effective quarantine matches every cookie").toBe(false);
    expect(privateOnScreen(pageC)).toEqual([]);
  });

  /** Another tab's storage churn while this page walks the keys: a new unrelated key appears at the start of every
   * pass, so no two passes agree and every listing is incomplete, until stopped. */
  function churn() {
    const actualKey = browser.localStorage.key.bind(browser.localStorage);
    let on = true;
    let n = 0;
    const spy = vi.spyOn(browser.localStorage, "key").mockImplementation((i) => {
      if (on && i === 0) browser.localStorage.setItem(`other-app.churn-${n++}`, "x");
      return actualKey(i);
    });
    return { stop: () => { on = false; spy.mockRestore(); }, passes: () => n };
  }

  it("a listing left incomplete keeps the barrier: an entry hidden by churn is not read as 'nothing pending'", async () => {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    // Tab F loads with nothing pending; its look at the cookie (p1's) is slow to come back.
    const slowMe = deferred();
    h.late["F GET /v1/auth/me"] = slowMe;
    const f = browser.tab("F");
    const pageF = f.open<App>(h.forPage("F"), RETURNS);
    await vi.advanceTimersByTimeAsync(20);
    // Meanwhile nine sign-outs become pending, p1's last; another tab's confirmed lifts then remove one earlier entry in
    // each pass of F's next listing, so p1 is never listed by it.
    const seeded = seedEntries([...Array.from({ length: 8 }, (_, i) => `other-${i}`), "p1"], Date.now() + 120_000);
    const target = seeded.at(-1)!;
    const actualKey = browser.localStorage.key.bind(browser.localStorage);
    let removed = 0;
    const walker = vi.spyOn(browser.localStorage, "key").mockImplementation((i) => {
      const key = actualKey(i);
      const targetIndex = browser.localStorage.entries().findIndex(([k]) => k === ENTRY + target.signOutId);
      if (removed < 8 && i === targetIndex - 1) {
        const victim = seeded[removed++];
        browser.localStorage.removeItem(ENTRY + victim.signOutId);
        browser.localStorage.removeItem(BACKOFF + victim.signOutId);
      }
      return key;
    });
    h.late["F GET /v1/auth/me"] = undefined;
    slowMe.resolve();
    await vi.advanceTimersByTimeAsync(50);
    walker.mockRestore();
    expect(removed, "the removals ran through a whole listing").toBe(8);
    expect(pageF.shown("workspace-picker"), "an incomplete listing was read as nothing pending, and p1's workspaces were listed").toBe(false);
    expect(pendingFor()).toEqual(["p1"]);
  });

  it("the retry under a listing that stays incomplete: bounded, sends nothing, and proceeds once storage settles", async () => {
    const h = hub();
    seedEntries(["p1"]);
    const c = churn();
    const from = h.calls.length;
    await load(browser.tab("A"), h, 20_000);
    const during = h.calls.slice(from).filter((x) => x.page === "A");
    expect(c.passes(), "the listings were churned").toBeGreaterThan(8);
    expect(during.filter((x) => x.method === "POST"), "an invalidation was sent on an incomplete listing").toEqual([]);
    // Boot's look, then at most one attempt per 2 s floor (the incomplete listing is always due; the floor holds).
    expect(during.filter((x) => x.path === "/v1/auth/me").length, "the retry spun").toBeLessThanOrEqual(2 + 20_000 / 2000);
    expect(pendingFor()).toEqual(["p1"]);
    // Storage settles: the next complete listing proceeds normally. The hub now confirms: p1's entry lifts.
    c.stop();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.signouts("A").length, "the retry never proceeded").toBeGreaterThan(0);
    expect(quarantine()).toBeNull();
  });
});

describe("the retry is shared: open tabs do not multiply the invalidation", () => {
  /** Sign-out calls made over `ms` by `tabs` tabs open on the sign-in page of a quarantined browser, with the hub failing. */
  async function signoutsOver(tabs: number, ms: number) {
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    h.state.latency = 500; // an attempt takes time, as over a network: long enough for another tab's timer to fire
    seedEntries(["p1"]);
    const opened: Tab[] = [];
    for (let i = 0; i < tabs; i++) {
      const tab = browser.tab(`T${i}`);
      tab.open<App>(h.forPage(tab.name), RETURNS);
      opened.push(tab);
    }
    await vi.advanceTimersByTimeAsync(ms);
    return { h, tabs: opened };
  }

  it("three tabs send no more than one tab would, on the same shared backoff", async () => {
    const TEN_MINUTES = 600_000;
    const one = (await signoutsOver(1, TEN_MINUTES)).h.signouts().length;
    browser.closeAll();
    browser = new Browser();
    const { h } = await signoutsOver(3, TEN_MINUTES);
    const calls = h.signouts();
    expect(one, "the single tab kept retrying").toBeGreaterThan(5);
    expect(calls.length, `three tabs sent ${calls.length}, one tab ${one}`).toBeLessThanOrEqual(one + 1);
    // And never two at once: consecutive calls are at least the base backoff apart.
    for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at, `calls ${i - 1} and ${i}`).toBeGreaterThanOrEqual(2000);
  });

  it("when the tab holding the lease closes, another takes over", async () => {
    const { h, tabs } = await signoutsOver(2, 30_000);
    const owner = h.signouts().at(-1)!.page;
    expect(h.signouts().every((c) => c.page === owner), "only the lease holder sends").toBe(true);
    const other = tabs.find((t) => t.name !== owner)!;
    expect(h.signouts(other.name)).toEqual([]);
    tabs.find((t) => t.name === owner)!.close();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.signouts(other.name).length, "nobody took over the retry").toBeGreaterThan(0);
  });
});
