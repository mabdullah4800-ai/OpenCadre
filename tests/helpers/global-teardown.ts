// Global setup/teardown: gives each test run its OWN temp directory, and deletes only that.
//
// Why this exists: 29 of the 30 test files that call mkdtempSync(path.join(tmpdir(), …)) never
// remove what they made. Every run leaked a directory per mkdtemp, across 78 prefixes; measured on
// 2026-09-18 that was 65,672 directories and ~2.4 GB under %TEMP%, which filled C:.
//
// THE DESIGN. setup() creates one directory per run under the ORIGINAL temp root,
// `oc-vitest-run-<pid>-<random>` (mkdtempSync), and points TEMP, TMP and TMPDIR at it before the
// worker pool starts. From then on os.tmpdir() -- in the workers and in every child process a test
// spawns -- resolves inside the run dir, so whatever a test leaks lands there, under any name.
// Teardown removes that one directory, then collects STALE run dirs left by runs that were killed
// before their own teardown could run.
//
// HOW THE ENV REACHES THE WORKERS (vitest 4.1, default `forks` pool). vitest builds each worker's
// env when it schedules the files, as `{ ...process.env, ...test.env, ... }`, and that happens AFTER
// globalSetup has run in the main process. So assigning process.env here is enough; no `test.env`
// entry or pool option is needed. tests/temp-run-dir.test.ts asserts it in a worker and in a spawned
// child, so a vitest upgrade that reorders this fails by name instead of silently sharing a root.
// All three variables, because each platform reads a different one: win32 os.tmpdir() is
// TEMP || TMP (TMPDIR is never consulted); POSIX is TMPDIR || TMP || TEMP.
//
// WHY THERE IS NO "SWEEP EVERYTHING NEW UNDER tmpdir()" ANY MORE. The previous version snapshotted
// the temp root's children at setup and, at teardown, recursively deleted every directory that had
// appeared since. Its header called that "safe while other agents share this machine". It was not: a
// listing cannot tell this run's directories from a CONCURRENT run's, so whichever run finished
// first deleted the other's live directories. On 2026-10-31 two suite runs sharing one TEMP root did
// exactly that -- one run's teardown removed the other's vitest SSR cache (<tmp>\<nanoid>\ssr\…) and
// its test temp dirs mid-run: 361 of 457 files failed in one run ("0 tests", ENOENT on the ssr path),
// 26 in another. Ownership is now structural -- one directory per run, named for it -- and nothing
// outside the run-dir prefix is ever removed. (vitest's own <tmp>\<nanoid> cache is created before
// globalSetup, in the original root, and vitest removes it itself on close; this file leaves it be.)
//
// Earlier bugs, kept short so nobody reintroduces them:
//   - An mtime cutoff with a grace window deleted a control dir planted one second BEFORE the run: a
//     window widens the set it means to narrow. Staleness here is a 24 h floor on names this file
//     itself creates, plus a dead pid; never a window around "now".
//   - A failed listing was once encoded as a Set holding one impossible name (with a raw NUL), so a
//     later successful listing matched nothing and EVERYTHING was swept. "Unknown" must never mean
//     "delete": every failure path below deletes nothing.
//
// The guards, since this deletes recursively:
//   - Nothing whose name does not match RUN_DIR_PATTERN is ever removed, and only direct children of
//     the root this run started with.
//   - Symlinks and junctions are never followed or removed (lstat, not stat).
//   - A stale run dir whose pid is still alive is kept (EPERM counts as alive), so a long run is
//     never collected by a neighbour, whatever its age. Known limit: a run in a different PID
//     namespace (WSL, a container) sharing this temp root looks dead from here, so after 24 h its
//     live run dir could be collected.
//   - If the run dir cannot be created, TEMP is left as it was and teardown deletes nothing.
//   - Every removal is individually try/caught: on Windows a file still held open fails to delete and
//     is skipped (and collected later as stale); cleanup never fails a run.
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const RUN_DIR_PREFIX = "oc-vitest-run-";
/** `oc-vitest-run-<pid>-<mkdtemp suffix>`; the pid is captured for the liveness check. */
export const RUN_DIR_PATTERN = /^oc-vitest-run-(\d+)-[A-Za-z0-9]+$/;
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const TEMP_VARS = ["TEMP", "TMP", "TMPDIR"] as const;

