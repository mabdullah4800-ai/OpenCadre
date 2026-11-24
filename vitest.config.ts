import { defineConfig } from "vitest/config";
import FlakeReporter from "./scripts/vitest-flake-reporter.mjs";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // PUBLIC-SNAPSHOT SKIP: these four suites compare against commits from the private pre-release history, which
    // this repository does not carry. See CONTRIBUTING.md, "Skipped tests".
    exclude: ["tests/approval-withdraw-legacy.test.ts", "tests/cli-unstamped-guard.test.ts", "tests/connector-previous-bundle.test.ts", "tests/update-notice-lazy-import.test.ts"],
    environment: "node",
    // OPENCADRE_BILLING=on: the suite exercises the plan, trial and limit engine (src/billing.ts). A hub started without it
    // puts every workspace on the non-expiring plan; tests/billing-off.test.ts covers that default.
    env: { OPENCADRE_DB_PATH: ":memory:", OPENCADRE_BILLING: "on" },
    // Gives each run its own temp dir (`oc-vitest-run-<pid>-*` under the original tmpdir()) by
    // pointing TEMP/TMP/TMPDIR at it before the workers start, and deletes only that dir at the end,
    // so whatever a test leaks goes with it and concurrent runs never delete each other's files.
    // tests/helpers/global-teardown.ts documents the guards and the 2026-10-31 incident.
    globalSetup: ["tests/helpers/global-teardown.ts"],
    // Starts every child process a test spawns with windowsHide, so an unattended run opens no console windows on
    // Windows, and kills any child a test file leaves running when that file ends, pass or fail. See the file.
    setupFiles: ["tests/helpers/child-process-hygiene.ts"],
    // db.ts's `db` is a module-level singleton; vitest isolates each test
    // FILE into its own module registry by default, so each file still gets
    // its own fresh :memory: database even without per-test teardown.
    //
    // The flake reporter annotates a FAILURE with its timing context (test name,
    // that test's duration against its file's median, and the total run duration)
    // and emits nothing on a green run. It never changes a result. The local suite
    // is this repo's only merge gate - so an
    // unexplained failure has to be characterisable on first sight instead of lost.
    reporters: ["default", new FlakeReporter()],
  },
});




