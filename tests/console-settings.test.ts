// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hubReadBody } from "./helpers/console-hub-reads.js";

describe("Console Organization & Settings Panel", () => {
  beforeEach(() => {
    let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
    html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    document.documentElement.innerHTML = html;
  });

  it("has settings tab and panel in index.html", () => {
    const tab = document.querySelector('button[data-tab="settings"]');
    expect(tab).toBeTruthy();
    expect(tab?.textContent?.trim()).toBe("Settings");

    const panel = document.querySelector('section[data-panel="settings"]');
    expect(panel).toBeTruthy();
    expect(document.getElementById("settings-org-name")).toBeTruthy();
    expect(document.getElementById("settings-org-id")).toBeTruthy();
    expect(document.getElementById("settings-hub-url")).toBeTruthy();
    expect(document.getElementById("settings-session-name")).toBeTruthy();
    // The fleet numbers moved to Home's status line (docs/design/CONSOLE-V2.md V8); console-settings-grid pins that.
    expect(document.getElementById("webhook-url")).toBeTruthy();
    expect(document.getElementById("webhook-auth")).toBeTruthy();
  });

  it("renderSettings populates the workspace details and the webhook URL", () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    const scriptFn = new Function(
      "window",
      "document",
      "localStorage",
      "fetch",
      `${appJs}; return { renderSettings, setMe: (val) => { me = val; } };`
    );

    const apiFetch = vi.fn();
    const { renderSettings, setMe } = scriptFn(window, document, window.localStorage, apiFetch);

    setMe({
      agentId: "agent-123",
      agentName: "Antigravity-Session",
      orgId: "org-abc-456",
      orgName: "Fleet Alpha",
      webhook_url: "https://example.com/hook",
      webhook_auth_set: true,
    });

    const mockAgents = [
      { id: "agent-123", name: "Antigravity-Session", online: true },
      { id: "agent-456", name: "ClaudeCode-Session", online: false },
      { id: "agent-789", name: "Cursor-Session", online: true },
    ];
    const mockTasks = [
      { id: "t1", status: "open" },
      { id: "t2", status: "claimed" },
      { id: "t3", status: "completed" },
    ];
    const mockGrants = [
      { id: "g1", category: "deploy" },
      { id: "g2", category: "restart" },
    ];

    renderSettings(mockAgents, mockTasks, mockGrants);

    expect(document.getElementById("settings-org-name")?.textContent).toBe("Fleet Alpha");
    expect(document.getElementById("settings-org-id")?.textContent).toBe("org-abc-456");
    expect(document.getElementById("settings-session-name")?.textContent).toBe("Antigravity-Session");

    const webhookInput = document.getElementById("webhook-url");
    expect(webhookInput.value).toBe("https://example.com/hook");
    const webhookAuth = document.getElementById("webhook-auth");
    expect(webhookAuth.placeholder).toContain("Configured");
  });

  it("submits webhook form and clears webhook", async () => {
    const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
    // The webhook routes answer { ok: true }; the console's refresh() reads (/v1/me, /v1/approvals, ...) answer the
    // shape src/rest.ts really returns, so each refresh renders instead of throwing on a field the body lacks.
    const apiFetch = vi.fn(async (url: string) => {
      const body = hubReadBody(url) ?? { ok: true };
      return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
    });

    const scriptFn = new Function(
      "window",
      "document",
      "localStorage",
      "fetch",
      `${appJs}; return { setAgentKey: (k) => { agentKey = k; } };`
    );

    const { setAgentKey } = scriptFn(window, document, window.localStorage, apiFetch);
    setAgentKey("agt_test_key");

    const webhookUrlInput = document.getElementById("webhook-url");
    const webhookAuthInput = document.getElementById("webhook-auth");
    const form = document.getElementById("webhook-form");

    webhookUrlInput.value = "https://notify.example.com/agent";
    webhookAuthInput.value = "Bearer my-token";

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/webhook",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "https://notify.example.com/agent", authHeader: "Bearer my-token" }),
      })
    );

    // Test clear button
    const clearBtn = document.getElementById("webhook-clear-btn");
    clearBtn.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/webhook",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: null }),
      })
    );
    expect(webhookUrlInput.value).toBe("");
    expect(webhookAuthInput.value).toBe("");
  });
});