/** True when `pid` names a live process. EPERM means it exists but is not ours: alive. Only ESRCH
 * reads as dead -- any other failure is "unknown", and unknown must never mean "delete". */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Creates this run's directory under `root`, or returns null if it cannot. */
export function createRunDir(root: string): string | null {
  try {
    return mkdtempSync(join(root, `${RUN_DIR_PREFIX}${process.pid}-`));
  } catch {
    return null;
  }
}

/** Removes `dir` recursively only if it is a real directory (not a link) that is a direct child of
 * `root` with a run-dir name. "skipped" means a guard refused; "failed" means rm threw. */
export function removeRunDir(root: string, dir: string): "removed" | "failed" | "skipped" {
  if (resolve(dirname(dir)) !== resolve(root) || !RUN_DIR_PATTERN.test(basename(dir))) return "skipped";
  try {
    if (!lstatSync(dir).isDirectory()) return "skipped"; // a symlink or junction reports false here
  } catch {
    return "skipped"; // already gone, or unreadable: nothing to do
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return "removed";
  } catch {
    return "failed";
  }
}

export interface SweepOptions {
  now?: number;
  staleAfterMs?: number;
  isAlive?: (pid: number) => boolean;
  /** A run-dir name to leave alone: the current run's. */
  except?: string;
}

/** Removes `oc-vitest-run-*` direct children of `root` whose newer of mtime/birthtime is more than
 * `staleAfterMs` old AND whose pid is dead. Everything else is kept, at any age. */
export function sweepStaleRunDirs(root: string, opts: SweepOptions = {}): { removed: number; failed: number } {
  const now = opts.now ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;
  const isAlive = opts.isAlive ?? isPidAlive;
  let removed = 0;
  let failed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { removed, failed }; // unlistable root: unknown, so delete nothing
  }
  for (const name of names) {
    if (name === opts.except) continue;
    const match = RUN_DIR_PATTERN.exec(name);
    if (!match) continue; // not a run dir: never ours to judge, at any age
    const full = join(root, name);
    let age: number;
    try {
      const st = lstatSync(full);
      if (!st.isDirectory()) continue; // symlink, junction or file: never followed, never removed
      age = now - Math.max(st.mtimeMs, st.birthtimeMs);
    } catch {
      continue;
    }
    if (!(age > staleAfterMs)) continue; // fresh, or an unreadable time: keep
    if (isAlive(Number(match[1]))) continue; // its run may still be going: keep
    const outcome = removeRunDir(root, full);
    if (outcome === "removed") removed++;
    else if (outcome === "failed") failed++;
  }
  return { removed, failed };
}

export interface RunOptions {
  /** The temp root to create the run dir under. Defaults to os.tmpdir() at setup time. */
  root?: string;
  /** The environment to point at the run dir. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Creates the run dir; injectable so a test can simulate failure. Defaults to createRunDir. */
  create?: (root: string) => string | null;
  sweep?: Omit<SweepOptions, "except">;
  log?: (line: string) => void;
}

/** Creates the run dir and points the temp variables at it; returns the dir and the teardown.
 * Exported so tests can drive it with an injected root and env instead of the real process's. */
export function setupRun(opts: RunOptions = {}): { runDir: string | null; teardown: () => void } {
  const root = opts.root ?? tmpdir();
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const runDir = (opts.create ?? createRunDir)(root);
  if (runDir === null) {
    log(`[temp-teardown] could not create a run dir under ${root}; TEMP left unchanged, nothing will be swept`);
    return { runDir, teardown: () => {} };
  }
  const saved = TEMP_VARS.map((name) => [name, env[name]] as const);
  for (const name of TEMP_VARS) env[name] = runDir;
  return {
    runDir,
    teardown: () => {
      // Restore first, so nothing that runs after this resolves tmpdir() into a deleted directory.
      for (const [name, value] of saved) {
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
      const own = removeRunDir(root, runDir);
      const stale = sweepStaleRunDirs(root, { ...opts.sweep, except: basename(runDir) });
      const parts: string[] = [];
      if (own === "failed") parts.push("this run's temp dir is still in use (collected once stale)");
      if (stale.removed > 0) parts.push(`removed ${stale.removed} stale run dir(s)`);
      if (stale.failed > 0) parts.push(`${stale.failed} stale run dir(s) still in use`);
      if (parts.length > 0) log(`[temp-teardown] ${parts.join("; ")}`);
    },
  };
}

export default function setup() {
  return setupRun().teardown;
}
