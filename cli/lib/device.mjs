import { chmodSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ampHome, clientConfigFile, clineDirs, containerOf, copilotHome, crushHome, devinHome, droidHome, vibeHome, mergeTomlArrayEntries, gooseDirs, grokHome, kiloHome, mergeTomlTable, mergeYamlMapEntry, parseJsonc, refuseOpencodeComments } from "./clients.mjs";
import { parseJsonConfig, readText, writeWithBackup } from "./files.mjs";

/** Machine connect (`opencadre connect --code ocd_…`): one credential for this computer, shared by every tool it sets up,
 * and a per-session stdio MCP server in each of those tools that names each chat to the hub. The credential lives ONLY
 * in ~/.opencadre/credentials.json: never in a tool config, never on stdout or stderr. */

// The client lists live in the one table (scripts/opencadre-clients.mjs), re-exported here because that is
// where callers already import them from, so nothing keeps a second list in step by hand.
//
// Two homes, one file. The packed CLI carries it as a helper (cli/helpers/), and this file sits in cli/lib/;
// run from a checkout there is no built helpers/ copy on purpose (scripts/pack-cli.mjs stages outside the
// repo), so it comes from scripts/ instead. Same probe helpers.mjs already does for helperSource, for the
// same reason. A single static specifier cannot serve both, so this is the one import in cli/ that resolves
// at runtime - and it must fail LOUDLY, because the layout it fails in (the packed CLI) is the one a normal
// local run never exercises. pathToFileURL, not the bare path: Node's ESM loader rejects "C:\..." on Windows.
const staged = fileURLToPath(new URL("../helpers/opencadre-clients.mjs", import.meta.url));
const inRepo = fileURLToPath(new URL("../../scripts/opencadre-clients.mjs", import.meta.url));
if (!existsSync(staged) && !existsSync(inRepo)) {
  // Audience is whoever is running the CLI, which may be an installed package with no repo on disk.
  // So name only the paths that were PROBED (facts about the failure) and never a path the reader is
  // assumed to have (an assumption about their layout) - the flat tarball has no cli/ directory, so
  // "cli/lib/helpers.mjs" is not a path an installed user could inspect.
  throw new Error(
    `opencadre: this install is incomplete - a required file (opencadre-clients.mjs) is missing. ` +
      `Reinstall opencadre to repair it. Searched: ${staged} (packed CLI) and ${inRepo} (checkout).`,
  );
}
const clientsModule = await import(existsSync(staged) ? pathToFileURL(staged).href : "../../scripts/opencadre-clients.mjs");
export const DEVICE_CLIENTS = clientsModule.COMPUTER_TOOLS;
export const MEASURING_CLIENTS = clientsModule.MEASURING_CLIENTS;
// Every client the registry knows, in any state. Re-exported for the same reason as its two
// siblings: the CLI must validate a --client against the ONE table rather than a hand-written list,
// and `clientsModule` is the only object holding it. `CLIENTS` in cli/lib/clients.mjs is a separate
// DETECTION list (six names, no dsh or reasonix) and answering "is this a known client?" from it
// would refuse clients the registry actually serves.
export const CONNECT_CLIENTS = clientsModule.CONNECT_CLIENTS;
// The one `CODEX_HOME` resolver (§9 item 7), re-exported rather than re-implemented. This file writes
// Codex's config.toml; if it resolved the path its own way, a relocated install would get a config
// written where Codex never looks — the defect the resolver exists to close, one caller at a time.
export const codexHome = clientsModule.codexHome;
// The doctor's per-client declarations, re-exported with the table they describe so a caller has
// one import for "which clients exist" and "what can be checked about each".
export const DOCTOR_CHECKS = clientsModule.DOCTOR_CHECKS;
// A client connect sets up for clearance only (Windsurf): no session server, so nothing about chats joining is said.
export const gateOnlyFor = clientsModule.gateOnlyFor;
// Re-exported AND imported, not redefined: the constant now lives in clients.mjs because
// `readExistingServer` there must recognise the same entry this module writes, and this module
// already imports that one. Kept re-exported so every existing importer keeps importing it from here.
//
// THE IMPORT IS LOAD-BEARING, and its absence was a real defect. `export { X } from "..."` is a
// PURE RE-EXPORT: it makes X visible to importers but does NOT bind X in this module's own scope.
// Two functions below USE the name (`[SESSION_SERVER]:` and `mcp_servers.${SESSION_SERVER}`), so a
// re-export alone left them referencing an undefined identifier — caught by the codex device-path
// test (`SESSION_SERVER is not defined`), not by any test of the reader this change is about.
// Importing it binds the local name; exporting it keeps every existing import path working.
//
// The two above come from the REGISTRY (clientsModule) and are used only for re-export; this one
// comes from the CLI's clients.mjs and is used HERE as well.
import { SESSION_SERVER } from "./clients.mjs";
export { SESSION_SERVER };
export const CURSOR_PROJECT_SERVER = "opencadre-project";

export const credentialsPath = (home) => join(home, ".opencadre", "credentials.json");

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** { file, before, after, replacing, migrated } writing { computer: { hub, credential, deviceId } } into credentials.json.
 * An older per-tool entry ({ devices: { "claude-code": … } }) is migrated away, since this one credential now serves
 * that tool; anything else in the file is kept. Throws if the file isn't a JSON object. */
