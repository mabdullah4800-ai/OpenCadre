// Dark mode Stage 2 (docs/design/CONSOLE_AUDIT.md, plan item 7): semantic/status colors. Each
// wash+ink pair (a near-white background with a dark, saturated text color in light mode) needs
// its own dark variant -- neither half can just get darker. Same approach as Stage 1's test:
// reads public/app/app.css directly since happy-dom doesn't evaluate @media or compute contrast.
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

const darkBlock = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));

// The value each token RENDERS as, per theme: every stylesheet the console loads, in order, var() chains followed to
// the primitive (tests/helpers/css-tokens.ts). These used to regex a literal hex out of app.css; the roles are var()
// references to /shared/tokens.css now (design-token plan, Task 3). Thresholds are unchanged.
const light = stylesheetDeclarations(CONSOLE_STYLESHEETS, "light");
const dark = stylesheetDeclarations(CONSOLE_STYLESHEETS, "dark");
function hex(name: string, decls: Map<string, string>, theme: string): string {
  const value = resolveToken(name, decls);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${name} resolves to ${value} in ${theme}, not a #rrggbb colour`);
  return value.toUpperCase();
}
const lightVar = (name: string) => hex(name, light, "light");
const darkVar = (name: string) => hex(name, dark, "dark");

/** The complete text of one rule, from its selector through its MATCHING closing brace. */
function cssRule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} not found -- if the rule moved out of app.css, move this guard with it`);
  // Walk to the MATCHING brace rather than the first `}`. A first-`}` slice would be truncated
  // by any nested block (@supports, @media, a nested selector) -- and a truncated slice is the
  // silent direction: it satisfies a not-toMatch(hex) assertion MORE easily, because the part
  // carrying the literal may not be in it. Balance the walk so the result cannot be short.
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`${selector} opened a brace that is never closed`);
}

describe("dark mode Stage 2: wash+ink pairs each get their own dark variant, not just a darker wash", () => {
  const pairs: [string, string, string][] = [
    ["all-clear chip / .status-msg.status-success / chip-online", "--clear-ink", "--clear-tint"],
    ["chip-waiting", "--amber-ink", "--amber-tint"],
    ["chip-limited / paused banner / status-error", "--danger-ink", "--danger-bg"],
    ["chip-redeemed", "--info-ink", "--info-bg"],
  ];

  it.each(pairs)("%s: dark ink on dark wash passes WCAG AA (4.5:1)", (_label, inkVar, bgVar) => {
    expect(contrastRatio(darkVar(inkVar), darkVar(bgVar))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(pairs)("%s: the dark variant actually differs from the light one (not left unchanged)", (_label, inkVar, bgVar) => {
    expect(darkVar(inkVar)).not.toBe(lightVar(inkVar));
    expect(darkVar(bgVar)).not.toBe(lightVar(bgVar));
  });

  it(".btn-halt's wash (--halt-wash) + its text (--halt-text) passes WCAG AA in dark", () => {
    // Re-pointed 2026-09-29 (design-token plan s9): this measured the fixed --halt FILL as text, and .btn-halt's text
    // is --halt-text now (danger text, with its own dark value), so the pair that renders is --halt-text on the wash.
    // --halt itself stays a fixed fill in both themes, confirmed separately below.
    expect(contrastRatio(darkVar("--halt-text"), darkVar("--halt-wash"))).toBeGreaterThanOrEqual(4.5);
    expect(darkVar("--halt-wash")).not.toBe(lightVar("--halt-wash"));
  });

  it(".risk-low's background (--risk-low-bg) gets its own dark variant, paired with --ink-2", () => {
    expect(contrastRatio(darkVar("--ink-2"), darkVar("--risk-low-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(darkVar("--risk-low-bg")).not.toBe(lightVar("--risk-low-bg"));
  });
});

describe("dark mode Stage 2: fixed semantic colors stay vivid in both themes (no dark override needed)", () => {
  // --amber/--halt/--chip/--clear and the risk/priority badge fills (--amber-contrast/
  // --halt-contrast, fixed since Stage 1's audit finding #1) are already saturated enough to read
  // clearly against a dark surface -- unlike the near-white washes above, they don't need a
  // separate dark variant. This just confirms they're genuinely untouched by the dark block,
  // rather than silently missing on purpose.
  const fixed = ["--amber", "--halt", "--chip", "--clear", "--amber-contrast", "--halt-contrast"];

  it.each(fixed)("%s is not redefined inside the dark-mode block", (name) => {
    // Any declaration of the name, not only a literal: the roles are var() references now, and `--halt:
    // var(--danger-solid-d)` in the dark block would redefine it just as surely as a hex. The resolved check covers the
    // other console stylesheets too.
    expect(darkBlock.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(new RegExp(`${name}\\s*:`));
    expect(darkVar(name)).toBe(lightVar(name));
  });

  it.each(["--amber-contrast", "--halt-contrast"])("%s passes WCAG AA (4.5:1) for white text against it, in both themes since it's unchanged (finding #1)", (name) => {
    // --amber/--halt themselves are NOT the white-text-fill colors -- that's finding #1's whole
    // point (they fail AA, which is why *-contrast exists). Only *-contrast needs this check.
    expect(contrastRatio("#ffffff", lightVar(name))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("dark mode Stage 2: components reference the tokens, not a hardcoded literal", () => {
  it(".btn-halt uses --halt-wash, not a hardcoded hex, and --halt-text for its text (the pair measured above)", () => {
    const rule = css.slice(css.indexOf(".btn-halt {"), css.indexOf(".btn-halt {") + 150);
    expect(rule).toMatch(/background:\s*var\(--halt-wash\)/);
    expect(rule).toMatch(/color:\s*var\(--halt-text\)/);
  });

  it(".risk-low uses --risk-low-bg, not a hardcoded hex", () => {
    expect(css).toMatch(/\.risk-low\s*\{\s*background:\s*var\(--risk-low-bg\)/);
  });

  it(".status-chip.chip-waiting and .chip-redeemed use tokens, not hardcoded hex", () => {
    const waiting = css.slice(css.indexOf(".status-chip.chip-waiting {"), css.indexOf(".status-chip.chip-waiting {") + 150);
    expect(waiting).toMatch(/color:\s*var\(--amber-ink\)/);
    const redeemed = css.slice(css.indexOf(".status-chip.chip-redeemed {"), css.indexOf(".status-chip.chip-redeemed {") + 150);
    expect(redeemed).toMatch(/background:\s*var\(--info-bg\)/);
    expect(redeemed).toMatch(/color:\s*var\(--info-ink\)/);
  });

  it(".strip.priority-1 uses --amber-wash, not a hardcoded light-mode hex (bug #181)", () => {
    // The P1 awareness card. This group's other rules are asserted with a +150-char window, which
    // is fine for one-line declarations; this rule is a four-line block, so the slice runs to the
    // rule's own closing brace and `cssRule` balances the walk to get there (see its comment).
    const rule = cssRule(".strip.priority-1");
    // The bug: the gradient opened on the literal #fffcf5, fixed in 013ec351 to --amber-wash.
    // Asserting the token alone would not have caught it -- a literal that ALSO names the token
    // would pass -- so forbid the hex outright, which is what this group is for. Both halves are
    // load-bearing, and each covers the other's blind spot: the token assertion catches the hex
    // replacing the token, the hex assertion catches a literal added BESIDE it.
    expect(rule).toMatch(/var\(--amber-wash\)/);
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
