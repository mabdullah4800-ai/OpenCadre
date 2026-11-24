// The two pragmas a THROWAWAY SQLite database wants, in one place so every test that creates one
// gets them instead of the four sites that happened to be written without them.
//
// WHY THIS EXISTS. TEMP on this box is B:, the external Seagate, and SQLite fsyncs per transaction
// there. tests/deploy-survival-check.test.ts:47-55 measured it: seeding one fixture took 10.3
// SECONDS on B: versus 564 ms on the internal SSD, which blew vitest's 10 s hookTimeout and made the
// whole file report as a failed suite with 12 skipped tests -- a slow disk reading as a broken test.
// These pragmas make it 3 ms.
//
// That file has carried the warning since it was written ("any test in this repo that creates a
// SQLite database in TEMP pays the same 20x on B:") and defines FAST_PRAGMAS to fix it -- but only
// for itself. The constant was never shared, so the sites that needed it most never got it. This
// file is that constant, moved somewhere the next test can find it.
//
// MEASURED, not assumed. tests/project-stamping.test.ts's workspaceDb() is a file-backed db in
// tmpdir() with no pragma anywhere in the file. Paired control/probe runs, one statement apart,
// interleaved so box-load drift cancels, file alone, serial, durations read from `--reporter=json`:
//
//   run  control (as written)     probe (+ FAST_PRAGMAS)
//   1    FAIL  5690.7898 ms       PASS  25.6029 ms
//   2    FAIL  6338.0344 ms       PASS  27.4487 ms
//   3    FAIL  8900.8902 ms       PASS  25.1149 ms
//   4    FAIL  8497.8985 ms       PASS  26.3666 ms
//
// 4/4, ~220-340x. The control failures are all "Test timed out in 5000ms", which is vitest's
// UNCHOSEN default -- the repo's vitest.config.ts set no testTimeout at d63f08f, so the deadline was
// never a decision any more than the missing pragma was.
//
// WHAT THESE COST. Nothing that matters here. The databases this is used with are created per test,
// live in tmpdir(), and are deleted with the run; durability is irrelevant, so trading it for speed
// is free. `journal_mode = MEMORY` keeps the rollback journal in RAM rather than a file, and
// `synchronous = OFF` skips the fsync on commit. Neither changes SQLite's LOCKING protocol -- the
// RESERVED/PENDING/EXCLUSIVE sequence is identical to the default DELETE journal mode, and only WAL
// changes concurrency semantics -- so tests that race two connections on one file still race.
// tests/migrations.test.ts's "applies a migration exactly once when two processes migrate the same
// file concurrently" is its own control for that: if these pragmas broke the locking, both
// processes would apply the migration and the test would go red rather than pass.
import Database from "better-sqlite3";

export const FAST_PRAGMAS = "PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;";

/**
 * Opens a database and applies FAST_PRAGMAS. Prefer this to `new Database(...)` plus a separate
 * `exec` -- one call is harder to forget, and forgetting is the failure this file exists to stop.
 * Existing handles (a db already open, or one whose constructor options matter) should use
 * `db.exec(FAST_PRAGMAS)` directly.
 */
export function openFast(file: string, options?: Database.Options) {
  const db = new Database(file, options);
  db.exec(FAST_PRAGMAS);
  return db;
}
