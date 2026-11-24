// Atomic, generation-pinned helper installs (Q1g PR-2: B:\ai-work\temp\2040-q1g\PLAN-Q1G.md §2.B-C, ruling 049a §2-4 and
// 049a's §2b refinements).
//
// LAYOUT under ~/.opencadre/bin:
//   .gen/<id>/                 one complete, immutable helper tree (every HELPERS name, installed text) plus
//                              .generation.json describing it. <id> is the CLI build's inputsDigest (first 12 hex) for a
//                              packed CLI, or the tree digest of the helper hashes when the CLI runs from a checkout.
//   .gen/current               a one-line pointer naming the active generation.
//   <entry>                    for every ENTRIES name, a stable stub (cli/lib/stubs.mjs) that reads the pointer ONCE and
//                              loads its own name from that generation. Clients keep the paths they already reference.
//   .opencadre-install.json    the success manifest, written LAST (plan §2.B step 5).
//   .backup/<ts>/<name>        durable copies of files `--force` replaced (never pruned in this release).
//
// UPGRADE (applyInstall): stage the tree into .gen/.staging-<rand>/ -> verify every file's sha256 against the target
// (the hub manifest's helpers when verifying against a hub, else this CLI's build) and every `imports` edge inside the
// tree -> rename the staging folder to .gen/<id>/ (one directory rename; a partial tree is never visible under an id)
// -> write current.tmp-*, rename it over current (retried on EPERM/EBUSY) -> write the entry stubs that are missing or
// out of date (each by rename) -> only then the success manifest. A failure before the pointer flip removes the staging
// folder and leaves `current`, the old generation and the manifest byte-identical.
//
// NO PRUNING (049a §2b-1). A long-lived plugin or proxy keeps the generation it loaded and may later spawn that
// generation's gate or wake, or import its files. So every generation is kept in this release; only an interrupted run's
// staging folders and pointer temp files are ever removed.
//
// LEGACY CONVERSION (049a §2b-3). An install from before generations holds full helper files at the root. Converting it
// writes the ENTRY stubs over the root entries, each by rename, and leaves every root LIBRARY file untouched, so an old
// entry that is still running keeps importing the old libraries it started with (an old, coherent closure) while a new
// invocation goes through a stub into its generation (a new, coherent closure). The remaining cross-generation edges are
// listed in LEGACY_EDGES below. This is NOT made safe by any ordering of the writes: dependency order alone is not an
// atomic bundle change, which is why conversion also requires a quiescent window: `connect --upgrade` inventories the
// live consumers it can detect (liveConsumers) and refuses without --force while any is live.

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_VERSION, ENTRIES, HELPERS, installedText, installManifestPath, readInstallManifest } from "./helpers.mjs";
import { helperImports, resolveImports } from "./imports.mjs";
import { isStub, stubText } from "./stubs.mjs";

export const GEN = ".gen";
export const BACKUP = ".backup";
export const LAYOUT = "generations";
const POINTER = "current";
const GEN_META = ".generation.json";
const ID = /^[0-9a-f]{12}$/;

/** Every edge by which one helper reaches ANOTHER ENTRY's slot, or the install root by absolute path. From an old
 * (legacy) root file such an edge lands, after conversion, on a stub, so the old caller gets the NEW generation's closure
 * for that callee. Each is justified here; tests/generations-inventory.test.ts rebuilds this table from the helpers' text
 * (static and dynamic imports, `new URL(..., import.meta.url)` and `here()` spawns, `".opencadre", "bin"` paths), so it
 * cannot drift.
 *   imports   opencadre-approval-gate-loader.mjs -> opencadre-approval-gate.mjs. In-process: an old loader imports the
 *             new gate. The loader imports nothing else (node:fs only), so no old library meets a new one; the gate's
 *             closure is the new generation's whole.
 *   spawns    a separate PROCESS whose closure is whichever generation its stub (or, inside a generation, its sibling)
 *             pins, never mixed with the caller's: awareness and antigravity start wake; the Amp plugin, kilo-core and
 *             OpenCode's clearance start the gate; the Cline hook starts the stamp, the gate and awareness.
 *   absolute  opencode-plugin/clearance.js falls back to <root>/opencadre-approval-gate.mjs (the entry stub) only when no
 *             gate sits beside its folder, i.e. in a checkout; inside a generation it uses its sibling. (A LEGACY
 *             opencode-plugin/index.js also imported <root>/opencadre-config.mjs by absolute path: a library conversion
 *             never rewrites, so that old plugin keeps its old config. The current one imports its own generation's.)
 * Entry-to-library imports (kilo-plugin -> kilo-core, every hook -> config, dialect, clients) are the ordinary closure:
 * inside a generation they resolve in it, and from a legacy root file they reach root libraries conversion leaves as
 * they were. Inside a generation every edge above resolves to the same generation: that is the pinning. */
export const LEGACY_EDGES = {
  imports: { "opencadre-approval-gate-loader.mjs": ["opencadre-approval-gate.mjs"] },
  spawns: {
    "opencadre-amp-plugin.mjs": ["opencadre-approval-gate.mjs"],
    "opencadre-antigravity.mjs": ["opencadre-wake.mjs"],
    "opencadre-awareness.mjs": ["opencadre-wake.mjs"],
    "opencadre-cline-hook.mjs": ["opencadre-approval-gate.mjs", "opencadre-awareness.mjs", "opencadre-session-stamp.mjs"],
    "opencadre-kilo-core.mjs": ["opencadre-approval-gate.mjs"],
    "opencode-plugin/clearance.js": ["opencadre-approval-gate.mjs"],
  },
  absolute: ["opencode-plugin/clearance.js"],
};

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const shortHash = (text) => sha256(text).slice(0, 12);
export const genRoot = (bin) => join(bin, GEN);
export const generationPath = (bin, id) => join(bin, GEN, id);
const pointerFile = (bin) => join(bin, GEN, POINTER);
export const fileIn = (dir, name) => join(dir, ...name.split("/"));
const readText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const rand = () => randomBytes(4).toString("hex");

/** An install failure with the exit code the CLI should end with (2: refused, nothing unsafe was done; 1: failed). */
export class InstallError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---- the pointer ----------------------------------------------------------------------------------------------------

/** { id, problem }: the active generation id, or null with why ("missing", "malformed", "unreadable (...)"). */
export function readPointer(bin) {
  let raw;
  try {
    raw = readFileSync(pointerFile(bin), "utf8");
  } catch (err) {
    return { id: null, problem: err.code === "ENOENT" ? "missing" : `unreadable (${err.code})` };
  }
  const id = raw.trim();
  return ID.test(id) ? { id, problem: null } : { id: null, problem: "malformed" };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

/** renameSync, retried with bounded backoff on the errors a virus scanner or a concurrent reader causes on Windows. */
export function renameRetry(from, to, tries = 12) {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (!TRANSIENT.has(err.code) || i >= tries) throw err;
      sleepSync(Math.min(10 * 2 ** i, 500));
    }
  }
}

