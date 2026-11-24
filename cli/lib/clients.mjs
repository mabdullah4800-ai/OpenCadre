import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseJsonConfig, readText } from "./files.mjs";

// A project path can differ lexically from its real, symlink-resolved form (macOS resolves /tmp ->
// /private/tmp and /var -> /private/var for a process actually cwd'd into a path under either). The
// reader side (scripts/opencadre-config.mjs's claudeCode()) resolves symlinks before comparing, so the
// key written here must match that canonical form -- otherwise a freshly-connected --project entry
// would never be found again, and a second connect from the same folder would create a duplicate key
// instead of reusing the first. Falls back to the lexical form when the path doesn't exist yet.
function realOrResolved(p) {
  const resolved = resolve(p);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Tools `connect` knows how to LOOK FOR on a machine. This list is about detection, not about
 * capability: a tool appears here when `present` below has a predicate for it, whether it is served
 * today or only being measured. Adding a client to the table in scripts/opencadre-clients.mjs
 * without adding it here leaves it undetectable, so `chooseMachineTools` can never mention it and
 * the "being measured" message the table exists to produce is unreachable. */
export const CLIENTS = ["claude-code", "codex", "cursor", "antigravity", "gemini", "grok", "opencode", "qwen", "amp", "kilo", "cline", "devin", "droid", "crush", "vibe", "goose", "copilot", "windsurf"];

// The one `CODEX_HOME` resolver (§9 item 7) lives with the client table, in scripts/. This file is on
// the cli/ side of that boundary, so it needs the same two-homes probe device.mjs uses: the packed CLI
// carries the module as a helper, and a checkout has no built helpers/ copy on purpose. It resolves at
// runtime and must fail LOUDLY, because the layout it fails in is the packed CLI -- the one a local
// run never exercises.
const stagedClients = fileURLToPath(new URL("../helpers/opencadre-clients.mjs", import.meta.url));
const inRepoClients = fileURLToPath(new URL("../../scripts/opencadre-clients.mjs", import.meta.url));
if (!existsSync(stagedClients) && !existsSync(inRepoClients)) {
  throw new Error(
    `opencadre: this install is incomplete - a required file (opencadre-clients.mjs) is missing. ` +
      `Reinstall opencadre to repair it. Searched: ${stagedClients} (packed CLI) and ${inRepoClients} (checkout).`,
  );
}
export const { ampHome, clineDirs, codexHome, copilotHome, crushHome, devinHome, droidHome, vibeHome, gooseDirs, grokHome, kiloHome, parseJsonc } = await import(existsSync(stagedClients) ? pathToFileURL(stagedClients).href : "../../scripts/opencadre-clients.mjs");

/** Finds an executable on PATH without spawning anything. On Windows only .exe/.cmd count:
 * the extensionless npm shim there is a POSIX shell script. */
export function findOnPath(name, env = process.env) {
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd"] : [""];
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, name + ext);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/** The claude binary as { command, args } runnable without a shell, or null. Node can't spawn a
 * .cmd shim shell-free on Windows, so an npm shim resolves to the program it wraps. */
export function claudeExecutable(env = process.env) {
  const found = findOnPath("claude", env);
  if (!found || !found.toLowerCase().endsWith(".cmd")) return found ? { command: found, args: [] } : null;
  const target = [...readFileSync(found, "utf8").matchAll(/"%dp0%\\([^"]+)"/g)].at(-1)?.[1];
  const file = target && join(dirname(found), target);
  if (!file || !existsSync(file)) return null;
  if (/\.exe$/i.test(file)) return { command: file, args: [] };
  return /\.[cm]?js$/i.test(file) ? { command: process.execPath, args: [file] } : null;
}

/** True when `file` (an `amp` found on PATH) is Amp's CLI rather than another program of the same name. */
function isAmpBinary(file) {
  if (!file) return false;
  try {
    return /ampcode|sourcegraph[\\/]amp/i.test(realpathSync.native(file));
  } catch {
    return false;
  }
}

export function detectClients(home, env = process.env) {
  const has = (...parts) => existsSync(join(home, ...parts));
  const present = {
    "claude-code": () => has(".claude.json") || Boolean(findOnPath("claude", env)),
    // Through the one resolver (§9 item 7): a relocated CODEX_HOME means ~/.codex does not exist, and a
    // detection that looked only there would report a working Codex install as absent.
    codex: () => existsSync(codexHome(home, env)),
    // OpenCadre creates ~/.cursor/mcp.json and hooks.json itself, so the folder alone is not
    // evidence that Cursor is installed. Keep explicit --client cursor available for custom installs.
    cursor: () => has(".cursor", "cli-config.json") ||
      (process.platform === "win32" && has("AppData", "Local", "Programs", "Cursor", "Cursor.exe")) ||
      Boolean(findOnPath("cursor", env) || findOnPath("cursor-agent", env)),
    antigravity: () => has(".gemini", "antigravity") || has(".gemini", "antigravity-cli") || Boolean(findOnPath("agy", env)),
    // Antigravity also creates ~/.gemini, so Gemini CLI is recognized by its own settings file or binary.
    gemini: () => has(".gemini", "settings.json") || Boolean(findOnPath("gemini", env)),
    // Grok Build keeps everything under ~/.grok (user guide ug-01, ug-05). Measured on this PC:
    // the directory does not exist and `grok` is not on PATH, so this predicate is DOCUMENTED-only
    // and currently always false here -- which is the honest state, not a bug.
    grok: () => has(".grok") || Boolean(findOnPath("grok", env)),
    // OpenCode's global config lives in ~/.config/opencode/opencode.json (docs.opencode.ai/docs/config,
    // verified 2026-09-19), on Windows too -- not an app-data directory. Either that folder or the
    // `opencode` binary on PATH is enough; a CLI-only install still ships the binary.
    opencode: () => has(".config", "opencode") || Boolean(findOnPath("opencode", env)),
    // Qwen Code keeps its user settings in ~/.qwen/settings.json (its bundle's `.qwen/settings.json`) and ships a
    // `qwen` binary.
    qwen: () => has(".qwen", "settings.json") || Boolean(findOnPath("qwen", env)),
    // Amp keeps its settings in ampHome's settings.json. Not the folder alone, and not any `amp` on PATH: the amp.rs
    // text editor also uses ~/.config/amp and ships an `amp` binary (review of 597af1c, S7). A binary counts only
    // when it resolves into Amp's own npm package.
    amp: () => existsSync(join(ampHome(home, env), "settings.json")) || isAmpBinary(findOnPath("amp", env)),
    // Kilo Code's CLI keeps its config under kiloHome. Not a `kilo` on PATH: the kilo text editor ships one too.
    kilo: () => existsSync(kiloHome(home, env)) || Boolean(findOnPath("kilocode", env)),
    // Cline's CLI creates ~/.cline (CLINE_DIR) on first run and ships a `cline` binary.
    cline: () => existsSync(clineDirs(home, env).root) || Boolean(findOnPath("cline", env)),
    // Devin CLI writes its config folder on first run and ships a `devin` binary.
    devin: () => existsSync(join(devinHome(home, env), "config.json")) || Boolean(findOnPath("devin", env)),
    // Factory Droid keeps ~/.factory and ships a `droid` binary.
    droid: () => existsSync(droidHome(home, env)) || Boolean(findOnPath("droid", env)),
    // Crush writes its global crush.json on first run and ships a `crush` binary.
    crush: () => existsSync(join(crushHome(home, env), "crush.json")) || Boolean(findOnPath("crush", env)),
    // Mistral Vibe writes ~/.vibe (VIBE_HOME) on first run and ships a `vibe` binary.
    vibe: () => existsSync(join(vibeHome(home, env), "config.toml")) || Boolean(findOnPath("vibe", env)),
    // Goose writes config.yaml on first run. Not the `goose` binary alone: pressly/goose, a database migration tool,
    // installs one too.
    goose: () => existsSync(join(gooseDirs(home, env).config, "config.yaml")),
    // Copilot CLI creates COPILOT_HOME (~/.copilot) on first run.
    copilot: () => existsSync(copilotHome(home, env)),
    // Windsurf keeps its user files under ~/.codeium/windsurf.
    windsurf: () => has(".codeium", "windsurf"),
  };
  return CLIENTS.filter((client) => present[client]());
}

// Each client spells the remote MCP URL field differently. `container` is the KEY PATH to the object
// holding the named servers: one segment for every client but OpenCode, two for OpenCode, which
// nests its servers under `mcp.servers`.
//
// OpenCode's shape was MEASURED against the installed binary (opencode v2.0.10), not taken from the
// docs - see docs/design/HARNESS-OPENCODE-IDENTITY.md:
//   { "mcp": { "servers": { "opencadre": { "type": "remote", "url", "headers" } } } }
// v2.0.10 does NOT read a name placed directly under `mcp`. The flat `mcp.opencadre` shape this code
// used before made `opencode mcp list` print "No MCP servers configured"; the nested shape prints
// "connected". A writer emitting the flat shape configures nothing on a v2 install, which is the
// whole reason this row is a path now.
//
// `enabled: true` was dropped at the same time: v2 replaced it with `disabled`, and a server with
// neither field connects. Writing `enabled` on v2 is inert, so the entry is just the transport.
const JSON_CLIENTS = {
  "claude-code": { path: [".claude.json"], container: ["mcpServers"], entry: (url, headers) => ({ type: "http", url, headers }) },
  cursor: { path: [".cursor", "mcp.json"], container: ["mcpServers"], entry: (url, headers) => ({ url, headers }) },
  // Antigravity: the documented ~/.gemini/config/mcp_config.json. agy 1.2.9 does not read the legacy
  // ~/.gemini/antigravity/mcp_config.json (measured), and neither does OpenCadre. A remote server is `serverUrl` + `headers`.
  antigravity: { path: [".gemini", "config", "mcp_config.json"], container: ["mcpServers"], entry: (url, headers) => ({ serverUrl: url, headers }) },
  gemini: { path: [".gemini", "settings.json"], container: ["mcpServers"], entry: (url, headers) => ({ httpUrl: url, headers }) },
  opencode: { path: [".config", "opencode", "opencode.json"], container: ["mcp", "servers"], entry: (url, headers) => ({ type: "remote", url, headers }) },
  // Qwen Code, a Gemini CLI fork: `mcpServers` in ~/.qwen/settings.json, a remote server named by `httpUrl`.
  // `alwaysLoadTools`: otherwise Qwen defers the server's tools behind its tool_search (measured live on 0.24.4).
  qwen: { path: [".qwen", "settings.json"], container: ["mcpServers"], entry: (url, headers) => ({ httpUrl: url, headers, alwaysLoadTools: true }) },
  // Amp: ONE top-level key whose name contains a dot, `"amp.mcpServers"` (VS Code-style settings), in
  // ~/.config/amp/settings.json; a remote server is `{ url, headers }`.
  amp: { path: [".config", "amp", "settings.json"], container: ["amp.mcpServers"], entry: (url, headers) => ({ url, headers }) },
  // Cline's CLI: `mcpServers` in ~/.cline/data/settings/cline_mcp_settings.json; a remote server is
  // `{ type: "streamableHttp", url, headers }` (no `type` means legacy SSE).
  cline: { path: [".cline", "data", "settings", "cline_mcp_settings.json"], container: ["mcpServers"], entry: (url, headers) => ({ type: "streamableHttp", url, headers }) },
  // Kilo Code's CLI: `mcp` in ~/.config/kilo/kilo.json, OpenCode's pre-v2 shape (one level, not `mcp.servers`; measured
  // on 7.7.9); a remote server is `{ type: "remote", url, headers }`.
  kilo: { path: [".config", "kilo", "kilo.json"], container: ["mcp"], entry: (url, headers) => ({ type: "remote", url, headers }) },
  // Copilot CLI: `mcpServers` in (COPILOT_HOME or ~/.copilot)/mcp-config.json; a remote server is `type: "http"`, and
  // `tools: ["*"]` exposes all of its tools.
  copilot: { path: [".copilot", "mcp-config.json"], container: ["mcpServers"], entry: (url, headers) => ({ type: "http", url, headers, tools: ["*"] }) },
  // Windsurf: `mcpServers` in ~/.codeium/windsurf/mcp_config.json; a remote server is `serverUrl` + `headers`.
  windsurf: { path: [".codeium", "windsurf", "mcp_config.json"], container: ["mcpServers"], entry: (url, headers) => ({ serverUrl: url, headers }) },
};

/** Walks a key path (["mcp","servers"] -> config.mcp.servers), creating missing objects on the way.
 * An existing non-object where a segment should be is replaced: it can only be a broken config, and
 * leaving it would make the write throw somewhere the caller cannot act on. Used by both the writer
 * and the reader so a path means the same thing on both sides - the drift that let the old reader
 * look in `mcp` while the writer later moved to `mcp.servers` is exactly what this prevents. */
const containerOf = (config, path) =>
  path.reduce((node, key) => {
    if (node[key] === null || typeof node[key] !== "object" || Array.isArray(node[key])) node[key] = {};
    return node[key];
  }, config);
export { containerOf };

/** Key path, per client, where a PREVIOUS version of this writer left `opencadre` and a current write
 * must clear it. OpenCode only: its container moved from the one-segment `mcp` to `mcp.servers`, so a
 * file written by the older code still carries `mcp.opencadre`. The reader finds that entry on
 * purpose (see readExistingServer), and this is the other half - the write removes it. A client that
 * never changed shape has no entry here, and nothing is deleted for a key we don't own. */
const LEGACY_CONTAINERS = { opencode: ["mcp"] };

/** The stdio entry the DEVICE path writes: a keyless server named `opencadre-session`, whose
 * credential lives in ~/.opencadre/credentials.json and is read by the proxy itself.
 *
 * It is declared HERE, in the lower module, rather than in device.mjs where it used to live, because
 * `readExistingServer` above must recognise it and device.mjs already imports this file — importing
 * back would be a cycle. device.mjs re-exports it so every existing importer keeps its path.
 *
 * One name, two containers: `mcpServers["opencadre-session"]` in a JSON client's config and
 * `[mcp_servers.opencadre-session]` in Codex's TOML. Both readers key on this constant, so the two
 * cannot spell it differently — which is exactly how the JSON clients came to miss it. */
export const SESSION_SERVER = "opencadre-session";

/** `env` is threaded through so a relocated CODEX_HOME is honoured here too (§9 item 7): this is the
 * path `connect` WRITES, so resolving it the default way is the defect the resolver exists to close.
 * The JSON clients' paths are home-relative and have no equivalent override, so they ignore it. */
export const clientConfigFile = (home, client, env = process.env) =>
  client === "codex" ? join(codexHome(home, env), "config.toml")
    : client === "opencode" ? opencodeConfigFile(home)
    : client === "amp" ? join(ampHome(home, env), "settings.json")
    : client === "kilo" ? join(kiloHome(home, env), "kilo.json")
    : client === "cline" ? clineDirs(home, env).mcp
    : client === "grok" ? join(grokHome(home, env), "config.toml")
    : client === "devin" ? join(devinHome(home, env), "mcp_config.json")
    : client === "droid" ? join(droidHome(home, env), "mcp.json")
    : client === "crush" ? join(crushHome(home, env), "crush.json")
    : client === "vibe" ? join(vibeHome(home, env), "config.toml")
    : client === "goose" ? join(gooseDirs(home, env).config, "config.yaml")
    : client === "copilot" ? join(copilotHome(home, env), "mcp-config.json")
    : join(home, ...JSON_CLIENTS[client].path);

/** Which OpenCode config file connect writes and doctor reads. `opencode.json` when it exists. Otherwise, when the
 * only config is `opencode.jsonc` and it holds PLAIN JSON (no comments, no trailing commas: JSON.parse accepts it),
 * that file: rewriting plain JSON loses nothing, and it is the file OpenCode reads. Measured 2026-09-23: OpenCode
 * v2.0.10 on the fleet PC had created a comment-free `opencode.jsonc`, and connect refused it by name, so OpenCode
 * could not be connected there at all. A `.jsonc` that really holds comments still resolves to `opencode.json`, and
 * refuseOpencodeComments stops the write there. */
export function opencodeConfigFile(home) {
  const json = join(home, ".config", "opencode", "opencode.json");
  const jsonc = join(home, ".config", "opencode", "opencode.jsonc");
  if (existsSync(json) || !existsSync(jsonc)) return json;
  return isPlainJsonObject(readText(jsonc)) ? jsonc : json;
}

const isPlainJsonObject = (text) => {
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, ""));
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
};

