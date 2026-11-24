// @vitest-environment happy-dom
// The page half of the one-window notification click (public/app/sw.js posts { type: "opencadre:open", url } to the
// console window it focused). app.js routes it through the console's existing deep-link path: showFocusedApproval for
// the workspace on screen, enterWorkspace(ws, { approvalId }) for another one the signed-in person belongs to, and
// nothing at all (beyond the acknowledgement) when nobody is signed in, the page is in the sign-out quarantine, or the
// message is not what the worker sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Console = {
  showPage: (name: string) => void;
  enterWorkspace: (orgId: string, opts?: { approvalId?: string | null }) => Promise<void>;
  leaveSignedOutElsewhere: () => void;
  refreshNow: () => Promise<void>;
  setState: (s: { me?: unknown; person?: unknown; authMode?: string; currentWorkspace?: string | null }) => void;
  state: () => { me: unknown; currentWorkspace: string | null; authMode: string };
};

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const pageShown = () => ["signin", "workspace-picker", "invite-accept", "console"].filter((id) => !$(id).hidden);

const approval = (id = "appr_9") => ({
  id, org_id: "org_2", action: `rm -rf ./dist-${id}`, risk: "high", category: "rm-rf", details: null,
  requested_by_agent_id: "other-agent", requested_by_agent_name: "Claude-Coder", status: "pending",
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString(),
});

const WORKSPACES = [{ orgId: "org_1", name: "One", role: "owner" }, { orgId: "org_2", name: "Two", role: "member" }, { orgId: "org_3", name: "Three", role: "member" }];

type Call = { path: string; workspace: string | null };
/** The hub as the console sees it: a person who belongs to org_1 and org_2. */
function hub(calls: Call[], holds: Record<string, () => Promise<void> | undefined> = {}) {
  return vi.fn(async (path: string, opts?: { headers?: Record<string, string> }) => {
    calls.push({ path, workspace: opts?.headers?.["X-OpenCadre-Workspace"] ?? null });
    // A request the test holds open until it says so: an answer that arrives late.
    await holds[path]?.();
    if (path === "/v1/auth/me") return json(200, { person: { id: "p1", name: "P", email: "p@x.example" }, workspaces: WORKSPACES });
    if (path === "/v1/me") return json(200, { agentId: "a", agentName: "P", role: "owner", orgId: opts?.headers?.["X-OpenCadre-Workspace"] ?? "org_1", orgName: "Org", billing: null });
    if (path.startsWith("/v1/approvals?")) return json(200, { approvals: [] });
    if (path === "/v1/onboarding") return json(200, { completed: 1, total: 1, steps: [] });
    if (path.startsWith("/v1/approvals/")) return json(200, { approval: approval(decodeURIComponent(path.split("/").pop()!)) });
    return json(200, {});
  });
}

let onMessage: ((event: unknown) => void) | undefined;

// A console a test loads kept running after that test: a completed entry schedules app.js's 4 s poll, which then painted
// into the SHARED document of whatever test ran next (an earlier test's empty /v1/agents read as "0 of 0 agents online":
// the intermittent failure seen in full-suite runs on 2026-10-06). So each test's consoles are retired when it ends:
//   - dispose() clears the console's own named timers and intervals and closes its live socket, so nothing new starts;
//   - and its network is fenced: once retired, NOTHING it started settles any more, neither a fetch that fulfils or
//     REJECTS after retirement, nor a response body (json()/text()) still being read (review of #725: a late rejection
//     repainted "Couldn't refresh", and a late body let an old refresh complete and clear the next page's notice). That
//     is the way api() treats an ended generation, applied to the whole instance.
// Not covered: the anonymous 150 ms skeleton timer (app.js:484), which paints no fetched data and cannot be cleared from
// outside. The test's own responses while it runs are untouched (fetchMock is still the one called, its records unchanged).
const consoleLives: { on: boolean; dispose?: () => void }[] = [];
/** Retires every console loaded so far: what afterEach does, callable mid-test by the regression controls below. */
function retireConsoles() {
  for (const life of consoleLives.splice(0)) {
    life.on = false;
    life.dispose?.();
  }
}
afterEach(retireConsoles);