// DURABILITY, AND WHAT IT COSTS. fsync is ~80 ms per file on this box's disks (measured 2026-10-01: 30 files in 2.4 s),
// so it is spent where a lost write is a lost user file or a lie: every --force BACKUP (ruling §3), the pointer and the
// success manifest. The generation's own files and the stubs are written without it: after a power loss they can be
// incomplete, which `installState` reports as partial (the tree no longer verifies against its .generation.json) and
// which the gate stub meets by failing CLOSED, never by running a half-written gate.
function writeDurable(file, text, { sync = true } = {}) {
  const fd = openSync(file, "w");
  try {
    writeSync(fd, text);
    if (sync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir) {
  // A directory fsync makes a new entry durable on POSIX; Windows cannot open a directory for it, and NTFS journals the
  // entry itself, so there it is a no-op.
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch { /* not supported here */ }
}

/** Replace `file` with `text` by writing a sibling temp file and renaming it over: a reader sees the old bytes or the new,
 * never a truncated file. */
export function replaceFile(file, text, { sync = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.opencadre-tmp-${process.pid}-${rand()}`;
  writeDurable(tmp, text, { sync });
  try {
    renameRetry(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Atomically point the install at generation `id`: write current.tmp-*, then rename it over current. */
export function writePointer(bin, id, { onStep = () => {} } = {}) {
  if (!ID.test(id)) throw new Error(`not a generation id: ${JSON.stringify(id)}`);
  mkdirSync(genRoot(bin), { recursive: true });
  const file = pointerFile(bin);
  const tmp = `${file}.tmp-${process.pid}-${rand()}`;
  writeDurable(tmp, `${id}\n`);
  onStep("pointer-tmp", { bin, id, tmp });
  try {
    renameRetry(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ---- the target build -----------------------------------------------------------------------------------------------

/** The tree digest of a helper-hash map: sha256 over sorted `<sha256>  <name>` lines, first 12 hex. */
export const treeId = (helpers) => sha256(Object.keys(helpers).sort().map((n) => `${helpers[n]}  ${n}\n`).join("")).slice(0, 12);

/** A target generation: { kind, id, names, text(name), helpers: {name: sha256}, imports, history() }. `files` maps every
 * helper name to its installed text. Exported so a test can install a generation of its own making. */
export function makeTarget({ files, id, kind = "custom", inputsDigest = null, commit = null, history = null }) {
  const names = Object.keys(files).sort();
  const helpers = Object.fromEntries(names.map((n) => [n, sha256(files[n])]));
  const target = { kind, id: id ?? treeId(helpers), inputsDigest, commit, names, text: (n) => files[n], helpers, imports: helperImports(files) };
  let memo;
  target.history = typeof history === "function" ? () => (memo === undefined ? (memo = history() ?? null) : memo) : () => history;
  if (!ID.test(target.id)) throw new Error(`generation id must be 12 hex, got ${JSON.stringify(target.id)}`);
  return target;
}

const BUILD_JSON = fileURLToPath(new URL("../build.json", import.meta.url));
const BUILD_INFO_SCRIPT = fileURLToPath(new URL("../../scripts/cli-build-info.mjs", import.meta.url));
let cachedBuild;

/** THIS CLI's own build as a target: from the packed package's build.json (id = inputsDigest), or, run from a checkout,
 * a "checkout build" whose id is the helper tree digest and whose official history comes from `git log`, read only
 * when a classification needs it. Throws when a packed package's helpers do not match its own build.json. */
export function cliBuild() {
  if (cachedBuild) return cachedBuild;
  const files = Object.fromEntries(Object.keys(HELPERS).map((n) => [n, installedText(n)]));
  if (existsSync(BUILD_JSON)) {
    let build;
    try {
      build = JSON.parse(readFileSync(BUILD_JSON, "utf8"));
    } catch (err) {
      throw new InstallError(1, `this CLI's build.json is unreadable (${err.message}); get the hub's current CLI again.`);
    }
    if (typeof build?.inputsDigest !== "string" || !/^[0-9a-f]{64}$/.test(build.inputsDigest) || !build.helpers || typeof build.helpers !== "object") {
      throw new InstallError(1, "this CLI's build.json is malformed; get the hub's current CLI again.");
    }
    const target = makeTarget({ files, kind: "build", id: build.inputsDigest.slice(0, 12), inputsDigest: build.inputsDigest, commit: build.commit ?? null, history: build.officialHistory ?? null });
    const bad = target.names.filter((n) => build.helpers[n] !== target.helpers[n]);
    if (bad.length) throw new InstallError(1, `this CLI package is inconsistent: ${bad.join(", ")} do not match its own build.json. Get the hub's current CLI again.`);
    target.provenance = build.provenance ?? null;
    return (cachedBuild = target);
  }
  const history = () => {
    if (!existsSync(BUILD_INFO_SCRIPT)) return null;
    const r = spawnSync(process.execPath, [BUILD_INFO_SCRIPT, "history"], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return null;
    try {
      return JSON.parse(r.stdout)?.officialHistory ?? null;
    } catch {
      return null;
    }
  };
  return (cachedBuild = makeTarget({ files, kind: "checkout", history }));
}

// ---- classification (plan §C) ---------------------------------------------------------------------------------------

/** One file against the text it should be:
 *   "missing"       absent or empty                                      -> write
 *   "current"       equal to the target                                  -> nothing
 *   "stale"         recorded by the local manifest and unchanged since   -> refresh
 *   "official-old"  not recorded (or refused before as "unknown"), and   -> refresh
 *                   its hash is in THIS target's official history
 *   "unknown"       not recorded (or refused before as "unknown"), and   -> refuse, list (--force: back up, replace)
 *                   its hash is not in this target's history
 *   "edited"        recorded, and changed since; or refused before as    -> refuse, list (--force: back up, replace)
 *                   "edited", whatever its bytes are now
 * A refused slot's hash is recorded in the manifest, and that record must never make it read as "stale" (049a ruling
 * §3: a file OpenCadre cannot vouch for is never replaced by a normal upgrade). So a slot a previous upgrade refused
 * keeps its refusal until it is current again or forced, with one exception: a slot refused as "unknown" is judged
 * against this target's history again, never against its recorded hash. "unknown" meant only that the history could not
 * tell (as when a build shipped with an empty one); a hash in the history is by definition bytes OpenCadre shipped. */
export function classify({ name, disk, want, previous, history }) {
  if (disk === null || disk === "") return "missing";
  if (disk === want) return "current";
  const refusedBefore = previous?.refused?.[name];
  if (refusedBefore === "edited") return refusedBefore;
  if (refusedBefore !== "unknown") {
    const recorded = previous ? (previous.layout === LAYOUT ? previous.slots?.[name] : previous.helpers?.[name]) : undefined;
    if (typeof recorded === "string") return shortHash(disk) === recorded ? "stale" : "edited";
  }
  const hashes = history?.[name];
  return Array.isArray(hashes) && hashes.includes(sha256(disk)) ? "official-old" : "unknown";
}

const REFUSED = new Set(["unknown", "edited"]);

// A backup an older tool wrote under a naming convention nothing manages any more (measured on this PC 2026-09-18: an
// orphaned opencadre-config.mjs.bak-20260915152059). Only files matching a MANAGED helper's name are touched. Unchanged
// from before generations (ruling §3: no silent retention change).
const STALE_BACKUP = /^(.+\.mjs)\.bak-.*$/;
function orphanedBackups(bin) {
  if (!existsSync(bin)) return [];
  return readdirSync(bin).filter((f) => {
    const managed = f.match(STALE_BACKUP)?.[1];
    return managed !== undefined && managed in HELPERS;
  });
}

/** What an interrupted run left behind: staging folders, pointer temp files, entry temp files. */
export function leftovers(bin) {
  const found = [];
  const gen = genRoot(bin);
  if (existsSync(gen)) for (const f of readdirSync(gen)) if (f.startsWith(".staging-") || f.startsWith(`${POINTER}.tmp-`)) found.push(join(gen, f));
  for (const dir of [bin, join(bin, "opencode-plugin")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.includes(".opencadre-tmp-")) found.push(join(dir, f));
  }
  return found;
}

/** The text that is running for `name` now: the active generation's copy, else a legacy root file (not a stub). */
function runningText(bin, name, pointerId) {
  if (pointerId) {
    const text = readText(fileIn(generationPath(bin, pointerId), name));
    if (text !== null) return text;
  }
  const root = readText(fileIn(bin, name));
  return root !== null && !isStub(root) ? root : null;
}

/** What installing `target` into `bin` would do, without writing anything. `force` turns every refusal into a durable
 * backup followed by a replacement. */
export function planInstall(bin, { target = cliBuild(), force = false, pruneBackups = true } = {}) {
  const previous = readInstallManifest(bin);
  const pointer = readPointer(bin);
  let historyMemo;
  const history = () => (historyMemo === undefined ? (historyMemo = target.history() ?? null) : historyMemo);
  // History is read only for a file that is neither current nor recorded (or was refused as unknown), so a clean connect
  // never runs git.
  const classifyLazy = (name, disk, want) => {
    const quick = classify({ name, disk, want, previous, history: null });
    return quick === "unknown" ? classify({ name, disk, want, previous, history: history() }) : quick;
  };
  const slots = Object.keys(ENTRIES).filter((n) => n in target.helpers).map((name) => {
    const disk = readText(fileIn(bin, name));
    const want = stubText(name, target.text(name));
    const cls = classifyLazy(name, disk, want);
    const action = cls === "current" ? "keep" : REFUSED.has(cls) ? (force ? "backup-replace" : "refuse") : "write";
    return { name, disk, want, cls, action, legacy: disk !== null && disk !== "" && !isStub(disk) };
  });
  const libraries = target.names.filter((n) => !(n in ENTRIES)).flatMap((name) => {
    const disk = readText(fileIn(bin, name));
    return disk === null ? [] : [{ name, cls: classifyLazy(name, disk, target.text(name)), hash: sha256(disk) }];
  });
  // A refused legacy entry keeps running its OWN code; if that code imports another entry's slot that is (or will be)
  // a stub, it would run a NEW closure under OLD code: a mixed closure. That pair blocks the switch.
  const stubAfter = new Set(slots.filter((s) => s.action !== "refuse" && (s.action !== "keep" || isStub(s.disk))).map((s) => s.name));
  const blockers = slots
    .filter((s) => s.action === "refuse" && s.legacy)
    .flatMap((s) => resolveImports(s.name, s.disk).filter((d) => stubAfter.has(d)).map((d) => ({ refused: s.name, imports: d })));
  const changed = target.names.filter((n) => runningText(bin, n, pointer.id) !== target.text(n));
  return {
    target,
    force,
    pruneBackups,
    id: target.id,
    previous,
    pointer,
    slots,
    libraries,
    blockers,
    changed,
    refused: slots.filter((s) => s.action === "refuse").map((s) => s.name),
    forced: slots.filter((s) => s.action === "backup-replace").map((s) => s.name),
    written: slots.filter((s) => s.action === "write" || s.action === "backup-replace").map((s) => s.name),
    converting: slots.some((s) => s.legacy && s.action !== "refuse" && s.action !== "keep"),
    removed: pruneBackups ? orphanedBackups(bin) : [],
    newGeneration: !existsSync(generationPath(bin, target.id)),
  };
}

// ---- verification ---------------------------------------------------------------------------------------------------

/** Problems with the tree in `dir` against `expected` ({name: sha256}) and `imports`: [] when every file is there with
 * the expected hash and every import edge resolves inside the tree. */
export function verifyTree(dir, expected, imports) {
  const problems = [];
  for (const name of Object.keys(expected).sort()) {
    const text = readText(fileIn(dir, name));
    if (text === null) problems.push(`${name} is missing`);
    else if (sha256(text) !== expected[name]) problems.push(`${name} has sha256 ${sha256(text).slice(0, 12)}, expected ${String(expected[name]).slice(0, 12)}`);
  }
  for (const [name, deps] of Object.entries(imports ?? {})) {
    for (const d of deps) if (!(d in expected) || !existsSync(fileIn(dir, d))) problems.push(`${name} imports ${d}, which is not in the generation`);
  }
  return problems;
}

// An atomic acquisition guard serializes claiming/recovering the installer lock. All installers use it, so two
// contenders cannot both delete a dead owner's lock and then remove the new owner's lock (the stale-lock ABA race).
// A process killed during this brief claim leaves the guard in place: refuse rather than guess. A confirmed dead
// full-install owner is recovered automatically under the guard; live or unreadable owners are never displaced.
const INSTALL_LOCK = ".opencadre-install.lock";
const ACQUIRE_GUARD = ".opencadre-install-acquire.lock";
export function acquireInstaller(bin) {
  mkdirSync(bin, { recursive: true });
  const guard = join(bin, ACQUIRE_GUARD);
  const lock = join(bin, INSTALL_LOCK);
  let guardFd;
  try { guardFd = openSync(guard, "wx"); }
  catch (err) {
    if (err.code !== "EEXIST") throw err;
    throw new InstallError(2, "Another installer is claiming this install. Nothing was changed. Retry when it finishes; if it crashed while claiming, confirm no installer is running before removing .opencadre-install-acquire.lock.");
  }
  try {
    if (existsSync(lock)) {
      let owner;
      try { owner = JSON.parse(readFileSync(lock, "utf8")); } catch { /* refuse unreadable owners */ }
      if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 1 || alive(owner.pid)) {
        throw new InstallError(2, "Another installer owns this install, or its ownership cannot be verified. Nothing was changed. Retry when it finishes; review an unreadable .opencadre-install.lock only after confirming no installer is running.");
      }
      unlinkSync(lock); // only a confirmed dead owner, while every other claim is excluded
    }
    const token = rand();
    const fd = openSync(lock, "wx");
    try { writeSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); }
    finally { closeSync(fd); }
    return () => {
      // Never remove a lock we no longer own (e.g. someone manually altered it).
      let owner;
      try { owner = JSON.parse(readFileSync(lock, "utf8")); } catch { return; }
      if (owner.pid === process.pid && owner.token === token) unlinkSync(lock);
    };
  } finally { closeSync(guardFd); unlinkSync(guard); }
}

// ---- apply ----------------------------------------------------------------------------------------------------------

/** Carry out `plan` (from planInstall). `verifyHelpers` ({name: sha256}, the hub manifest's) replaces the target's own
 * hashes as what the staged tree must equal. `onStep(step, info)` is called after each step ("staged", "validated",
 * "renamed" or "reused", "pointer-tmp", "pointer", "stubs", "manifest"): tests interrupt or corrupt the run there.
 * Returns { id, stamp, backups, manifest }. Throws InstallError; before the pointer flip a failure leaves `current`, every
 * generation and the manifest as they were, and removes the staging folder. */
export function applyInstall(bin, plan, options = {}) {
  const release = acquireInstaller(bin);
  try {
    // Planning may precede a slow process inventory. Revalidate under ownership so an intervening upgrade/edit cannot
    // lose the peer's activated history or replace/back up bytes from an obsolete snapshot. Refuse before any writes.
    const fresh = planInstall(bin, { target: plan.target, force: plan.force, pruneBackups: plan.pruneBackups });
    const inputs = (p) => JSON.stringify({ previous: p.previous, pointer: p.pointer, slots: p.slots, libraries: p.libraries, removed: p.removed, newGeneration: p.newGeneration });
    if (inputs(fresh) !== inputs(plan)) throw new InstallError(2, "This install changed after the upgrade plan was made. Nothing was changed. Run the command again to review the current files.");
    return applyInstallOwned(bin, fresh, options);
  } finally { release(); }
}
function applyInstallOwned(bin, plan, { verifyHelpers = null, onStep = () => {}, now = new Date() } = {}) {
  const { target } = plan;
  if (plan.blockers.length) {
    throw new InstallError(2, `Refused: ${plan.blockers.map((b) => `${b.refused} (left as it is) imports ${b.imports}, which this upgrade would move to the new generation`).join("; ")}. That would run new files under old code. Nothing was changed. Re-run with --force to back up and replace ${[...new Set(plan.blockers.map((b) => b.refused))].join(", ")}.`);
  }
  const expected = verifyHelpers ?? target.helpers;
  const missingFromTarget = Object.keys(expected).filter((n) => !target.names.includes(n));
  if (missingFromTarget.length || target.names.some((n) => !(n in expected))) {
    throw new InstallError(2, `This CLI's helpers are not the set the hub's manifest describes (${[...missingFromTarget, ...target.names.filter((n) => !(n in expected))].join(", ")}). Nothing was changed.`);
  }
  mkdirSync(genRoot(bin), { recursive: true });
  // Only an interrupted run's own leftovers go: staging folders and temp files. Never a generation (049a §2b-1).
  for (const f of leftovers(bin)) rmSync(f, { recursive: true, force: true });

  // Backups first, so a replacement never precedes its durable copy (ruling §3). They survive any later failure.
  const backups = [];
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  for (const s of plan.slots.filter((x) => x.action === "backup-replace")) {
    const dest = fileIn(join(bin, BACKUP, stamp), s.name);
    mkdirSync(dirname(dest), { recursive: true });
    writeDurable(dest, s.disk);
    fsyncDir(dirname(dest));
    backups.push(dest);
  }

  const id = target.id;
  const final = generationPath(bin, id);
  let staging = null;
  try {
    if (!existsSync(final)) {
      staging = join(genRoot(bin), `.staging-${process.pid}-${rand()}`);
      mkdirSync(staging);
      for (const name of target.names) {
        mkdirSync(dirname(fileIn(staging, name)), { recursive: true });
        writeDurable(fileIn(staging, name), target.text(name), { sync: false });
      }
      writeDurable(join(staging, GEN_META), `${JSON.stringify({ id, kind: target.kind, inputsDigest: target.inputsDigest, commit: target.commit, helpers: target.helpers, imports: target.imports }, null, 2)}\n`, { sync: false });
      onStep("staged", { bin, id, staging });
      const problems = verifyTree(staging, expected, target.imports);
      if (problems.length) throw new InstallError(1, `The staged generation did not verify (${problems.join("; ")}). Nothing was switched; the install is as it was.`);
      onStep("validated", { bin, id, staging });
      try {
        renameRetry(staging, final);
        staging = null;
      } catch (err) {
        // Another run may have created the same generation meanwhile: reuse it only if it verifies.
        if (!existsSync(final) || verifyTree(final, expected, target.imports).length) throw err;
      }
      onStep("renamed", { bin, id, final });
    } else {
      const problems = verifyTree(final, expected, target.imports);
      if (problems.length) {
        throw new InstallError(2, `Generation ${id} already exists at ${final} but does not verify (${problems.join("; ")}). It was left as it is, and nothing was switched: move that folder aside, then run the upgrade again.`);
      }
      onStep("reused", { bin, id, final });
    }
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }

  if (readPointer(bin).id !== id) writePointer(bin, id, { onStep });
  onStep("pointer", { bin, id });

  for (const s of plan.slots.filter((x) => x.action === "write" || x.action === "backup-replace")) replaceFile(fileIn(bin, s.name), s.want);
  onStep("stubs", { bin, id });

  for (const f of plan.removed) rmSync(join(bin, f), { force: true });

  const manifest = manifestFor(plan, now);
  replaceFile(installManifestPath(bin), `${JSON.stringify(manifest, null, 2)}\n`, { sync: true });
  onStep("manifest", { bin, id });
  return { id, stamp: manifest.stamp, backups, manifest };
}

function manifestFor(plan, now) {
  const { target, previous } = plan;
  const helpers = Object.fromEntries(target.names.map((n) => [n, target.helpers[n].slice(0, 12)]));
  // Same formula as every earlier manifest: over the installed contents, sorted, so it changes exactly when they do.
  const stamp = shortHash(Object.keys(helpers).sort().map((n) => `${n}:${helpers[n]}`).join("\n"));
  const slots = {};
  const refused = {};
  for (const s of plan.slots) {
    if (s.action === "refuse") {
      // Keep the RECORDED hash of an edited file, so it keeps reading as edited; record an unknown one as it is.
      const recorded = previous ? (previous.layout === LAYOUT ? previous.slots?.[s.name] : previous.helpers?.[s.name]) : undefined;
      slots[s.name] = s.cls === "edited" && typeof recorded === "string" ? recorded : shortHash(s.disk);
      refused[s.name] = s.cls;
    } else {
      slots[s.name] = shortHash(s.want);
    }
  }
  const activated = [...new Set([...(Array.isArray(previous?.activated) ? previous.activated : []), target.id])];
  return {
    cliVersion: CLI_VERSION,
    stamp,
    installedAt: now.toISOString(),
    layout: LAYOUT,
    generation: target.id,
    activated,
    build: { kind: target.kind, inputsDigest: target.inputsDigest, commit: target.commit },
    helpers,
    slots,
    refused,
  };
}

// ---- the helpers API the CLI and doctor use --------------------------------------------------------------------------

/** What an install in `bin` is behind this CLI: { stale, edited, missing, unstamped }, arrays of names. `stale` names
 * helpers whose running copy differs from this CLI's; `edited` names entry slots a normal upgrade would refuse. */
export function driftReport(bin, { target = cliBuild() } = {}) {
  const plan = planInstall(bin, { target, pruneBackups: false });
  return {
    stale: plan.changed,
    edited: plan.refused,
    missing: plan.slots.filter((s) => s.cls === "missing").map((s) => s.name),
    unstamped: plan.previous === null,
  };
}

/** One line describing drift, or null when there is none, so connect and doctor describe it the same way. */
export function driftLine(drift) {
  if (!drift.unstamped && drift.stale.length === 0 && drift.edited.length === 0 && drift.missing.length === 0) return null;
  if (drift.unstamped) return "This install has no record of which revision it came from, so its helpers were replaced with this CLI's copies.";
  const parts = [];
  if (drift.stale.length > 0) parts.push(`${drift.stale.length} helper(s) were a stale revision and have been updated`);
  if (drift.missing.length > 0) parts.push(`${drift.missing.length} were missing and have been restored`);
  if (drift.edited.length > 0) parts.push(`${drift.edited.length} had been changed on this machine and were backed up, then replaced (${drift.edited.join(", ")})`);
  return `${parts.join("; ")}.`;
}

/** `connect`'s install: set the install up with no refusal (a refused file is backed up durably, then replaced).
 * Returns the paths it manages (every entry slot, then the generation folder), with `.drift` (the state BEFORE, which
 * the install erases), `.backups` and `.plan`. */
export function installHelpers(bin, { target = cliBuild(), onStep } = {}) {
  mkdirSync(bin, { recursive: true });
  const drift = driftReport(bin, { target });
  const plan = planInstall(bin, { target, force: true, pruneBackups: false });
  const result = applyInstall(bin, plan, { onStep });
  const written = [...plan.slots.map((s) => fileIn(bin, s.name)), generationPath(bin, plan.id)];
  written.drift = drift;
  written.backups = result.backups;
  written.plan = plan;
  return written;
}

/** What `connect --upgrade` would do: { changed, refused, forced, written, removed, blockers, libraries, converting, ... }. */
export function planUpgrade(bin, { force = false, target = cliBuild() } = {}) {
  return planInstall(bin, { target, force });
}

/** `connect --upgrade`: { changed, refused, forced, removed, backups, stamp, id, plan }. Throws InstallError. */
export function upgradeHelpers(bin, { force = false, target = cliBuild(), verifyHelpers = null, onStep } = {}) {
  mkdirSync(bin, { recursive: true });
  const plan = planInstall(bin, { target, force });
  const result = applyInstall(bin, plan, { verifyHelpers, onStep });
  return { changed: plan.changed, refused: plan.refused, forced: plan.forced, removed: plan.removed, backups: result.backups, stamp: result.stamp, id: result.id, plan };
}

// ---- live consumers (the quiescent window, 049a §2b-3) ---------------------------------------------------------------

const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

/** Every process on this machine, as [{ pid, name, startedAt, line }], or null when the platform would not say. Read-only,
 * one query. `startedAt` is the process's creation time (ms since the epoch) and `line` its command line; either is null
 * where the platform does not let this user read it (Windows hides another account's command line, as it did for the
 * `svchost.exe` that held a stale wake lock's pid on 2026-10-01): that is UNKNOWN, never evidence either way. */
export function processTable() {
  if (process.platform === "win32") {
    const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;Get-CimInstance Win32_Process | ForEach-Object { $c=$_.CreationDate; \"$($_.ProcessId)`t$(if($c){([DateTimeOffset]$c).ToUnixTimeMilliseconds()})`t$($_.Name)`t$($_.CommandLine -replace '[\\r\\n\\t]', ' ')\" }";
    // By its full path, as opencadre-config.mjs walkAncestors does: a PATH without System32 must not blind the inventory.
    const powerShell = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const r = spawnSync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout.split(/\r?\n/).map((l) => l.split("\t")).filter((f) => f.length >= 4 && /^\d+$/.test(f[0])).map(([pid, started, name, ...line]) => ({
      pid: Number(pid),
      name: name || null,
      startedAt: /^\d+$/.test(started) ? Number(started) : null,
      line: line.join("\t").trim() || null,
    }));
  }
  // lstart is the start time in the C locale's fixed form ("Wed Oct  1 04:47:56 2026", local time).
  const ps = ["/bin/ps", "/usr/bin/ps"].find((p) => existsSync(p)) ?? "ps";
  const r = spawnSync(ps, ["-eo", "pid=,lstart=,args="], { encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" }, windowsHide: true });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout.split("\n").map((l) => /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(l)).filter(Boolean).map((m) => {
    const startedAt = Date.parse(m[2].replace(/\s+/g, " "));
    const line = m[3].trim() || null;
    return { pid: Number(m[1]), name: line ? line.split(/\s+/)[0].replace(/^.*[\\/]/, "") : null, startedAt: Number.isFinite(startedAt) ? startedAt : null, line };
  });
}

/** Text with anything credential-shaped removed: OpenCadre keys and connect codes, bearer tokens, and the value after a
 * key/token/secret/password flag or variable, written plainly (`--token x`, `TOKEN=x`) or as a JSON/TOML array
 * (`"--token", "x"`). Defence in depth only: callers must not put prior config values in text they persist at all. */
export function redactSecrets(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\b(agt|dev|org)_[A-Za-z0-9._~-]+/g, "$1_[redacted]")
    .replace(/\b(oci|ocd|oca|ocr|oc)_[A-Za-z0-9]{8,}/g, "$1_[redacted]")
    .replace(/(\bBearer\s+)\S+/gi, "$1[redacted]")
    .replace(/("--?(?:key|token|api-key|apikey|secret|password|credential)"\s*,\s*")(?:[^"\\]|\\.)*/gi, "$1[redacted]")
    .replace(/(--?(?:key|token|api-key|apikey|secret|password|credential)(?:=|\s+))\S+/gi, "$1[redacted]")
    .replace(/(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)\S+/g, "$1[redacted]");
}

