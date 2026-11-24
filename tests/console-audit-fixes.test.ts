// Regression tests for docs/design/CONSOLE_AUDIT.md finding #1-3: two CSS layout bugs and a
// WCAG contrast failure. No build step for the console, so this reads public/app/app.css
// directly (happy-dom doesn't compute real layout/contrast) rather than a component test.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONSOLE_STYLESHEETS, resolve as resolveToken, stylesheetDeclarations } from "./helpers/css-tokens.js";

const css = readFileSync(resolve(process.cwd(), "public/app/app.css"), "utf8");

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

// The light value each token RENDERS as: every stylesheet the console loads, in order, var() chains followed to the
// primitive (tests/helpers/css-tokens.ts). This used to regex the first literal hex beside the name in app.css; the
// roles are var() references to /shared/tokens.css now (design-token plan, Task 3).
const light = stylesheetDeclarations(CONSOLE_STYLESHEETS, "light");
function cssVar(name: string): string {
  const value = resolveToken(name, light);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${name} resolves to ${value}, not a #rrggbb colour`);
  return value;
}

describe("risk/priority badge contrast (finding #1)", () => {
  it("--amber-contrast and --halt-contrast pass WCAG AA (4.5:1) for white text", () => {
    // .risk / .p-badge text renders at 0.72rem (11.5px) bold -- well under the "large text"
    // exemption (18.7px bold / 24px regular), so the small-text 4.5:1 threshold applies.
    expect(contrastRatio(cssVar("--amber-contrast"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(cssVar("--halt-contrast"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("the original --amber fails AA, which is why the badges no longer use it directly", () => {
    // Documents *why* the fix exists: if this ever starts passing, the badges could switch back.
    expect(contrastRatio(cssVar("--amber"), "#ffffff")).toBeLessThan(4.5);
    // 2026-09-29, design-token plan s9: this test also asserted that --halt fails AA with white text. That pinned a
    // property of the OLD value (#e5484d, 3.91:1). --halt is now the audit's danger solid (#D93A3F), which passes white
    // text at 4.54:1, at the edge; the badges keep --halt-contrast (5.57:1) for margin, and the test above already
    // guards them. The --halt half is removed rather than inverted: a value that clears AA by 0.04 is not one to build
    // text on.
  });

  it(".risk-high, .risk-medium, .p-badge.p1 and .badge use the contrast-safe tokens", () => {
    expect(css).toMatch(/\.risk-high\s*\{\s*background:\s*var\(--halt-contrast\)/);
    expect(css).toMatch(/\.risk-medium\s*\{\s*background:\s*var\(--amber-contrast\)/);
    expect(css).toMatch(/\.p-badge\.p1\s*\{\s*background:\s*var\(--amber-contrast\)/);
    // .badge is the nav-tab unread-count pill (#pending-badge/#inbox-badge/#awareness-badge) --
    // same white-on-amber, same 0.72rem/700 size, same failure, caught in review after the first pass missed it.
    expect(css).toMatch(/\.badge\s*\{[^}]*background:\s*var\(--amber-contrast\)/);
  });
});

describe("mobile clearance-policy / invite form field height (finding #2)", () => {
  it("resets .policy-add-form .field's flex-basis once the form stacks to a column", () => {
    // .field { flex: 1 1 200px } sets a 200px *main-axis* basis, which is a sane min-width on
    // desktop (flex-direction: row) but becomes a forced 200px *height* once the mobile media
    // query flips .policy-add-form to flex-direction: column -- stretching every stacked field
    // (Settings > Clearance policy's project override, and the Members > invite form, which
    // both use this class) to 200px tall with a big gap between the label and its input.
    const mobileBlock = css.slice(css.indexOf("@media"), css.length);
    expect(mobileBlock).toMatch(/\.policy-add-form\s*\{\s*flex-direction:\s*column[^}]*\}/);
    expect(mobileBlock).toMatch(/\.policy-add-form\s+\.field\s*\{\s*flex:\s*none\s*;?\s*\}/);
  });
});

describe("task board \"Add task\" button (finding #3)", () => {
  it("doesn't shrink or wrap, so the input gives up space first instead", () => {
    expect(css).toMatch(/\.task-form\s+\.btn\s*\{[^}]*flex-shrink:\s*0[^}]*\}/);
    expect(css).toMatch(/\.task-form\s+\.btn\s*\{[^}]*white-space:\s*nowrap[^}]*\}/);
  });
});
