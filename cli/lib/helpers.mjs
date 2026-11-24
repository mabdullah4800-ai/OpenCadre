// The helper table, the install transform and the install manifest's reader. NODE BUILTINS ONLY, by contract:
// scripts/cli-build-info.mjs provenanceFor() imports `<ref>:cli/lib/helpers.mjs` ALONE from a scratch folder to read a
// ref's HELPERS and installTransform, so this file must load with no sibling beside it (tests/generations.test.ts
// checks). The install itself (generations, stubs, classification) lives in cli/lib/generations.mjs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fleet helpers installed into ~/.opencadre/bin/.gen/<id>/, by file name, with their path in the repo. */
export const HELPERS = {
  // Listed first only because it is the file to read first; a generation is staged whole and switched to at once
  // (cli/lib/generations.mjs), so this order carries no build-order meaning.
  "opencadre-clients.mjs": "scripts/opencadre-clients.mjs",
  "opencadre-config.mjs": "scripts/opencadre-config.mjs",
  "opencadre-hook-dialect.mjs": "scripts/opencadre-hook-dialect.mjs",
  "opencadre-secrets.mjs": "scripts/opencadre-secrets.mjs",
  "opencadre-wake.mjs": "scripts/opencadre-wake.mjs",
  "opencadre-usage.mjs": "scripts/opencadre-usage.mjs",
  "opencadre-update-notice.mjs": "scripts/opencadre-update-notice.mjs",
  // The update policy and the one bounded manifest reader (PR-E1). A library: the notice imports it, and the CLI loads it
  // through helperSource for doctor, `update` and `connect --upgrade`.
  "opencadre-update-check.mjs": "scripts/opencadre-update-check.mjs",
  "opencadre-mcp.mjs": "scripts/opencadre-mcp.mjs",
  "pure-ack.mjs": "scripts/pure-ack.mjs",
  "opencadre-awareness.mjs": "examples/hooks/opencadre-awareness.mjs",
  "opencadre-antigravity.mjs": "examples/hooks/opencadre-antigravity.mjs",
  "opencadre-approval-gate.mjs": "examples/hooks/opencadre-approval-gate.mjs",
  "opencadre-approval-gate-loader.mjs": "examples/hooks/opencadre-approval-gate-loader.mjs",
  "opencadre-session-stamp.mjs": "examples/hooks/opencadre-session-stamp.mjs",
  "opencadre-amp-plugin.mjs": "examples/hooks/opencadre-amp-plugin.mjs",
  "opencadre-kilo-core.mjs": "examples/hooks/opencadre-kilo-core.mjs",
  "opencadre-cline-hook.mjs": "examples/hooks/opencadre-cline-hook.mjs",
  // A `.js` file with exactly one export: Kilo calls every function a plugin module exports.
  "opencadre-kilo-plugin.js": "examples/hooks/opencadre-kilo-plugin.js",
  // OpenCode loads a plugin from a DIRECTORY with an index.js entry (HARNESS-OPENCODE.md §3.1), so these helpers live in a
  // subfolder; connect lists that folder under `plugins` in OpenCode's config.
  "opencode-plugin/index.js": "scripts/opencode-plugin/index.js",
  "opencode-plugin/mail.js": "scripts/opencode-plugin/mail.js",
  "opencode-plugin/clearance.js": "examples/opencode-plugin/clearance.js",
};

const BUNDLED = fileURLToPath(new URL("../helpers/", import.meta.url));
const REPO = fileURLToPath(new URL("../../", import.meta.url));

// The packed CLI carries helpers/ (scripts/pack-cli.mjs); run from a checkout, it uses the repo's own files.
export const helperSource = (name) => (existsSync(join(BUNDLED, name)) ? join(BUNDLED, name) : join(REPO, HELPERS[name]));

// Dot-prefixed on purpose: this is METADATA about the install, not one of the things installed.
// It sits beside the helpers so a machine can answer "which revision am I running" from its own
// disk, with no network and no repo. Deliberately not an entry in HELPERS: nothing should try to
// invoke it, rewrite its imports, or list it as a managed file.
const MANIFEST = ".opencadre-install.json";
export const installManifestPath = (binDir) => join(binDir, MANIFEST);


/** The CLI package's own version, for the manifest's human-readable field. Read rather than
 * hardcoded so it cannot drift from cli/package.json. Unreadable -> "unknown", never a throw:
 * the version is a label, and `stamp` is the value anything actually compares. */
export const CLI_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

/** { cliVersion, stamp, installedAt, helpers } for the install in `binDir`, or null when there is
 * none or it is unreadable.
 *
 * Null rather than a throw on every failure path, because this is read on the connect path: every
 * machine installed before this existed has no manifest, and a half-written one must degrade to
 * "unknown revision" rather than break a user's connect. The caller decides what to say about it. */
export function readInstallManifest(binDir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(installManifestPath(binDir), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.stamp !== "string" || !parsed.helpers || typeof parsed.helpers !== "object") return null;
  return parsed;
}

/** The helpers a CLIENT reaches by a fixed path at the install root (a hook command, an MCP server's args, a plugin
 * URL, a Cline or Amp wrapper's import), with what their stable stub does when it cannot load its generation
 * (cli/lib/stubs.mjs). Every other helper is a LIBRARY: it exists only inside a generation, and a legacy root copy of
 * one is never rewritten (an old entry that is still running may import it). tests/generations-inventory.test.ts
 * derives this set from what the client-config writers reference, so it cannot drift. */
export const ENTRIES = {
  "opencadre-mcp.mjs": "proxy",
  "opencadre-awareness.mjs": "quiet",
  "opencadre-wake.mjs": "quiet",
  "opencadre-usage.mjs": "quiet",
  "opencadre-session-stamp.mjs": "quiet",
  "opencadre-antigravity.mjs": "quiet",
  "opencadre-approval-gate.mjs": "gate",
  "opencadre-approval-gate-loader.mjs": "loader",
  "opencadre-cline-hook.mjs": "cline",
  "opencadre-amp-plugin.mjs": "amp-plugin",
  "opencadre-kilo-plugin.js": "kilo-plugin",
  "opencode-plugin/index.js": "opencode-plugin",
};

/** The sibling-import rewrite on its own, as a pure function of a helper's source text: side by side in one folder,
 * repo-relative references (../../scripts/x.mjs) become siblings (./x.mjs). Exported so scripts/cli-build-info.mjs hashes
 * exactly the text an install writes (build.json `helpers` and `officialHistory`), from one definition, rather than
 * a second copy of the rewrite that could drift from this one. */
export const installTransform = (text) => text.replaceAll("../../scripts/", "./");

/** The installed text for `name`: its source with the sibling-import rewrite applied. Exported so
 * tests can state what an install should produce without re-deriving the transform. */
export const installedText = (name) => installTransform(readFileSync(helperSource(name), "utf8"));
