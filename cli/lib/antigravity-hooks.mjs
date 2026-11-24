import { join } from "node:path";
import { parseJsonConfig, readText } from "./files.mjs";

/** Antigravity's own hooks.json format is keyed by hook NAME, not by event (unlike Claude Code/Codex in
 * session-hooks.mjs), so merging is simple: touch only our own entries ("opencadre-inbox" and "opencadre-gate")
 * and leave every other key untouched. Global, not per-repo: Antigravity reads a workspace hooks.json from `.agents/` (or
 * `.agent/`) first if one exists there, then falls back to this one, so writing here never edits a
 * repository the user didn't point at. https://antigravity.google/docs/hooks/ */

export const HOOK_NAME = "opencadre-inbox";
/** The clearance gate, a separate named entry so a user can switch it off in Antigravity's Hooks menu without
 * losing the inbox. */
export const GATE_HOOK_NAME = "opencadre-gate";
const TIMEOUT = 10;
// The gate may hold a command while a person decides (ask mode waits up to 540 s by default).
const GATE_TIMEOUT = 600;

export const antigravityHooksFile = (home) => join(home, ".gemini", "config", "hooks.json");

/** Returns { file, before, after } without writing; throws if the existing file isn't a JSON object. */
export function planAntigravityHooks({ home, binDir }) {
  const file = antigravityHooksFile(home);
  const before = readText(file);
  const config = parseJsonConfig(file, before);

  const scriptPath = join(binDir, "opencadre-antigravity.mjs");
  const hook = (mode) => ({ type: "command", command: `node "${scriptPath}" ${mode}`, timeout: TIMEOUT });
  config[HOOK_NAME] = { enabled: true, PreInvocation: [hook("pre-invocation")], Stop: [hook("stop")] };
  // Clearance: the shared approval gate on run_command, Antigravity's only shell tool. Tool events take a
  // matcher group, unlike Stop and PreInvocation (antigravity.google/docs/hooks). An entry the user disabled
  // stays disabled: only the command and timeout are refreshed.
  const gatePath = join(binDir, "opencadre-approval-gate.mjs");
  const enabled = config[GATE_HOOK_NAME]?.enabled === false ? false : true;
  config[GATE_HOOK_NAME] = {
    enabled,
    PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: `node "${gatePath}" --client antigravity`, timeout: GATE_TIMEOUT }] }],
  };

  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}