/** A command line with anything credential-shaped removed, so the inventory can print it. Kept short. */
export function redactCommandLine(line) {
  if (typeof line !== "string") return line;
  const out = redactSecrets(line);
  return out.length > 240 ? `${out.slice(0, 239)}…` : out;
}

/** The JavaScript runtimes an OpenCadre helper runs under. A process with any other executable is not one. */
const RUNTIME = /^(node|nodejs|bun|deno)(\.exe)?$/i;
/** How far a creation time may sit past the record's own time and still be its writer (clock granularity, not reuse). */
const START_TOLERANCE_MS = 5_000;
const when = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** The arguments of a command line: Windows rules (CommandLineToArgvW: quotes, and backslashes before a quote) on win32;
 * whitespace elsewhere, where `ps` prints the arguments without their quoting (a path with a space then splits, and
 * the process can only be judged unverified, never proven). */
export function splitCommandLine(line, platform = process.platform) {
  if (typeof line !== "string") return [];
  if (platform !== "win32") return line.trim().split(/\s+/).filter(Boolean);
  const args = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      let n = 0;
      while (line[i] === "\\") {
        n++;
        i++;
      }
      if (line[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2) cur += '"';
        else quoted = !quoted;
      } else {
        cur += "\\".repeat(n);
        i--;
      }
      any = true;
    } else if (c === '"') {
      quoted = !quoted;
      any = true;
    } else if (!quoted && (c === " " || c === "\t")) {
      if (any) args.push(cur);
      cur = "";
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (any) args.push(cur);
  return args;
}

