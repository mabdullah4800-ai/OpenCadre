// @vitest-environment happy-dom
// UX batch 1, fix 4 (Codex audit): the phone's More drawer is declared role="dialog" aria-modal="true", but opening it
// only un-hid it. Focus stayed on the More button behind it, Tab walked out into the page underneath, and that page was
// still reachable by keyboard and screen reader. Red before the fix: focus never entered the drawer, Tab was not
// trapped, nothing was inert, and closing left focus wherever it happened to be.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const BACKGROUND = ["skip-link", "sidebar", "bottom-bar"];

function loadConsole() {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  // A hub that never answers: boot() would otherwise land on the sign-in page and hide the console under the test.
  new Function("window", "document", "localStorage", "fetch", appJs)(window, document, window.localStorage, vi.fn(() => new Promise(() => {})));
}
const tab = (target: Element, shiftKey = false) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
const background = () => [...BACKGROUND.map((id) => $(id)), document.querySelector(".shell-main") as HTMLElement];

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
  loadConsole();
  $("console").hidden = false;
});

describe("the More drawer behaves as the modal it says it is", () => {
  it("moves focus into the drawer and makes the page behind it inert", () => {
    $("more-btn").focus();
    $("more-btn").click();
    expect(document.activeElement).toBe($("more-drawer-close"));
    for (const region of background()) expect(region.hasAttribute("inert")).toBe(true);
    expect($("more-drawer").hasAttribute("inert")).toBe(false);
  });

  it("traps Tab and Shift+Tab inside, wrapping at both ends", () => {
    $("more-btn").click();
    const last = $("signout-mobile");
    last.focus();
    tab(last);
    expect(document.activeElement).toBe($("more-drawer-close"));
    tab($("more-drawer-close"), true);
    expect(document.activeElement).toBe(last);
  });

  it("Escape closes it, lifts inert and puts focus back on More", () => {
    $("more-btn").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($("more-drawer").hidden).toBe(true);
    for (const region of background()) expect(region.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe($("more-btn"));
  });

  it("the close button and the backdrop restore focus to More too", () => {
    $("more-btn").click();
    $("more-drawer-close").click();
    expect(document.activeElement).toBe($("more-btn"));
    $("more-btn").click();
    $("more-drawer-backdrop").click();
    expect(document.activeElement).toBe($("more-btn"));
    for (const region of background()) expect(region.hasAttribute("inert")).toBe(false);
  });
});