export function planCredentials({ home, hub, credential, deviceId }) {
  const file = credentialsPath(home);
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const devices = isObject(config.devices) ? { ...config.devices } : null;
  const previous = [config.computer?.credential, ...DEVICE_CLIENTS.map((c) => devices?.[c]?.credential)].filter((c) => typeof c === "string" && c.startsWith("dev_"));
  const migrated = Boolean(devices) && DEVICE_CLIENTS.some((c) => devices[c] !== undefined);
  if (devices) {
    for (const c of DEVICE_CLIENTS) delete devices[c];
    if (Object.keys(devices).length === 0) delete config.devices;
    else config.devices = devices;
  }
  config.computer = { hub, credential, deviceId };
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n`, replacing: previous.some((c) => c !== credential), migrated };
}

const sameHub = (a, b) => typeof a === "string" && typeof b === "string" && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
const isCredential = (c) => typeof c === "string" && /^dev_[0-9a-f]{48}$/.test(c);

/** { hub, credential, deviceId, shape } for the credential this computer already holds, or null. `hub` narrows it to one
 * hub; without it the computer entry wins, then an older per-tool entry. Reads the current shape
 * ({ computer: {…} }) and the one from before ({ devices: { "claude-code": {…} } }). Never print the credential. */
export function readStoredCredential({ home, hub }) {
  const file = credentialsPath(home);
  const config = parseJsonConfig(file, readText(file));
  const entries = [
    ["computer", config.computer],
    ...DEVICE_CLIENTS.map((c) => ["devices", isObject(config.devices) ? config.devices[c] : undefined]),
  ];
  for (const [shape, entry] of entries) {
    if (!isObject(entry) || !isCredential(entry.credential) || typeof entry.hub !== "string") continue;
    if (hub && !sameHub(entry.hub, hub)) continue;
    return { hub: entry.hub.replace(/\/+$/, ""), credential: entry.credential, deviceId: typeof entry.deviceId === "string" ? entry.deviceId : undefined, shape };
  }
  return null;
}

/** True when credentials.json already holds exactly this computer entry, so there is nothing to write. */
export function holdsComputerEntry({ home, hub, credential, deviceId }) {
  const file = credentialsPath(home);
  const { computer } = parseJsonConfig(file, readText(file));
  return isObject(computer) && sameHub(computer.hub, hub) && computer.credential === credential && computer.deviceId === deviceId;
}

/** Owner-only where the OS supports it (on Windows the user profile's ACL is what protects it). */
export function writeCredentials(plan) {
  mkdirSync(dirname(plan.file), { recursive: true, mode: 0o700 });
  const result = writeWithBackup(plan.file, plan.before, plan.after);
  try {
    chmodSync(plan.file, 0o600);
  } catch { /* best effort */ }
  return result;
}

/** The stdio server's command line. No key or credential: the proxy reads credentials.json itself. */
export const sessionServerArgs = (proxyPath, client) => [proxyPath, "--client", client];

/** { file, before, after } for ~/.claude.json mcpServers["opencadre-session"]; throws if the file isn't a JSON object. */
export function planSessionServer({ home, proxyPath, client }) {
  const file = join(home, ".claude.json");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  config.mcpServers = { ...config.mcpServers, [SESSION_SERVER]: { type: "stdio", command: "node", args: sessionServerArgs(proxyPath, client) } };
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** { file, before, after } for ~/.codex/config.toml [mcp_servers.opencadre-session]: the same keyless stdio proxy. Nothing
 * else in the file changes: no key, no [shell_environment_policy] lines, and a named agent's [mcp_servers.opencadre]
 * table stays as it is. */
export function planCodexSessionServer({ home, proxyPath }) {
  // Through the one resolver (§9 item 7). This is the DEVICE path's writer, and it is the one a
  // relocated install is most likely to hit first, since it runs on every computer-credential connect.
  const file = join(codexHome(home), "config.toml");
  const before = readText(file);
  const str = (s) => JSON.stringify(s);
  const after = mergeTomlTable(before, `mcp_servers.${SESSION_SERVER}`, [
    `command = ${str("node")}`,
    `args = [${sessionServerArgs(proxyPath, "codex").map(str).join(", ")}]`,
    // wait_for_message can hold a call for up to 280 s.
    "tool_timeout_sec = 300",
  ]);
  return { file, before, after };
}

/** { file, before, after } for Devin's mcp_config.json `mcpServers["opencadre-session"]`: the keyless stdio proxy, run
 * with `--client devin`. Devin runs one MCP process for all its sessions, so every call is stamped (planDevinHooks). */
export function planDevinSessionServer({ home, proxyPath, env = process.env }) {
  const file = join(devinHome(home, env), "mcp_config.json");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  containerOf(config, ["mcpServers"])[SESSION_SERVER] = { command: "node", args: sessionServerArgs(proxyPath, "devin") };
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** Why Devin's config.json or mcp_config.json cannot be rewritten, or null. Devin reads both as JSON with comments (its
 * docs show them), and a rewrite through JSON would delete the comments, so such a file is left alone and connect says
 * so; Devin alone is skipped when other tools are being set up (review of 47dab9a, S3). */
export function devinConfigProblem({ home, env = process.env }) {
  return jsonConfigProblem(["config.json", "mcp_config.json"].map((name) => join(devinHome(home, env), name)));
}

/** Why Crush's crush.json cannot be rewritten, or null (the same reasons as Devin's). */
export function crushConfigProblem({ home, env = process.env }) {
  return jsonConfigProblem([join(crushHome(home, env), "crush.json")]);
}

/** The first of `files` that holds comments, trailing commas or no JSON object, said as the reason connect leaves it
 * alone, else null. A missing or empty file is fine. */
function jsonConfigProblem(files) {
  for (const file of files) {
    const text = readText(file);
    if (!text.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch { /* comments, trailing commas, or broken */ }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) continue;
    if (parsed !== undefined) return `${file} does not hold a JSON object; fix it first, then run the command again. Nothing was changed.`;
    const jsonc = parseJsonc(text);
    return jsonc && typeof jsonc === "object" && !Array.isArray(jsonc)
      ? `${file} holds comments or trailing commas, and OpenCadre will not rewrite it: that would delete them. Remove them (or move the file aside), then run the command again.`
      : `${file} is not valid JSON; fix it first, then run the command again. Nothing was changed.`;
  }
  return null;
}

/** { file, before, after } for Devin's config.json `hooks` (Claude's grouped shape; matchers are regex SEARCHES, with
 * no Claude name aliasing). OpenCadre's handlers are replaced in place and every other hook and setting stays. Devin's
 * default hook timeout is 60 s and a timeout lets the call run, so each says its own (600 is honoured, measured). */
export function planDevinHooks({ home, awarenessPath, gatePath, stampPath, env = process.env }) {
  const file = join(devinHome(home, env), "config.json");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const hooks = containerOf(config, ["hooks"]);
  const run = (script, timeout) => ({ type: "command", command: `node "${script}" --client devin`, timeout });
  const ours = (h) => /opencadre-(approval-gate(-loader)?|session-stamp|awareness)\.mjs/.test(String(h?.command ?? ""));
  const add = (event, group) => {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !ours(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    hooks[event] = [...kept, ...group];
  };
  // Both of Devin's shell tools: `write_to_process` types into a running shell (review of 47dab9a, B1). Through the
  // loader, and exit 2 on a crash: Devin runs a call whose hook fails any other way (S1).
  const loaderPath = gatePath.replace(/opencadre-approval-gate\.mjs$/, "opencadre-approval-gate-loader.mjs");
  add("PreToolUse", [
    { matcher: "^(exec|write_to_process)$", hooks: [run(loaderPath, 600)] },
    { matcher: `^mcp__${SESSION_SERVER}__`, hooks: [run(stampPath, 15)] },
  ]);
  add("SessionStart", [{ hooks: [run(awarenessPath, 15)] }]);
  add("UserPromptSubmit", [{ hooks: [run(awarenessPath, 15)] }]);
  add("PostToolUse", [
    { hooks: [run(awarenessPath, 15)] },
    // Once a write to a running shell RAN, the gate's record of that shell's line is trimmed (--typed-commit).
    { matcher: "^write_to_process$", hooks: [{ type: "command", command: `node "${gatePath}" --typed-commit --client devin`, timeout: 15 }] },
  ]);
  add("Stop", [{ hooks: [run(awarenessPath, 30)] }]);
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** { file, before, after } for Factory Droid's ~/.factory/mcp.json `mcpServers["opencadre-session"]`: the keyless stdio
 * proxy, run with `--client droid`. Every call names its session in `_meta.assemblySessionId`, so no stamp is needed. */
export function planDroidSessionServer({ home, proxyPath, env = process.env }) {
  const file = join(droidHome(home, env), "mcp.json");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  containerOf(config, ["mcpServers"])[SESSION_SERVER] = { type: "stdio", command: "node", args: sessionServerArgs(proxyPath, "droid") };
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** { file, before, after } for Factory Droid's ~/.factory/hooks.json. The file is FLAT (`{ PreToolUse: [...] }`; a
 * `hooks` wrapper is ignored, measured on 0.226.2), each group Claude-shaped. OpenCadre's handlers are replaced in place
 * and every other hook stays. A hook's default timeout is 60 s and a timeout lets the call run, so each says its own:
 *   PreToolUse on `Execute`            the approval gate, through its loader (exit 2 if it cannot load)
 *   SessionStart, UserPromptSubmit     awareness: the session's name, then mail and what changed (additionalContext)
 *   Stop                               awareness: unread mail continues the turn once (stop_hook_active) */
export function planDroidHooks({ home, awarenessPath, gatePath, env = process.env }) {
  const file = join(droidHome(home, env), "hooks.json");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const run = (script, timeout) => ({ type: "command", command: `node "${script}" --client droid`, timeout });
  const ours = (h) => /opencadre-(approval-gate(-loader)?|awareness)\.mjs/.test(String(h?.command ?? ""));
  for (const [event, groups] of Object.entries(config)) {
    if (!Array.isArray(groups)) throw new Error(`${file}: "${event}" is not a list of hook groups; fix it first, nothing was changed.`);
  }
  const add = (event, group) => {
    const kept = (Array.isArray(config[event]) ? config[event] : [])
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !ours(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    config[event] = [...kept, ...group];
  };
  const loaderPath = gatePath.replace(/opencadre-approval-gate\.mjs$/, "opencadre-approval-gate-loader.mjs");
  add("PreToolUse", [{ matcher: "Execute", hooks: [run(loaderPath, 600)] }]);
  add("SessionStart", [{ hooks: [run(awarenessPath, 15)] }]);
  add("UserPromptSubmit", [{ hooks: [run(awarenessPath, 15)] }]);
  add("Stop", [{ hooks: [run(awarenessPath, 30)] }]);
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** { file, before, after } for Mistral Vibe's ~/.vibe/config.toml (VIBE_HOME): one `[[mcp_servers]]` entry named
 * `opencadre-session`, the keyless stdio proxy run with `--client vibe`. Every other line stays. */
export function planVibeSessionServer({ home, proxyPath, env = process.env }) {
  const file = join(vibeHome(home, env), "config.toml");
  const before = readText(file);
  const q = (v) => JSON.stringify(v);
  const after = mergeTomlArrayEntries(before, "mcp_servers", (lines) => lines.some((l) => new RegExp(`^\\s*name\\s*=\\s*["']${SESSION_SERVER}["']`).test(l)), [[
    `name = ${q(SESSION_SERVER)}`,
    `transport = "stdio"`,
    `command = "node"`,
    `args = [${sessionServerArgs(proxyPath, "vibe").map(q).join(", ")}]`,
  ]]);
  return { file, before, after };
}