async function loadConsole(fetchMock: ReturnType<typeof vi.fn>): Promise<Console> {
  const life: { on: boolean; dispose?: () => void } = { on: true };
  consoleLives.push(life);
  const never = () => new Promise<never>(() => {});
  // Settles exactly as `p` does while this console lives; after retirement, never (fulfilment AND rejection).
  const fence = <T,>(p: Promise<T>): Promise<T> =>
    p.then((v) => (life.on ? v : never()), (e) => (life.on ? Promise.reject(e) : never()));
  // A response whose promise-returning members (json(), text(), ...) are fenced the same way.
  const fenced = (r: unknown): unknown =>
    r && typeof r === "object"
      ? new Proxy(r as object, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== "function") return value;
            return (...a: unknown[]) => {
              const out = (value as (...x: unknown[]) => unknown).apply(target, a);
              return out && typeof (out as Promise<unknown>).then === "function" ? fence(out as Promise<unknown>) : out;
            };
          },
        })
      : r;
  const scoped = (...args: unknown[]) =>
    life.on ? fence(Promise.resolve().then(() => fetchMock(...args))).then(fenced) : never();
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const console_ = new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return {
      showPage, enterWorkspace, leaveSignedOutElsewhere, refreshNow,
      setState: (s) => {
        if ("me" in s) me = s.me;
        if ("person" in s) person = s.person;
        if ("authMode" in s) authMode = s.authMode;
        if ("currentWorkspace" in s) currentWorkspace = s.currentWorkspace;
      },
      state: () => ({ me, currentWorkspace, authMode }),
      // Test-only teardown of this instance's timers and socket. typeof keeps a renamed or removed name from throwing;
      // the fetch cut-off above still covers anything a name here misses.
      dispose: () => {
        for (const t of [typeof pollTimer !== "undefined" ? pollTimer : 0, typeof refreshSoonTimer !== "undefined" ? refreshSoonTimer : 0,
          typeof wsReconnectTimer !== "undefined" ? wsReconnectTimer : 0, typeof toastTimer !== "undefined" ? toastTimer : 0,
          typeof signOutRetryTimer !== "undefined" ? signOutRetryTimer : 0, typeof taskSearchTimer !== "undefined" ? taskSearchTimer : 0]) clearTimeout(t);
        for (const t of [typeof homeTick !== "undefined" ? homeTick : 0, typeof emailCooldownTimer !== "undefined" ? emailCooldownTimer : 0,
          typeof computerTimerInterval !== "undefined" ? computerTimerInterval : 0, typeof computerStatusPollInterval !== "undefined" ? computerStatusPollInterval : 0,
          typeof firstRunPoll !== "undefined" ? firstRunPoll : 0]) clearInterval(t);
        try { if (typeof liveSocket !== "undefined" && liveSocket) liveSocket.close(); } catch {}
      },
    };`,
  )(window, document, window.localStorage, scoped) as Console;
  life.dispose = (console_ as unknown as { dispose: () => void }).dispose;
  await new Promise((r) => setTimeout(r, 0)); // boot() (no session: 401) has settled on the sign-in page
  return console_;
}

const signedIn = (c: Console, workspace = "org_1") => {
  c.setState({ me: { agentId: "a", agentName: "P", role: "owner", orgId: workspace, orgName: "Org" }, person: { id: "p1", name: "P", email: "p@x.example" }, authMode: "session", currentWorkspace: workspace });
  c.showPage("console");
};

const link = (workspace: string, approvalId = "appr_9") => `${window.location.origin}/app/?workspace=${workspace}#approval-${approvalId}`;
/** What the worker posts, with the acknowledgement port it transfers. */
const message = (data: unknown) => {
  const port = { postMessage: vi.fn() };
  return { event: { data, ports: [port] }, port };
};
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/app/");
  onMessage = undefined;
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: (type: string, fn: (event: unknown) => void) => { if (type === "message") onMessage = fn; },
      getRegistration: async () => undefined,
      register: async () => undefined,
    },
  });
});

const bootFetch = () => vi.fn(async (path: string) => (path === "/v1/auth/me" ? json(401, { error: "no session" }) : json(200, {})));

describe("the console listens for the worker's open message", () => {
  it("registers a message listener on navigator.serviceWorker", async () => {
    await loadConsole(bootFetch());
    expect(typeof onMessage).toBe("function");
  });

  it("does not throw where there is no service worker", async () => {
    Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: undefined });
    await expect(loadConsole(bootFetch())).resolves.toBeDefined();
  });
});

describe("a valid open message", () => {
  it("for the workspace on screen opens that approval, with no workspace re-entry", async () => {
    const calls: Call[] = [];
    const c = await loadConsole(hub(calls));
    signedIn(c, "org_1");
    calls.length = 0;
    const { event, port } = message({ type: "opencadre:open", url: link("org_1", "appr_9") });
    onMessage!(event);
    await settle();
    expect(port.postMessage).toHaveBeenCalled(); // the worker gets its acknowledgement, so it does not navigate
    expect(calls.map((x) => x.path)).toEqual(["/v1/approvals/appr_9"]);
    expect($("focused-approval-overlay").hidden).toBe(false);
    expect($("focused-approval-overlay").textContent).toContain("rm -rf ./dist");
    expect(c.state().currentWorkspace).toBe("org_1");
  });

  it("for another workspace the person belongs to goes through enterWorkspace with the approval id", async () => {
    const calls: Call[] = [];
    const c = await loadConsole(hub(calls));
    signedIn(c, "org_1");
    calls.length = 0;
    const { event } = message({ type: "opencadre:open", url: link("org_2", "appr_7") });
    onMessage!(event);
    await settle();
    // membership looked up, the workspace entered (its own /v1/me), then the approval loaded inside org_2
    expect(calls.map((x) => x.path)).toEqual(expect.arrayContaining(["/v1/auth/me", "/v1/me", "/v1/approvals/appr_7"]));
    expect(calls.find((x) => x.path === "/v1/me")?.workspace).toBe("org_2");
    expect(calls.find((x) => x.path === "/v1/approvals/appr_7")?.workspace).toBe("org_2");
    expect(c.state().currentWorkspace).toBe("org_2");
    expect($("focused-approval-overlay").hidden).toBe(false);
  });

  it("for a workspace the person does not belong to enters nothing and opens nothing", async () => {
    const calls: Call[] = [];
    const c = await loadConsole(hub(calls));
    signedIn(c, "org_1");
    calls.length = 0;
    onMessage!(message({ type: "opencadre:open", url: link("org_other") }).event);
    await settle();
    expect(calls.map((x) => x.path)).not.toContain("/v1/me");
    expect(calls.some((x) => x.path.startsWith("/v1/approvals/"))).toBe(false);
    expect(c.state().currentWorkspace).toBe("org_1");
    expect($("focused-approval-overlay").hidden).toBe(true);
  });

  it("from the workspace picker (signed in, none entered) enters the named workspace", async () => {
    const calls: Call[] = [];
    const c = await loadConsole(hub(calls));
    c.setState({ me: null, person: { id: "p1", name: "P", email: "p@x.example" }, authMode: "key", currentWorkspace: null });
    c.showPage("workspace-picker");
    calls.length = 0;
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_3") }).event);
    await settle();
    expect(c.state().currentWorkspace).toBe("org_2");
    expect(calls.map((x) => x.path)).toContain("/v1/approvals/appr_3");
  });
});

