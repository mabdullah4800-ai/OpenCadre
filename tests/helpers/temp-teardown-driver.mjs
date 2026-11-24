// One minimal "test run", for tests/temp-teardown.test.ts. Spawned as a real child process so the
// experiment has two independent runs (two pids), not two setup() calls inside one run's process.
//
// It loads the REAL tests/helpers/global-teardown.ts -- Node 22.22.3 strips the types natively, so
// this file imports the module a real vitest run loads. A driver that re-implemented the teardown
// would pass while the real one stayed broken.
//
// Everything outside the run is passed in: --root is the private temp root this run treats as
// tmpdir() (the caller sets TEMP, TMP and TMPDIR to it), and --coord is where the orchestrating test
// and this run exchange signals. This file never hardcodes a temp path.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import setup from "./global-teardown.ts";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

const run = arg("run");
const root = arg("root");
const coord = arg("coord");
if (!run || !root || !coord) throw new Error("--run=, --root= and --coord= are required");

const record = (name, value = "") => writeFileSync(join(coord, `${run}-${name}`), value);

// Bounded well under the test's own timeout, so a wedged run reports itself.
async function waitForSignal(name, ms = 20_000) {
  const file = join(coord, name);
  const deadline = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`run ${run}: timed out waiting for ${name}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// 1. The isolation this experiment stands on, recorded so the test can ASSERT it: before setup,
//    tmpdir() must be the private root, or this run would work against the shared one.
record("root.txt", tmpdir());
record("pid.txt", String(process.pid));

// 2. Exactly the call vitest's globalSetup makes. Afterwards tmpdir() is this run's own dir.
const teardown = setup();
const runDir = tmpdir();
record("rundir.txt", runDir);

// 3. Live working state, the two kinds the 2026-10-31 incident lost:
//    - inside the run dir, where a test's mkdtemp now lands;
//    - directly in the shared root under an arbitrary name, the way vitest's own
//      <tmp>\<nanoid>\ssr cache is created before globalSetup runs.
mkdirSync(join(runDir, "work", "nested"), { recursive: true });
writeFileSync(join(runDir, "work", "nested", "live.txt"), run);
mkdirSync(join(root, `${run}-ssr-cache`, "ssr"), { recursive: true });
record("ready");

await waitForSignal(`${run}-release`);

// 4. The teardown, exactly as a real run's globalTeardown performs it.
teardown();
record("after.txt", tmpdir());
record("swept");
