// @vitest-environment happy-dom
// Codex-OpenCadre-049a on #657 at 07f31da5: three more ways the previous workspace, or the previous person, outlived a
// change of identity. (1) The phone-notification approval card (#focused-approval-overlay), open or still loading, stayed
// up over the next workspace and over the sign-in page. (2) A request of the old identity answering late painted into
// the new one: a rotated or newly created agent key in Add a computer's snippets, a connect command, with a tab switch.
// (3) Drafts typed into the old workspace (a task, an invite, a typed organization key) stayed in their fields.
// Now api() never settles an answer (or a failure) for an identity that has gone, every console field goes back to its
// markup default, the overlay closes, and signing out reloads the page to the bare sign-in address once the session
// cookie is invalidated, bounded so a failing or hanging hub still signs out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => { let r!: () => void; const promise = new Promise<void>((res) => { r = res; }); return { promise, resolve: r }; };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

const A_APPROVAL = "A-PRIVATE-APPROVAL deploy to prod";
const A_KEY = "agt_A_PRIVATE_ROTATED_KEY_5f1c";
const A_NEW_KEY = "agt_A_PRIVATE_NEW_AGENT_KEY_77e2";
const A_CODE = "ocd_A_PRIVATE_CONNECT_CODE";
const A_MARKERS = ["A-PRIVATE", "agt_A_PRIVATE", "ocd_A_PRIVATE", "Grace-from-A"];

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

type Call = { path: string; method: string; ws: string; credentials?: string };

/** Workspaces A and B for one person (or B only for "bob"). `hold["<METHOD> <path>"]` keeps that request pending until
 * released; `answer["<METHOD> <path>"]` overrides its status. The path is matched without its query, so "GET /v1/tasks"
 * names every read of the task board (one per column since tasks tranche 2). */
function hub() {
  const state = { who: "ada" };
  const hold: Record<string, Deferred | undefined> = {};
  const answer: Record<string, number | undefined> = {};
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (path: string, init?: { method?: string; headers?: Record<string, string>; credentials?: string }) => {
    const method = init?.method ?? "GET";
    const ws = init?.headers?.["X-OpenCadre-Workspace"] ?? "none";
    calls.push({ path, method, ws, credentials: init?.credentials });
    const key = `${method} ${path.split("?")[0]}`;
    if (hold[key]) await hold[key]!.promise;
    if (answer[key]) return json(answer[key]!, { error: `refused near ${A_KEY}` });
    if (path === "/v1/auth/me") {
      return state.who === "ada"
        ? json(200, { person: { id: "p1", name: "Ada", email: "ada@example.com" }, workspaces: [
          { orgId: "ws-a", name: "Alpha", role: "owner" }, { orgId: "ws-b", name: "Beta", role: "owner" }] })
        : json(200, { person: { id: "p2", name: "Bob", email: "bob@example.com" }, workspaces: [{ orgId: "ws-b", name: "Beta", role: "owner" }] });
    }
    if (path === "/v1/auth/signout") return json(200, { ok: true });
    if (path === "/v1/auth/config") return json(200, { enabled: true, methods: {}, signup: "closed" });
    if (method === "POST" && path.endsWith("/rotate-key")) return json(200, { agentId: "ag-a", agentName: "Grace-from-A", apiKey: A_KEY, ownKey: false });
    if (method === "POST" && path === "/v1/org/agents") return json(200, { agentName: "Grace-from-A", apiKey: A_NEW_KEY });
    if (method === "POST" && path === "/v1/org/devices") {
      return json(201, { deviceId: "dev-a", code: A_CODE, name: "A-PRIVATE-PC", expiresAt: new Date(Date.now() + 900_000).toISOString(), command: `npx opencadre connect --code ${A_CODE}` });
    }
    if (method !== "GET") return json(200, {});
    const a = ws === "ws-a";
    if (path === "/v1/me") return json(200, { orgId: ws, orgName: ws, agentId: `me-${ws}`, agentName: "Ada", role: "operator", workspace: { paused: false } });
    if (path === "/v1/agents") return json(200, { agents: [] });
    if (path === "/v1/approvals/ap-a") {
      return json(200, { approval: { id: "ap-a", status: "pending", category: "shell", action: A_APPROVAL, details: A_APPROVAL, risk: "high",
        requested_by_agent_id: "ag-a", requested_by_agent_name: "Grace-from-A", created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString() } });
    }
    if (path.startsWith("/v1/approvals")) return json(200, { approvals: [] });
    if (path === "/v1/approval-grants") return json(200, { grants: [] });
    if (path.split("?")[0] === "/v1/tasks") return json(200, { tasks: a ? [] : [] });
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
  enterWorkspace: (orgId: string) => Promise<void>;
  signOut: (message?: string) => void;
  showFocusedApproval: (id: string) => Promise<void>;
  rotateKey: (agent: { id: string; name: string }) => Promise<void>;
  activeTab: () => string;
};

let replace: ReturnType<typeof vi.fn>;
/** app.js with its own `location`, whose replace() is recorded instead of navigating. */
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
    `${appJs}; return { enterWorkspace, signOut, showFocusedApproval, rotateKey, activeTab: () => activeTab };`,
  )(window, document, window.localStorage, fetchMock, location) as Console;
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  window.localStorage.clear();
  window.sessionStorage.clear();
  history.replaceState(null, "", "/app/");
  replace = vi.fn();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("confirm", () => true);
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function inA() {
  const h = hub();
  const c = loadConsole(h.fetchMock);
  await vi.advanceTimersByTimeAsync(0);
  await c.enterWorkspace("ws-a");
  await vi.advanceTimersByTimeAsync(300);
  return { ...h, c };
}

