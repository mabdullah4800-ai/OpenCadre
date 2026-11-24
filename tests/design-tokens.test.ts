// The design-token guards (docs/superpowers/plans/2026-09-29-design-tokens.md, Task 5; docs/design/DESIGN-SYSTEM.md).
//
// The palette lives once, in /shared/tokens.css, and each surface's roles reference it. Three things keep that true:
//   (a)  no colour literal in the four UI stylesheets, except the translucent overlays, shadows and masks listed
//        below, each with its selector and reason. The list cannot rot: an entry whose literal is gone fails too.
//   (a2) the shared file has no dark theme, and (b) no name is declared both in the shared file and a surface file:
//        both live in tests/console-token-source.test.ts, beside the load-order checks they depend on.
//   (c)  a contrast matrix measured through the resolver (tests/helpers/css-tokens.ts): console light and dark. Values are what the roles render as, across each page's stylesheets in load order.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { CONSOLE_STYLESHEETS, resolve, stylesheetDeclarations, type Scheme } from "./helpers/css-tokens.js";

const read = (file: string) => readFileSync(resolvePath(process.cwd(), file), "utf8");
const UI_FILES = ["public/app/app.css", "public/app/console-v2.css", "public/app/tokens.css"];

// ---- (a) colour literals ------------------------------------------------------------------------------------------

// Every CSS named colour (CSS Color 4), so `white` or `black` written as a value is a literal like any hex. Not
// listed: transparent and currentcolor, which carry no palette value.
const NAMED = "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen";
const LITERAL = new RegExp(String.raw`#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)|(?<![\w-])(?:${NAMED.split(" ").join("|")})(?![\w-])`, "gi");

type Finding = { file: string; selector: string; literal: string };

/** Split a rule body into declarations on `;`, ignoring any inside quotes or parentheses (a data URI, a url()). */
function declarationsOf(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out.map((d) => d.trim()).filter(Boolean);
}

/** Every colour literal in a declaration VALUE, with its rule's selector (nested at-rules joined with " > "). */
function literals(file: string): Finding[] {
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Finding[] = [];
  const stack: string[] = [];
  let preludeStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      stack.push(css.slice(preludeStart, i).trim().replace(/\s+/g, " "));
      preludeStart = bodyStart = i + 1;
    } else if (css[i] === "}") {
      const body = css.slice(bodyStart, i);
      if (!body.includes("{")) {
        for (const decl of declarationsOf(body)) {
          const colon = decl.indexOf(":");
          if (colon < 0) continue;
          for (const m of decl.slice(colon + 1).matchAll(LITERAL)) found.push({ file, selector: stack.join(" > "), literal: m[0].toLowerCase() });
        }
      }
      stack.pop();
      preludeStart = bodyStart = i + 1;
    } else if (css[i] === ";") {
      preludeStart = i + 1; // a declaration, or a statement between rules (@import): never part of the next selector
    }
  }
  return found;
}

