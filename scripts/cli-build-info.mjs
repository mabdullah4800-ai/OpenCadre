// The build identity scripts/pack-cli.mjs writes into the CLI package as build.json, the pure pieces it is made of, and
// the deploy-time provenance file that carries git history into a build that has no .git.
//
// WHY IT EXISTS (Q1g, docs: B:\ai-work\temp\2040-q1g\PLAN-Q1G.md §2.A, ruling 049a §1). npx caches a tarball by its URL,
// so a machine can keep running an old CLI after a deploy, and nothing on that machine could say which build it holds.
// The hub now serves this file, from inside the one tarball it serves, as GET /cli/manifest.json (src/cli-package.ts),
// so the package and the description of the package are the same bytes by construction.
//
// WHAT IT DESCRIBES IS THE PACKED TREE, NOT HEAD (ruling §1: "rather than imply that git HEAD alone proves its
// contents"). `commit` is where the tree was packed from; `dirty` names every packed input whose bytes that commit does
// NOT account for; `inputsDigest` is over the exact packed bytes. So a build from a dirty tree says so, and two builds
// with the same commit but different bytes have different digests.
//
//   {
//     schema: 1,
//     provenance: "git" | "deploy-archive" | "none",   where commit and officialHistory came from (below)
//     commit: "<full sha>" | null,
//     dirty: ["<repo path>", ...],              packed inputs whose bytes are no rendering of the commit's blob
//     inputsDigest: "<sha256 hex>",             over sorted (packed path, sha256 of bytes) of every packed input
//     helpers: { "<name>": "<sha256 hex>" },    of the INSTALLED text (installTransform), what installHelpers writes
//     imports: { "<name>": ["<name>", ...] },   relative imports, static and dynamic, resolved as installed siblings
//     officialHistory: { "<name>": ["<sha256 hex>", ...] }   installed-text hashes of every committed revision
//   }
//
// THREE PROVENANCES.
//   "git"            a checkout: commit is HEAD, histories come from `git log HEAD`, dirty is measured against HEAD.
//   "deploy-archive" no .git, but <root>/cli-provenance.json (written by scripts/deploy-vps.sh with
//                    `node scripts/cli-build-info.mjs provenance <ref>` on the deploying host, which has .git, and added
//                    to the `git archive` it ships) supplies commit and histories. dirty is [] BY CONSTRUCTION: a
//                    `git archive` of a ref is that commit's bytes. A provenance file that does not parse, or does not
//                    cover every packed helper, FAILS THE BUILD: silently degrading to empty histories would make every
//                    official old helper "unknown provenance" in production with nothing saying why.
//   "none"           neither: commit null, dirty [] because nothing could be compared (NOT because the tree is clean),
//                    empty histories. A reader must treat it as "provenance unknown".
//
// LINE ENDINGS: TWO RENDERINGS OF EVERY REVISION. A committed revision reaches an install through whatever renders it:
// `git archive` or a checkout on the building host. Measured 2026-09-30 on this Windows box (core.autocrlf=true, from
// C:/Program Files/Git/etc/gitconfig): `git archive HEAD scripts/pure-ack.mjs` hashes d58e36f1… = the CRLF working copy,
// while the blob (`git show HEAD:…`) hashes 5489069e…. A deploy from Linux ships the LF blob; a deploy from this box ships
// CRLF. So each revision contributes the installed-text hash of its blob AND of the blob's autocrlf rendering (LF -> CRLF,
// applied only when the blob holds no CR at all, as git's auto conversion does). Both are that revision's content; the
// line-ending choice belongs to the host that rendered it, not to whoever edited the file. `dirty` applies the same rule.
// (`git cat-file --batch --filters` would render per host config, but this git, 2.54.0.windows.1, fails it with "missing
// path" for <rev>:<path> input, and one spawn per revision would cost hundreds of spawns per build.)
//
// THE INPUT SET IS WHAT NPM PACKED, READ BACK FROM A TARBALL (review of #679, Codex-049a). The first version hashed every
// file in the staging folder, but npm packs only cli/package.json's "files" allowlist minus its default exclusions: a
// stray cli/review-excluded-scratch.txt entered inputsDigest and never entered the package, so the digest could not be
// re-derived from the package it describes. pack-cli now packs the stage WITHOUT build.json, reads that tarball's
// entries (readTarGz below), and takes inputsDigest and the helper hashes from those exact bytes, so npm's selection and
// any package.json normalisation are in by construction. It then writes build.json, packs again, and refuses the build
// unless the second tarball's entries are the first's plus package/build.json, byte for byte (samePackPlusBuild).
// `dirty` still compares each packed file's SOURCE bytes (the staged copy) with HEAD, so a package.json npm rewrote is
// not "dirty" for the rewrite alone.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HELPERS, installTransform } from "../cli/lib/helpers.mjs";