describe("a message that must not open anything", () => {
  it("signed out: only the sign-in page, no request, no approval; the worker is still acknowledged", async () => {
    const calls: Call[] = [];
    const c = await loadConsole(hub(calls));
    c.showPage("signin");
    calls.length = 0;
    const { event, port } = message({ type: "opencadre:open", url: link("org_1") });
    onMessage!(event);
    await settle();
    expect(calls).toEqual([]);
    expect(pageShown()).toEqual(["signin"]);
    expect($("focused-approval-overlay").hidden).toBe(true);
    expect(port.postMessage).toHaveBeenCalled();
  });

  it("in the sign-out quarantine: nothing is entered even for a person the page still holds", async () => {
    const calls: Call[] = [];
    const c = await loadConsole(hub(calls));
    signedIn(c, "org_1");
    window.localStorage.setItem("opencadre.signOutQuarantine.v1.entry.pending1", JSON.stringify({ personId: "p1" }));
    calls.length = 0;
    onMessage!(message({ type: "opencadre:open", url: link("org_2") }).event);
    onMessage!(message({ type: "opencadre:open", url: link("org_1") }).event);
    await settle();
    expect(calls).toEqual([]);
    expect(c.state().currentWorkspace).toBe("org_1");
    expect($("focused-approval-overlay").hidden).toBe(true);
  });

  it("a quarantine that lands while the membership is being looked up stops the entry", async () => {
    const calls: Call[] = [];
    let release!: () => void;
    const out = new Promise<void>((r) => { release = r; });
    let held = false;
    const c = await loadConsole(hub(calls, { "/v1/auth/me": () => (held ? out : undefined) }));
    signedIn(c, "org_1");
    calls.length = 0;
    held = true;
    onMessage!(message({ type: "opencadre:open", url: link("org_2") }).event);
    await settle();
    window.localStorage.setItem("opencadre.signOutQuarantine.v1.entry.late", JSON.stringify({ personId: "p1" }));
    release();
    await settle();
    expect(calls.map((x) => x.path)).not.toContain("/v1/me");
    expect(c.state().currentWorkspace).toBe("org_1");
    expect($("focused-approval-overlay").hidden).toBe(true);
  });

  for (const [label, data] of [
    ["no data", undefined],
    ["a string", "opencadre:open"],
    ["another type", { type: "something-else", url: "/app/?workspace=org_2#approval-appr_9" }],
    ["no url", { type: "opencadre:open" }],
    ["a non-string url", { type: "opencadre:open", url: 42 }],
    ["another origin", { type: "opencadre:open", url: "https://evil.example/app/?workspace=org_2#approval-appr_9" }],
    ["a path outside /app/", { type: "opencadre:open", url: `${window.location.origin}/v1/me?workspace=org_2#approval-appr_9` }],
    ["no workspace", { type: "opencadre:open", url: `${window.location.origin}/app/#approval-appr_9` }],
    ["no approval", { type: "opencadre:open", url: `${window.location.origin}/app/?workspace=org_2` }],
    ["a workspace that is not an id", { type: "opencadre:open", url: `${window.location.origin}/app/?workspace=${encodeURIComponent("../x y")}#approval-appr_9` }],
    ["an extra query field", { type: "opencadre:open", url: `${window.location.origin}/app/?workspace=org_2&invite=tok#approval-appr_9` }],
    ["a redirect field", { type: "opencadre:open", url: `${window.location.origin}/app/?workspace=org_2&next=${encodeURIComponent("https://evil.example")}#approval-appr_9` }],
    ["two workspace fields", { type: "opencadre:open", url: `${window.location.origin}/app/?workspace=org_2&workspace=org_1#approval-appr_9` }],
    ["a route other than /app/", { type: "opencadre:open", url: `${window.location.origin}/app/settings?workspace=org_2#approval-appr_9` }],
    ["credentials in the url", { type: "opencadre:open", url: window.location.origin.replace("//", "//user:secret@") + "/app/?workspace=org_2#approval-appr_9" }],
    ["a fragment that is not an approval", { type: "opencadre:open", url: `${window.location.origin}/app/?workspace=org_2#/settings/billing` }],
    ["an approval that is not an id", { type: "opencadre:open", url: `${window.location.origin}/app/?workspace=org_2#approval-${encodeURIComponent("a/../b")}` }],
  ] as const) {
    it(`a malformed message is ignored: ${label}`, async () => {
      const calls: Call[] = [];
      const c = await loadConsole(hub(calls));
      signedIn(c, "org_1");
      calls.length = 0;
      expect(() => onMessage!({ data, ports: [] })).not.toThrow();
      await settle();
      expect(calls).toEqual([]);
      expect(c.state().currentWorkspace).toBe("org_1");
      expect($("focused-approval-overlay").hidden).toBe(true);
    });
  }
});

