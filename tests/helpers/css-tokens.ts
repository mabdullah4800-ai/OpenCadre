// Reads design tokens the way a browser would apply them, so a test can measure the value a role RENDERS as.
//
// Roles are declared as references (`--ink: var(--n-950)`) with the primitive in /shared/tokens.css, loaded first
// (docs/superpowers/plans/2026-09-29-design-tokens.md, Option A). A test that regex-reads a literal hex beside a role
// name finds nothing once the role is a var(), or worse, finds a stale literal somewhere else in the file. These three
// functions model only what the token files use, and fail loudly on anything they cannot answer:
//
//   declarations(css, scheme)  ONE file. The custom properties on top-level `:root` rules (a selector list counts
//                              when one of its selectors is exactly `:root`) and, for "dark" only, on the `:root`
//                              rules inside `@media (prefers-color-scheme: dark)` blocks. All of these are applied in
//                              SOURCE ORDER, a later declaration replacing an earlier one, so a light `:root` after a
//                              dark block wins in dark too, as in the browser. Other selectors (`:root:not(...)`,
//                              `.panel`) and other @media blocks are ignored: they do not set the page-wide value.
//   merge(...maps)             SEVERAL files: pass each file's declarations() in the order the page loads them; a
//                              later file's declaration replaces an earlier one's.
//   resolve(name, decls)       substitutes every var(--x) / var(--x, fallback) to the final value; throws on a cycle
//                              or on an unknown name with no fallback, never answers "undefined".
//   stylesheetDeclarations(files, scheme) and CONSOLE_STYLESHEETS: the two above for a real page's files, in its
//                              load order.
//
// It is deliberately not a CSS parser: no cascade by specificity, no !important, no nested @supports. If a token
// file starts using one of those, extend this and add the case to tests/css-tokens.test.ts first.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export type Scheme = "light" | "dark";

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level blocks as [prelude, body], brace-matched so a nested @media body stays whole. */
function blocks(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth < 0) throw new Error(`css-tokens: unbalanced "}" at offset ${i}`);
      if (depth === 0) {
        out.push([css.slice(preludeStart, bodyStart - 1).trim(), css.slice(bodyStart, i)]);
        preludeStart = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      preludeStart = i + 1; // a top-level statement such as @import or @charset
    }
  }
  if (depth !== 0) throw new Error("css-tokens: unbalanced \"{\"");
  return out;
}

const isRoot = (selector: string) => selector.split(",").some((s) => s.trim() === ":root");
const isDarkMedia = (prelude: string) => /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/.test(prelude.replace(/\s+/g, " "));

function customProperties(body: string, into: Map<string, string>) {
  for (const decl of body.split(";")) {
    const m = /^\s*(--[A-Za-z0-9_-]+)\s*:([\s\S]*)$/.exec(decl);
    if (m) into.set(m[1], m[2].trim());
  }
}

export function declarations(css: string, scheme: Scheme): Map<string, string> {
  const out = new Map<string, string>();
  // One pass in source order: the media query only gates its block, so a light :root rule AFTER a dark block still
  // wins in dark, exactly as in the browser. Reading all light rules first and the dark blocks after would not.
  for (const [prelude, body] of blocks(stripComments(css))) {
    if (isRoot(prelude)) customProperties(body, out);
    else if (scheme === "dark" && isDarkMedia(prelude)) {
      for (const [selector, inner] of blocks(body)) if (isRoot(selector)) customProperties(inner, out);
    }
  }
  return out;
}

export function merge(...maps: Array<Map<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of maps) for (const [k, v] of m) out.set(k, v);
  return out;
}

/** The index of the ")" that closes the "(" at `open`. */
function closing(value: string, open: number): number {
  let depth = 0;
  for (let i = open; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")" && --depth === 0) return i;
  }
  throw new Error(`css-tokens: unbalanced parentheses in "${value}"`);
}

function substitute(value: string, decls: Map<string, string>, stack: string[]): string {
  let out = "";
  let i = 0;
  for (let at = value.indexOf("var(", i); at !== -1; at = value.indexOf("var(", i)) {
    const end = closing(value, at + 3);
    const inner = value.slice(at + 4, end);
    const comma = inner.indexOf(",");
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    // A declared name in a cycle THROWS (via lookup) rather than taking the fallback as a browser would: deliberate, a
    // cycle in a token file is a bug a test must surface, not a value to measure.
    const replacement = decls.has(name) || fallback === undefined
      ? lookup(name, decls, stack)
      : substitute(fallback, decls, stack);
    out += value.slice(i, at) + replacement;
    i = end + 1;
  }
  return out + value.slice(i);
}

function lookup(name: string, decls: Map<string, string>, stack: string[]): string {
  if (stack.includes(name)) throw new Error(`css-tokens: cycle ${[...stack, name].join(" -> ")}`);
  const value = decls.get(name);
  if (value === undefined) {
    throw new Error(`css-tokens: ${name} is not declared${stack.length ? ` (reached from ${stack.join(" -> ")})` : ""}`);
  }
  return substitute(value, decls, [...stack, name]);
}

export function resolve(name: string, decls: Map<string, string>): string {
  return lookup(name, decls, []);
}

/** The console's stylesheets in the order the page applies them: index.html links /shared/tokens.css, then app.css,
 * whose first statement @imports ./tokens.css (so tokens.css's rules come BEFORE app.css's own), then console-v2.css.
 * tests/css-tokens.test.ts checks this against index.html and app.css, so a reordered page fails there first. */
export const CONSOLE_STYLESHEETS = ["public/shared/tokens.css", "public/app/tokens.css", "public/app/app.css", "public/app/console-v2.css"];

/** declarations() of several stylesheets, read from the repo root and merged in the order given. */
export function stylesheetDeclarations(files: readonly string[], scheme: Scheme): Map<string, string> {
  return merge(...files.map((f) => declarations(readFileSync(resolvePath(process.cwd(), f), "utf8"), scheme)));
}
