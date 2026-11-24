// Loads OpenCadre's approval gate for a harness that RUNS a command whose pre-hook exits with anything but 2 (Windsurf:
// docs.devin.ai/desktop/cascade/hooks). A gate that fails to load (a helper missing after a partial upgrade, a helper
// from another version) fails during module linking, before any handler of its own exists, and exits 1: Windsurf would
// run the command. Imported dynamically here, the same failure is caught and blocks instead (review of 0610cda, S3).
// Everything else, the gate does itself; it reads the same argv (`--client windsurf`) and stdin.
import { writeSync } from "node:fs";

try {
  await import("./opencadre-approval-gate.mjs");
} catch (err) {
  try {
    writeSync(2, `OpenCadre approval gate could not load (${err?.message ?? err}), so this command was blocked.\n`);
  } catch { /* stderr gone: still block */ }
  process.exit(2);
}