export const BUILD_SCHEMA = 1;
export const BUILD_FILE = "build.json";
export const PROVENANCE_FILE = "cli-provenance.json";
export const PROVENANCE_SCHEMA = 1;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every regular file in a gzipped tar, in archive order, as { path, bytes }. Pure JS over node:zlib: the same format
 * src/cli-package.ts tarEntry reads (a TypeScript copy, because the hub's image does not ship scripts/; tests hold the two
 * to the same answers). ustar prefix joined as `prefix/name`; a pax "x" path or a GNU "L" long name overrides the next
 * entry's name; global pax "g", directories and links are skipped. A truncated archive throws. */
export function readTarGz(tgz) {
  const tar = gunzipSync(tgz, { maxOutputLength: 256 * 1024 * 1024 });
  const text = (h, from, to) => {
    const field = h.subarray(from, to);
    const nul = field.indexOf(0);
    return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8");
  };
  const files = [];
  let override = null;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const sizeField = text(header, 124, 136).trim();
    const size = sizeField === "" ? 0 : parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar: bad size field at offset ${off}`);
    const body = off + 512;
    if (body + size > tar.length) throw new Error(`tar: entry at offset ${off} runs past the end of the archive`);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = text(header, 257, 263).startsWith("ustar") ? text(header, 345, 500) : "";
    const name = prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100);
    const data = tar.subarray(body, body + size);
    if (type === "x") {
      const path = data.toString("utf8").match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      override = path ? path[1] : override;
    } else if (type === "L") {
      override = text(data, 0, data.length);
    } else if (type !== "g") {
      const effective = override ?? name;
      override = null;
      if (type === "0" || type === "7") files.push({ path: effective, bytes: Buffer.from(data) });
    }
    off = body + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** An npm tarball's files as package-relative inputs: `package/` stripped. Throws on an entry outside package/ or a
 * duplicate path, neither of which npm writes, rather than hash an ambiguous set. */
export function packedInputs(tgz) {
  const seen = new Set();
  return readTarGz(tgz).map(({ path, bytes }) => {
    if (!path.startsWith("package/")) throw new Error(`tar: ${path} is outside package/`);
    const rel = path.slice("package/".length);
    if (seen.has(rel)) throw new Error(`tar: ${rel} appears twice`);
    seen.add(rel);
    return { path: rel, bytes };
  });
}

/** Null when `final`'s inputs are exactly `probe`'s plus build.json holding `buildBytes`, byte for byte; otherwise one
 * line naming the first difference. */
export function samePackPlusBuild(probe, final, buildBytes) {
  const want = new Map(probe.map((f) => [f.path, f.bytes]));
  if (want.has(BUILD_FILE)) return `the first pack already holds ${BUILD_FILE}`;
  const got = new Map(final.map((f) => [f.path, f.bytes]));
  const build = got.get(BUILD_FILE);
  if (!build) return `the final pack has no ${BUILD_FILE}`;
  if (!Buffer.from(build).equals(Buffer.from(buildBytes))) return `the final pack's ${BUILD_FILE} is not the one written`;
  got.delete(BUILD_FILE);
  for (const [path, bytes] of want) {
    if (!got.has(path)) return `the final pack lost ${path}`;
    if (!Buffer.from(got.get(path)).equals(Buffer.from(bytes))) return `the final pack's ${path} differs from the first pack's`;
  }
  for (const path of got.keys()) if (!want.has(path)) return `the final pack gained ${path}`;
  return null;
}

/** sha256 over the sorted list of (packed-relative path, sha256 of its bytes): one line `<hash>  <path>\n` per file,
 * sorted by path (sha256sum's shape, so it can be re-derived by hand from an extracted package). Paths are the
 * package-relative POSIX form; a duplicate path is a caller bug and throws rather than silently hashing twice. */
export function inputsDigest(files) {
  const seen = new Set();
  const lines = files.map(({ path, bytes }) => {
    if (seen.has(path)) throw new Error(`inputsDigest: duplicate path ${path}`);
    seen.add(path);
    return [path, `${sha256(bytes)}  ${path}\n`];
  });
  lines.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(lines.map(([, line]) => line).join(""));
}

