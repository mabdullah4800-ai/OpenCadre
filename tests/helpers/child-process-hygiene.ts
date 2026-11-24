// A vitest setup file (vitest.config.ts `setupFiles`): every child process a test file starts from its worker is
//  1. started with `windowsHide: true`, so an unattended run (a worker with no console of its own, as when an agent
//     runs the suite) does not open a console window per child on Windows. An explicit `windowsHide` is kept; and
//  2. reaped when the file ends, pass, fail or timeout: any child it started that is still running is killed through
//     the ChildProcess handle the worker holds, never by a bare pid looked up later. It covers tracked direct children
//     and their trees only while the worker still holds those handles, and a child it cannot end fails that file's
//     afterAll, naming the child. Cleanup after a crashed or force-terminated worker is best effort (see registry()).
//
// It patches node:child_process once per worker, so the ~200 spawn sites across tests/** need no per-site option and a
// new test cannot forget it. It reaches only processes started from the worker: a script a test runs as a child (an
// embedded `node -e` owner, a fixture .mjs) must pass `windowsHide` itself, as tests/wake-owner.test.ts and
// tests/helpers/fake-qwen-host.mjs do.
import cp, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { afterAll } from "vitest";
import { SPAWNERS, type Spawner, withWindowsHide } from "./windows-hide.js";

/** Set on each wrapped function, so a test can tell the patch is in force and a second load does not wrap twice. */
export const HIDE_MARK = Symbol.for("opencadre.tests.windowsHide");

type Registry = { owned: Set<ChildProcess>; original: Record<Spawner, (...a: unknown[]) => unknown> };
// On globalThis rather than in this module: vitest evaluates a setup file again for each test file a worker runs, but
// the builtin it patches, and the children it starts, belong to the worker.
const REGISTRY = Symbol.for("opencadre.tests.childProcessRegistry");
const g = globalThis as unknown as Record<symbol, Registry | undefined>;

/** Children this worker started and has not yet seen exit. */
function registry(): Registry {
  if (!g[REGISTRY]) {
    const created: Registry = { owned: new Set(), original: {} as Registry["original"] };
    g[REGISTRY] = created;
    // Best effort for a worker that exits without running afterAll: an orderly exit kills the children it still holds
    // handles for. No exit handler runs after a forced termination or a hard crash, so those children are not covered.
    process.once("exit", () => {
      for (const c of created.owned) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    });
  }
  return g[REGISTRY];
}

function track(child: unknown): void {
  if (!child || typeof (child as ChildProcess).once !== "function") return;
  const c = child as ChildProcess;
  if (c.exitCode !== null || c.signalCode !== null) return;
  const { owned } = registry();
  owned.add(c);
  c.once("exit", () => owned.delete(c));
}

function install(): void {
  const mod = cp as unknown as Record<string, ((...a: unknown[]) => unknown) & Record<PropertyKey, unknown>>;
  const { original } = registry();
  for (const name of SPAWNERS) {
    const fn = mod[name];
    if (fn[HIDE_MARK]) continue;
    original[name] = fn;
    const wrapped = Object.assign(function (this: unknown, ...args: unknown[]) {
      const result = fn.apply(this, withWindowsHide(name, args));
      track(result);
      return result;
    }, { [HIDE_MARK]: true });
    // exec/execFile carry a custom promisify that calls the unwrapped function: rebuild it on top of the rewrite, so
    // `promisify(execFile)` still resolves { stdout, stderr } and its child is hidden and tracked too.
    const custom = fn[promisify.custom as unknown as string] as ((...a: unknown[]) => Promise<unknown> & { child?: unknown }) | undefined;
    if (typeof custom === "function") {
      Object.defineProperty(wrapped, promisify.custom, {
        value: (...args: unknown[]) => {
          const p = custom(...withWindowsHide(name, args));
          track(p.child);
          return p;
        },
      });
    }
    mod[name] = wrapped as typeof fn;
  }
  // ESM `import { spawn } from "node:child_process"` reads the builtin's ESM exports, which only follow the CommonJS
  // object after this call.
  syncBuiltinESMExports();
}

/** Kill every child this worker started that is still running, and wait for each to exit. On Windows the kill is
 * `taskkill /T` of that child's own pid, issued while the worker still holds the child's process handle (so the pid
 * cannot have been reused) and covering only that child's tree; elsewhere it is the handle's own kill.
 *
 * Resolves with the number of children it reaped. Throws when any child has still not exited after `waitMs`, naming
 * each one's pid, command and what its kills returned, so a cleanup that failed fails the file's afterAll rather than
 * passing silently. A refused kill is not by itself a failure: the child may already be exiting, which the wait sees. */
export async function reapOwnedChildren(waitMs = 10_000): Promise<number> {
  const { owned, original } = registry();
  const live = [...owned].filter(running);
  const survivors = (await Promise.all(live.map((c) => reapOne(c, original, waitMs)))).filter((s): s is string => s !== null);
  if (survivors.length > 0) {
    throw new Error(`child-process hygiene: ${survivors.length} owned child process(es) still running ${waitMs} ms after `
      + `the reap, so this file's cleanup failed:\n${survivors.join("\n")}`);
  }
  return live.length;
}

const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

/** Kill one owned child and wait up to `waitMs` for its exit: null once it has exited, else a line describing it. */
function reapOne(c: ChildProcess, original: Registry["original"], waitMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (!running(c)) return resolve(null);
    let taskkill = "not run";
    let kill = "not run";
    const onExit = () => { clearTimeout(timer); resolve(null); };
    const timer = setTimeout(() => {
      c.off("exit", onExit);
      if (!running(c)) return resolve(null);
      const command = c.spawnargs.join(" ");
      resolve(`  pid ${c.pid}: ${command.length > 300 ? command.slice(0, 300) + "..." : command} `
        + `(taskkill: ${taskkill}; kill(): ${kill})`);
    }, waitMs);
    c.once("exit", onExit);
    if (process.platform === "win32" && c.pid) {
      try {
        const r = original.spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5_000 }) as
          { status: number | null; error?: Error };
        taskkill = r.error ? `failed: ${r.error.message}` : `exit ${r.status}`;
      } catch (e) {
        taskkill = `threw: ${(e as Error).message}`;
      }
    }
    if (running(c)) kill = c.kill("SIGKILL") ? "sent" : "refused";
  });
}

install();
afterAll(() => reapOwnedChildren(), 30_000);
