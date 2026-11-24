import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The agent state indicator is a THREE-file contract that nothing currently tests:
 *   app.js       decides which state an agent is in (agentState) and emits a class
 *   tokens.css   defines what each state class looks like
 *   app.css      loads tokens.css
 *
 * Each file is individually reasonable, and a mismatch between them fails SILENTLY:
 * a class app.js emits that tokens.css does not define renders as an unstyled dot,
 * and a state tokens.css styled that app.js never emits is dead CSS. Neither shows
 * up in any other test because nothing asserts the two vocabularies agree.
 *
 * Written by DeepSeek-D2V6 (reviewer) after verifying the contract by hand and
 * finding no test covered it. The five states are not a guess: they were confirmed
 * against the live GET /v1/agents payload (working | waiting | idle | online | offline).
 */

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const appDir = path.join(process.cwd(), "public", "app");
const readApp = (file: string) => readFileSync(path.join(appDir, file), "utf8");

/**
 * The state indicator lives in files owned by the Frontend Designer (tokens.css) and
 * the console owner (app.js/app.css). On a branch that predates that work they are
 * simply absent, so this suite SKIPS rather than fails - a failure here would mean
 * "these files are missing from this branch", which is not a defect in the contract
 * this test exists to check.
 */
const hasIndicator = (() => {
  try {
    return readApp("tokens.css").includes(".state-dot") && readApp("app.js").includes("state-dot");
  } catch {
    return false;
  }
})();
const describeIndicator = hasIndicator ? describe : describe.skip;

/**
 * The states the console renders, read from app.js's own whitelist rather than hardcoded.
 *
 * This started as a literal list of five. The hub then gained a sixth state (`blocked`),
 * and a hardcoded five turned a correct implementation into a failing test - the test was
 * stale, not the code. Deriving the list from the source of truth means the STATE MODEL
 * can grow without this contract test needing an edit, which is the point: this test is
 * about the app.js <-> tokens.css AGREEMENT, not about how many states exist.
 *
 * A companion assertion below still checks that the list is non-trivial, so deriving it
 * cannot silently degrade into an empty check.
 */