/** True when this client has a config file `planClientConfig` can write an entry into.
 *
 * This is NOT the same question as "is it a device client" or "is it being measured". Antigravity is
 * still measuring and is genuinely connectable with an oc_ (named-agent) code, as are the served Cursor,
 * Gemini CLI, OpenCode and Qwen Code, because someone wrote a writer for each. Grok is measuring and has
 * NO writer, so `planClientConfig` matches nothing in JSON_CLIENTS and throws "Cannot read properties
 * of undefined (reading 'path')" -- a raw TypeError where a refusal belongs.
 *
 * Callers must ask this before planning, so the absence of a writer is reported in words rather
 * than discovered as a crash. Kept as a predicate over the tables above rather than a hand-written
 * name list, so it cannot drift from what planClientConfig actually supports. */
export const hasConfigWriter = (client) => client === "codex" || Boolean(JSON_CLIENTS[client]);

/** Returns { file, before, after, warnings } for this client's opencadre MCP entry, without writing.
 * Throws when the existing file can't be parsed, so callers can check before spending a code.
 * With `project` (Claude Code only) the entry goes under that folder's projects entry instead of
 * the user-wide mcpServers, so a second agent on the same machine doesn't replace the first. */
export function planClientConfig({ home, client, hub, key, project }) {
  const file = clientConfigFile(home, client);
  const before = readText(file);
  const url = `${hub}/mcp`;
  if (client === "codex") return { file, before, ...mergeCodexToml(before, { url, hub, key }) };
  if (client === "opencode") refuseOpencodeComments(home, file);
  const config = parseJsonConfig(file, before);
  const { container, entry } = JSON_CLIENTS[client];
  const server = entry(url, { Authorization: `Bearer ${key}` });
  if (project) {
    const dir = claudeProjectKey(config, project);
    const current = config.projects?.[dir] ?? {};
    config.projects = { ...config.projects, [dir]: { ...current, mcpServers: { ...current.mcpServers, opencadre: server } } };
  } else {
    const target = containerOf(config, container);
    target.opencadre = server;
    // OpenCode only: a machine configured by the writer that predates the v2 measurement carries a
    // stale flat `mcp.opencadre` BESIDE the nested entry now (containerOf creates `mcp.servers` and
    // leaves the flat key alone). v2.0.10 ignores the flat shape, so leaving it would keep a second,
    // dead copy of the credential in the user's file. Deleting it is the migration the reader above
    // promises: it finds the flat entry so a reconnect reuses its key, and the write moves it where
    // v2 actually reads.
    if (LEGACY_CONTAINERS[client]) delete config[LEGACY_CONTAINERS[client]]?.opencadre;
  }
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n`, warnings: [] };
}

/** OpenCode also accepts JSONC, and its global config may be spelled `opencode.jsonc`. This CLI has no
 * comment-preserving writer. A PLAIN-JSON `.jsonc` is written directly (opencodeConfigFile resolves to it, and
 * `file` is then that path, so this check does nothing). A `.jsonc` that is not plain JSON (comments, trailing
 * commas) makes opencodeConfigFile resolve to `opencode.json` instead, and this refuses: rewriting it would delete
 * every comment, and writing `opencode.json` beside it would silently orphan it. Guarded on both files because only
 * when `opencode.json` does not exist is the `.jsonc` the file OpenCode reads. A comment INSIDE `opencode.json`
 * needs no special case: parseJsonConfig's JSON.parse throws "not valid JSON" for it, before anything is written. */
export function refuseOpencodeComments(home, file) {
  const jsonc = join(home, ".config", "opencode", "opencode.jsonc");
  if (existsSync(jsonc) && !existsSync(file)) {
    throw new Error(
      `${jsonc} is JSONC (it may hold comments), and OpenCadre will not rewrite it: doing so would delete your comments. ` +
        `Move its settings into ${file} (or remove the comments), then run the command again; nothing was changed.`,
    );
  }
}

/** Reuses the spelling of an existing projects entry for this folder (Claude Code has written both
 * C:\x and C:/x on Windows); a new entry uses forward slashes, as current Claude Code does. */
function claudeProjectKey(config, project) {
  const norm = (p) => (process.platform === "win32" ? realOrResolved(p).toLowerCase() : realOrResolved(p));
  const found = Object.keys(config.projects ?? {}).find((dir) => norm(dir) === norm(project));
  if (found) return found;
  return process.platform === "win32" ? realOrResolved(project).replace(/\\/g, "/") : realOrResolved(project);
}

// --- ~/.codex/config.toml, merged line by line (no TOML dependency) ----------------

const TABLE_HEADER = /^\s*\[\[?([^[\]]+)\]\]?\s*(#.*)?$/;
// [mcp_servers."opencadre"] and [ mcp_servers.opencadre ] name the same table.
const tableName = (line) =>
  line.match(TABLE_HEADER)?.[1].split(".").map((s) => s.trim().replace(/^(["'])(.*)\1$/, "$2")).join(".");

function splitTables(text) {
  const sections = [{ name: null, lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    const name = tableName(line);
    if (name === undefined) sections.at(-1).lines.push(line);
    else sections.push({ name, lines: [line] });
  }
  return sections;
}

const isOpencadreTable = (name) => name === "mcp_servers.opencadre" || Boolean(name?.startsWith("mcp_servers.opencadre."));

function joinSections(sections, eol) {
  const out = [];
  for (const s of sections) {
    if (s.name !== null && out.length > 0 && out.at(-1).trim() !== "") out.push("");
    out.push(...s.lines);
  }
  while (out.length > 0 && out[0].trim() === "") out.shift();
  while (out.length > 0 && out.at(-1).trim() === "") out.pop();
  return `${out.join(eol)}${eol}`;
}

/** Replaces OpenCadre's own entries of the TOML array of tables `arrayName` (`[[arrayName]]` sections for which
 * `isOurs(lines)` is true, with any `[arrayName.…]` subtables that belong to them) by `entries` (each a list of body
 * lines), appended at the end. Every other line stays exactly as it was. Mistral Vibe's `[[mcp_servers]]` and
 * `[[hooks]]`. */
export function mergeTomlArrayEntries(before, arrayName, isOurs, entries) {
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const kept = [];
  let dropping = false;
  for (const s of splitTables(before)) {
    const isEntry = s.name === arrayName && /^\s*\[\[/.test(s.lines[0] ?? "");
    if (isEntry) dropping = isOurs(s.lines);
    else if (!(s.name?.startsWith(`${arrayName}.`))) dropping = false;
    if (!dropping) kept.push(s);
  }
  for (const body of entries) kept.push({ name: arrayName, lines: [`[[${arrayName}]]`, ...body] });
  return joinSections(kept, eol);
}

/** Whether a TOML array of tables `arrayName` has an entry whose `name` is `name` (Vibe's `[[mcp_servers]]`). */
export function hasTomlArrayEntry(text, arrayName, name) {
  return splitTables(text).some((s) => s.name === arrayName && s.lines.some((l) => new RegExp(`^\\s*name\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(l)));
}