const overlay = () => document.getElementById("focused-approval-overlay")!;
function expectNothingOfA(when: string) {
  const page = document.body.textContent ?? "";
  for (const marker of A_MARKERS) expect(page, `${when}: the page still shows ${marker}`).not.toContain(marker);
  expect(overlay().hidden, `${when}: the approval card is still up`).toBe(true);
  expect(document.getElementById("toast")!.hidden, `${when}: a toast is up`).toBe(true);
}

/** A switch to B, or a sign-out (optionally followed by Bob signing in to B). */
const CHANGES = {
  "a switch to B": async (c: Console) => { await c.enterWorkspace("ws-b"); await vi.advanceTimersByTimeAsync(300); },
  "a sign-out": async (c: Console) => { c.signOut(); await vi.advanceTimersByTimeAsync(10); },
} as const;

describe("the approval card from a phone notification", () => {
  for (const [change, run] of Object.entries(CHANGES)) {
    it(`already open, then ${change}: closed and emptied`, async () => {
      const { c } = await inA();
      await c.showFocusedApproval("ap-a");
      expect(overlay().hidden).toBe(false);
      expect(overlay().textContent).toContain(A_APPROVAL);
      await run(c);
      expectNothingOfA(`after ${change}`);
      expect(overlay().childElementCount).toBe(0);
    });

    it(`still loading, answering after ${change}: never shown`, async () => {
      const { c, hold } = await inA();
      hold["GET /v1/approvals/ap-a"] = deferred();
      void c.showFocusedApproval("ap-a");
      await vi.advanceTimersByTimeAsync(10);
      expect(overlay().hidden).toBe(false); // "Loading…"
      await run(c);
      hold["GET /v1/approvals/ap-a"]!.resolve();
      await vi.advanceTimersByTimeAsync(300);
      expectNothingOfA(`after the late answer, ${change}`);
    });
  }
});

describe("a request of the old workspace answering after a switch paints nothing and changes no tab", () => {
  const started = {
    "rotate key": { key: "POST /v1/org/agents/ag-a/rotate-key", start: (c: Console) => { void c.rotateKey({ id: "ag-a", name: "Grace-from-A" }); } },
    "create agent": { key: "POST /v1/org/agents", start: () => {
      (document.getElementById("agent-name") as HTMLInputElement).value = "Grace-from-A";
      (document.getElementById("agent-form") as HTMLFormElement).requestSubmit();
    } },
    "add a computer": { key: "POST /v1/org/devices", start: () => {
      (document.getElementById("computer-name") as HTMLInputElement).value = "A-PRIVATE-PC";
      (document.getElementById("add-computer-form") as HTMLFormElement).requestSubmit();
    } },
    "first-run command": { key: "POST /v1/org/devices", start: () => { document.getElementById("first-run-get-command")!.click(); } },
  } as const;
  for (const [action, { key, start }] of Object.entries(started)) {
    for (const outcome of ["succeeds", "fails"] as const) {
      it(`${action} ${outcome} late`, async () => {
        const { c, hold, answer } = await inA();
        hold[key] = deferred();
        if (outcome === "fails") answer[key] = 500;
        start(c);
        await vi.advanceTimersByTimeAsync(10);
        await c.enterWorkspace("ws-b");
        await vi.advanceTimersByTimeAsync(300);
        const tab = c.activeTab();
        hold[key]!.resolve();
        await vi.advanceTimersByTimeAsync(300);
        expectNothingOfA(`${action} answering late`);
        expect(document.getElementById("snippets")!.childElementCount, "a key's snippets are on screen").toBe(0);
        expect(document.getElementById("connect-output")!.hidden).toBe(true);
        expect(document.getElementById("computer-output")!.hidden).toBe(true);
        expect(document.getElementById("first-run-cmd")!.hidden).toBe(true);
        for (const id of ["agent-error", "computer-error"]) expect(document.getElementById(id)!.hidden, `#${id} shows A's failure`).toBe(true);
        expect(c.activeTab(), "the late answer changed the tab").toBe(tab);
        expect((document.getElementById("btn-add-computer") as HTMLButtonElement).disabled, "Add a computer is left disabled").toBe(false);
      });
    }
  }
});

