import { describe, expect, it } from "vitest";
import { countByRule, INFINITE_ALLOW, lintCss, lintHtml, lintJs, RULES, splitSelectors } from "../scripts/ui-lint.mjs";

// scripts/ui-lint.mjs is report-only, so the only thing that keeps it honest is this file: one KNOWN POSITIVE per
// rule (a lint that finds nothing must be shown able to find something), each fixture firing ONLY its own rule, and
// clean fixtures that must stay quiet, including the allowlisted cases that look like positives.

type Finding = { rule: string; line: number; text: string };
const rules = (found: Finding[]) => found.map((f) => f.rule);

const POSITIVES: Record<string, { css?: string; html?: string; js?: string }> = {
  "font-weight-heavy": {
    css: ".title { font-weight: 800; }\n.sub { font: 700 1rem/1.2 var(--display); }\n.h2 { font-weight: 650; }\n:root { --fw-h1: 660; }",
  },
  "font-load-heavy": {
    html: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400..800&family=Geist+Mono:wght@400;500&display=swap">',
    css: '@import url("https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap");',
  },
  uppercase: { css: ".label {\n  text-transform: uppercase;\n  letter-spacing: 0.08em;\n}" },
  "negative-tracking": { css: ".btn { font-size: 0.875rem; letter-spacing: -0.01em; }\n.h3 { font: 500 18px/1.2 var(--font); letter-spacing: -0.02em; }" },
  "transition-all": { css: ".card { transition: all 200ms ease; }" },
  // The substring allowlist exempted both of these: one selector contains "live", the other "dot".
  "infinite-animation": { css: ".cta-live { animation: dash 1s linear infinite; }\n.hero-led-dot { animation: blink 2s infinite; }" },
  "js-loop": { js: "const id = setInterval(tick, 1000);\nrequestAnimationFrame(draw);" },
  italic: { css: ".quote { font-style: italic; }", html: "<p>This is <em>really</em> fast</p>" },
  "heading-period": { html: '<section>\n  <h2 class="x">Agents talk to <span>each other</span>.</h2>\n</section>' },
  emoji: {
    css: '.plan li::before { content: "✓"; }',
    html: "<button>Launch 🚀</button>\n<span>&#10003;</span>",
    js: 'status.textContent = "Connected ✓";',
  },
  "arrow-separator": { js: "const a = 'Open the board →';\nconst b = `2 computers · 3 agents`;", html: "<p>Fleet · 3 agents</p>" },
  "em-dash": { js: 'msg = "Code expired — add the computer again";', html: "<p>One step — then the next</p>" },
  "placeholder-copy": { js: "'<button>Approve in this example</button>'", html: "<figcaption>Illustrated example</figcaption>" },
  "helper-text": { js: "'<p class=\"coord-decision-note\" data-decision-note></p>'", html: '<p class="lede">Text</p>\n<span class="hint field-hint">Text</span>' },
  "amber-misuse": { css: ":root { --amber: #E5940C; --wait-x: var(--amber); }\n.status-chip.chip-waiting { color: var(--wait-x); }" },
  "hue-gradient": { css: ".strip.priority-1 { background-image: linear-gradient(90deg, #FDF3E1, #FFFFFF 40%); }\n.fill { background: linear-gradient(90deg, #4f7df3, #8b5cf6); }" },
  "off-grid": { css: ".role { padding: 3px 9px; }\n.mark { width: 7px; }" },
  "pill-radius": { css: ".card {\n  padding: 16px;\n  border-radius: 999px;\n}\n.tag { border-radius: var(--radius-pill); }" },
};

const lint = { css: lintCss, html: lintHtml, js: lintJs } as Record<string, (s: string) => Finding[]>;

