// Review of #679 (Codex-049a, CHANGES REQUIRED): build.json's inputsDigest must describe the files npm ACTUALLY packs.
//
// Reproduced by the reviewer (B:/ai-work/temp/049a-q1g-packed-inputs-probe.mjs): a copy of the tree with
// cli/review-excluded-scratch.txt, a file outside cli/package.json's "files" allowlist, produced a manifest inputsDigest
// that could not be re-derived from the tarball, because the digest hashed the staging folder and npm left the file out.
// pack-cli now packs a probe tarball first and hashes ITS entries (scripts/cli-build-info.mjs, THE INPUT SET).
//
//   (a) an excluded file (outside the allowlist, or one of npm's default exclusions) changes neither the digest nor the
//       tarball, and is not in it;
//   (b) control: a genuinely packed helper, edited, IS in the tarball, `dirty` names it, and the digest changes;
//   (c) every pack's inputsDigest re-derives from its own tarball's entries minus build.json, and its helper hashes from
//       the packed helper bytes.
//
// Each case packs a copy of the tree that is its own throwaway git repository (so `dirty` has a HEAD to compare with and
// nothing outside the copy is read), through the copy's own scripts/pack-cli.mjs, as `npm run build` does.
import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { tmpDir } from "./helpers/tmp.js";
import { BUILD_FILE, dirtyInputs, inputsDigest, installedHash, packedInputs, readTarGz, samePackPlusBuild, sha256 } from "../scripts/cli-build-info.mjs";
import { packCli, realNpmPack } from "../scripts/pack-cli.mjs";

const { tarEntry } = await import("../src/cli-package.js");
const ROOT = process.cwd();
const PACK_TIMEOUT = 600_000; // two npm packs per build, on a box other agents load

interface Packed { tgz: Buffer; build: Record<string, any>; files: Array<{ path: string; bytes: Buffer }> }

/** A copy of the build inputs as a fresh git repo with one commit, plus a function to pack it. */
function repoCopy() {
  const root = tmpDir("oc-pack-inputs-");
  for (const p of ["cli", "scripts", "examples/hooks", "examples/opencode-plugin", "package.json"]) cpSync(path.join(ROOT, p), path.join(root, p), { recursive: true });
  const g = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  g("init", "-q");
  g("add", "-A");
  g("commit", "-q", "-m", "fixture");
  const pack = (): Packed => {
    const out = tmpDir("oc-pack-inputs-out-");
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "pack-cli.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`pack-cli failed (${r.status}): ${r.stderr}`);
    const tgz = readFileSync(path.join(out, "opencadre-cli.tgz"));
    const all = packedInputs(tgz);
    const build = JSON.parse(all.find((f) => f.path === BUILD_FILE)!.bytes.toString("utf8"));
    return { tgz, build, files: all.filter((f) => f.path !== BUILD_FILE) };
  };
  return { root, pack };
}

/** (c): the digest and helper hashes a build.json states, re-derived from nothing but its own tarball. */
function expectRederivable(p: Packed) {
  expect(p.build.inputsDigest, "inputsDigest re-derived from the tarball minus build.json").toBe(inputsDigest(p.files));
  for (const [name, hash] of Object.entries(p.build.helpers)) {
    const entry = p.files.find((f) => f.path === `helpers/${name}`);
    expect(entry, `helpers/${name} is packed`).toBeDefined();
    expect(hash, name).toBe(installedHash(entry!.bytes));
  }
}

let fixture: ReturnType<typeof repoCopy>;
let clean: Packed;

beforeAll(() => {
  fixture = repoCopy();
  clean = fixture.pack();
}, PACK_TIMEOUT);

describe("the digest is over what npm packed", () => {
  it("(c) a clean pack re-derives from its own tarball, and names no input dirty", () => {
    expectRederivable(clean);
    expect(clean.build.provenance).toBe("git");
    expect(clean.build.dirty).toEqual([]);
    // Two tar readers (scripts/, used by pack-cli; src/, used by the hub) agree on every entry of a real npm tarball.
    for (const { path: p, bytes } of readTarGz(clean.tgz)) expect(tarEntry(clean.tgz, p)?.equals(bytes), p).toBe(true);
  });

  it("(a) files npm leaves out change neither the digest nor the tarball, and are not in it", () => {
    // The reviewer's file (outside the "files" allowlist), and npm's default exclusions INSIDE an allowlisted folder.
    const excluded = ["review-excluded-scratch.txt", "lib/.DS_Store", "lib/helpers.mjs.orig", "lib/npm-debug.log", "bin/.npmrc"];
    for (const rel of excluded) writeFileSync(path.join(fixture.root, "cli", ...rel.split("/")), `excluded ${rel}\n`);
    const withExtras = fixture.pack();
    const packedPaths = withExtras.files.map((f) => f.path);
    for (const rel of excluded) expect(packedPaths, rel).not.toContain(rel);
    expect(withExtras.build.inputsDigest).toBe(clean.build.inputsDigest);
    expect(withExtras.build.dirty).toEqual([]);
    expect(sha256(withExtras.tgz), "the tarball itself is byte-identical").toBe(sha256(clean.tgz));
    expectRederivable(withExtras);
  }, PACK_TIMEOUT);

  it("(b) control: an edited helper that IS packed is in the tarball, is dirty, and moves the digest", () => {
    const helper = path.join(fixture.root, "scripts", "pure-ack.mjs");
    appendFileSync(helper, "// a local edit\n");
    const edited = fixture.pack();
    expect(edited.files.find((f) => f.path === "helpers/pure-ack.mjs")!.bytes.equals(readFileSync(helper))).toBe(true);
    expect(edited.build.dirty).toEqual(["scripts/pure-ack.mjs"]);
    expect(edited.build.inputsDigest).not.toBe(clean.build.inputsDigest);
    expect(edited.build.helpers["pure-ack.mjs"]).not.toBe(clean.build.helpers["pure-ack.mjs"]);
    expectRederivable(edited);
  }, PACK_TIMEOUT);
});

