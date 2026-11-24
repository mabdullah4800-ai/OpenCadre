#!/usr/bin/env node
// ui-lint: report-only checks for the mechanical rules in docs/ui-rules.md (adapted from unslop, CC BY 4.0,
// .claude/skills/unslop/NOTICE.md). It reads public/app/*.css, public/shared/*.css, every
// public/**/*.html and every public/**/*.js and *.mjs, prints file:line findings and a count per rule, and exits 0.
// `--strict` exits 1 when anything is found. It is a grep with a little CSS and JS awareness, not a parser: it is not
// wired into CI, a finding is a prompt to look, not a verdict, and its counts are an UNDERCOUNT (docs/ui-rules.md
// lists what it cannot see).
//
//   node scripts/ui-lint.mjs            report
//   node scripts/ui-lint.mjs --strict   report, exit 1 on any finding
//
// Comments are blanked before matching (line numbers are kept). In HTML, <style> bodies, style="" attributes, class
// attributes, headings, text and inline <script> bodies (not JSON ones) are checked. In JS, string literals are
// checked for copy and glyphs, and code for loops.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RULES = [
  "font-weight-heavy",
  "font-load-heavy",
  "uppercase",
  "negative-tracking",
  "transition-all",
  "infinite-animation",
  "js-loop",
  "italic",
  "heading-period",
  "emoji",
  "arrow-separator",
  "em-dash",
  "placeholder-copy",
  "helper-text",
  "amber-misuse",
  "hue-gradient",
  "off-grid",
  "pill-radius",
];

// Looping motion is for live things only. These are the four loops on main that are live, by exact selector: the
// button spinner, the loading skeleton, the console's live dot and the working-state dot. Anything else that loops is
// reported, however it is named (a substring allowlist exempted any selector containing "live" or "dot").
export const INFINITE_ALLOW = new Set([".btn.is-loading::after", ".skeleton", ".live-dot.is-live", ".state-dot--working"]);
// 999px is for avatars and dots only, matched against each selector in the owning list.
const PILL_ALLOW = /avatar|dot\b|-dot|dot-/i;
// Amber means waiting on a person. Selectors allowed to paint with an amber token (--wait-*, --amber*, or a custom
// property defined from one), by exact selector. Only selectors whose own code or comment says a person is being
// waited on are listed: a clearance (approval) request and its decision row, the console's waiting state (dot, word,
// row edge), and the site's asking and needed nodes, ask wire, wait glyphs, status and tag. Every other use is
// reported for a person to judge: status-chip.chip-waiting (a computer connecting), live-dot.is-polling, task.stale,
// callout, risk-medium, the p1 priority chips, badges and strips, conflict and warn nodes and wires, rail-dot.dot-amber,
// and .badge, the inbox count, which adds unread messages and mentions to pending approvals (app.js
// updateInboxBadge), so it is not a count of people being waited on.
export const AMBER_ALLOW = new Set([
  ".strip.clearance",
  ".decide",
  ".inbox-queue-list .strip.clearance.is-selected",
  ".state-dot--waiting",
  ".state-dot--waiting::after",
  ".state-chip:has(.state-dot--waiting) .state-word",
  ".strip--waiting .strip-id",
  ".node-you.node-needed",
  ".node-asking",
  ".wire-ask",
  ".glyph-wait",
  ".node-you .glyph-wait",
  ".stage-tag",
  ".status.wait",
  ".mx-out-wait",
  ".mx-glyph-wait",
  ".mx-out-wait .mx-head",
]);