describe("ui-lint", () => {
  it("has a known positive for every rule", () => {
    expect(Object.keys(POSITIVES).sort()).toEqual([...RULES].sort());
  });

  describe.each(Object.entries(POSITIVES))("KNOWN POSITIVE: %s", (rule, fixture) => {
    for (const kind of ["css", "html", "js"] as const) {
      const text = fixture[kind];
      if (!text) continue;
      it(`is found in ${kind.toUpperCase()}, and nothing else is`, () => {
        const found = lint[kind](text);
        expect(rules(found)).toContain(rule);
        expect(new Set(rules(found))).toEqual(new Set([rule]));
      });
    }
  });

  it("finds every positive in a multi-positive fixture, not just the first", () => {
    expect(lintCss(POSITIVES["font-weight-heavy"].css!).map((f) => f.line)).toEqual([1, 2, 3, 4]);
    expect(lintCss(POSITIVES["negative-tracking"].css!).map((f) => f.line)).toEqual([1, 2]);
    expect(lintCss(POSITIVES["infinite-animation"].css!).map((f) => f.line)).toEqual([1, 2]);
    expect(lintCss(POSITIVES["hue-gradient"].css!).map((f) => f.line)).toEqual([1, 2]);
    expect(lintCss(POSITIVES["off-grid"].css!).map((f) => f.line)).toEqual([1, 2]);
    expect(lintJs(POSITIVES["js-loop"].js!).map((f) => f.line)).toEqual([1, 2]);
    expect(lintJs(POSITIVES["arrow-separator"].js!).map((f) => f.line)).toEqual([1, 2]);
    expect(lintHtml(POSITIVES["helper-text"].html!).map((f) => f.text)).toEqual(["lede", "field-hint"]);
  });

  it("reports the line the finding is on", () => {
    expect(lintCss(POSITIVES.uppercase.css!).map((f) => f.line)).toEqual([2]);
    expect(lintCss(POSITIVES["pill-radius"].css!).map((f) => f.line)).toEqual([3, 5]);
    expect(lintHtml(POSITIVES["heading-period"].html!).map((f) => f.line)).toEqual([2]);
    const inStyle = lintHtml("<!doctype html>\n<style>\n.a { color: red; }\n.b { text-transform: uppercase; }\n</style>");
    expect(inStyle.map((f) => [f.rule, f.line])).toEqual([["uppercase", 4]]);
    const js = lintJs("const a = 1;\n/* 'not → a string' */\n// 'nor — this'\nconst s = 'x → y';");
    expect(js.map((f) => [f.rule, f.line])).toEqual([["arrow-separator", 4]]);
    const inScript = lintHtml("<p>ok</p>\n<script>\nlet t = setInterval(f, 5);\n</script>");
    expect(inScript.map((f) => [f.rule, f.line])).toEqual([["js-loop", 3]]);
  });

  it("counts findings per rule, with every rule present", () => {
    const counts = countByRule([...lintCss(POSITIVES.emoji.css!), ...lintHtml(POSITIVES.emoji.html!), ...lintJs(POSITIVES.emoji.js!)]);
    expect(Object.keys(counts).sort()).toEqual([...RULES].sort());
    expect(counts.emoji).toBe(4);
  });

  // A grouped rule is one string; an allowlist that compared the whole string could never match a group, and an entry
  // for the group would exempt every part of it. Each part is judged on its own.
  describe("selector lists are judged one selector at a time", () => {
    it("splits on top-level commas only", () => {
      expect(splitSelectors(".a, .b:is(.c, .d), [data-x='1,2'] .e,\n .f:not(.g, .h)")).toEqual([".a", ".b:is(.c, .d)", "[data-x='1,2'] .e", ".f:not(.g, .h)"]);
    });
    it("amber: the allowed part is exempt and the other part is still reported", () => {
      const found = lintCss(":root { --wait-solid: #E5940C; }\n.state-dot--waiting, .state-dot--blocked { box-shadow: inset 0 0 0 1px var(--wait-solid); }");
      expect(found.map((f) => [f.rule, f.line])).toEqual([["amber-misuse", 2]]);
      expect(found[0].text).toMatch(/^\.state-dot--blocked \{/);
      expect(lintCss(":root { --wait-solid: #E5940C; }\n.state-dot--waiting, .state-dot--waiting::after { background: var(--wait-solid); }")).toEqual([]);
    });
    it("looping: the allowed part is exempt and the other part is still reported", () => {
      const found = lintCss(".skeleton, .cta-live { animation: shimmer 1.4s ease infinite; }");
      expect(found.map((f) => f.rule)).toEqual(["infinite-animation"]);
      expect(found[0].text).toMatch(/^\.cta-live \{/);
    });
    it("pill: the allowed part is exempt and the other part is still reported", () => {
      const found = lintCss(".avatar, .card:is(.a, .b) { border-radius: 999px; }");
      expect(found.map((f) => f.rule)).toEqual(["pill-radius"]);
      expect(found[0].text).toMatch(/^\.card:is\(\.a, \.b\) \{/);
    });
  });

  it("allows looping only on the four exact live selectors", () => {
    expect([...INFINITE_ALLOW].sort()).toEqual([".btn.is-loading::after", ".live-dot.is-live", ".skeleton", ".state-dot--working"]);
  });

  it("stays quiet on clean CSS, including the allowlisted look-alikes", () => {
    const css = [
      "/* text-transform: uppercase; transition: all 1s; ✓ border-radius: 999px; font-weight: 800 */",
      ":root { --radius-pill: 999px; --fw-h1: 600; --amber: #E5940C; --c: var(--amber); --danger: #D93A3F; }",
      ".card { padding: 16px; border-radius: 12px; font: 500 1rem/1.4 var(--body); transition: background-color 160ms var(--ease-out), transform 160ms var(--ease-out); }",
      ".title { font-weight: 600; letter-spacing: 0; text-transform: none; font-style: normal; }",
      ".h1 { font-weight: var(--fw-h1); }",
      ".btn.is-loading::after { animation: btn-spin 0.7s linear infinite; }",
      ".skeleton { background: linear-gradient(90deg, #EEEEEA 25%, #E6E6E1 50%, #EEEEEA 75%); animation: shimmer 1.4s ease infinite; }",
      ".state-dot--working { animation: state-pulse 1.8s ease-in-out infinite; }",
      ".live-dot.is-live { animation: pulse-live 2s infinite ease-in-out; }",
      ".avatar { border-radius: 999px; }",
      ".status-dot { border-radius: var(--radius-pill); }",
      "@keyframes btn-spin { to { transform: rotate(360deg); } }",
      '.footer::after { content: "© 2026 ™"; }',
      ".strip.clearance { border-left: 2px solid var(--amber); }",
      ".glyph-block { --c: var(--danger); box-shadow: inset 0 0 0 1px var(--c); }",
      ".mx-glyph-wait { background: radial-gradient(circle, var(--amber) 0 2px, transparent 2.4px); }",
      ".marquee { mask-image: linear-gradient(90deg, transparent, #E5940C 15%, #4f7df3 85%, transparent); }",
      ".display { font-size: clamp(2.4rem, 4vw, 4rem); letter-spacing: -0.04em; }",
      ".grid { padding: 4px 8px; margin: 2px -12px; width: 1px; font-size: 13px; line-height: 21px; top: 0.5px; }",
      '@import url("https://fonts.googleapis.com/css2?family=Geist:wght@400..600&family=Geist+Mono:wght@400;500&display=swap");',
    ].join("\n");
    expect(lintCss(css)).toEqual([]);
  });

  it("stays quiet on clean HTML", () => {
    const html = [
      "<!doctype html>",
      "<head><title>Fleet — OpenCadre</title></head>",
      "<!-- <h1>Old heading.</h1> <em>x</em> 🚀 Illustrated example — · → -->",
      "<h1>Agents claim the work</h1>",
      "<h2>Questions, answered</h2>",
      "<p>Plain sentences keep their period. <strong>Strong</strong> is fine.</p>",
      '<ul class="note-list"><li data-decision-note>One step, then the next</li></ul>',
      '<div style="font-weight: 500; border-radius: 8px; padding: 12px">Card</div>',
      "<script>const s = '<h2>Not a heading.</h2>';</script>",
      '<script type="application/ld+json">{"description": "Agents — together → 🚀 in this example"}</script>',
      "<style>.a { color: var(--ink); }</style>",
    ].join("\n");
    expect(lintHtml(html)).toEqual([]);
  });

  it("stays quiet on clean JS", () => {
    const js = [
      "// setInterval(poll) — a comment → not code ✓",
      "/* requestAnimationFrame(draw); 'Illustrated example' */",
      "const label = 'Connected';",
      "el.className = 'note-list card';",
      "const sel = '[data-decision-note]';",
      "setTimeout(done, 200);",
      "const url = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600';",
    ].join("\n");
    expect(lintJs(js)).toEqual([]);
  });
});
