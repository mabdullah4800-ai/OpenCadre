// A temp directory that removes itself when the test file finishes.
//
// The problem this replaces: 29 of the 30 test files that call
// `mkdtempSync(path.join(tmpdir(), ...))` never remove what they made -- only five files in the whole
// suite call rmSync at all -- across 78 distinct prefixes. Measured 2026-09-18: 65,672 dirs / ~2.4 GB
// under the temp root, which filled C: and forced agent work onto B:.
//
// The pattern is why it went unnoticed for so long: every call site looks locally correct.
// `const tempHome = () => mkdtempSync(path.join(tmpdir(), "oc-cli-home-"));` is a perfectly ordinary
// line, and nothing about it says "this leaks forever". So the fix is not to add an afterAll to each
// file -- that is N places that must each remember, and the next test someone writes starts leaking
// again. It is to make the creating function ALSO the registering one, so a caller cannot get a temp
// directory without it being tracked:
//
//     import { tmpDir } from "./helpers/tmp.js";
//     const tempHome = () => tmpDir("oc-cli-home-");   // same shape, now self-cleaning
//
// Registration is keyed per test FILE via vitest's `afterAll`, so one file's cleanup can never remove
// another's directories, and a file that fails or times out still cleans up (afterAll runs on failure
// too; only a hard process kill skips it).
//
// This is the SOURCE fix and the counterpart to tests/helpers/global-teardown.ts, which is the
// COLLECTOR: during a run tmpdir() resolves inside that run's own `oc-vitest-run-*` directory, so
// anything this file fails to remove, and anything a file nobody converted leaks, is deleted with the
// run dir at teardown. Neither is sufficient alone -- do not delete either as redundant with the other.
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Directories this test file created, in creation order. */
const created: string[] = [];

/** Creates a temp directory and registers it for removal when this test file finishes.
 * Drop-in for `mkdtempSync(path.join(tmpdir(), prefix))`. */
export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  let failed = 0;
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // On Windows a file still held open refuses to delete. Leaving one directory behind is
      // strictly better than failing a green test run during cleanup, and global-teardown.ts
      // removes it with this run's temp dir.
      failed++;
    }
  }
  if (failed > 0) {
    console.log(`[tmp] ${failed} temp dir(s) still in use; the global teardown removes them with the run dir`);
  }
});