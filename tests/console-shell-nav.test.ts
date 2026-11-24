// @vitest-environment happy-dom
// Hub redesign Stage 1 (docs/design/HUB_REDESIGN.md, Section 7): app shell + sidebar nav, replacing
// the old horizontal tab bar. Structural chrome only -- every section keeps its existing content
// and endpoints; only the container changed.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadConsole(fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () => json(200, {}))) {
  const appJs = readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
  return new Function(
    "window", "document", "localStorage", "fetch",
    `${appJs}; return { selectTab, openMoreDrawer, closeMoreDrawer, syncBadgeMobile, paintSkeleton, setFirstRefreshDone: (v) => { firstRefreshDone = v; }, setApprovalStatus: (v) => { homeSources.approvals.status = v; } };`,
  )(window, document, window.localStorage, fetchMock) as {
    selectTab: (name: string) => void;
    openMoreDrawer: () => void;
    closeMoreDrawer: () => void;
    syncBadgeMobile: (id: string) => void;
    paintSkeleton: (id: string, count?: number) => void;
    setFirstRefreshDone: (v: boolean) => void;
    setApprovalStatus: (v: string) => void;
  };
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

beforeEach(() => {
  let html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  html = html.replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  document.documentElement.innerHTML = html;
});

describe("sidebar nav: every existing section is still reachable", () => {
  it("every one of the 7 sections has a sidebar nav-item with the right data-tab and a matching panel", () => {
    expect(document.querySelector('.sidebar-nav [data-tab="awareness"]')).toBeNull();
    for (const name of ["overview", "inbox", "fleet", "tasks", "timeline", "connect", "settings"]) {
      expect(document.querySelector(`.sidebar-nav [data-tab="${name}"]`)).toBeTruthy();
      expect(document.querySelector(`.panel[data-panel="${name}"]`)).toBeTruthy();
    }
  });

  it("selectTab() marks the right nav-item aria-current across all three copies (sidebar, bottom bar, drawer)", () => {
    const { selectTab } = loadConsole();
    selectTab("fleet");
    const current = document.querySelectorAll('[data-tab="fleet"][aria-current="page"]');
    // Fleet has 2 copies (sidebar + bottom bar), no drawer copy.
    expect(current.length).toBe(2);
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(2);

    selectTab("settings");
    // Settings has 2 copies (sidebar + drawer), no bottom-bar copy.
    expect(document.querySelectorAll('[data-tab="settings"][aria-current="page"]')).toHaveLength(2);
    // Settings' own page links (the sidebar list and the strip) mark their open page with aria-current="page" too, so
    // this counts the section navs' copies only.
    expect(document.querySelectorAll('[data-tab][aria-current="page"]')).toHaveLength(2);
    // ...and each Settings list marks exactly one page, the same one.
    for (const list of ["settings-subnav", "settings-index"]) {
      expect(document.querySelectorAll(`#${list} [aria-current="page"]`), list).toHaveLength(1);
      expect(document.querySelector(`#${list} [aria-current="page"]`)!.getAttribute("data-settings-section"), list).toBe("billing-card");
    }
  });

  it("clicking any of a section's nav-item copies activates the same panel", () => {
    const { selectTab } = loadConsole();
    selectTab("inbox");
    // The drawer copy of "settings" should switch to the settings panel just like the sidebar one.
    document.querySelector<HTMLButtonElement>('.drawer-nav [data-tab="settings"]')!.click();
    expect(document.querySelector('.panel[data-panel="settings"]')!.classList.contains("is-active")).toBe(true);
    expect(document.querySelector('.panel[data-panel="inbox"]')!.classList.contains("is-active")).toBe(false);
  });
});