// The final-pack check, seen refusing a REAL tarball. npm cannot be made to pack differently on demand, so packCli is
// handed an npmPack whose second call packs something other than what the first call described (the real npm pack,
// after a stray file is added to the stage, which is inside the "files" allowlist so npm does pack it). The build must
// throw with the named difference and leave `out` exactly as it found it.
describe("packCli refuses a final pack that is not the one build.json describes", () => {
  /** The real npm pack, except that before its second call it slips lib/stray.mjs into the stage. */
  const packThatDrifts = () => {
    let calls = 0;
    return (stage: string, dest: string) => {
      calls += 1;
      if (calls === 2) writeFileSync(path.join(stage, "lib", "stray.mjs"), "export const stray = true;\n");
      return realNpmPack(stage, dest);
    };
  };
  const quiet = () => {};

  it("throws naming the gained file, and leaves no tarball of any name in an empty out", () => {
    const out = tmpDir("oc-pack-drift-empty-");
    expect(() => packCli({ out, npmPack: packThatDrifts(), log: quiet })).toThrow(/the packed CLI is not the package build\.json describes: the final pack gained lib\/stray\.mjs/);
    expect(readdirSync(out)).toEqual([]);
  }, PACK_TIMEOUT);

  it("leaves an existing opencadre-cli.tgz byte-identical, and nothing beside it", () => {
    const out = tmpDir("oc-pack-drift-existing-");
    const before = Buffer.from("the previous build's tarball");
    writeFileSync(path.join(out, "opencadre-cli.tgz"), before);
    expect(() => packCli({ out, npmPack: packThatDrifts(), log: quiet })).toThrow(/final pack gained lib\/stray\.mjs/);
    expect(readdirSync(out)).toEqual(["opencadre-cli.tgz"]);
    expect(readFileSync(path.join(out, "opencadre-cli.tgz")).equals(before)).toBe(true);
  }, PACK_TIMEOUT);

  it("control: the same call with the real npm pack succeeds and writes only opencadre-cli.tgz", () => {
    const out = tmpDir("oc-pack-drift-control-");
    const { target, build } = packCli({ out, log: quiet });
    expect(readdirSync(out)).toEqual(["opencadre-cli.tgz"]);
    expect(build.inputsDigest).toBe(inputsDigest(packedInputs(readFileSync(target)).filter((f) => f.path !== BUILD_FILE)));
  }, PACK_TIMEOUT);
});

describe("the pieces pack-cli relies on", () => {
  const f = (p: string, s: string) => ({ path: p, bytes: Buffer.from(s) });
  it("samePackPlusBuild accepts only the probe plus the written build.json, byte for byte", () => {
    const probe = [f("package.json", "{}"), f("lib/a.mjs", "a")];
    const build = Buffer.from("{\"schema\":1}\n");
    expect(samePackPlusBuild(probe, [...probe, { path: BUILD_FILE, bytes: build }], build)).toBeNull();
    expect(samePackPlusBuild(probe, probe, build)).toMatch(/has no build\.json/);
    expect(samePackPlusBuild(probe, [...probe, { path: BUILD_FILE, bytes: Buffer.from("{}") }], build)).toMatch(/not the one written/);
    expect(samePackPlusBuild(probe, [probe[0], { path: BUILD_FILE, bytes: build }], build)).toMatch(/lost lib\/a\.mjs/);
    expect(samePackPlusBuild(probe, [probe[0], f("lib/a.mjs", "A"), { path: BUILD_FILE, bytes: build }], build)).toMatch(/lib\/a\.mjs differs/);
    expect(samePackPlusBuild(probe, [...probe, f("extra.txt", "x"), { path: BUILD_FILE, bytes: build }], build)).toMatch(/gained extra\.txt/);
    expect(samePackPlusBuild([...probe, { path: BUILD_FILE, bytes: build }], [...probe, { path: BUILD_FILE, bytes: build }], build)).toMatch(/first pack already holds/);
  });

  it("dirty compares the SOURCE bytes: a packed file npm rewrote is not dirty for the rewrite alone", () => {
    const committed = Buffer.from('{"name":"opencadre-cli","bin":{"opencadre":"./bin/opencadre.mjs"}}\n');
    const normalised = Buffer.from('{"name":"opencadre-cli","bin":{"opencadre":"bin/opencadre.mjs"}}\n');
    const head = new Map([["cli/package.json", committed]]);
    expect(dirtyInputs([{ repoPath: "cli/package.json", bytes: normalised, sourceBytes: committed }], head)).toEqual([]);
    expect(dirtyInputs([{ repoPath: "cli/package.json", bytes: committed, sourceBytes: normalised }], head)).toEqual(["cli/package.json"]);
  });

  it("packedInputs strips package/ and refuses anything outside it", () => {
    // A hand-rolled one-entry ustar archive outside package/.
    const h = Buffer.alloc(512);
    h.write("elsewhere.txt", 0);
    h.write("0000644\0", 100);
    h.write("00000000001\0", 124);
    h.write("0", 156);
    h.write("ustar\0", 257);
    const tgz = gzipSync(Buffer.concat([h, Buffer.from("x"), Buffer.alloc(511), Buffer.alloc(1024)]));
    expect(() => packedInputs(tgz)).toThrow(/outside package\//);
    expect(packedInputs(clean.tgz).every((e) => !e.path.startsWith("package/"))).toBe(true);
  });
});