describe("a late answer never acts on a newer identity", () => {
  /** A request held open: `release()` lets it answer. */
  const gate = () => {
    let release!: () => void;
    const open = new Promise<void>((r) => { release = r; });
    return { hold: () => open, release };
  };

  it("a workspace switch between the message and the membership answer wins: the late answer enters nothing", async () => {
    const calls: Call[] = [];
    const lookup = gate();
    let held = false;
    const c = await loadConsole(hub(calls, { "/v1/auth/me": () => (held ? lookup.hold() : undefined) }));
    signedIn(c, "org_1");
    calls.length = 0;
    held = true;
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_9") }).event);
    await settle();
    expect(calls.map((x) => x.path)).toEqual(["/v1/auth/me"]); // the message's membership lookup, still out
    // meanwhile the person signs in somewhere else: a new identity ticket
    held = false;
    await c.enterWorkspace("org_3");
    calls.length = 0;
    lookup.release(); // the late answer, now owned by a superseded ticket
    await settle();
    // (org_3's own refresh may be calling; nothing may name org_2 or the message's approval)
    expect(calls.filter((x) => x.workspace === "org_2" || x.path.startsWith("/v1/approvals/appr_9"))).toEqual([]);
    expect(c.state().currentWorkspace).toBe("org_3");
    expect($("focused-approval-overlay").hidden).toBe(true);
  });

  it("a sign-out elsewhere between the message and the answer wins: the late answer signs nobody in", async () => {
    const calls: Call[] = [];
    const lookup = gate();
    let held = false;
    const c = await loadConsole(hub(calls, { "/v1/auth/me": () => (held ? lookup.hold() : undefined) }));
    signedIn(c, "org_1");
    held = true;
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_9") }).event);
    await settle();
    held = false;
    c.leaveSignedOutElsewhere();
    calls.length = 0;
    lookup.release();
    await settle();
    expect(calls.map((x) => x.path)).not.toContain("/v1/me");
    expect(calls.some((x) => x.path.startsWith("/v1/approvals/"))).toBe(false);
    expect(c.state().me).toBeNull();
    expect(pageShown()).toEqual(["signin"]);
  });

  it("an approval still loading for the workspace on screen never paints once another workspace is entered", async () => {
    const calls: Call[] = [];
    const answer = gate();
    let held = false;
    const c = await loadConsole(hub(calls, { "/v1/approvals/appr_9": () => (held ? answer.hold() : undefined) }));
    signedIn(c, "org_1");
    held = true;
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_9") }).event);
    await settle();
    held = false;
    await c.enterWorkspace("org_2");
    await settle();
    answer.release(); // org_1's approval, answered after the switch
    await settle();
    expect($("focused-approval-overlay").textContent).not.toContain("rm -rf ./dist");
    expect(c.state().currentWorkspace).toBe("org_2");
  });

  it("a message for the workspace being switched to, while me is still the old one, goes through a full entry", async () => {
    const calls: Call[] = [];
    const c = await loadConsole(hub(calls));
    signedIn(c, "org_1");
    c.setState({ currentWorkspace: "org_2" }); // mid-switch: currentWorkspace moved, `me` (org_1) has not yet
    calls.length = 0;
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_5") }).event);
    await settle();
    expect(calls.map((x) => x.path)).toEqual(expect.arrayContaining(["/v1/auth/me", "/v1/me", "/v1/approvals/appr_5"]));
    expect(calls.find((x) => x.path === "/v1/me")?.workspace).toBe("org_2");
  });
});

describe("overlapping notifications: the latest click wins", () => {
  /** Answers the nth call of a path after arm() late, on release(); every other call at once. Boot's own calls, before
   * arm(), are never held. */
  const lateNth = (nth: number) => {
    let seen = 0;
    let armed = false;
    let release!: () => void;
    const open = new Promise<void>((r) => { release = r; });
    return { hold: () => (armed && ++seen === nth ? open : undefined), release, arm: () => { armed = true; seen = 0; } };
  };

  it("two same-workspace approvals: the older one's load resolving last does not overwrite the newer", async () => {
    const calls: Call[] = [];
    const first = lateNth(1);
    const c = await loadConsole(hub(calls, { "/v1/approvals/appr_A": first.hold }));
    signedIn(c, "org_1");
    first.arm();
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_A") }).event);
    await settle();
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_B") }).event);
    await settle();
    expect($("focused-approval-overlay").textContent).toContain("dist-appr_B");
    first.release(); // A answers after B
    await settle();
    expect($("focused-approval-overlay").textContent).toContain("dist-appr_B");
    expect($("focused-approval-overlay").textContent).not.toContain("dist-appr_A");
  });

  it("two cross-workspace clicks (org_2, then org_1) with org_2's membership answer last: the console ends on org_1 with its approval", async () => {
    const calls: Call[] = [];
    const membership = lateNth(1);
    const c = await loadConsole(hub(calls, { "/v1/auth/me": membership.hold }));
    signedIn(c, "org_3");
    membership.arm();
    calls.length = 0;
    // the first /v1/auth/me from here on is the org_2 click's lookup: held; the org_1 click's answers at once
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_2") }).event);
    await settle();
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_1") }).event);
    await settle();
    expect(c.state().currentWorkspace).toBe("org_1");
    membership.release(); // org_2's answer arrives last
    await settle();
    expect(c.state().currentWorkspace).toBe("org_1");
    expect(calls.some((x) => x.path === "/v1/me" && x.workspace === "org_2")).toBe(false);
    expect($("focused-approval-overlay").textContent).toContain("dist-appr_1");
    expect($("focused-approval-overlay").textContent).not.toContain("dist-appr_2");
  });

  it("an older click that already left the membership lookup still cannot switch after a newer same-workspace click", async () => {
    const calls: Call[] = [];
    const entry = lateNth(2); // /v1/auth/me: 1st = the org_2 click's membership lookup, 2nd = enterWorkspace's own
    const c = await loadConsole(hub(calls, { "/v1/auth/me": entry.hold }));
    signedIn(c, "org_1");
    entry.arm();
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_2") }).event);
    await settle(); // membership answered; enterWorkspace(org_2) is waiting on its own /v1/auth/me
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_1") }).event); // org_1 is still the workspace on screen
    await settle();
    entry.release();
    await settle();
    expect(c.state().currentWorkspace).toBe("org_1");
    expect(calls.some((x) => x.path === "/v1/me" && x.workspace === "org_2")).toBe(false);
    expect($("focused-approval-overlay").textContent).toContain("dist-appr_1");
  });

  it("a superseded notification's failure shows no toast; the same failure, not superseded, does", async () => {
    const failing = async (superseded: boolean) => {
      const calls: Call[] = [];
      let n = 0;
      let armed = false;
      let release!: () => void;
      const open = new Promise<void>((r) => { release = r; });
      const inner = hub(calls, { "/v1/auth/me": () => (armed && ++n === 2 ? open : undefined) });
      // enterWorkspace's own /v1/auth/me (the 2nd) fails once released
      const fetchMock = vi.fn(async (path: string, opts?: { headers?: Record<string, string> }) => {
        const res = await inner(path, opts);
        return armed && path === "/v1/auth/me" && n === 2 ? json(500, { error: "hub unavailable" }) : res;
      });
      const c = await loadConsole(fetchMock);
      $("toast").hidden = true; // the document is shared by the two runs of this test
      signedIn(c, "org_1");
      armed = true;
      onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_2") }).event);
      await settle();
      if (superseded) {
        onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_1") }).event);
        await settle();
      }
      release();
      await settle();
      return $("toast").hidden;
    };
    expect(await failing(false)).toBe(false); // control: an unsuperseded failure is shown
    expect(await failing(true)).toBe(true);
  });
});