// The import parser lives in cli/lib/imports.mjs (the packed CLI carries cli/lib, not scripts/, and the installer must
// parse exactly as this packer did); re-exported here under the names this file always had.
export { helperImports, relativeImports, resolveImports, unresolvedImports } from "../cli/lib/imports.mjs";
import { helperImports } from "../cli/lib/imports.mjs";

/** The byte renderings a committed blob can reach an install as: the blob itself, and, when the blob holds no CR at all,
 * its autocrlf checkout (every LF -> CRLF). See LINE ENDINGS above. */
export function renderings(blob) {
  const bytes = Buffer.from(blob);
  if (bytes.includes(0x0d) || !bytes.includes(0x0a)) return [bytes];
  return [bytes, Buffer.from(bytes.toString("latin1").replace(/\n/g, "\r\n"), "latin1")];
}

/** Packed inputs whose SOURCE bytes are no rendering of the commit's blob. `inputs` is [{ repoPath, bytes, sourceBytes? }]:
 * `sourceBytes` is the file as it was staged from the repo, and it is what is compared when present, because npm may
 * rewrite what it packs (package.json) and that rewrite is npm's, not an edit. `headBlobs` maps a repo path to the blob's
 * bytes, or null/absent when the commit has no such file. Pure, so a test injects both. */
export function dirtyInputs(inputs, headBlobs) {
  return inputs
    .filter(({ repoPath, bytes, sourceBytes }) => {
      const blob = headBlobs.get(repoPath);
      const source = Buffer.from(sourceBytes ?? bytes);
      return !blob || !renderings(blob).some((r) => r.equals(source));
    })
    .map(({ repoPath }) => repoPath)
    .sort();
}

/** The installed-text sha256 of some bytes. Decoded as UTF-8 and re-encoded exactly as installHelpers does
 * (readFileSync "utf8" -> writeFileSync of the string), so the two hashes agree byte for byte. */
export const installedHash = (bytes, transform = installTransform) => sha256(Buffer.from(transform(Buffer.from(bytes).toString("utf8")), "utf8"));

/** Every installed-text hash one committed revision can produce: one per rendering. */
export const revisionHashes = (blob, transform = installTransform) => [...new Set(renderings(blob).map((r) => installedHash(r, transform)))];

// ---- git, impure. Every call degrades to null on any failure: a missing git, not a repo, a shallow boundary. ----

