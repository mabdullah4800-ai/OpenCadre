import { spawnSync } from "node:child_process";
import { findOnPath } from "./clients.mjs";

// The injectable default: a direct call whose options always end in windowsHide: true, so the child opens no console
// window on Windows whatever the caller passes. A raw child_process function is never handed around (see
// tests/product-spawn-static-guard.test.ts).
function hiddenSpawnSync(command, args, options) {
  return spawnSync(command, [...args], { ...options, windowsHide: true });
}

/**
 * A version warning, not a daemon health probe. Codex 0.157.0's no-argument TUI was measured
 * failing before sign-in on a Windows host that denied daemon detachment; `codex exec` and
 * `codex doctor --summary` did not distinguish that failure. A version cannot prove that a
 * customer's host has the same restriction, so this check must not change doctor's verdict.
 * Keep it separate from the shared Codex app wiring check: the app may work on the same machine.
 */
export function codexDaemonVersionWarning({ env = process.env, platform = process.platform, executable, run = hiddenSpawnSync } = {}) {
  if (platform !== "win32") return null;
  const binary = executable ?? findOnPath("codex", env);
  if (!binary) return null;
  try {
    const batch = /\.(cmd|bat)$/i.test(binary);
    // Windows runs .cmd/.bat through cmd.exe. Quote the executable as one token: npm's shim
    // commonly lives under a user path containing spaces, which otherwise hides this advisory.
    const result = run(batch ? `"${binary}"` : binary, ["--version"], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 8_192, windowsHide: true,
      shell: batch, env,
    });
    if (result.error || result.status !== 0) return null;
    const version = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:\s|$)/m.exec(result.stdout ?? "");
    if (!version || version[1] !== "0" || version[2] !== "157" || version[3] !== "0") return null;
    return "Codex CLI 0.157.0 may fail to open its interactive TUI on Windows hosts that block daemon detachment. Run `codex` with no arguments to confirm; if it says 'host Job Object prevents daemon detachment', upgrade the Codex CLI to 0.157.1 or newer. This version check alone does not prove a failure on this computer.";
  } catch {
    // A missing, broken or unsupported CLI is outside this optional version warning. The normal
    // wiring checks still report their own result; a failed version read must not turn them green.
    return null;
  }
}
