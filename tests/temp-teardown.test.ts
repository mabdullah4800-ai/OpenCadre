// The global setup gives each run its own temp dir, and the teardown deletes only that.
//
// The defect this replaced (tests/helpers/global-teardown.ts header): teardown deleted every
// directory that had appeared under tmpdir() since setup, so when two runs shared a temp root, the
// first to finish deleted the other's live directories. On 2026-10-31 that failed 361 of 457 files in
// one run. The overlap test below is the regression guard for exactly that.
//
// TWO PROCESSES, not two setupRun() calls in one process, for the overlap case: the run dir is keyed
// by pid, and an in-process pair would share one. The driver imports the REAL global-teardown.ts.
//
// PRIVATE ROOT, ALWAYS, with all three of TEMP/TMP/TMPDIR set: win32 os.tmpdir() reads TEMP || TMP
// and never TMPDIR; POSIX reads TMPDIR first. Setting two is a silent no-op on one platform.
//
// The rest drives the exported functions in-process with an injected root and env, so they never
// touch this worker's real process.env or the shared temp root.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUN_DIR_PREFIX,
  isPidAlive,
  removeRunDir,
  setupRun,
  sweepStaleRunDirs,
} from "./helpers/global-teardown.js";
import { SPAWN_TEST_TIMEOUT_MS, waitFor } from "./helpers/spawn.js";
import { tmpDir } from "./helpers/tmp.js";