function git(gitBin, root, args, input) {
  const r = spawnSync(gitBin, [...args], { cwd: root, input, encoding: "buffer", maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  return r.error || r.status !== 0 ? null : r.stdout;
}

/** `git cat-file --batch` over `<rev>:<path>` specs, ONE process for all of them (hundreds of revisions would otherwise
 * be hundreds of spawns on every build). Map spec -> bytes, or null for a spec git reports missing. Null when git fails. */
export function catFileBatch(gitBin, root, specs) {
  if (specs.length === 0) return new Map();
  const out = git(gitBin, root, ["cat-file", "--batch"], Buffer.from(specs.map((s) => `${s}\n`).join(""), "utf8"));
  if (out === null) return null;
  const result = new Map();
  let off = 0;
  for (const spec of specs) {
    const eol = out.indexOf(0x0a, off);
    if (eol < 0) return null;
    const header = out.subarray(off, eol).toString("utf8");
    off = eol + 1;
    const m = header.match(/^[0-9a-f]+ (\w+) (\d+)$/);
    if (!m) {
      // "<spec> missing" (or "ambiguous"): no object at that revision, which is an answer, not a failure.
      result.set(spec, null);
      continue;
    }
    const size = Number(m[2]);
    result.set(spec, m[1] === "blob" ? out.subarray(off, off + size) : null);
    off += size + 1; // the content, then git's trailing newline
  }
  return result;
}

/** Commits (newest first) reachable from `ref` that touched each path, from ONE `git log`. Map path -> [sha]. */
function commitsTouching(gitBin, root, ref, paths) {
  // Include resolution-only merge blobs and reachable side-branch revisions. Default merge logs
  // omit changed path names, so a genuinely committed helper was being classified as unknown.
  const out = git(gitBin, root, ["log", "--full-history", "--diff-merges=separate", "--format=%x00%H", "--name-only", "--no-renames", ref, "--", ...paths]);
  if (out === null) return null;
  const byPath = new Map(paths.map((p) => [p, []]));
  for (const block of out.toString("utf8").split("\0").slice(1)) {
    const [sha, ...names] = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const n of names) byPath.get(n)?.push(sha);
  }
  return byPath;
}

/** The full commit sha `ref` names, or null. */
export function resolveCommit(gitBin, root, ref) {
  const out = git(gitBin, root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return out === null ? null : out.toString("utf8").trim() || null;
}

/** { name: sorted [hash] } over every revision of each helper's source reachable from `commit`: the committed-bytes rule
 * (both renderings, through `transform`). Null when git fails. A shallow clone yields fewer revisions. */
export function historyAt({ gitBin = "git", root, commit, helpers, transform = installTransform }) {
  const sources = [...new Set(Object.values(helpers))];
  const touching = commitsTouching(gitBin, root, commit, sources);
  if (touching === null) return null;
  const blobs = catFileBatch(gitBin, root, sources.flatMap((p) => touching.get(p).map((sha) => `${sha}:${p}`)));
  if (blobs === null) return null;
  return Object.fromEntries(Object.keys(helpers).sort().map((name) => {
    const source = helpers[name];
    const hashes = new Set();
    for (const sha of touching.get(source)) {
      const blob = blobs.get(`${sha}:${source}`);
      if (blob) for (const h of revisionHashes(blob, transform)) hashes.add(h);
    }
    return [name, [...hashes].sort()];
  }));
}

const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Reads and checks a deploy provenance file. Throws, naming the file and the fault, on anything but a well-formed file
 * that covers every name in `helperNames`: a build must never silently lose its history. */
export function readProvenance(file, helperNames) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Regenerate it with \`node scripts/cli-build-info.mjs provenance <ref>\`, or delete it to build with provenance "none".`);
  }
  const fault = (why) => new Error(`${file} is malformed: ${why}. Regenerate it with \`node scripts/cli-build-info.mjs provenance <ref>\`.`);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fault("not an object");
  if (parsed.schema !== PROVENANCE_SCHEMA) throw fault(`schema is ${JSON.stringify(parsed.schema)}, expected ${PROVENANCE_SCHEMA}`);
  if (typeof parsed.commit !== "string" || !COMMIT.test(parsed.commit)) throw fault("commit is not a full commit sha");
  const history = parsed.officialHistory;
  if (!history || typeof history !== "object" || Array.isArray(history)) throw fault("officialHistory is not an object");
  for (const [name, hashes] of Object.entries(history)) {
    if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === "string" && HEX64.test(h))) throw fault(`officialHistory["${name}"] is not a list of sha256 hex`);
  }
  const missing = helperNames.filter((n) => !(n in history));
  if (missing.length) throw fault(`it has no history for packed helper(s) ${missing.join(", ")}, so it does not describe this tree`);
  return { commit: parsed.commit, officialHistory: history };
}

/** The whole build identity for a staged package.
 *
 * `root` is the repo (or the extracted deploy archive), `files` is [{ path, repoPath, bytes, sourceBytes }] for every
 * file npm PACKED (pack-cli reads them back from a probe tarball: path = package-relative POSIX, bytes = the packed bytes,
 * sourceBytes = the staged copy, repoPath = where it came from in the repo), and `helpers` is { name: repoPath }
 * (cli/lib/helpers.mjs HELPERS). inputsDigest and the helper hashes are over `bytes`; `dirty` compares `sourceBytes`.
 * `gitBin` exists so a test can prove the no-git paths. */
export function collectBuildInfo({ root, files, helpers, gitBin = "git" }) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const names = Object.keys(helpers).sort();
  const installed = {};
  const helperHashes = {};
  for (const name of names) {
    const packed = byPath.get(`helpers/${name}`);
    if (!packed) throw new Error(`build.json: helper ${name} is not among the packed inputs (expected helpers/${name})`);
    installed[name] = installTransform(Buffer.from(packed.bytes).toString("utf8"));
    helperHashes[name] = installedHash(packed.bytes);
  }

  let provenance = "none";
  let commit = null;
  let dirty = [];
  let history = Object.fromEntries(names.map((name) => [name, []]));
  const head = resolveCommit(gitBin, root, "HEAD");
  const provenanceFile = join(root, PROVENANCE_FILE);
  if (head !== null) {
    provenance = "git";
    commit = head;
    const repoPaths = [...new Set(files.map((f) => f.repoPath))];
    const headBlobs = catFileBatch(gitBin, root, repoPaths.map((p) => `${commit}:${p}`));
    if (headBlobs !== null) dirty = dirtyInputs(files, new Map(repoPaths.map((p) => [p, headBlobs.get(`${commit}:${p}`) ?? null])));
    history = historyAt({ gitBin, root, commit, helpers }) ?? history;
  } else if (existsSync(provenanceFile)) {
    // The deploy archive: `git archive <ref>` is that commit's bytes, so there is nothing for `dirty` to find.
    provenance = "deploy-archive";
    const read = readProvenance(provenanceFile, names);
    commit = read.commit;
    history = Object.fromEntries(names.map((name) => [name, [...read.officialHistory[name]]]));
  }
  if (provenance !== "none") {
    // The target build is never unknown to itself: the packed text joins its own helper's history.
    for (const name of names) history[name] = [...new Set([...history[name], helperHashes[name]])].sort();
  }

  return {
    schema: BUILD_SCHEMA,
    provenance,
    commit,
    dirty,
    inputsDigest: inputsDigest(files),
    helpers: helperHashes,
    imports: helperImports(installed),
    officialHistory: history,
  };
}