// --- Goose's config.yaml: one entry under a top-level block mapping, merged line by line (no YAML dependency) -----

/** Replaces (or adds) the entry `childKey` under the top-level mapping `topKey` of a block-style YAML document, leaving
 * every other line exactly as it was. `entryLines` are the entry as written at column 0 (`key:` then its body indented
 * by two spaces); they are re-indented to the mapping's own indent. Only the shape Goose itself writes is edited: a
 * block mapping under `topKey`, or none at all, or `topKey: {}`. Anything else (flow style, tabs, a sequence) throws,
 * so the caller can say what to add by hand rather than risk a broken config. */
export function mergeYamlMapEntry(before, topKey, childKey, entryLines) {
  const refuse = (why) => {
    throw new Error(`cannot add ${childKey} under "${topKey}" in this YAML file automatically (${why})`);
  };
  // A byte-order mark hides the first key from the line matcher, and a second `extensions:` makes serde_yaml reject
  // the WHOLE file, so Goose would ignore the user's provider and model too (review of d6a7ef7, S5).
  if (before.startsWith("\uFEFF")) refuse("it starts with a byte-order mark");
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const lines = before.length ? before.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
  if (lines.some((l) => /^\t|^ *\t/.test(l))) refuse("it is indented with tabs");
  const escaped = topKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heads = lines.flatMap((l, i) => (new RegExp(`^["']?${escaped}["']?\\s*:`).test(l) ? [i] : []));
  if (heads.length > 1) refuse(`"${topKey}" appears more than once`);
  const head = heads.length ? heads[0] : -1;
  const block = (indent) => entryLines.map((l) => (l ? `${" ".repeat(indent)}${l}` : l));
  if (head === -1) {
    const out = [...lines];
    while (out.length && out.at(-1).trim() === "") out.pop();
    out.push(`${topKey}:`, ...block(2));
    return `${out.join(eol)}${eol}`;
  }
  const rest = lines[head].replace(/^[^:]*:/, "").trim();
  if (rest && !/^\{\s*\}\s*(#.*)?$/.test(rest) && !/^#/.test(rest)) refuse(`"${topKey}" is not a block mapping`);
  if (rest.startsWith("{")) lines[head] = `${topKey}:`;
  // The mapping's own lines: indented or blank, up to the next line at column 0 that is not a comment.
  let end = head + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]) || /^#/.test(lines[end]))) end++;
  const body = lines.slice(head + 1, end);
  const first = body.find((l) => l.trim() !== "" && !/^\s*#/.test(l));
  const indent = first ? first.length - first.trimStart().length : 2;
  if (first && /^\s*-(\s|$)/.test(first)) refuse(`"${topKey}" holds a list`);
  const keyRe = new RegExp(`^ {${indent}}["']?${childKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:`);
  let at = body.findIndex((l) => keyRe.test(l));
  let drop = 0;
  if (at !== -1) {
    drop = 1;
    while (at + drop < body.length && (body[at + drop].trim() === "" || body[at + drop].length - body[at + drop].trimStart().length > indent)) drop++;
    // Blank lines that trailed the old entry belong between entries, not to it.
    while (drop > 1 && body[at + drop - 1].trim() === "") drop--;
  } else {
    at = body.length;
    while (at > 0 && (body[at - 1].trim() === "" || /^#/.test(body[at - 1]))) at--;
  }
  body.splice(at, drop, ...block(indent));
  const out = [...lines.slice(0, head + 1), ...body, ...lines.slice(end)];
  return `${out.join(eol)}${eol}`;
}

/** Replaces one table (`name`, with any subtables) wholesale, in place, or appends it; every other line stays. An inline
 * definition of the same key under its parent table is dropped, since TOML forbids defining it twice. */
export function mergeTomlTable(before, name, bodyLines) {
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const ours = (n) => n === name || Boolean(n?.startsWith(`${name}.`));
  let sections = splitTables(before);
  const at = sections.findIndex((s) => ours(s.name));
  sections = sections.filter((s) => !ours(s.name));
  const parent = name.slice(0, name.lastIndexOf("."));
  const leaf = name.slice(name.lastIndexOf(".") + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const s of sections) {
    if (s.name === parent) s.lines = s.lines.filter((l) => !new RegExp(`^\\s*["']?${leaf}["']?\\s*[=.]`).test(l));
  }
  sections.splice(at < 0 ? sections.length : at, 0, { name, lines: [`[${name}]`, ...bodyLines] });
  return joinSections(sections, eol);
}

/** The opencadre server table (and any subtables) is replaced wholesale, in place. TOML forbids
 * defining a table twice, so existing definitions are reused, never added.
 *
 * THE KEY IS NOT EXPORTED TO THE SHELL — a deliberate change from earlier behaviour
 * (HARNESS-CODEX.md §9 item 8, 2026-09-20). This function used to add
 *
 *     [shell_environment_policy.set]
 *     OPENCADRE_URL = "…"
 *     OPENCADRE_KEY = "agt_…"
 *
 * so hooks and wake scripts would find the hub. Everything under that table is forwarded to every
 * command Codex runs, so the agent's own key became readable by any `env` the model executed — a
 * credential exposure, not a convenience.
 *
 * AND IT WAS NOT EVEN THE ONLY COPY. Measured against the real binary on the fleet PC
 * (`codex sandbox -c … cmd /c set`, 2026-09-20, codex-cli 0.155.1): with `OPENCADRE_KEY` in the
 * PARENT environment, it reaches a spawned command under the DEFAULT policy. The vendor's
 * `ignore_default_excludes` name filter (KEY/SECRET/TOKEN) is **opt-in** — it fires only when set to
 * `false`, or when the name is listed under `filters`. So the name alone was never protected, and
 * this table did not defeat a guard: it added a second copy of a value that was already forwarded.
 *
 * That correction is recorded because the first draft of this comment claimed the opposite — that we
 * had overridden Codex's built-in protection — on the strength of a real doc quote with an inference
 * stacked on top that nobody had driven. The exposure is as serious either way; the mechanism decides
 * the remedy, and there is no vendor protection to restore here.
 *
 * NOTHING NEEDS IT. Every consumer resolves through `resolveNamedAgent`
 * (scripts/opencadre-config.mjs), whose order is: the env pair, ELSE the reader for this client —
 * which reads this very function's `http_headers` — ELSE a bare env key. So the hooks, the approval
 * gate and the wake script all find the same key with the env absent. session-hooks.mjs states the
 * intent in its own header: the hooks "find the key in the client's own MCP config at run time".
 *
 * A file that already carries the pair is CLEANED rather than left, so an existing install stops
 * leaking on its next connect rather than only new ones. Other variables under `set` are preserved
 * untouched — only OpenCadre's own two keys are removed. */
export function mergeCodexToml(before, { url, hub, key }) {
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  // These values need no escaping beyond what JSON and TOML basic strings share.
  const str = (s) => JSON.stringify(s);
  const warnings = [];

  let sections = splitTables(before);
  const at = sections.findIndex((s) => isOpencadreTable(s.name));
  sections = sections.filter((s) => !isOpencadreTable(s.name));
  // An inline `opencadre = { ... }` under [mcp_servers] would collide with the table.
  for (const s of sections) {
    if (s.name === "mcp_servers") s.lines = s.lines.filter((l) => !/^\s*["']?opencadre["']?\s*[=.]/.test(l));
  }
  sections.splice(at < 0 ? sections.length : at, 0, {
    name: "mcp_servers.opencadre",
    lines: [
      "[mcp_servers.opencadre]",
      `url = ${str(url)}`,
      `http_headers = { "Authorization" = ${str(`Bearer ${key}`)} }`,
      "tool_timeout_sec = 300",
    ],
  });

  // Remove OpenCadre's own keys from the shell environment, wherever they are.
  //
  // `hub` is now unused for writing and stays in the signature on purpose: every caller passes it,
  // and a future reader should not have to work out whether the hub is still needed here.
  const isOurs = (l) => /^\s*["']?OPENCADRE_(URL|KEY)["']?\s*=/.test(l);
  const setTable = sections.find((s) => s.name === "shell_environment_policy.set");
  const policy = sections.find((s) => s.name === "shell_environment_policy");
  if (setTable) {
    const rest = setTable.lines.slice(1).filter((l) => !isOurs(l));
    if (setTable.lines.some(isOurs)) {
      warnings.push("~/.codex/config.toml had OPENCADRE_URL and OPENCADRE_KEY under [shell_environment_policy.set]; they were removed, because that table is forwarded to every command the model runs. The hooks read the key from this file's [mcp_servers.opencadre] table instead.");
    }
    // Drop the table entirely when nothing else was in it, rather than leaving an empty header. The
    // test is for a non-BLANK line, not for a non-empty array: the file's trailing newline leaves a
    // `""` in `rest`, so `rest.length > 0` was true for a table that held only our keys and the empty
    // header survived (measured, by tracing `rest` — it was `[""]`).
    setTable.lines = rest.some((l) => l.trim() !== "") ? [setTable.lines[0], ...rest] : [];
  } else if (policy?.lines.some((l) => /^\s*set\s*[=.]/.test(l)) && /OPENCADRE_(URL|KEY)/.test(policy.lines.join("\n"))) {
    // Inline form: no line-wise way to remove one key from a `set = { … }`, so report it rather than
    // assume it is fine. Silently leaving a key exposed is the failure this whole change is about.
    warnings.push("~/.codex/config.toml defines OPENCADRE_URL or OPENCADRE_KEY inside an inline shell_environment_policy.set, which this command does not rewrite; remove them by hand so the key is not forwarded to every command Codex runs.");
  }

  return { after: joinSections(sections, eol), warnings };
}

/** This client's user-wide opencadre entry as { found, url, key, table }, or { found: false }; never log the key.
 * Unreadable config counts as none: planClientConfig reports the parse error before any code is spent.
 *
 * TWO KEYS can hold it, and they mean different things — the same pair `readCodexServer` reads out of
 * a TOML config, one container over:
 *   opencadre          the NAMED-AGENT entry: an agent key in its Authorization header
 *   opencadre-session  the SESSION entry the device path writes (device.mjs planSessionServer):
 *                      keyless by design, the credential lives in ~/.opencadre/credentials.json
 *
 * Reading only the first made `doctor` report not_connected on a computer the device path had just
 * connected. That is neither hypothetical nor new: the identical defect was found and fixed for
 * CODEX on 2026-09-18 (measured), and the fix was never carried across to this reader — so every
 * JSON client kept it, including Claude Code, the launch-critical one. Measured again 2026-09-19:
 * `claude mcp list` reported `opencadre-session … Connected` while this function returned
 * { found: false }, because the entry lives at mcpServers["opencadre-session"].
 *
 * The session entry wins when both are present, for the same reason the codex reader gives: it is
 * what the device path writes and what chats actually use, so a machine carrying both is
 * mid-migration. `table` names which was found, so a caller can describe the identity model rather
 * than infer it from a missing key. */
export function readExistingServer({ home, client }) {
  const file = clientConfigFile(home, client);
  const text = readText(file);
  if (!text.trim()) return { found: false };
  if (client === "codex") return readCodexServer(text);
  if (client === "goose") return readGooseServer(text);
  // Vibe's config.toml has a `[[mcp_servers]]` array of tables, each named by `name`.
  if (client === "vibe") return hasTomlArrayEntry(text, "mcp_servers", SESSION_SERVER) ? { found: true, table: SESSION_SERVER, sessionServer: true } : { found: false };
  // Grok's config.toml has Codex's `[mcp_servers.<name>]` tables.
  if (client === "grok") return readCodexServer(text);
  // Devin's mcp_config.json: `mcpServers`, session entry only (no named-agent writer for Devin).
  if (client === "devin" || client === "droid" || client === "crush") {
    try {
      // Devin reads its config files as JSON with comments; Droid's mcp.json is `mcpServers` too; Crush's is `mcp`.
      const parsed = parseJsonc(text);
      const entry = (client === "crush" ? parsed?.mcp : parsed?.mcpServers)?.[SESSION_SERVER];
      return entry && typeof entry === "object" ? { found: true, table: SESSION_SERVER, sessionServer: true } : { found: false };
    } catch {
      return { found: false };
    }
  }
  let servers;
  try {
    // The writer's own key path, walked without creating anything: a missing intermediate segment
    // means "no entry", not "make one". THE WALK IS KEPT rather than replaced by a direct index,
    // because OpenCode needs the LEGACY fallback below.
    // A leading byte-order mark is dropped, as parseJsonConfig does, so the reader and the writers agree on the same
    // file (Codex-OpenCadre-8160 on 161495b: a BOM .jsonc with an entry read as "not configured").
    const parsed = JSON.parse(text.replace(/^﻿/, ""));
    let node = parsed;
    for (const key of JSON_CLIENTS[client].container) {
      node = node && typeof node === "object" ? node[key] : undefined;
    }
    servers = node;
    // A machine set up by the writer that PREDATES the v2 measurement still carries the flat
    // `mcp.opencadre` shape. v2.0.10 ignores that shape, but the entry is still the user's existing
    // OpenCadre configuration, and answering "not found" would make `connect` call the machine
    // unconfigured and spend a fresh code beside the stale entry. Reading it lets the next write
    // replace it with the nested form - which is the migration.
    //
    // Folded INTO `servers` rather than returned directly: everything below reads
    // `servers[SESSION_SERVER]` / `servers.opencadre`, and a second return path here would be a
    // second definition of "found" to keep in step with this one.
    const legacy = LEGACY_CONTAINERS[client];
    if (legacy && !servers?.opencadre) {
      const flat = legacy.reduce((n, key) => n?.[key], parsed)?.opencadre;
      if (flat) servers = { ...(servers ?? {}), opencadre: flat };
    }
  } catch {
    return { found: false };
  }
  const session = servers?.[SESSION_SERVER];
  const named = servers?.opencadre;
  const entry = session ?? named;
  if (!entry || typeof entry !== "object") return { found: false };
  // A session entry is KEYLESS BY DESIGN, so it is "found" without an Authorization header — the
  // same rule readCodexServer applies. `sessionServer` lets a caller say so rather than report
  // "key present: no" as though something were missing.
  if (entry === session) return { found: true, table: SESSION_SERVER, sessionServer: true, url: entry.url };
  const auth = Object.entries(entry.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  return { found: true, table: "opencadre", url: entry.url ?? entry.serverUrl ?? entry.httpUrl, key: typeof auth === "string" ? auth.match(/Bearer\s+(\S+)/)?.[1] : undefined };
}

/** OpenCadre's session entry in Goose's config.yaml, read as text (no YAML dependency): an `opencadre-session:` key
 * indented under `extensions:` whose block runs OpenCadre's proxy. Goose has no named-agent entry. */
export function readGooseServer(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const head = lines.findIndex((l) => /^["']?extensions["']?\s*:/.test(l));
  if (head === -1) return { found: false };
  for (let i = head + 1; i < lines.length && (lines[i].trim() === "" || /^\s|^#/.test(lines[i])); i++) {
    if (!new RegExp(`^\\s+["']?${SESSION_SERVER}["']?\\s*:`).test(lines[i])) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    let j = i + 1;
    const body = [];
    while (j < lines.length && (lines[j].trim() === "" || lines[j].length - lines[j].trimStart().length > indent)) body.push(lines[j++]);
    const block = body.join("\n");
    if (!/opencadre-mcp\.mjs/.test(block)) return { found: false };
    return { found: true, table: SESSION_SERVER, sessionServer: true, disabled: /^\s*enabled\s*:\s*false\b/m.test(block) };
  }
  return { found: false };
}

/** The OpenCadre server table of a Codex config.toml as { found, table, url, key }; never log the key.
 *
 * TWO tables can hold it, and they mean different things:
 *   [mcp_servers.opencadre]          the NAMED-AGENT entry: an agent key in http_headers
 *   [mcp_servers.opencadre-session]  the SESSION entry the device path writes (device.mjs
 *                                    planCodexSessionServer): keyless by design, the credential
 *                                    lives in ~/.opencadre/credentials.json
 * Reading only the first made `doctor` report not_connected on a computer the device path had
 * just connected (measured 2026-09-18), because the device entry was invisible to it. So both
 * are looked for here and `table` says which was found, letting callers describe the identity
 * model instead of guessing it from a missing key.
 *
 * The session table wins when both are present: it is the one the sprint path writes, and a
 * machine carrying both is mid-migration -- the session entry is what its chats actually use. */
export function readCodexServer(text) {
  const sections = splitTables(text);
  const named = sections.find((s) => s.name === "mcp_servers.opencadre");
  const session = sections.find((s) => s.name === "mcp_servers.opencadre-session");
  const table = session ?? named;
  if (!table) return { found: false };
  const body = table.lines.slice(1).join("\n");
  return {
    found: true,
    table: table.name,
    named: Boolean(named),
    url: body.match(/^\s*url\s*=\s*["']([^"']+)["']/m)?.[1],
    key: body.match(/Bearer\s+([\w-]+)/)?.[1],
  };
}