/** Node options this parser POSITIVELY knows, so it can find the script after them. Any other option before the script
 * makes the script unknowable from the command line (an unknown option may take the next argument as its value: review
 * of #694 at b9875de2, `node --redirect-warnings <helper> other.mjs` runs only other.mjs), and the process is UNKNOWN.
 * VALUE_OPTIONS take exactly one value, as the next argument or after `=`; FLAG_OPTIONS take none as a separate argument
 * (an `=value` form, where Node allows one, is attached). NO_SCRIPT_OPTIONS mean no script file runs at all. */
const VALUE_OPTIONS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file", "--input-type", "--title", "--stack-size", "--inspect-port", "--disable-warning", "--redirect-warnings"]);
const FLAG_OPTIONS = new Set(["--no-warnings", "--no-deprecation", "--enable-source-maps", "--trace-warnings", "--trace-deprecation", "--trace-uncaught", "--throw-deprecation", "--pending-deprecation", "--expose-gc", "--preserve-symlinks", "--preserve-symlinks-main", "--abort-on-uncaught-exception", "--experimental-vm-modules", "--frozen-intrinsics", "--inspect", "--inspect-brk"]);
const NO_SCRIPT_OPTIONS = new Set(["-e", "--eval", "-p", "--print", "-i", "--interactive", "-c", "--check", "--test", "-v", "--version", "-h", "--help"]);

