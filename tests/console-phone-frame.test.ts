// @vitest-environment happy-dom
// Console shell, Task 3 (docs/superpowers/plans/2026-09-29-console-shell.md): the phone frame. The fixed bottom bar
// must never cover the page's last rows or a toast, on a phone with a home indicator too (env(safe-area-inset-bottom)),
// and Settings' tab strip must say which page is open, bring it into view, and show that it scrolls. CSS is read with
// the cascade helper (the rule that wins on the real element at that width), behaviour through app.js in happy-dom.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computed, CONSOLE_LAYOUT_STYLESHEETS, parseRules } from "./helpers/css-cascade.js";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const RULES = parseRules(CONSOLE_LAYOUT_STYLESHEETS);
const PHONE = { width: 375 };
const DESKTOP = { width: 1440 };
const at = (node: Element, env: { width: number }) => computed(node, RULES, env);
const INSET = "env(safe-area-inset-bottom)";

function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function("window", "document", "localStorage", "fetch", `${appJs}; return { selectTab, scrollToSettingsSection, renderSettingsIndex };`)(
    window, document, window.localStorage, vi.fn(async () => json(200, {})),
  ) as {
    selectTab: (name: string) => void;
    scrollToSettingsSection: (key: string, o?: { record?: boolean }) => void;
    renderSettingsIndex: () => void;
  };
}

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  history.replaceState(null, "", "/app/");
  $("console").hidden = false;
});

describe("the bottom bar covers nothing", () => {
  it("the page reserves the bar's height plus the home-indicator inset below its last row", () => {
    const main = document.querySelector(".shell-main")!;
    const pad = at(main, PHONE)["padding-bottom"];
    expect(pad).toContain(INSET);
    expect(pad).toContain("var(--bottom-bar-space)");
    expect(at(main, DESKTOP)["padding-bottom"]).toBeUndefined();
  });

  it("the space reserved is at least the bar's own height: its items' min-height plus its top rule (53px measured at 375)", () => {
    const space = at(document.documentElement, PHONE)["--bottom-bar-space"];
    expect(space).toMatch(/^\d+px$/);
    const item = at(document.querySelector(".bottom-bar-item")!, PHONE);
    const bar = at($("bottom-bar"), PHONE);
    // The items' min-height includes their padding (app.css sets box-sizing: border-box on *), and the bar adds no
    // padding of its own above them, only its 1px top rule (and the inset below, reserved separately).
    expect(bar["padding-top"]).toBeUndefined();
    const barHeight = parseFloat(item["min-height"]) + parseFloat(bar["border-top"]);
    expect([item["min-height"], bar["border-top"], barHeight]).toEqual(["52px", "1px solid var(--line)", 53]);
    expect(parseFloat(space)).toBeGreaterThanOrEqual(barHeight);
  });

  it("the bar itself pads by the inset", () => {
    expect(at($("bottom-bar"), PHONE)["padding-bottom"]).toBe(INSET);
  });

  it("a toast sits above the bar on a phone, and where it was on a larger screen", () => {
    const phone = at($("toast"), PHONE).bottom;
    expect(phone).toContain("var(--bottom-bar-space)");
    expect(phone).toContain(INSET);
    expect(at($("toast"), DESKTOP).bottom).toBe(`calc(18px + ${INSET})`);
  });
});