// The allowed literals: translucent neutrals that tint whatever they cross, so no single palette value can stand in
// for them, and masks where only the alpha matters. One entry per (file, selector, literal). Adding one needs a reason
// in this shape; a status colour, a text colour or a surface is never allowed here (use a role).
const SHADOW = "shadow: a translucent neutral depth cue, not a palette colour";
const OVERLAY = "neutral overlay: a translucent tint over whatever surface it crosses";
const BACKDROP = "backdrop: a translucent scrim behind a modal layer";
const MASK = "alpha mask: only the alpha channel is read";
const SVG_MASK = "SVG mask data URI: the stroke colour is ignored, the icon is painted by the element";
const DARK_ROOT = "@media (prefers-color-scheme: dark) > :root";
const ALLOWED: Array<[file: string, selector: string, literal: string, reason: string]> = [
  // public/app/app.css :root (light) and its dark block: the themed overlay and shadow tokens.
  ["public/app/app.css", ":root", "rgba(255, 255, 255, 0.9)", "--specular: " + OVERLAY],
  ["public/app/app.css", ":root", "rgba(23, 23, 23, 0.08)", "--focus-glow, --chip-tint-3: " + OVERLAY],
  ["public/app/app.css", ":root", "rgba(23, 23, 23, 0.04)", "--chip-tint-1: " + OVERLAY],
  ["public/app/app.css", ":root", "rgba(23, 23, 23, 0.06)", "--chip-tint-2: " + OVERLAY],
  ["public/app/app.css", ":root", "rgba(23, 23, 23, 0.1)", "--chip-tint-4: " + OVERLAY],
  ["public/app/app.css", ":root", "rgba(0, 0, 0, 0.03)", "--shadow-subtle: " + SHADOW],
  ["public/app/app.css", ":root", "rgba(0, 0, 0, 0.04)", "--shadow-subtle: " + SHADOW],
  ["public/app/app.css", ":root", "rgba(255, 255, 255, 0.8)", "--shadow's inset highlight: " + OVERLAY],
  ["public/app/app.css", ":root", "rgba(15, 23, 42, 0.06)", "--shadow: " + SHADOW],
  ["public/app/app.css", ":root", "rgba(15, 23, 42, 0.14)", "--shadow-lg: " + SHADOW],
  ["public/app/app.css", DARK_ROOT, "rgba(255, 255, 255, 0.04)", "--specular (dark): " + OVERLAY],
  ["public/app/app.css", DARK_ROOT, "rgba(255, 255, 255, 0.12)", "--focus-glow (dark): " + OVERLAY],
  ["public/app/app.css", DARK_ROOT, "rgba(255, 255, 255, 0.06)", "--chip-tint-1 (dark): " + OVERLAY],
  ["public/app/app.css", DARK_ROOT, "rgba(255, 255, 255, 0.08)", "--chip-tint-2 (dark): " + OVERLAY],
  ["public/app/app.css", DARK_ROOT, "rgba(255, 255, 255, 0.10)", "--chip-tint-3 (dark): " + OVERLAY],
  ["public/app/app.css", DARK_ROOT, "rgba(255, 255, 255, 0.13)", "--chip-tint-4 (dark): " + OVERLAY],
  ["public/app/app.css", DARK_ROOT, "rgba(0, 0, 0, 0.3)", "--shadow-subtle (dark): " + SHADOW],
  ["public/app/app.css", DARK_ROOT, "rgba(0, 0, 0, 0.4)", "--shadow-subtle (dark): " + SHADOW],
  ["public/app/app.css", DARK_ROOT, "rgba(255, 255, 255, 0.03)", "--shadow's inset highlight (dark): " + OVERLAY],
  ["public/app/app.css", DARK_ROOT, "rgba(0, 0, 0, 0.5)", "--shadow (dark): " + SHADOW],
  ["public/app/app.css", DARK_ROOT, "rgba(0, 0, 0, 0.6)", "--shadow-lg (dark): " + SHADOW],
  // public/app/app.css rules
  ["public/app/app.css", ".btn", "rgba(0, 0, 0, 0.04)", SHADOW],
  ["public/app/app.css", ".btn:hover", "rgba(15, 23, 42, 0.25)", "hover border: " + OVERLAY],
  ["public/app/app.css", ".btn-ink", "rgba(15, 23, 42, 0.35)", SHADOW],
  ["public/app/app.css", ".btn-quiet:hover", "rgba(15, 23, 42, 0.05)", "hover fill: " + OVERLAY],
  ["public/app/app.css", ".workspace-item:hover", "rgba(15, 23, 42, 0.2)", "hover border: " + OVERLAY],
  ["public/app/app.css", "@media (max-width: 767px) > .drawer-backdrop:not([hidden])", "rgba(0, 0, 0, 0.4)", BACKDROP],
  ["public/app/app.css", ".command", "rgba(255, 255, 255, 0.08)", "hairline on the carbon slab: " + OVERLAY],
  ["public/app/app.css", ".outcome-noted, .outcome-withdrawn", "rgba(15, 23, 42, 0.06)", "neutral pill fill: " + OVERLAY],
  ["public/app/app.css", ".snippet pre", "rgba(255, 255, 255, 0.08)", "hairline on the carbon slab: " + OVERLAY],
  ["public/app/app.css", ".toast", "rgba(23, 23, 23, 0.3)", SHADOW],
  ["public/app/app.css", ".bg-pill", "rgba(0, 0, 0, 0.04)", SHADOW],
  ["public/app/app.css", ".focused-approval-overlay", "rgba(15, 23, 42, 0.55)", BACKDROP],
  // public/app/console-v2.css
  ["public/app/console-v2.css", ".row-menu-list", "rgba(0, 0, 0, 0.35)", SHADOW],
  ["public/app/console-v2.css", ".signin-card", "rgba(0, 0, 0, 0.04)", SHADOW],
  ["public/app/console-v2.css", ".signin-card", "rgba(0, 0, 0, 0.18)", SHADOW],
  ["public/app/console-v2.css", "@media (prefers-color-scheme: dark) > .signin-card", "rgba(0, 0, 0, 0.6)", SHADOW],
  ["public/app/console-v2.css", ".user-menu", "rgba(0, 0, 0, 0.45)", SHADOW],
  ["public/app/console-v2.css", ".find-backdrop", "rgba(0, 0, 0, 0.35)", BACKDROP],
  ["public/app/console-v2.css", ".find-panel", "rgba(0, 0, 0, 0.5)", SHADOW],
  ["public/app/console-v2.css", '.connect-mode button[aria-selected="true"]', "rgba(0, 0, 0, 0.12)", SHADOW],
  ["public/app/console-v2.css", ".switch-track::after", "rgba(0, 0, 0, 0.25)", SHADOW],
  ["public/app/console-v2.css", "@supports (appearance: base-select) > .board select::picker(select)", "rgba(0, 0, 0, 0.45)", SHADOW],
  ["public/app/console-v2.css", "@supports (appearance: base-select) > .board select::picker-icon", "black", SVG_MASK],
  ["public/app/console-v2.css", '.board input[type="checkbox"]:not([role="switch"])::after', "black", SVG_MASK],
  ["public/app/console-v2.css", ".board details:not(.row-menu):not(.files-count) > summary::before, .board details[open]:not(.row-menu):not(.files-count) > summary::before", "black", SVG_MASK],
];
const key = (f: Pick<Finding, "file" | "selector" | "literal">) => `${f.file} | ${f.selector} | ${f.literal.toLowerCase()}`;

