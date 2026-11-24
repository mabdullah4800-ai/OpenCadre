// A small cascade for layout rules: which value a property ends up with on a real element, at a given viewport width,
// across a page's stylesheets in load order. For tests of the form "at 1100px the rail's badge is positioned" where
// happy-dom (no layout, partial CSS) cannot answer and a regex over one rule would miss a later rule that overrides it.
//
// What it models: @media blocks with min-width / max-width / prefers-color-scheme / prefers-reduced-motion / forced-colors
// (nested blocks AND together); selector lists matched against the element with Element.matches (keyboard focus as an option);
// Selectors 4 specificity (:is/:not/:has take their most specific argument, :where counts nothing); source order;
// !important; the padding, margin and overflow shorthands. An unknown media feature, an unmodelled at-rule or a
// selector happy-dom cannot parse throws rather than guessing.
//
// Known gaps, so a reader does not over-trust it: no other shorthand is expanded (font, border, inset, outline, grid-area,
// background...: a test must ask for the property as written, and a longhand set elsewhere is not merged into it);
// @supports, @keyframes, @starting-style and @font-face bodies are skipped; values are returned as written, with no
// var() or env() substitution and no calc(); selectors with a pseudo-element are skipped (they style another box); no
// inheritance, no inline styles, no layout.
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export type Env = { width: number; dark?: boolean; reducedMotion?: boolean; forcedColors?: boolean };
type Decl = { prop: string; value: string; important: boolean };
export type Rule = { media: string[]; selectors: string[]; decls: Decl[]; order: number };

export const CONSOLE_LAYOUT_STYLESHEETS = ["public/app/app.css", "public/app/console-v2.css"];

/** Split on a separator character at nesting depth 0 (outside parentheses, brackets and quotes). */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && (sep === " " ? /\s/.test(c) : c === sep)) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const SKIPPED_AT_RULES = /^@(supports|keyframes|-webkit-keyframes|starting-style|font-face)\b/;

export function parseRules(files: string[]): Rule[] {
  return parseCss(...files.map((file) => readFileSync(resolvePath(process.cwd(), file), "utf8")));
}

