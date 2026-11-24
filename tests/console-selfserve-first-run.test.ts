// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Console = {
  renderFirstRun: () => Promise<void>;
  refreshOnboarding: () => Promise<void>;
  rememberSelfServe: (orgId: string, agent: unknown) => void;
  setMe: (v: { orgId: string; orgName?: string } | null) => void;
};

// An in-memory Storage: window.localStorage varies by runtime (newer Node versions
// expose their own partial localStorage global, where clear() is missing).
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}
let storage: Storage;

// The keys the hub mints are what this whole path exists to hand over, so they use the real shape.
const MINTED_KEY = "agt_selfserve_first_run_key";

function loadConsole(fetchMock: ReturnType<typeof vi.fn>): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { renderFirstRun, refreshOnboarding, rememberSelfServe, setMe: (v) => { me = v; } };`,
  )(window, document, storage, fetchMock) as Console;
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const DEVICE_COMMAND = "npx -y https://hub.opencadre.example/cli/opencadre-cli.tgz connect --hub https://hub.opencadre.example --code oc_TESTCODE";

/** Routes the console's calls the way the hub answers them. `devices` is a live list the test can
 *  mutate between polls, which is how a "connected" transition is staged. */
function hubMock(state: { devices: unknown[]; agents?: unknown[]; created?: Array<Record<string, unknown>> }) {
  return vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/v1/org/devices" && init?.method === "POST") {
      state.created?.push(JSON.parse(String(init.body)));
      return json(201, { deviceId: "dev-1", code: "oc_TESTCODE", expiresAt: new Date(Date.now() + 600_000).toISOString(), command: DEVICE_COMMAND });
    }
    if (path === "/v1/org/devices") return json(200, { devices: state.devices });
    if (path === "/v1/agents") return json(200, { agents: state.agents ?? [{ id: "a1" }, { id: "a2" }] });
    return json(404, { error: `no mock for ${path}` });
  });
}

beforeEach(() => {
  storage = memoryStorage();
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
afterEach(() => vi.useRealTimers());

describe("self-serve first run card", () => {
  it("stays hidden for a workspace the hub did not mint a key for (waitlist path untouched)", async () => {
    const fetchMock = hubMock({ devices: [] });
    const { renderFirstRun, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1", orgName: "Waitlist Co" });
    await renderFirstRun();

    expect($("first-run-card").hidden).toBe(true);
    // Not just hidden -- the card never asked the hub anything. The console's own boot call
    // (/v1/auth/me, made at module load, before this test touches anything) is why this checks the
    // paths rather than the call count. A waitlist workspace must render as it did before this card.
    const paths = fetchMock.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/v1/org/devices");
    expect(paths).not.toContain("/v1/agents");
  });

  it("shows the one-time key and the command step for a self-serve workspace", async () => {
    const fetchMock = hubMock({ devices: [] });
    const { renderFirstRun, rememberSelfServe, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1", orgName: "Ada's Workspace" });
    rememberSelfServe("org-1", { apiKey: MINTED_KEY, agentName: "First Agent" });
    await renderFirstRun();

    expect($("first-run-card").hidden).toBe(false);
    expect($("first-run-step-workspace").classList.contains("is-done")).toBe(true);
    expect($("first-run-workspace-label").textContent).toContain("Ada's Workspace");
    // The key the hub mints in the create round trip, shown here or thrown away (src/accounts.ts §2.3).
    expect($("first-run-key").hidden).toBe(false);
    expect($("first-run-key-value").textContent).toBe(MINTED_KEY);
    expect($("first-run-key-value").hidden).toBe(false);
    // Still to do: the command.
    expect($("first-run-step-command").classList.contains("is-done")).toBe(false);
    expect($("first-run-get-command").hidden).toBe(false);
    expect($("first-run-cmd").hidden).toBe(true);
  });

  it("hands over one command from the device route, then ticks the step when a chat connects", async () => {
    vi.useFakeTimers();
    const state = { devices: [{ deviceId: "dev-1", status: "waiting" }], created: [] as Array<Record<string, unknown>> };
    const fetchMock = hubMock(state);
    const { renderFirstRun, rememberSelfServe, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1" });
    rememberSelfServe("org-1", { apiKey: MINTED_KEY, agentName: "First Agent" });
    await renderFirstRun();

    $("first-run-get-command").click();
    await vi.advanceTimersByTimeAsync(0);

    // One command, the hub's own string, verbatim.
    expect($("first-run-cmd").hidden).toBe(false);
    expect($("first-run-cmd-text").textContent).toBe(DEVICE_COMMAND);
    expect($("first-run-get-command").hidden).toBe(true);
    expect($("first-run-status").textContent).toContain("Waiting");
    // The workspace is named for the person, not required of them.
    expect(state.created).toEqual([{ name: "My computer" }]);

    state.devices = [{ deviceId: "dev-1", status: "connected" }];
    await vi.advanceTimersByTimeAsync(3000);

    expect($("first-run-step-command").classList.contains("is-done")).toBe(true);
    expect($("first-run-step-agents").classList.contains("is-done")).toBe(true);
    expect($("first-run-status").textContent).toBe("Connected ✓");
  });

  it("gives up on a removed computer: says so and stops polling it", async () => {
    // The card's own poller, on the device status it had no branch for. Asserted on the polling
    // count rather than on the chip alone: a fix that only gets the words right still leaks a
    // 3-second request per page load, for as long as the tab is open.
    vi.useFakeTimers();
    const state = { devices: [{ deviceId: "dev-1", status: "waiting" }], created: [] as Array<Record<string, unknown>> };
    const fetchMock = hubMock(state);
    const { renderFirstRun, rememberSelfServe, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1" });
    rememberSelfServe("org-1", { apiKey: MINTED_KEY, agentName: "First Agent" });
    await renderFirstRun();

    $("first-run-get-command").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("first-run-status").textContent).toContain("Waiting");

    const polls = () => fetchMock.mock.calls.filter(([c]) => c === "/v1/org/devices").length;
    state.devices = [{ deviceId: "dev-1", status: "revoked" }];
    await vi.advanceTimersByTimeAsync(3000);

    expect($("first-run-status").textContent).toMatch(/removed/i);
    // The dead command is taken off screen and the way to get a new one is offered again.
    expect($("first-run-cmd").hidden).toBe(true);
    expect($("first-run-get-command").hidden).toBe(false);
    const afterRevoked = polls();

    await vi.advanceTimersByTimeAsync(9000); // polling should have stopped
    expect(polls()).toBe(afterRevoked);
  });

  it("never ticks the agents step from the count alone -- an agent already existed", async () => {
    // The card's own step would be a lie if a non-zero count counted as "a chat appeared": the
    // self-serve workspace always holds the first agent plus the person's member row.
    const fetchMock = hubMock({ devices: [], agents: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] });
    const { renderFirstRun, rememberSelfServe, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1" });
    rememberSelfServe("org-1", { apiKey: MINTED_KEY, agentName: "First Agent" });
    await renderFirstRun();

    expect($("first-run-agents-label").textContent).toContain("3 agents");
    expect($("first-run-step-agents").classList.contains("is-done")).toBe(false);
  });

  it("stays hidden for this workspace after Hide, across a later refresh", async () => {
    const fetchMock = hubMock({ devices: [] });
    const { renderFirstRun, rememberSelfServe, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1" });
    rememberSelfServe("org-1", { apiKey: MINTED_KEY, agentName: "First Agent" });
    await renderFirstRun();
    expect($("first-run-card").hidden).toBe(false);

    $("first-run-hide").click();
    expect($("first-run-card").hidden).toBe(true);

    await renderFirstRun();
    expect($("first-run-card").hidden).toBe(true);
    expect(storage.getItem("opencadre.firstrun.hidden.org-1")).toBe("1");
  });

  it("keeps the card over a later page load but never re-shows the key, and never writes it down", async () => {
    const fetchMock = hubMock({ devices: [] });
    const first = loadConsole(fetchMock);
    first.setMe({ orgId: "org-1" });
    first.rememberSelfServe("org-1", { apiKey: MINTED_KEY, agentName: "First Agent" });
    await first.renderFirstRun();

    // A reload: same storage, fresh module -- exactly what the browser does -- and no key in memory.
    const second = loadConsole(fetchMock);
    second.setMe({ orgId: "org-1" });
    await second.renderFirstRun();

    expect($("first-run-card").hidden).toBe(false);
    expect($("first-run-key-title").textContent).toContain("shown when you created this workspace");
    expect($("first-run-key-value").hidden).toBe(true);
    expect($("first-run-key-copy").hidden).toBe(true);
    // The hub stores only a hash; the console must not keep the second copy the hub refused to.
    const stored = [...Array(storage.length).keys()].map((i) => storage.getItem(storage.key(i) ?? "") ?? "");
    expect(stored.join("\n")).not.toContain(MINTED_KEY);
  });

  it("renders for a marker set by hand, and still has no key to reveal -- what the gate really guarantees", async () => {
    // Measured by 1101 while reviewing this PR, and kept as a guard so the claim cannot drift back to
    // the stronger one the code does not provide. The marker is WRITTEN only by the create round trip,
    // but it is READ as a bare localStorage flag, so a hand-set marker does render the card. That is
    // not a leak: there is no persisted key for it to show. It is the reason "only a workspace the hub
    // minted a key for" is the wrong way to describe this gate.
    storage.setItem("opencadre.selfserve.org-1", "1");
    const fetchMock = hubMock({ devices: [] });
    const { renderFirstRun, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1", orgName: "Hand-set Co" });
    await renderFirstRun();

    expect($("first-run-card").hidden).toBe(false);
    expect($("first-run-key").hidden).toBe(false);
    // ... and empty. The value row and its Copy button are the only things a key would reach.
    expect($("first-run-key-value").hidden).toBe(true);
    expect($("first-run-key-value").textContent).not.toContain("agt_");
    expect($("first-run-key-copy").hidden).toBe(true);
  });

  it("gets out of the way once a computer connected on an earlier visit", async () => {
    const fetchMock = hubMock({ devices: [{ deviceId: "dev-1", status: "connected" }] });
    const first = loadConsole(fetchMock);
    first.setMe({ orgId: "org-1" });
    first.rememberSelfServe("org-1", { apiKey: MINTED_KEY, agentName: "First Agent" });
    await first.renderFirstRun();

    const second = loadConsole(fetchMock);
    second.setMe({ orgId: "org-1" });
    await second.renderFirstRun();

    expect($("first-run-card").hidden).toBe(true);
  });

  it("supersedes the generic checklist while it is up, and hands back to it afterwards", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/v1/org/devices") return json(200, { devices: [] });
      if (path === "/v1/agents") return json(200, { agents: [{ id: "a1" }] });
      if (path === "/v1/onboarding") {
        return json(200, { completed: 0, total: 4, steps: [{ id: "first_agent", done: false, doneAt: null, detail: null }] });
      }
      return json(404, { error: `no mock for ${path}` });
    });
    const { renderFirstRun, refreshOnboarding, rememberSelfServe, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1" });
    rememberSelfServe("org-1", { apiKey: MINTED_KEY, agentName: "First Agent" });

    // The order applyRole uses.
    await renderFirstRun();
    await refreshOnboarding();

    // Two cards saying "connect an agent" is the sloppiness this avoids: the first-run one says it
    // with the actual command, so the checklist stands down rather than repeating itself above it.
    expect($("first-run-card").hidden).toBe(false);
    expect($("onboarding-card").hidden).toBe(true);

    // Once the first run is over the checklist takes over again, with the steps the card doesn't cover.
    $("first-run-hide").click();
    await refreshOnboarding();
    expect($("onboarding-card").hidden).toBe(false);
  });

  it("still shows the command step when the device list cannot be read", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/v1/org/devices") throw new Error("network down");
      return json(200, { agents: [] });
    });
    const { renderFirstRun, rememberSelfServe, setMe } = loadConsole(fetchMock);
    setMe({ orgId: "org-1" });
    rememberSelfServe("org-1", { apiKey: MINTED_KEY, agentName: "First Agent" });
    await renderFirstRun();

    expect($("first-run-card").hidden).toBe(false);
    expect($("first-run-get-command").hidden).toBe(false);
  });
});

// The join between the hub minting the key and this card showing it: the console's REAL create form.
// Every test above stages that join with a fixture (`rememberSelfServe`), which is the right way to
// test the card and the wrong way to test the join. If a refactor went back to destructuring only
// `{ workspace }` off the create response, every fixture-based test here would still pass while a
// brand-new self-serve user landed in a console holding nothing to connect with -- the one credential
// the whole path exists to hand over, silently dropped. So this drives the form itself, and asserts on
// the reply the hub really sends (src/rest.ts: `agent` is a TOP-LEVEL sibling of `workspace`, present
// only when the hub minted a first key).
describe("the self-serve key arrives through the console's own create form", () => {
  /** Answers every route the console touches after a create with the SHAPE that route really returns,
   *  not `{}`: renderHistory() maps grants.grants and the onboarding card maps progress.steps, so an
   *  empty object in the wrong place throws inside a render and shows up as an unhandled rejection
   *  rather than as the behaviour under test. */
  function createMock(createBody: unknown, seen: Array<{ path: string; method: string | undefined; body: unknown }>) {
    return vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      const route = path.split("?")[0];
      seen.push({ path: route, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (route === "/v1/workspaces" && init?.method === "POST") return json(201, createBody);
      if (route === "/v1/auth/me") {
        return json(200, { person: { id: "p1", name: "Ada", email: "ada@example.com" }, workspaces: [], canCreateWorkspace: true });
      }
      if (route === "/v1/me") return json(200, { agentId: "m1", agentName: "Ada", role: "owner", orgId: "org-1", orgName: "Acme", workspace: {} });
      if (route === "/v1/approval-grants") return json(200, { grants: [] });
      if (route === "/v1/onboarding") return json(200, { completed: 0, total: 4, steps: [] });
      if (route === "/v1/messages") return json(200, { messages: [] });
      if (route === "/v1/events") return json(200, { events: [] });
      if (route === "/v1/org/devices" || route === "/v1/push/devices") return json(200, { devices: [] });
      if (route === "/v1/org/sessions") return json(200, { sessions: [] });
      if (route === "/v1/org/projects") return json(200, { projects: [] });
      // Each of these three is an object keyed by its collection (src/rest.ts: { agents }, { tasks }, { approvals }), never a bare array.
      if (route === "/v1/agents") return json(200, { agents: [] });
      if (route === "/v1/tasks") return json(200, { tasks: [] });
      if (route === "/v1/approvals") return json(200, { approvals: [] });
      return json(200, {});
    });
  }

  /** Submits the form the way a person's Enter key does, then drains the chain: the handler awaits the
   *  round trip and then enterWorkspace() fans out into a dozen renders, so one await is not enough and
   *  a fixed sleep would be a guess. */
  async function submitCreateForm(name: string) {
    ($("workspace-create-name") as HTMLInputElement).value = name;
    $("workspace-create-form").dispatchEvent(new Event("submit", { cancelable: true }));
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it("shows the key the hub minted in the create response, and the command step to spend it", async () => {
    const seen: Array<{ path: string; method: string | undefined; body: unknown }> = [];
    const fetchMock = createMock(
      {
        workspace: { orgId: "org-1", name: "Acme Robotics", role: "owner" },
        agent: { agentId: "a1", agentName: "First Agent", apiKey: MINTED_KEY },
      },
      seen,
    );
    const { renderFirstRun } = loadConsole(fetchMock);

    await submitCreateForm("Acme Robotics");
    await renderFirstRun();

    const created = seen.find((c) => c.path === "/v1/workspaces" && c.method === "POST");
    expect(created?.body).toEqual({ name: "Acme Robotics" });
    // The key must be ON SCREEN: the hub stores only a hash, so this response is the only chance.
    expect($("first-run-card").hidden).toBe(false);
    expect($("first-run-key").hidden).toBe(false);
    expect($("first-run-key-value").textContent).toBe(MINTED_KEY);
    expect($("first-run-step-workspace").classList.contains("is-done")).toBe(true);
    // And the next step is offered, not skipped: the key alone leaves the user where they started.
    expect($("first-run-get-command").hidden).toBe(false);
    // Still not written down -- the hub's refusal to keep a copy is the reason the card exists.
    const stored = [...Array(storage.length).keys()].map((i) => storage.getItem(storage.key(i) ?? "") ?? "");
    expect(stored.join("\n")).not.toContain(MINTED_KEY);
  });

  it("leaves a waitlist workspace exactly as it was: no `agent`, so nothing to show", async () => {
    const seen: Array<{ path: string; method: string | undefined; body: unknown }> = [];
    const fetchMock = createMock({ workspace: { orgId: "org-1", name: "Waitlist Co", role: "owner" } }, seen);
    const { renderFirstRun } = loadConsole(fetchMock);

    await submitCreateForm("Waitlist Co");
    await renderFirstRun();

    expect(seen.some((c) => c.path === "/v1/workspaces" && c.method === "POST")).toBe(true);
    expect($("first-run-card").hidden).toBe(true);
    // The marker is what the card turns on, so its absence is the whole claim -- the card does not
    // merely render empty, it never engages at all on this path.
    const keys = [...Array(storage.length).keys()].map((i) => storage.key(i) ?? "");
    expect(keys.some((k) => k.startsWith("opencadre.selfserve."))).toBe(false);
  });
});