describe("Settings' tab strip on a phone", () => {
  const link = (key: string) => document.querySelector(`#settings-index [data-settings-section="${key}"]`) as HTMLElement;

  it("marks the open page with aria-current=page, in the strip and in the sidebar list, and only that one", () => {
    const { selectTab, scrollToSettingsSection } = loadConsole();
    selectTab("settings");
    scrollToSettingsSection("notifications");
    const current = [...document.querySelectorAll("#settings-index a[aria-current], #settings-subnav a[aria-current]")];
    expect(current.map((a) => [a.closest("nav")!.id, a.getAttribute("data-settings-section"), a.getAttribute("aria-current")])).toEqual([
      ["settings-subnav", "webhook-card", "page"],
      ["settings-index", "webhook-card", "page"],
    ]);
  });

  it("styles the open page the way the sidebar list does", () => {
    const { selectTab, scrollToSettingsSection } = loadConsole();
    selectTab("settings");
    scrollToSettingsSection("people");
    scrollToSettingsSection("workspace");
    const open = at(link("settings-org-card"), PHONE);
    const sidebar = at(document.querySelector('#settings-subnav [data-settings-section="settings-org-card"]')!, DESKTOP);
    for (const prop of ["background", "color", "font-weight"]) expect(open[prop], prop).toBe(sidebar[prop]);
    expect(at(link("billing-card"), PHONE)["font-weight"]).toBeUndefined();
  });

  it("scrolls the open page's tab into view, and only the strip, when the strip overflows", () => {
    const { selectTab, scrollToSettingsSection } = loadConsole();
    const strip = $("settings-index");
    Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => 375 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => 640 });
    const target = link("webhook-card");
    Object.defineProperty(target, "offsetLeft", { configurable: true, get: () => 520 });
    Object.defineProperty(target, "offsetWidth", { configurable: true, get: () => 100 });
    selectTab("settings");
    scrollToSettingsSection("notifications");
    // Its right edge (620) plus the strip's 16px gutter lands at the strip's right edge.
    expect(strip.scrollLeft).toBe(620 - 375 + 16);
    // Back to a tab already in view: nothing moves.
    const first = link("billing-card");
    Object.defineProperty(first, "offsetLeft", { configurable: true, get: () => 16 });
    Object.defineProperty(first, "offsetWidth", { configurable: true, get: () => 100 });
    strip.scrollLeft = 0;
    scrollToSettingsSection("billing");
    expect(strip.scrollLeft).toBe(0);
  });

  it("does not snap back while someone scrolls it: the 4s poll re-renders Settings on the same page and leaves the strip alone", () => {
    const { selectTab, scrollToSettingsSection } = loadConsole();
    const strip = $("settings-index");
    Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => 375 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => 640 });
    const target = link("webhook-card");
    Object.defineProperty(target, "offsetLeft", { configurable: true, get: () => 520 });
    Object.defineProperty(target, "offsetWidth", { configurable: true, get: () => 100 });
    selectTab("settings");
    scrollToSettingsSection("notifications");
    expect(strip.scrollLeft).toBe(261);
    strip.scrollLeft = 40; // the person scrolls the strip
    // What renderSettings does on every poll (app.js): the same page, not recorded.
    scrollToSettingsSection("notifications", { record: false });
    expect(strip.scrollLeft).toBe(40);
    // Opening Settings again still brings the open tab into view (display:none reset the strip's scroll).
    selectTab("overview");
    strip.scrollLeft = 0;
    selectTab("settings");
    expect(strip.scrollLeft).toBe(261);
  });

  it("brings the open tab back into view when tabs appear before it (the first poll learns which pages this person sees)", () => {
    // Measured on a deep link to #/settings/notifications at 375: the strip revealed Notifications with three tabs
    // hidden, the first poll un-hid People, Projects and Safety, and Notifications was pushed half out of view.
    const { selectTab, scrollToSettingsSection, renderSettingsIndex } = loadConsole();
    const strip = $("settings-index");
    let offset = 220;
    Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => 375 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => offset + 116 });
    const target = link("webhook-card");
    Object.defineProperty(target, "offsetLeft", { configurable: true, get: () => offset });
    Object.defineProperty(target, "offsetWidth", { configurable: true, get: () => 100 });
    renderSettingsIndex(); // People, Projects and Safety: their cards are hidden until the hub says who you are
    selectTab("settings");
    scrollToSettingsSection("notifications");
    expect(strip.scrollLeft).toBe(0); // 220..320 fits in 375
    for (const id of ["members-card", "projects-card", "policy-card"]) $(id).hidden = false;
    offset = 520;
    renderSettingsIndex();
    expect(strip.scrollLeft).toBe(620 - 375 + 16);
    // A re-render with nothing new leaves a scrolled strip alone.
    strip.scrollLeft = 40;
    renderSettingsIndex();
    expect(strip.scrollLeft).toBe(40);
  });

  it("says there is more with an edge fade, only while it overflows, on the side the more is", () => {
    const { selectTab } = loadConsole();
    const strip = $("settings-index");
    let scrollWidth = 375;
    Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => 375 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => scrollWidth });
    selectTab("settings");
    expect(strip.dataset.more).toBeUndefined();
    scrollWidth = 640;
    strip.scrollLeft = 0;
    strip.dispatchEvent(new Event("scroll"));
    expect(strip.dataset.more).toBe("end");
    strip.scrollLeft = 100;
    strip.dispatchEvent(new Event("scroll"));
    expect(strip.dataset.more).toBe("both");
    strip.scrollLeft = 640 - 375;
    strip.dispatchEvent(new Event("scroll"));
    expect(strip.dataset.more).toBe("start");
  });

  it("writes the fade attribute only when it changes, not on every scroll event", async () => {
    const { selectTab } = loadConsole();
    const strip = $("settings-index");
    Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => 375 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => 640 });
    selectTab("settings");
    strip.scrollLeft = 100;
    strip.dispatchEvent(new Event("scroll"));
    expect(strip.dataset.more).toBe("both");
    const writes: string[] = [];
    const observer = new MutationObserver((records) => writes.push(...records.map((r) => r.attributeName!)));
    observer.observe(strip, { attributes: true, attributeFilter: ["data-more"] });
    for (const left of [110, 120, 130]) { strip.scrollLeft = left; strip.dispatchEvent(new Event("scroll")); }
    await new Promise((r) => setTimeout(r, 0));
    expect(writes).toEqual([]);
    strip.scrollLeft = 0;
    strip.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 0));
    observer.disconnect();
    expect(writes).toEqual(["data-more"]);
    expect(strip.dataset.more).toBe("end");
  });

  it("the fade is a mask on the strip in the phone range, keyed to that attribute", () => {
    const strip = $("settings-index");
    expect(at(strip, PHONE)["mask-image"]).toBeUndefined();
    for (const side of ["end", "start", "both"]) {
      strip.dataset.more = side;
      const s = at(strip, PHONE);
      expect(s["mask-image"], side).toMatch(/^linear-gradient\(.*transparent/);
      expect(s["-webkit-mask-image"], side).toBe(s["mask-image"]);
    }
  });
});
