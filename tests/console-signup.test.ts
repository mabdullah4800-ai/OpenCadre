// @vitest-environment happy-dom
// Signup in the console (docs/design/CONSOLE-V2.md S7). The sign-in page says what it does in each signup mode, and the
// no-workspace note never mentions a waitlist.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const DAY = 86_400_000;
const trial = { plan: "trial", planName: "Trial", subscriptionStatus: "active", trialEndsAt: new Date(Date.now() + 5 * DAY).toISOString(), readOnly: false, reason: null, graceEndsAt: null,
  limits: { key: "trial", name: "Trial", maxAgents: 10, maxMachines: 3, maxProjects: 3, maxWorkspaces: 1, maxWebhooks: 1, retentionDays: 14, trialDays: 7 } };

function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch",
    `${appJs}; return { applySignupWording, activeTab: () => activeTab,
      setMe: (v) => { me = v; }, setRole: (m, r) => { authMode = m; currentWorkspaceRole = r; } };`,
  )(window, document, window.localStorage, vi.fn(async () => json(200, {}))) as {
    applySignupWording: (mode: string | null, hasAccountSignIn?: boolean) => void;
    activeTab: () => string;
    setMe: (v: unknown) => void;
    setRole: (m: string, r: string | null) => void;
  };
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  history.replaceState(null, "", "/app/");
  sessionStorage.clear();
});

describe("the sign-in page says what it does in each signup mode (S7)", () => {
  it("open signup: it is also where an account is created", () => {
    loadConsole().applySignupWording("open");
    expect($("signin-title").textContent).toBe("Sign in or create an account");
    expect($("signin-lede").textContent).toContain("New here?");
  });

  it("open signup with no account sign-in method configured doesn't invite a stranger to create an account", () => {
    // Found on a dev hub: open mode, no hosted methods, so the only option below was an agent key, which can't create
    // an account, yet the page said "Continue with any option below".
    loadConsole().applySignupWording("open", false);
    expect($("signin-title").textContent).toBe("Sign in");
    expect($("signin-lede").textContent).not.toContain("New here?");
  });

  // The operator removed the waitlist: nothing in the console points at one, whatever mode a hub reports.
  it("there is no waitlist link anywhere in the console", () => {
    loadConsole().applySignupWording("waitlist");
    expect($("signin-title").textContent).toBe("Sign in");
    expect(document.getElementById("workspace-picker-waitlist")).toBeNull();
    expect(document.querySelector('a[href*="waitlist"]')).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/waitlist/i);
  });
});

describe("a person signed in with no workspace (f46c on d2c6d86)", () => {
  it("boots straight to the picker, which tells a person with no workspace to ask for an invite", async () => {
    // Drives boot() the way a signed-in person arrives: /v1/auth/me answers with a person and no workspace, so the
    // sign-in page (the only place the mode used to be read) never runs. An earlier version of this test called the
    // picker by hand and let boot take the sign-in path, which read the mode anyway, so it passed on the bug.
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/v1/auth/me") return json(200, { person: { email: "new@example.com" }, workspaces: [], canCreateWorkspace: false });
      if (url === "/v1/auth/config") return json(200, { enabled: true, signup: "waitlist", methods: { github: true } });
      return json(200, {});
    });
    new Function("window", "document", "localStorage", "fetch", `${appJs}; return {};`)(window, document, window.localStorage, fetchMock);
    await vi.waitFor(() => expect($("workspace-picker").hidden).toBe(false));
    expect($("workspace-picker-empty").hidden).toBe(false);
    expect($("workspace-picker-empty").textContent).toContain("Ask a workspace owner for an invite link.");
    expect($("workspace-picker-empty").textContent).not.toMatch(/waitlist/i);
  });
});