/** The script file a JavaScript runtime runs, from its argument list, or null when no script can be PROVEN. The executable
 * must be node, bun or deno (a shell or any other program that merely mentions a path runs nothing). The script is the
 * first argument after options this parser knows; an eval runs no file; any option it does not know (and, for bun and
 * deno, whose options are not modelled, any option at all) leaves the script unknown. */
export function runtimeScript(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  const exe = argv[0].replace(/^.*[\\/]/, "");
  if (!RUNTIME.test(exe)) return null;
  const node = /^(node|nodejs)(\.exe)?$/i.test(exe);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") return argv[i + 1] ?? null;
    if (!a.startsWith("-")) {
      if (i === 1 && a === "run" && !node) continue; // `bun run x`, `deno run x`
      return a;
    }
    if (!node) return null;
    const [name, attached] = a.includes("=") ? [a.slice(0, a.indexOf("=")), true] : [a, false];
    if (NO_SCRIPT_OPTIONS.has(name)) return null;
    if (VALUE_OPTIONS.has(name)) {
      if (!attached) i++;
      continue;
    }
    if (FLAG_OPTIONS.has(name)) continue;
    return null; // an option this parser does not know: what runs is not provable
  }
  return null;
}

/** Whether `script` is the installed helper `helper`: an absolute path (canonical, where it exists) whose file is that
 * helper, in an OpenCadre install folder: a `.opencadre/bin`, one of `bins`, or a generation (`.gen/<id>`) in either. */
