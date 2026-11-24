// Where a dev script puts its bulk. The fleet PC's C: is nearly full and B: is the Seagate (the operator, 2026-09-23),
// so bulk goes on B: whenever this machine has it. OPENCADRE_SCRATCH wins over both. With no B:, the system temp dir is
// used and `warning` says so, so falling back to C: is never silent.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

export const BIG_DRIVE_SCRATCH = "B:/ai-work/temp";

/** { root, warning }: `root` is where scratch goes; `warning` is a line to print when that root is the small drive. */
export function scratchRoot({ env = process.env, exists = existsSync, tmp = tmpdir } = {}) {
  if (env.OPENCADRE_SCRATCH) return { root: env.OPENCADRE_SCRATCH, warning: null };
  if (exists(BIG_DRIVE_SCRATCH)) return { root: BIG_DRIVE_SCRATCH, warning: null };
  return { root: tmp(), warning: `B: (the Seagate) is not connected, so this run's scratch (~450 MB while it runs, removed when it ends) and its screenshots go to ${tmp()} on the system drive.` };
}

/** Where screenshots go when the caller names no folder: beside the scratch, on the same drive. `out` wins, resolved
 * against the repo root. Never the repo checkout by default, which on the fleet PC is on the small drive. */
export function shotsDir({ out, root, repoRoot, resolve }) {
  return out ? resolve(repoRoot, out) : resolve(root, "console-shots");
}
