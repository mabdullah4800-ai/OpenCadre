// @vitest-environment happy-dom
// The screenshot harness redacts credentials before it photographs a page, because a screenshot is a
// FILE and this repo's rule is that no key (agt_/org_/dev_) goes into one -- not even a dead one.
//
// A redactor that quietly misses is worse than no redactor at all: it launders the key into an
// artifact that a reviewer, who can now see the step in the source, has a fresh reason to trust. So
// the load-bearing assertions here are not only "it removed the key" but "it can tell, and say, that
// it did not" -- which is why the third case below is a key it structurally cannot see, asserted to
// leave `remaining` at 1 rather than 0.
//
// The harness calls main() at import, so it cannot be imported. Its REDACT_SOURCE is extracted from
// the file and re-parsed as the template literal it is, so what runs here is the shipped bytes rather
// than a copy that can drift from them.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HARNESS = readFileSync(resolve(process.cwd(), "scripts/dev/console-shots.mjs"), "utf8");

// A key in the live shape: the first-run card prints one of these in full on the Overview panel.
//
// This is tests/no-hardcoded-secrets.test.ts's allowlisted synthetic placeholder rather than a fresh
// random string, and that is deliberate. A real key is `agt_` + 48 lowercase hex, which is exactly
// what that gate scans tracked text files for; a random-shaped literal here would make this file an
// offender and turn the repo's non-negotiable secret scan red on its own test fixture. Reusing the
// one synthetic value keeps the allowlist at a single auditable entry, and what this test needs is
// the SHAPE, not the value.
const KEY = "agt_0123456789abcdef0123456789abcdef0123456789abcdef";
// The command's device code, which is the SUBJECT of the shot and must survive untouched.
const CMD = "npx -y https://hub.opencadre.example/cli/opencadre-cli.tgz connect --device --code ocd_G2RN8ALQML";

function loadRedactor(): (doc: Document) => { cells: number; remaining: number } {
  const m = HARNESS.match(/const REDACT_SOURCE = `([\s\S]*?)`;/);
  if (!m) throw new Error("REDACT_SOURCE not found in scripts/dev/console-shots.mjs");
  // Re-parse the escapes exactly as the harness does at runtime: `\\b` in the file is `\b` in the page.
  const source = new Function(`return \`${m[1]}\`;`)() as string;
  // The source is already an IIFE expression, so `return` it as-is.
  const run = new Function("document", `return ${source}`) as (doc: Document) => string;
  return (doc) => JSON.parse(run(doc));
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("screenshot credential redaction", () => {
  it("removes a key printed in full, and leaves the command's ocd_ code exactly as it was", () => {
    document.body.innerHTML = `<div class="first-run-key"><pre id="key-value">${KEY}</pre></div>
      <pre id="cmd">${CMD}</pre>`;

    const result = loadRedactor()(document);

    expect($("key-value").textContent).toBe("(redacted)");
    expect(document.body.innerHTML).not.toContain("0123456789abcdef");
    // The device code is the evidence the screenshot exists to carry -- redacting it would destroy
    // the shot's subject to protect its scenery.
    expect($("cmd").textContent).toBe(CMD);
    expect(result.cells).toBe(1);
    // ...and the clean re-scan is what stops the caller throwing on its own output.
    expect(result.remaining).toBe(0);
  });

  it("removes a key held as a form value, which is not textContent", () => {
    document.body.innerHTML = `<input id="k" value="${KEY}">`;

    const result = loadRedactor()(document);

    expect(($("k") as HTMLInputElement).value).toBe("(redacted)");
    expect(result.cells).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it("reports a key it could not remove, instead of reporting success", () => {
    // The negative control, and the reason the guard is not decoration: the walker only rewrites
    // LEAF nodes, so a key split across two nodes matches nothing it looks at -- yet the page still
    // renders the whole key, because innerText concatenates what the leaves hold. cells === 0 here
    // is the walker doing its job correctly and the page still being unsafe, which is precisely the
    // case a `cells > 0` check alone would wave through.
    document.body.innerHTML = `<div id="w"><span>agt_</span><span>a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0</span></div>`;

    const result = loadRedactor()(document);

    expect(result.cells).toBe(0);
    expect(result.remaining).toBe(1); // > 0, so the harness throws rather than writes the PNG
    expect($("w").textContent).toContain("agt_");
  });

  it("leaves prose alone, including a bare prefix that is not a credential", () => {
    const prose = "Paste your agt_ key when prompted; the ocd_ code goes to the CLI.";
    document.body.innerHTML = `<p id="p">${prose}</p>`;

    const result = loadRedactor()(document);

    expect($("p").textContent).toBe(prose);
    expect(result.cells).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

describe("the capture path", () => {
  it("has exactly one capture site, and it redacts first and refuses rather than warns", () => {
    // A shape pin, not evidence about a page: it cannot fail on any DOM. What it can fail on is the
    // refactor that hurts -- a second `captureScreenshot` added for some new shot, which would
    // bypass the redactor silently because nothing else about the run would change.
    const captures = HARNESS.match(/captureScreenshot/g) ?? [];
    expect(captures).toHaveLength(1);

    const redactAt = HARNESS.indexOf("await this.redactCredentials()");
    expect(redactAt).toBeGreaterThan(-1);
    expect(redactAt).toBeLessThan(HARNESS.indexOf("captureScreenshot"));

    // The refusal is the load-bearing half of the pair above.
    expect(HARNESS).toMatch(/if \(result\.remaining > 0\) \{\s*throw new Error\(/);
  });
});
