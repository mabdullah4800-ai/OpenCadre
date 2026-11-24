// The environment a test gives a CLI subprocess, so it reads ONLY the test's own home -- never the operator's real
// client configs (review of #692 at 02c4f838, Codex-049a; Olive measured four exit-3 mismatches from an inherited real
// %APPDATA%: Goose and Devin resolve their folders from APPDATA on Windows, not from HOME).
//
// Two rules, both from that review:
//   1. Every variable the CLI uses to find a client's folder (grep of cli/ and scripts/opencadre-clients.mjs:
//      HOME/USERPROFILE, APPDATA, LOCALAPPDATA, XDG_*, CODEX_HOME, COPILOT_HOME, GROK_HOME, VIBE_HOME, GOOSE_PATH_ROOT,
//      FACTORY_HOME_OVERRIDE, CRUSH_GLOBAL_CONFIG, CLINE_*, REASONIX_HOME, plus OPENCADRE_*) is DROPPED from the
//      parent, and the home-derived ones are SET explicitly to paths inside the test home.
//   2. Dropping is CASE-INSENSITIVE and happens BEFORE the explicit values are set: Windows env names are
//      case-insensitive, so a parent `AppData` next to our `APPDATA` (or a copied `HOME` after ours) could otherwise win.
//      The old helpers copied the parent AFTER setting HOME/USERPROFILE, so the parent's own values overwrote them.
// OS and runtime variables (SystemRoot, WINDIR, TEMP, TMP, ComSpec, PATHEXT, NUMBER_OF_PROCESSORS…) are kept. PATH is
// set to an EMPTY value on purpose: no installed vendor CLI (claude, codex…) can be found or run, and node itself is
// started by absolute path (process.execPath).
import path from "node:path";

const DROP_EXACT = new Set([
  "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME", "GROK_HOME", "VIBE_HOME", "GOOSE_PATH_ROOT", "FACTORY_HOME_OVERRIDE",
  "CRUSH_GLOBAL_CONFIG", "REASONIX_HOME",
]);
const DROP_PREFIX = ["XDG_", "CLINE_", "OPENCADRE_"];

export const isDroppedFromChild = (name: string) => {
  const up = name.toUpperCase();
  return DROP_EXACT.has(up) || DROP_PREFIX.some((p) => up.startsWith(p));
};

/** The child's environment: `parent` minus every home/client/OpenCadre override (case-insensitively), then the test
 * home's own explicit values. */
export function isolatedCliEnv(home: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined || isDroppedFromChild(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    CODEX_HOME: path.join(home, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    PATH: "",
  };
}
