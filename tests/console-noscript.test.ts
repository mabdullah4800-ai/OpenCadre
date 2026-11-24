// The console without JavaScript: every console page starts hidden and app.js shows one, so with scripting off the page
// would be blank. A <noscript> block says so in plain words.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("the console without JavaScript", () => {
  const html = readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8");
  const block = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? "";
  const text = block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("explains in plain words that the console needs JavaScript", () => {
    expect(block, "a <noscript> block exists").not.toBe("");
    expect(text).toMatch(/needs JavaScript/i);
    expect(text).toMatch(/turned off/i);
  });

  it("links nowhere: nothing in it needs the hub or a hosted page", () => {
    expect([...block.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1])).toEqual([]);
  });

  it("never implies a plan can be bought or a checkout finished without JavaScript", () => {
    expect(text).not.toMatch(/checkout|buy|pay|subscribe|start your trial/i);
  });

  it("carries no id (the console's own ids stay unique) and no inline style or script (the console's CSP)", () => {
    expect(block).not.toMatch(/\sid=|\sstyle=|<script|\son[a-z]+=/i);
  });
});
