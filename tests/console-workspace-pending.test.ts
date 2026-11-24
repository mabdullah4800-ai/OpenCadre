// @vitest-environment happy-dom
// One unstarted workspace per owner: a 409 WORKSPACE_PENDING from the create form takes the person into the workspace
// that is already waiting, instead of showing a dead end. (The hub still answers that code; src/accounts.ts.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const consoleDisposers: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of consoleDisposers.splice(0)) dispose();
  // Cancellation settles the owned read scopes before the next test replaces their shared document.
  await Promise.resolve();
});

function loadConsole(fetchMock: unknown) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  const documentListeners = vi.spyOn(document, "addEventListener");
  const windowListeners = vi.spyOn(window, "addEventListener");
  let c;
  try {
  c = new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return {
            dispose: () => {
        identityTicket++;
        authMode = "key"; currentWorkspace = null; agentKey = null; me = null;
        clearTimeout(pollTimer); pollTimer = null;
        clearTimeout(refreshSoonTimer); refreshSoonTimer = null;
        refreshWaiters.splice(0).forEach(done => done());
        beginConsoleGeneration();
      },
    };`,
  )(window, document, window.localStorage, fetchMock) as {
    dispose: () => void;
  };
  } finally {
    const ownedDocumentListeners = [...documentListeners.mock.calls];
    const ownedWindowListeners = [...windowListeners.mock.calls];
    documentListeners.mockRestore();
    windowListeners.mockRestore();
    if (c) {
      const disposeState = c.dispose;
      let disposed = false;
      c.dispose = () => {
        if (disposed) return;
        disposed = true;
        disposeState();
        for (const [type, listener, options] of ownedDocumentListeners) document.removeEventListener(type, listener, options);
        for (const [type, listener, options] of ownedWindowListeners) window.removeEventListener(type, listener, options);
      };
      consoleDisposers.push(c.dispose);
    }
  }
  return c!;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const zero = { key: "pending", name: "No plan yet", maxAgents: 0, maxMachines: 0, maxProjects: 0, maxWorkspaces: 1, maxWebhooks: 0, retentionDays: null, trialDays: null };
const PENDING = {
  plan: "pending", planName: "No plan yet", subscriptionStatus: "active", trialEndsAt: null, readOnly: true,
  reason: "it has no plan yet", graceEndsAt: null, seats: 1, limits: zero, awaitingPlan: true, trialConvertsAt: null,
};

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  history.replaceState(null, "", "/app/");
  localStorage.clear();
  sessionStorage.clear();
});

describe("one unstarted workspace per owner: the console takes the person to the one already waiting", () => {
  it("a 409 WORKSPACE_PENDING from the create form enters the waiting workspace instead of showing a dead end", async () => {
    const seen: Array<{ path: string; method?: string; workspace?: string }> = [];
    const fetchMock = vi.fn(async (path: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const route = path.split("?")[0];
      seen.push({ path: route, method: init?.method, workspace: init?.headers?.["X-OpenCadre-Workspace"] });
      if (route === "/v1/workspaces" && init?.method === "POST") {
        return json(409, { error: 'Your workspace "Waiting" is waiting for its free trial to start. Choose a plan for it before creating another workspace.', code: "WORKSPACE_PENDING", workspace: { orgId: "org-9", name: "Waiting" } });
      }
      if (route === "/v1/auth/me") return json(200, { person: { id: "p1", name: "Ada", email: "ada@example.com" }, workspaces: [{ orgId: "org-9", name: "Waiting", role: "owner", paused: false }], canCreateWorkspace: true });
      if (route === "/v1/me") return json(200, { agentId: "m1", agentName: "Ada", role: "operator", orgId: "org-9", orgName: "Waiting", workspace: {}, billing: PENDING });
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
    loadConsole(fetchMock);
    ($("workspace-create-name") as HTMLInputElement).value = "Second";
    $("workspace-create-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(seen.some((c) => c.path === "/v1/me" && c.workspace === "org-9")).toBe(true));
    expect($("workspace-create-error").hidden, "no dead-end error: the person is taken to the waiting workspace").toBe(true);
  });
});