// Regressions from Codex's independent review of #665 (pr665-console-race-probe.ts), verbatim.
describe("review: notification completion ordering", () => {
  it("an older same-workspace approval answer cannot replace the card for the latest click", async () => {
    const calls: Call[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const baseFetch = hub(calls, { "/v1/approvals/appr_old": () => held });
    const fetchMock = vi.fn(async (path: string, opts?: { headers?: Record<string, string> }) => {
      const result = await baseFetch(path, opts);
      if (path.startsWith("/v1/approvals/")) {
        const id = path.split("/").pop()!;
        return json(200, { approval: { ...approval(id), action: `notification ${id}` } });
      }
      return result;
    });
    const c = await loadConsole(fetchMock);
    signedIn(c, "org_1");
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_old") }).event);
    await settle();
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_new") }).event);
    await settle();
    expect($("focused-approval-overlay").textContent).toContain("notification appr_new");
    release();
    await settle();
    expect($("focused-approval-overlay").textContent).toContain("notification appr_new");
    expect($("focused-approval-overlay").textContent).not.toContain("notification appr_old");
  });

  it("an older cross-workspace lookup cannot override the latest click for the workspace on screen", async () => {
    const calls: Call[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let shouldHold = false;
    const c = await loadConsole(hub(calls, { "/v1/auth/me": () => shouldHold ? held : undefined }));
    signedIn(c, "org_1");
    shouldHold = true;
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_old") }).event);
    await settle();
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_new") }).event);
    await settle();
    expect(c.state().currentWorkspace).toBe("org_1");
    shouldHold = false;
    release();
    await settle();
    await settle();
    expect(c.state().currentWorkspace).toBe("org_1");

  });
});



describe("notification ownership covers the card's own actions and an entry in progress", () => {
  const gate = () => {
    let release!: () => void;
    const open = new Promise<void>((r) => { release = r; });
    return { open, release };
  };

  it("a superseded card's decision finishing cannot close the newer notification's card", async () => {
    const calls: Call[] = [];
    const decision = gate();
    const c = await loadConsole(hub(calls, { "/v1/approvals/appr_A/decide": () => decision.open }));
    signedIn(c, "org_1");
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_A") }).event);
    await settle();
    (document.querySelector("#focused-approval-overlay .btn-halt") as HTMLElement).click(); // Deny on A: the POST is held
    await settle();
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_B") }).event);
    await settle();
    expect($("focused-approval-overlay").textContent).toContain("dist-appr_B");
    decision.release(); // A's decision lands after B replaced its card
    await settle();
    expect($("focused-approval-overlay").hidden).toBe(false);
    expect($("focused-approval-overlay").textContent).toContain("dist-appr_B");
  });

  it("a card for an approval that finishes loading after an entry into another workspace began paints nothing", async () => {
    const calls: Call[] = [];
    const load = gate();
    const entry = gate();
    let armed = false;
    const c = await loadConsole(hub(calls, {
      "/v1/approvals/appr_A": () => load.open,
      "/v1/auth/me": () => (armed ? entry.open : undefined),
    }));
    signedIn(c, "org_1");
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_A") }).event);
    await settle();
    armed = true;
    const entering = c.enterWorkspace("org_2"); // an entry starts (its /v1/auth/me is out)
    await settle();
    load.release(); // A's answer arrives while the entry is in progress
    await settle();
    expect($("focused-approval-overlay").textContent).not.toContain("dist-appr_A");
    entry.release();
    await entering.catch(() => {});
  });
});

describe("a withdrawn entry never presents its identity", () => {
  it("an older org_2 entry whose /v1/me answers after a newer org_1 notification began: the console ends on org_1, org_2 never appears", async () => {
    const calls: Call[] = [];
    const counts: Record<string, number> = {};
    const gates: Record<string, { open: Promise<void>; release: () => void }> = {};
    const gate = (key: string) => {
      let release!: () => void;
      const open = new Promise<void>((r) => { release = r; });
      return (gates[key] = { open, release });
    };
    gate("me#1"); // enterWorkspace(org_2)'s /v1/me
    gate("auth#3"); // the newer org_1 notification's membership lookup
    let armed = false;
    const hold = (path: string) => () => {
      if (!armed) return undefined;
      counts[path] = (counts[path] ?? 0) + 1;
      return gates[`${path === "/v1/me" ? "me" : "auth"}#${counts[path]}`]?.open;
    };
    const seen: string[] = [];
    const c = await loadConsole(hub(calls, { "/v1/me": hold("/v1/me"), "/v1/auth/me": hold("/v1/auth/me") }));
    signedIn(c, "org_3");
    armed = true;
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_2") }).event); // membership (auth#1), enterWorkspace (auth#2), then /v1/me (me#1) is held
    await settle();
    onMessage!(message({ type: "opencadre:open", url: link("org_1", "appr_1") }).event); // its membership lookup (auth#3) is held
    await settle();
    gates["me#1"].release(); // the old org_2 identity answers first
    await settle();
    seen.push(String((c.state().me as { orgId?: string } | null)?.orgId), $("focused-approval-overlay").textContent ?? "");
    expect(seen[0]).not.toBe("org_2");
    expect(seen[1]).not.toContain("Loading");
    expect($("focused-approval-overlay").hidden).toBe(true);
    gates["auth#3"].release();
    await settle();
    expect(c.state().currentWorkspace).toBe("org_1");
    expect($("focused-approval-overlay").textContent).toContain("dist-appr_1");
    expect(calls.some((x) => x.path === "/v1/approvals/appr_2")).toBe(false);
  });
});

// Regression from Codex's re-review of #665 at 5a18e214 (pr665-5a18-member-stale-probe.ts), verbatim.
it("review: a superseded notification entry awaiting /v1/me cannot show its withdrawn approval loading card", async () => {
  const calls: Call[] = [];
  let releaseMember!: () => void;
  let releaseLatest!: () => void;
  const member = new Promise<void>((resolve) => { releaseMember = resolve; });
  const latest = new Promise<void>((resolve) => { releaseLatest = resolve; });
  let armed = false;
  let holdLatest = false;
  const c = await loadConsole(hub(calls, {
    "/v1/me": () => armed ? member : undefined,
    "/v1/auth/me": () => holdLatest ? latest : undefined,
  }));
  signedIn(c, "org_1");
  armed = true;
  onMessage!(message({type:"opencadre:open", url:link("org_2", "appr_old")}).event);
  await settle(); // old entry has passed auth/me and is waiting on its member identity
  expect(calls.some(x => x.path === "/v1/me" && x.workspace === "org_2")).toBe(true);
  holdLatest = true;
  onMessage!(message({type:"opencadre:open", url:link("org_1", "appr_new")}).event);
  await settle();
  releaseMember();
  await settle();
  const oldCardShown = !$("focused-approval-overlay").hidden;
  const oldIdentityShown = (c.state().me as {orgId?:string})?.orgId === "org_2";
  holdLatest = false;
  releaseLatest();
  await settle();
  await settle();
  expect({oldCardShown, oldIdentityShown}).toEqual({oldCardShown:false, oldIdentityShown:false});
});

// Regression from Codex's review of #665 at 2e4fa03d (pr665-2e4-rollback-refresh-probe.ts). One change to the probe: it
// awaited the abandoned refresh's promise, but a request owned by an ended generation never settles by design (api()), so
// with the generation correctly ended that await can only hang; `await settle()` stands in for it.
it("review: restoring a withdrawn entry must invalidate an already-running refresh for the abandoned workspace", async () => {
  const calls: Call[] = [];
  let releaseEntry!: () => void;
  let releasePoll!: () => void;
  const entry = new Promise<void>((resolve) => { releaseEntry = resolve; });
  const poll = new Promise<void>((resolve) => { releasePoll = resolve; });
  let armed = false;
  let meCount = 0;
  const c = await loadConsole(hub(calls, {
    "/v1/me": () => armed ? (++meCount === 1 ? entry : meCount === 2 ? poll : undefined) : undefined,
  }));
  signedIn(c, "org_1");
  armed = true;
  onMessage!(message({type:"opencadre:open", url:link("org_2", "appr_old")}).event);
  await settle(); // org_2 is staged; its entry's member lookup is pending
  const refreshing = (c as unknown as {refreshNow:()=>Promise<void>}).refreshNow();
  await settle(); // real background refresh captures org_2 and its current generation
  expect(calls.filter(x=>x.path==="/v1/me" && x.workspace==="org_2")).toHaveLength(2);
  onMessage!(message({type:"opencadre:open", url:link("org_other", "appr_new")}).event);
  await settle(); // valid newer click, but no membership, so it starts no new entry/generation
  releaseEntry();
  await settle();
  expect(c.state().currentWorkspace).toBe("org_1");
  releasePoll();
  void refreshing;
  await settle();
  expect(c.state().currentWorkspace).toBe("org_1");
  expect((c.state().me as {orgId?:string})?.orgId).toBe("org_1");
});

describe("withdrawing a notification's entry is a transition of its own", () => {
  const gate = () => {
    let release!: () => void;
    const open = new Promise<void>((r) => { release = r; });
    return { open, release };
  };
  const meOf = (c: Console) => (c.state().me as { orgId?: string } | null)?.orgId;

  /** org_1 on screen; a notification for org_2 is staged with its member lookup held (the 1st /v1/me after arming);
   * then a valid newer click for a workspace the person is not in withdraws it without starting an entry of its own. */
  async function stagedThenWithdrawn(extra: Record<string, () => Promise<void> | undefined> = {}) {
    const calls: Call[] = [];
    const entry = gate();
    let armed = false;
    let meCount = 0;
    const c = await loadConsole(hub(calls, { "/v1/me": () => (armed && ++meCount === 1 ? entry.open : undefined), ...extra }));
    signedIn(c, "org_1");
    armed = true;
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_old") }).event);
    await settle();
    return { c, calls, entry, withdraw: async () => {
      onMessage!(message({ type: "opencadre:open", url: link("org_other", "appr_new") }).event);
      await settle();
      entry.release();
      await settle();
    } };
  }

  it("an already-painted refresh from the abandoned workspace is dropped, and the page goes back to org_1 with org_1's data", async () => {
    const calls: Call[] = [];
    const entry = gate();
    let armed = false;
    let meCount = 0;
    // every /v1/agents answer names its workspace, so what is painted says whose data it is
    const base = hub(calls, { "/v1/me": () => (armed && ++meCount === 1 ? entry.open : undefined) });
    const fetchMock = vi.fn(async (path: string, opts?: { headers?: Record<string, string> }) => {
      const res = await base(path, opts);
      if (path === "/v1/agents") {
        const ws = opts?.headers?.["X-OpenCadre-Workspace"] ?? "none";
        return json(200, { agents: [{ id: `a-${ws}`, name: `agent-of-${ws}`, role: "member", status: "online", last_seen_at: new Date().toISOString(), created_at: new Date().toISOString() }] });
      }
      return res;
    });
    const c = await loadConsole(fetchMock);
    signedIn(c, "org_1");
    armed = true;
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_old") }).event);
    await settle();
    await c.refreshNow(); // a refresh of the staged org_2 completes and paints its agents
    onMessage!(message({ type: "opencadre:open", url: link("org_other", "appr_new") }).event);
    await settle();
    entry.release();
    await settle();
    expect(c.state().currentWorkspace).toBe("org_1");
    expect(meOf(c)).toBe("org_1");
    expect(document.body.textContent).not.toContain("agent-of-org_2");
  });

  it("an in-flight refresh from the abandoned workspace is rejected when it lands, and org_1 loads afresh", async () => {
    const calls: Call[] = [];
    const entry = gate();
    const abandoned = gate();
    let armed = false;
    let meCount = 0;
    let agentCount = 0;
    const base = hub(calls, { "/v1/me": () => (armed && ++meCount === 1 ? entry.open : undefined) });
    const fetchMock = vi.fn(async (path: string, opts?: { headers?: Record<string, string> }) => {
      const ws = opts?.headers?.["X-OpenCadre-Workspace"] ?? "none";
      if (path === "/v1/agents") {
        calls.push({ path, workspace: ws });
        if (armed && ++agentCount === 1) await abandoned.open; // the staged org_2 refresh's agents, answered late
        const n = ws === "org_2" ? 3 : 1; // org_2 has three agents, org_1 one: the count says whose answer was painted
        return json(200, { agents: Array.from({ length: n }, (_, i) => ({ id: `a-${ws}-${i}`, name: `agent-of-${ws}-${i}`, role: "member", key_class: "agent", online: true })) });
      }
      return base(path, opts);
    });
    const c = await loadConsole(fetchMock);
    signedIn(c, "org_1");
    armed = true;
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_old") }).event);
    await settle();
    void c.refreshNow(); // in flight for the staged org_2: its /v1/agents is held
    await settle();
    onMessage!(message({ type: "opencadre:open", url: link("org_other", "appr_new") }).event);
    await settle();
    entry.release(); // the entry is withdrawn: org_1 again
    await settle();
    // from here on nothing of org_2 may ever reach the page or `me`
    const seen: string[] = [];
    const watch = new MutationObserver(() => { seen.push($("fleet-count").textContent ?? ""); });
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    abandoned.release(); // the abandoned refresh finally answers
    await settle();
    watch.disconnect();
    expect(seen.some((s) => s.includes("of 3"))).toBe(false); // org_2's three agents never counted
    expect($("fleet-count").textContent).toContain("of 1"); // org_1's did, after the fresh load
    expect(meOf(c)).toBe("org_1");
    expect(c.state().currentWorkspace).toBe("org_1");
    expect(calls.filter((x) => x.path === "/v1/agents" && x.workspace === "org_1").length).toBeGreaterThan(0); // org_1 loaded afresh
  });

  it("the restored workspace opens no approval card: the withdrawn notification's approval is not carried over", async () => {
    const { c, calls, withdraw } = await stagedThenWithdrawn();
    await withdraw();
    await settle();
    expect(c.state().currentWorkspace).toBe("org_1");
    expect(meOf(c)).toBe("org_1");
    expect($("focused-approval-overlay").hidden).toBe(true);
    expect(calls.some((x) => x.path.startsWith("/v1/approvals/appr_old"))).toBe(false);
    expect(calls.some((x) => x.path.startsWith("/v1/approvals/appr_new"))).toBe(false);
  });

  it("a newer real entry that begins while the entry is withdrawn wins; the withdrawal does nothing", async () => {
    const { c, entry } = await stagedThenWithdrawn();
    // the newer notification is a real entry into org_3 (a member workspace) whose own steps complete at once
    onMessage!(message({ type: "opencadre:open", url: link("org_3", "appr_3") }).event);
    await settle();
    expect(c.state().currentWorkspace).toBe("org_3");
    entry.release(); // the old org_2 entry answers last
    await settle();
    expect(c.state().currentWorkspace).toBe("org_3");
    expect(meOf(c)).toBe("org_3");
    expect($("focused-approval-overlay").textContent).toContain("dist-appr_3");
  });

  it("a real entry begun by the person after the notification's withdrawal was decided is not overwritten by the restore", async () => {
    const { c, entry } = await stagedThenWithdrawn();
    onMessage!(message({ type: "opencadre:open", url: link("org_other", "appr_new") }).event); // withdraws the org_2 entry
    await settle();
    await c.enterWorkspace("org_3"); // the person switches meanwhile: a newer ticket
    entry.release();
    await settle();
    expect(c.state().currentWorkspace).toBe("org_3");
    expect(meOf(c)).toBe("org_3");
  });
});

// Regression from Codex's re-review of #665 at 7650e869 (pr665-7650-recovery-failure-probe.ts), verbatim.
it("review: an already-painted abandoned identity is not retained when the restored workspace reload fails", async () => {
  const calls: Call[] = [];
  let releaseEntry!: () => void;
  const entry = new Promise<void>((resolve) => { releaseEntry = resolve; });
  let armed = false;
  let meCount = 0;
  let failRestored = false;
  const base = hub(calls, { "/v1/me": () => armed && ++meCount === 1 ? entry : undefined });
  const fetchMock = vi.fn(async (path: string, opts?: { headers?: Record<string, string> }) => {
    const workspace = opts?.headers?.["X-OpenCadre-Workspace"];
    if (failRestored && path === "/v1/me" && workspace === "org_1") {
      calls.push({ path, workspace });
      return json(503, { error: "unavailable" });
    }
    const response = await base(path, opts);
    if (path === "/v1/agents") return json(200, { agents: [] });
    return response;
  });
  const c = await loadConsole(fetchMock);
  signedIn(c, "org_1");
  armed = true;
  onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_old") }).event);
  await settle();
  await c.refreshNow();
  expect((c.state().me as { orgId?: string })?.orgId).toBe("org_2");
  failRestored = true;
  onMessage!(message({ type: "opencadre:open", url: link("org_other", "appr_new") }).event);
  await settle();
  releaseEntry();
  await settle();
  await settle();
  expect(c.state().currentWorkspace).toBe("org_1");
  expect(calls.some(x => x.path === "/v1/me" && x.workspace === "org_1")).toBe(true);
  expect((c.state().me as { orgId?: string })?.orgId).toBe("org_1");
});

describe("the recovery restores identity and clears painted data itself, whether or not the reload works", () => {
  /** org_1 on screen; org_2's entry held; a real refresh completes for org_2 (its identity assigned, its three agents
   * painted); a newer non-member click withdraws the entry; then the entry is released. `restored` = org_1's own
   * requests then work or answer 503. */
  async function paintedThenWithdrawn(restored: "ok" | "503") {
    const calls: Call[] = [];
    let releaseEntry!: () => void;
    const entry = new Promise<void>((resolve) => { releaseEntry = resolve; });
    let armed = false;
    let meCount = 0;
    let failRestored = false;
    const base = hub(calls, { "/v1/me": () => (armed && ++meCount === 1 ? entry : undefined) });
    const fetchMock = vi.fn(async (path: string, opts?: { headers?: Record<string, string> }) => {
      const ws = opts?.headers?.["X-OpenCadre-Workspace"];
      if (failRestored && ws === "org_1" && ["/v1/me", "/v1/agents"].includes(path)) {
        calls.push({ path, workspace: ws });
        return json(503, { error: "unavailable" });
      }
      if (path === "/v1/agents") {
        calls.push({ path, workspace: ws ?? null });
        const n = ws === "org_2" ? 3 : 1;
        return json(200, { agents: Array.from({ length: n }, (_, i) => ({ id: `a-${ws}-${i}`, name: `agent-of-${ws}-${i}`, role: "member", key_class: "agent", online: true })) });
      }
      return base(path, opts);
    });
    const c = await loadConsole(fetchMock);
    signedIn(c, "org_1");
    armed = true;
    onMessage!(message({ type: "opencadre:open", url: link("org_2", "appr_old") }).event);
    await settle();
    await c.refreshNow(); // org_2's identity is assigned and its data painted
    expect((c.state().me as { orgId?: string } | null)?.orgId).toBe("org_2");
    expect($("fleet-count").textContent).toContain("of 3");
    failRestored = restored === "503";
    onMessage!(message({ type: "opencadre:open", url: link("org_other", "appr_new") }).event);
    await settle();
    releaseEntry();
    await settle();
    await settle();
    return { c, calls };
  }

  it("the restored reload succeeds: org_1's identity and data, nothing of org_2", async () => {
    const { c } = await paintedThenWithdrawn("ok");
    expect(c.state().currentWorkspace).toBe("org_1");
    expect((c.state().me as { orgId?: string } | null)?.orgId).toBe("org_1");
    expect($("fleet-count").textContent).toContain("of 1");
    expect($("focused-approval-overlay").hidden).toBe(true);
  });

  it("the restored reload fails: identity is org_1's again and org_2's painted data is gone, not left on screen", async () => {
    const { c, calls } = await paintedThenWithdrawn("503");
    expect(calls.some((x) => x.path === "/v1/me" && x.workspace === "org_1")).toBe(true);
    expect(c.state().currentWorkspace).toBe("org_1");
    expect((c.state().me as { orgId?: string } | null)?.orgId).toBe("org_1");
    expect($("fleet-count").textContent ?? "").not.toContain("of 3");
  });
});

// Review of #725 (Olive): a retired console must not settle ANYTHING it started. A late fulfilment, a late rejection
// (which repainted "Couldn't refresh"), and a response body still being read at retirement (which let an old refresh
// complete and clear the next page's notice) are each held back, and each has a control showing that without retirement
// the same late event does settle and repaint, so these can fail. Deterministic: under a second, no poll wait.
describe("a retired console cannot touch the next test's document", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));

  async function lateRefresh(mode: "resolve" | "reject" | "body", retire: boolean) {
    let release!: (value?: unknown) => void;
    let reached!: () => void;
    const started = new Promise<void>((r) => { reached = r; });
    const held = new Promise((r, j) => { release = mode === "reject" ? () => j(new Error("late request failed")) : r; });
    const base = hub([]);
    const c = await loadConsole(vi.fn(async (path: string, opts?: { headers?: Record<string, string> }) => {
      if (path === "/v1/auth/me") return json(401, {});
      if (path === "/v1/agents") {
        if (mode === "body") return { ok: true, status: 200, json: () => { reached(); return held; } };
        reached();
        await held;
        return json(200, { agents: [] });
      }
      return base(path, opts);
    }));
    signedIn(c);
    let settled = false;
    void c.refreshNow().then(() => { settled = true; });
    await started;
    if (mode === "body") await tick(); // every other response has reached api(); only this body is still pending
    if (retire) retireConsoles();
    $("refresh-notice").textContent = "NEXT TEST";
    release(mode === "body" ? { agents: [] } : undefined);
    await tick();
    return { notice: $("refresh-notice").textContent, settled };
  }

  for (const mode of ["resolve", "reject", "body"] as const) {
    it(`retired: a late ${mode} settles nothing and paints nothing`, async () => {
      expect(await lateRefresh(mode, true)).toEqual({ notice: "NEXT TEST", settled: false });
    });
  }
  for (const mode of ["reject", "body"] as const) {
    it(`control, not retired: the same late ${mode} settles and repaints (so the case above can fail)`, async () => {
      const r = await lateRefresh(mode, false);
      expect(r.settled).toBe(true);
      expect(r.notice).not.toBe("NEXT TEST");
    });
  }
});
