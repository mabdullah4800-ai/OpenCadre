// Every child_process call in the product starts its child with `windowsHide: true`.
//
// On Windows, a process with no console of its own (an agent app's detached child, a detached wake watcher, the MCP
// proxy under a GUI client) that starts a console child WITHOUT windowsHide can make the default terminal open a window
// and hide it again, leaving a stale Alt-Tab entry (observed natively; receipt in B:\ai-work\temp\9d1f-ghost-windows\).
// Any product file can end up under such a parent, so the rule is every call, not a list of the ones known to run
// unattended.
//
// This file is the static half: tests/helpers/spawn-hide-scan.ts reads every product source file and accepts a
// child_process call only in a form it can prove hidden; everything else is a finding. Its rules and limits are written
// at the top of that file. tests/product-spawn-windows-hide.test.ts records the options the main unattended paths pass
// at runtime. Neither observes Windows itself.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { productFiles, scanProduct, scanSource } from "./helpers/spawn-hide-scan.js";
import { NEGATIVES, POSITIVES, REVIEW_1E684AEC, REVIEW_EAE06A92, REVIEW_F97811E0 } from "./helpers/spawn-hide-fixtures.js";

const ROOT = process.cwd();

/** Calls that are meant to open a visible window, keyed "file:line", with the reason. There are none: nothing the product
 * starts needs a console window of its own. An entry here must still match a finding, or the test fails. */
const VISIBLE_ON_PURPOSE = new Map<string, string>();

const findings = (src: string) => scanSource(src, "fixture.mjs").findings.map((f) => f.message);
const BACKSLASH = String.fromCharCode(92);

describe("the escaped fixtures really contain their escapes (a decoded fixture would test nothing)", () => {
  const escaped = [...REVIEW_1E684AEC, ...REVIEW_EAE06A92, ...NEGATIVES, ...POSITIVES.map(([n, s]): [string, string] => [n, s])]
    .filter(([name]) => /escaped/.test(name));
  it("has the escaped fixtures", () => {
    expect(escaped.length).toBeGreaterThanOrEqual(8);
  });
  for (const [name, src] of escaped) {
    it(name, () => {
      expect(src.includes(BACKSLASH), src).toBe(true);
      expect(src.includes("~"), src).toBe(false);
    });
  }
});

describe("the scan fails closed on every false negative the reviews found", () => {
  for (const [name, src] of [...REVIEW_1E684AEC, ...REVIEW_EAE06A92, ...REVIEW_F97811E0]) {
    it(name, () => {
      expect(findings(src).length, src).toBeGreaterThan(0);
    });
  }
});

describe("the scan can say no (each shape of a missing or unprovable windowsHide is a finding)", () => {
  for (const [name, src] of NEGATIVES) {
    it(name, () => {
      expect(findings(src).length, src).toBeGreaterThan(0);
    });
  }
});

describe("the forms the scan accepts as hidden (positive controls: each counts its calls and passes)", () => {
  for (const [name, src, n] of POSITIVES) {
    it(name, () => {
      const r = scanSource(src, "fixture.mjs");
      expect(r.findings, src).toEqual([]);
      expect(r.calls.length, src).toBe(n);
      expect(r.calls.every((c) => c.windowsHide && c.problem === null)).toBe(true);
    });
  }

  it("records detached", () => {
    expect(scanSource(`import { spawn } from "node:child_process";\nspawn("x", [], { windowsHide: true, detached: true });`, "f.mjs").calls)
      .toMatchObject([{ fn: "spawn", windowsHide: true, detached: true, problem: null }]);
  });
});

describe("every product child_process call hides its console", () => {
  const scan = scanProduct(ROOT);

  it("scans every helper the CLI installs", async () => {
    const { HELPERS } = await import(pathToFileURL(path.join(ROOT, "cli", "lib", "helpers.mjs")).href) as { HELPERS: Record<string, string> };
    const scanned = new Set(productFiles(ROOT));
    expect(Object.values(HELPERS).filter((src) => !scanned.has(src))).toEqual([]);
    expect(scanned.has("cli/bin/opencadre.mjs")).toBe(true);
  });

  it("finds the call sites (an empty scan is not a pass)", () => {
    expect(scan.calls.length).toBeGreaterThanOrEqual(30);
  });

  it("has no call without windowsHide: true, and nothing it cannot prove", () => {
    const open = scan.findings.filter((f) => !VISIBLE_ON_PURPOSE.has(`${f.file}:${f.line}`));
    expect(open.map((f) => `${f.file}:${f.line} ${f.message}`)).toEqual([]);
  });

  it("every allowlist entry still names a finding", () => {
    const sites = new Set(scan.findings.map((f) => `${f.file}:${f.line}`));
    expect([...VISIBLE_ON_PURPOSE.keys()].filter((k) => !sites.has(k))).toEqual([]);
  });

  it("turning off any one product windowsHide is caught, for every call it covers (mutation)", () => {
    let killed = 0;
    for (const file of new Set(scan.calls.map((c) => c.file))) {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      const base = scanSource(src, file).findings.length;
      for (const m of src.matchAll(/windowsHide:\s*true/g)) {
        const mutated = src.slice(0, m.index) + "windowsHide: false" + src.slice(m.index! + m[0].length);
        killed += Math.max(0, scanSource(mutated, file).findings.length - base);
      }
    }
    expect(killed).toBe(scan.calls.filter((c) => c.windowsHide).length);
    expect(killed).toBe(scan.calls.length);
  });
});
