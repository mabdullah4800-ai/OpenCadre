// The pure pieces of the CLI package's build identity (scripts/cli-build-info.mjs), tested without packing: the inputs
// digest, the import parse, the dirty-input rule and the missing-git fallback. The packed build.json itself, and its
// agreement with what an install writes, is tested against a real pack in tests/cli-manifest.test.ts.
import { describe, expect, it } from "vitest";
import { collectBuildInfo, historyAt, revisionHashes, dirtyInputs, renderings, helperImports, inputsDigest, installedHash, relativeImports, resolveImports, sha256, unresolvedImports } from "../scripts/cli-build-info.mjs";
import { HELPERS } from "../cli/lib/helpers.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpDir } from "./helpers/tmp.js";

const bytes = (s: string) => Buffer.from(s, "utf8");

describe("inputsDigest", () => {
  const files = [
    { path: "bin/opencadre.mjs", bytes: bytes("console.log(1)\n") },
    { path: "helpers/pure-ack.mjs", bytes: bytes("export const x = 1;\n") },
    { path: "package.json", bytes: bytes("{}\n") },
  ];

  it("changes when ONE packed byte changes, and only then", () => {
    const base = inputsDigest(files);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(inputsDigest(files.map((f) => ({ ...f })))).toBe(base);
    const oneByte = files.map((f, i) => (i === 1 ? { ...f, bytes: bytes("export const x = 2;\n") } : f));
    expect(inputsDigest(oneByte)).not.toBe(base);
  });

  it("covers the path too: the same bytes under another name are another package", () => {
    const renamed = files.map((f, i) => (i === 0 ? { ...f, path: "bin/other.mjs" } : f));
    expect(inputsDigest(renamed)).not.toBe(inputsDigest(files));
  });

  it("does not depend on the order files were listed in, and refuses a duplicate path", () => {
    expect(inputsDigest([...files].reverse())).toBe(inputsDigest(files));
    expect(() => inputsDigest([...files, files[0]])).toThrow(/duplicate path/);
  });

  it("is sha256sum's shape, so it can be re-derived by hand from an extracted package", () => {
    const expected = sha256([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${sha256(f.bytes)}  ${f.path}\n`).join(""));
    expect(inputsDigest(files)).toBe(expected);
  });
});

describe("imports, parsed rather than listed", () => {
  it("finds static, re-exported, side-effect and dynamic relative imports, and drops package imports", () => {
    const text = [
      'import { a } from "./config.mjs";',
      "import {",
      "  b,",
      "} from './multi.mjs';",
      'export { c } from "./reexport.mjs";',
      'import "./side-effect.mjs";',
      'const d = await import("./dynamic.mjs");',
      'import { readFileSync } from "node:fs";',
      'import x from "some-package";',
    ].join("\n");
    expect(relativeImports(text).sort()).toEqual(["./config.mjs", "./dynamic.mjs", "./multi.mjs", "./reexport.mjs", "./side-effect.mjs"]);
  });

  it("resolves against the helper's own folder inside bin/, so a subfolder helper's siblings keep their folder", () => {
    expect(resolveImports("opencode-plugin/index.js", 'import "./mail.js"; import("./clearance.js")')).toEqual(["opencode-plugin/clearance.js", "opencode-plugin/mail.js"]);
    expect(resolveImports("opencode-plugin/index.js", 'import "../opencadre-config.mjs"')).toEqual(["opencadre-config.mjs"]);
    // Out of the install altogether: returned as is, so pack-cli can refuse it.
    expect(resolveImports("opencadre-mcp.mjs", 'import "../../elsewhere.mjs"')).toEqual(["../../elsewhere.mjs"]);
  });

  it("names what an install could not load", () => {
    const imports = helperImports({ "a.mjs": 'import "./b.mjs"; import "./missing.mjs"', "b.mjs": "" });
    expect(imports).toEqual({ "a.mjs": ["b.mjs", "missing.mjs"], "b.mjs": [] });
    expect(unresolvedImports(imports)).toEqual(["a.mjs -> missing.mjs"]);
  });
});

describe("dirty inputs are decided by CONTENT against the commit's blob, in either line-ending rendering", () => {
  const inputs = [
    { repoPath: "cli/lib/a.mjs", bytes: bytes("same\n") },
    { repoPath: "cli/lib/b.mjs", bytes: bytes("edited\n") },
    { repoPath: "cli/lib/c.mjs", bytes: bytes("untracked\n") },
    // The autocrlf checkout of an LF blob, what this box's checkout AND its `git archive` produce (measured): not dirty.
    { repoPath: "scripts/d.mjs", bytes: bytes("one\r\ntwo\r\n") },
    // Half converted: no renderer produces this, so it is an edit.
    { repoPath: "scripts/e.mjs", bytes: bytes("one\r\ntwo\n") },
    // A blob that already holds CRLF is left alone by git's auto conversion, so its LF form is an edit too.
    { repoPath: "scripts/f.mjs", bytes: bytes("one\ntwo\n") },
  ];
  const head = new Map<string, Buffer | null>([
    ["cli/lib/a.mjs", bytes("same\n")],
    ["cli/lib/b.mjs", bytes("committed\n")],
    ["cli/lib/c.mjs", null],
    ["scripts/d.mjs", bytes("one\ntwo\n")],
    ["scripts/e.mjs", bytes("one\ntwo\n")],
    ["scripts/f.mjs", bytes("one\r\ntwo\r\n")],
  ]);

  it("lists modified, untracked and non-rendering inputs, and not an input equal to a rendering of its blob", () => {
    expect(dirtyInputs(inputs, head)).toEqual(["cli/lib/b.mjs", "cli/lib/c.mjs", "scripts/e.mjs", "scripts/f.mjs"]);
  });

  it("is empty when every input is exactly its blob's bytes", () => {
    const clean = inputs.map((i) => ({ ...i, bytes: head.get(i.repoPath) ?? bytes("") }));
    const withAll = new Map([...head].map(([k, v]) => [k, v ?? bytes("")]));
    expect(dirtyInputs(clean, withAll)).toEqual([]);
  });

  it("renderings: the blob, plus its CRLF form only when the blob holds no CR", () => {
    expect(renderings(bytes("a\nb\n")).map((b) => b.toString())).toEqual(["a\nb\n", "a\r\nb\r\n"]);
    expect(renderings(bytes("a\r\nb\n")).map((b) => b.toString())).toEqual(["a\r\nb\n"]);
    expect(renderings(bytes("no newline")).map((b) => b.toString())).toEqual(["no newline"]);
  });
});

describe("installedHash", () => {
  it("hashes the text an install writes: the sibling-import rewrite applied", () => {
    const source = 'import { x } from "../../scripts/opencadre-config.mjs";\n';
    expect(installedHash(bytes(source))).toBe(sha256(bytes('import { x } from "./opencadre-config.mjs";\n')));
    expect(installedHash(bytes(source))).not.toBe(sha256(bytes(source)));
  });
});

describe("collectBuildInfo without git", () => {
  it("degrades to commit null, no dirty list and empty histories instead of failing the build", () => {
    const helpers = { "a.mjs": "scripts/a.mjs", "b.mjs": "scripts/b.mjs" };
    const files = [
      { path: "helpers/a.mjs", repoPath: "scripts/a.mjs", bytes: bytes('import "./b.mjs";\n') },
      { path: "helpers/b.mjs", repoPath: "scripts/b.mjs", bytes: bytes("export {};\n") },
      { path: "package.json", repoPath: "cli/package.json", bytes: bytes("{}\n") },
    ];
    const build = collectBuildInfo({ root: process.cwd(), files, helpers, gitBin: "git-that-does-not-exist-q1g" });
    expect(build).toEqual({
      schema: 1,
      provenance: "none",
      commit: null,
      dirty: [],
      inputsDigest: inputsDigest(files),
      helpers: { "a.mjs": sha256(files[0].bytes), "b.mjs": sha256(files[1].bytes) },
      imports: { "a.mjs": ["b.mjs"], "b.mjs": [] },
      officialHistory: { "a.mjs": [], "b.mjs": [] },
    });
  });

  it("with a deploy provenance file: its commit and history, plus the packed text, provenance deploy-archive, dirty []", () => {
    const root = tmpDir("oc-build-info-prov-");
    const old = "0".repeat(64);
    writeFileSync(path.join(root, "cli-provenance.json"), JSON.stringify({ schema: 1, commit: "a".repeat(40), officialHistory: { "a.mjs": [old], "b.mjs": [] } }));
    const helpers = { "a.mjs": "scripts/a.mjs", "b.mjs": "scripts/b.mjs" };
    const files = [
      { path: "helpers/a.mjs", repoPath: "scripts/a.mjs", bytes: bytes("export const a = 1;\n") },
      { path: "helpers/b.mjs", repoPath: "scripts/b.mjs", bytes: bytes("export {};\n") },
    ];
    const build = collectBuildInfo({ root, files, helpers, gitBin: "git-that-does-not-exist-q1g" });
    expect(build.provenance).toBe("deploy-archive");
    expect(build.commit).toBe("a".repeat(40));
    expect(build.dirty).toEqual([]);
    // The packed text is never unknown to its own build, even when the file's history (a dirty deploy host) lacks it.
    expect(build.officialHistory).toEqual({ "a.mjs": [old, sha256(files[0].bytes)].sort(), "b.mjs": [sha256(files[1].bytes)] });
  });

  it("refuses a helper that is not among the packed inputs", () => {
    expect(() => collectBuildInfo({ root: process.cwd(), files: [], helpers: { "a.mjs": "scripts/a.mjs" }, gitBin: "git-that-does-not-exist-q1g" })).toThrow(/not among the packed inputs/);
  });
});

describe("the real helpers' imports", () => {
  it("the approval gate's parsed imports are its three siblings, and every helper import resolves to a helper", async () => {
    const { installedText } = await import("../cli/lib/helpers.mjs");
    const imports = helperImports(Object.fromEntries(Object.keys(HELPERS).map((n) => [n, installedText(n)])));
    expect(imports["opencadre-approval-gate.mjs"]).toEqual(["opencadre-config.mjs", "opencadre-hook-dialect.mjs", "opencadre-secrets.mjs"]);
    expect(imports["opencadre-approval-gate-loader.mjs"]).toEqual(["opencadre-approval-gate.mjs"]);
    expect(unresolvedImports(imports)).toEqual([]);
  });
});


describe("official helper history across merges", () => {
  it("retains merge-resolution bytes and both parent histories, excluding later commits", () => {
    const root = tmpDir("oc-history-merge-");
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q");
    mkdirSync(path.join(root, "scripts"));
    const helper = path.join(root, "scripts/a.mjs");
    const revisions = ["base\n", "left\n", "right\n", "resolved\n", "later\n"];
    const commit = (text: string, message: string) => {
      writeFileSync(helper, text);
      git("add", "--", "scripts/a.mjs");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    const base = commit(revisions[0], "base");
    git("checkout", "-q", "-b", "left");
    commit(revisions[1], "left");
    git("checkout", "-q", "-b", "right", base);
    commit(revisions[2], "right");
    const merging = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "rerere.enabled=false", "merge", "--no-ff", "--no-commit", "left"], { cwd: root, encoding: "utf8" });
    expect(merging.status, merging.stderr).toBe(1);
    const merged = commit(revisions[3], "resolved merge");
    commit(revisions[4], "later");
    const history = historyAt({ root, commit: merged, helpers: { "a.mjs": "scripts/a.mjs" } });
    expect(history).not.toBeNull();
    for (const revision of revisions.slice(0, 4)) {
      for (const hash of revisionHashes(Buffer.from(revision))) expect(history!["a.mjs"]).toContain(hash);
    }
    for (const hash of revisionHashes(Buffer.from(revisions[4]))) expect(history!["a.mjs"]).not.toContain(hash);
  }, 60_000);
});