const DRIVER = fileURLToPath(new URL("./helpers/temp-teardown-driver.mjs", import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
const LATER = () => Date.now() + 2 * DAY_MS; // "now" as seen by a sweep two days from now
const dead = () => false;
const silent = () => {};
// Plain fs work, but each call took up to 2 s on this box under a loaded fleet (one test hit vitest's 5 s
// default with nothing wrong), so these get the same allowance as a spawning test.
const FS = { timeout: SPAWN_TEST_TIMEOUT_MS };

/** Starts one scripted "run" as a real child process with `root` as its temp root. */
function startRun(run: string, root: string, coord: string) {
  const child = spawn(process.execPath, [DRIVER, `--run=${run}`, `--root=${root}`, `--coord=${coord}`], {
    env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (chunk) => { err += String(chunk); });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exited, stderr: () => err };
}

const read = (coord: string, run: string, name: string) => readFileSync(join(coord, `${run}-${name}`), "utf8");

/** The child's own record that it started against the private root and got a run dir inside it. */
function expectIsolated(run: string, coord: string, root: string): string {
  expect(read(coord, run, "root.txt"), `run ${run} must start with tmpdir() = the private root`).toBe(root);
  const runDir = read(coord, run, "rundir.txt");
  const pid = read(coord, run, "pid.txt");
  expect(runDir.startsWith(join(root, `${RUN_DIR_PREFIX}${pid}-`)), `run ${run}'s tmpdir() after setup: ${runDir}`).toBe(true);
  return runDir;
}

async function finish(run: ReturnType<typeof startRun>, coord: string, name: string) {
  writeFileSync(join(coord, `${name}-release`), "");
  const code = await run.exited;
  expect({ code, stderr: run.stderr() }, `run ${name} must run to completion`).toEqual({ code: 0, stderr: "" });
}

describe("two overlapping runs sharing one temp root", () => {
  it(
    "(a) one run's teardown leaves the other's run dir and contents intact; (b) each removes its own",
    async () => {
      const root = tmpDir("oc-td-root-");
      const coord = tmpDir("oc-td-coord-");
      const a = startRun("a", root, coord);
      let b: ReturnType<typeof startRun> | undefined;
      try {
        await waitFor(() => existsSync(join(coord, "a-ready")), "run a to set up");
        const aDir = expectIsolated("a", coord, root);

        b = startRun("b", root, coord);
        await waitFor(() => existsSync(join(coord, "b-ready")), "run b to set up");
        const bDir = expectIsolated("b", coord, root);
        expect(bDir).not.toBe(aDir);

        // b finishes while a is still running: the 2026-10-31 shape.
        await finish(b, coord, "b");
        expect({
          aRunDir: existsSync(aDir),
          aLiveFile: existsSync(join(aDir, "work", "nested", "live.txt")),
          aSsrCache: existsSync(join(root, "a-ssr-cache", "ssr")),
          bRunDir: existsSync(bDir),
        }).toEqual({ aRunDir: true, aLiveFile: true, aSsrCache: true, bRunDir: false });
        expect(read(coord, "b", "after.txt"), "teardown restores TEMP").toBe(root);

        await finish(a, coord, "a");
        expect(existsSync(aDir), "a's teardown removes a's own run dir").toBe(false);
        // Only the non-run-dir entries remain: neither run deleted anything outside its own dir.
        expect(readdirSync(root).sort()).toEqual(["a-ssr-cache", "b-ssr-cache"]);
      } finally {
        a.child.kill();
        b?.child.kill();
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("setupRun", FS, () => {
  it("(b) points TEMP/TMP/TMPDIR at a fresh run dir, then removes it and restores the env", () => {
    const root = tmpDir("oc-td-own-");
    const env: NodeJS.ProcessEnv = { TEMP: "orig-temp", OTHER: "x" };
    const { runDir, teardown } = setupRun({ root, env, log: silent });
    expect(runDir).not.toBeNull();
    expect(basename(runDir!)).toMatch(new RegExp(`^${RUN_DIR_PREFIX}${process.pid}-[A-Za-z0-9]+$`));
    expect(env).toEqual({ TEMP: runDir, TMP: runDir, TMPDIR: runDir, OTHER: "x" });
    mkdirSync(join(runDir!, "leaked", "deep"), { recursive: true });
    writeFileSync(join(runDir!, "leaked", "deep", "f.txt"), "x");

    teardown();
    expect(existsSync(runDir!)).toBe(false);
    expect(env).toEqual({ TEMP: "orig-temp", OTHER: "x" });
  });

  it("(c) its teardown also collects a stale dead run dir, and keeps everything else", () => {
    const root = tmpDir("oc-td-own-sweep-");
    mkdirSync(join(root, `${RUN_DIR_PREFIX}111-aaaaaa`, "x"), { recursive: true });
    mkdirSync(join(root, "unrelated"));
    const { teardown } = setupRun({ root, env: {}, log: silent, sweep: { now: LATER(), isAlive: dead } });
    teardown();
    expect(readdirSync(root)).toEqual(["unrelated"]);
  });

  it("(e) when the run dir cannot be created, TEMP is unchanged and teardown deletes nothing", () => {
    const root = tmpDir("oc-td-nocreate-");
    const stale = join(root, `${RUN_DIR_PREFIX}111-aaaaaa`);
    mkdirSync(stale);
    const env: NodeJS.ProcessEnv = { TEMP: "orig" };
    const lines: string[] = [];
    const { runDir, teardown } = setupRun({
      root,
      env,
      create: () => null,
      log: (l) => lines.push(l),
      sweep: { now: LATER(), isAlive: dead },
    });
    expect(runDir).toBeNull();
    expect(env).toEqual({ TEMP: "orig" });
    teardown();
    expect(existsSync(stale), "a stale run dir that WOULD be swept is left alone").toBe(true);
    expect(env).toEqual({ TEMP: "orig" });
    expect(lines.join("\n")).toMatch(/could not create a run dir/);
  });

  it("(e) a real creation failure (the root is a file) behaves the same", () => {
    const parent = tmpDir("oc-td-fileroot-");
    const root = join(parent, "not-a-dir");
    writeFileSync(root, "");
    const env: NodeJS.ProcessEnv = {};
    const { runDir, teardown } = setupRun({ root, env, log: silent });
    expect(runDir).toBeNull();
    expect(env).toEqual({});
    expect(() => teardown()).not.toThrow();
  });
});

describe("sweepStaleRunDirs", FS, () => {
  it("(c) removes only run dirs that are both older than 24 h and dead", () => {
    const root = tmpDir("oc-td-stale-");
    const names = {
      staleDead: `${RUN_DIR_PREFIX}111-aaaaaa`,
      staleLive: `${RUN_DIR_PREFIX}222-bbbbbb`,
      notOurs: "oc-vitest-runner-old",
      badPid: `${RUN_DIR_PREFIX}xyz-cccccc`,
      other: "someone-elses",
    };
    for (const n of Object.values(names)) mkdirSync(join(root, n, "inner"), { recursive: true });
    const isAlive = (pid: number) => pid === 222;

    // Fresh: nothing is removed, dead pid or not.
    expect(sweepStaleRunDirs(root, { isAlive })).toEqual({ removed: 0, failed: 0 });
    expect(readdirSync(root).sort()).toEqual(Object.values(names).sort());

    // Two days on: only the dead, matching one goes. A non-matching dir is kept at any age.
    expect(sweepStaleRunDirs(root, { now: LATER(), isAlive })).toEqual({ removed: 1, failed: 0 });
    expect(readdirSync(root).sort()).toEqual([names.staleLive, names.notOurs, names.badPid, names.other].sort());
  });

  it("(c) leaves the excepted name (the current run's) alone", () => {
    const root = tmpDir("oc-td-except-");
    const own = `${RUN_DIR_PREFIX}333-dddddd`;
    mkdirSync(join(root, own));
    expect(sweepStaleRunDirs(root, { now: LATER(), isAlive: dead, except: own })).toEqual({ removed: 0, failed: 0 });
    expect(existsSync(join(root, own))).toBe(true);
  });

  it("(c) judges age by the NEWER of mtime and birthtime", (ctx) => {
    const root = tmpDir("oc-td-age-");
    const dir = join(root, `${RUN_DIR_PREFIX}444-eeeeee`);
    mkdirSync(dir);
    if (!(lstatSync(dir).birthtimeMs > 0)) ctx.skip(); // no birthtime on this filesystem
    const old = new Date(Date.now() - 3 * DAY_MS);
    utimesSync(dir, old, old); // mtime says stale; birthtime (now) says fresh
    expect(sweepStaleRunDirs(root, { isAlive: dead })).toEqual({ removed: 0, failed: 0 });
    expect(existsSync(dir)).toBe(true);
  });

  it("(d) never follows or removes a symlink/junction named like a run dir", () => {
    const root = tmpDir("oc-td-link-");
    const target = tmpDir("oc-td-link-target-");
    writeFileSync(join(target, "precious.txt"), "keep");
    const link = join(root, `${RUN_DIR_PREFIX}555-ffffff`);
    symlinkSync(target, link, "junction"); // junction: no symlink privilege needed on Windows
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    expect(sweepStaleRunDirs(root, { now: LATER(), isAlive: dead })).toEqual({ removed: 0, failed: 0 });
    expect(removeRunDir(root, link)).toBe("skipped");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, "precious.txt"), "utf8")).toBe("keep");
  });

  it("(d) a junction/symlink INSIDE a run dir is unlinked, not followed, when the run dir is removed", () => {
    const root = tmpDir("oc-td-nested-");
    const target = tmpDir("oc-td-nested-target-");
    writeFileSync(join(target, "sentinel.txt"), "keep");
    const { runDir, teardown } = setupRun({ root, env: {}, log: silent });
    expect(runDir).not.toBeNull();
    const link = join(runDir!, "deep", "link");
    mkdirSync(join(runDir!, "deep"));
    // A junction on Windows (no symlink privilege needed); a plain directory symlink elsewhere.
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    teardown();
    expect(existsSync(runDir!), "the run dir itself is removed").toBe(false);
    expect(readFileSync(join(target, "sentinel.txt"), "utf8"), "the link's target is untouched").toBe("keep");
  });

  it("an unlistable root deletes nothing and does not throw", () => {
    const root = join(tmpDir("oc-td-missing-"), "nope");
    expect(sweepStaleRunDirs(root, { now: LATER(), isAlive: dead })).toEqual({ removed: 0, failed: 0 });
  });
});

describe("removeRunDir guards", FS, () => {
  it("refuses a non-run-dir name and a path that is not a direct child of the root", () => {
    const root = tmpDir("oc-td-guard-");
    mkdirSync(join(root, "keep-me"));
    mkdirSync(join(root, "sub", `${RUN_DIR_PREFIX}1-aaaaaa`), { recursive: true });
    expect(removeRunDir(root, join(root, "keep-me"))).toBe("skipped");
    expect(removeRunDir(root, join(root, "sub", `${RUN_DIR_PREFIX}1-aaaaaa`))).toBe("skipped");
    expect(existsSync(join(root, "keep-me"))).toBe(true);
    expect(existsSync(join(root, "sub", `${RUN_DIR_PREFIX}1-aaaaaa`))).toBe(true);
  });
});

describe("isPidAlive", FS, () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("is true for this process and false for an exited child", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    const child = spawnSync(process.execPath, ["-e", ""]);
    expect(child.pid).toBeGreaterThan(0);
    expect(isPidAlive(child.pid!)).toBe(false);
  });

  it("reads EPERM (exists, not ours) as alive, and only ESRCH as dead", () => {
    const fail = (code: string) => vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    fail("EPERM");
    expect(isPidAlive(12345)).toBe(true);
    vi.restoreAllMocks();
    fail("ESRCH");
    expect(isPidAlive(12345)).toBe(false);
  });
});
