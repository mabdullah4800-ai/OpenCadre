// For tests that start real Node child processes (hooks, the wake script, the CLI, the MCP proxy): what their timing
// looks like when the machine is busy, so a loaded full suite doesn't fail them for being slow.
import { spawn } from "node:child_process";

/** Timeout for a test that starts real Node child processes. Starting `node script.mjs` takes ~0.1 s on an idle machine
 * but 1.7-2.5 s each when the suite shares the CPU (measured on Windows ARM64 with four suites running at once), so a
 * test with a few sequential spawns can't fit vitest's 5 s default. Only for tests that really spawn. */
export const SPAWN_TEST_TIMEOUT_MS = 30_000;

/** How long starting a bare `node` takes right now. A wall-clock bound on a child process includes Node's own startup;
 * subtract this, measured alongside the child, so the bound checks the script's own work however busy the machine is. */
export function nodeStartupMs(): Promise<number> {
  return new Promise((resolve) => {
    const started = Date.now();
    spawn(process.execPath, ["-e", ""], { stdio: "ignore" }).on("exit", () => resolve(Date.now() - started));
  });
}

/** Resolves once `predicate` holds, polling every 25 ms; rejects with `what` after `timeoutMs`. For a condition a child
 * process or a server brings about, instead of a fixed sleep that is too short when the machine is busy. */
export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Env for a test that runs the approval gate against a hub in this process. The gate gives up on the hub's policy after
 * 3 s and then treats the hub as unreachable, which changes its decision; on a busy machine the hub, sharing the test's
 * CPU, can take longer than that to answer. */
export const GATE_TEST_ENV = { OPENCADRE_POLICY_TIMEOUT_MS: "20000" };
