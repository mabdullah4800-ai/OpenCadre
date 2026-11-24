// @vitest-environment happy-dom
// UX batch 1, fix 7 (Codex audit), the console: the key sign-in hint asked for "an 'Operator' key" without saying what
// that is. Red before the fix: the hint was jargon. A workspace with no plan says so plainly on its plan card.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { renderBilling, setMe: (v) => { me = v; }, activeTab: () => activeTab };`,
  )(window, document, window.localStorage, vi.fn(async (path: string) => {
    return json(200, {});
  })) as { renderBilling: (counts?: unknown) => void; setMe: (v: unknown) => void; activeTab: () => string };
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  localStorage.clear();
});

describe("plain words", () => {
  it("the key sign-in hint explains what an agent key is and which one to use", () => {
    const hint = document.querySelector("#signin-key-form .field-hint")!.textContent ?? "";
    expect(hint).not.toMatch(/"Operator" key/);
    expect(hint).toMatch(/agt_/);
    expect(hint).toMatch(/approve/i);
    expect(hint).toMatch(/only in this browser/i);
    // Shown, not kept for screen readers only or in a tooltip.
    const node = document.querySelector("#signin-key-form .field-hint")!;
    expect(node.classList.contains("visually-hidden")).toBe(false);
    expect(document.querySelector("#signin-key-form [title]")).toBeNull();
  });

  it("the organization key field says, in sight, that the key is never stored", () => {
    const field = document.getElementById("org-key-field")!;
    const hint = field.querySelector(".field-hint") as HTMLElement;
    expect(hint.textContent).toBe("Used for this request only. Never stored.");
    expect(hint.classList.contains("visually-hidden")).toBe(false);
    expect(document.getElementById("org-key")!.getAttribute("aria-describedby")).toBe(hint.id);
    expect(field.querySelector("[title]")).toBeNull();
  });

  it("a workspace with no plan says so plainly on its plan card, with no plan chooser", () => {
    const c = loadConsole();
    c.setMe({ orgId: "org-1", agentId: "me", role: "operator", billing: { plan: "none", planName: "No plan yet", awaitingPlan: true, limits: {} } });
    c.renderBilling({});
    expect($("billing-plan").textContent).toBe("No plan yet");
    expect($("billing-usage").hidden).toBe(true);
    expect($("billing-card").querySelectorAll("button, a")).toHaveLength(0);
  });

  it("a workspace that already has a plan shows its name and its usage", () => {
    const c = loadConsole();
    c.setMe({ orgId: "org-1", agentId: "me", role: "operator", billing: { plan: "pro", planName: "Pro", limits: {} } });
    c.renderBilling({});
    expect($("billing-plan").textContent).toBe("Pro");
    expect($("billing-usage").hidden).toBe(false);
  });
});
