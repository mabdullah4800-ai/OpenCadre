// Dark mode Stage 3 (docs/design/CONSOLE_AUDIT.md, plan item 7): shadows and remaining one-offs.
// Same approach as Stage 1/2's tests: reads public/app/app.css directly, since happy-dom doesn't
// evaluate @media or compute real box-shadow rendering.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "public/app/app.css"), "utf8");
const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
const darkBlock = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));

function lightShadow(name: string): string {
  const m = rootBlock.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`${name} not found in :root`);
  return m[1].trim();
}
function darkShadow(name: string): string {
  const m = darkBlock.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`${name} not found in the dark-mode block`);
  return m[1].trim();
}

describe("dark mode Stage 3: shadow tokens", () => {
  const tokens = ["--shadow-subtle", "--shadow", "--shadow-lg"];

  it.each(tokens)("%s has its own dark-mode value, distinct from light", (name) => {
    expect(darkShadow(name)).not.toBe(lightShadow(name));
  });

  it("--shadow's embedded highlight is a subtle white, not the light-mode's stark rgba(255,255,255,0.8) inset", () => {
    // Same class of bug Stage 1 fixed on --specular itself: --shadow bundles its own separate
    // white inset highlight, which Stage 1 didn't touch since it's baked into a different token.
    const dark = darkShadow("--shadow");
    expect(dark).toMatch(/inset 0 1px 0 rgba\(255, 255, 255, 0\.\d+\)/);
    const m = dark.match(/rgba\(255, 255, 255, (0\.\d+)\)/);
    expect(Number(m![1])).toBeLessThan(0.1); // stark (0.8) would still glitch; must be much subtler
  });

  it.each(tokens)("%s's drop-shadow layer uses black, not a dark-navy tint that blends into a dark surface", (name) => {
    const dark = darkShadow(name);
    expect(dark).toMatch(/rgba\(0, 0, 0, 0\.[3-9]/); // opaque enough to actually read as a shadow
    expect(dark).not.toMatch(/rgba\(15, 23, 42/); // the light-mode navy tint
  });
});