export function isInstalledHelper(script, helper, bins = [], platform = process.platform) {
  if (typeof script !== "string" || !isAbsolute(script)) return false;
  let file = resolve(script);
  try {
    file = realpathSync(file);
  } catch { /* judged by the path it was started with */ }
  const same = (a, b) => (platform === "win32" ? a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase() : a === b);
  if (!same(basename(file), helper)) return false;
  let dir = dirname(file);
  if (ID.test(basename(dir)) && basename(dirname(dir)) === ".gen") dir = dirname(dirname(dir));
  if (bins.some((b) => same(resolve(b), dir))) return true;
  return same(basename(dir), "bin") && same(basename(dirname(dir)), ".opencadre");
}

/** Whether the live pid a record names is still the OpenCadre helper that wrote it. A pid is reused (on 2026-10-01 two
 * wake locks from 09-23 and 09-26 named pids that `svchost.exe`, started 09-28, held), so `kill(pid, 0)` alone proves
 * only that SOME process has that number. Evidence, strongest first:
 *   1. creation time: a process created after the record was written (`writtenAt`) cannot have written it, and one whose
 *      creation time differs from the writer's own (`procStart`, newer wake locks) is another process;
 *   2. the command line, where readable: its executable must be a JavaScript runtime whose script is the installed
 *      helper (`helper`, in an install folder: isInstalledHelper). One that only names the helper is UNKNOWN;
 *   3. the executable, where the command line is not readable: anything but a JavaScript runtime is not the helper.
 * What the platform will not say leaves the answer UNKNOWN, which the caller counts as live (to be safe) and labels.
 * Returns { verdict: "live" | "unknown" | "stale", why }. Never touches the process; never a reason to stop one. */