/** `node scripts/cli-build-info.mjs provenance <ref>`'s answer, for the repo containing `cwd`: the full commit `ref`
 * names and the official history of the helpers THAT COMMIT packs. The helper list and the install transform are read
 * from `<ref>:cli/lib/helpers.mjs` itself, not from this checkout, so deploying a ref other than the checked-out one
 * still describes the ref. Throws when `ref` is not a commit or its history cannot be read. */
export async function provenanceFor({ cwd = process.cwd(), ref, gitBin = "git" }) {
  const top = git(gitBin, cwd, ["rev-parse", "--show-toplevel"]);
  if (top === null) throw new Error(`${cwd} is not inside a git repository`);
  const root = top.toString("utf8").trim();
  const commit = resolveCommit(gitBin, root, ref);
  if (!commit) throw new Error(`${ref} does not name a commit`);
  const source = git(gitBin, root, ["show", `${commit}:cli/lib/helpers.mjs`]);
  if (source === null) throw new Error(`${ref} has no cli/lib/helpers.mjs`);
  // Imported from a scratch copy: helpers.mjs uses only node builtins, and every path it derives from import.meta.url is
  // lazy or wrapped (CLI_VERSION falls back to "unknown"), so loading it outside a checkout is safe.
  const dir = mkdtempSync(join(tmpdir(), "opencadre-provenance-"));
  let mod;
  try {
    writeFileSync(join(dir, "helpers.mjs"), source);
    mod = await import(pathToFileURL(join(dir, "helpers.mjs")).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!mod.HELPERS || typeof mod.HELPERS !== "object") throw new Error(`${ref}:cli/lib/helpers.mjs exports no HELPERS`);
  const transform = typeof mod.installTransform === "function" ? mod.installTransform : installTransform;
  const officialHistory = historyAt({ gitBin, root, commit, helpers: mod.HELPERS, transform });
  if (officialHistory === null) throw new Error(`could not read the history of ${ref}'s helpers`);
  return { schema: PROVENANCE_SCHEMA, commit, officialHistory };
}

/** Every file under `dir`, as { path (POSIX, relative to dir), bytes }, sorted by path. */
export function walkFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(dir, rel));
    else if (entry.isFile()) out.push({ path: rel, bytes: readFileSync(join(dir, rel)) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The official history of THIS checkout's helpers at HEAD, for a CLI run from a checkout (no build.json): the installer
 * (cli/lib/generations.mjs) asks for it only when it meets an untracked helper it must classify, so a plain connect pays
 * nothing. Null when git cannot answer (not a checkout, no git): every untracked differing file is then unknown. */
export function checkoutHistory({ root = fileURLToPath(new URL("../", import.meta.url)), gitBin = "git" } = {}) {
  const commit = resolveCommit(gitBin, root, "HEAD");
  if (commit === null) return null;
  const history = historyAt({ gitBin, root, commit, helpers: HELPERS });
  return history === null ? null : { commit, officialHistory: history };
}

// CLI: `node scripts/cli-build-info.mjs provenance <ref>` prints the provenance JSON on stdout (scripts/deploy-vps.sh);
// `node scripts/cli-build-info.mjs history` prints checkoutHistory() (cli/lib/generations.mjs, from a checkout).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [mode, ref] = process.argv.slice(2);
  if (mode === "history") {
    process.stdout.write(`${JSON.stringify(checkoutHistory())}\n`);
    process.exit(0);
  }
  if (mode !== "provenance" || !ref) {
    console.error("usage: node scripts/cli-build-info.mjs provenance <ref> | history");
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(await provenanceFor({ ref }), null, 2)}\n`);
  } catch (err) {
    console.error(`cli-build-info: ${err.message}`);
    process.exit(1);
  }
}