const whitelistOf = (js: string) =>
  [...(js.match(/const AGENT_STATES = \{([\s\S]*?)\};/) ?? [, ""])[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
const EXPECTED_STATES = whitelistOf(readApp("app.js"));

/**
 * True when tokens.css defines a rule for exactly this state class.
 *
 * A plain `css.includes('.state-dot--waiting')` is NOT sufficient: it also matches
 * `.state-dot--waitingX`, so renaming a class would still "pass" while the real state
 * lost its styling. That is a mutation this test must catch, so the match is anchored
 * to the full class name (CSS class chars are [A-Za-z0-9_-]).
 */
const definesState = (css: string, state: string) =>
  new RegExp(`\\.state-dot--${state}(?![\\w-])`).test(css);

describeIndicator("agent state indicator: the app.js <-> tokens.css contract", () => {
  it("serves tokens.css and wires it from app.css", async () => {
    const css = await (await fetch(`${baseUrl}/app/tokens.css`)).text();
    expect(css).toContain(".state-dot");
    // app.css must load it, or every state class below is inert.
    expect(readApp("app.css")).toMatch(/@import\s+url\(["']\.\/tokens\.css["']\)/);
  });

  it("defines a .state-dot--<state> rule in tokens.css for every state the console emits", async () => {
    const css = await (await fetch(`${baseUrl}/app/tokens.css`)).text();
    const missing = EXPECTED_STATES.filter((s) => !definesState(css, s));
    expect(missing, `tokens.css is missing a rule for: ${missing.join(", ")}`).toEqual([]);
  });

  it("emits no state class that tokens.css does not define (no silently unstyled dot)", async () => {
    const js = readApp("app.js");
    const css = readApp("tokens.css");
    // Every class app.js interpolates into state-dot--<x> must exist in the CSS.
    const emitted = [...js.matchAll(/state-dot--\$\{[^}]+\}|state-dot--([a-z-]+)/g)]
      .map((m) => m[1])
      .filter((v): v is string => Boolean(v));
    const emittedDynamic = js.includes("state-dot--${");
    // With a dynamic class the names are DATA, not literals - so assert the whitelist
    // that guards them instead, which is what actually constrains the vocabulary.
    if (emittedDynamic) {
      const whitelist = js.match(/const AGENT_STATES = \{([\s\S]*?)\};/);
      expect(whitelist, "app.js must gate dynamic state classes behind an explicit whitelist").not.toBeNull();
      const allowed = [...whitelist![1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
      const undefinedStates = allowed.filter((s) => !definesState(css, s));
      expect(undefinedStates, `app.js allows states with no CSS: ${undefinedStates.join(", ")}`).toEqual([]);
    }
    for (const name of emitted) {
      expect(definesState(css, name), `app.js emits .state-dot--${name} but tokens.css does not define it`).toBe(true);
    }
  });

  it("styles no state class the model does not declare (no dead CSS - the OTHER direction)", async () => {
    // The docblock above claims both directions; until this test existed only one was
    // asserted. Every other case here iterates WHITELIST -> CSS, so a `.state-dot--<x>`
    // rule in tokens.css with no matching whitelist entry was invisible to the whole file:
    // confirmed by injecting `.state-dot--ghost` into tokens.css, which passed 5 of 5.
    // Found by DeepSeek-KCHU reviewing PR #201 - a docblock asserting coverage the test did
    // not provide, which is the same defect class this suite exists to catch.
    const css = readApp("tokens.css");
    const declared = new Set(EXPECTED_STATES);
    const styled = [...css.matchAll(/\.state-dot--([\w-]+)/g)]
      .map((m) => m[1])
      // Modifiers that are not states (none today; this keeps the intent explicit).
      .filter((name) => !name.startsWith("__"));
    const orphans = [...new Set(styled)].filter((s) => !declared.has(s));
    expect(
      orphans,
      `tokens.css styles state class(es) the model never declares: ${orphans.join(", ")} - dead CSS, or a state that should be in the whitelist`,
    ).toEqual([]);
    // Guard the guard: if the extraction ever stops finding classes, the assertion above
    // would pass vacuously. Require it to see at least the states we know are styled.
    expect(styled.length, "the CSS scan found no state classes at all").toBeGreaterThanOrEqual(EXPECTED_STATES.length);
  });

  it("keeps the whitelist and the label map in step, so no state renders wordless", () => {
    const js = readApp("app.js");
    const whitelist = whitelistOf(js);
    const labels = [...js.match(/const STATE_LABEL = \{([\s\S]*?)\};/)![1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    // Guard the derivation: an empty or single-entry whitelist would make every
    // assertion below vacuously true, which is worse than a hardcoded list.
    expect(whitelist.length, "the state model must declare more than one state").toBeGreaterThan(1);
    expect(labels.length, "the label map must declare more than one state").toBeGreaterThan(1);
    // The state word is the channel that survives greyscale, reduced-motion AND a
    // screen reader, so a state without a label is a state with no accessible name.
    expect([...whitelist].sort()).toEqual([...labels].sort());
    expect([...whitelist].sort()).toEqual([...EXPECTED_STATES].sort());
  });

  it("an unrecognised state value cannot reach the DOM as an unstyled class", () => {
    const js = readApp("app.js");
    const css = readApp("tokens.css");
    // The whitelist is what stands between a hub value and a class name, so the
    // property to assert is the GUARD, not any particular fallback shape. The
    // fallback itself has changed once already (heartbeat boolean -> null; the
    // console then renders the binary chip), and pinning the old shape here is
    // what made this assertion stale. The invariant that survives both is: a
    // state not in the whitelist never becomes a `state-dot--<value>` class.
    const whitelist = whitelistOf(js);
    expect(whitelist.length).toBeGreaterThan(1);
    const unknown = "definitely-not-a-real-state";
    expect(whitelist).not.toContain(unknown);
    expect(definesState(css, unknown), "tokens.css must not style a state the model does not declare").toBe(false);
    // And the guard must actually consult the whitelist rather than interpolating raw input.
    expect(js).toMatch(/AGENT_STATES\[[^\]]+\]\s*\?/);
  });
});
/**
 * blocked and waiting share the ring-with-a-centre signature, and since the design-token palette (2026-09-29) they are
 * the same shade in greyscale (L 0.1387 vs 0.1382). Colour alone no longer separates them for a greyscale or
 * colour-blind reader, so the CENTRE's shape must: round for waiting, square for blocked. This reads the effective
 * border-radius of each centre across every rule that names it (the last declaration wins, as in the cascade).
 */
describeIndicator("agent state indicator: blocked and waiting differ by shape, not only colour", () => {
  const centreRadius = (css: string, selector: string) => {
    let radius: string | undefined;
    for (const [, sel, body] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!sel.split(",").some((s) => s.trim() === selector)) continue;
      for (const m of body.matchAll(/border-radius\s*:\s*([^;]+)/g)) radius = m[1].trim();
    }
    return radius;
  };

  it("waiting's centre is round and blocked's is not", () => {
    const css = readApp("tokens.css");
    const waiting = centreRadius(css, ".state-dot--waiting::after");
    const blocked = centreRadius(css, ".state-dot--blocked::after");
    expect(waiting).toBe("50%");
    expect(blocked).toBeDefined();
    expect(blocked).not.toBe(waiting);
    expect(blocked).not.toMatch(/^(50%|999px|100%)$/);
  });
});