describe("mobile 'More' drawer", () => {
  it("starts closed", () => {
    expect($("more-drawer").hidden).toBe(true);
    expect($("more-drawer-backdrop").hidden).toBe(true);
  });

  it("opens on the More button, closes on the close button, backdrop, or Escape", () => {
    loadConsole();
    $("more-btn").click();
    expect($("more-drawer").hidden).toBe(false);
    expect($("more-btn").getAttribute("aria-expanded")).toBe("true");

    $("more-drawer-close").click();
    expect($("more-drawer").hidden).toBe(true);
    expect($("more-btn").getAttribute("aria-expanded")).toBe("false");

    $("more-btn").click();
    expect($("more-drawer").hidden).toBe(false);
    $("more-drawer-backdrop").click();
    expect($("more-drawer").hidden).toBe(true);

    $("more-btn").click();
    expect($("more-drawer").hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect($("more-drawer").hidden).toBe(true);
  });

  it("closes automatically once a section is selected from inside it", () => {
    const { openMoreDrawer } = loadConsole();
    openMoreDrawer();
    expect($("more-drawer").hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('.drawer-nav [data-tab="timeline"]')!.click();
    expect($("more-drawer").hidden).toBe(true);
  });
});

describe("mobile badge sync", () => {
  it("syncBadgeMobile mirrors the sidebar badge's hidden state and count onto its bottom-bar/drawer twin", () => {
    const { syncBadgeMobile } = loadConsole();
    const primary = $("inbox-badge");
    primary.hidden = false;
    primary.textContent = "3";
    syncBadgeMobile("inbox-badge");
    expect($("inbox-badge-mobile").hidden).toBe(false);
    expect($("inbox-badge-mobile").textContent).toBe("3");

    primary.hidden = true;
    syncBadgeMobile("inbox-badge");
    expect($("inbox-badge-mobile").hidden).toBe(true);
  });
});

describe("first-load skeleton (4.17)", () => {
  it("paints skeleton rows into a still-empty container before the first refresh completes", () => {
    const { paintSkeleton, setFirstRefreshDone } = loadConsole();
    setFirstRefreshDone(false);
    paintSkeleton("clearances", 3);
    expect($("clearances").querySelectorAll(".skeleton").length).toBe(3);
  });

  it("never overwrites real content once the first refresh has already completed", () => {
    const { paintSkeleton, setFirstRefreshDone } = loadConsole();
    $("clearances").textContent = "real content already rendered";
    setFirstRefreshDone(true);
    paintSkeleton("clearances", 3);
    expect($("clearances").textContent).toBe("real content already rendered");
    expect($("clearances").querySelectorAll(".skeleton")).toHaveLength(0);
  });

  it("preserves meaningful text while that domain is pending before the first batch completes", () => {
    const { paintSkeleton, setFirstRefreshDone } = loadConsole();
    setFirstRefreshDone(false);
    $("clearances").textContent = "Waiting for your decision";
    paintSkeleton("clearances");
    expect($("clearances").textContent).toBe("Waiting for your decision");
    expect($("clearances").querySelectorAll(".skeleton")).toHaveLength(0);
  });

  it("preserves an existing element and its focus while the domain is pending", () => {
    const { paintSkeleton } = loadConsole();
    const button = document.createElement("button");
    button.textContent = "Review request";
    $("clearances").replaceChildren(button);
    button.focus();
    paintSkeleton("clearances");
    expect($("clearances").firstElementChild).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("still paints a pending whitespace-only domain after another domain finished", () => {
    const { paintSkeleton, setFirstRefreshDone } = loadConsole();
    setFirstRefreshDone(true);
    $("clearances").textContent = " \n\t ";
    paintSkeleton("clearances", 2);
    expect($("clearances").querySelectorAll(".skeleton")).toHaveLength(2);
  });

  for (const status of ["ok", "failed"]) {
    it(`does not paint over an empty ${status} domain`, () => {
      const { paintSkeleton, setApprovalStatus } = loadConsole();
      setApprovalStatus(status);
      $("clearances").replaceChildren();
      paintSkeleton("clearances");
      expect($("clearances").querySelectorAll(".skeleton")).toHaveLength(0);
    });
  }
});

describe("dead weight removed (docs/design/HUB_REDESIGN.md finding 1.7)", () => {
  it("the font stylesheet no longer requests Barlow Condensed or JetBrains Mono", () => {
    const html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
    expect(html).not.toMatch(/Barlow/);
    expect(html).not.toMatch(/JetBrains/);
  });
});