export function judgeRecordedPid({ pid, helper, label, writtenAt = null, procStart = null, bins = [] }, table, isAlive = alive) {
  if (!isAlive(pid)) return { verdict: "stale", why: `pid ${pid} is not running` };
  const proc = Array.isArray(table) ? table.find((p) => p.pid === pid) : null;
  if (!proc) return { verdict: "unknown", why: `pid ${pid} is running, but ${table ? "it is not in the process list" : "the process list could not be read"}, so whether it is the ${label} is unknown (counted to be safe)` };
  const name = proc.name ?? "an unnamed process";
  const started = Number.isFinite(proc.startedAt) ? when(proc.startedAt) : null;
  if (started && Number.isFinite(writtenAt) && proc.startedAt > writtenAt + START_TOLERANCE_MS) {
    return { verdict: "stale", why: `pid ${pid} was reused by ${name} (started ${started}, after this record was written ${when(writtenAt)})` };
  }
  if (started && Number.isFinite(procStart) && Math.abs(proc.startedAt - procStart) > START_TOLERANCE_MS) {
    return { verdict: "stale", why: `pid ${pid} was reused by ${name} (started ${started}; the ${label} that wrote this record started ${when(procStart)})` };
  }
  const since = started ? `started ${started}` : "start time unknown";
  if (proc.line) {
    const command = redactCommandLine(proc.line);
    if (isInstalledHelper(runtimeScript(splitCommandLine(proc.line)), helper, bins)) return { verdict: "live", why: `${since}, command ${command}` };
    // Naming the helper is not running it: a shell that echoes its path, an eval, a wrapper, a copy outside an install.
    if (proc.line.toLowerCase().includes(helper.replace(/\.m?js$/, ""))) {
      return { verdict: "unknown", why: `${since}, command ${command}; it names the ${label} but is not a JavaScript runtime running an installed one, so whether it is one is unknown (counted to be safe)` };
    }
    return { verdict: "stale", why: `pid ${pid} was reused by ${name} (${since}, command ${command})` };
  }
  if (proc.name && !RUNTIME.test(proc.name)) return { verdict: "stale", why: `pid ${pid} was reused by ${proc.name} (${since}; not a JavaScript runtime, so not the ${label})` };
  return { verdict: "unknown", why: `pid ${pid} is ${name}, ${since}, but its command line cannot be read, so whether it is the ${label} is unknown (counted to be safe)` };
}

/** The live consumers of the install in `bin` that can be detected, without touching any of them:
 *   - wake watchers holding a lock (<state dir>/wake-*.lock, the watcher's own pid; opencadre-wake.mjs takeLock),
 *   - MCP proxies that recorded a seat for their host (~/.opencadre/run/<client>-<hostPid>.json, `proxyPid`),
 *   - any process whose command line names this bin folder (proxies, hooks, watchers started from it).
 * A recorded pid counts only while that process is still the helper that recorded it (judgeRecordedPid).
 * Returns { consumers: [{ kind, pid, detail }], ignored: [{ kind, pid, detail }], caveats: [text] }: each `detail` says
 * why that consumer counts, or why a record was ignored ("stale lock ignored", pid 9720 "was reused by svchost.exe …").
 * A plugin loaded inside Kilo, Amp or OpenCode runs in that tool's own process and is found only by the third check if
 * at all: caveats say so. `table` stands in for the live process list in tests. */
export function liveConsumers({ home, bin, env = process.env, table = processTable } = {}) {
  const consumers = [];
  const ignored = [];
  const caveats = ["A plugin running inside Kilo, Amp or OpenCode is part of that tool's own process and may not be listed: close those tools too."];
  const procs = table();
  if (procs === null) caveats.push("The process list could not be read on this machine, so processes started from this folder were not checked, and no recorded pid could be confirmed: each running one is counted to be safe.");
  const seen = new Set();
  const add = (kind, pid, detail) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    consumers.push({ kind, pid, detail });
  };
  const judge = (kind, ignoredKind, file, record) => {
    const j = judgeRecordedPid(record, procs);
    if (j.verdict === "stale") ignored.push({ kind: ignoredKind, pid: record.pid, detail: `${j.why}; ${file}` });
    else add(kind, record.pid, `${j.verdict === "unknown" ? "UNVERIFIED, " : ""}${j.why}; ${file}`);
  };
  for (const dir of [...new Set([env.OPENCADRE_WAKE_STATE_DIR, join(home, ".opencadre")].filter(Boolean))]) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch { continue; }
    for (const f of names.filter((n) => /^wake-[0-9a-f]+\.lock$/.test(n))) {
      let owner;
      try {
        owner = JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch { continue; }
      if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 1) continue;
      // `startedAt` is when the watcher wrote the lock (every lock format has it); `procStart` is when the watcher's own
      // process started (newer watchers). A lock with neither is judged by the process alone.
      judge("wake watcher", "stale lock ignored", join(dir, f), { pid: owner.pid, helper: "opencadre-wake.mjs", bins: [bin], label: "wake watcher", writtenAt: Number(owner.startedAt) || null, procStart: Number(owner.procStart) || null });
    }
  }
  const run = join(home, ".opencadre", "run");
  let records = [];
  try {
    records = readdirSync(run).filter((n) => n.endsWith(".json"));
  } catch { /* none */ }
  for (const f of records) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(run, f), "utf8"));
    } catch { continue; }
    if (!Number.isSafeInteger(rec?.proxyPid) || rec.proxyPid <= 1) continue;
    // `at` is when the proxy wrote its record, after it started (opencadre-config.mjs writeHostHandoff).
    judge("MCP proxy", "stale proxy record ignored", join(run, f), { pid: rec.proxyPid, helper: "opencadre-mcp.mjs", bins: [bin], label: "MCP proxy", writtenAt: Date.parse(rec.at) || null });
  }
  if (procs !== null) {
    const needle = process.platform === "win32" ? bin.toLowerCase() : bin;
    for (const p of procs) {
      if (p.pid === process.pid || !p.line) continue;
      if ((process.platform === "win32" ? p.line.toLowerCase() : p.line).includes(needle)) add("process", p.pid, `${Number.isFinite(p.startedAt) ? `started ${when(p.startedAt)}, ` : ""}command ${redactCommandLine(p.line)}`);
    }
  }
  return { consumers, ignored, caveats };
}

