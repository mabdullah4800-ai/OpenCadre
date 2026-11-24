import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findLocks, lockRoots } from "../scripts/reasonix-lock-doctor.mjs";

/** A lock file under the same one-directory-per-family layout the harness uses
 * (~/.reasonix/locks/config-edits-<hash>/*.lock), back-dated by `ageMinutes`. */
function plantLock(root: string, name: string, ageMinutes: number): string {
  const dir = path.join(root, "config-edits-abc123");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "");
  const when = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(file, when, when);
  return file;
}

describe("reasonix lock doctor", () => {
  it("flags a lock untouched for longer than the bar as orphaned", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lockdoctor-"));
    plantLock(root, "old.lock", 120);

    const locks = findLocks([root], Date.now());

    expect(locks).toHaveLength(1);
    expect(locks[0].orphaned).toBe(true);
    expect(locks[0].ageMinutes).toBeGreaterThan(100);
  });

  it("does NOT flag a freshly touched lock -- its owner may still be alive", () => {
    // This is the case that matters more than the positive one: clearing a live
    // lock would let two writers into the same workspace, which is worse than
    // the stalled queue this tool exists to clear.
    const root = mkdtempSync(path.join(tmpdir(), "lockdoctor-"));
    plantLock(root, "fresh.lock", 0);

    const locks = findLocks([root], Date.now());

    expect(locks).toHaveLength(1);
    expect(locks[0].orphaned).toBe(false);
  });

  it("treats a missing lock root as empty rather than throwing", () => {
    // Not every host has every lock family, and REASONIX_HOME may point at a
    // config directory that has never taken a lock.
    const missing = path.join(tmpdir(), `lockdoctor-absent-${Date.now()}`);

    expect(findLocks([missing], Date.now())).toEqual([]);
  });

  it("reports the oldest lock first, so the likeliest orphan leads", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lockdoctor-"));
    plantLock(root, "newer.lock", 40);
    plantLock(root, "oldest.lock", 240);

    const locks = findLocks([root], Date.now());

    expect(locks.map((l) => l.ageMinutes)).toEqual([...locks.map((l) => l.ageMinutes)].sort((a, b) => b - a));
    expect(locks[0].ageMinutes).toBeGreaterThan(locks[1].ageMinutes);
  });

  it("honours the bar: a lock inside it is live, the same lock outside it is orphaned", () => {
    // The classifier is a pure function of age vs the bar, so the same file must
    // flip classification with no other change. This is what makes the rule
    // auditable rather than a magic number buried at a call site.
    const root = mkdtempSync(path.join(tmpdir(), "lockdoctor-"));
    const file = plantLock(root, "borderline.lock", 45);
    const now = Date.now();

    expect(findLocks([root], now)[0].orphaned).toBe(true);

    const older = new Date(now - 5 * 60_000);
    utimesSync(file, older, older);
    expect(findLocks([root], now)[0].orphaned).toBe(false);
  });

  it("resolves lock roots from REASONIX_HOME so one definition does not drift into two", () => {
    const home = path.join(tmpdir(), "lockdoctor-home");
    const roots = lockRoots(home, { REASONIX_HOME: path.join(home, "custom-reasonix") } as NodeJS.ProcessEnv);

    expect(roots).toContain(path.join(home, ".reasonix", "locks"));
    expect(roots.some((r) => r.includes("custom-reasonix"))).toBe(true);
  });

  it("--json emits JSON and NOTHING else, even when orphans exist", async () => {
    // Pins the defect that made the session-start notice silently never fire: the human
    // "Re-run with --apply" hint was printed AFTER the JSON, so JSON.parse() threw in the
    // consumer and the caller got nothing. A machine-readable mode that appends prose is worse
    // than having none, because it fails quietly at the far end of a subprocess boundary -- and
    // the hook that consumes this is exactly such a boundary.
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const home = mkdtempSync(path.join(tmpdir(), "lockdoctor-home-"));
    const dir = path.join(home, "repair-mutation-locks");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "old.lock");
    writeFileSync(file, "");
    const when = new Date(Date.now() - 120 * 60_000);
    utimesSync(file, when, when);

    const out = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/reasonix-lock-doctor.mjs", import.meta.url)), "--json"],
      { env: { ...process.env, REASONIX_HOME: home }, encoding: "utf8" },
    );

    const report = JSON.parse(out); // throws if even one non-JSON line slipped into stdout
    expect(report.orphans).toBeGreaterThanOrEqual(1);
    expect(report.locks.some((lock: { path: string }) => lock.path === file)).toBe(true);
  });

  it("keeps the --apply hint in the HUMAN report, so fixing --json did not lose it", async () => {
    // The fix for the test above MOVED the hint into the human branch. This pins that it landed
    // somewhere rather than nowhere: a machine-readable mode still needs an answer for a human who
    // does not yet know a lock is holding their workspace.
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const home = mkdtempSync(path.join(tmpdir(), "lockdoctor-home-"));
    const dir = path.join(home, "repair-mutation-locks");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "old.lock");
    writeFileSync(file, "");
    const when = new Date(Date.now() - 120 * 60_000);
    utimesSync(file, when, when);

    const out = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/reasonix-lock-doctor.mjs", import.meta.url))],
      { env: { ...process.env, REASONIX_HOME: home }, encoding: "utf8" },
    );

    expect(out).toContain("ORPHAN");
    expect(out).toContain("--apply");
  });

  it("--sweep clears an orphan and RETURNS 0, and leaves a fresh lock alone", async () => {
    // The automated mode. Two properties matter more than the deletion itself:
    //   1. exit 0 ALWAYS. A pre-tool hook that exits non-zero can be read as a DENIAL of the call
    //      it precedes, so a maintenance sweep that reports failure would block the very tool use
    //      it was clearing the way for. The orphan must go AND the code must still be 0.
    //   2. a fresh lock SURVIVES the same run. Clearing a lock whose owner may still be writing
    //      would put two writers in one workspace, which is worse than the stalled queue this
    //      exists to clear. Sweeping is only safe if it respects the bar it was given.
    // Both are asserted from ONE invocation, because that is how a real sweep runs: it sees a
    // mixture, and it must take exactly the right subset.
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const home = mkdtempSync(path.join(tmpdir(), "lockdoctor-sweep-"));
    const dir = path.join(home, "repair-mutation-locks");
    mkdirSync(dir, { recursive: true });
    const orphan = path.join(dir, "old.lock");
    const live = path.join(dir, "fresh.lock");
    for (const file of [orphan, live]) writeFileSync(file, "");
    const when = new Date(Date.now() - 20 * 60_000);
    utimesSync(orphan, when, when);
    // `live` keeps its write-time mtime: 0 minutes old, inside any sane bar.

    // stdout must stay EMPTY under --sweep: it is the channel a hook's consumer reads, and a
    // sweep that merely succeeded is not something to print there. stderr is where the record goes.
    const run = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/reasonix-lock-doctor.mjs", import.meta.url)), "--sweep", "--age", "10"],
      { env: { ...process.env, REASONIX_HOME: home }, encoding: "utf8" },
    );

    expect(run.status).toBe(0); // exit 0 ALWAYS, even though it removed something
    expect(run.stdout).toBe(""); // nothing on the channel a consumer parses
    expect(run.stderr).toContain("cleared ORPHANED lock"); // the removal is recorded where it is safe
    expect(run.stderr).toContain(orphan);
    expect(existsSync(orphan)).toBe(false); // the orphan is gone
    expect(existsSync(live)).toBe(true); // and the fresh lock is untouched by the same run
  });
});
