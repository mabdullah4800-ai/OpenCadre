// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

type Console = {
  applyRole: () => void;
  generateAgentName: (prefix?: string) => string;
  renderOtherAgents: (agents: unknown[]) => void;
  setSession: (identity: { agentId: string; agentName: string; role: string }, key: string) => void;
  setWorkspaceSession: (identity: { agentId: string; agentName: string; role: string }, role: "owner" | "admin" | "member" | null) => void;
  effectiveRole: () => string;
  currentKey: () => string | null;
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

// app.js now probes /v1/auth/* at boot regardless of which client test loaded it; none of these
// tests are about that flow, so answer it the way a hub with no session cookie really would (401),
// rather than falling through to each test's own key-focused mock and getting a stray 200 {}.
function loadConsole(fetchMock: ReturnType<typeof vi.fn>): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const wrapped = (url: string, ...rest: unknown[]) =>
    url.startsWith("/v1/auth/") ? json(401, { error: "no session" }) : fetchMock(url, ...rest);
  return new Function(
    "window", "document", "localStorage", "fetch",
    // Plain JS only inside this string -- new Function() has no TypeScript pass, so a type
    // annotation or `as` cast here is a runtime SyntaxError, not a type error.
    `${appJs}; return {
      applyRole, generateAgentName, renderOtherAgents,
      setSession: (m, k) => { me = m; agentKey = k; },
      currentKey: () => agentKey,
      // Session-mode state for the RBAC gate tests: enterWorkspace() sets authMode/currentWorkspaceRole
      // from /v1/auth/me plus the picked workspace (see app.js enterWorkspace), and these tests need to
      // place the caller in a workspace without driving the whole sign-in flow.
      setWorkspaceSession: (m, role) => { me = m; agentKey = "agt_member"; authMode = "session"; currentWorkspaceRole = role; person = { id: "p1", name: m.agentName, email: "p@example.com", email_verified: 1 }; },
      effectiveRole: () => effectiveRole(),
    };`,
  )(window, document, storage, wrapped) as Console;
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

beforeEach(() => {
  storage = memoryStorage();
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});
afterEach(() => vi.unstubAllGlobals());

describe("console agent key management", () => {
  it("lets an operator create a key without the organization key", async () => {
    // Only the create is a 201; the refresh() a successful create asks for reads the hub's real shapes (a body without
    // `approvals` made renderClearances throw in a refresh that landed during a later test).
    const fetchMock = vi.fn(async (url: string) =>
      (url === "/v1/org/agents" ? json(201, { agentId: "a9", agentName: "Codex-Laptop", apiKey: "agt_new" }) : json(200, hubReadBody(url) ?? {})));
    const ui = loadConsole(fetchMock);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    ui.applyRole();

    expect($("org-key-field").hidden).toBe(true);
    expect($("org-key").required).toBe(false);
    expect(document.querySelector("#create-agent-key-details summary")?.textContent).toMatch(/set up a tool by hand with an agent key/i);

    $("agent-name").value = "Codex-Laptop";
    $("agent-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    const createCall = fetchMock.mock.calls.find(([url]) => url === "/v1/org/agents");
    expect(createCall).toBeTruthy();
    expect(createCall![1]).toMatchObject({ method: "POST", body: JSON.stringify({ name: "Codex-Laptop" }) });
    expect(createCall![1].headers.authorization).toBe("Bearer agt_op");
    expect($("connect-output").hidden).toBe(false);
    const snippets = $("snippets").textContent ?? "";
    expect(snippets).toContain("agt_new");
    expect(snippets).toContain('http_headers = { "Authorization" = "Bearer agt_new" }');
    expect(snippets).toContain("tool_timeout_sec = 300");
    expect(snippets).toContain("[shell_environment_policy.set]");
    expect(snippets).toContain('OPENCADRE_KEY = "agt_new"');
    expect($("connect-output").textContent).toContain("Each agent needs its own key and its own working folder.");
  });

  it("keeps the organization key form for non-operators", () => {
    const ui = loadConsole(vi.fn());
    ui.setSession({ agentId: "c1", agentName: "Coder", role: "agent" }, "agt_c");
    ui.applyRole();
    expect($("org-key-field").hidden).toBe(false);
    expect($("org-key").required).toBe(true);
  });

  it("shows a duplicate-name error inline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(409, { error: "an agent named Coder already exists" }));
    const ui = loadConsole(fetchMock);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    ui.applyRole();
    $("agent-name").value = "Coder";
    $("agent-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect($("agent-error").hidden).toBe(false);
    expect($("agent-error").textContent).toBe("an agent named Coder already exists");
  });

  it("shows why adding a computer failed, right on the form", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(409, { error: "a computer named PC-2 already exists" }));
    const ui = loadConsole(fetchMock);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    $("computer-name").value = "PC-2";
    $("add-computer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect($("computer-error").hidden).toBe(false);
    expect($("computer-error").textContent).toBe("a computer named PC-2 already exists");
  });

  it("disables Add a computer while the request is in flight, so repeated clicks can't produce multiple codes", async () => {
    // Found live on the old per-agent flow this replaced: the operator got 3 connect codes from 3
    // clicks within 5s. A deferred fetch lets us click twice while the first request is still
    // outstanding and assert only one ever went out.
    let releaseFetch: (() => void) | undefined;
    // Only the create is held open; the refresh() a successful create asks for reads the hub's real shapes.
    const fetchMock = vi.fn(
      (url: string) =>
        url !== "/v1/org/devices"
          ? Promise.resolve(json(200, hubReadBody(url) ?? {}))
          : new Promise((resolve) => {
            releaseFetch = () =>
              resolve(json(200, { deviceId: "d1", command: "npx opencadre connect --device --code ocd_abc123", code: "ocd_abc123", expiresAt: new Date(Date.now() + 900_000).toISOString() }));
          }),
    );
    const ui = loadConsole(fetchMock);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    $("computer-name").value = "PC-2";
    const btn = $("btn-add-computer") as unknown as HTMLButtonElement;

    btn.click();
    await flush();
    expect(btn.disabled).toBe(true);

    // A second and third click while the first request is still outstanding must not fire more requests.
    btn.click();
    btn.click();
    await flush();
    expect(fetchMock.mock.calls.filter(([url, opts]) => url === "/v1/org/devices" && opts?.method === "POST")).toHaveLength(1);

    releaseFetch?.();
    await flush();
    expect(btn.disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([url, opts]) => url === "/v1/org/devices" && opts?.method === "POST")).toHaveLength(1);
  });

  it("re-enables Add a computer after a failed request too", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(409, { error: "a computer named PC-2 already exists" }));
    const ui = loadConsole(fetchMock);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    $("computer-name").value = "PC-2";
    const btn = $("btn-add-computer") as unknown as HTMLButtonElement;
    btn.click();
    await flush();
    expect(btn.disabled).toBe(false);
  });

  it("generates readable random names from crypto.getRandomValues", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    const ui = loadConsole(vi.fn());
    const names = Array.from({ length: 50 }, () => ui.generateAgentName());
    for (const n of names) expect(n).toMatch(/^[A-Za-z]+-[A-Z0-9]{4}$/);
    expect(new Set(names).size).toBeGreaterThan(40);
    expect(spy).toHaveBeenCalled();
    expect(ui.generateAgentName("Codex-Laptop")).toMatch(/^Codex-[A-Z0-9]{4}$/);

    $("agent-name").value = "Cursor";
    $("generate-agent-name").click();
    expect($("agent-name").value).toMatch(/^Cursor-[A-Z0-9]{4}$/);
  });

  // Both real named tool agents (role: "agent") -- distinct from the legacy operator-role key,
  // which docs/design/HUB_REDESIGN.md 1.8.2 excludes from this list entirely (see
  // tests/console-remove-agent.test.ts). "op" here is just an agent that happens to share an id
  // with the viewer, for the "rotate my own key" test below -- not that legacy key.
  const agents = [
    { id: "op", name: "Operator", role: "agent", online: true, editing_files_parsed: [], last_heartbeat_at: null },
    { id: "c1", name: "Coder", role: "agent", online: false, editing_files_parsed: [], last_heartbeat_at: null },
  ];

  it("shows Rotate key in Other agents only for operators", () => {
    const ui = loadConsole(vi.fn());
    ui.setSession({ agentId: "c1", agentName: "Coder", role: "agent" }, "agt_c");
    ui.renderOtherAgents(agents);
    expect(document.querySelectorAll("[data-rotate]").length).toBe(0);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    ui.renderOtherAgents(agents);
    expect(document.querySelectorAll("[data-rotate]").length).toBe(2);
  });

  // --- RBAC: rotate/delete moved to owner-only (src/permissions.ts REQUIRED, decisions 2026-09-18) ---
  // roleFor() resolves a session caller by memberRole FIRST, and accounts.ts agentRoleFor maps both
  // owner AND admin to agents.role="operator" -- so /v1/me reports role:"operator" for an admin too.
  // A gate that trusted me.role therefore showed a session admin working-looking buttons that the API
  // answers with 403 "Only an owner can do this." These pin the effective-role resolution instead.

  it("resolves the effective role the way the server does", () => {
    const ui = loadConsole(vi.fn());
    // Key mode: a bare Operator key is owner-equivalent (the bootstrap exception in roleFor).
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    expect(ui.effectiveRole()).toBe("owner");
    // Key mode: a plain agent key is not.
    ui.setSession({ agentId: "c1", agentName: "Coder", role: "agent" }, "agt_c");
    expect(ui.effectiveRole()).toBe("agent");
    // Session mode: memberRole wins over the member agent's role -- this is the case that broke.
    ui.setWorkspaceSession({ agentId: "a1", agentName: "Ada", role: "operator" }, "admin");
    expect(ui.effectiveRole()).toBe("admin");
    ui.setWorkspaceSession({ agentId: "a1", agentName: "Ada", role: "operator" }, "owner");
    expect(ui.effectiveRole()).toBe("owner");
    ui.setWorkspaceSession({ agentId: "a1", agentName: "Ada", role: "agent" }, "member");
    expect(ui.effectiveRole()).toBe("member");
  });

  it("hides Rotate key and Remove from a session admin, whose member agent still reports role:operator", () => {
    const ui = loadConsole(vi.fn());
    // The exact production shape: /v1/me for an admin carries role:"operator" because agentRoleFor
    // maps admin -> operator. Only currentWorkspaceRole distinguishes them.
    ui.setWorkspaceSession({ agentId: "a1", agentName: "Ada", role: "operator" }, "admin");
    ui.renderOtherAgents(agents);
    expect(document.querySelectorAll("[data-rotate]").length).toBe(0);
    expect(document.querySelectorAll("[data-remove]").length).toBe(0);
  });

  it("still shows Rotate key and Remove to a session owner", () => {
    const ui = loadConsole(vi.fn());
    ui.setWorkspaceSession({ agentId: "a1", agentName: "Ada", role: "operator" }, "owner");
    ui.renderOtherAgents(agents);
    expect(document.querySelectorAll("[data-rotate]").length).toBe(2);
    // Ada is the viewer, so the two listed agents are both removable by her.
    expect(document.querySelectorAll("[data-remove]").length).toBe(2);
  });

  it("tells a session admin where the owner-only actions went, instead of leaving an unexplained gap", () => {
    const ui = loadConsole(vi.fn());
    ui.setWorkspaceSession({ agentId: "a1", agentName: "Ada", role: "operator" }, "admin");
    ui.renderOtherAgents(agents);
    const note = document.querySelector(".manage-roles-note");
    expect(note?.textContent).toMatch(/owner only/i);
    expect(note?.textContent).toMatch(/admin/);
    expect(note?.querySelector("a")?.getAttribute("href")).toContain("rbac-permission-model.md");
    // An owner sees the buttons, not the note -- the note must not become furniture for everyone.
    ui.setWorkspaceSession({ agentId: "a1", agentName: "Ada", role: "operator" }, "owner");
    ui.renderOtherAgents(agents);
    expect(document.querySelector(".manage-roles-note")).toBeNull();
    // Nor should a plain agent or a key-mode operator ever see it.
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    ui.renderOtherAgents(agents);
    expect(document.querySelector(".manage-roles-note")).toBeNull();
  });

  it("rotates another agent's key after confirmation and shows the new key", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/rotate-key") ? json(200, { agentId: "c1", agentName: "Coder", apiKey: "agt_rotated", ownKey: false }) : json(200, hubReadBody(url) ?? {}));
    const ui = loadConsole(fetchMock);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    ui.renderOtherAgents(agents);
    (document.querySelector('[data-rotate="c1"]') as HTMLButtonElement).click();
    await flush();
    expect(confirm).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/v1/org/agents/c1/rotate-key", expect.objectContaining({ method: "POST" }));
    expect($("snippets").textContent).toContain("agt_rotated");
    expect(ui.currentKey()).toBe("agt_op");
  });

  it("does nothing when the rotation is not confirmed", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const fetchMock = vi.fn();
    const ui = loadConsole(fetchMock);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    ui.renderOtherAgents(agents);
    (document.querySelector('[data-rotate="c1"]') as HTMLButtonElement).click();
    await flush();
    expect(fetchMock).not.toHaveBeenCalledWith("/v1/org/agents/c1/rotate-key", expect.anything());
  });

  it("switches the stored console key when the operator rotates its own key", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/rotate-key") ? json(200, { agentId: "op", agentName: "Operator", apiKey: "agt_mine2", ownKey: true }) : json(200, hubReadBody(url) ?? {}));
    const ui = loadConsole(fetchMock);
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    storage.setItem("opencadre.agentKey", "agt_op");
    ui.renderOtherAgents(agents);
    (document.querySelector('[data-rotate="op"]') as HTMLButtonElement).click();
    await flush();
    expect(ui.currentKey()).toBe("agt_mine2");
    expect(storage.getItem("opencadre.agentKey")).toBe("agt_mine2");
  });

  it("Other agents excludes session-kind agents -- they live in Fleet's project/computer views instead", () => {
    const ui = loadConsole(vi.fn());
    ui.setSession({ agentId: "op", agentName: "Operator", role: "operator" }, "agt_op");
    ui.renderOtherAgents([
      ...agents,
      { id: "s1", name: "Codex-OpenCadre-3f2a", role: "agent", kind: "session", online: true, editing_files_parsed: [], last_heartbeat_at: null },
    ]);
    const names = Array.from(document.querySelectorAll("#fleet-other-agents .callsign")).map((n) => n.textContent);
    expect(names).toEqual(["Operator", "Coder"]);
  });
});
