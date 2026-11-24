// @vitest-environment happy-dom
// Console shell, Task 2 (docs/superpowers/plans/2026-09-29-console-shell.md): at 1024-1279px the sidebar is a 64px
// icon rail. On main it clipped the Inbox badge and the account button, its icons had no names once their labels were
// display:none, Settings' own pages could not be reached at all, and Home's agent names were cut mid-glyph because the
// ellipsis sat on a flex box (text-overflow does nothing there). These read the rules that win on the real elements at
// 1100px (tests/helpers/css-cascade.ts); the bounding-box check lives in the harness probe (plan Task 5).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computed, CONSOLE_LAYOUT_STYLESHEETS, parseRules } from "./helpers/css-cascade.js";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const RULES = parseRules(CONSOLE_LAYOUT_STYLESHEETS);
const RAIL = { width: 1100 };
const DESKTOP = { width: 1440 };
const at = (node: Element, env: { width: number }) => computed(node, RULES, env);

function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${appJs}; return { homeSessionRow, sessionStrip, renderConnectComputers };`)(
    window, document, window.localStorage, vi.fn(async () => json(200, {})),
  ) as {
    homeSessionRow: (s: unknown) => HTMLElement;
    sessionStrip: (s: unknown, isEnded: boolean, o?: unknown) => HTMLElement;
    renderConnectComputers: (devices: unknown[], sessions: unknown[]) => void;
  };
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  $("console").hidden = false;
});

describe("the instrument (known positives from the source)", () => {
  it("reads the sidebar as the 64px rail at 1100 and the 240px sidebar at 1440", () => {
    expect(at($("sidebar"), RAIL).width).toBe("64px");
    expect(at($("sidebar"), DESKTOP).width).toBe("240px");
  });
});

describe("rail: nothing clipped", () => {
  it("the Inbox badge sits on its icon, positioned inside the nav item, not beside it", () => {
    const badge = $("inbox-badge");
    badge.hidden = false;
    const item = badge.closest(".nav-item")!;
    expect(at(item, RAIL).position).toBe("relative");
    const b = at(badge, RAIL);
    expect(b.position).toBe("absolute");
    expect(b["margin-left"]).toBe("0");
    // At full width it stays beside the label, as before.
    expect(at(badge, DESKTOP).position).toBeUndefined();
  });

  it("the account button has a row of its own in a one-column footer", () => {
    const footer = document.querySelector(".sidebar-bottom")!;
    const f = at(footer, RAIL);
    expect(f["grid-template-columns"]).toBe("1fr");
    expect(f["grid-template-areas"]).toBe('"avatar" "menu"');
    expect(at($("user-menu-btn"), RAIL)["grid-area"]).toBe("menu");
  });
});

/** Off screen but in the accessibility tree: a 1px, clipped, absolutely positioned box. clip does nothing on a box that
 * is not positioned, so each property is asserted, and display must not be none (that would drop the name). */
function expectVisuallyHidden(s: Record<string, string>, what: string) {
  expect(s.display, `${what}: display`).not.toBe("none");
  expect(s.position, `${what}: position`).toBe("absolute");
  expect(s.width, `${what}: width`).toBe("1px");
  expect(s.height, `${what}: height`).toBe("1px");
  expect(s["overflow-x"], `${what}: overflow`).toBe("hidden");
  expect(s.clip, `${what}: clip`).toBe("rect(0 0 0 0)");
}

describe("rail: every icon is named", () => {
  it("nav labels stay in the accessibility tree (visually hidden, not display:none), and each item has a tooltip", () => {
    for (const item of document.querySelectorAll(".sidebar-nav .nav-item")) {
      const label = item.querySelector(".nav-label")!;
      const s = at(label, RAIL);
      expectVisuallyHidden(s, label.textContent!);
      expect(item.getAttribute("title")).toBe(label.textContent!.trim());
      expect(at(label, DESKTOP).clip).toBeUndefined();
    }
  });

  it("Find and the settings back button keep their words for screen readers; the account button has a tooltip", () => {
    for (const span of [document.querySelector(".find-btn span")!, document.querySelector(".settings-back span")!]) {
      expectVisuallyHidden(at(span, RAIL), span.textContent!);
    }
    expect($("find-btn").getAttribute("title")).toBe("Find (F)");
    expect($("user-menu-btn").getAttribute("aria-label")).toBe("Account menu");
    expect($("user-menu-btn").getAttribute("title")).toBe("Account menu");
  });

  it("Settings' pages stay reachable: the rail cannot list them, so the in-page strip shows", () => {
    expect(at($("settings-index"), RAIL).display).not.toBe("none");
    expect(at($("settings-index"), DESKTOP).display).toBe("none");
    expect(at($("settings-index"), { width: 800 }).display).toBe("none");
  });
});

describe("Home's agent names ellipsize", () => {
  it("a long name is one line ending in an ellipsis (a block box, since text-overflow does nothing on a flex box), with the full name in its title", () => {
    const { homeSessionRow } = loadConsole();
    const row = homeSessionRow({ agentId: "a1", agentName: "ClaudeCode-web-ed75f0c1", tool: "claude", online: true, liveness: "live", lastHeartbeatAt: null });
    $("overview-happening").append(row);
    const name = row.querySelector(".callsign")!;
    expect(name.getAttribute("title")).toContain("ClaudeCode-web-ed75f0c1");
    for (const env of [RAIL, DESKTOP, { width: 375 }]) {
      const s = at(name, env);
      expect(["flex", "inline-flex", "grid"], `display at ${env.width}`).not.toContain(s.display);
      expect(s["overflow-x"], `overflow at ${env.width}`).toBe("hidden");
      expect(s["text-overflow"], `text-overflow at ${env.width}`).toBe("ellipsis");
      expect(s["white-space"], `white-space at ${env.width}`).toBe("nowrap");
    }
  });
});

/** One line that ends in "…" at the rail, desktop and phone widths: a block box (not flex or grid), clipped, unwrapped. */
function expectEllipsis(node: Element, what: string) {
  for (const env of [RAIL, DESKTOP, { width: 375 }]) {
    const s = at(node, env);
    expect(["flex", "inline-flex", "grid", "inline-grid"], `${what}: display at ${env.width}`).not.toContain(s.display);
    expect(s["overflow-x"], `${what}: overflow at ${env.width}`).toBe("hidden");
    expect(s["text-overflow"], `${what}: text-overflow at ${env.width}`).toBe("ellipsis");
    expect(s["white-space"], `${what}: white-space at ${env.width}`).toBe("nowrap");
  }
}

// The same flex-box ellipsis defect elsewhere in the console's rows, found by a rendered sweep of every view at 1024
// and 375 (every element whose computed text-overflow is ellipsis while its display is flex or grid): the Agents row's
// name and Add a computer's per-computer status.
describe("the same fix in the other rows that ellipsize", () => {
  it("Agents: a session row's name ends in an ellipsis, with the full name in its title", () => {
    const { sessionStrip } = loadConsole();
    const row = sessionStrip({ agentId: "a2", agentName: "ClaudeCode-OpenCadre-web-ed75f0c1", tool: "claude", online: true, liveness: "live", lastHeartbeatAt: null }, false);
    const group = document.createElement("div");
    group.className = "strips";
    group.append(row);
    $("fleet-groups").append(group);
    const name = row.querySelector(".callsign")!;
    expect(name.textContent).toBe("ClaudeCode-OpenCadre-web-ed75f0c1");
    expect(name.getAttribute("title")).toBe("ClaudeCode-OpenCadre-web-ed75f0c1");
    expectEllipsis(name, "Agents row name");
  });

  it("Add a computer: a computer's status ends in an ellipsis (the dot is an inline box in front of it)", () => {
    const { renderConnectComputers } = loadConsole();
    renderConnectComputers([{ deviceId: "d1", name: "Build server in the far rack", status: "waiting", tools: ["claude"], lastSeenAt: null }], []);
    const status = document.querySelector("#connect-computers-list .computer-row-status")!;
    expect(status.textContent).toBe("Waiting to connect");
    expectEllipsis(status, "computer status");
    const name = document.querySelector("#connect-computers-list .computer-row-name")!;
    expectEllipsis(name, "computer name");
    expect(name.getAttribute("title")).toBe("Build server in the far rack");
  });
});
