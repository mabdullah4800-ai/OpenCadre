// @vitest-environment happy-dom
// Regression coverage for the #119 <-> #121 contract mismatches PC-Beta's review caught: the console's
// hand-written response shapes must match what src/rest.ts actually sends (tests/accounts.test.ts is the
// source of truth for those shapes), and the key-mode claim path must not depend on session-only state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Console = {
  loadSignInConfig: () => Promise<void>;
  renderWorkspacePicker: (identity: unknown) => void;
  refreshMembers: () => Promise<void>;
  fromNow: (s: string) => string;
  setMe: (v: unknown) => void;
  setAuthMode: (v: string) => void;
  getCurrentWorkspace: () => string | null;
};

function loadConsole(fetchMock: ReturnType<typeof vi.fn>): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return {
      loadSignInConfig, renderWorkspacePicker, refreshMembers, fromNow,
      setMe: (v) => { me = v; }, setAuthMode: (v) => { authMode = v; },
      getCurrentWorkspace: () => currentWorkspace,
    };`,
  )(window, document, window.localStorage, fetchMock) as Console;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("sign-in config uses the real /v1/auth/config shape", () => {
  it("reads methods.github/google/email, not top-level flags", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { enabled: true, methods: { github: true, google: false, email: true } }));
    const { loadSignInConfig } = loadConsole(fetchMock);
    await loadSignInConfig();
    expect($("signin-github").hidden).toBe(false);
    expect($("signin-google").hidden).toBe(true);
    expect($("signin-email-form").hidden).toBe(false);
    expect($("signin-oauth").hidden).toBe(false);
  });

  it("sends no Authorization header for this public call (rate-limit bucket sharing)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { enabled: false, methods: {} }));
    const { loadSignInConfig } = loadConsole(fetchMock);
    await loadSignInConfig();
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>).authorization).toBeUndefined();
  });

  // #423 made a new live state reachable: the hub answers 200 with every method false when it could not
  // reach the provider (before that it claimed all three, so the console showed buttons on no evidence).
  // The console falls into its "no hosted sign-in" branch for that too, opening the agent-key form --
  // correct, and not a dead end. But it did so SILENTLY: the loading line was hidden without its text
  // being changed, so the user got a key form with no explanation of why the buttons vanished.
  // 1051's review of #423 measured exactly this and filed it as a follow-up; this is that follow-up.
  it("explains itself when the hub could not verify any method, instead of silently opening the key form", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { enabled: true, methods: { github: false, google: false, email: false } }));
    const { loadSignInConfig } = loadConsole(fetchMock);
    await loadSignInConfig();
    // No fabricated buttons, and the key form is open -- the behaviour #423 established.
    expect($("signin-oauth").hidden).toBe(true);
    expect($("signin-email-form").hidden).toBe(true);
    expect((document.querySelector(".signin-key-details") as HTMLDetailsElement).open).toBe(true);
    // AND the user is told why, which is the part that was missing.
    expect($("signin-methods-loading").hidden).toBe(false);
    expect($("signin-methods-loading").textContent).toMatch(/couldn't check|could not check/i);
    expect($("signin-methods-loading").textContent).toMatch(/agent key/i);
  });

  // The same-conditions control: a hub genuinely configured with NO hosted sign-in also lands in that
  // branch, and there the silent behaviour is correct -- there is nothing to apologize for, the
  // deployment simply uses agent keys. Without this control the test above would also pass for a console
  // that always prints the failure message, which would be wrong on a deliberately key-only hub.
  it("stays quiet when the hub is simply configured with no hosted sign-in", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { enabled: false, methods: { github: false, google: false, email: false } }));
    const { loadSignInConfig } = loadConsole(fetchMock);
    await loadSignInConfig();
    expect((document.querySelector(".signin-key-details") as HTMLDetailsElement).open).toBe(true);
    expect($("signin-methods-loading").hidden).toBe(true);
  });
});

describe("workspace picker: zero-workspace empty state", () => {
  it("shows the ask-for-an-invite message and hides create when canCreateWorkspace is false", () => {
    const { renderWorkspacePicker } = loadConsole(vi.fn());
    renderWorkspacePicker({ person: { name: "Ada" }, workspaces: [], canCreateWorkspace: false });
    expect($("workspace-picker-empty").hidden).toBe(false);
    expect(($("workspace-create-details") as HTMLDetailsElement).hidden).toBe(true);
  });

  it("hides create when the person already has workspaces but can't create another", () => {
    const { renderWorkspacePicker } = loadConsole(vi.fn());
    renderWorkspacePicker({ person: { name: "Ada" }, workspaces: [{ orgId: "o1", name: "Acme", role: "member" }], canCreateWorkspace: false });
    expect($("workspace-picker-empty").hidden).toBe(true); // has a workspace, so no empty-state message
    expect(($("workspace-create-details") as HTMLDetailsElement).hidden).toBe(true); // but still can't create
  });

  it("opens the create form instead when canCreateWorkspace is true", () => {
    const { renderWorkspacePicker } = loadConsole(vi.fn());
    renderWorkspacePicker({ person: { name: "Ada" }, workspaces: [], canCreateWorkspace: true });
    expect($("workspace-picker-empty").hidden).toBe(true);
    const details = $("workspace-create-details") as HTMLDetailsElement;
    expect(details.hidden).toBe(false);
    expect(details.open).toBe(true);
  });
});

describe("key-mode Operator claim path (ACCOUNTS.md transition)", () => {
  it("refreshMembers scopes to me.orgId, not the session-only currentWorkspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { members: [], invites: [] }));
    const { refreshMembers, setMe, setAuthMode } = loadConsole(fetchMock);
    setAuthMode("key");
    setMe({ agentId: "op1", agentName: "Operator", role: "operator", orgId: "org-77" });
    await refreshMembers();
    expect(fetchMock).toHaveBeenCalledWith("/v1/workspaces/org-77/members", expect.anything());
  });

  it("offers Owner as an invite role for a key-mode operator", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { members: [], invites: [] }));
    const { refreshMembers, setMe, setAuthMode } = loadConsole(fetchMock);
    setAuthMode("key");
    setMe({ agentId: "op1", agentName: "Operator", role: "operator", orgId: "org-77" });
    await refreshMembers();
    const values = Array.from($("invite-role-select").querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["member", "admin", "owner"]);
  });
});

describe("fromNow: future-tense expiry", () => {
  it("reads 'in N days' for a 7-day-out timestamp, not past-tense", () => {
    const { fromNow } = loadConsole(vi.fn());
    const sevenDaysOut = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(fromNow(sevenDaysOut)).toBe("in 7 days");
  });
});