/** Splits a selector list on its top-level commas, leaving commas inside :is() :where() :has() :not() and [attr]. */
export function splitSelectors(list) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const c of list) {
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// Emoji and pictographs used as icons: the emoji blocks, Misc Symbols and Dingbats (which hold ✓ ✔ ✕ ✨ ⚠), ⭐ ⭕,
// and the emoji variation selector. Deliberately excludes © ® ™, which are ordinary typography.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\u{FE0F}]/u;
const ARROW_SEP = /[\u2190-\u2193\u2197\u2198]| \u00B7 /;
const PLACEHOLDER = /in this example|illustrated example|no live workspace/i;
const EM_DASH = /\u2014/;
const HELPER_CLASS = /^(?:kicker|lede|field-hint|rule-note|[\w-]+-note)$/;
const SPACING_PROP = /^(?:margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|width|height|min-width|min-height|max-width|max-height)(?:-[a-z-]+)?$/;
const WEIGHT_VAR = /^--(?:fw|font-weight)\b|weight/i;
const MAX_WEIGHT = 600;

const blank = (s) => s.replace(/[^\n]/g, " ");
const norm = (s) => s.replace(/\s+/g, " ").trim();

/** Replaces CSS comments with spaces, keeping newlines so line numbers hold. */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** Walks CSS and yields each declaration with its line, the selector that owns it, its rule id and its at-rules. */
function* declarations(css, lineOffset = 0) {
  const text = stripCssComments(css);
  const stack = [];
  let ruleSeq = 0;
  let start = 0;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      stack.push({ head: text.slice(start, i).trim(), id: ++ruleSeq });
      start = i + 1;
      startLine = line;
    } else if (c === "}" || c === ";") {
      const body = text.slice(start, i);
      const lead = body.match(/^\s*/)[0];
      const declLine = startLine + (lead.match(/\n/g) || []).length;
      const decl = body.trim();
      if (decl && decl.includes(":")) {
        const rules = stack.filter((s) => !s.head.startsWith("@"));
        yield {
          decl,
          line: declLine + lineOffset,
          selector: norm(rules.map((s) => s.head).join(" ")),
          ruleId: stack.length ? stack[stack.length - 1].id : 0,
          atRules: stack.filter((s) => s.head.startsWith("@")).map((s) => s.head).join(" "),
        };
      }
      if (c === "}") stack.pop();
      start = i + 1;
      startLine = line;
    }
    if (c === "\n") line++;
  }
}

/** Custom properties declared in some stylesheets, so var() can be resolved and amber aliases found. */
export function buildContext(cssTexts) {
  const vars = new Map();
  for (const css of cssTexts) {
    for (const { decl } of declarations(css)) {
      const colon = decl.indexOf(":");
      const prop = decl.slice(0, colon).trim();
      if (prop.startsWith("--") && !vars.has(prop)) vars.set(prop, decl.slice(colon + 1).trim());
    }
  }
  const amber = new Set([...vars.keys()].filter((n) => /^--(?:wait-|amber)/.test(n)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, value] of vars) {
      if (amber.has(name)) continue;
      if ([...value.matchAll(/var\(\s*(--[\w-]+)/g)].some((m) => amber.has(m[1]) || /^--(?:wait-|amber)/.test(m[1]))) {
        amber.add(name);
        changed = true;
      }
    }
  }
  return { vars, amber };
}

function resolve(value, vars) {
  let v = value;
  for (let n = 0; n < 8 && /var\(/.test(v); n++) {
    v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fallback) => vars.get(name) ?? fallback ?? "");
  }
  return v;
}

const heavyToken = (t) => /^(?:bold|bolder)$/.test(t) || (/^\d{3,4}$/.test(t) && Number(t) > MAX_WEIGHT && Number(t) <= 1000);

/** Smallest rendered size of a font-size or font shorthand value, in rem; null when it cannot be told. */
function sizeRem(value, shorthand) {
  let v = value.trim();
  const clamp = v.match(/clamp\(\s*([^,]+),/);
  if (clamp) v = clamp[1];
  const tokens = v.split(/\s+/);
  const tok = shorthand ? tokens.find((t) => /^[\d.]+(?:px|rem|em)(?:\/|$)/.test(t)) : tokens[0];
  const m = tok?.match(/^([\d.]+)(px|rem|em)/);
  if (!m) return null;
  return m[2] === "px" ? Number(m[1]) / 16 : Number(m[1]);
}

function parseColor(s) {
  let r, g, b, a = 1;
  let m;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/i))) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
  } else if ((m = s.match(/^rgba?\(([^)]*)\)$/i))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    [r, g, b] = p;
    if (p.length > 3) a = p[3];
  } else if ((m = s.match(/^hsla?\(([^)]*)\)$/i))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => parseFloat(x));
    return { h: p[0], s: p[1] / 100, l: p[2] / 100, a: p.length > 3 ? p[3] : 1 };
  } else return null;
  [r, g, b] = [r, g, b].map((x) => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l, a };
  const sat = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s: sat, l, a };
}

/** True when a gradient blends a colour with anything else: a hue into a neutral, a wash, or two tones of a hue.
 * Only a tone shift between neutrals is allowed. A single colour drawn against `transparent` (a dot or a square
 * painted with a gradient) is not a blend. Colours it cannot resolve (color-mix, currentColor, names) are skipped. */
