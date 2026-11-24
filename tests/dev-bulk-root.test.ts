// Where dev scripts put their bulk (scripts/dev/bulk-root.mjs). The operator's rule, 2026-09-23: on the fleet PC,
// scratch goes on the Seagate (B:), never on the nearly full C:. console-shots.mjs used to write ~450 MB per run into
// the system temp dir and keep it; 57 runs filled most of an 8.3 GB %TEMP%. Each arm fails on a picker that always
// returns tmpdir(), and the last one fails on one that falls back to C: without saying so.
import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BIG_DRIVE_SCRATCH, scratchRoot, shotsDir } from "../scripts/dev/bulk-root.mjs";

const tmp = () => "C:/Users/someone/AppData/Local/Temp";

describe("dev scratch root", () => {
  it("uses the big drive when this machine has it", () => {
    const r = scratchRoot({ env: {}, exists: (p: string) => p === BIG_DRIVE_SCRATCH, tmp });
    expect(r).toEqual({ root: BIG_DRIVE_SCRATCH, warning: null });
  });

  it("OPENCADRE_SCRATCH wins over the big drive", () => {
    const r = scratchRoot({ env: { OPENCADRE_SCRATCH: "D:/scratch" }, exists: () => true, tmp });
    expect(r).toEqual({ root: "D:/scratch", warning: null });
  });

  it("without the big drive it falls back to the system temp dir, and says so", () => {
    const r = scratchRoot({ env: {}, exists: () => false, tmp });
    expect(r.root).toBe(tmp());
    expect(r.warning).toMatch(/not connected/);
  });
});

describe("default screenshot folder", () => {
  it("sits beside the scratch on the chosen drive, never in the repo checkout", () => {
    const dir = shotsDir({ out: undefined, root: BIG_DRIVE_SCRATCH, repoRoot: "C:\\repo", resolve: path.win32.resolve });
    expect(dir).toBe("B:\\ai-work\\temp\\console-shots");
  });

  it("--out wins, resolved against the repo", () => {
    expect(shotsDir({ out: "shots", root: BIG_DRIVE_SCRATCH, repoRoot: "/repo", resolve: path.posix.resolve })).toBe("/repo/shots");
  });

  // The harness runs main() at import, so its wiring is read from source: both choices must come from this module.
  // Spelling-bound on purpose and labelled so; the behaviour of each choice is the two describes above.
  it("console-shots takes its scratch root and default screenshot folder from this module", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/dev/console-shots.mjs"), "utf8");
    expect(src).toMatch(/const \{ root: scratchBase, warning: scratchWarning \} = scratchRoot\(\);/);
    expect(src).toMatch(/const outDir = shotsDir\(\{ out: args\.out, root: scratchBase,/);
    expect(src).not.toMatch(/"\.console-shots"/);
  });
});
