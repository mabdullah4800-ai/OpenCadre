// The token resolver the design-token tests measure through (docs/superpowers/plans/2026-09-29-design-tokens.md, Task 1).
//
// Once roles are declared as var(--n-*) references, a contrast test that reads a literal hex out of app.css reads
// nothing. The helper follows each role to the primitive it renders as, so these cases pin the ways that walk could
// silently answer with the wrong value: a stale fallback, a light value leaking into dark, a declaration that is not
// on :root, a commented-out one, or a cycle that would otherwise hang.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { CONSOLE_STYLESHEETS, declarations, merge, resolve, stylesheetDeclarations } from "./helpers/css-tokens.js";

const decls = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("resolve", () => {
  it("returns a literal value unchanged", () => {
    expect(resolve("--a", decls({ "--a": "#15161A" }))).toBe("#15161A");
  });

  it("follows a chain of three var() references to the literal", () => {
    expect(resolve("--a", decls({ "--a": "var(--b)", "--b": "var(--c)", "--c": "#F6F6F3" }))).toBe("#F6F6F3");
  });

  it("uses the fallback when the name is not declared", () => {
    expect(resolve("--a", decls({ "--a": "var(--missing, #FFFFFF)" }))).toBe("#FFFFFF");
  });

  it("follows a fallback that is itself a var() reference", () => {
    expect(resolve("--a", decls({ "--a": "var(--missing, var(--b))", "--b": "#DDDDD8" }))).toBe("#DDDDD8");
  });

  it("ignores the fallback when the name is declared", () => {
    expect(resolve("--a", decls({ "--a": "var(--b, #FFFFFF)", "--b": "#0F1013" }))).toBe("#0F1013");
  });

  it("throws on a cycle instead of looping", () => {
    expect(() => resolve("--a", decls({ "--a": "var(--b)", "--b": "var(--c)", "--c": "var(--a)" }))).toThrow(/cycle/i);
  });

  it("throws on an unknown name with no fallback", () => {
    expect(() => resolve("--a", decls({ "--a": "var(--nowhere)" }))).toThrow(/--nowhere/);
    expect(() => resolve("--nowhere", decls({}))).toThrow(/--nowhere/);
  });

  it("resolves every var() in a value that mixes references and literals", () => {
    const d = decls({ "--line": "var(--n-200)", "--n-200": "#DDDDD8", "--ink": "#15161A", "--surface": "#FFFFFF" });
    expect(resolve("--hairline", merge(d, decls({ "--hairline": "0 0 0 1px var(--line)" })))).toBe("0 0 0 1px #DDDDD8");
    expect(resolve("--ring", merge(d, decls({ "--ring": "0 0 0 2px var(--surface), 0 0 0 4px var(--ink) inset" }))))
      .toBe("0 0 0 2px #FFFFFF, 0 0 0 4px #15161A inset");
  });
});

describe("declarations", () => {
  const css = `
    :root { --bg: #F6F6F3; --ink: var(--n-950); }
    /* :root { --bg: #FF0000; } */
    :root {
      /* retired; --ink: #FF0000; */
      --line: #DDDDD8;
    }
    .panel { --bg: #FF0000; --only-here: #FF0000; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #15161A; }
      .panel { --line: #FF0000; }
    }
    @media (max-width: 600px) { :root { --bg: #FF0000; } }
  `;

  it("reads custom properties on top-level :root rules, and nothing on other selectors", () => {
    const light = declarations(css, "light");
    expect(Object.fromEntries(light)).toEqual({ "--bg": "#F6F6F3", "--ink": "var(--n-950)", "--line": "#DDDDD8" });
  });

  it("ignores a commented-out declaration or rule", () => {
    const light = declarations(css, "light");
    expect(light.get("--ink")).toBe("var(--n-950)");
    expect(light.get("--bg")).toBe("#F6F6F3");
  });

  it("in dark, the prefers-color-scheme: dark :root block overrides the light value; other @media blocks do not", () => {
    const dark = declarations(css, "dark");
    expect(dark.get("--bg")).toBe("#15161A");
    expect(dark.get("--line")).toBe("#DDDDD8"); // .panel inside the dark block is not :root
    expect(dark.has("--only-here")).toBe(false);
  });

  it("in light, the dark block is not read", () => {
    expect(declarations(css, "light").get("--bg")).toBe("#F6F6F3");
  });

  it("reads a selector list that includes :root, and ignores a compound selector such as :root:not(...)", () => {
    const list = `:root, [data-theme="light"] { --x: #111111; } :root:not(.a) { --y: #222222; } :root.dark { --z: #333333; }`;
    expect(Object.fromEntries(declarations(list, "light"))).toEqual({ "--x": "#111111" });
  });

  it("with two :root rules, the later one wins", () => {
    const two = `:root { --bg: #111111; --ink: #000000; } :root { --bg: #222222; }`;
    expect(Object.fromEntries(declarations(two, "light"))).toEqual({ "--bg": "#222222", "--ink": "#000000" });
  });

  it("reads every dark block, the later one winning", () => {
    const two = `
      :root { --bg: #FFFFFF; --ink: #000000; --line: #DDDDDD; }
      @media (prefers-color-scheme: dark) { :root { --bg: #111111; --ink: #EEEEEE; } }
      @media (prefers-color-scheme: dark) { :root { --bg: #222222; } }
    `;
    expect(Object.fromEntries(declarations(two, "dark"))).toEqual({ "--bg": "#222222", "--ink": "#EEEEEE", "--line": "#DDDDDD" });
  });

  it("applies :root rules and dark blocks in SOURCE order: a light :root after the dark block wins in dark too", () => {
    // What a browser does: the media query only gates the block; the cascade between two :root rules of equal
    // specificity is decided by which comes later in the file.
    const late = `
      :root { --bg: #FFFFFF; }
      @media (prefers-color-scheme: dark) { :root { --bg: #111111; --ink: #EEEEEE; } }
      :root { --bg: #F6F6F3; }
    `;
    expect(Object.fromEntries(declarations(late, "dark"))).toEqual({ "--bg": "#F6F6F3", "--ink": "#EEEEEE" });
    expect(Object.fromEntries(declarations(late, "light"))).toEqual({ "--bg": "#F6F6F3" });
  });
});

describe("merge", () => {
  it("lets a later stylesheet override an earlier one, as source order does", () => {
    const shared = decls({ "--n-950": "#15161A", "--bg": "#FFFFFF" });
    const surface = decls({ "--bg": "var(--n-950)" });
    const all = merge(shared, surface);
    expect(all.get("--bg")).toBe("var(--n-950)");
    expect(resolve("--bg", all)).toBe("#15161A");
  });
});

describe("CONSOLE_STYLESHEETS", () => {
  it("is the console's real load order: the page's links, with app.css's @import of tokens.css before app.css", () => {
    const read = (f: string) => readFileSync(resolvePath(process.cwd(), f), "utf8");
    const links = [...read("public/app/index.html").matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(\/[^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual(["/shared/tokens.css", "/app/app.css", "/app/console-v2.css"]);
    // An @import must precede every other rule, so it is applied before app.css's own :root.
    expect(read("public/app/app.css").trimStart()).toMatch(/^@import url\("\.\/tokens\.css"\);/);
    expect(CONSOLE_STYLESHEETS).toEqual(["public/shared/tokens.css", "public/app/tokens.css", "public/app/app.css", "public/app/console-v2.css"]);
    expect(stylesheetDeclarations(CONSOLE_STYLESHEETS, "light").size).toBeGreaterThan(0);
  });
});
