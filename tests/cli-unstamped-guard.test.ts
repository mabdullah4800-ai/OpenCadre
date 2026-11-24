// Q1g guard: nothing the product prints names the CLI package at its BARE URL.
//
// WHY. npx caches a tarball by its URL spec, so a new build at the unchanged bare `<hub>/cli/opencadre-cli.tgz` is never
// fetched (measured, B:\ai-work\temp\2040-q1g\npx-cache-probe.sh; --prefer-online does not help). Every command a user or
// an agent copies must therefore carry the package's stamp: the path alias `<hub>/cli/<stamp>/opencadre-cli.tgz`, or the
// older `?v=<stamp>` query the bare route still honours. Before this guard the hub stamped its console commands while
// doctor, the no-code `connect` re-run and the site all printed the bare URL (PLAN-Q1G.md §2.A).
//
// TWO RULES, each a literal pattern over the source text (a source-regex test is spelling-bound, so the behavioural half
// lives in tests/cli-manifest.test.ts and tests/doctor-helpers.test.ts; this one stops the spelling coming back):
//   A. A printed command, `npx -y <anything>/cli/opencadre-cli.tgz` with no `?v=` after it. No exceptions, anywhere scanned.
//   B. A string literal that ENDS in the bare path (`.../cli/opencadre-cli.tgz` followed by a quote or backtick): the shape a
//      URL builder has. Each is allowed only with a `guard-allow(<id>)` marker on its line or the three above, and every id
//      must be one of EXCEPTIONS below, with its reason, used exactly once, so the list cannot rot in either direction.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CODE_DIRS = ["src", "cli", "public/site", "public/app"];
// Docs a user copies commands from. docs/design, docs/research and docs/ops are dated records of what was measured and
// are annotated rather than rewritten, so they are not scanned.
const DOC_FILES = () => [
  "README.md",
  ...readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
  ...readdirSync(path.join(ROOT, "docs", "qa")).filter((f) => f.endsWith(".md")).map((f) => `docs/qa/${f}`),
];
const TEXT = /\.(ts|mjs|js|html|json|md|txt)$/;

/** The only places a string may end in the bare path, and why none of them is a printed command. */
const EXCEPTIONS: Record<string, string> = {
  "bare-route": "src/rest.ts: the Express route's own path. It keeps serving commands printed before the alias existed.",
  "build-output-path": "src/cli-package.ts: the tarball's file path on the hub (dist/cli/...), not a URL.",
  unbuilt: "src/connect.ts cliTarballUrl: no package is built, so there is no stamp to print and nothing to download (the routes answer 503/404).",
  "no-stamp-from-hub": "cli/bin/opencadre.mjs cliUrlFor: the hub answered with no stamp (an older hub's /v1/devices/me, or one with no package), so no stamped URL exists.",
};

const PRINTED = /npx -y \S*\/cli\/opencadre-cli\.tgz(?!\?v=)/g;
const BARE_LITERAL = /\/cli\/opencadre-cli\.tgz(?=[`"'])/g;
const MARKER = /guard-allow\(([a-z0-9-]+)\)/;

function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : TEXT.test(name) ? [rel] : [];
  });
}

interface Finding { file: string; line: number; text: string; rule: "A" | "B"; allowedAs?: string }

/** Every rule-A and rule-B hit in `text`, with the marker id a rule-B hit is allowed under (if any). Exported shape is
 * exercised on synthetic text below, so the scanner is proven able to find what it guards against. */
function scan(file: string, text: string): Finding[] {
  const lines = text.split(/\r?\n/);
  const out: Finding[] = [];
  lines.forEach((line, i) => {
    for (const _ of line.matchAll(PRINTED)) out.push({ file, line: i + 1, text: line.trim(), rule: "A" });
    for (const _ of line.matchAll(BARE_LITERAL)) {
      const marker = lines.slice(Math.max(0, i - 3), i + 1).map((l) => l.match(MARKER)?.[1]).filter(Boolean).at(-1);
      out.push({ file, line: i + 1, text: line.trim(), rule: "B", allowedAs: marker });
    }
  });
  return out;
}

describe("the scanner itself", () => {
  it("finds the bare commands this change removed, and passes their stamped forms", () => {
    // The exact shapes that shipped before Q1g: doctor's upgrade advice, the site's snippet and cliUrlFor's fallback.
    const before = [
      "const latest = `npx -y ${hub}/cli/opencadre-cli.tgz connect --upgrade`;",
      '<pre class="snippet"><span class="dim">$</span> npx -y https://hub.opencadre.example/cli/opencadre-cli.tgz \\',
      "  return `${hub}/cli/opencadre-cli.tgz${stamp}`;",
      "  return `${hub}/cli/opencadre-cli.tgz`;",
    ].join("\n");
    const found = scan("synthetic", before);
    expect(found.filter((f) => f.rule === "A").map((f) => f.line)).toEqual([1, 2]);
    // The `${stamp}` template is not caught by rule B (it does not END in the bare path), which is why cliUrlFor now builds
    // the stamped shapes explicitly and its only bare return carries a marker.
    expect(found.filter((f) => f.rule === "B").map((f) => [f.line, f.allowedAs])).toEqual([[4, undefined]]);

    const after = [
      "const cmd = `npx -y ${hub}/cli/${stamp}/opencadre-cli.tgz connect --upgrade`;",
      "npx -y https://hub.opencadre.example/cli/opencadre-cli.tgz?v=0123456789ab connect",
      "// guard-allow(unbuilt): reason",
      "  return `${hub}/cli/opencadre-cli.tgz`;",
    ].join("\n");
    const ok = scan("synthetic", after);
    expect(ok.filter((f) => f.rule === "A")).toEqual([]);
    expect(ok.filter((f) => f.rule === "B").map((f) => f.allowedAs)).toEqual(["unbuilt"]);
  });
});

describe("no printed CLI command without a stamp", () => {
  const code = CODE_DIRS.flatMap(walk);
  const files = [...code, ...DOC_FILES()];
  // Rule B is about code that BUILDS a URL; prose in the docs may name the bare path to warn against it, so the docs are held
  // to rule A (no bare command) only.
  const findings = files
    .flatMap((file) => scan(file, readFileSync(path.join(ROOT, file), "utf8")))
    .filter((f) => f.rule === "A" || code.includes(f.file));

  it("scans the directories it names (a guard over zero files is green by construction)", () => {
    for (const must of ["cli/lib/doctor.mjs", "cli/bin/opencadre.mjs", "src/connect.ts", "src/rest.ts", "public/site/index.html", "docs/quickstart.md"]) {
      expect(files).toContain(must);
    }
  });

  it("rule A: no `npx -y …/cli/opencadre-cli.tgz` without a stamp in src/, cli/, public/site/, public/app/ or the user docs", () => {
    expect(findings.filter((f) => f.rule === "A").map((f) => `${f.file}:${f.line}: ${f.text}`)).toEqual([]);
  });

  it("rule B: a string ending in the bare path appears only under a listed exception, and every exception is used once", () => {
    const b = findings.filter((f) => f.rule === "B");
    expect(b.filter((f) => !f.allowedAs || !(f.allowedAs in EXCEPTIONS)).map((f) => `${f.file}:${f.line}: ${f.text}`)).toEqual([]);
    expect(b.map((f) => f.allowedAs).sort()).toEqual(Object.keys(EXCEPTIONS).sort());
  });
});
