// @vitest-environment happy-dom
// The cascade helper the console shell tests read CSS through (tests/helpers/css-cascade.ts). An instrument that can be
// wrong silently is worse than none, so its specificity and its refusal to guess are tested here.
import { describe, expect, it } from "vitest";
import { computed, CONSOLE_LAYOUT_STYLESHEETS, parseCss, parseRules, specificity } from "./helpers/css-cascade.js";

describe("specificity", () => {
  it.each([
    ["a.b#c", [1, 1, 1]],
    ["nav a[href]", [0, 1, 2]],
    [".a:hover", [0, 2, 0]],
    ["*", [0, 0, 0]],
    // :is(), :not() and :has() take the MOST specific selector of their list, not the sum.
    [":is(#a, .b)", [1, 0, 0]],
    [":not(.a, .b)", [0, 1, 0]],
    ["li:not(.a, .b, .c)", [0, 1, 1]],
    [":has(> img, #x)", [1, 0, 0]],
    // :where() adds nothing.
    [":where(#a, .b) .c", [0, 1, 0]],
    [".x:not(:is(#y, .z))", [1, 1, 0]],
  ])("%s", (selector, expected) => {
    expect(specificity(selector)).toEqual(expected);
  });
});

describe("matching", () => {
  it("throws on a selector it cannot parse, instead of treating it as a non-match", () => {
    const div = document.createElement("div");
    expect(() => computed(div, parseCss(".a[ { display: block }"), { width: 1000 })).toThrow(/css-cascade: cannot match/);
  });

  it("treats interaction states (:hover, :active, :open) as not holding, without throwing", () => {
    const div = document.createElement("div");
    div.className = "a";
    const rules = parseCss(".a { display: block } .a:hover { display: flex } .a:active { display: grid } .a:open { display: none }");
    expect(computed(div, rules, { width: 1000 }).display).toBe("block");
  });

  it("parses and can match every selector in the console's stylesheets", () => {
    const rules = parseRules(CONSOLE_LAYOUT_STYLESHEETS);
    expect(rules.length).toBeGreaterThan(500);
    for (const env of [{ width: 375 }, { width: 1100 }, { width: 1440, dark: true }]) {
      expect(() => computed(document.createElement("div"), rules, env)).not.toThrow();
      expect(() => computed(document.createElement("div"), rules, env, { focus: true })).not.toThrow();
    }
  });

  it("a more specific :not() loses to a later rule of equal weight once specificity is the max, not the sum", () => {
    const li = document.createElement("li");
    li.className = "x";
    // :not(.a, .b) is (0,1,0) + li (0,0,1) = (0,1,1), the same as li.x, so the later rule wins.
    const rules = parseCss("li:not(.a, .b) { display: flex } li.x { display: block }");
    expect(computed(li, rules, { width: 1000 }).display).toBe("block");
  });
});