function isHueGradient(value, vars) {
  if (!/gradient\(/i.test(value)) return false;
  const v = resolve(value, vars);
  const found = [...v.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi)].map((m) => [m[0].toLowerCase(), parseColor(m[0])]).filter(([, c]) => c && c.a > 0.05);
  const distinct = new Set(found.map(([s]) => s));
  const chromatic = found.some(([, c]) => c.s >= 0.2 && c.l > 0.08 && c.l < 0.97);
  return chromatic && distinct.size >= 2;
}

function cssFindings(css, ctx, lineOffset = 0) {
  const out = [];
  const add = (rule, line, text) => out.push({ rule, line, text });
  const byRule = new Map();
  // A custom property declared inside a rule (like `--c` on a glyph) means that rule's own value there.
  const local = new Map();
  const isAmber = (name, ruleId) => {
    const own = local.get(ruleId)?.get(name);
    if (own !== undefined) return [...own.matchAll(/var\(\s*(--[\w-]+)/g)].some((m) => isAmber(m[1], -1));
    return ctx.amber.has(name) || /^--(?:wait-|amber)/.test(name);
  };
  const label = (selector, decl) => `${selector.length > 70 ? `…${selector.slice(-70)}` : selector} { ${decl} }`;
  for (const d of declarations(css, lineOffset)) {
    const { decl, line, selector, atRules, ruleId } = d;
    const parts = splitSelectors(selector);
    const colon = decl.indexOf(":");
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    const v = value.toLowerCase();
    if (!byRule.has(ruleId)) byRule.set(ruleId, []);
    byRule.get(ruleId).push({ prop, value, line, decl });

    if (prop.startsWith("--")) {
      if (!local.has(ruleId)) local.set(ruleId, new Map());
      local.get(ruleId).set(prop, value);
      if (WEIGHT_VAR.test(prop) && v.split(/\s+/).some(heavyToken)) add("font-weight-heavy", line, decl);
      continue;
    }
    const rv = resolve(v, ctx.vars).toLowerCase();
    if (prop === "font-weight" && rv.split(/\s+/).some(heavyToken)) add("font-weight-heavy", line, decl);
    if (prop === "font" && rv.split(/[\s/]+/).some(heavyToken)) add("font-weight-heavy", line, decl);
    if (prop === "text-transform" && /\buppercase\b/.test(v)) add("uppercase", line, decl);
    if ((prop === "transition" || prop === "transition-property") && /(?:^|,)\s*all\b/.test(v)) add("transition-all", line, decl);
    // Allowlists are checked per selector in a list, so an allowed selector never exempts its neighbours; only the
    // selectors that are not allowed are reported.
    if ((prop === "animation" || prop === "animation-iteration-count") && /\binfinite\b/.test(v) && !/@keyframes/.test(atRules)) {
      const bad = parts.filter((p) => !INFINITE_ALLOW.has(p));
      if (bad.length) add("infinite-animation", line, label(bad.join(", "), decl));
    }
    if ((prop === "font-style" || prop === "font") && /\b(?:italic|oblique)\b/.test(v)) add("italic", line, decl);
    if (prop === "border-radius" && (/\b9{3,}px\b/.test(v) || /var\(--radius-pill\)/.test(v))) {
      const bad = parts.filter((p) => !PILL_ALLOW.test(p));
      if (bad.length) add("pill-radius", line, label(bad.join(", "), decl));
    }
    if ([...value.matchAll(/var\(\s*(--[\w-]+)/g)].some((m) => isAmber(m[1], ruleId))) {
      const bad = parts.filter((p) => !AMBER_ALLOW.has(p));
      if (bad.length) add("amber-misuse", line, label(bad.join(", "), decl));
    }
    // Paint only: a mask gradient sets alpha, so its colours never show.
    if (/^(?:background|background-image|border-image|border-image-source)$/.test(prop) && isHueGradient(value, ctx.vars)) add("hue-gradient", line, decl);
    if (SPACING_PROP.test(prop) && [...v.matchAll(/(?<![\w.])(\d+)px\b/g)].some((m) => Number(m[1]) >= 3 && Number(m[1]) % 2 === 1)) {
      add("off-grid", line, label(selector, decl));
    }
  }
  // Negative tracking on text under 1.5rem: needs the rule's own size, so a rule that inherits its size is not seen.
  for (const decls of byRule.values()) {
    const ls = decls.find((x) => x.prop === "letter-spacing");
    if (!ls || !/^-/.test(resolve(ls.value, ctx.vars).trim())) continue;
    const fs = decls.find((x) => x.prop === "font-size") ?? decls.find((x) => x.prop === "font");
    if (!fs) continue;
    const rem = sizeRem(resolve(fs.value, ctx.vars), fs.prop === "font");
    if (rem !== null && rem < 1.5) add("negative-tracking", ls.line, `${ls.decl} at ${fs.decl}`);
  }
  return out;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

const decodeEntities = (l) =>
  l.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&mdash;/g, "\u2014").replace(/&rarr;/g, "\u2192").replace(/&middot;/g, "\u00B7");

function emojiFindings(text, lineOffset = 0) {
  const out = [];
  text.split("\n").forEach((l, i) => {
    if (EMOJI.test(decodeEntities(l))) out.push({ rule: "emoji", line: i + 1 + lineOffset, text: l.trim().slice(0, 120) });
  });
  return out;
}

/** Font loads (Google Fonts URLs) whose Geist weight axis goes above 600. */
function fontLoadFindings(text, lineOffset = 0) {
  const out = [];
  for (const m of text.matchAll(/family=(Geist(?:\+Mono)?):[^&"'\s)]*?wght@([\d.,;]+)/g)) {
    const weights = [...m[2].matchAll(/\d{3,4}/g)].map((x) => Number(x[0]));
    if (Math.max(...weights) > MAX_WEIGHT) out.push({ rule: "font-load-heavy", line: lineOf(text, m.index) + lineOffset, text: `${m[1]}:wght@${m[2]}` });
  }
  return out;
}

const helperTokens = (classList) => classList.split(/\s+/).filter((t) => HELPER_CLASS.test(t));

/** Copy rules shared by HTML text and JS strings. */
function copyFindings(text, line) {
  const out = [];
  const t = decodeEntities(text);
  const show = norm(text).slice(0, 100);
  if (ARROW_SEP.test(t)) out.push({ rule: "arrow-separator", line, text: show });
  if (EM_DASH.test(t)) out.push({ rule: "em-dash", line, text: show });
  if (PLACEHOLDER.test(t)) out.push({ rule: "placeholder-copy", line, text: show });
  return out;
}

/** Splits JS into string literals and code with comments and strings blanked. Regex literals are not recognised. */
export function scanJs(js) {
  const strings = [];
  let code = "";
  let line = 1;
  let i = 0;
  while (i < js.length) {
    const c = js[i];
    const next = js[i + 1];
    if (c === "/" && next === "/") {
      const end = js.indexOf("\n", i);
      const stop = end === -1 ? js.length : end;
      code += blank(js.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = js.indexOf("*/", i + 2);
      const stop = end === -1 ? js.length : end + 2;
      const chunk = js.slice(i, stop);
      code += blank(chunk);
      line += (chunk.match(/\n/g) || []).length;
      i = stop;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < js.length && js[j] !== c) {
        if (js[j] === "\\") j++;
        else if (js[j] === "\n" && c !== "`") break;
        j++;
      }
      const chunk = js.slice(i, j + 1);
      strings.push({ text: js.slice(i + 1, j), line });
      code += c + blank(chunk.slice(1, -1)) + (chunk.length > 1 ? chunk.slice(-1) : "");
      line += (chunk.match(/\n/g) || []).length;
      i = j + 1;
    } else {
      code += c;
      if (c === "\n") line++;
      i++;
    }
  }
  return { code, strings };
}

/** Lints one script's text. */
export function lintJs(js, lineOffset = 0) {
  const out = [];
  const { code, strings } = scanJs(js);
  for (const m of code.matchAll(/\b(setInterval|requestAnimationFrame)\s*\(/g)) {
    out.push({ rule: "js-loop", line: lineOf(code, m.index) + lineOffset, text: m[1] });
  }
  for (const s of strings) {
    const line = s.line + lineOffset;
    out.push(...copyFindings(s.text, line));
    if (EMOJI.test(decodeEntities(s.text))) out.push({ rule: "emoji", line, text: norm(s.text).slice(0, 100) });
    const classes = [...s.text.matchAll(/class(?:Name)?\s*=\s*\\?["']([^"'\\]*)/g)].map((m) => m[1]);
    if (/^[\w-]+(?: [\w-]+)*$/.test(s.text.trim())) classes.push(s.text.trim());
    const helpers = classes.flatMap(helperTokens);
    if (helpers.length) out.push({ rule: "helper-text", line, text: helpers.join(" ") });
    out.push(...fontLoadFindings(s.text, line - 1));
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Lints one stylesheet's text. */
export function lintCss(css, ctx = buildContext([css])) {
  const clean = stripCssComments(css);
  return [...cssFindings(css, ctx), ...emojiFindings(clean), ...fontLoadFindings(clean)].sort((a, b) => a.line - b.line);
}

/** Lints one HTML document's text. */
export function lintHtml(html, ctx) {
  const out = [];
  let text = html.replace(/<!--[\s\S]*?-->/g, blank);
  // Inline scripts get the JS rules; JSON blocks (structured data) are not UI.
  for (const m of text.matchAll(/(<script\b([^>]*)>)([\s\S]*?)<\/script>/gi)) {
    if (/type\s*=\s*["']?application\/(?:ld\+)?json/i.test(m[2])) continue;
    out.push(...lintJs(m[3], lineOf(text, m.index + m[1].length) - 1));
  }
  text = text.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, a, body, b) => a + blank(body) + b);
  const styles = [...text.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)];
  const context = ctx ?? buildContext(styles.map((m) => m[2]));
  for (const m of styles) out.push(...cssFindings(m[2], context, lineOf(text, m.index + m[1].length) - 1));
  for (const m of text.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    out.push(...cssFindings(`x{${m[2]}}`, context, lineOf(text, m.index) - 1));
  }
  for (const m of text.matchAll(/\sclass\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    const helpers = helperTokens(m[2]);
    if (helpers.length) out.push({ rule: "helper-text", line: lineOf(text, m.index), text: helpers.join(" ") });
  }
  for (const m of text.matchAll(/<em\b/gi)) out.push({ rule: "italic", line: lineOf(text, m.index), text: "<em>" });
  for (const m of text.matchAll(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const inner = m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (/\.$/.test(inner)) out.push({ rule: "heading-period", line: lineOf(text, m.index), text: `<${m[1]}>${inner.slice(-80)}` });
  }
  const noStyle = text.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, a, body, b) => a + blank(body) + b);
  // Text nodes: everything between tags, with the <head> left out (titles and meta are not on the page).
  const body = noStyle.replace(/<head\b[\s\S]*?<\/head>/i, blank);
  for (const m of body.matchAll(/>([^<]+)</g)) {
    if (!m[1].trim()) continue;
    const lead = m[1].match(/^\s*/)[0];
    out.push(...copyFindings(m[1], lineOf(body, m.index + 1) + (lead.match(/\n/g) || []).length));
  }
  out.push(...emojiFindings(noStyle));
  out.push(...fontLoadFindings(noStyle));
  return out.sort((a, b) => a.line - b.line);
}

function walk(dir, keep) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

/** The files the lint reads, relative to `root`, in a stable order. */
export function targetFiles(root) {
  const pub = path.join(root, "public");
  const css = ["app", "shared", "site"].flatMap((d) => {
    const dir = path.join(pub, d);
    try {
      return readdirSync(dir).filter((n) => n.endsWith(".css")).map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  });
  const pages = walk(pub, (f) => /\.(?:html|m?js)$/.test(f));
  return [...css, ...pages].map((f) => path.relative(root, f).replace(/\\/g, "/")).sort();
}

export function lintRepo(root) {
  const files = targetFiles(root).map((rel) => ({ rel, text: readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n") }));
  const ctx = buildContext(files.filter((f) => f.rel.endsWith(".css")).map((f) => f.text));
  const findings = [];
  for (const { rel, text } of files) {
    const found = rel.endsWith(".css") ? lintCss(text, ctx) : rel.endsWith(".html") ? lintHtml(text, ctx) : lintJs(text);
    for (const f of found) findings.push({ file: rel, ...f });
  }
  return findings;
}

export function countByRule(findings) {
  const counts = Object.fromEntries(RULES.map((r) => [r, 0]));
  for (const f of findings) counts[f.rule]++;
  return counts;
}

function main(argv) {
  const strict = argv.includes("--strict");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const findings = lintRepo(root);
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.text}`);
  const counts = countByRule(findings);
  console.log("");
  for (const r of RULES) console.log(`${String(counts[r]).padStart(5)}  ${r}`);
  console.log(`${String(findings.length).padStart(5)}  total (an undercount: see docs/ui-rules.md)`);
  return strict && findings.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