/** Rules from CSS text; several texts are one page's stylesheets in load order. */
export function parseCss(...texts: string[]): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  const walk = (css: string, media: string[]) => {
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
        if (depth < 0) throw new Error(`css-cascade: unbalanced "}" at ${i}`);
        if (depth === 0) {
          const prelude = css.slice(preludeStart, bodyStart - 1).trim().replace(/\s+/g, " ");
          const body = css.slice(bodyStart, i);
          if (prelude.startsWith("@media")) walk(body, [...media, prelude.slice(6).trim()]);
          else if (SKIPPED_AT_RULES.test(prelude)) { /* not modelled */ }
          else if (prelude.startsWith("@")) throw new Error(`css-cascade: unmodelled at-rule ${prelude}`);
          else {
            const decls: Decl[] = [];
            for (const d of splitTop(body, ";")) {
              const colon = d.indexOf(":");
              if (colon < 0) continue;
              let value = d.slice(colon + 1).trim();
              const important = /!important$/.test(value);
              if (important) value = value.replace(/\s*!important$/, "");
              decls.push(...expand(d.slice(0, colon).trim().toLowerCase(), value).map(([prop, v]) => ({ prop, value: v, important })));
            }
            rules.push({ media, selectors: splitTop(prelude, ","), decls, order: order++ });
          }
          preludeStart = i + 1;
        }
      } else if (c === ";" && depth === 0) {
        preludeStart = i + 1;
      }
    }
  };
  for (const text of texts) walk(text.replace(/\/\*[\s\S]*?\*\//g, ""), []);
  return rules;
}

function expand(prop: string, value: string): Array<[string, string]> {
  if (prop === "padding" || prop === "margin") {
    const v = splitTop(value, " ");
    const [t, r = t, b = t, l = r] = v;
    return [[`${prop}-top`, t], [`${prop}-right`, r], [`${prop}-bottom`, b], [`${prop}-left`, l]];
  }
  if (prop === "overflow") {
    const [x, y = x] = splitTop(value, " ");
    return [["overflow", value], ["overflow-x", x], ["overflow-y", y]];
  }
  return [[prop, value]];
}

export function mediaMatches(media: string, env: Env): boolean {
  return media.split(/\s+and\s+/).every((cond) => {
    const m = cond.trim().match(/^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/);
    if (!m) throw new Error(`css-cascade: unmodelled media condition ${cond}`);
    const [, feature, val] = m;
    if (feature === "min-width") return env.width >= parseFloat(val);
    if (feature === "max-width") return env.width <= parseFloat(val);
    if (feature === "prefers-color-scheme") return (val === "dark") === Boolean(env.dark);
    if (feature === "prefers-reduced-motion") return (val === "reduce") === Boolean(env.reducedMotion);
    if (feature === "forced-colors") return (val === "active") === Boolean(env.forcedColors);
    throw new Error(`css-cascade: unmodelled media feature ${feature}`);
  });
}

type Spec = [number, number, number];
const beats = (a: Spec, b: Spec) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** [ids, classes/attributes/pseudo-classes, types] for one complex selector (Selectors 4 §17): :is(), :not() and :has()
 * count the MOST specific selector of their argument list, :where() counts nothing, any other functional pseudo-class
 * counts as one pseudo-class, and * counts nothing. */
export function specificity(selector: string): Spec {
  let total: Spec = [0, 0, 0];
  let s = selector;
  // Functional pseudo-classes, innermost handled by recursion: cut each out and add what it is worth.
  for (let m = s.match(/:([\w-]+)\(/); m; m = s.match(/:([\w-]+)\(/)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < s.length; close++) {
      if (s[close] === "(") depth++;
      else if (s[close] === ")" && --depth === 0) break;
    }
    if (depth !== 0) throw new Error(`css-cascade: unbalanced parentheses in ${selector}`);
    const name = m[1].toLowerCase();
    const arg = s.slice(open + 1, close);
    let worth: Spec = [0, 0, 0];
    if (name === "is" || name === "not" || name === "has") {
      for (const part of splitTop(arg, ",")) {
        const sp = specificity(part.replace(/^[>+~]\s*/, ""));
        if (beats(sp, worth) > 0) worth = sp;
      }
    } else if (name !== "where") worth = [0, 1, 0];
    total = [total[0] + worth[0], total[1] + worth[1], total[2] + worth[2]];
    s = `${s.slice(0, m.index)} ${s.slice(close + 1)}`;
  }
  const attrs = (s.match(/\[[^\]]*\]/g) ?? []).length;
  s = s.replace(/\[[^\]]*\]/g, " ");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+/g) ?? []).length + (s.match(/(?<!:):[\w-]+/g) ?? []).length + attrs;
  const types = (s.replace(/::?[\w-]+|[#.][\w-]+/g, " ").match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length
    + (s.match(/::[\w-]+/g) ?? []).length;
  return [total[0] + ids, total[1] + classes, total[2] + types];
}

const FOCUS = /:focus(-visible)?(?![\w-])/g;

/** Matches `sel` with the element keyboard-focused (`focus: true`: :focus and :focus-visible hold, :not(:focus...)
 * fails) or not (they fail, :not(:focus...) holds). happy-dom has no focus-visible state to ask. Other interaction
 * states (:hover, :active, :open) are happy-dom's own answer: not holding (tests/css-cascade.test.ts pins that). A
 * selector happy-dom cannot parse THROWS, so it can never drop out of the cascade unnoticed. */
function matchesInState(el: Element, sel: string, focus: boolean): boolean {
  let s = sel;
  if (/:not\(:focus(-visible)?\)/.test(s)) {
    if (focus) return false;
    s = s.replace(/:not\(:focus(-visible)?\)/g, "");
  }
  if (FOCUS.test(s)) {
    FOCUS.lastIndex = 0;
    if (!focus) return false;
    s = s.replace(FOCUS, "");
  }
  FOCUS.lastIndex = 0;
  try {
    return el.matches(s || "*");
  } catch (err) {
    throw new Error(`css-cascade: cannot match selector ${JSON.stringify(sel)}: ${(err as Error).message}`);
  }
}

/** The winning value of each property on `el` at `env`, from the rules whose selector matches it. */
export function computed(el: Element, rules: Rule[], env: Env, { focus = false }: { focus?: boolean } = {}): Record<string, string> {
  type Hit = Decl & { spec: [number, number, number]; order: number };
  const hits: Hit[] = [];
  for (const rule of rules) {
    if (!rule.media.every((m) => mediaMatches(m, env))) continue;
    let best: [number, number, number] | null = null;
    for (const sel of rule.selectors) {
      if (sel.includes("::")) continue;
      const ok = matchesInState(el, sel, focus);
      if (ok) { const sp = specificity(sel); if (!best || beats(sp, best) > 0) best = sp; }
    }
    if (best) for (const d of rule.decls) hits.push({ ...d, spec: best, order: rule.order });
  }
  hits.sort((a, b) => Number(a.important) - Number(b.important) || beats(a.spec, b.spec) || a.order - b.order);
  const out: Record<string, string> = {};
  for (const h of hits) out[h.prop] = h.value;
  return out;
}