const DRAFTS: Record<string, string> = {
  "task-title": "A-PRIVATE task title", "task-description": "A-PRIVATE task description", "invite-email-input": "a-private@example.com",
  "agent-name": "A-PRIVATE-agent", "computer-name": "A-PRIVATE-PC", "org-key": "org_A_PRIVATE", "project-add-key": "github.com/a/private",
  "policy-add-project": "github.com/a/private", "webhook-url": "https://a-private.example/hook", "webhook-auth": "Bearer A-PRIVATE", "task-search": "A-PRIVATE",
};
function typeDrafts() {
  for (const [id, value] of Object.entries(DRAFTS)) {
    const input = document.getElementById(id) as HTMLInputElement;
    input.value = value;
    // A typed draft must exercise the app's input listener, including webhookEdited.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  (document.getElementById("task-reviews") as HTMLSelectElement).value = "3";
}

describe("drafts typed into the old workspace", () => {
  it("are gone after a switch (their .value, not the page text)", async () => {
    const { c } = await inA();
    typeDrafts();
    await c.enterWorkspace("ws-b");
    for (const id of Object.keys(DRAFTS)) expect((document.getElementById(id) as HTMLInputElement).value, `#${id}`).toBe("");
    expect((document.getElementById("task-reviews") as HTMLSelectElement).value).toBe("1");
  });

  it("are gone after sign-out, and stay gone when someone else signs in", async () => {
    const { c, state } = await inA();
    typeDrafts();
    c.signOut();
    for (const id of Object.keys(DRAFTS)) expect((document.getElementById(id) as HTMLInputElement).value, `signed out: #${id}`).toBe("");
    state.who = "bob";
    await c.enterWorkspace("ws-b");
    await vi.advanceTimersByTimeAsync(300);
    for (const id of Object.keys(DRAFTS)) expect((document.getElementById(id) as HTMLInputElement).value, `Bob: #${id}`).toBe("");
  });

  it("are kept through a failed refresh in the same workspace", async () => {
    const { answer } = await inA();
    typeDrafts();
    answer["GET /v1/tasks"] = 500;
    await vi.advanceTimersByTimeAsync(4000);
    expect(document.getElementById("refresh-notice")!.textContent).toMatch(/^Couldn't refresh/);
    for (const [id, value] of Object.entries(DRAFTS)) expect((document.getElementById(id) as HTMLInputElement).value, `#${id}`).toBe(value);
  });
});

describe("an unedited webhook field", () => {
  it("accepts newer server hydration after programmatic initialization while another source fails", async () => {
    const { fetchMock, answer } = await inA();
    const original = fetchMock.getMockImplementation()!;
    const input = document.getElementById("webhook-url") as HTMLInputElement;
    input.value = "https://programmatic.example/initial"; // no user input event
    fetchMock.mockImplementation(async (path, init) => {
      const response = await original(path, init);
      if (path !== "/v1/me") return response;
      return json(200, { ...await response.json(), webhook_url: "https://server.example/current" });
    });
    answer["GET /v1/tasks"] = 500;
    await vi.advanceTimersByTimeAsync(4000);
    expect(document.getElementById("refresh-notice")!.textContent).toMatch(/^Couldn't refresh/);
    expect(input.value).toBe("https://server.example/current");
  });
});

describe("signing out reloads to the bare sign-in page once the session cookie is invalidated", () => {
  // This tab's record (sessionStorage) and the browser's quarantine (localStorage), as the console reads them.
  const signedOut = () => {
    const tab = JSON.parse(window.sessionStorage.getItem("opencadre.signedOut") ?? "null");
    const pending = Object.keys(window.localStorage).some((k) => k.startsWith("opencadre.signOutQuarantine.v1.entry."));
    return { reason: tab?.reason ?? null, pending };
  };

  it("clears the page at once, invalidates the captured session, then reloads to /app/", async () => {
    const { c, hold, calls } = await inA();
    await c.showFocusedApproval("ap-a");
    history.replaceState(null, "", "/app/?workspace=ws-a#approval-ap-a");
    hold["POST /v1/auth/signout"] = deferred();
    c.signOut();
    // Synchronously, before any cleanup is awaited: the sign-in page, nothing of A.
    expect(document.getElementById("signin")!.hidden).toBe(false);
    expect(document.getElementById("console")!.hidden).toBe(true);
    expectNothingOfA("the moment sign-out was asked for");
    await vi.advanceTimersByTimeAsync(100);
    const signout = calls.find((call) => call.path === "/v1/auth/signout")!;
    expect(signout).toMatchObject({ method: "POST", ws: "ws-a", credentials: "same-origin" });
    expect(replace, "reloaded before the cookie was invalidated").not.toHaveBeenCalled();
    hold["POST /v1/auth/signout"]!.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/app/"); // no workspace, approval or key carried
    expect(signedOut()).toMatchObject({ reason: null, pending: false });
  });

  it("a failing invalidation still signs out, and the next boot sends it again", async () => {
    const { c, answer } = await inA();
    answer["POST /v1/auth/signout"] = 500;
    c.signOut();
    await vi.advanceTimersByTimeAsync(10);
    expect(replace).toHaveBeenCalledWith("/app/");
    expect(signedOut()).toMatchObject({ reason: null, pending: true });
  });

  it("a hanging invalidation is bounded: the page reloads after 5 s, with nothing private shown meanwhile", async () => {
    const { c, hold } = await inA();
    await c.showFocusedApproval("ap-a");
    hold["POST /v1/auth/signout"] = deferred(); // never answers
    c.signOut();
    await vi.advanceTimersByTimeAsync(4900);
    expect(replace).not.toHaveBeenCalled();
    expectNothingOfA("while the invalidation hangs");
    expect(document.getElementById("signin")!.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(replace).toHaveBeenCalledWith("/app/");
    expect(signedOut()).toMatchObject({ reason: null, pending: true });
  });

  it("the boot after it neither signs the old cookie back in nor loses the reason, and resends a pending invalidation", async () => {
    // A #657 marker, as production 69c4ef00 writes it (sessionStorage, with a pending field): it joins the shared set.
    window.sessionStorage.setItem("opencadre.signedOut", JSON.stringify({ reason: "key-rejected", pending: true, attempts: 0, nextAt: 0, personId: "p1", tabKey: null, signOutId: "m0-657" }));
    const h = hub();
    loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(10);
    // It may LOOK at the cookie (/v1/auth/me) to see whose it is; it never enters with it (/v1/me).
    expect(h.calls.some((call) => call.path === "/v1/me"), "boot signed the old cookie back in").toBe(false);
    expect(document.getElementById("console")!.hidden).toBe(true);
    expect(h.calls.some((call) => call.path === "/v1/auth/signout" && call.method === "POST")).toBe(true);
    expect(document.getElementById("signin")!.hidden).toBe(false);
    expect(document.getElementById("signin-error")!.textContent).toBe("Your key was rejected. Sign in again.");
    expect(window.sessionStorage.getItem("opencadre.signedOut")).toBeNull();
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith("opencadre.signOutQuarantine.v1.entry."))).toEqual([]);
  });

  it("a saved key the hub rejects at boot signs out without a reload, so it cannot loop", async () => {
    window.localStorage.setItem("opencadre.agentKey", "agt_saved_but_revoked");
    const h = hub();
    h.answer["GET /v1/auth/me"] = 401;
    h.answer["GET /v1/me"] = 401;
    loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(6000);
    expect(replace).not.toHaveBeenCalled();
    expect(document.getElementById("signin")!.hidden).toBe(false);
    expect(document.getElementById("signin-error")!.textContent).toBe("Your saved key was rejected. Sign in again.");
  });

  it("a sign-in still in flight when someone signs out never signs them back in", async () => {
    const h = hub();
    const c = loadConsole(h.fetchMock);
    await vi.advanceTimersByTimeAsync(0);
    h.hold["GET /v1/auth/me"] = deferred();
    const entering = c.enterWorkspace("ws-a");
    await vi.advanceTimersByTimeAsync(10);
    c.signOut();
    h.hold["GET /v1/auth/me"]!.resolve();
    void entering; // superseded: it never settles, so nothing after its await runs
    await vi.advanceTimersByTimeAsync(300);
    expect(document.getElementById("console")!.hidden).toBe(true);
    expect(document.getElementById("signin")!.hidden).toBe(false);
    expect(h.calls.some((call) => call.path === "/v1/me" && call.ws === "ws-a")).toBe(false);
  });
});
