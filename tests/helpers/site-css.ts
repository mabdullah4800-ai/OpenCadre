import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** public/site/site.css without its comments. */
export const siteCss = () => readFileSync(resolve(process.cwd(), "public/site/site.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `@supports selector(:has(*)) { ... }` block: [start, end) offsets of the whole block and its inner text. */
function hasBlocks(css: string): { start: number; end: number; inner: string }[] {
  const out: { start: number; end: number; inner: string }[] = [];
  const re = /@supports\s+selector\(:has\(\*\)\)\s*\{/g;
  for (let m; (m = re.exec(css));) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth > 0; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    out.push({ start: m.index, end: i, inner: css.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

/** The stylesheet a browser WITHOUT :has() applies: every `@supports selector(:has(*))` block removed. */
export function withoutHas(css: string): string {
  let text = css;
  for (const b of hasBlocks(css).reverse()) text = text.slice(0, b.start) + text.slice(b.end);
  return text;
}

/** What only a browser WITH :has() adds: the inside of every `@supports selector(:has(*))` block. */
export const onlyWithHas = (css: string): string => hasBlocks(css).map((b) => b.inner).join("\n");

/** The innermost rules of a stylesheet (those inside @media come out too), as selector and declarations. */
export const rulesOf = (css: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] }));

/** Rules whose selector matches `sel` and which hide what they select. */
export const hiding = (css: string, sel: RegExp) => rulesOf(css).filter((r) => sel.test(r.selector) && /display:\s*none/.test(r.body));
