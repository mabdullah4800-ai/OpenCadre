// @vitest-environment happy-dom
// Console shell, Task 4 (docs/superpowers/plans/2026-09-29-console-shell.md): every nav item, in every place the
// console shows one (sidebar, icon rail, phone bottom bar, More drawer, Settings' sidebar list and its strip), is a real
// button or link the Tab key stops on, with the PR2 focus ring (2px, --ink) where the keyboard can see it. On main the
// bottom bar's ring was drawn 2px OUTSIDE items that touch the screen's left and bottom edges, so part of it was off
// screen; it is drawn inside those items now.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computed, CONSOLE_LAYOUT_STYLESHEETS, parseRules } from "./helpers/css-cascade.js";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const RULES = parseRules(CONSOLE_LAYOUT_STYLESHEETS);
const RING = "2px solid var(--ink)";

function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${appJs}; return { selectTab, openMoreDrawer };`)(
    window, document, window.localStorage, vi.fn(async () => json(200, {})),
  ) as { selectTab: (name: string) => void; openMoreDrawer: () => void };
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  history.replaceState(null, "", "/app/");
  $("console").hidden = false;
});

// Each place a nav item lives, the width at which that place is on screen, and its items.
const PLACES: Array<{ name: string; width: number; items: () => HTMLElement[] }> = [
  { name: "sidebar", width: 1440, items: () => [...document.querySelectorAll<HTMLElement>("#tabs-nav > *:not(hr)")] },
  { name: "icon rail", width: 1100, items: () => [...document.querySelectorAll<HTMLElement>("#tabs-nav > *:not(hr)")] },
  { name: "bottom bar", width: 375, items: () => [...document.querySelectorAll<HTMLElement>("#bottom-bar > *")] },
  { name: "More drawer", width: 375, items: () => [...document.querySelectorAll<HTMLElement>(".drawer-nav > *, #find-btn-mobile, #signout-mobile")] },
  { name: "Settings sidebar list", width: 1440, items: () => [...document.querySelectorAll<HTMLElement>("#settings-subnav > *")] },
  { name: "Settings strip", width: 375, items: () => [...document.querySelectorAll<HTMLElement>("#settings-index > *")] },
];

describe("every nav item is a Tab stop", () => {
  for (const place of PLACES) {
    it(`${place.name}: each item is a button or a link with an address, and none is taken out of the tab order`, () => {
      const items = place.items();
      expect(items.length).toBeGreaterThan(2);
      for (const item of items) {
        const what = item.textContent!.trim() || item.id;
        expect(item.tagName === "BUTTON" || (item.tagName === "A" && item.hasAttribute("href")), what).toBe(true);
        expect(item.getAttribute("tabindex"), what).toBeNull();
        expect((item as HTMLButtonElement).disabled ?? false, what).toBe(false);
      }
    });
  }

  it("Settings' page links become Tab stops when Settings opens, and the sidebar's section list steps aside", () => {
    const { selectTab } = loadConsole();
    selectTab("settings");
    expect($("settings-subnav").hidden).toBe(false);
    expect($("tabs-nav").hidden).toBe(true);
    const shown = [...document.querySelectorAll<HTMLElement>("#settings-subnav a, #settings-index a")].filter((a) => !a.closest("[hidden]"));
    expect(shown.length).toBe(12 - [...document.querySelectorAll("#settings-subnav a[hidden], #settings-index a[hidden]")].length);
    expect(shown.length).toBeGreaterThan(0);
  });

  it("the More drawer, once open, holds focus on its own items", () => {
    const { openMoreDrawer } = loadConsole();
    openMoreDrawer();
    expect($("more-drawer").contains(document.activeElement)).toBe(true);
  });
});

describe("every nav item shows the focus ring where the keyboard can see it", () => {
  for (const place of PLACES) {
    it(`${place.name}: ${RING}`, () => {
      for (const item of place.items()) {
        const s = computed(item, RULES, { width: place.width }, { focus: true });
        expect(s.outline, item.textContent!.trim()).toBe(RING);
      }
    });
  }

  it("the bottom bar draws it inside each item: they touch the screen's left and bottom edges", () => {
    for (const item of PLACES[2].items()) {
      expect(computed(item, RULES, { width: 375 }, { focus: true })["outline-offset"], item.textContent!.trim()).toBe("-2px");
    }
    // Elsewhere the ring keeps its 2px gap outside the item.
    const home = document.querySelector<HTMLElement>('#tabs-nav [data-tab="overview"]')!;
    expect(computed(home, RULES, { width: 1440 }, { focus: true })["outline-offset"]).toBe("2px");
  });

  it("the instrument sees focus state: without focus there is no outline rule on a nav item", () => {
    const home = document.querySelector<HTMLElement>('#tabs-nav [data-tab="overview"]')!;
    expect(computed(home, RULES, { width: 1440 }).outline).toBeUndefined();
  });
});