describe("(a) no colour literal in the UI stylesheets outside the allowlist", () => {
  const found = UI_FILES.flatMap(literals);
  const allowed = new Set(ALLOWED.map(([file, selector, literal]) => key({ file, selector, literal })));

  it("reads all four files, and finds the literals it is meant to police", () => {
    for (const f of UI_FILES) expect(read(f).length, f).toBeGreaterThan(0);
    // A parser that found nothing would pass "every literal is allowlisted" vacuously; it cannot find fewer literals
    // than the allowlist names while "every entry still exists" also passes, and this states that floor directly.
    expect(found.length).toBeGreaterThanOrEqual(ALLOWED.length);
  });

  it("every literal in a value is an allowlisted overlay, shadow or mask", () => {
    const unlisted = [...new Set(found.map(key))].filter((k) => !allowed.has(k));
    expect(unlisted).toEqual([]);
  });

  it("every allowlist entry still exists (the list cannot rot)", () => {
    const present = new Set(found.map(key));
    expect([...allowed].filter((k) => !present.has(k))).toEqual([]);
    expect(allowed.size, "no duplicate entries").toBe(ALLOWED.length);
  });

  it("every entry says why, and none is a status, text or surface colour", () => {
    for (const [file, selector, literal, reason] of ALLOWED) {
      expect(reason, `${file} ${selector} ${literal}`).toMatch(/shadow|overlay|backdrop|mask/i);
      // Only neutrals: black, white, the carbon/slate rgb family, or chalk. A hue would need a role, not an entry.
      const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(literal);
      const neutral = !rgb || Math.max(+rgb[1], +rgb[2], +rgb[3]) - Math.min(+rgb[1], +rgb[2], +rgb[3]) <= 27;
      expect(neutral, `${literal} is not a neutral`).toBe(true);
      if (!rgb) expect(literal).toMatch(/^(#000|black)$/);
    }
  });

  it("the parser sees a literal in each form it claims to (positive controls)", () => {
    const probe = (css: string) => {
      const file = "probe.css";
      const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
      return [...text.matchAll(/\{([^{}]*)\}/g)].flatMap((m) => declarationsOf(m[1]).flatMap((d) => [...d.slice(d.indexOf(":") + 1).matchAll(LITERAL)].map((x) => x[0])));
    };
    expect(probe(".a { color: #fff; }")).toEqual(["#fff"]);
    expect(probe(".a { color: rgb(1 2 3); background: hsla(0, 0%, 0%, .5); }")).toEqual(["rgb(1 2 3)", "hsla(0, 0%, 0%, .5)"]);
    expect(probe(".a { background: color-mix(in srgb, var(--x) 10%, white); }")).toEqual(["white"]);
    expect(probe(".a { white-space: nowrap; border: 0; color: var(--ink); } /* #fff */")).toEqual([]);
  });
});

// ---- (c) contrast matrix ------------------------------------------------------------------------------------------

/** WCAG 2.x contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  };
  const [x, y] = [lum(a) + 0.05, lum(b) + 0.05];
  return x > y ? x / y : y / x;
}

type Surface = { name: string; files: readonly string[]; scheme: Scheme };
const CONSOLE_LIGHT: Surface = { name: "console light", files: CONSOLE_STYLESHEETS, scheme: "light" };
const CONSOLE_DARK: Surface = { name: "console dark", files: CONSOLE_STYLESHEETS, scheme: "dark" };

function colour(surface: Surface, token: string): string {
  const value = resolve(token, stylesheetDeclarations(surface.files, surface.scheme));
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${surface.name}: ${token} resolves to ${value}, not a #rrggbb colour`);
  return value;
}

/** The colour the page's global :focus-visible outline draws in, read from the LAST file that declares one. */
function focusToken(files: readonly string[]): string {
  let token: string | undefined;
  for (const f of files) {
    const m = /(?:^|\})\s*:focus-visible\s*\{[^}]*outline:\s*[^;}]*var\((--[a-z0-9-]+)\)/.exec(read(f).replace(/\/\*[\s\S]*?\*\//g, ""));
    if (m) token = m[1];
  }
  if (!token) throw new Error("no global :focus-visible outline found");
  return token;
}

type Pair = [surface: Surface, fg: string, bg: string, min: number];
const pairs: Pair[] = [];
for (const s of [CONSOLE_LIGHT, CONSOLE_DARK]) {
  for (const fg of ["--ink", "--ink-2", "--muted"]) for (const bg of ["--bg", "--surface", "--surface-2"]) pairs.push([s, fg, bg, 4.5]);
  const focus = focusToken(s.files);
  for (const bg of ["--bg", "--surface"]) pairs.push([s, focus, bg, 3]);
  // --ring, the box-shadow focus ring console-v2 draws on buttons and controls: its outer (visible) ring.
  for (const bg of ["--bg", "--surface"]) pairs.push([s, "--ink", bg, 3]);
  for (const [fg, bg] of [["--clear-ink", "--clear-tint"], ["--amber-ink", "--amber-tint"], ["--amber-ink", "--amber-wash"], ["--danger-ink", "--danger-bg"], ["--info-ink", "--info-bg"], ["--halt-text", "--halt-wash"]]) pairs.push([s, fg, bg, 4.5]);
  for (const bg of ["--halt", "--halt-contrast", "--amber-contrast", "--ink-solid"]) pairs.push([s, "--on-solid", bg, 4.5]);
  pairs.push([s, "--clear-ink", "--surface", 4.5]);
  // Home's dashboard (console dashboard phase 1). A plan-limit gauge's fills on its track (graphics, 3:1): ink, near the
  // limit and at it. The fleet map's slabs are --ink on the card with --surface words on them, and each state glyph sits
  // on a --surface disc on the slab. The waiting tile's number is --ink on --amber-wash; its words, and every "showing
  // data from" caption, are --amber-ink.
  for (const fg of ["--ink", "--amber-ink", "--halt-text"]) pairs.push([s, fg, "--chart-track", 3]);
  pairs.push([s, "--surface", "--ink", 4.5]);
  // The Open tasks strip's "open" segment: --line-strong fill, outlined in --ink (the outline is the 3:1 edge).
  pairs.push([s, "--ink", "--line-strong", 3]);
  for (const fg of ["--state-online", "--state-working", "--state-waiting", "--state-blocked", "--state-idle"]) pairs.push([s, fg, "--surface", 3]);
  pairs.push([s, "--ink", "--amber-wash", 4.5]);
  for (const bg of ["--surface", "--bg"]) pairs.push([s, "--amber-ink", bg, 4.5]);
}

describe("(c) contrast matrix, measured through the resolver", () => {
  it("the console's --ring draws its visible ring in --ink (so the --ink rows above are the ring)", () => {
    const ring = stylesheetDeclarations(CONSOLE_STYLESHEETS, "light").get("--ring");
    expect(ring).toMatch(/0 0 0 4px var\(--ink\)\s*$/);
  });

  it.each(pairs.map(([s, fg, bg, min]) => [`${s.name}: ${fg} on ${bg} >= ${min}`, s, fg, bg, min] as const))("%s", (_label, s, fg, bg, min) => {
    const ratio = contrast(colour(s, fg), colour(s, bg));
    expect(Number(ratio.toFixed(2)), `${colour(s, fg)} on ${colour(s, bg)}`).toBeGreaterThanOrEqual(min);
  });
});