// ---- state, for doctor (plan §C) -------------------------------------------------------------------------------------

/** The transitive import closure of `names` in `imports`, sorted. */
export function closureOf(names, imports) {
  const out = new Set();
  const visit = (n) => {
    if (out.has(n)) return;
    out.add(n);
    for (const d of imports?.[n] ?? []) visit(d);
  };
  for (const n of names) visit(n);
  return [...out].sort();
}

export const GATE_ENTRIES = ["opencadre-approval-gate.mjs", "opencadre-approval-gate-loader.mjs"];

/** Exactly one of "current" | "stale" | "partial" | "modified" | "missing" for the install in `bin`, with the reasons,
 * against `expected` (the hub manifest's { helpers, imports } when it could be read, else this CLI's build):
 *   partial   the pointer, the generation and the manifest disagree, a generation is incomplete, or an interrupted
 *             run left a staging folder or temp file behind (checked first: nothing else can be trusted then);
 *   stale     the active files are not the expected ones (including a legacy install, which has no generation);
 *   modified  an entry slot holds a file a normal upgrade refuses (edited, or of unknown provenance);
 *   current   none of the above.
 * Stale outranks modified: a local edit must not hide that the rest of the install is behind. `staleNames` and
 * `modifiedNames` carry both whatever the state, so a report can name each. `gate` lists the approval gate's closure:
 * each file's installed sha256 against the expected one. */
export function installState(bin, { target = cliBuild(), expected = null } = {}) {
  const want = expected ?? { helpers: target.helpers, imports: target.imports };
  const reasons = { partial: [], modified: [], stale: [] };
  if (!existsSync(bin)) return { state: "missing", reasons: [], gate: [], pointer: null };
  const manifest = readInstallManifest(bin);
  const pointer = readPointer(bin);
  const genExists = existsSync(genRoot(bin));
  const gens = genExists ? readdirSync(genRoot(bin)).filter((f) => ID.test(f)) : [];
  for (const f of [INSTALL_LOCK, ACQUIRE_GUARD]) if (existsSync(join(bin, f))) reasons.partial.push(`installer ownership remains at ${join(bin, f)}`);
  for (const f of leftovers(bin)) reasons.partial.push(`an interrupted upgrade left ${f} behind`);
  const plan = planInstall(bin, { target, pruneBackups: false });
  const stubs = plan.slots.filter((s) => isStub(s.disk));
  const legacy = plan.slots.some((s) => s.legacy);
  if (genExists || stubs.length) {
    if (pointer.problem) reasons.partial.push(`the generation pointer (${pointerFile(bin)}) is ${pointer.problem}`);
    else if (!existsSync(generationPath(bin, pointer.id))) reasons.partial.push(`the pointer names generation ${pointer.id}, which is not there`);
    else {
      const meta = (() => {
        try {
          return JSON.parse(readFileSync(join(generationPath(bin, pointer.id), GEN_META), "utf8"));
        } catch {
          return null;
        }
      })();
      const self = meta?.helpers ? verifyTree(generationPath(bin, pointer.id), meta.helpers, meta.imports) : ["its .generation.json is missing or unreadable"];
      for (const p of self) reasons.partial.push(`generation ${pointer.id}: ${p}`);
    }
    if (!manifest) reasons.partial.push("the install manifest is missing, so the last upgrade did not finish");
    else if (manifest.layout !== LAYOUT) reasons.partial.push("the install manifest predates generations while a generation exists, so a conversion did not finish");
    else if (pointer.id && manifest.generation !== pointer.id) reasons.partial.push(`the pointer names ${pointer.id} but the install manifest records ${manifest.generation}, so the last upgrade did not finish`);
    const activated = new Set([...(Array.isArray(manifest?.activated) ? manifest.activated : []), ...(pointer.id ? [pointer.id] : [])]);
    for (const g of gens) if (!activated.has(g)) reasons.partial.push(`generation ${g} was staged but never activated (an interrupted upgrade)`);
    for (const s of plan.slots) if (s.cls === "missing") reasons.partial.push(`the entry ${s.name} is missing`);
  }
  const modifiedNames = plan.slots.filter((s) => s.action === "refuse").map((s) => s.name);
  for (const s of plan.slots) if (s.action === "refuse") reasons.modified.push(`${s.name} (${s.cls === "edited" ? "edited on this machine" : "not a file OpenCadre installed"})`);
  const active = pointer.id && existsSync(generationPath(bin, pointer.id)) ? generationPath(bin, pointer.id) : null;
  const installedHash = (name) => {
    const text = active ? readText(fileIn(active, name)) : legacy ? readText(fileIn(bin, name)) : null;
    return text === null ? null : sha256(text);
  };
  if (!active && !legacy && !genExists && !stubs.length) return { state: "missing", reasons: [], allReasons: reasons, gate: [], pointer: null, generations: [], staleNames: [], modifiedNames: [], legacy: false };
  const staleNames = [];
  if (!active && legacy) reasons.stale.push("this install predates generations: its helpers are fixed files at the install root");
  for (const name of Object.keys(want.helpers).sort()) {
    const h = installedHash(name);
    if (h !== want.helpers[name] && (active || legacy)) {
      staleNames.push(name);
      reasons.stale.push(`${name} is not the expected revision`);
    }
  }
  for (const s of plan.slots) if (s.action === "write" && s.cls !== "missing" && isStub(s.disk)) reasons.stale.push(`the ${s.name} stub is an older form`);
  // A refused/custom/missing root entry is what the host invokes. Its expected dependency closure is at the root too,
  // not the unused generation copy. An edited stub also fails entry verification, even when its marker survives.
  const rootGateClosure = new Set(closureOf(GATE_ENTRIES.filter((name) => {
    const slot = plan.slots.find((s) => s.name === name);
    return active && (!slot || slot.action === "refuse" || !isStub(slot.disk));
  }), want.imports));
  const gate = closureOf(GATE_ENTRIES.filter((n) => n in want.helpers), want.imports).map((name) => {
    const root = rootGateClosure.has(name) ? readText(fileIn(bin, name)) : null;
    const installed = rootGateClosure.has(name) ? (root === null ? null : sha256(root)) : installedHash(name);
    return { name, installed, expected: want.helpers[name] ?? null, ok: installed !== null && installed === want.helpers[name] };
  });
  const state = reasons.partial.length ? "partial" : reasons.stale.length ? "stale" : reasons.modified.length ? "modified" : "current";
  return { state, reasons: reasons[state] ?? [], allReasons: reasons, gate, pointer: pointer.id, generations: gens, staleNames, modifiedNames, legacy: !active && legacy };
}
