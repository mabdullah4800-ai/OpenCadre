#!/usr/bin/env node
// Packs cli/ (bin, lib, templates) plus the fleet helpers it installs into dist/cli/opencadre-cli.tgz,
// which the hub serves at /cli/<stamp>/opencadre-cli.tgz (and the bare /cli/opencadre-cli.tgz) for the console's connect
// command. Runs as part of npm run build.
//
// The package carries build.json at its root (scripts/cli-build-info.mjs says what is in it and why): the hub reads it back
// out of this same tarball for GET /cli/manifest.json, so the manifest and the package cannot describe different builds.
//
//   node scripts/pack-cli.mjs [--out dist/cli]
//
// The flow is packCli() below, exported so a test can hand it an npmPack that misbehaves on purpose (the final-pack
// check has to be seen refusing a real tarball, and npm cannot be made to pack differently on demand). Run as a script,
// it calls packCli with the real npm pack, exactly as before; importing it runs nothing.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HELPERS } from "../cli/lib/helpers.mjs";
import { BUILD_FILE, collectBuildInfo, packedInputs, samePackPlusBuild, unresolvedImports } from "./cli-build-info.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const TARGET = "opencadre-cli.tgz";

// npm's own entry point, run through node: no shell, so paths with spaces need no quoting on Windows.
// Under npm run it's npm_execpath; otherwise it ships beside node (Windows) or in ../lib (POSIX).
function npmCli() {
  const node = dirname(process.execPath);
  return [
    process.env.npm_execpath,
    join(node, "node_modules", "npm", "bin", "npm-cli.js"),
    join(node, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((p) => p && p.endsWith("npm-cli.js") && existsSync(p));
}

/** `npm pack <stage>` into `dest`: { file, bytes } of the tarball npm wrote. The only npmPack the build uses. */
export function realNpmPack(stage, dest) {
  const npm = npmCli();
  if (!npm) throw new Error("could not find npm-cli.js next to node");
  const packed = spawnSync(process.execPath, [npm, "pack", stage, "--pack-destination", dest, "--json"], { encoding: "utf8", windowsHide: true });
  if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`);
  const [{ filename }] = JSON.parse(packed.stdout);
  const file = join(dest, filename);
  return { file, bytes: readFileSync(file) };
}

/** Stages cli/ plus the helpers from `root`, packs it with its build.json, and writes `<out>/opencadre-cli.tgz`. Returns
 * { target, build }. Throws on any failure, and then leaves `out` as it found it: both packs land in scratch folders, and
 * the target is only ever replaced by one rename of a tarball that passed every check. */
export function packCli({ root = ROOT, out = join(ROOT, "dist", "cli"), npmPack = realNpmPack, log = console.log } = {}) {
  // Staged outside the repo so the source tree never carries a built helpers/ copy.
  const stage = mkdtempSync(join(tmpdir(), "opencadre-cli-"));
  const probeDir = mkdtempSync(join(tmpdir(), "opencadre-cli-probe-"));
  let finalDir = null;
  try {
    cpSync(join(root, "cli"), stage, { recursive: true });
    mkdirSync(join(stage, "helpers"));
    for (const [name, source] of Object.entries(HELPERS)) {
      mkdirSync(dirname(join(stage, "helpers", name)), { recursive: true });
      cpSync(join(root, source), join(stage, "helpers", name));
    }
    // cli/lib/device.mjs resolves the client table at runtime, preferring the helper staged beside the packed CLI
    // and falling back to the repo. In the tarball there is no repo, so the staged copy MUST exist: fail the build
    // here rather than let a packed CLI discover it at import time, after install, where nobody is watching.
    const tableHelper = "opencadre-clients.mjs";
    if (!existsSync(join(stage, "helpers", tableHelper))) {
      throw new Error(`the packed CLI needs helpers/${tableHelper} (cli/lib/device.mjs imports it). Add it to HELPERS in cli/lib/helpers.mjs.`);
    }
    // Build identity, over exactly what npm PACKS (review of #679: the staging folder is not the package; npm keeps only
    // cli/package.json's "files" allowlist minus its default exclusions, and may normalise package.json). So the stage is
    // packed once WITHOUT build.json into a probe tarball, and the identity is computed from that tarball's own entries.
    // Each packed file is mapped back to its staged source (what `dirty` compares with HEAD) and to its repo path.
    const probe = packedInputs(npmPack(stage, probeDir).bytes);
    const helperOf = new Map(Object.entries(HELPERS).map(([name, source]) => [`helpers/${name}`, source]));
    const files = probe.map((f) => {
      const source = join(stage, ...f.path.split("/"));
      // npm packs from the stage, so every entry has a staged source; one without is a pack we do not understand.
      if (!existsSync(source)) throw new Error(`npm packed ${f.path}, which is not in the staged package`);
      return { ...f, sourceBytes: readFileSync(source), repoPath: helperOf.get(f.path) ?? `cli/${f.path}` };
    });
    const build = collectBuildInfo({ root, files, helpers: HELPERS });
    // A helper that imports a sibling the package does not carry would install and then fail at import time, inside a
    // hook, where nobody is watching. Same reasoning as the table check above, generalised from the parsed imports.
    const unresolved = unresolvedImports(build.imports);
    if (unresolved.length) throw new Error(`packed helpers import files the package does not carry: ${unresolved.join(", ")}. Add them to HELPERS in cli/lib/helpers.mjs.`);
    const buildBytes = Buffer.from(`${JSON.stringify(build, null, 2)}\n`, "utf8");
    writeFileSync(join(stage, BUILD_FILE), buildBytes);
    log(`Build ${build.commit ?? "(no commit)"} [provenance ${build.provenance}]${build.dirty.length ? ` with ${build.dirty.length} input(s) not as committed` : ""}, inputs ${build.inputsDigest.slice(0, 12)}`);
    // The final pack goes to a scratch folder INSIDE `out` (same volume, so the rename below is one atomic replace), never
    // straight into `out`: a pack that fails the check must not leave a tarball, or an npm-named file, where the hub looks.
    mkdirSync(out, { recursive: true });
    finalDir = mkdtempSync(join(out, ".pack-"));
    const finalTgz = npmPack(stage, finalDir);
    // The package that ships must be the one described: the probe's files plus this build.json, byte for byte. Anything
    // else (npm packing differently the second time, a file changing under the stage) fails the build here.
    const mismatch = samePackPlusBuild(probe, packedInputs(finalTgz.bytes), buildBytes);
    if (mismatch) throw new Error(`the packed CLI is not the package build.json describes: ${mismatch}`);
    const target = join(out, TARGET);
    renameSync(finalTgz.file, target);
    log(`Packed ${target}`);
    return { target, build };
  } finally {
    for (const dir of [stage, probeDir, finalDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// Run as a script (npm run build): the real npm pack, into --out or dist/cli.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    packCli({ out: resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(ROOT, "dist", "cli")) });
  } catch (err) {
    console.error(`pack-cli: ${err.message}`);
    process.exitCode = 1;
  }
}