/** { file, before, after } for Mistral Vibe's ~/.vibe/hooks.toml: OpenCadre's `[[hooks]]` entries (named `opencadre-…`)
 * replaced, every other hook kept. Hooks of one type run in order, and a failing hook is allowed unless `strict`:
 *   pre_tool on OpenCadre's tools   the identity stamp (`tool_input`, which replaces the arguments)
 *   pre_tool on `bash`              the approval gate, strict (a failure denies), timeout 600
 *   post_tool on every tool         awareness: the session's name once, then mail and what changed, with the result
 *   post_agent                      awareness: unread mail continues the turn once */
export function planVibeHooks({ home, awarenessPath, gatePath, stampPath, env = process.env }) {
  const file = join(vibeHome(home, env), "hooks.toml");
  const before = readText(file);
  const q = (v) => JSON.stringify(v);
  const run = (script) => q(`node "${script}" --client vibe`);
  const after = mergeTomlArrayEntries(before, "hooks", (lines) => lines.some((l) => /^\s*name\s*=\s*["']opencadre-/.test(l)), [
    [`name = "opencadre-stamp"`, `type = "pre_tool"`, `match = ${q(`${SESSION_SERVER}_*`)}`, `command = ${run(stampPath)}`, `timeout = 15`],
    [`name = "opencadre-gate"`, `type = "pre_tool"`, `match = "bash"`, `strict = true`, `command = ${run(gatePath)}`, `timeout = 600`],
    [`name = "opencadre-awareness"`, `type = "post_tool"`, `command = ${run(awarenessPath)}`, `timeout = 15`],
    [`name = "opencadre-mail"`, `type = "post_agent"`, `command = ${run(awarenessPath)}`, `timeout = 30`],
  ]);
  return { file, before, after };
}

/** { file, before, after } for Crush's global crush.json: `mcp["opencadre-session"]` (the keyless stdio proxy, run with
 * `--client crush`) and OpenCadre's entries in `hooks.PreToolUse`, Crush's only hook event (a flat list of
 * { matcher, command, timeout }; matching hooks run in parallel). Every other key and hook stays; OpenCadre's are
 * replaced in place. A hook's default timeout is 30 s and a timeout lets the call run, so each says its own:
 *   ^mcp_opencadre-session_   the identity stamp (`updated_input`, merged, no decision)
 *   ^bash$                    the approval gate, through its loader (exit 2 if it cannot load)
 *   every tool                awareness: the session's name once, then mail and what changed, with the tool's result */
export function planCrushConfig({ home, proxyPath, awarenessPath, gatePath, stampPath, env = process.env }) {
  const file = join(crushHome(home, env), "crush.json");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  containerOf(config, ["mcp"])[SESSION_SERVER] = { type: "stdio", command: "node", args: sessionServerArgs(proxyPath, "crush") };
  const hooks = containerOf(config, ["hooks"]);
  const ours = (h) => /opencadre-(approval-gate(-loader)?|session-stamp|awareness)\.mjs/.test(String(h?.command ?? ""));
  const run = (script) => `node "${script}" --client crush`;
  const loaderPath = gatePath.replace(/opencadre-approval-gate\.mjs$/, "opencadre-approval-gate-loader.mjs");
  hooks.PreToolUse = [
    ...(Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.filter((h) => !ours(h)) : []),
    { matcher: `^mcp_${SESSION_SERVER}_`, command: run(stampPath), timeout: 15 },
    { matcher: "^bash$", command: run(loaderPath), timeout: 600 },
    { matcher: "", command: run(awarenessPath), timeout: 15 },
  ];
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** { file, before, after } for Grok's ~/.grok/config.toml `[mcp_servers.opencadre-session]`: the keyless stdio proxy,
 * run with `--client grok`. Named like Claude Code's entry in ~/.claude.json, which Grok also loads, so this one wins
 * there (a native entry wins on the same name; measured) and Grok's sessions do not start Claude Code's proxy. */
export function planGrokSessionServer({ home, proxyPath, env = process.env }) {
  const file = join(grokHome(home, env), "config.toml");
  const before = readText(file);
  const str = (s) => JSON.stringify(s);
  const after = mergeTomlTable(before, `mcp_servers.${SESSION_SERVER}`, [
    `command = ${str("node")}`,
    `args = [${sessionServerArgs(proxyPath, "grok").map(str).join(", ")}]`,
  ]);
  return { file, before, after };
}

/** { file, before, after } for Grok's hook file ~/.grok/hooks/opencadre.json (OpenCadre's own; Grok merges every file
 * there and always trusts it). Claude's grouped shape. Grok's default hook timeout is 5 s and a timeout lets the call
 * run, so every handler says its own. SessionStart and UserPromptSubmit are not installed: Grok does not read their
 * output. */
export function planGrokHooks({ home, awarenessPath, gatePath, env = process.env }) {
  const file = join(grokHome(home, env), "hooks", "opencadre.json");
  const run = (script, timeout) => ({ type: "command", command: `node "${script}" --client grok`, timeout });
  const hooks = {
    // Both of Grok's shell tools: `monitor` runs a watched command too (review of 7ffc12c, B1). Anchored, since the
    // matcher is a regex over the tool name.
    PreToolUse: [{ matcher: "^(run_terminal_command|monitor)$", hooks: [run(gatePath, 600)] }],
    PostToolUse: [{ hooks: [run(awarenessPath, 15)] }],
    Stop: [{ hooks: [run(awarenessPath, 30)] }],
  };
  return { file, before: readText(file), after: `${JSON.stringify({ hooks }, null, 2)}\n` };
}

/** { file, before, after } for ~/.cursor/mcp.json mcpServers["opencadre-session"]: the same keyless stdio proxy, run
 * with `--client cursor`. One file serves the editor and the `agent` CLI ("the CLI uses the same configuration as
 * the editor", cursor.com/docs/cli/mcp). A named agent's `opencadre` entry, if any, stays exactly as it is. */
export function planCursorSessionServer({ home, proxyPath }) {
  const file = clientConfigFile(home, "cursor");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const servers = containerOf(config, ["mcpServers"]);
  servers[SESSION_SERVER] = { type: "stdio", command: "node", args: sessionServerArgs(proxyPath, "cursor") };
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** Cursor starts project MCP servers outside the workspace on Windows. Bind this entry
 * to the exact project folder before initialize, while leaving every other server intact. */
export function planCursorProjectServer({ projectRoot, proxyPath }) {
  const file = join(projectRoot, ".cursor", "mcp.json");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const servers = containerOf(config, ["mcpServers"]);
  const old = servers[SESSION_SERVER];
  if (old?.command === "node" && Array.isArray(old.args) && old.args[0] === proxyPath
      && old.args.includes("--client") && old.args[old.args.indexOf("--client") + 1] === "cursor") delete servers[SESSION_SERVER];
  servers[CURSOR_PROJECT_SERVER] = { type: "stdio", command: "node", args: [...sessionServerArgs(proxyPath, "cursor"), "--project", projectRoot] };
  return { file, before, after: JSON.stringify(config, null, 2) + "\n" };
}
/** { file, before, after } for ~/.gemini/settings.json mcpServers["opencadre-session"]: the keyless stdio proxy, run
 * with `--client gemini`. The same file holds Gemini's hooks, so the caller plans the hooks AFTER writing this. A
 * named agent's `opencadre` entry, if any, stays exactly as it is (it wins at runtime). */
export function planGeminiSessionServer({ home, proxyPath, client = "gemini" }) {
  const file = clientConfigFile(home, client);
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const servers = containerOf(config, ["mcpServers"]);
  // Qwen Code defers an MCP server's tools behind its tool_search unless the entry says `alwaysLoadTools: true`
  // (MEASURED live on 0.24.4: without it the model was offered none of OpenCadre's tools). Gemini CLI has no such key.
  servers[SESSION_SERVER] = { command: "node", args: sessionServerArgs(proxyPath, client), ...(client === "qwen" ? { alwaysLoadTools: true } : {}) };
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** Qwen Code keeps the same `mcpServers` shape in ~/.qwen/settings.json (it is a Gemini CLI fork), with its hooks in
 * the same file, so the Gemini writer serves it under its own client name. */
export const planQwenSessionServer = ({ home, proxyPath }) => planGeminiSessionServer({ home, proxyPath, client: "qwen" });

/** { file, before, after } for Goose's config.yaml `extensions.opencadre-session`: the keyless stdio proxy, run with
 * `--client goose`, merged line by line (mergeYamlMapEntry), every other line untouched. Scalars are written as JSON
 * strings, which YAML reads the same. `timeout` bounds each MCP call in Goose (default 300 s); wait_for_message can
 * hold one for 280 s, so it gets headroom. Throws, before anything is written, on a config shape it will not edit. */
export function planGooseSessionServer({ home, proxyPath, env = process.env }) {
  const file = join(gooseDirs(home, env).config, "config.yaml");
  const before = readText(file);
  const q = JSON.stringify;
  const entry = [
    `${SESSION_SERVER}:`,
    "  enabled: true",
    "  type: stdio",
    `  name: ${q(SESSION_SERVER)}`,
    `  description: ${q("OpenCadre: this session's messages, tasks and clearance")}`,
    "  cmd: node",
    `  args: [${sessionServerArgs(proxyPath, "goose").map(q).join(", ")}]`,
    "  envs: {}",
    "  timeout: 600",
  ];
  try {
    return { file, before, after: mergeYamlMapEntry(before, "extensions", SESSION_SERVER, entry) };
  } catch (err) {
    throw new Error(`${file}: ${err.message}. Add this under "extensions:" yourself, then run the command again; nothing was changed:\n${entry.map((l) => `  ${l}`).join("\n")}`);
  }
}

/** Goose's hooks, as OpenCadre's own Goose plugin: `<plugins>/opencadre/plugin.json` and `hooks/hooks.json`, which
 * Goose discovers and enables by itself (plugins/discovery.rs). The whole plugin is ours, so each file is written
 * whole. Goose runs a hook with `sh -c` on every platform, so paths use forward slashes. Returns [{ file, before, after }].
 *   PreToolUse on `shell` (Goose's shell tool keeps its bare name): the approval gate, 600 s for a person to decide.
 *   Stop: the awareness hook, which blocks the stop once per new mail (Goose shows the reason as a user message).
 * SessionStart and UserPromptSubmit are not installed: Goose shows nothing a hook prints to the model there. */
export function planGoosePlugin({ home, awarenessPath, gatePath, env = process.env }) {
  const dir = join(gooseDirs(home, env).plugins, "opencadre");
  // Single-quoted for `sh -c`, so a `$`, backtick or `"` in the home path is taken literally.
  const quote = (p) => `'${p.replaceAll("\\", "/").replaceAll("'", `'\\''`)}'`;
  const hooks = {
    hooks: {
      // `on_failure: "block"`: Goose's default lets the command run when the hook fails (a crash, its timeout, no
      // node or no sh on PATH), which would switch clearance off silently (review of d6a7ef7, B3). Goose honours it on
      // PreToolUse only, which is the one step where failing closed is right.
      PreToolUse: [{ matcher: "^shell$", hooks: [{ type: "command", command: `node ${quote(gatePath)} --client goose`, timeout: 600, on_failure: "block" }] }],
      Stop: [{ hooks: [{ type: "command", command: `node ${quote(awarenessPath)} --client goose`, timeout: 15 }] }],
    },
  };
  const plugin = { name: "opencadre", description: "OpenCadre: risky shell commands wait for approval, and new mail reaches the session when its turn ends." };
  return [
    { file: join(dir, "plugin.json"), after: `${JSON.stringify(plugin, null, 2)}\n` },
    { file: join(dir, "hooks", "hooks.json"), after: `${JSON.stringify(hooks, null, 2)}\n` },
  ].map((p) => ({ ...p, before: readText(p.file) }));
}

/** { file, before, after } for Copilot CLI's mcp-config.json `mcpServers["opencadre-session"]`: the keyless stdio
 * proxy, run with `--client copilot`, every tool exposed. A named agent's `opencadre` entry, if any, stays. */
export function planCopilotSessionServer({ home, proxyPath, env = process.env }) {
  const file = clientConfigFile(home, "copilot", env);
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const servers = containerOf(config, ["mcpServers"]);
  servers[SESSION_SERVER] = { type: "local", command: "node", args: sessionServerArgs(proxyPath, "copilot"), tools: ["*"] };
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** { file, before, after } for OpenCadre's own Copilot CLI hook file, (COPILOT_HOME or ~/.copilot)/hooks/opencadre.json,
 * written whole (the file is ours; Copilot reads every *.json there, with no trust step). Copilot names no event in a
 * camelCase payload, so each command says which one it is (`--event`). Measured on 1.0.88:
 *   sessionStart, userPromptSubmitted  awareness: who this session is, the protocol, the digest (additionalContext)
 *   preToolUse on bash|powershell      the approval gate; `timeoutSec` above its 540 s wait (a timeout lets it run)
 *   preMcpToolCall                     the identity stamp, into the call's `_meta`
 *   agentStop                          awareness: unread mail keeps the session going once (stop_hook_active) */
export function planCopilotHooks({ home, awarenessPath, gatePath, stampPath, env = process.env }) {
  const file = join(copilotHome(home, env), "hooks", "opencadre.json");
  const run = (path, event, extra = {}) => ({ type: "command", command: `node "${path}" --client copilot --event ${event}`, ...extra });
  const hooks = {
    version: 1,
    hooks: {
      sessionStart: [run(awarenessPath, "sessionStart", { timeoutSec: 15 })],
      userPromptSubmitted: [run(awarenessPath, "userPromptSubmitted", { timeoutSec: 15 })],
      // write_bash / write_powershell type into a running shell, so they are gated too.
      preToolUse: [run(gatePath, "preToolUse", { matcher: "bash|powershell|write_bash|write_powershell", timeoutSec: 600 })],
      // Once a write to a running shell RAN, the gate's record of that shell's line is trimmed (--typed-commit).
      postToolUse: [{ type: "command", command: `node "${gatePath}" --typed-commit --client copilot --event postToolUse`, matcher: "write_bash|write_powershell", timeoutSec: 15 }],
      preMcpToolCall: [run(stampPath, "preMcpToolCall", { timeoutSec: 15 })],
      agentStop: [run(awarenessPath, "agentStop", { timeoutSec: 15 })],
    },
  };
  return { file, before: readText(file), after: `${JSON.stringify(hooks, null, 2)}\n` };
}

/** { file, before, after } for Windsurf's user hooks, ~/.codeium/windsurf/hooks.json: the approval gate on
 * `pre_run_command`, beside whatever hooks the user has (an earlier OpenCadre entry is replaced, not duplicated).
 * Windsurf runs a hook with `bash -c`, or `powershell -Command` on Windows, taking each from its own field. */
export function planWindsurfHooks({ home, gatePath }) {
  const file = join(home, ".codeium", "windsurf", "hooks.json");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const hooks = containerOf(config, ["hooks"]);
  // Through the loader, so a gate that fails to load blocks (exit 2) instead of letting Windsurf run the command.
  const command = `node "${gatePath.replace(/opencadre-approval-gate\.mjs$/, "opencadre-approval-gate-loader.mjs")}" --client windsurf`;
  const ours = (h) => String(h?.command ?? "").includes("opencadre-approval-gate");
  const list = Array.isArray(hooks.pre_run_command) ? hooks.pre_run_command.filter((h) => !ours(h)) : [];
  hooks.pre_run_command = [...list, { command, powershell: command, show_output: false }];
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** Why Amp's settings file cannot be rewritten, or null. Amp reads it as JSONC (comments and trailing commas allowed);
 * a rewrite through JSON would delete the comments, so such a file is left alone and the reader told what to add by
 * hand (review of 597af1c, S4). */
export function ampSettingsProblem({ home, proxyPath }) {
  const file = clientConfigFile(home, "amp");
  const text = readText(file);
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return null;
  } catch { /* JSONC, or broken */ }
  const entry = JSON.stringify({ [SESSION_SERVER]: { command: "node", args: sessionServerArgs(proxyPath, "amp") } });
  return `${file} holds comments or trailing commas (Amp reads it as JSONC), and OpenCadre will not rewrite it: that would delete them. `
    + `Add this under "amp.mcpServers" yourself, or remove the comments, then run the command again: ${entry}`;
}

/** { file, before, after } for ~/.config/amp/settings.json `"amp.mcpServers"["opencadre-session"]`: the keyless stdio
 * proxy, run with `--client amp`. `amp.mcpServers` is ONE key with a dot in its name (VS Code-style settings), not a
 * nested object. User-level servers run without Amp's workspace approval step. A named agent's `opencadre` entry, if
 * any, stays as it is. */
export function planAmpSessionServer({ home, proxyPath }) {
  const file = clientConfigFile(home, "amp");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const servers = containerOf(config, ["amp.mcpServers"]);
  servers[SESSION_SERVER] = { command: "node", args: sessionServerArgs(proxyPath, "amp") };
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** { file, before, after } for Amp's user plugin ~/.config/amp/plugins/opencadre.js: a one-line module that loads
 * OpenCadre's plugin from ~/.opencadre/bin, so an update of the helpers updates the plugin with no second write.
 * Amp runs plugins under Bun, which imports a file URL like Node does. */
export function planAmpPlugin({ home, pluginPath }) {
  const file = join(ampHome(home), "plugins", "opencadre.js");
  const after = [
    "// Written by `opencadre connect`: OpenCadre for Amp (each thread its own agent, clearance for shell commands,",
    "// mail, including to an idle thread). Remove this file to switch it off; `opencadre connect` writes it again.",
    `export { default } from ${JSON.stringify(pathToFileURL(pluginPath).href)};`,
    `export const description = "OpenCadre: each thread is its own agent; risky shell commands wait for approval; new mail reaches idle threads.";`,
    "",
  ].join("\n");
  return { file, before: readText(file), after };
}

/** { file, before, after } for Antigravity's ~/.gemini/config/mcp_config.json `mcpServers["opencadre-session"]`: the
 * keyless stdio proxy, run with `--client antigravity`. One child serves every conversation of an agy process, and each
 * call names its conversation in `_meta` (measured on agy 1.2.9). A named agent's `opencadre` entry stays as it is. */
export function planAntigravitySessionServer({ home, proxyPath }) {
  const file = clientConfigFile(home, "antigravity");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  containerOf(config, ["mcpServers"])[SESSION_SERVER] = { command: "node", args: sessionServerArgs(proxyPath, "antigravity") };
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** { file, before, after } for Cline's cline_mcp_settings.json `mcpServers["opencadre-session"]`: the keyless stdio
 * proxy, run with `--client cline`. `timeout` is seconds per request (Cline's default 60): OpenCadre's waits hold a
 * request for up to 55 s, so it gets room. */
export function planClineSessionServer({ home, proxyPath, env = process.env }) {
  const file = clientConfigFile(home, "cline", env);
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  containerOf(config, ["mcpServers"])[SESSION_SERVER] = { command: "node", args: sessionServerArgs(proxyPath, "cline"), timeout: 120 };
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** [{ file, before, after }] for Cline's file hooks ~/.cline/hooks/PreToolUse.mjs and PostToolUse.mjs: one-line modules
 * that load ~/.opencadre/bin/opencadre-cline-hook.mjs. A file of the user's own by that name is never replaced: connect
 * refuses instead (it would be their hook, silently gone). */
export function planClineHooks({ home, hookPath, env = process.env }) {
  const dir = clineDirs(home, env).hooks;
  const body = (event) => [
    `// Written by \`opencadre connect\`: OpenCadre's ${event} hook for Cline (identity, clearance for shell commands, mail).`,
    "// Remove this file to switch it off; `opencadre connect` writes it again.",
    `import ${JSON.stringify(pathToFileURL(hookPath).href)};`,
    "",
  ].join("\n");
  return ["PreToolUse", "PostToolUse"].map((event) => {
    const file = join(dir, `${event}.mjs`);
    const before = readText(file);
    if (before.trim() && !before.includes("opencadre-cline-hook.mjs")) {
      throw new Error(`${file} is a Cline hook of your own, and OpenCadre's ${event} hook would take its name, so OpenCadre will not replace it. `
        + `Add \`import ${JSON.stringify(pathToFileURL(hookPath).href)};\` to it (or rename it), then run the command again; nothing was changed.`);
    }
    return { file, before, after: body(event) };
  });
}

// Kilo's global config files, in the order it merges them (GLOBAL_CONFIG_FILES in the 7.7.9 binary), and the marker of
// its one-time bash-permission migration.
const KILO_CONFIG_FILES = ["config.json", "kilo.json", "kilo.jsonc", "opencode.json", "opencode.jsonc"];
const KILO_BASH_MIGRATED = ".bash-permission-migrated";

/** Why Kilo's kilo.json cannot be rewritten, or null. Kilo reads it as JSONC; a rewrite through JSON would delete the
 * comments, so such a file is left alone and the reader told what to add by hand, as for Amp. */
export function kiloConfigProblem({ home, proxyPath, pluginPath, env = process.env }) {
  const file = clientConfigFile(home, "kilo", env);
  const text = readText(file);
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return null;
  } catch { /* JSONC, or broken */ }
  const entry = JSON.stringify({ plugin: [pathToFileURL(pluginPath).href], mcp: { [SESSION_SERVER]: kiloServer(proxyPath) } });
  return `${file} holds comments or trailing commas (Kilo reads it as JSONC), and OpenCadre will not rewrite it: that would delete them. `
    + `Add these entries yourself, or remove the comments, then run the command again: ${entry}`;
}

const kiloServer = (proxyPath) => ({ type: "local", command: ["node", ...sessionServerArgs(proxyPath, "kilo")] });

/** Kilo Code's CLI, one file: ~/.config/kilo/kilo.json gets `mcp["opencadre-session"]` (the keyless stdio proxy, run
 * with `--client kilo`; `mcp` is one level deep in Kilo, OpenCode's pre-v2 shape) and OpenCadre's plugin in `plugin`,
 * as a file URL of ~/.opencadre/bin/opencadre-kilo-plugin.js (Kilo imports it under Bun). An older OpenCadre plugin
 * entry at another path is replaced; every other plugin and server stays.
 *
 * Returns { file, before, after, marker }. `marker` is Kilo's bash-permission migration marker when it must be written
 * too: on its first start, a Kilo that finds a global config with any setting in it and no marker decides the user
 * predates its bash-permission change and writes `permission.bash: "allow"` into it. A kilo.json this run creates
 * where Kilo had no config at all would make a NEW user look like an old one and silently allow every bash command,
 * so in that case (and only then) the marker is written beside it, which is what Kilo itself writes for a new user. */
export function planKiloConfig({ home, proxyPath, pluginPath, env = process.env }) {
  const file = clientConfigFile(home, "kilo", env);
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  containerOf(config, ["mcp"])[SESSION_SERVER] = kiloServer(proxyPath);
  const url = pathToFileURL(pluginPath).href;
  const plugins = Array.isArray(config.plugin) ? config.plugin.filter((p) => !(typeof p === "string" && /opencadre-kilo-plugin\.js$/.test(p))) : [];
  config.plugin = [...plugins, url];
  const dir = kiloHome(home, env);
  const fresh = !existsSync(join(dir, KILO_BASH_MIGRATED)) && !existsSync(join(dir, "config"))
    && KILO_CONFIG_FILES.every((name) => !existsSync(join(dir, name)));
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n`, marker: fresh ? join(dir, KILO_BASH_MIGRATED) : null };
}

/** { file, before, after } for ~/.config/opencode/opencode.json mcp.servers["opencadre-session"]: the same
 * keyless stdio proxy, as OpenCode's `type: "local"` transport. OpenCode and Claude Code/Codex do not share
 * one MCP host - each app runs its own children - so the entry is written per tool even though the command
 * line is the same.
 *
 * THE SHAPE IS MEASURED, not taken from the docs (docs/design/HARNESS-OPENCODE-IDENTITY.md): v2.0.10 reads
 * servers under `mcp.servers` and a local server is `{ type: "local", command: [argv...] }` - `command` is an
 * ARRAY, not Claude Code's string `command` + `args`. The container is reached through `containerOf`, the
 * same key-path walk the named-agent writer and the reader use, so the two cannot drift onto different
 * shapes again. `refuseOpencodeComments` runs for the same reason it runs there: this writer cannot preserve
 * JSONC comments, so a `.jsonc` file is refused by name rather than silently rewritten or orphaned. */
export function planOpencodeSessionServer({ home, proxyPath }) {
  // The same resolver the named-agent writer and doctor use: a comment-free opencode.jsonc is the file written.
  const file = clientConfigFile(home, "opencode");
  const before = readText(file);
  refuseOpencodeComments(home, file);
  const config = parseJsonConfig(file, before);
  const servers = containerOf(config, ["mcp", "servers"]);
  servers[SESSION_SERVER] = { type: "local", command: ["node", ...sessionServerArgs(proxyPath, "opencode")], enabled: true };
  // The named-agent entry (if any) is keyed `opencadre` and stays exactly as it is: a named agent wins at
  // runtime, and removing it here would silently drop an identity the user set up on purpose.
  //
  // The OpenCadre plugin (mail that wakes an idle chat; clearance) is a folder installed beside the proxy. OpenCode
  // loads plugins listed under `plugins`, and an absolute path is allowed (opencode.ai/v2/docs/build/plugins).
  // Added once, beside whatever plugins the user already lists; an entry naming our folder is not duplicated.
  const pluginDir = opencodePluginDir(proxyPath);
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  const ours = (p) => typeof p === "string" && p.replaceAll("\\", "/").toLowerCase() === pluginDir.replaceAll("\\", "/").toLowerCase();
  if (!plugins.some(ours)) config.plugins = [...plugins, pluginDir];
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n` };
}

/** The OpenCadre plugin folder for OpenCode: `opencode-plugin/` beside the proxy in ~/.opencadre/bin (cli/lib/helpers.mjs). */
export const opencodePluginDir = (proxyPath) => join(dirname(proxyPath), "opencode-plugin");
