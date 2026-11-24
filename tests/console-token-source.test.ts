// Every token has ONE declaration (docs/design/CONSOLE-V2.md §4.2, docs/superpowers/plans/2026-09-29-design-tokens.md).
//
// The console used to load an older /shared/tokens.css twice (a <link> in index.html and an @import in app.css) and
// then redeclare 37 of its 51 values in app.css, so which value applied depended on source order and a reader could
// not tell. Raised on #540 by Codex-OpenCadre-f46c; the answer then was to drop the shared file from the console.
//
// The design-token plan (Option A, ruled by Codex-OpenCadre-049a, 2026-09-29) brings it back with a narrower job:
// /shared/tokens.css holds only theme-invariant colour PRIMITIVES, linked first by both surfaces, and each surface
// declares its ROLES as references to them. What made #540 a hazard was two declarations of one name, so that is what
// these tests forbid, together with the other two ways the shared file could quietly change a surface: a dark block
// (which would darken the light-only site) and a role or component value slipping into it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { declarations, resolve as resolveToken } from "./helpers/css-tokens.js";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const SHARED = "public/shared/tokens.css";
const SCALE = "public/shared/scale.css";
const CONSOLE_STYLES = [SHARED, "public/app/app.css", "public/app/tokens.css", "public/app/console-v2.css"];
const SURFACE_STYLES = ["public/app/app.css", "public/app/tokens.css", "public/app/console-v2.css"];
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
// Comments are stripped first: a prose mention such as "--chip: the Signal cyan" is not a declaration.
const definedIn = (text: string) => new Set([...stripComments(text).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const stylesheets = (html: string) => [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);

describe("the console's styles: shared primitives first, then the console's own files", () => {
  it("index.html links /shared/tokens.css first, then app.css, then console-v2.css", () => {
    const links = stylesheets(read("public/app/index.html"));
    expect(links[0]).toBe("/shared/tokens.css");
    expect(links.filter((href) => href.startsWith("/"))).toEqual(["/shared/tokens.css", "/app/app.css", "/app/console-v2.css"]);
  });

  it("app.css does not import the shared tokens (one <link>, not a second copy by @import)", () => {
    expect(read("public/app/app.css")).not.toMatch(/@import[^;]*shared\/tokens\.css/);
  });

  it("every token the console reads is declared in a file the console loads", () => {
    const users = [...CONSOLE_STYLES, "public/app/app.js"].map(read).join("\n");
    const own = new Set(CONSOLE_STYLES.flatMap((f) => [...definedIn(read(f))]));
    // Two are read only with a fallback beside them (var(--sans, inherit)) or set at runtime by app.js (--hold-ms).
    const WITH_FALLBACK = new Set(["--sans", "--hold-ms"]);
    const missing = [...new Set([...users.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))]
      .filter((t) => !own.has(t) && !WITH_FALLBACK.has(t));
    expect(missing).toEqual([]);
  });
});

describe("/shared/tokens.css holds primitives only", () => {
  const shared = read(SHARED);

  it("declares only neutrals, the chip, status primitives and vendor primitives", () => {
    const names = [...definedIn(shared)];
    expect(names.length).toBeGreaterThan(0);
    const PRIMITIVE = /^--(?:n-\d+|chip|(?:ok|wait|danger|neutral)-(?:text|solid|wash)-[ld]|viz-[1-3]-[ld]|vendor-[a-z]+)$/;
    expect(names.filter((n) => !PRIMITIVE.test(n))).toEqual([]);
  });

  it("has no dark theme of any kind: its values are theme-invariant, and the site is light-only", () => {
    // `color-scheme` covers both a prefers-color-scheme block and a color-scheme property; light-dark() would pick a
    // value by theme inside a single declaration.
    const code = stripComments(shared);
    expect(code).not.toMatch(/color-scheme/);
    expect(code).not.toMatch(/light-dark\(/);
  });

  it("holds the audit's values (UX audit 2026-09-29 s4.1 neutrals and chip, s4.2 status table), and no other", () => {
    // Copied from the audit, not from the file: a value retuned in tokens.css without a decision fails here. --n-350 and
    // --n-450 are the audit's dark --text-2 / --text-3, named as neutrals by plan s7.
    const AUDIT: Record<string, string> = {
      "--n-0": "#FFFFFF", "--n-50": "#F6F6F3", "--n-100": "#EEEEEA", "--n-150": "#E6E6E1", "--n-200": "#DDDDD8",
      "--n-300": "#C9C9C3", "--n-350": "#B8BAC0", "--n-400": "#8B8E96", "--n-450": "#8E9199", "--n-500": "#6C707A",
      "--n-700": "#44474D", "--n-800": "#2E3036", "--n-850": "#24252B", "--n-900": "#1C1D22", "--n-950": "#15161A",
      "--n-1000": "#0F1013",
      "--chip": "#16B8CE",
      "--ok-text-l": "#18794E", "--ok-text-d": "#4CC38A", "--ok-solid-l": "#22A06B", "--ok-solid-d": "#3DB67B",
      "--ok-wash-l": "#E9F6EF", "--ok-wash-d": "#13261C",
      "--wait-text-l": "#A35200", "--wait-text-d": "#F0A83A", "--wait-solid-l": "#E5940C", "--wait-solid-d": "#E5A23A",
      "--wait-wash-l": "#FDF3E1", "--wait-wash-d": "#2A2112",
      "--danger-text-l": "#C62A2F", "--danger-text-d": "#FF6B6B", "--danger-solid-l": "#D93A3F", "--danger-solid-d": "#F06064",
      "--danger-wash-l": "#FCEBEB", "--danger-wash-d": "#2C1618",
      "--neutral-text-l": "#6C707A", "--neutral-text-d": "#8E9199", "--neutral-solid-l": "#A4A6AB", "--neutral-solid-d": "#5E6168",
      "--neutral-wash-l": "#EEEEEA", "--neutral-wash-d": "#24252B",
      // The data-viz series, from the design direction's validated set (direction.md s2.4), not from the audit.
      "--viz-1-l": "#006AC5", "--viz-1-d": "#2896F5", "--viz-2-l": "#B55D92", "--viz-2-d": "#BC6398",
      "--viz-3-l": "#8F78EE", "--viz-3-d": "#765DCF",
    };
    const decls = declarations(shared, "light");
    const actual = Object.fromEntries(Object.keys(AUDIT).map((n) => [n, decls.has(n) ? resolveToken(n, decls).toUpperCase() : "(missing)"]));
    expect(actual).toEqual(AUDIT);
    const unpinned = [...decls.keys()].filter((n) => !n.startsWith("--vendor-") && !(n in AUDIT));
    expect(unpinned).toEqual([]);
  });

  it("no custom property is declared both in the shared file and in a surface's own file", () => {
    const primitives = definedIn(shared);
    const clashes = SURFACE_STYLES.flatMap((f) => [...definedIn(read(f))].filter((n) => primitives.has(n)).map((n) => `${f} ${n}`));
    expect(clashes).toEqual([]);
  });
});

// The non-colour scale (type and radius) is shared too, with the opposite rule: nothing in it may be a colour, so the
// palette still has one home. The site links it; the console does not yet (it still declares its own --font,
// --space-* and --radius-*), and moving it over is its own reviewed change.
describe("/shared/scale.css holds the non-colour scale only", () => {
  const scale = read(SCALE);
  const code = stripComments(scale);

  it("declares something, and only values that are not colours", () => {
    expect(definedIn(scale).size).toBeGreaterThan(0);
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|color-mix|oklab|oklch|lab|lch)\(/i);
    // A reference would let a colour in by the back door (--x: var(--chip)); the scale's values are all literal.
    expect(code).not.toMatch(/var\(/);
  });

  it("has no theme of any kind and no second block: one :root, one declaration per name", () => {
    expect(code).not.toMatch(/color-scheme|light-dark\(|@media/);
    expect(code.match(/\{/g)?.length).toBe(1);
    const names = [...code.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(names.length).toBe(new Set(names).size);
  });

  it("no name it declares is declared again in a file a site page loads", () => {
    const own = definedIn(scale);
    const clashes = [SHARED].flatMap((f) => [...definedIn(read(f))].filter((n) => own.has(n)).map((n) => `${f} ${n}`));
    expect(clashes).toEqual([]);
  });
});
