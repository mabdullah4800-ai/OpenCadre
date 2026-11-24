// @vitest-environment happy-dom
// Codex-OpenCadre-049a on #657 at e1e4568b: three ways the identity transitions themselves lost ownership.
// (1) A phone notification's deep link (/app/?workspace=A#approval-…) never opened: boot parked it in a global that the
//     workspace entry's own reset then cleared. It is now handed to the entry that owns it and consumed there.
// (2) A superseded transition's FAILURE still acted: the saved-key boot's late 401 signed out a newer manual login.
//     Transition calls are now owned by their ticket, so a superseded answer or failure (and its 401/423 handling) never
//     settles.
// (3) A pending sign-out was forgotten on the next load, so the old, still valid cookie was signed straight back in.
//     The marker now stays until the hub confirms the invalidation, retried with a capped backoff across reloads, and
//     never auto-enters while pending. A deliberate sign-in always wins: it settles or drops the marker first, and an
//     older cleanup or retry can neither navigate away from it nor rewrite the marker under it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => { let r!: () => void; const promise = new Promise<void>((res) => { r = res; }); return { promise, resolve: r }; };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() { this.readyState = 3; }
}

type Call = { path: string; method: string; ws: string; auth: string };

/** `session` says whether the cookie is still a live session. /v1/me answers per bearer key (agt_old is the saved one,
 * agt_new the one typed now) or per workspace header. `hold[key]` and `answer[key]` (key = "<METHOD> <path>", or
 * "<METHOD> <path> <bearer>") hold a request or override its status. */
function hub() {
  const state = { session: true, personId: "p1" };
  const hold: Record<string, Deferred | undefined> = {};
  const answer: Record<string, number | undefined> = {};
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (path: string, init?: { method?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? "GET";
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "none";
    const auth = (init?.headers?.authorization ?? "").replace("Bearer ", "");
    calls.push({ path, method, ws, auth });
    for (const key of [`${method} ${path} ${auth}`, `${method} ${path}`]) {
      if (hold[key]) await hold[key]!.promise;
      if (answer[key]) return json(answer[key]!, { error: answer[key] === 423 ? "This workspace is paused." : "nope" });
    }
    if (path === "/v1/auth/me") {
      if (!state.session) return json(401, { error: "no session" });
      return json(200, { person: { id: state.personId, name: "Ada", email: "ada@example.com" }, workspaces: [
        { orgId: "ws-a", name: "Alpha", role: "owner" }, { orgId: "ws-b", name: "Beta", role: "owner" }] });
    }
    if (path === "/v1/auth/config") return json(200, { enabled: true, methods: {}, signup: "closed" });
    if (path === "/v1/auth/signout") { state.session = false; return json(200, { ok: true }); }
    if (method !== "GET") return json(200, {});
    if (path === "/v1/me") {
      const org = auth ? `key-${auth}` : ws;
      return json(200, { orgId: org, orgName: org, agentId: `me-${org}`, agentName: "Ada", role: "operator", workspace: { paused: false } });
    }
    if (path === "/v1/approvals/ap-a") {
      return json(200, { approval: { id: "ap-a", status: "pending", category: "shell", action: "A-PRIVATE-APPROVAL deploy", details: "",
        risk: "high", requested_by_agent_id: "ag-a", requested_by_agent_name: "Grace-from-A", created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString() } });
    }
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
    if (path === "/v1/onboarding") return json(200, { completed: 1, total: 1, steps: [] });
    return json(200, {});
  });
  return { fetchMock, state, hold, answer, calls };
}

type Console = {
  enterWorkspace: (orgId: string, opts?: { approvalId?: string }) => Promise<void>;
  signIn: (key: string) => Promise<void>;
  signOut: (message?: string) => void;
  whoIsIn: () => string | null;
};

