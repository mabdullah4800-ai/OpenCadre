// @vitest-environment happy-dom
// Console shell, Task 1 (docs/superpowers/plans/2026-09-29-console-shell.md): the frame works for keyboard and
// screen-reader users. One h1 per view (the seven titles were h2, so no view had a top-level heading), a skip link as
// the first stop in the tab order that lands on main, and landmark names that tell the landmarks apart (two navs were
// both "Sections" and two were both "Settings sections").
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computed, CONSOLE_LAYOUT_STYLESHEETS, parseRules } from "./helpers/css-cascade.js";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const VIEWS = ["overview", "inbox", "fleet", "tasks", "timeline", "connect", "settings"];

function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${appJs}; return { selectTab };`)(
    window, document, window.localStorage, vi.fn(async () => json(200, {})),
  ) as { selectTab: (name: string) => void };
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  history.replaceState(null, "", "/app/");
  $("console").hidden = false; // signed in: the sign-in screens stay hidden
});

/** Shown, as far as markup decides it: no hidden ancestor, and inside a panel only when that panel is the active one.
 * Anything inside <noscript> is not shown: this whole file runs the console with scripting on, where a browser never
 * renders it (happy-dom parses its children as ordinary nodes). */
const shown = (node: Element) => !node.closest("[hidden], noscript") && (!node.closest(".panel") || node.closest(".panel")!.classList.contains("is-active"));

describe("one h1 per view", () => {
  for (const view of VIEWS) {
    it(`${view}: exactly one shown h1, the view's own title`, () => {
      const { selectTab } = loadConsole();
      selectTab(view);
      const h1s = [...document.querySelectorAll("h1")].filter(shown);
      expect(h1s.map((h) => h.id)).toEqual([`h-${view}`]);
      // The panel is still named by its title.
      expect(document.querySelector(`.panel[data-panel="${view}"]`)!.getAttribute("aria-labelledby")).toBe(h1s[0].id);
    });
  }

  it("the h1 is styled exactly as the h2 was: every .panel-head title rule names h1", () => {
    for (const file of ["public/app/app.css", "public/app/console-v2.css"]) {
      const css = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(css, file).not.toMatch(/\.panel-head h2\b/);
      expect(css, file).toMatch(/\.panel-head h1\b/);
    }
  });
});

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";
const tabStops = (root: Element) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
  .filter((n) => !(n as HTMLButtonElement).disabled && n.getAttribute("tabindex") !== "-1" && shown(n));

describe("only the active view is in the accessibility tree", () => {
  it("a panel is display:none unless it is the active one, so an inactive view's h1 is not announced", () => {
    const rules = parseRules(CONSOLE_LAYOUT_STYLESHEETS);
    const panel = document.querySelector('.panel[data-panel="inbox"]')!;
    for (const width of [375, 1100, 1440]) {
      panel.classList.remove("is-active");
      expect(computed(panel, rules, { width }).display, `inactive at ${width}`).toBe("none");
      panel.classList.add("is-active");
      expect(computed(panel, rules, { width }).display, `active at ${width}`).toBe("block");
    }
  });
});

describe("skip link", () => {
  it("is the first tab stop in the console and says where it goes", () => {
    loadConsole();
    const first = tabStops($("console"))[0];
    expect(first.tagName).toBe("A");
    expect(first.textContent!.trim()).toBe("Skip to content");
    expect(first.getAttribute("href")).toBe("#main");
    const main = document.querySelector("main")!;
    expect(main.id).toBe("main");
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("moves focus to main without rewriting the view's address", () => {
    const { selectTab } = loadConsole();
    selectTab("tasks");
    const before = location.hash;
    const link = tabStops($("console"))[0];
    link.focus();
    link.click();
    expect(document.activeElement).toBe(document.querySelector("main"));
    expect(location.hash).toBe(before);
    expect(document.querySelector('.panel[data-panel="tasks"]')!.classList.contains("is-active")).toBe(true);
  });

  it("is visually hidden until focused, then shown at the top left (the rules that win on it, at every width)", () => {
    const rules = parseRules(CONSOLE_LAYOUT_STYLESHEETS);
    for (const width of [375, 1100, 1440]) {
      const idle = computed($("skip-link"), rules, { width });
      // clip does nothing on a box that is not positioned, so each part of the pattern is asserted.
      expect([idle.display, idle.position, idle.width, idle.height, idle["overflow-x"], idle.clip], `unfocused at ${width}`)
        .toEqual([undefined, "absolute", "1px", "1px", "hidden", "rect(0 0 0 0)"]);
      const focused = computed($("skip-link"), rules, { width }, { focus: true });
      expect([focused.position, focused.top, focused.left, focused.clip, focused.width], `focused at ${width}`)
        .toEqual(["fixed", "8px", "8px", undefined, undefined]);
    }
  });
});

/** The accessible name a landmark gets from aria-label or aria-labelledby (text of the referenced nodes). */
function nameOf(node: Element): string | null {
  const label = node.getAttribute("aria-label");
  if (label) return label.trim();
  const by = node.getAttribute("aria-labelledby");
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim();
  return null;
}

describe("landmark names", () => {
  it("every named landmark (nav, main, aside, header, footer, named section) and dialog has a unique name", () => {
    loadConsole();
    const landmarks = [...document.querySelectorAll("#console nav, #console main, #console aside, #console header, #console footer, #console section, #console [role=dialog]")];
    const named = landmarks.map((n) => ({ tag: n.tagName.toLowerCase(), id: n.id, name: nameOf(n) })).filter((l) => l.name);
    const byName = new Map<string, string[]>();
    for (const l of named) byName.set(l.name!, [...(byName.get(l.name!) ?? []), `${l.tag}#${l.id}`]);
    const duplicates = [...byName].filter(([, where]) => where.length > 1);
    expect(duplicates).toEqual([]);
    // Every nav is named, so a screen reader's landmark list can tell them apart.
    expect([...document.querySelectorAll("#console nav")].filter((n) => !nameOf(n)).map((n) => n.id)).toEqual([]);
  });

  it("names the four section navs for what they hold", () => {
    expect(nameOf($("tabs-nav"))).toBe("Sections");
    expect(nameOf($("bottom-bar"))).toBe("Sections, phone bar");
    expect(nameOf($("settings-subnav"))).toBe("Settings pages");
    expect(nameOf($("settings-index"))).toBe("Settings sections");
  });
});
