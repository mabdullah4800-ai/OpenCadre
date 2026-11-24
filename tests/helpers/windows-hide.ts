// The argument rewrite behind tests/helpers/child-process-hygiene.ts: give a child_process call `windowsHide: true` unless
// the caller already chose a value. Pure, so its handling of every call shape is tested on its own
// (tests/child-process-hygiene.test.ts).

/** The child_process functions that start a process. `exec`/`execSync` take (command, options?, callback?); the rest
 * take (file, args?, options?, callback?), where args may be omitted, null or undefined. */
export const SPAWNERS = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"] as const;
export type Spawner = (typeof SPAWNERS)[number];

const isOptions = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `args` with `windowsHide: true` in the options slot. The caller's options object is copied, never mutated, and an
 * explicit `windowsHide` (true or false) is kept as given. */
export function withWindowsHide(fn: Spawner, args: readonly unknown[]): unknown[] {
  const out = [...args];
  if (out.length === 0) return out;
  // Where Node reads the options: after the command for exec*, else after an args array (or a null/undefined args).
  const slot = fn === "exec" || fn === "execSync" ? 1 : Array.isArray(out[1]) || (out.length > 1 && out[1] == null) ? 2 : 1;
  const current = out[slot];
  if (isOptions(current)) {
    if (current.windowsHide === undefined) out[slot] = { ...current, windowsHide: true };
  } else if (current == null && slot < out.length) {
    out[slot] = { windowsHide: true };
  } else {
    // Absent, or a callback sits where options would: options go in front of it.
    out.splice(slot, 0, { windowsHide: true });
  }
  return out;
}