let replace: ReturnType<typeof vi.fn>;
function loadConsole(fetchMock: ReturnType<typeof hub>["fetchMock"]): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const location = new Proxy(window.location, {
    get(target, key) {
      if (key === "replace") return replace;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Function("window", "document", "localStorage", "fetch", "location",
    `${appJs}; return { enterWorkspace, signIn, signOut, whoIsIn: () => me?.orgId ?? null };`,
  )(window, document, window.localStorage, fetchMock, location) as Console;
}

/** A fresh page load in the same tab: new DOM and a fresh app.js, the same sessionStorage and localStorage. */
function freshPage() {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
}

beforeEach(() => {
  freshPage();
  window.localStorage.clear();
  window.sessionStorage.clear();
  history.replaceState(null, "", "/app/");
  replace = vi.fn();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const shown = (id: string) => !document.getElementById(id)!.hidden;
const overlay = () => document.getElementById("focused-approval-overlay")!;
/** The sign-out marker as the console reads it: this tab's record (sessionStorage) and the browser's quarantine
 * (localStorage, schema v1: a write-once key per pending sign-out), flattened to its first entry for single-sign-out tests. */
const QUARANTINE_ENTRY = "opencadre.signOutQuarantine.v1.entry.";
const QUARANTINE_BACKOFF = "opencadre.signOutQuarantine.v1.backoff.";
const marker = () => {
  const tab = JSON.parse(window.sessionStorage.getItem("opencadre.signedOut") ?? "null");
  const entries = Object.keys(window.localStorage).filter((k) => k.startsWith(QUARANTINE_ENTRY)).sort().map((k) => {
    const signOutId = k.slice(QUARANTINE_ENTRY.length);
    const backoff = JSON.parse(window.localStorage.getItem(QUARANTINE_BACKOFF + signOutId) ?? "{}");
    return { personId: JSON.parse(window.localStorage.getItem(k)!).personId ?? null, signOutId, attempts: backoff.attempts ?? 0, nextAt: backoff.nextAt ?? 0 };
  });
  return tab || entries.length ? { ...(tab ?? {}), ...(entries[0] ?? {}), entries, pending: entries.length > 0 } : null;
};
/** A pending sign-out written straight to storage, as a tab long gone left it. */
const seedEntry = (personId: string, signOutId: string, attempts = 0, nextAt = 0) => {
  window.localStorage.setItem(QUARANTINE_ENTRY + signOutId, JSON.stringify({ personId }));
  if (attempts || nextAt) window.localStorage.setItem(QUARANTINE_BACKOFF + signOutId, JSON.stringify({ attempts, nextAt }));
};
const signInWithKey = (key: string) => {
  (document.getElementById("signin-key") as HTMLInputElement).value = key;
  (document.getElementById("signin-key-form") as HTMLFormElement).requestSubmit();
};

describe("a phone notification's deep link", () => {
  it("a real boot of /app/?workspace=A#approval-… with a live session opens that approval", async () => {
    history.replaceState(null, "", "/app/?workspace=ws-a#approval-ap-a");
    const h = hub();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(300);
    expect(c.whoIsIn()).toBe("ws-a");
    expect(overlay().hidden).toBe(false);
    expect(overlay().textContent).toContain("A-PRIVATE-APPROVAL deploy");
  });

  it("is never carried into another workspace entered before it lands", async () => {
    history.replaceState(null, "", "/app/?workspace=ws-a#approval-ap-a");
    const h = hub();
    h.hold["GET /v1/me"] = deferred(); // boot's entry into A is still out
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(50);
    const holdA = h.hold["GET /v1/me"]!;
    h.hold["GET /v1/me"] = undefined;
    void c.enterWorkspace("ws-b");
    await vi.advanceTimersByTimeAsync(50);
    holdA.resolve();
    await vi.advanceTimersByTimeAsync(300);
    expect(c.whoIsIn()).toBe("ws-b");
    expect(overlay().hidden).toBe(true);
    expect(h.calls.some((call) => call.path === "/v1/approvals/ap-a")).toBe(false);
  });
});

describe("a superseded transition's failure never acts on a newer identity", () => {
  it("the saved-key boot's late 401 does not sign out a manual sign-in made after it", async () => {
    window.localStorage.setItem("opencadre.agentKey", "agt_old");
    const h = hub();
    h.state.session = false;
    h.hold["GET /v1/me agt_old"] = deferred();
    h.answer["GET /v1/me agt_old"] = 401;
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(50); // boot is now waiting on agt_old
    await c.signIn("agt_new");
    await vi.advanceTimersByTimeAsync(300);
    expect(c.whoIsIn()).toBe("key-agt_new");
    h.hold["GET /v1/me agt_old"]!.resolve();
    await vi.advanceTimersByTimeAsync(300);
    expect(c.whoIsIn(), "the old key's 401 signed the new login out").toBe("key-agt_new");
    expect(shown("console")).toBe(true);
    expect(window.localStorage.getItem("opencadre.agentKey")).toBe("agt_new");
    expect(shown("signin-error")).toBe(false);
  });

  it("an older sign-in's late 423 shows no paused banner over the newer one", async () => {
    const h = hub();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(50);
    h.hold["GET /v1/me agt_old"] = deferred();
    h.answer["GET /v1/me agt_old"] = 423;
    const old = c.signIn("agt_old");
    let oldSettled = false;
    old.then(() => { oldSettled = true; }, () => { oldSettled = true; });
    await vi.advanceTimersByTimeAsync(10);
    await c.signIn("agt_new");
    h.hold["GET /v1/me agt_old"]!.resolve();
    await vi.advanceTimersByTimeAsync(300);
    expect(c.whoIsIn()).toBe("key-agt_new");
    expect(shown("paused-banner")).toBe(false);
    expect(oldSettled, "the superseded sign-in settled, so its caller's error handling ran").toBe(false);
  });

  it("a workspace entry whose first call fails after a newer sign-in neither rejects nor signs out", async () => {
    const h = hub();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(50);
    h.hold["GET /v1/auth/me"] = deferred();
    h.answer["GET /v1/auth/me"] = 401;
    let rejected = false;
    c.enterWorkspace("ws-a").catch(() => { rejected = true; });
    await vi.advanceTimersByTimeAsync(10);
    await c.signIn("agt_new");
    h.hold["GET /v1/auth/me"]!.resolve();
    await vi.advanceTimersByTimeAsync(300);
    expect(rejected, "the superseded entry's failure reached its caller").toBe(false);
    expect(c.whoIsIn()).toBe("key-agt_new");
    expect(shown("console")).toBe(true);
  });
});

describe("the old cookie stays quarantined until the hub confirms it gone, or a different person's session replaces it", () => {
  const seedPending = () => seedEntry("p1", "m0-seeded");
  // Looking at the cookie (/v1/auth/me) is allowed; entering with it (/v1/me for a workspace) is not.
  const enteredWithCookie = (h: ReturnType<typeof hub>) => h.calls.some((call) => call.path === "/v1/me" && call.ws !== "none");
  /** A reload of this tab: a fresh page and app.js, the same sessionStorage and localStorage. */
  async function reload(h: ReturnType<typeof hub>, ms = 10_000) {
    freshPage();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(ms);
    return c;
  }

  for (const failure of ["fails", "hangs"] as const) {
    it(`an invalidation that ${failure} on every try: no load of the tab ever signs the old cookie back in`, async () => {
      seedPending();
      const h = hub(); // the cookie stays the old person's live session throughout
      if (failure === "fails") h.answer["POST /v1/auth/signout"] = 500;
      else h.hold["POST /v1/auth/signout"] = deferred(); // never answers
      let lastNextAt = 0;
      for (let load = 1; load <= 4; load++) {
        const c = await reload(h, 70_000);
        expect(enteredWithCookie(h), `load ${load} signed the old cookie back in`).toBe(false);
        expect(c.whoIsIn(), `load ${load}`).toBeNull();
        expect(shown("signin"), `load ${load}`).toBe(true);
        expect(marker()?.pending, `load ${load} forgot the pending sign-out`).toBe(true);
        if (failure === "fails") {
          expect(marker().nextAt).toBeGreaterThanOrEqual(lastNextAt);
          expect(marker().nextAt - Date.now(), "the backoff is capped").toBeLessThanOrEqual(60_000);
          lastNextAt = marker().nextAt;
        }
      }
      expect(h.calls.filter((call) => call.path === "/v1/auth/signout").length, "it kept retrying").toBeGreaterThan(3);
    });
  }

  it("a key login the hub rejects (401) lifts nothing: a reload still does not enter with the cookie", async () => {
    seedPending();
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    h.answer["GET /v1/me agt_wrong"] = 401;
    await reload(h, 100);
    signInWithKey("agt_wrong");
    await vi.advanceTimersByTimeAsync(3000);
    expect(shown("signin-key-error")).toBe(true);
    expect(marker()?.pending).toBe(true);
    const c = await reload(h);
    expect(enteredWithCookie(h)).toBe(false);
    expect(c.whoIsIn()).toBeNull();
  });

  for (const send of ["is sent", "fails"] as const) {
    it(`an emailed link that ${send === "is sent" ? "was requested but not used" : "failed to send"} lifts nothing: a reload still does not enter`, async () => {
      seedPending();
      const h = hub();
      h.answer["POST /v1/auth/signout"] = 500;
      if (send === "fails") h.answer["POST /v1/auth/email"] = 500;
      await reload(h, 100);
      (document.getElementById("signin-email") as HTMLInputElement).value = "someone@example.com";
      (document.getElementById("signin-email-form") as HTMLFormElement).requestSubmit();
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.calls.some((call) => call.path === "/v1/auth/email"), "the request itself stays possible").toBe(true);
      expect(marker()?.pending).toBe(true);
      const c = await reload(h);
      expect(enteredWithCookie(h)).toBe(false);
      expect(c.whoIsIn()).toBeNull();
    });
  }

  it("a key login that lands keeps the quarantine: the key works, and a reload uses the key, never the cookie", async () => {
    seedPending();
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    let c = await reload(h, 100);
    signInWithKey("agt_new");
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.whoIsIn()).toBe("key-agt_new");
    expect(marker()?.pending, "a key login lifted the quarantine").toBe(true);
    expect(marker().tabKey, "the marker must not hold the key itself").not.toContain("agt_new");
    c = await reload(h);
    expect(c.whoIsIn(), "this tab's own key signs in again").toBe("key-agt_new");
    expect(enteredWithCookie(h)).toBe(false);
    expect(marker()?.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.whoIsIn(), "a retry acted on the key login").toBe("key-agt_new");
    expect(replace).not.toHaveBeenCalled();
  });

  it("a key another tab saved is not used while quarantined", async () => {
    seedPending();
    window.localStorage.setItem("opencadre.agentKey", "agt_other_tab");
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const c = await reload(h, 5000);
    expect(c.whoIsIn()).toBeNull();
    expect(shown("signin")).toBe(true);
    expect(marker()?.pending).toBe(true);
  });

  it("an emailed link or OAuth completing as a DIFFERENT person lifts it, and that person's session is used", async () => {
    seedPending();
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    h.state.personId = "p2";
    await reload(h, 300);
    expect(marker()).toBeNull();
    expect(shown("workspace-picker"), "the new person's session was not used").toBe(true); // two workspaces: the picker
    expect(h.calls.some((call) => call.path === "/v1/auth/signout"), "the new person's session was sent an invalidation").toBe(false);
  });

  it("the SAME person's session coming back does not lift it", async () => {
    seedPending();
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const c = await reload(h, 300);
    expect(marker()?.pending).toBe(true);
    expect(c.whoIsIn()).toBeNull();
    expect(enteredWithCookie(h)).toBe(false);
  });

  for (const confirmation of [200, 401] as const) {
    it(`a confirmed invalidation (${confirmation === 200 ? "2xx" : "401, already gone"}) clears it`, async () => {
      seedPending();
      const h = hub();
      if (confirmation === 401) h.answer["POST /v1/auth/signout"] = 401;
      await reload(h, 300);
      expect(marker()).toBeNull();
    });
  }

  it("signing out from the workspace picker invalidates the cookie too", async () => {
    const h = hub();
    loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(300); // two workspaces: boot shows the picker
    expect(shown("workspace-picker")).toBe(true);
    document.getElementById("workspace-picker-signout")!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.calls.some((call) => call.path === "/v1/auth/signout" && call.method === "POST")).toBe(true);
    expect(replace).toHaveBeenCalledWith("/app/");
  });

  it("a newer login started while the old sign-out removes its push device: the old cleanup sends no invalidation", async () => {
    vi.stubGlobal("navigator", { ...window.navigator, serviceWorker: { getRegistration: async () => ({
      pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/sub" }) } }) } });
    const h = hub();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(50);
    await c.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(300);
    const pushRemoval = deferred();
    h.hold["DELETE /v1/push/devices"] = pushRemoval;
    c.signOut();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls.some((call) => call.method === "DELETE" && call.path === "/v1/push/devices"), "the push removal is out").toBe(true);
    signInWithKey("agt_new");
    await vi.advanceTimersByTimeAsync(100);
    expect(c.whoIsIn()).toBe("key-agt_new");
    pushRemoval.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls.some((call) => call.method === "POST" && call.path === "/v1/auth/signout" && call.ws === "ws-a"),
      "the old cleanup dispatched its invalidation after a newer login").toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(c.whoIsIn()).toBe("key-agt_new");
    // The old cookie is not forgotten: it was quarantined, and a retry that looked at it first (still Ada's) ended it.
    const retry = h.calls.findIndex((call) => call.method === "POST" && call.path === "/v1/auth/signout");
    expect(retry, "the quarantined cookie was never invalidated").toBeGreaterThan(-1);
    expect(h.calls.slice(0, retry).some((call) => call.path === "/v1/auth/me"), "the retry sent it without looking first").toBe(true);
    expect(marker()).toBeNull();
  });

  it("a sign-out cleanup finishing after a newer sign-in never navigates away from it", async () => {
    const h = hub();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(50);
    await c.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(300);
    const cleanup = deferred();
    h.hold["POST /v1/auth/signout"] = cleanup;
    c.signOut();
    await vi.advanceTimersByTimeAsync(100);
    signInWithKey("agt_new");
    await vi.advanceTimersByTimeAsync(2500);
    expect(c.whoIsIn()).toBe("key-agt_new");
    cleanup.resolve();
    await vi.advanceTimersByTimeAsync(10_000); // past the cleanup's own 5 s bound too
    expect(replace, "the old sign-out reloaded the page over the new login").not.toHaveBeenCalled();
    expect(c.whoIsIn()).toBe("key-agt_new");
  });
});

// Codex-OpenCadre-049a on #657 at 4b72a9b9: a key-mode sign-out wrote a fresh pending:false marker over a still pending
// quarantine (outgoing.session was false, so "invalidated" was true), and the next load entered the old cookie. Every
// marker write now goes through writeSignedOut, which refuses to downgrade a pending quarantine without a proof.
describe("a key-mode sign-out never lifts the old cookie's quarantine", () => {
  const seedPending = () => seedEntry("p1", "m0-seeded", 2);
  const enteredWithCookie = (h: ReturnType<typeof hub>) => h.calls.some((call) => call.path === "/v1/me" && call.ws !== "none");
  async function reload(h: ReturnType<typeof hub>, ms = 10_000) {
    freshPage();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(ms);
    return c;
  }
  async function keySignOut(c: Console) {
    c.signOut();
    await vi.advanceTimersByTimeAsync(6000);
    expect(replace).toHaveBeenCalledWith("/app/");
    replace.mockClear();
  }

  it("key sign-in, key sign-out, reload: the cookie is still not entered, and the quarantine is intact", async () => {
    seedPending();
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const c = await reload(h, 100);
    signInWithKey("agt_a");
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.whoIsIn()).toBe("key-agt_a");
    await keySignOut(c);
    expect(marker()).toMatchObject({ pending: true, personId: "p1", tabKey: null });
    expect(marker().attempts).toBeGreaterThanOrEqual(2);
    const again = await reload(h);
    expect(enteredWithCookie(h)).toBe(false);
    expect(again.whoIsIn()).toBeNull();
    expect(shown("signin")).toBe(true);
  });

  it("key sign-in, an attempt to open a workspace with the cookie, sign-out, reload: the cookie is never entered", async () => {
    seedPending();
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    const c = await reload(h, 100);
    signInWithKey("agt_a");
    await vi.advanceTimersByTimeAsync(3000);
    let refused = false;
    await c.enterWorkspace("ws-a").catch(() => { refused = true; });
    expect(refused, "a workspace was opened with the quarantined cookie").toBe(true);
    expect(enteredWithCookie(h)).toBe(false);
    await keySignOut(c);
    const again = await reload(h);
    expect(enteredWithCookie(h)).toBe(false);
    expect(again.whoIsIn()).toBeNull();
    expect(marker()?.pending).toBe(true);
  });

  it("key A, sign-out, key B, sign-out, reload: no cookie entry, and B's fingerprint is gone", async () => {
    seedPending();
    const h = hub();
    h.answer["POST /v1/auth/signout"] = 500;
    let c = await reload(h, 100);
    signInWithKey("agt_a");
    await vi.advanceTimersByTimeAsync(3000);
    await keySignOut(c);
    c = await reload(h, 100);
    signInWithKey("agt_b");
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.whoIsIn()).toBe("key-agt_b");
    await vi.advanceTimersByTimeAsync(10);
    expect(marker().tabKey, "B's fingerprint was recorded").toEqual(expect.any(String));
    await keySignOut(c);
    expect(marker()).toMatchObject({ pending: true, personId: "p1", tabKey: null });
    window.localStorage.setItem("opencadre.agentKey", "agt_b"); // even if B's key were still saved somewhere
    const again = await reload(h);
    expect(enteredWithCookie(h)).toBe(false);
    expect(again.whoIsIn(), "a signed-out key was reused").toBeNull();
  });
});

// The shared quarantine is one write-once key per pending sign-out (Codex-OpenCadre-049a on #659 at 0306228c): entries
// are only added (under a fresh id) or removed by the exact ids evidence was taken about, never rewritten, evicted or
// skipped, and an entry that cannot be read fails closed as an unknown person, whose id is its key.
describe("the shared quarantine keys", () => {
  const ENTRY = "opencadre.signOutQuarantine.v1.entry.";
  const BACKOFF = "opencadre.signOutQuarantine.v1.backoff.";
  type Q = { entries: Array<{ personId: string | null; signOutId: string; attempts: number; nextAt: number }> } | null;
  type Api = {
    add: (e: { personId: string | null; attempts?: number; nextAt?: number }) => string;
    lift: (ids: string[]) => void;
    replaced: (captured: string[], personId: string | null) => boolean;
    backOff: (ids: string[]) => void;
    read: () => Q;
    signedOut: () => unknown;
  };
  const setApi = (storage: unknown = window.localStorage) => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    return new Function("window", "document", "localStorage", "fetch", "location",
      `${appJs}; return { add: addQuarantineEntry, lift: liftQuarantine, replaced: liftIfReplaced, backOff, read: readQuarantine, signedOut: readSignedOut };`,
    )(window, document, storage, hub().fetchMock, window.location) as Api;
  };
  const people = (q: Q) => (q?.entries ?? []).map((e) => e.personId);
  const ids = (q: Q) => (q?.entries ?? []).map((e) => e.signOutId);
  const keys = () => Object.keys(window.localStorage).filter((k) => k.startsWith("opencadre.signOutQuarantine")).sort();

  it("each sign-out is its own key under a fresh id, the same person's included; the value is the person only", () => {
    const m = setApi();
    const a = m.add({ personId: "p1" });
    const b = m.add({ personId: "p1" });
    const c = m.add({ personId: "p2" });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(keys()).toEqual([a, b, c].map((id) => ENTRY + id).sort());
    expect(JSON.parse(window.localStorage.getItem(ENTRY + a)!)).toEqual({ personId: "p1" });
  });

  it("a lift removes exactly the keys named, never an entry added since", () => {
    const m = setApi();
    const a = m.add({ personId: "p1" });
    const captured = [a];
    const b = m.add({ personId: "p1" });
    m.lift(captured);
    expect(ids(m.read())).toEqual([b]);
    m.lift(["nope"]);
    expect(ids(m.read())).toEqual([b]);
    m.lift([b]);
    expect(m.read()).toBeNull();
    expect(keys()).toEqual([]);
  });

  it("'replaced' needs a known person matching no pending entry, and lifts only what it captured", () => {
    const m = setApi();
    const a = m.add({ personId: "p1" });
    expect(m.replaced([a], "p1"), "the quarantined person's own cookie").toBe(false);
    expect(m.replaced([a], null), "a cookie the hub names no one for").toBe(false);
    const b = m.add({ personId: "p2" }); // added after the look was captured
    expect(m.replaced([a], "p9")).toBe(true);
    expect(people(m.read())).toEqual(["p2"]);
    const u = m.add({ personId: null });
    expect(m.replaced([b, u], "p9"), "an unknown entry matches every cookie").toBe(false);
    expect(people(m.read()).sort()).toEqual(["p2", null].sort());
  });

  it("past the parsing bound, sign-outs are written and read as unknown: nothing evicted, nothing skipped", () => {
    const m = setApi();
    const added = Array.from({ length: 20 }, (_, i) => m.add({ personId: `p${i + 1}` }));
    const q = m.read()!;
    expect(q.entries).toHaveLength(20);
    // Whichever sixteen sort first are parsed; the rest, and every sign-out added past the bound, are unknown.
    expect(people(q).filter((p) => p !== null).length).toBeLessThanOrEqual(16);
    for (const id of added.slice(0, 16)) expect(JSON.parse(window.localStorage.getItem(ENTRY + id)!).personId).toEqual(expect.any(String));
    for (const id of added.slice(16)) expect(JSON.parse(window.localStorage.getItem(ENTRY + id)!), "written as unknown").toEqual({ personId: null });
  });

  it("a malformed or oversized entry is an unknown person whose id is its key, the same on every read and in every tab", () => {
    const m = setApi();
    window.localStorage.setItem(`${ENTRY}broken`, "{");
    window.localStorage.setItem(`${ENTRY}huge`, JSON.stringify({ personId: "p1", pad: "x".repeat(300) }));
    expect(m.read()!.entries).toEqual([
      { personId: null, signOutId: "broken", attempts: 0, nextAt: 0 },
      { personId: null, signOutId: "huge", attempts: 0, nextAt: 0 },
    ]);
    expect(ids(setApi().read())).toEqual(["broken", "huge"]);
    m.lift(["broken"]);
    expect(ids(m.read())).toEqual(["huge"]);
  });

  it("listing the entries survives another tab removing a key mid-walk: no pending entry is missed", () => {
    seedEntry("p1", "a-first");
    seedEntry("p2", "b-second");
    // This page's view of the shared storage: another tab lifts p1's entry right after this walk has listed it.
    const shared = window.localStorage;
    let removed = false;
    let walking = false;
    const view = {
      get length() { return shared.length; },
      key(i: number) {
        const key = shared.key(i);
        if (walking && !removed && key === `${ENTRY}a-first`) { removed = true; shared.removeItem(key); }
        return key;
      },
      getItem: (k: string) => shared.getItem(k),
      setItem: (k: string, v: string) => shared.setItem(k, v),
      removeItem: (k: string) => shared.removeItem(k),
    };
    const m = setApi(view);
    walking = true;
    expect(people(m.read()), "p2's entry was skipped when the indexes shifted").toEqual(["p2"]);
    expect(removed, "the removal ran during the walk").toBe(true);
  });

  it("membership in a listing never decides a 'replaced' lift: each captured key is read directly", () => {
    seedEntry("p1", "same-person");
    window.localStorage.setItem(`${ENTRY}unknown-person`, "{damaged");
    seedEntry("p2", "other-person");
    // A view whose listing (consistent across passes, so "complete") never shows the first two keys; reads still work.
    const shared = window.localStorage;
    const hidden = new Set([`${ENTRY}same-person`, `${ENTRY}unknown-person`]);
    const listed = () => Object.keys(shared).filter((k) => !hidden.has(k));
    const view = {
      get length() { return listed().length; },
      key: (i: number) => listed()[i] ?? null,
      getItem: (k: string) => shared.getItem(k),
      setItem: (k: string, v: string) => shared.setItem(k, v),
      removeItem: (k: string) => shared.removeItem(k),
    };
    const m = setApi(view);
    expect(m.replaced(["same-person", "unknown-person", "other-person"], "p1"), "p1 matches nothing the listing shows").toBe(true);
    expect(shared.getItem(`${ENTRY}same-person`), "the cookie's own person's entry was lifted as replaced").not.toBeNull();
    expect(shared.getItem(`${ENTRY}unknown-person`), "an unknown entry was lifted as replaced").not.toBeNull();
    expect(shared.getItem(`${ENTRY}other-person`), "another person's entry, proved replaced, stayed").toBeNull();
  });

  it("a backoff never recreates a lifted entry, and an orphaned backoff key is removed", () => {
    const m = setApi();
    const a = m.add({ personId: "p1" });
    m.backOff([a]);
    expect(JSON.parse(window.localStorage.getItem(BACKOFF + a)!).attempts).toBe(1);
    m.lift([a]);
    m.backOff([a]);
    expect(keys().filter((k) => !k.endsWith(".lease"))).toEqual([]);
    window.localStorage.setItem(BACKOFF + a, JSON.stringify({ attempts: 3, nextAt: 0 })); // as a racing write would leave it
    expect(m.read()).toBeNull();
    expect(window.localStorage.getItem(BACKOFF + a), "the orphan stayed").toBeNull();
  });

  it("a #657 marker becomes an entry under a fresh id, never its own, and is reduced in the same step", () => {
    window.sessionStorage.setItem("opencadre.signedOut", JSON.stringify({ reason: "key-rejected", pending: true, attempts: 2, nextAt: 0,
      personId: "p1", tabKey: "a".repeat(64), signOutId: "legacy-x" }));
    const m = setApi(); // loading the page reads the marker
    const q = m.read()!;
    expect(people(q)).toEqual(["p1"]);
    expect(ids(q)).not.toContain("legacy-x");
    expect(q.entries[0].attempts).toBe(2);
    expect(JSON.parse(window.sessionStorage.getItem("opencadre.signedOut")!), "the old marker was left in place").toEqual({ reason: null, tabKey: "a".repeat(64) });
    m.lift(["legacy-x"]);
    expect(people(m.read()), "evidence naming the marker's old id lifted the migrated entry").toEqual(["p1"]);
  });

  it("only the schema's fields are ever stored", () => {
    const m = setApi();
    const id = m.add({ personId: "p1", key: "agt_secret", email: "ada@example.com" } as never);
    expect(Object.keys(JSON.parse(window.localStorage.getItem(ENTRY + id)!))).toEqual(["personId"]);
    expect(JSON.stringify({ ...window.localStorage })).not.toMatch(/agt_secret|ada@example/);
  });
});

// Codex-OpenCadre-049a on #657 at f90db206: signOut wrote its quarantine only when its cleanup finished (or at the 5 s
// cap), so a reload before then found no marker and entered the old, still valid cookie. The quarantine is now written
// in the same synchronous step as the page reset. Each case reloads BEFORE the cap, with the invalidation never answering.
describe("a reload before the sign-out's cleanup finishes still finds the quarantine", () => {
  const enteredWithCookieAfter = (h: ReturnType<typeof hub>, from: number) =>
    h.calls.slice(from).some((call) => call.path === "/v1/me" && call.ws !== "none");
  async function signedInWithCookie() {
    const h = hub();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(50);
    await c.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(300);
    h.hold["POST /v1/auth/signout"] = deferred(); // the cleanup's invalidation never answers
    return { h, c };
  }
  async function reloadNow(h: ReturnType<typeof hub>) {
    const from = h.calls.length;
    freshPage();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(1000); // still well inside the old page's 5 s cap
    expect(enteredWithCookieAfter(h, from), "the reload entered the old cookie").toBe(false);
    expect(c.whoIsIn()).toBeNull();
    expect(shown("signin")).toBe(true);
    expect(marker()).toMatchObject({ pending: true, personId: "p1" });
  }

  it("reloading immediately after the sign-out click", async () => {
    const { h, c } = await signedInWithCookie();
    c.signOut();
    expect(marker(), "the quarantine was not on disk when signOut returned").toMatchObject({ pending: true, personId: "p1" });
    await reloadNow(h);
  });

  it("reloading while the push device is still being removed", async () => {
    vi.stubGlobal("navigator", { ...window.navigator, serviceWorker: { getRegistration: async () => ({
      pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/sub" }) } }) } });
    const { h, c } = await signedInWithCookie();
    h.hold["DELETE /v1/push/devices"] = deferred();
    c.signOut();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls.some((call) => call.method === "DELETE" && call.path === "/v1/push/devices")).toBe(true);
    await reloadNow(h);
  });

  it("reloading while the signout call is still out", async () => {
    const { h, c } = await signedInWithCookie();
    c.signOut();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls.some((call) => call.method === "POST" && call.path === "/v1/auth/signout")).toBe(true);
    await reloadNow(h);
  });

  it("a confirmation that arrives lifts only the quarantine this sign-out wrote", async () => {
    const { h, c } = await signedInWithCookie();
    const answer = h.hold["POST /v1/auth/signout"]!;
    c.signOut();
    await vi.advanceTimersByTimeAsync(10);
    // Meanwhile another sign-out is pending too (a different person's, from a tab with a stale view).
    seedEntry("p9", "someone-else");
    answer.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(marker()).toMatchObject({ pending: true, personId: "p9", signOutId: "someone-else" });
  });
});
