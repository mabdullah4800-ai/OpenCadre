// @vitest-environment happy-dom
// Console-side coverage for R4 phone approvals (docs/design/ACCOUNTS.md -> "Phone notifications"):
// the Settings card, the ?workspace=<orgId>#approval-<id> deep link, and sign-out cleanup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Approval = { id: string; org_id: string; action: string; risk: string; category: string | null; details: string | null; requested_by_agent_id: string; requested_by_agent_name: string; status: string; created_at: string; expires_at: string; decided_by_agent_name?: string; decided_by_person_name?: string | null; decision_note?: string | null };

type Console = {
  approvalDeepLink: () => { workspaceId: string; approvalId: string } | null;
  showFocusedApproval: (id: string) => Promise<void>;
  refreshPushCard: () => Promise<void>;
  removeThisDevicePush: () => Promise<void>;
  signOut: (message?: string) => void;
  setMe: (v: unknown) => void;
  setAuthMode: (v: string) => void;
  setAgentKey: (v: string | null) => void;
};

function loadConsole(fetchMock: ReturnType<typeof vi.fn>): Console {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return {
      approvalDeepLink, showFocusedApproval, refreshPushCard, removeThisDevicePush, signOut,
      setMe: (v) => { me = v; }, setAuthMode: (v) => { authMode = v; }, setAgentKey: (v) => { agentKey = v; },
    };`,
  )(window, document, window.localStorage, fetchMock) as Console;
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const approval = (overrides: Partial<Approval> = {}): Approval => ({
  id: "appr1", org_id: "org1", action: "rm -rf ./dist", risk: "high", category: "rm-rf", details: null,
  requested_by_agent_id: "other-agent", requested_by_agent_name: "Claude-Coder", status: "pending",
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString(),
  ...overrides,
});

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  // Default: no service worker support in this test's happy-dom navigator, so push code paths that
  // check for it degrade quietly. Individual tests override this to exercise the subscribed path.
  Object.defineProperty(window.navigator, "serviceWorker", { value: undefined, configurable: true });
});

describe("approvalDeepLink", () => {
  const setUrl = (search: string, hash: string) => {
    window.history.replaceState(null, "", `/app/${search}${hash}`);
  };

  it("parses a real notification link", () => {
    setUrl("?workspace=org_123", "#approval-appr_456");
    const { approvalDeepLink } = loadConsole(vi.fn());
    expect(approvalDeepLink()).toEqual({ workspaceId: "org_123", approvalId: "appr_456" });
  });

  it("is null without a workspace query param", () => {
    setUrl("", "#approval-appr_456");
    const { approvalDeepLink } = loadConsole(vi.fn());
    expect(approvalDeepLink()).toBeNull();
  });

  it("is null without an #approval- hash", () => {
    setUrl("?workspace=org_123", "");
    const { approvalDeepLink } = loadConsole(vi.fn());
    expect(approvalDeepLink()).toBeNull();
  });

  it("is null for an unrelated hash", () => {
    setUrl("?workspace=org_123", "#something-else");
    const { approvalDeepLink } = loadConsole(vi.fn());
    expect(approvalDeepLink()).toBeNull();
  });
});

describe("showFocusedApproval", () => {
  it("fetches the single approval by id, not the whole list", async () => {
    const fetchMock = vi.fn(async () => json(200, { approval: approval() }));
    const { showFocusedApproval } = loadConsole(fetchMock);
    await showFocusedApproval("appr1");
    // boot() also fires at module load and makes its own unrelated calls through this same mock;
    // this only asserts showFocusedApproval's own request, not the total call count.
    expect(fetchMock).toHaveBeenCalledWith("/v1/approvals/appr1", expect.anything());
    expect(fetchMock.mock.calls.some(([url]) => url === "/v1/approvals?status=pending" || url === "/v1/approvals")).toBe(false);
  });

  it("renders the pending approval as a focused card with hold-to-approve and Deny", async () => {
    const fetchMock = vi.fn(async () => json(200, { approval: approval() }));
    const { showFocusedApproval } = loadConsole(fetchMock);
    await showFocusedApproval("appr1");
    const overlay = $("focused-approval-overlay");
    expect(overlay.hidden).toBe(false);
    expect(overlay.textContent).toContain("Claude-Coder");
    expect(overlay.textContent).toContain("rm -rf ./dist");
    expect(overlay.querySelector(".hold")).toBeTruthy();
    expect(Array.from(overlay.querySelectorAll("button")).some((b) => b.textContent === "Deny")).toBe(true);
  });

  it("shows the route's own not-found message for an approval that doesn't exist (expired or wrong workspace)", async () => {
    const fetchMock = vi.fn(async () => json(404, { error: 'No approval request found matching "missing-id"' }));
    const { showFocusedApproval } = loadConsole(fetchMock);
    await showFocusedApproval("missing-id");
    expect($("focused-approval-overlay").textContent).toContain("No approval request found matching");
  });

  it("shows who already decided it, instead of a stale decide card", async () => {
    const decided = approval({ status: "approved", decided_by_agent_name: "Operator" });
    const fetchMock = vi.fn(async () => json(200, { approval: decided }));
    const { showFocusedApproval } = loadConsole(fetchMock);
    await showFocusedApproval("appr1");
    const text = $("focused-approval-overlay").textContent ?? "";
    expect(text).toContain("Already approved");
    expect(text).toContain("Operator");
    expect($("focused-approval-overlay").querySelector(".hold")).toBeNull();
  });

  it("names the PERSON who decided it, not the member agent they acted through (migration 53)", async () => {
    const decided = approval({ status: "approved", decided_by_agent_name: "Ada (2)", decided_by_person_name: "Ada" });
    const fetchMock = vi.fn(async () => json(200, { approval: decided }));
    const { showFocusedApproval } = loadConsole(fetchMock);
    await showFocusedApproval("appr1");
    const text = $("focused-approval-overlay").textContent ?? "";
    expect(text).toContain("Already approved by Ada.");
    expect(text).not.toContain("Ada (2)");
  });
});

describe("push devices card", () => {
  it("hides the card entirely when push isn't configured on this hub", async () => {
    const fetchMock = vi.fn(async () => json(200, { enabled: false, publicKey: null, devices: [] }));
    const { refreshPushCard } = loadConsole(fetchMock);
    await refreshPushCard();
    expect($("push-card").hidden).toBe(true);
  });

  it("lists devices and shows a failing one distinctly", async () => {
    const fetchMock = vi.fn(async () => json(200, {
      enabled: true, publicKey: "abc",
      devices: [
        { id: "d1", endpoint: "https://fcm.googleapis.com/x", service: "fcm.googleapis.com", deviceLabel: "Chrome on Mac", createdAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastFailureAt: null, failing: false },
        { id: "d2", endpoint: "https://push.apple.com/y", service: "push.apple.com", deviceLabel: null, createdAt: new Date().toISOString(), lastSuccessAt: null, lastFailureAt: new Date().toISOString(), failing: true },
      ],
    }));
    const { refreshPushCard } = loadConsole(fetchMock);
    await refreshPushCard();
    expect($("push-card").hidden).toBe(false);
    const rows = document.querySelectorAll(".push-device-row");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("Chrome on Mac");
    expect(rows[1].classList.contains("push-device-row-failing")).toBe(true);
    expect(rows[1].textContent).toContain("not delivering");
  });

  it("says, in sight and before it is turned on, that commands show on the lock screen", async () => {
    const fetchMock = vi.fn(async () => json(200, { enabled: true, publicKey: "abc", devices: [] }));
    const { refreshPushCard } = loadConsole(fetchMock);
    await refreshPushCard();
    const note = $("push-privacy");
    expect(note.textContent).toBe("Commands show on the lock screen.");
    // Not folded into a closed <details>, and beside the button that turns notifications on.
    expect(note.closest("details")).toBeNull();
    expect(note.hidden).toBe(false);
    expect(note.nextElementSibling?.id).toBe("push-body");
    expect(($("push-enable-btn") as HTMLElement).hidden).toBe(false);
  });

  it("removing a device calls DELETE with its endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === "DELETE") return json(204, {});
      return json(200, { enabled: true, publicKey: "abc", devices: [{ id: "d1", endpoint: "https://fcm.googleapis.com/x", service: "fcm.googleapis.com", deviceLabel: null, createdAt: new Date().toISOString(), lastSuccessAt: null, lastFailureAt: null, failing: false }] });
    });
    const { refreshPushCard } = loadConsole(fetchMock);
    await refreshPushCard();
    document.querySelector(".push-device-row button")!.dispatchEvent(new Event("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    const del = fetchMock.mock.calls.find(([, opts]) => (opts as { method?: string } | undefined)?.method === "DELETE");
    expect(del).toBeTruthy();
    expect(JSON.parse((del![1] as { body: string }).body)).toEqual({ endpoint: "https://fcm.googleapis.com/x" });
  });
});

describe("sign-out removes this browser's device first", () => {
  it("calls DELETE /v1/push/devices before POST /v1/auth/signout", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      calls.push(`${opts?.method ?? "GET"} ${url}`);
      if (url === "/v1/push/devices" && opts?.method === "DELETE") return json(204, {});
      return json(200, { ok: true });
    });
    // A registered service worker with an active push subscription for this browser.
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: async () => ({
          pushManager: { getSubscription: async () => ({ endpoint: "https://fcm.googleapis.com/this-browser" }) },
        }),
      },
    });
    const { signOut, setAuthMode } = loadConsole(fetchMock);
    setAuthMode("session");
    signOut();
    // signOut() fires these without awaiting; a macrotask flush drains the whole chain
    // (getRegistration -> getSubscription -> DELETE -> signout) regardless of its depth.
    await new Promise((r) => setTimeout(r, 0));

    const deleteIdx = calls.findIndex((c) => c === "DELETE /v1/push/devices");
    const signoutIdx = calls.findIndex((c) => c === "POST /v1/auth/signout");
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(signoutIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(signoutIdx);
  });

  it("never blocks or breaks sign-out when there's no subscription to remove", async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    const { signOut, setAuthMode } = loadConsole(fetchMock);
    setAuthMode("session");
    expect(() => signOut()).not.toThrow();
    expect($("signin").hidden).toBe(false);
  });
});
