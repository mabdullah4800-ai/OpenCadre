// Probe: does this run's per-run temp dir (tests/helpers/global-teardown.ts) actually reach the
// worker this file runs in, and the child processes its tests spawn?
//
// globalSetup only sets TEMP/TMP/TMPDIR in vitest's MAIN process. That reaches the workers because
// vitest 4 builds each worker's env from process.env after globalSetup has run. If a vitest upgrade
// reorders that, tests silently fall back to the shared temp root, where a concurrent run's files
// live; this file turns that into a named failure.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_DIR_PATTERN } from "./helpers/global-teardown.js";

describe("per-run temp dir", () => {
  it("os.tmpdir() in a test worker is this run's oc-vitest-run- dir", () => {
    expect(tmpdir()).toContain("oc-vitest-run-");
    expect(basename(tmpdir())).toMatch(RUN_DIR_PATTERN);
  });

  it("a child process spawned by a test resolves the same dir", () => {
    const childTmp = execFileSync(process.execPath, ["-e", "process.stdout.write(require('os').tmpdir())"], {
      encoding: "utf8",
    });
    expect(childTmp).toBe(tmpdir());
  });
});
