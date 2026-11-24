// Dark mode Stage 1 (docs/design/CONSOLE_AUDIT.md, plan item 7): base surfaces only, under
// prefers-color-scheme. No build step for the console, so this reads public/app/app.css directly
// (happy-dom doesn't evaluate @media queries or compute real contrast) rather than a component
// test -- same approach as tests/console-audit-fixes.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONSOLE_STYLESHEETS, resolve as resolveToken, stylesheetDeclarations } from "./helpers/css-tokens.js";

const css = readFileSync(resolve(process.cwd(), "public/app/app.css"), "utf8");
const html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");

/** WCAG 2.x relative-luminance contrast ratio between two #rrggbb colors. */
function contrastRatio(hexA: string, hexB: string): number {
  const toRgb = (hex: string) => {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const luminance = ([r, g, b]: number[]) => {
    const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [l1, l2] = [luminance(toRgb(hexA)) + 0.05, luminance(toRgb(hexB)) + 0.05];
  return l1 > l2 ? l1 / l2 : l2 / l1;
}

/** The value a token RENDERS as in dark mode: every stylesheet the console loads, in order, with the dark blocks
 * applied, and var() chains followed to the primitive (tests/helpers/css-tokens.ts). It used to regex a literal hex
 * out of app.css's dark block; the roles are var() references to /shared/tokens.css now (design-token plan, Task 3). */
const dark = stylesheetDeclarations(CONSOLE_STYLESHEETS, "dark");
function darkVar(name: string): string {
  const value = resolveToken(name, dark);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${name} resolves to ${value} in dark, not a #rrggbb colour`);
  return value;
}

describe("dark mode Stage 1: declares itself", () => {
  it("app.css has a prefers-color-scheme: dark block overriding the base surface tokens", () => {
    expect(css).toMatch(/@media \(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{/);
  });

  it(":root sets color-scheme: light dark, so native controls/scrollbars follow", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
    expect(root).toMatch(/color-scheme:\s*light dark/);
  });

  it("index.html's <meta name=\"color-scheme\"> matches (light dark, not light-only)", () => {
    expect(html).toMatch(/<meta name="color-scheme" content="light dark">/);
  });

  it("index.html has a dark theme-color for mobile browser chrome, not just the light one", () => {
    expect(html).toMatch(/<meta name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"/);
  });
});

describe("dark mode Stage 1: base surface contrast (WCAG AA, 4.5:1 normal text)", () => {
  it("--ink (body text) on --bg and --surface both pass", () => {
    const ink = darkVar("--ink");
    expect(contrastRatio(ink, darkVar("--bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ink, darkVar("--surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it("--ink-2 (secondary text, e.g. .strip-body) on --bg and --surface both pass", () => {
    const ink2 = darkVar("--ink-2");
    expect(contrastRatio(ink2, darkVar("--bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ink2, darkVar("--surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it("--muted (hints, timestamps, .muted) on --bg and --surface both pass", () => {
    const muted = darkVar("--muted");
    expect(contrastRatio(muted, darkVar("--bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(muted, darkVar("--surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it("--surface is visibly lighter than --bg, so cards read as raised, not flat", () => {
    // Not a WCAG check (surfaces aren't text) -- just confirms the two aren't the same color,
    // which would make every card/panel invisible against the page background.
    expect(darkVar("--surface")).not.toBe(darkVar("--bg"));
    expect(darkVar("--surface-2")).not.toBe(darkVar("--bg"));
  });
});

// Regression for a real bug this Stage caught by actually screenshotting the console in dark mode
// (not just running the contrast math above): --ink flips light in dark mode since it's the body
// text color, but .btn-ink and .toast use it as a *solid fill* with white text on top -- flipping
// --ink light made both render white-on-white. --ink-solid is a fixed dark fill, deliberately never
// overridden in the dark-mode block, so these stay legible in both themes.
describe("dark mode Stage 1: --ink-solid stays fixed (the .btn-ink / .toast regression)", () => {
  it("--ink-solid is defined in :root and NOT overridden inside the dark-mode block", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
    expect(root).toMatch(/--ink-solid:/);
    // It is a var() to a primitive now, so measure what it renders as: a dark fill, the same in both themes.
    const light = resolveToken("--ink-solid", stylesheetDeclarations(CONSOLE_STYLESHEETS, "light"));
    expect(light).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(darkVar("--ink-solid")).toBe(light);
    // Slices to EOF on purpose -- do not bound this. The dark block runs 29 declarations over 56
    // lines and only the first 11 fall in its opening 800 chars, so a bounded window let an override
    // re-added after the cut satisfy this assertion while the claim in the test's own name was false.
    const darkBlock = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    expect(darkBlock).not.toMatch(/--ink-solid:/);
  });

  it(".btn-ink and .toast use --ink-solid for their fill, not --ink", () => {
    const btnInk = css.slice(css.indexOf(".btn-ink {"), css.indexOf(".btn-ink {") + 200);
    expect(btnInk).toMatch(/background:\s*var\(--ink-solid\)/);
    expect(btnInk).not.toMatch(/background:\s*var\(--ink\)[;)]/);
    const toast = css.slice(css.indexOf(".toast {"), css.indexOf(".toast {") + 200);
    expect(toast).toMatch(/background:\s*var\(--ink-solid\)/);
  });

  it("the focused-field glow adapts to theme via --focus-glow, not a hardcoded dark rgba", () => {
    const focusRule = css.slice(css.indexOf(".field input:focus"), css.indexOf(".field input:focus") + 200);
    expect(focusRule).toMatch(/box-shadow:\s*0 0 0 3px var\(--focus-glow\)/);
  });

  // Same defect class as the priority-1 strip (#181), found while verifying it: a literal
  // rgba(23,23,23,a) BACKGROUND darkens whatever is under it, which is correct on a near-white
  // surface and invisible on a dark one -- the chip keeps its legible text but loses its pill
  // shape entirely. The five that existed are now --chip-tint-1..4. This guards the class, not
  // the five call sites, so a new chip added with a literal fails here rather than in dark mode.
  it("no surface colour is a hardcoded dark-on-light rgba", () => {
    // Widened from `background:` only, on 46f9's review of #404: the narrower regex made the
    // "covers the class" claim true of backgrounds and of nothing else, so a border-color or an
    // outline written with the same literal would pass. This matches the literal in ANY
    // declaration and subtracts the two kinds that are legitimately dark in both themes:
    //
    //   - a `--token: rgba(...)` DEFINITION, which is the light half of a themed pair and is
    //     supposed to be dark -- that is the fix, not the defect;
    //   - a `box-shadow: rgba(...)` DECLARATION, exempted as a POLICY CHOICE and not as a finding.
    //     Dark UIs commonly use darker, not lighter, shadows, and .toast is a fixed-dark surface in
    //     both themes (--ink-solid is declared once, at app.css:31, and is not redeclared in the
    //     dark block), so a dark shadow under it is plausibly right in both modes. Plausible is not
    //     measured: nobody has rendered .toast in dark mode, so its rgba(23,23,23,0.3) at :1022
    //     stays exempted deliberately AND UNVERIFIED. Do not read this exemption as a claim that
    //     the shadow is correct -- if you render .toast in dark mode and it is wrong, delete this
    //     exemption, and the render is the evidence that justifies deleting it.
    //
    // The unit here is the DECLARATION, not the line, and that distinction is load-bearing. A
    // previous version filtered whole LINES (`!/box-shadow/.test(line)`), so a single line carrying
    // both a matched surface declaration and a shadow was exempted by the shadow -- the same shape
    // of hole this guard was widened to close, one level down. Measured on the unmutated tree:
    // `.oc { background: rgba(23,23,23,0.08); box-shadow: 0 1px 2px rgba(23,23,23,0.2); }` on one
    // line PASSED that version and FAILS this one. Leaving the exemption anchored on the
    // declaration's own leading property name is what makes "exempted deliberately" true beyond
    // today's one-declaration-per-line formatting.
    //
    // Comments are stripped first: prose ABOUT the literal (including the note that documents this
    // very fix, in app.css) is not a declaration, and a guard that trips on its own explanation
    // teaches the next person to delete the explanation.
    const offenders = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .flatMap((line, i) => line.split(";").map((decl) => [i + 1, decl.trim()] as const))
      .filter(([, decl]) => /rgba\(23,\s*23,\s*23/.test(decl))
      .filter(([, decl]) => !/^--[a-z0-9-]+:/.test(decl))
      .filter(([, decl]) => !/^box-shadow\s*:/.test(decl))
      .map(([n, decl]) => `${n}: ${decl}`);
    expect(offenders).toEqual([]);
  });

  it("every --chip-tint step flips to a light tint in the dark block", () => {
    const block = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    for (const step of [1, 2, 3, 4]) {
      const m = block.match(new RegExp(`--chip-tint-${step}:\\s*rgba\\((\\d+)`));
      expect(m, `--chip-tint-${step} missing from the dark-mode block`).toBeTruthy();
      expect(Number(m![1]), `--chip-tint-${step} is still a dark tint in dark mode`).toBe(255);
    }
  });
});
