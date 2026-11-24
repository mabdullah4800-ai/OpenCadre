// Finds this agent's hub URL and key. Zero dependencies; shared by opencadre-wake.mjs, the
// session hooks and the per-session MCP proxy so every client resolves its identity the same way.
//
//   resolveHub({ client, cwd, home, env, sessionId, hostSessionId, create })
//     -> { base, key, source, headers } or {} when nothing is configured
//
// Order:
//   1. OPENCADRE_URL + OPENCADRE_KEY.
//   2. A named agent (agt_ key) in the client's own MCP config (client may be a list, tried in
//      order), so a machine running several clients never hands one client another's identity.
//      With no client, Antigravity's config is read (the wake script's original behaviour). A key
//      with no URL anywhere targets the public hub.
//   3. This computer's credential (~/.opencadre/credentials.json; for Claude Code and Codex, or an
//      older per-tool entry for that tool), ONLY when the tool session is known (sessionId, else
//      CLAUDE_CODE_SESSION_ID). `headers` then names the session and its project (the git remote,
//      see projectIdentity), so the hub resolves the request to that session's own agent, in a
//      project the workspace has enabled. Without a session id there is no identity to act as, so
//      nothing is returned: never guess.
//   4. {}
// `headers` is {} for a named agent; always spread it into the request headers.
//
// Device headers are resolve-only by default (X-OpenCadre-Resolve-Only: 1): the hub then answers only
// for a session that already exists and never creates one (401 NO_SESSION_ERROR). Hooks rely on that,
// so a process without an MCP proxy (a desktop helper process) never brings an agent into being. Only
// the proxy, the connect-time join and the explicit session commands create, with `create: true`.
//
// Never log the returned key or credential.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ampHome, clineDirs, codexHome, copilotHome, COMPUTER_TOOLS, crushHome, vibeHome, devinHome, droidHome, grokHome, kiloHome, parseJsonc, READER_NAMES, readerFor, seatScopeFor, sessionIdSourceFor } from "./opencadre-clients.mjs";

const PUBLIC_HUB = "https://hub.opencadre.example";

const readText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const readJson = (file) => {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
};

const readJsonc = (file) => parseJsonc(readText(file));
const bearer = (auth) => (typeof auth === "string" ? auth.match(/^\s*Bearer\s+(\S+)/)?.[1] : undefined);

// A project folder's path can differ lexically from process.cwd() for the exact same real directory
// purely because of an OS symlink (macOS resolves /tmp -> /private/tmp and /var -> /private/var when a
// process is actually cwd'd into a path under either; a plain path.resolve() never follows symlinks).
// Without this, a named-agent override configured for a project under a symlinked path silently never
// matches, and the fail-closed guarantee (docs/design/SESSION_MODEL.md) falls through instead of holding.
// Falls back to the lexical form when the path doesn't exist yet (nothing to resolve against).
function realOrResolved(p) {
  const resolved = resolve(p);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

// [mcp_servers.opencadre] with url = "..." and http_headers = { Authorization = "Bearer agt_..." }.
function codex(home) {
  // Through the one resolver, so a relocated CODEX_HOME is read as well as written (§9 item 7).
  const lines = readText(join(codexHome(home), "config.toml")).split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[\s*mcp_servers\.("?)opencadre\1\s*\]/.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^\s*\[(?!\s*mcp_servers\.("?)opencadre\1\.)/.test(l));
  const table = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  return { url: table.match(/^\s*url\s*=\s*["']([^"']+)["']/m)?.[1], key: bearer(table.match(/Bearer\s+[\w-]+/)?.[0]) };
}

// mcpServers.opencadre: the project enclosing cwd (nearest first), then user scope.
function claudeCode(home, cwd) {
  const config = readJson(join(home, ".claude.json"));
  if (!config) return null;
  const norm = (p) => (process.platform === "win32" ? realOrResolved(p).toLowerCase() : realOrResolved(p));
  // This folder's own agent, else the nearest parent folder's, else the user-wide one. Never another project's:
  // a session in an unrelated project must not act as (and read the mail of) an agent connected somewhere else.
  const projects = Object.entries(config.projects ?? {});
  const within = (dir) => {
    const d = norm(dir);
    const c = norm(cwd);
    return c === d || c.startsWith(d.endsWith(sep) ? d : d + sep);
  };
  const enclosing = projects.filter(([dir]) => within(dir)).sort(([a], [b]) => norm(b).length - norm(a).length);
  const candidates = [...enclosing.map(([, p]) => p.mcpServers), config.mcpServers];
  const server = candidates.map((servers) => servers?.opencadre).find((s) => s?.url && bearer(s.headers?.Authorization));
  return server ? { url: server.url, key: bearer(server.headers.Authorization) } : null;
}

// Antigravity's mcp_config.json names the endpoint serverUrl (or url); a missing URL means the public hub. Only the
// documented file (~/.gemini/config): agy 1.2.9 does not read the legacy ~/.gemini/antigravity/mcp_config.json
// (measured: `agy mcp list` shows nothing from it, and a server listed only there never starts), so a named agent
// found only there is one Antigravity never loads, and must not make the session server stand down (review of
// d790104, S2). Doctor names a legacy-only entry.
function antigravity(home) {
  for (const sub of [join(".gemini", "config", "mcp_config.json")]) {
    const s = readJson(join(home, sub))?.mcpServers?.opencadre;
    const key = bearer(s?.headers?.Authorization || s?.headers?.authorization);
    if (key) return { url: s.serverUrl || s.url || PUBLIC_HUB, key };
  }
  return null;
}

// Cursor's GLOBAL ~/.cursor/mcp.json mcpServers.opencadre: the named agent an older `connect --code oc_` wrote there.
// Only the global file: a project's .cursor/mcp.json arrives with a repository someone else wrote, and reading a key
// from it would let that repository choose which hub this chat talks to.
function cursor(home) {
  const s = readJson(join(home, ".cursor", "mcp.json"))?.mcpServers?.opencadre;
  const key = bearer(s?.headers?.Authorization || s?.headers?.authorization);
  return key && typeof s.url === "string" ? { url: s.url, key } : null;
}

// Gemini CLI's user settings (~/.gemini/settings.json) mcpServers.opencadre, the named agent `connect --code oc_` writes
// (httpUrl + Authorization). User file only, for the same reason as Cursor's.
function gemini(home) {
  const s = readJson(join(home, ".gemini", "settings.json"))?.mcpServers?.opencadre;
  const key = bearer(s?.headers?.Authorization || s?.headers?.authorization);
  const url = s?.httpUrl || s?.url;
  return key && typeof url === "string" ? { url, key } : null;
}

/** The exact names a PROJECT-LOCAL reasonix.toml may pull out of the environment.
 *
 * A project file is ATTACKER-CONTROLLED in the sense that matters: it arrives with a repository
 * someone else wrote, and it is read by whoever clones that repository. The file already chose where
 * the Authorization header goes (its own `url`); without this list it ALSO chose which of the
 * machine's environment variables went into that header, by writing `${NAME}` for any name at all.
 * The two together are an exfiltration primitive: a repo holding nothing but a reasonix.toml naming
 * `https://evil.example/mcp` and `Bearer ${ANY_SECRET}` sends ANY_SECRET's value to its own host.
 * Measured for board task 1aea98d5, both callsites, before this list existed.
 *
 * EXACT NAMES, not a prefix, and the difference is the whole control. The first version of this
 * matched `name.startsWith("OPENCADRE_")` on the reasoning that OPENCADRE_ "is the namespace the
 * tool owns" - which is not a property of a namespace, it is a property of the names IN it. A prefix
 * admits every name that HAPPENS to begin with those ten characters, including ones a session may
 * genuinely carry: OPENCADRE_STRIPE_SECRET_KEY, OPENCADRE_GITHUB_TOKEN, OPENCADRE_ANTHROPIC_API_KEY.
 * A cloned repo naming any of those is handed the value by exactly the mechanism this list exists to
 * stop, so the prefix version narrowed the hole and then reported it closed. Caught by FFH9's review
 * of the PR; the names below are the ones a config in this repo actually writes.
 *
 * THIS IS NOT THE WHOLE CONTROL, and the gap is deliberate rather than overlooked: OPENCADRE_KEY is
 * itself in the allowlisted set, so a project file that names `${OPENCADRE_KEY}` is still handed
 * that value whenever it is present in the process environment. Measured absent from a plain
 * `node -e` on this box, so the channel is not ambient - but it is set for any process the fleet's
 * own launch path exports it into. Restricting the project candidate to its own directory's .env
 * would close that too; it is a wider behaviour change than the allowlist and is left to be decided
 * rather than adopted silently here. */
export const PROJECT_CONFIG_ENV_ALLOWED = new Set(["OPENCADRE_URL", "OPENCADRE_KEY"]);

/** True for the two names above and nothing else - see PROJECT_CONFIG_ENV_ALLOWED for why a prefix
 *  would not do. Exported as a predicate so callers do not each re-derive the membership test. */
export const projectConfigEnvAllowed = (name) => PROJECT_CONFIG_ENV_ALLOWED.has(name);

/** An expand bound to the allowlisted names only, for a file that did not ship with this tool. */
export function projectExpand(base) {
  return (name) => (projectConfigEnvAllowed(name) ? base(name) : undefined);
}

// Reasonix stores MCP servers as TOML [[plugins]] entries, and a project ./reasonix.toml WINS over the
// machine-wide config. That precedence is what gives a folder its own agent, so cwd is read first -
// the same nearest-file-wins order Reasonix itself applies. Only the http "opencadre" entry is a named
// agent; the keyless stdio "opencadre-session" entry the machine credential installs is not one.
// Each candidate carries the ${VAR} source of the DIRECTORY IT LIVES IN: a project file expands from
// the process environment plus ./ .env, and each machine-wide root from its own home's .env.
//
// WHICH NAMES, not only which file, is the other half of that, and only the project candidate is
// narrowed: see projectConfigEnvAllowed() above. The machine-wide roots below are this tool's own
// install, expand their local names out of their own home .env, and keep the unrestricted expand.
//
// This used to bind ONE expand - reasonixEnv(roots[0]) - for every candidate. The ordered list exists
// precisely because the config that wins may be roots[1], so a config at ~/.reasonix/config.toml was
// reading its variables out of ~/.config/reasonix/.env: a different install's file, on the machines
// where both exist. Per-directory is also the only rule here with no special case to state.
//
// Exported so the pairing can be asserted directly. ${VAR} resolution is invisible to a caller that
// supplies none, so a reader that read the wrong .env would pass every end-to-end test that used a
// literal key - which is what let this sit unnoticed. The pair is the testable thing.
export function reasonixCandidates(home, cwd, env = process.env, platform = process.platform) {
  const roots = reasonixRoots(home, env, platform);
  return [
    ...(cwd ? [[join(cwd, "reasonix.toml"), projectExpand(reasonixEnv(cwd))]] : []),
    ...roots.map((root) => [join(root, "config.toml"), reasonixEnv(root)]),
  ];
}

function reasonix(home, cwd) {
  for (const [file, expand] of reasonixCandidates(home, cwd)) {
    const found = reasonixPlugin(readText(file), expand);
    if (found) return found;
  }
  return null;
}

// Reasonix home is not under the POSIX home layout on Windows (%APPDATA%\Reasonix), so unlike the
// other readers this one cannot simply join(home, ...). REASONIX_HOME wins, then the platform default.
// Ordered, XDG first: every entry is a directory a config MAY live in. Exported because the lock
// doctor needs the SET rather than a preference -- it sweeps a lock family under the config root as
// well as under ~/.reasonix/locks -- and was otherwise carrying its own copy of this rule.
//
// The POSIX order is chosen by CONVENTION (XDG first, ~/.reasonix as the legacy fallback), NOT
// measured from Reasonix itself: the desktop install exposes no code to read, and no caller here has
// observed which of the two Reasonix actually opens. On this repo's Windows machines the question is
// moot -- the config lives in %APPDATA%\Reasonix and ~/.reasonix holds only lock files.
//
// THIS LIST IS THE ORDER, not a set: the hook's reasonixHome() derives the single home from it (the
// first candidate that exists) and the reader walks it in order, so the two cannot disagree again.
// Until that unification the hook took ~/.reasonix first and the reader ~/.config/reasonix first, and
// the fleet's check for that divergence compared a home it derived itself against one the hook derived,
// so the two agreed only for as long as the copies happened to match.
//
// `platform` is a parameter, not process.platform read inline, so BOTH arms are reachable from
// either OS. A guard that only runs on the platform it describes is skipped everywhere the fleet
// actually verifies, and an arm nobody runs is not evidence about the other one.
export function reasonixRoots(home, env = process.env, platform = process.platform) {
  if (env.REASONIX_HOME) return [env.REASONIX_HOME];
  if (platform === "win32") return [join(env.APPDATA || join(home, "AppData", "Roaming"), "Reasonix")];
  return [join(home, ".config", "reasonix"), join(home, ".reasonix")];
}

// Reasonix expands ${VAR} in its own config from the environment and its home .env supplies the values,
// so a key written as ${OPENCADRE_KEY} is the expected form rather than an exotic one - and a reader
// that only saw process.env would silently miss the ordinary case. Process env wins, as in Reasonix.
function reasonixEnv(root) {
  const map = new Map();
  for (const line of readText(join(root, ".env")).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) map.set(m[1], m[2].trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return (name) => process.env[name] ?? map.get(name);
}

/** A line that begins a NEW table, ending the current [[plugins]] element.
 *
 * Reasonix REWRITES its own config into canonical form on load, turning an inline
 * `headers = { Authorization = "Bearer …" }` into a `[plugins.headers]` SUB-table. "The block runs
 * to the next top-level header" is therefore the wrong rule: it ends the block AT that sub-table,
 * the Bearer lookup below finds nothing, and this reader returns null - silently, with the caller
 * seeing only "no agent configured for this client". A `[plugins.…]` sub-table belongs to THIS
 * plugin; anything else ends it.
 *
 * Leading whitespace is TOLERATED, in both halves, and that is load-bearing rather than tidiness.
 * This rule's whole job is to agree with the entry matcher above about where one plugin stops and
 * the next begins; that matcher accepts an INDENTED `[[plugins]]` (`/^\s*\[\[plugins\]\]\s*$/`), so a
 * rule anchored at column 0 does not end the block at an indented neighbour. The block then runs on,
 * the `name = "opencadre"` test matches the LATER plugin, and the url/Bearer lookups below return the
 * FIRST ones in the joined block - i.e. this reader hands its caller a NEIGHBOURING plugin's url and
 * key as the opencadre identity, which is the exact misattribution every reader in this file exists
 * to prevent. Measured with a two-plugin document, both forms: flush returns the right plugin,
 * indented returned {"url":"https://other.example","key":"OTHERKEY"}. Bounded by the indented
 * arm of "takes opencadre's own sub-table, never a neighbouring plugin's" below.
 *
 * Same defect and same fix as the copy that used to live in scripts/reasonix-opencadre-hook.mjs. That
 * hook now imports reasonixPlugin() from here instead of carrying a second reader, because two
 * implementations of the thing that decides an agent's identity is how a session gets briefed as one
 * agent and woken as another. */
const startsNewTable = (line) => /^\s*\[/.test(line) && !/^\s*\[plugins\./.test(line);

/** The opencadre `[[plugins]]` entry of a Reasonix TOML document as { url, key }, or null.
 *
 * EXPORTED because it has a second caller: scripts/reasonix-opencadre-hook.mjs must resolve the
 * SAME identity the reader does, and it carried its own copy of this function. Two copies of a
 * parser that decides an agent's identity is how a session gets briefed as one agent and woken as
 * another - so there is one implementation and the hook imports it. `expand` fills ${VAR}; the
 * caller supplies it because only the caller knows where the values live (process env, Reasonix
 * home's .env).
 *
 * The block runs to the next NEW table, NOT to the next line starting with `[`: Reasonix REWRITES
 * its own config into canonical form, turning an inline `headers = { … }` into a `[plugins.headers]`
 * SUB-table that belongs to this plugin. Ending the block there would miss the Authorization line
 * and return null, silently. */
export function reasonixPlugin(text, expand) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\[\[plugins\]\]\s*$/.test(lines[i])) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && !startsNewTable(lines[j]); j += 1) body.push(lines[j]);
    const block = body.join("\n");
    if (!/^\s*name\s*=\s*"opencadre"\s*$/m.test(block)) continue;
    const raw = block.match(/Bearer\s+([^"'\s]+)/)?.[1];
    if (!raw) continue;
    const key = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => expand(name) ?? whole);
    // An unresolved ${VAR} is not a usable key: a half-expanded string must never be sent as one.
    if (/\$\{/.test(key)) continue;
    return { url: block.match(/^\s*url\s*=\s*["']([^"']+)["']/m)?.[1] || PUBLIC_HUB, key };
  }
  return null;
}

// The client list lives in ./opencadre-clients.mjs, so it cannot drift from the CLI's copy. Only the
// readers belong here, beside the config-file formats they parse; the table supplies their names.
// Qwen Code is a Gemini CLI fork and writes the same `mcpServers.opencadre` shape into its own user settings.
function qwen(home) {
  const s = readJson(join(home, ".qwen", "settings.json"))?.mcpServers?.opencadre;
  const key = bearer(s?.headers?.Authorization || s?.headers?.authorization);
  const url = s?.httpUrl || s?.url;
  return key && typeof url === "string" ? { url, key } : null;
}

// Copilot CLI's user MCP config (COPILOT_HOME or ~/.copilot)/mcp-config.json mcpServers.opencadre: a named agent.
function copilot(home) {
  const s = readJson(join(copilotHome(home), "mcp-config.json"))?.mcpServers?.opencadre;
  const key = bearer(s?.headers?.Authorization || s?.headers?.authorization);
  return key && typeof s.url === "string" ? { url: s.url, key } : null;
}

// Windsurf's user MCP config ~/.codeium/windsurf/mcp_config.json mcpServers.opencadre (serverUrl + Authorization): the
// named agent `connect --code oc_` writes, Windsurf's one way to OpenCadre's tools.
function windsurf(home) {
  const s = readJson(join(home, ".codeium", "windsurf", "mcp_config.json"))?.mcpServers?.opencadre;
  const key = bearer(s?.headers?.Authorization || s?.headers?.authorization);
  const url = s?.serverUrl || s?.url;
  return key && typeof url === "string" ? { url, key } : null;
}

const READER_FNS = { claudeCode, codex, cursor, gemini, qwen, copilot, windsurf, antigravity, reasonix };
const READERS = Object.fromEntries(READER_NAMES.map((name) => [name, READER_FNS[readerFor(name)]]));

// Client configs hold the MCP endpoint; the REST API lives at the hub root.
const hub = (url, key, source, headers = {}) => ({ base: url.replace(/\/+$/, "").replace(/\/mcp$/, ""), key, source, headers });

const homeDir = (home, env) => home || env.OPENCADRE_HOOK_HOME || homedir();

/** Where the install ROOT is for code at `fileUrl` (default: this file): the folder that holds the entry stubs a client
 * references (~/.opencadre/bin). A helper running from a generation lives in <root>/.gen/<12 hex>/[sub/]; a helper
 * outside one (a legacy fixed-file install, or a checkout) is at the root itself, so the answer there is its own folder,
 * exactly what a helper compared itself with before generations (Q1g PR-2, cli/lib/generations.mjs). */
export function installRoot(fileUrl = import.meta.url) {
  const file = fileUrl instanceof URL || String(fileUrl).startsWith("file:") ? fileURLToPath(fileUrl) : String(fileUrl);
  const parts = resolve(file).split(sep);
  for (let i = parts.length - 2; i >= 1; i--) {
    if (parts[i - 1] === ".gen" && /^[0-9a-f]{12}$/.test(parts[i])) return parts.slice(0, i - 1).join(sep) || sep;
  }
  return dirname(resolve(file));
}

/** Steps 1 and 2 only: the env key, else the named agent (agt_) configured for this client and folder. */
export function resolveNamedAgent({ client, cwd = process.cwd(), home, env = process.env } = {}) {
  if (env.OPENCADRE_URL && env.OPENCADRE_KEY) return hub(env.OPENCADRE_URL, env.OPENCADRE_KEY, "env");
  const dir = homeDir(home, env);
  for (const name of [client ?? "antigravity"].flat()) {
    const found = READERS[name]?.(dir, cwd);
    if (found?.url && found.key) return hub(found.url, found.key, name);
  }
  if (env.OPENCADRE_KEY) return hub(PUBLIC_HUB, env.OPENCADRE_KEY, "env");
  return {};
}

// --- Device credentials and session headers (per-session identity) ---------------------------

/** Where `opencadre connect --code ocd_…` keeps this computer's credential. Nothing else holds it. */
export const credentialsFile = (home) => join(home, ".opencadre", "credentials.json");

// The tools one computer credential serves are declared in ./opencadre-clients.mjs, beside every other
// client-list fact, so this module no longer keeps its own copy in step by hand. Other tools are
// detected by connect but not set up yet, so the credential never applies to them.
export { COMPUTER_TOOLS };

const credentialEntry = (entry) =>
  entry && typeof entry.hub === "string" && typeof entry.credential === "string" && entry.credential.startsWith("dev_")
    ? { hub: entry.hub.replace(/\/+$/, ""), credential: entry.credential, deviceId: typeof entry.deviceId === "string" ? entry.deviceId : undefined }
    : null;

/** { hub, credential, deviceId } for the client, or null. Never log the credential.
 * credentials.json is { "computer": { hub, credential, deviceId } }: one credential for every supported tool. A file
 * from before (one credential per tool, { "devices": { "<client>": {...} } }) still works for that tool until the next
 * connect rewrites it. */
export function readDeviceCredential({ client, home, env = process.env } = {}) {
  const file = readJson(credentialsFile(homeDir(home, env)));
  const computer = COMPUTER_TOOLS.includes(client) ? credentialEntry(file?.computer) : null;
  return computer ?? (typeof client === "string" ? credentialEntry(file?.devices?.[client]) : null);
}

/** How a credential was resolved, for callers that need to say so out loud.
 *
 * WHY THIS EXISTS. `readDeviceCredential` collapses three different situations into the same
 * success shape, so a caller cannot tell them apart:
 *   - the machine entry was used                                    (the healthy path)
 *   - a machine entry EXISTS BUT IS UNUSABLE, and an older per-tool entry was used instead
 *   - there is no machine entry at all, only the older per-tool shape (a partial migration)
 * The second and third look identical from the outside, so a machine credential that is
 * corrupt — a wrong prefix, a truncated value, a missing field — SILENTLY degrades to a stale
 * leftover. That is the same masking hazard the packed-CLI `../../scripts/` fallback had, and
 * it is worse here because this is an IDENTITY: the agent keeps working while acting as a
 * credential the operator believes was replaced.
 *
 * THE FALLBACK ITSELF IS DELIBERATE AND IS NOT REMOVED. A partial migration is a real state
 * (a machine can legitimately hold a legacy file — this reviewer's own machine did), and
 * refusing to read it would break a working setup to report a cosmetic problem. What changes
 * is only that the behaviour becomes OBSERVABLE.
 *
 * @returns {{ credential: object|null, shape: "computer"|"legacy"|"none", machineEntryUnusable: boolean, note: string|null }}
 */
export function explainDeviceCredential({ client, home, env = process.env } = {}) {
  const file = readJson(credentialsFile(homeDir(home, env)));
  const computerRaw = file?.computer;
  const eligible = COMPUTER_TOOLS.includes(client);
  const computer = eligible ? credentialEntry(computerRaw) : null;
  const legacy = typeof client === "string" ? credentialEntry(file?.devices?.[client]) : null;

  if (computer) {
    return { credential: computer, shape: "computer", machineEntryUnusable: false, note: null };
  }

  // A machine entry is PRESENT but did not validate, and we are about to serve something
  // else. This is the case that used to be silent.
  const rejected = Boolean(computerRaw) && eligible;
  if (legacy) {
    return {
      credential: legacy,
      shape: "legacy",
      machineEntryUnusable: rejected,
      note: rejected
        ? `credentials.json has a "computer" entry that is not usable (expected { hub, credential: "dev_…" }), so ${client} is using an older per-tool entry instead. Run "opencadre connect" to repair this computer's credential.`
        : `no "computer" entry in credentials.json, so ${client} is using today's per-tool entry. Run "opencadre connect" to move this computer to a single credential.`,
    };
  }

  return {
    credential: null,
    shape: "none",
    machineEntryUnusable: rejected,
    note: rejected
      ? `credentials.json has a "computer" entry that is not usable (expected { hub, credential: "dev_…" }) and no per-tool entry for ${client}.`
      : null,
  };
}

// Keep in step with the header constants in src/devices.ts and src/projects.ts.
export const SESSION_HEADER = "x-opencadre-session";
export const HOST_SESSION_HEADER = "x-opencadre-host-session";
export const CLIENT_HEADER = "x-opencadre-client";
export const PROJECT_HEADER = "x-opencadre-project";
export const PROJECT_NAME_HEADER = "x-opencadre-project-name";
export const RESOLVE_ONLY_HEADER = "x-opencadre-resolve-only";
// Asks the hub to answer a request with NO seat (src/devices.ts checkDeviceWithoutSeat): a stamped Codex process's
// startup traffic, so the process itself never joins the roster unless an unstamped tool call needs it.
export const DEFER_SEAT_HEADER = "x-opencadre-defer-seat";
// Sent with that seatless traffic by a proxy whose ONE process serves sessions in several folders (the client row's
// `stampFolder`: Devin). Its own working directory is wherever the app was launched and names no session's project,
// so the hub answers its tool list without checking that folder's project; every tool call still carries its
// session's own folder and is checked there (src/devices.ts checkDeviceWithoutSeat; review of 47dab9a, B2).
export const SHARED_PROCESS_HEADER = "x-opencadre-shared-process";
/** A resolve-only caller's opt-in to adopting the one live session this device already has in this project. Set by
 * resolveHub for clients whose `sessionIdSource.from` is "process" and only when create is false; see the comment on
 * ADOPT_LIVE_HEADER in src/devices.ts for the ruling it implements. */
export const ADOPT_LIVE_HEADER = "x-opencadre-adopt-live";
/** A proxy sets this once it has seen a `tools/call`, which is proof that a CHAT is behind the session
 * rather than just an eagerly-spawned process. The hub promotes `agents.liveness` to 'chat' on it.
 *
 * The proxy is the only party that CAN say this: the hub's /mcp route sees headers and never the JSON-RPC
 * method, so a `tools/call` is invisible to it. Measured on the phantom class -- all four eagerly-spawned
 * processes produced zero tool-call rows while 8 of 13 real chats produced them (up to 2,537) -- so this is
 * the one signal that separates a chat from a process that merely started. See migration 38's comment. */
export const CHAT_PROVEN_HEADER = "x-opencadre-chat-proven";
/** The hub's 401 text for a resolve-only request whose session doesn't exist yet: callers stay silent on it. */
export const NO_SESSION_ERROR = "no OpenCadre session for this chat yet";
/** The hub's 409 error when a resolve-only adopter had more than one live session to choose between and the hub
 * refused to guess. This one must NOT be silent: a chat that stays nameless is the inert-hook defect the adoption
 * fix exists to remove, and a chat that quietly borrows a sibling's name is worse. */
export const AMBIGUOUS_SESSION_ERROR = "more than one live OpenCadre session in this project; not guessing which one is this chat";
/** The hub's 403 error for a session in a project its workspace hasn't enabled: every caller acts as if OpenCadre
 * weren't configured at all (no tools, no output, never a blocked command). */
export const PROJECT_NOT_ENABLED = "project_not_enabled";

/** True for a hub answer refusing this session's project. `body` is the parsed JSON body, if any. */
export const isProjectNotEnabled = (status, body) => status === 403 && body?.error === PROJECT_NOT_ENABLED;
/** True for a hub answer refusing to choose between several live sessions for this chat. `body` is the parsed JSON body. */
export const isAmbiguousSession = (status, body) => status === 409 && body?.error === AMBIGUOUS_SESSION_ERROR;

/** The hub's 402 code for a workspace whose billing has lapsed (src/billing.ts READ_ONLY_CODE). Reads are
 * still served; writes are refused with this code and a message naming the date it lapsed. */
export const READ_ONLY_CODE = "TRIAL_EXPIRED";

/** True for a hub answer refusing a WRITE because the workspace's billing has lapsed.
 *
 * WHY EVERY CLIENT MUST TREAT THIS AS "NO-OP" RATHER THAN AS AN ERROR (#416 §8 item 6): a lapsed
 * subscription is not a fault in the customer's editor, config or network, and it is not something
 * they can fix from inside a tool that is asking us for advice. So no client may block, hold, retry
 * or scold on it:
 *   - the approval gate must not deny or hold a command (the user's own shell is not ours to close);
 *   - the Stop hook and the watcher must exit 0 at once (a hook that retries a bill for 30 s is a
 *     wedged editor, and the harness runs it on every single turn);
 *   - the MCP proxy must stay up and answer legibly, so the user's other tools keep working.
 *
 * Distinguished from `isProjectNotEnabled` by its STATUS: that one is a 403 meaning "OpenCadre isn't
 * configured here", this is a 402 meaning "OpenCadre is configured and the bill lapsed". Different
 * status, different sentence to the user, same requirement never to block.
 *
 * `code` is checked when present, but a 402 without it still counts: the status is the hub's own
 * statement that this is a billing refusal, and requiring our own field too would make the no-op
 * depend on the hub having been upgraded first. */
export const isBillingReadOnly = (status, body) => status === 402 && (body?.code === undefined || body.code === READ_ONLY_CODE);

// The hub's own rule for session ids (printable ASCII, no spaces). Anything else is treated as absent, never repaired:
// a repaired id would name a different session.
const SESSION_ID = /^[\x21-\x7e]{1,200}$/;
const sessionIdOrNull = (raw) => {
  const value = typeof raw === "string" ? raw.trim() : "";
  return SESSION_ID.test(value) ? value : null;
};

/** WHY THIS EXISTS AT ALL: sessionIdOrNull returns null for BOTH "the variable was never set" and
 * "the variable was set to something unusable", so by the time a caller holds its result the two
 * cases are indistinguishable. They need different things said about them - an absent variable is
 * a configuration or harness problem the user did not cause, a malformed one is a value they can
 * see and fix - so the distinction has to be preserved at the point of reading rather than
 * reconstructed later from a null.
 *
 * resolveSessionId never returns a fallback. A refusal is deliberate: a substituted or defaulted
 * id would name a different session, which is the failure this whole area exists to prevent, and
 * with a machine-wide credential it would silently make every chat on the box one agent. */
/** A session id as the hub keys it, for a client whose ids only mean something within a scope (seatScopeFor: Goose's
 * data root). With the scope unset (the default root) the id is unchanged, so names stay short where nothing collides. */
export function scopedSessionId(client, id, env = process.env) {
  const scope = seatScopeFor([client].flat()[0]);
  const value = scope && typeof env?.[scope] === "string" ? env[scope].trim() : "";
  if (!value || typeof id !== "string" || !id) return id;
  return `${id.slice(0, 180)}~r${createHmac("sha256", "opencadre-seat-scope").update(value).digest("hex").slice(0, 8)}`;
}

export const SESSION_ABSENT = "absent";
export const SESSION_INDETERMINATE = "indeterminate";
export function resolveSessionId({ source, sessionId, env = process.env } = {}) {
  // A caller-supplied id wins: resolveHub takes one from its caller for the same reason.
  if (sessionId !== undefined && sessionId !== null) {
    const value = sessionIdOrNull(sessionId);
    return value ? { ok: true, id: value } : { ok: false, reason: SESSION_INDETERMINATE };
  }
  if (!source) return { ok: false, reason: SESSION_ABSENT };
  if (source.from === "process") {
    // Correct only because this client runs one server process per chat, so process lifetime
    // equals session lifetime. The table states that; a client that reuses one process across
    // chats must not declare "process".
    return { ok: true, id: `${source.name ?? "local"}-${randomUUID()}` };
  }
  if (source.from === "call" || source.from === "stamp") {
    // A client whose chat id only exists on the wire (`params._meta`, OpenCode) has NO id yet at
    // process start. It still creates at `initialize`, and this is the value it creates under.
    //
    // WHY NOT ABSENT, WHICH WOULD BE THE OBVIOUS ANSWER: the tool list the client sees comes FROM
    // the resolved session, so a proxy that refuses to create at `initialize` serves zero tools -
    // and a chat with zero tools can never make the `tools/call` that would have supplied the id.
    // That deadlock is settled dead in docs/design/MCP-PROXY-CREATION-GATE.md §6 ("Defer creation
    // to the first tools/call - not implementable... The gate deadlocks against itself").
    //
    // SO IT CREATES, AND THE SEAT IS STABLE, NOT RANDOM. `process`'s fresh UUID per launch would
    // mint a NEW roster row on every app start for a client that spawns one child per app - the
    // phantom multiplication that document exists about. A constant, client-qualified seat is
    // reused instead: fleet decision #16791 measured that a stable seat converges on ONE row per
    // (device, seat, project) through code that already exists in the hub, and that the qualifier
    // must be IN the seat - with an unqualified one the second client in a project silently takes
    // the first client's row (the "silent alias", worse than an error). So `opencode-appstart`,
    // not `appstart`; a space cannot separate because SESSION_ID forbids it, hence `-`.
    //
    // This seat names the APP, not a chat: it is the truthful granularity for the moment before
    // any chat value has arrived. The chat's own id REPLACES it on the first `tools/call` the proxy
    // forwards (scripts/opencadre-mcp.mjs, adoptCallSession), which is what makes OpenCode a
    // per-chat client rather than one agent per app.
    //
    // `from: "stamp"` (Cursor) reaches the same seat for the same reason: its chat id arrives on each
    // call, signed by a hook, never at spawn. The proxy asks the hub for NO seat at all while nothing
    // needs one (DEFER_SEAT_HEADER), so for a stamp client this value names the app's project headers
    // rather than a roster row.
    return { ok: true, id: `${source.name ?? "local"}-appstart` };
  }
  if (source.from !== "env") return { ok: false, reason: SESSION_ABSENT };
  const raw = env[source.name];
  if (raw === undefined || raw === null) return { ok: false, reason: SESSION_ABSENT };
  const value = sessionIdOrNull(raw);
  // Set but unusable. Distinct from absent on purpose, and reported as such.
  return value ? { ok: true, id: value } : { ok: false, reason: SESSION_INDETERMINATE };
}

// --- Project identity: a project is a git repository ------------------------------------------

/** A folder name as the hub shows it: the last path segment reduced to [A-Za-z0-9._-], at most 40 characters.
 * Same rule as sanitizeProject in src/projects.ts. */
export function sanitizeName(raw) {
  if (typeof raw !== "string") return null;
  const segment = raw.split(/[\\/]/).filter((s) => s.trim()).pop() ?? "";
  const clean = segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 40).replace(/[-.]+$/, "");
  return clean || null;
}

const statKind = (path) => {
  try {
    const s = statSync(path);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : null;
  } catch {
    return null;
  }
};

/** The enclosing git checkout of cwd as { root, commonDir }, walking up for .git, or null. A .git FILE (a worktree or
 * submodule) points at its gitdir; a worktree's gitdir names the shared repository in `commondir`, where the config
 * lives. Read from disk, never by spawning git. */
export function findGitCheckout(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    const kind = statKind(dotGit);
    if (kind === "dir") return { root: dir, commonDir: dotGit };
    if (kind === "file") {
      const target = readText(dotGit).match(/^\s*gitdir:\s*(.+?)\s*$/m)?.[1];
      if (target) {
        const gitDir = resolve(dir, target);
        const common = readText(join(gitDir, "commondir")).trim();
        return { root: dir, commonDir: common ? resolve(gitDir, common) : gitDir };
      }
      return { root: dir, commonDir: null };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Environment that moves git's repository discovery or ref lookup away from what the files under the folder say.
const GIT_DISCOVERY_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"];
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})\s*$/;
// A branch name made only of ordinary path components; anything stranger is left to git.
const PLAIN_BRANCH = /^(?!.*\.lock(?:\/|$))(?!.*\.(?:\/|$))[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/** What `git rev-parse --abbrev-ref HEAD` prints in `cwd` when git opens the repository, read from its files instead of
 * started as a process (about 60 ms each on Windows):
 *   "<branch>"  HEAD names refs/heads/<branch>, that ref exists, and no other ref of that name would make git print the
 *               longer "heads/<branch>" (it does when a tag or a remote-tracking ref shares the name);
 *   "HEAD"      HEAD is detached (an object id);
 *   null        no repository encloses cwd, so git prints nothing;
 *   undefined   anything else, or any doubt: ask git. That covers a `.git` file that does not read cleanly, a bare or
 *               reftable repository, a `.git` folder git would skip, an unborn branch, a symbolic or garbled branch ref,
 *               git environment overrides and an unusual branch name.
 * What it CANNOT see is git refusing a repository it found: safe.directory ownership, an unknown repository extension,
 * no git on PATH, a timeout. git then prints nothing, so a caller that would ACT on a branch (exempt a command from
 * approval because the branch is not a protected one) must still confirm it with git. A caller that only needs "not
 * exempt" can stop here, because a refusal is never exempt either. */
export function headBranchOnDisk(cwd, env = process.env) {
  if (GIT_DISCOVERY_ENV.some((k) => env[k] !== undefined)) return undefined;
  let dir = resolve(cwd);
  if (statKind(dir) !== "dir") return undefined;
  for (;;) {
    const dotGit = join(dir, ".git");
    const kind = statKind(dotGit);
    if (kind) return headBranchOfGitDir(dotGit, kind);
    if (existsSync(dotGit)) return undefined;
    // The folder itself may be a repository (a bare one, or the inside of a .git folder), which git would use.
    if (existsSync(join(dir, "HEAD"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function headBranchOfGitDir(dotGit, kind) {
  let gitDir = dotGit;
  if (kind === "file") {
    const target = /^gitdir: (\S(?:.*\S)?)\s*$/.exec(readText(dotGit))?.[1];
    if (!target) return undefined;
    gitDir = resolve(dirname(dotGit), target);
  }
  const commonText = readText(join(gitDir, "commondir")).trim();
  const common = commonText ? resolve(gitDir, commonText) : gitDir;
  // An empty or broken .git folder is skipped by git, which keeps walking up: not followed here.
  if (statKind(join(common, "objects")) !== "dir" || statKind(join(common, "refs")) !== "dir" || existsSync(join(common, "reftable"))) return undefined;
  const head = readText(join(gitDir, "HEAD"));
  if (OBJECT_ID.test(head)) return "HEAD";
  const branch = /^ref: refs\/heads\/(\S+)\s*$/.exec(head)?.[1];
  if (!branch || !PLAIN_BRANCH.test(branch)) return undefined;
  const packed = new Set(readText(join(common, "packed-refs")).split(/\r?\n/).map((l) => /^[0-9a-f]{40,64} (\S+)$/.exec(l)?.[1]).filter(Boolean));
  // The branch must exist, as a loose ref holding an object id or a packed one: on an unborn branch git fails.
  const loose = join(common, "refs", "heads", ...branch.split("/"));
  const looseKind = statKind(loose);
  if (looseKind === "file") {
    if (!OBJECT_ID.test(readText(loose))) return undefined;
  } else if (looseKind !== null || existsSync(loose) || !packed.has(`refs/heads/${branch}`)) {
    return undefined;
  }
  // `--abbrev-ref` prints "heads/<branch>" when another rule would also resolve the short name (git's
  // shorten_unambiguous_ref, strict mode): a ref at the top of the git dir, refs/<b>, refs/tags/<b>, refs/remotes/<b> or
  // refs/remotes/<b>/HEAD. A folder of that name is not a ref; anything else there is left to git.
  for (const other of [branch, `refs/${branch}`, `refs/tags/${branch}`, `refs/remotes/${branch}`, `refs/remotes/${branch}/HEAD`]) {
    if (packed.has(other)) return undefined;
    for (const root of new Set([gitDir, common])) {
      const path = join(root, ...other.split("/"));
      if (statKind(path) !== "dir" && existsSync(path)) return undefined;
    }
  }
  return branch;
}

/** remote.origin.url from a git config file's text, or undefined. Section names are case-insensitive, the subsection
 * ("origin") is not; the first url wins, as for git fetch. */
export function originUrl(configText) {
  let inOrigin = false;
  for (const raw of String(configText).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/);
    if (section) {
      inOrigin = section[1].toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    const url = inOrigin && line.match(/^url\s*=\s*(.*)$/i);
    if (url) return url[1].replace(/\s+[#;].*$/, "").replace(/^"(.*)"$/, "$1").trim() || undefined;
  }
  return undefined;
}

/** This folder's project as { key, name }: the git root's origin remote normalized to host/owner/repo (so the same
 * repository on two computers is one project), else `local:<folder>` for the git root (or cwd, outside a checkout).
 * The name is the repository's own name as its remote spells it. Null only for a folder with no usable name. */
export function projectIdentity(cwd = process.cwd()) {
  const checkout = findGitCheckout(cwd);
  const remote = checkout?.commonDir ? originUrl(readText(join(checkout.commonDir, "config"))) : undefined;
  const key = remote ? normalizeProject(remote) : null;
  if (key && key.includes("/")) {
    const name = sanitizeName(remote.replace(/[\\/]+$/, "").replace(/\.git$/i, "").split(/[\\/:]/).pop()) ?? sanitizeName(key);
    return { key, name };
  }
  const folder = sanitizeName(basename(checkout?.root ?? resolve(cwd)));
  // The key is lowercased because Windows gives a process whatever casing its launcher used, so one
  // folder reached as `desktop\opencadre` and as `Desktop\OpenCadre` must still be one project: a
  // case-tracking key makes them two, discards the wake cursor, and re-wakes on every unread message.
  // `name` keeps the folder's own spelling, as it does for a remote repo above.
  return folder ? { key: `local:${folder.toLowerCase()}`, name: folder } : null;
}

/** The request headers that name one tool session, or null when the session id is missing or malformed. */
export function sessionHeaders({ client, sessionId, hostSessionId, cwd = process.cwd() }) {
  const session = sessionIdOrNull(sessionId);
  if (!session) return null;
  const headers = { [SESSION_HEADER]: session };
  const host = sessionIdOrNull(hostSessionId);
  if (host) headers[HOST_SESSION_HEADER] = host;
  if (client) headers[CLIENT_HEADER] = client;
  Object.assign(headers, projectHeaders(cwd));
  return headers;
}

/** X-OpenCadre-Project and X-OpenCadre-Project-Name for a folder ({} when it has no project identity). */
export function projectHeaders(cwd = process.cwd()) {
  const project = projectIdentity(cwd);
  return project ? { [PROJECT_HEADER]: project.key, [PROJECT_NAME_HEADER]: project.name } : {};
}

// --- Local opt-in: the project allowlist -------------------------------------------------------
//
// No sightings, client side (Codex-OpenCadre-8160's plan, thread 4c76be48). A folder's project key is sent to the hub
// ONLY when that project is on this computer's local copy of the workspace's enabled list. Every other folder gets the
// quiet answer it got before (empty tools, silent hooks, a pass-through gate) WITHOUT a request, so the hub never
// learns it was open. The list is refreshed from GET /v1/devices/projects, which is asked with the credential alone.
//
// The snapshot is REPLACED only by a successful sync and never expires to empty: a hub outage keeps the last list, so
// an enabled project keeps its clearance.
//
// With NO snapshot yet, the hub is asked per request, as before this list existed (the hub itself no longer records a
// folder it refuses). Going quiet instead would switch the approval gate off in an ENABLED project on every computer
// upgraded before its first sync -- a risky command would pass where it used to be held. The window is short: connect
// syncs, and the MCP proxy syncs at every start. A hub from before the route (404) is asked per request the same way.

/** Where this computer keeps the enabled-project list, one slot per (hub, credential). */
export const allowlistFile = (home) => join(home, ".opencadre", "project-allowlist.json");
const allowlistSlot = (hubUrl, credential) =>
  `${String(hubUrl).replace(/\/+$/, "")} ${createHash("sha256").update(String(credential)).digest("hex").slice(0, 16)}`;
export const ALLOWLIST_SYNC_TIMEOUT_MS = 3000;

/** { projects: Set, fetchedAt } | { cannotList: true } | null (no snapshot for this hub and credential). */
export function readProjectAllowlist({ hub, credential, home, env = process.env } = {}) {
  const slot = readJson(allowlistFile(homeDir(home, env)))?.[allowlistSlot(hub, credential)];
  if (slot?.cannotList === true) return { cannotList: true };
  if (!slot || !Array.isArray(slot.projects) || !slot.projects.every((k) => typeof k === "string")) return null;
  return { projects: new Set(slot.projects), fetchedAt: typeof slot.fetchedAt === "string" ? slot.fetchedAt : null };
}

function writeAllowlistSlot({ hub, credential, home, env = process.env }, value) {
  const file = allowlistFile(homeDir(home, env));
  const current = readJson(file);
  const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), [allowlistSlot(hub, credential)]: value };
  mkdirSync(dirname(file), { recursive: true });
  // Atomic: a reader sees the old list or the new one, never a half-written file that parses as "no snapshot".
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, file);
}

/** Refreshes the snapshot from GET /v1/devices/projects (credential only, no folder headers). Replaces it only on a
 * 200 carrying a list of keys; anything else leaves it as it was and says why. Never throws. */
export async function syncProjectAllowlist({ hub, credential, home, env = process.env, timeoutMs = ALLOWLIST_SYNC_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!hub || !credential) return { ok: false, reason: "no_credential" };
  let res;
  try {
    res = await fetchImpl(`${String(hub).replace(/\/+$/, "")}/v1/devices/projects`, {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 404) {
    // A hub from before the route. Only a snapshot-less computer records that: a real list is never replaced by it.
    if (!readProjectAllowlist({ hub, credential, home, env })?.projects) {
      try { writeAllowlistSlot({ hub, credential, home, env }, { cannotList: true, checkedAt: new Date().toISOString() }); } catch { /* best effort */ }
    }
    return { ok: false, reason: "hub_cannot_list" };
  }
  if (res.status !== 200) return { ok: false, reason: `http_${res.status}` };
  const body = await res.json().catch(() => null);
  const projects = body?.projects;
  if (!Array.isArray(projects) || !projects.every((k) => typeof k === "string")) return { ok: false, reason: "bad_response" };
  try {
    writeAllowlistSlot({ hub, credential, home, env }, { fetchedAt: new Date().toISOString(), projects });
  } catch {
    return { ok: false, reason: "unwritable" };
  }
  return { ok: true, projects };
}

/** Whether this folder may be named to the hub:
 *   "listed"          its project is on the snapshot: contact the hub as usual;
 *   "unlisted"        the snapshot does not have it: stay quiet, send nothing;
 *   "unknown"         no snapshot yet (before the first sync): ask the hub per request, as before;
 *   "hub_cannot_list" the hub predates the list: ask it per request, as before. */
export function folderAccess({ cwd = process.cwd(), hub, credential, home, env = process.env } = {}) {
  const snapshot = readProjectAllowlist({ hub, credential, home, env });
  if (!snapshot) return "unknown";
  if (snapshot.cannotList) return "hub_cannot_list";
  const key = projectIdentity(cwd)?.key;
  return key && snapshot.projects.has(key) ? "listed" : "unlisted";
}

/** True when a request naming this folder may go to the hub at all. */
export const mayContactHub = (opts) => folderAccess(opts) !== "unlisted";

/** The headers for a request that must never create a session, plus the per-client adoption opt-in.
 *
 * The policy lives in the client table, not here: `sessionIdSource.from === "process"` means the client runs one
 * server process per chat, so its seat is minted by the MCP proxy and is a value the chat's OWN hook can never
 * learn (docs/design/HARNESS-CODEX.md §5.4.1). Only such a client may adopt the single live session its proxy
 * created. A client whose id comes from the environment knows its own seat, so it is never offered this: a
 * Claude Code chat that adopted a live Codex session in the same folder would be wearing an identity that is not
 * its own, silently -- the exact failure per-chat identity exists to prevent (sprint job 1).
 *
 * Adoption is a hub-side deduction, so the hub enforces all of it too (src/devices.ts): this only says who asks. */
function resolveOnlyHeaders(name, headers) {
  const resolveOnly = { ...headers, [RESOLVE_ONLY_HEADER]: "1" };
  if (sessionIdSourceFor(name)?.from === "process") resolveOnly[ADOPT_LIVE_HEADER] = "1";
  return resolveOnly;
}

// --- The Codex identity stamp ------------------------------------------------------------------
//
// WHY: Codex gives its MCP server no per-chat value in any channel (HARNESS-CODEX.md §5.4.1, §5.4.3),
// but a PreToolUse hook receives the chat's `session_id` AND may rewrite an MCP call's arguments.
// At `rust-v0.155.1` that is `McpHandler::with_updated_hook_input` (core/src/tools/handlers/mcp.rs:427),
// applied only with `permissionDecision:"allow"` (hooks/src/engine/output_parser.rs:162-168).
// So examples/hooks/opencadre-session-stamp.mjs adds STAMP_FIELD to every OpenCadre call, and the
// proxy takes its identity for that call from the stamp. The hook and the tool path then name the
// SAME seat, so two chats are two agents, and a reopened chat never has to guess among stale sessions.
//
// SIGNED, because an unsigned field is one the MODEL could type: a chat that wrote a sibling's
// session id there would act under the sibling's name, the exact failure per-chat identity exists
// to prevent. The key is the machine's device credential, which the hook and the proxy both already
// read. LIMIT: this raises the bar from "type a string" to "read the credential file"; a model that
// can read ~/.opencadre/credentials.json can forge a stamp, as it could already act as the machine.
export const STAMP_FIELD = "_opencadre_stamp";
const STAMP_CONTEXT = "opencadre-session-stamp/v1\n";

/** The signature binding `sessionId` to this machine's credential (v1, no time). Still produced beside the dated
 * one so a proxy that started before the helpers were upgraded keeps answering its chat until it restarts; it is
 * never ACCEPTED any more (verifyStamp requires the dated one). */
export const stampSignature = (credential, sessionId) =>
  createHmac("sha256", String(credential)).update(STAMP_CONTEXT + String(sessionId)).digest("hex");

const STAMP_CONTEXT_V2 = "opencadre-session-stamp/v2\n";

/** The signature binding `sessionId` AND the moment the hook signed it (`ts`, ms since the epoch). */
export const stampSignatureAt = (credential, sessionId, ts) =>
  createHmac("sha256", String(credential)).update(`${STAMP_CONTEXT_V2}${String(sessionId)}\n${String(ts)}`).digest("hex");

/** How long a stamp stays good.
 *
 * WHY A STAMP EXPIRES AT ALL (review of 8c294fd, finding 3). Harnesses record a tool call's arguments to disk: Gemini
 * CLI's chat recording under ~/.gemini/tmp keeps the hook-modified arguments, and a Codex rollout keeps them too. A
 * stamp that never expired could be copied out of such a file and replayed wherever the stamp hook does not run to
 * overwrite it (hooks switched off, a folder Gemini does not trust), acting as that chat for good.
 *
 * WHY NOT A MINUTE. The hook signs BEFORE the harness asks the person whether to allow the MCP call (Cursor asks for
 * each call by default; Gemini and Codex ask in their default modes), so a stamp may legitimately wait for a human.
 * Thirty minutes covers a person who stepped away and still turns "valid forever" into a short window. */
export const STAMP_MAX_AGE_MS = 30 * 60 * 1000;
/** Clock slack for a stamp dated slightly in the future (the hook and the proxy read the same clock, so this is small). */
const STAMP_FUTURE_SLACK_MS = 60 * 1000;

/** A stamp for `sessionId`, signed now: `{ sid, sig, ts, tsig }`. `sig` is the v1 signature (see stampSignature).
 *
 * `sig` is a migration aid for a proxy already running pre-expiry code. No current proxy
 * accepts it alone. Keep the dual field until an evidence-backed compatibility decision
 * documents affected cohorts, a security rationale and customer recovery notices. A calendar
 * date is not evidence that customers upgraded. See docs/design/CONNECTOR-COMPATIBILITY.md.
 * Never widen verifyStamp to accept undated signatures. */
export function mintStamp(credential, sessionId, now = Date.now(), { folder, v1 = true } = {}) {
  const stamp = { sid: sessionId, ...(v1 ? { sig: stampSignature(credential, sessionId) } : {}), ts: now, tsig: stampSignatureAt(credential, sessionId, now) };
  // The session's FOLDER, where one MCP process serves sessions in several folders (the client row's `stampFolder`:
  // Devin, whose ACP process and Desktop app share one proxy started wherever they were launched). The proxy then takes
  // the call's project from this folder, the one the gate and awareness use, and not from its own working directory
  // (review of 47dab9a, B2). Signed with the session and the moment, so it cannot be moved to another stamp.
  if (typeof folder === "string" && folder) Object.assign(stamp, { dir: folder, dsig: stampFolderSignature(credential, sessionId, now, folder) });
  return stamp;
}

const STAMP_CONTEXT_DIR = "opencadre-session-stamp/folder\n";
const stampFolderSignature = (credential, sessionId, ts, folder) =>
  createHmac("sha256", String(credential)).update(`${STAMP_CONTEXT_DIR}${String(sessionId)}\n${String(ts)}\n${String(folder)}`).digest("hex");

/** { ok: true, sessionId } for a fresh stamp this credential signed, else { ok: false, reason }. */
export function verifyStamp(credential, stamp, { now = Date.now() } = {}) {
  if (!credential) return { ok: false, reason: "no device credential to verify with" };
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return { ok: false, reason: "not a stamp object" };
  const { sid, ts, tsig } = stamp;
  if (typeof sid !== "string" || !sid) return { ok: false, reason: "no session id" };
  if (!Number.isSafeInteger(ts) || typeof tsig !== "string" || !/^[0-9a-f]{64}$/.test(tsig)) {
    return { ok: false, reason: "no dated signature (the stamp hook is older than this proxy: run the connect command again, then restart the tool)" };
  }
  const want = Buffer.from(stampSignatureAt(credential, sid, ts), "hex");
  if (!timingSafeEqual(want, Buffer.from(tsig, "hex"))) return { ok: false, reason: "signature does not match" };
  if (ts > now + STAMP_FUTURE_SLACK_MS) return { ok: false, reason: "dated in the future" };
  if (now - ts > STAMP_MAX_AGE_MS) return { ok: false, reason: "expired" };
  if (stamp.dir !== undefined || stamp.dsig !== undefined) {
    const { dir, dsig } = stamp;
    if (typeof dir !== "string" || !dir || typeof dsig !== "string" || !/^[0-9a-f]{64}$/.test(dsig)
      || !timingSafeEqual(Buffer.from(stampFolderSignature(credential, sid, ts, dir), "hex"), Buffer.from(dsig, "hex"))) {
      return { ok: false, reason: "folder signature does not match" };
    }
    return { ok: true, sessionId: sid, folder: dir };
  }
  return { ok: true, sessionId: sid };
}

/** Where the stamp sits in this machine's Codex hooks.json, as { file, group, handler }, or null. Read from
 * the file Codex itself reads, not from a marker we write, so a user who removes the hook is believed at once. */
function codexStampPosition({ home, env = process.env } = {}) {
  const file = join(codexHome(homeDir(home, env), env), "hooks.json");
  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const groups = config?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return null;
  for (const [group, g] of groups.entries()) {
    const handler = Array.isArray(g?.hooks) ? g.hooks.findIndex((h) => String(h?.command ?? "").includes("opencadre-session-stamp")) : -1;
    if (handler >= 0) return { file, group, handler };
  }
  return null;
}

/** True when this machine's Codex hooks.json lists the stamp hook on PreToolUse (installed, not necessarily trusted). */
export const codexStampInstalled = (opts = {}) => codexStampPosition(opts) !== null;

/** True only when the stamp is installed AND Codex has recorded trust for that exact hook entry, so Codex will
 * actually run it.
 *
 * WHY TRUST AND NOT JUST PRESENCE (review of 1647207 by Codex-OpenCadre-d193): Codex skips a new or changed
 * hook until a person trusts it in /hooks. Right after `connect --upgrade` the stamp is IN hooks.json but NOT
 * run. If the hooks then resolved by their own id while the proxy, getting unstamped calls, stayed on its
 * process seat, one chat would act as two agents: the defect the stamp exists to fix. Until trust is recorded,
 * the old adoption path is kept on BOTH sides.
 *
 * The trust key is positional, `<hooks.json path>:<event>:<group index>:<handler index>` (MEASURED on the
 * fleet PC, and the format `cli/lib/doctor.mjs` reads). It REPORTS PRESENCE of `trusted_hash`, NOT VALIDITY,
 * for the reason doctor gives: nothing in this repo implements Codex's hash, and a second implementation
 * would fail in ways indistinguishable from a real trust gap. The residual risk is a trust entry left at
 * this position by a DIFFERENT, earlier hook. The stamp is the first handler ever placed at its position. */
export function codexStampActive({ home, env = process.env } = {}) {
  const at = codexStampPosition({ home, env });
  if (!at) return false;
  let text;
  try {
    text = readFileSync(join(codexHome(homeDir(home, env), env), "config.toml"), "utf8");
  } catch {
    return false;
  }
  const norm = (p) => p.replaceAll("\\", "/").toLowerCase();
  const want = `${norm(at.file)}:pre_tool_use:${at.group}:${at.handler}`;
  let inOurs = false;
  for (const line of text.split(/\r?\n/)) {
    // Both TOML quote styles: Codex writes OpenCadre's entries single-quoted (see doctor.mjs readTrustState).
    const header = /^\s*\[hooks\.state\.(["'])(.+?)\1\]\s*$/.exec(line);
    if (header) {
      inOurs = norm(header[2]) === want;
      continue;
    }
    if (/^\s*\[/.test(line)) inOurs = false;
    else if (inOurs && /^\s*trusted_hash\s*=/.test(line)) return true;
  }
  return false;
}

/** Where the stamp hook sits in this machine's Cursor hooks.json, or null. Cursor's file is FLAT - each event
 * holds handlers directly (`{ version: 1, hooks: { preToolUse: [{ command, matcher }] } }`) - unlike the
 * grouped Claude/Codex shape. */
function cursorStampInstalled({ home, env = process.env } = {}) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(homeDir(home, env), ".cursor", "hooks.json"), "utf8"));
  } catch {
    return false;
  }
  const handlers = config?.hooks?.preToolUse;
  return Array.isArray(handlers) && handlers.some((h) => String(h?.command ?? "").includes("opencadre-session-stamp") && String(h.command).includes("--client cursor"));
}

/** True when this client's chats name themselves with a signed stamp on every OpenCadre call, so a hook
 * holding the chat's id may resolve that exact seat, and the proxy need not open one for the process.
 * Codex passive hooks are resolve-only; only actual MCP work or a risky pre-tool clearance request creates
 * its seat. Other stamp clients retain their hook-side creation behavior. Each client's own hook file answers:
 *   codex   the stamp is installed AND trusted (Codex skips an untrusted hook; see codexStampActive)
 *   cursor  the stamp is installed in ~/.cursor/hooks.json (Cursor runs user-level hooks without a
 *           trust step)
 *   gemini  the stamp is installed in ~/.gemini/settings.json
 *   amp     OpenCadre's plugin is in Amp's plugin folder (the plugin is the stamp)
 *   kilo    OpenCadre's plugin is listed in Kilo's kilo.json (the plugin is the stamp)
 *   antigravity  OpenCadre's session server is in ~/.gemini/config/mcp_config.json: Antigravity names the
 *           conversation on every MCP call (`_meta`), with the same id its hooks get, so no stamp is needed
 * Any other client has no stamp, so false. */
export function stampActive({ client, home, env = process.env } = {}) {
  if (client === "codex") return codexStampActive({ home, env });
  if (client === "cursor") return cursorStampInstalled({ home, env });
  if (client === "gemini") return geminiStampInstalled({ home, env });
  if (client === "amp") return ampPluginInstalled({ home, env });
  if (client === "kilo") return kiloPluginInstalled({ home, env });
  // Droid: no stamp (every call names its session in `_meta`); its hooks, once connect installed them in the flat
  // ~/.factory/hooks.json, fire only inside a real session, so they may open that session's seat.
  if (client === "droid") {
    const hooks = readJsonc(join(droidHome(homeDir(home, env), env), "hooks.json"));
    return Object.values(hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => String(h?.command ?? "").includes("--client droid"))));
  }
  // Vibe: the stamp is a pre_tool hook in its hooks.toml.
  if (client === "vibe") {
    // The command is a TOML string, so its inner quotes are escaped (`\"`).
    return /opencadre-session-stamp\.mjs(\\?")? --client vibe/.test(readText(join(vibeHome(homeDir(home, env), env), "hooks.toml")));
  }
  // Crush: the stamp is a PreToolUse hook in its crush.json.
  if (client === "crush") {
    const hooks = readJsonc(join(crushHome(homeDir(home, env), env), "crush.json"))?.hooks?.PreToolUse;
    return Array.isArray(hooks) && hooks.some((h) => String(h?.command ?? "").includes("opencadre-session-stamp") && String(h.command).includes("--client crush"));
  }
  // Devin: the stamp is a PreToolUse hook in its config.json.
  if (client === "devin") {
    const groups = readJsonc(join(devinHome(homeDir(home, env), env), "config.json"))?.hooks?.PreToolUse;
    return Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => String(h?.command ?? "").includes("opencadre-session-stamp") && String(h.command).includes("--client devin")));
  }
  // Cline: its PreToolUse file hook loads OpenCadre's (the hook is the stamp).
  if (client === "cline") {
    try {
      return readFileSync(join(clineDirs(homeDir(home, env), env).hooks, "PreToolUse.mjs"), "utf8").includes("opencadre-cline-hook.mjs");
    } catch {
      return false;
    }
  }
  if (client === "antigravity") return Boolean(readJson(join(homeDir(home, env), ".gemini", "config", "mcp_config.json"))?.mcpServers?.["opencadre-session"]);
  return false;
}

/** Where Amp loads OpenCadre's plugin from: a wrapper `connect` writes into Amp's user plugin folder (ampHome), which
 * loads examples/hooks/opencadre-amp-plugin.mjs from ~/.opencadre/bin. */
export const ampPluginFile = ({ home, env = process.env } = {}) => join(ampHome(homeDir(home, env), env), "plugins", "opencadre.js");

/** True when Amp will load OpenCadre's plugin (the stamp, the gate and the mail all live in it). */
export function ampPluginInstalled({ home, env = process.env } = {}) {
  try {
    return readFileSync(ampPluginFile({ home, env }), "utf8").includes("opencadre-amp-plugin");
  } catch {
    return false;
  }
}

/** True when Kilo will load OpenCadre's plugin: kilo.json (kiloHome) lists opencadre-kilo-plugin.js in `plugin`. A
 * mention anywhere else (a comment, another key) is not the plugin (review of 91c617a, N5). */
export function kiloPluginInstalled({ home, env = process.env } = {}) {
  const plugins = readJson(join(kiloHome(homeDir(home, env), env), "kilo.json"))?.plugin;
  return Array.isArray(plugins) && plugins.some((p) => typeof p === "string" && /opencadre-kilo-plugin\.js$/.test(p));
}

/** Where the stamp sits in Gemini CLI's ~/.gemini/settings.json: a BeforeTool group holding the stamp handler run
 * with --client gemini. Gemini runs settings hooks without a per-hook trust step (a folder Gemini does not trust
 * skips them all, which the proxy's refusal of unstamped calls then makes visible). */
function geminiStampInstalled({ home, env = process.env } = {}) {
  const groups = readJson(join(homeDir(home, env), ".gemini", "settings.json"))?.hooks?.BeforeTool;
  return Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks)
    && g.hooks.some((h) => String(h?.command ?? "").includes("opencadre-session-stamp") && String(h.command).includes("--client gemini")));
}

/** True when the harness `host` has OpenCadre's OWN approval gate installed for it, so a gate installed for another
 * client may stand down on that host's payload without leaving its commands unguarded.
 *
 * WHY THIS IS ASKED, AND NOT ASSUMED (review of 7948fb9, finding B1). Cursor runs Claude Code's hooks and honours
 * their nested `permissionDecision` (it ships `enableClaudeNestedHookSpecificOutputCompatibility: true`). On a
 * machine where only Claude Code is connected, the Claude Code gate is therefore the ONLY thing holding a risky
 * command in a Cursor chat. Standing down there would switch clearance off without anyone deciding to. It stands
 * down only when the host's own gate will decide instead.
 *   cursor       ~/.cursor/hooks.json has a beforeShellExecution handler running the gate with --client cursor, with or
 *                without `failClosed` (an entry from before board 70f528b2 still decides; doctor sends it to upgrade)
 *   antigravity  ~/.gemini/config/hooks.json has the opencadre-gate entry, not switched off */
export function hostGateInstalled(host, { home, env = process.env } = {}) {
  const dir = homeDir(home, env);
  if (host === "cursor") {
    const handlers = readJson(join(dir, ".cursor", "hooks.json"))?.hooks?.beforeShellExecution;
    return Array.isArray(handlers) && handlers.some((h) => String(h?.command ?? "").includes("opencadre-approval-gate") && String(h.command).includes("--client cursor"));
  }
  if (host === "copilot") {
    const handlers = readJson(join(copilotHome(dir, env), "hooks", "opencadre.json"))?.hooks?.preToolUse;
    return Array.isArray(handlers) && handlers.some((h) => String(h?.command ?? "").includes("opencadre-approval-gate") && String(h.command).includes("--client copilot"));
  }
  if (host === "droid") {
    const groups = readJsonc(join(droidHome(dir, env), "hooks.json"))?.PreToolUse;
    return Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks)
      && g.hooks.some((h) => String(h?.command ?? "").includes("opencadre-approval-gate") && String(h.command).includes("--client droid")));
  }
  if (host === "devin") {
    const groups = readJsonc(join(devinHome(dir, env), "config.json"))?.hooks?.PreToolUse;
    return Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks)
      && g.hooks.some((h) => String(h?.command ?? "").includes("opencadre-approval-gate") && String(h.command).includes("--client devin")));
  }
  if (host === "grok") {
    const groups = readJson(join(grokHome(dir, env), "hooks", "opencadre.json"))?.hooks?.PreToolUse;
    return Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks)
      && g.hooks.some((h) => String(h?.command ?? "").includes("opencadre-approval-gate") && String(h.command).includes("--client grok")));
  }
  if (host === "antigravity") {
    const entry = readJson(join(dir, ".gemini", "config", "hooks.json"))?.["opencadre-gate"];
    return Boolean(entry) && entry.enabled !== false && JSON.stringify(entry).includes("--client antigravity");
  }
  return false;
}

// --- Host handoff: an MCP child tells its host's hooks which seat it holds ----------------------
//
// WHY THIS EXISTS (review of 14c8f9a, B1). Qwen Code hands its stdio MCP child QWEN_CODE_SESSION_ID ONCE, when the
// child is spawned, and then CHANGES the variable in its own process on /clear, /reset, /new and /resume
// (Config.startNewSession, 0.24.4). Its hooks inherit the NEW value; the MCP child keeps the old one. So a hook
// that named its chat by the variable asked the hub about a session nobody had opened: the gate denied every risky
// command as "no session", and mail stopped arriving, until qwen restarted.
//
// The one thing the child and the hooks still share is their HOST PROCESS. So the child finds that process by walking
// its own ancestry (locateHost: the nearest ancestor whose command line is the host's), records the seat it acts as
// under the host's pid in ~/.opencadre/run/<client>-<hostPid>.json, and a hook finds that record through ITS
// ancestry (findHostHandoff). Nothing is cached and nothing is taken from the environment: an answer that is not
// re-derived from the live process tree is how a hook came to name another process's seat (review of e5f165e, B1).
//
// `mode: "pooled"`: the host shares ONE child among many sessions (Qwen's ACP mode, McpTransportPool). The child then
// holds no seat of its own; each call names its session (scripts/opencadre-mcp.mjs), and a hook names its session by
// its own per-session id, so the record tells hooks NOT to use a process seat.
const handoffDir = (home, env) => join(homeDir(home, env), ".opencadre", "run");
const handoffFile = (client, hostPid, home, env) => join(handoffDir(home, env), `${client}-${hostPid}.json`);
const isPid = (n) => Number.isSafeInteger(n) && n > 1;
const alive = (pid) => {
  if (!isPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
};

/** Visits the process `pid` and up to `depth - 1` of its ancestors, nearest first, as { pid, ppid, line, argv? }, until
 * `visit` returns true. `line` is the command line; `argv` is the exact argument list where the platform keeps one
 * (Linux /proc), so a prompt with spaces is not split into flags. One PowerShell call on Windows (its output read as
 * UTF-8, so a non-ASCII profile path survives); /proc on Linux; one `ps` per level elsewhere, stopping early. */
function walkAncestors(pid, depth, visit, platform = process.platform) {
  try {
    if (platform === "win32") {
      const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$p=${Number(pid)};for($i=0;$i -lt ${Number(depth)};$i++){$w=Get-CimInstance Win32_Process -Filter "ProcessId=$p";if(!$w){break};"$($w.ProcessId)\`t$($w.ParentProcessId)\`t$($w.CommandLine -replace '[\\r\\n\\t]', ' ')";$p=$w.ParentProcessId}`;
      // A process can put line breaks in its command line; keep each CIM result on one row before parsing.
      const powerShell = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const r = spawnSync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true });
      for (const row of String(r.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
        const [p, pp, ...rest] = row.split("\t");
        if (visit({ pid: Number(p), ppid: Number(pp), line: rest.join("\t") })) return;
      }
      return;
    }
    let current = Number(pid);
    for (let i = 0; i < depth && isPid(current); i++) {
      let entry;
      if (platform === "linux") {
        const stat = readFileSync(`/proc/${current}/stat`, "utf8");
        // Field 4, read after the command name's closing parenthesis (a name may contain spaces).
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        const argv = readFileSync(`/proc/${current}/cmdline`, "utf8").split("\0").filter(Boolean);
        entry = { pid: current, ppid, line: argv.join(" "), argv };
      } else {
        const r = spawnSync("ps", ["-o", "ppid=,args=", "-p", String(current)], { encoding: "utf8", timeout: 3000, windowsHide: true });
        const m = /^\s*(\d+)\s+(.*)$/.exec(String(r.stdout ?? "").trim());
        if (!m) return;
        entry = { pid: current, ppid: Number(m[1]), line: m[2] };
      }
      if (visit(entry)) return;
      current = entry.ppid;
    }
  } catch { /* what was read so far */ }
}

/** The process `pid` and up to `depth - 1` of its ancestors, nearest first. [] when the platform will not say. */
export function processChain(pid, depth = 4, platform = process.platform) {
  const chain = [];
  walkAncestors(pid, depth, (p) => { chain.push(p); return false; }, platform);
  return chain;
}

/** True when a process's command line is the host's: it runs the host's entry script (the directory of `entryEnv`),
 * or matches the table's pattern. */
const isHost = (p, { entryEnv, pattern, env }) => {
  const entry = entryEnv && typeof env[entryEnv] === "string" && env[entryEnv] ? env[entryEnv] : null;
  // The entry's folder, cut at either slash; a value with no folder in it (".") would match every line, so it is not used.
  const folder = entry ? entry.replace(/[\\/][^\\/]*$/, "") : "";
  return Boolean((folder.length > 3 && folder !== entry && p.line.includes(folder)) || (pattern && new RegExp(pattern, "i").test(p.line)));
};

/** The host process of this MCP child: the nearest ancestor (a Node shim may sit between them, Scoop or Volta on
 * Windows) whose command line runs the host's entry script. For Qwen that script is QWEN_CODE_CLI, which Qwen sets in
 * its own environment before spawning anything; without it, a command line naming the qwen-code package's entry.
 * Returns { pid, line, argv? } or null when the host cannot be identified, which the caller must treat as unknown,
 * not as absent. `chain` stands in for the live process tree in tests. */
export function locateHost({ entryEnv, pattern, env = process.env, chain, from = process.ppid } = {}) {
  let found = null;
  const visit = (p) => (isHost(p, { entryEnv, pattern, env }) ? ((found = p), true) : false);
  if (chain) chain.some(visit);
  else walkAncestors(from, 4, visit);
  return found ? { pid: found.pid, line: found.line, ...(found.argv ? { argv: found.argv } : {}) } : null;
}

/** Records this child's seat for its host's hooks, atomically and readable by this user only. Best effort: a failed
 * write leaves hooks on their own id. */
export function writeHostHandoff({ client, hostPid, seat, mode = "process", home, env = process.env }) {
  if (!isPid(hostPid)) return;
  try {
    mkdirSync(handoffDir(home, env), { recursive: true, mode: 0o700 });
    try {
      chmodSync(handoffDir(home, env), 0o700); // a folder that already existed keeps its own mode otherwise
    } catch { /* not ours to change */ }
    const file = handoffFile(client, hostPid, home, env);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ client, hostPid, proxyPid: process.pid, seat, mode, at: new Date().toISOString() }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* hooks fall back to their own id */ }
}

// --- Antigravity: which workspace a conversation is in ---------------------------------------------
//
// agy (the CLI) gives its hooks `workspacePaths: []` unless it was started with --add-dir, and runs them in
// ~/.gemini/config with PWD set there too (measured on 1.2.9, docs/qa/HARNESS-MEASUREMENT.md §10). The agy process
// itself runs in the workspace, and a hook is its descendant (agy -> sh -> node), so the workspace is the working
// directory of the nearest ancestor that IS agy: read from /proc on Linux and with lsof on macOS. Nothing a command
// the model runs can change that.
//
// Files that name the folder (OpenCadre's own record, agy's last_conversations cache) are NOT used anywhere: a command
// the model runs can rewrite or delete them, and point the gate at a laxer project (review of d790104, B1; on Windows,
// where they were a fallback, a `cd` then a write got past any rule naming them: review of 712edc2, S4). Where the
// process tree cannot say (Windows), the folder is unknown, and the gate fails closed.

/** An agy process's own executable, not a script that merely mentions it, and not one of the IDE's Electron helper
 * processes (`--type=…`), whose working directory is wherever the IDE was started (review of 712edc2, S3). */
const isAgy = (p) => {
  const exe = String(p.argv?.[0] ?? p.line.split(/\s+/)[0] ?? "");
  // A whole argument that is `--type=…`, where the arguments are known: a prompt that merely mentions it is not a flag
  // (review of 7ffc12c, N5).
  const helper = Array.isArray(p.argv) ? p.argv.slice(1).some((a) => String(a).startsWith("--type=")) : /(^|\s)--type=/.test(p.line);
  return /(^|[\\/])(agy|antigravity)(\.exe)?$/i.test(exe) && !helper;
};

/** The working directory of process `pid` (Linux /proc, macOS lsof), or null. */
function processCwd(pid, platform = process.platform) {
  try {
    if (platform === "linux") return realpathSync(`/proc/${Number(pid)}/cwd`);
    if (platform === "darwin") {
      const r = spawnSync("lsof", ["-a", "-p", String(Number(pid)), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      const line = String(r.stdout ?? "").split("\n").find((l) => l.startsWith("n"));
      return line ? line.slice(1) : null;
    }
  } catch { /* gone, or not ours to read */ }
  return null;
}

/** The workspace of the agy process this hook runs under: { folder } when found, { folder: null } when the process tree
 * was read and names none, or null when this platform cannot say (Windows). A working directory that is the home folder
 * or a filesystem root is no workspace. `chain` / `cwdOf` stand in for the live process tree in tests. */
export function antigravityHostWorkspace({ from = process.ppid, platform = process.platform, chain, cwdOf = (pid) => processCwd(pid, platform), home = homedir() } = {}) {
  if (!chain && platform !== "linux" && platform !== "darwin") return null;
  const tree = chain ?? processChain(from, 6, platform);
  const agy = tree.find(isAgy);
  const folder = agy ? cwdOf(agy.pid) : null;
  const root = folder && resolve(folder) === resolve(folder, "..");
  return { folder: folder && !root && resolve(folder) !== resolve(home) && existsSync(folder) ? folder : null };
}

/** The workspace folder of an Antigravity conversation, or null when it cannot be told (see above). */
export function antigravityWorkspace({ host = antigravityHostWorkspace() } = {}) {
  return host?.folder ?? null;
}

/** Removes this child's record, and only its own: a later child of the same host may have replaced it. */
export function clearHostHandoff({ client, hostPid, home, env = process.env }) {
  const file = handoffFile(client, hostPid, home, env);
  if (readJson(file)?.proxyPid === process.pid) {
    try {
      rmSync(file, { force: true });
    } catch { /* best effort */ }
  }
}

/** The live record for one host, or null. Believed only while its child lives and, on Linux and Windows, only
 * while that child is really a descendant of the host it names. A record written by hand or matched by pid reuse
 * names no one. */
export function readHostHandoff({ client, hostPid, home, env = process.env, platform = process.platform }) {
  if (!isPid(hostPid)) return null;
  const record = readJson(handoffFile(client, hostPid, home, env));
  if (!record || record.client !== client || record.hostPid !== hostPid || !alive(record.proxyPid) || !alive(hostPid)) return null;
  if (["linux", "win32"].includes(platform) && !processChain(record.proxyPid, 4, platform).some((p) => p.ppid === hostPid)) return null;
  return record.mode === "pooled" || (typeof record.seat === "string" && record.seat) ? record : null;
}

/** Every live record of this client, by host pid; a dead child's record is removed on the way. */
export function liveHandoffs({ client, home, env = process.env }) {
  let names = [];
  try {
    names = readdirSync(handoffDir(home, env));
  } catch {
    return [];
  }
  const pattern = new RegExp(`^${client.replace(/[^\w-]/g, "")}-(\\d+)\\.json$`);
  const records = [];
  for (const name of names) {
    const m = pattern.exec(name);
    if (!m) continue;
    const record = readHostHandoff({ client, hostPid: Number(m[1]), home, env });
    if (record) {
      records.push(record);
      continue;
    }
    // Removed only while it still holds the SAME dead child: a new child of a reused host pid may have renamed its own
    // record into place since it was read.
    const file = join(handoffDir(home, env), name);
    const stale = readJson(file)?.proxyPid;
    if (!alive(stale) && readJson(file)?.proxyPid === stale) {
      try {
        rmSync(file, { force: true });
      } catch { /* best effort */ }
    }
  }
  return records;
}

/** Seats other live children of this client hold, so a second host resuming the same session does not share one. */
export function heldSeats({ client, exceptHostPid, home, env = process.env }) {
  return new Set(liveHandoffs({ client, home, env }).filter((r) => r.hostPid !== exceptHostPid && r.seat).map((r) => r.seat));
}

/** The host's record as a HOOK sees it, and only its OWN host's (review of 4f2516d, B1: a nested `qwen -p` run from a
 * Qwen session's shell must never land on the outer Qwen's record):
 *   - `--host-pid` given (every POSIX install passes `"$PPID"`, which under `bash -c` IS the host): that record or none;
 *   - else the parent, when it is the host (a hook it ran directly);
 *   - else the NEAREST ancestor recognised as the host (Windows runs a hook under cmd.exe or PowerShell), and no
 *     further: an outer host's record is never read.
 * The ancestry is read only when a live record exists at all, so a machine with no Qwen running pays nothing for it;
 * on Windows it costs one PowerShell start per hook call. Returns the live record or null. */
export function findHostHandoff({ client, spec, argv = process.argv, env = process.env, home } = {}) {
  const flag = argv.indexOf("--host-pid");
  if (flag > -1) return readHostHandoff({ client, hostPid: Number(argv[flag + 1]), home, env });
  const direct = readHostHandoff({ client, hostPid: process.ppid, home, env });
  if (direct) return direct;
  if (!spec || liveHandoffs({ client, home, env }).length === 0) return null;
  const host = locateHost({ entryEnv: spec.entryEnv, pattern: spec.pattern, env, from: process.ppid });
  return host ? readHostHandoff({ client, hostPid: host.pid, home, env }) : null;
}

/** The host's command-line arguments before any `--` (so a prompt cannot pose as a flag). */
export const hostFlags = (line, argv) => {
  // A Windows command line quotes its arguments ("--acp"); the quotes are not part of the flag.
  const tokens = Array.isArray(argv) ? argv : String(line ?? "").split(/\s+/).filter(Boolean).map((t) => t.replace(/^"+|"+$/g, ""));
  const stop = tokens.indexOf("--");
  return stop === -1 ? tokens : tokens.slice(0, stop);
};

/** True only when Codex will actually launch our async Stop watcher in this home. */
export function codexWakeInstalled({ home, env = process.env } = {}) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(codexHome(homeDir(home, env), env), "hooks.json"), "utf8"));
  } catch {
    return false;
  }
  const groups = config?.hooks?.Stop;
  return Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks)
    && g.hooks.some((h) => h?.async === true && String(h?.command ?? "").includes("opencadre-wake.mjs")
      && String(h.command).includes("--codex-queue")));
}

export function resolveHub({ client, cwd = process.cwd(), home, env = process.env, sessionId, hostSessionId, create = false, allowUnlisted = false } = {}) {
  const named = resolveNamedAgent({ client, cwd, home, env });
  if (named.key) return named;
  // A device credential is an identity only together with the session it acts for.
  //
  // This USED to hardcode `sessionId || env.CLAUDE_CODE_SESSION_ID`, which is Claude Code's
  // variable baked into a function every client goes through. It now asks the canonical table
  // what this client's session id comes from, so the answer is declared once per client instead
  // of assumed here. That is a BEHAVIOUR CHANGE at this call site, not an additive one: any client
  // whose declaration differs from the old hardcoded default resolves differently now.
  //
  // A refusal to resolve is returned as no headers, which callers already treat as "no identity
  // for this chat" - the same shape as before, reached deliberately instead of by a falsy value.
  const headersFor = (name) => {
    // A caller-supplied sessionId is honoured only for the client it was supplied for. The loop
    // below can walk more than one candidate name, and leaking one client's id onto another would
    // be exactly the misattribution this area exists to prevent.
    const supplied = name === client ? sessionId : undefined;
    // A STAMP client names a chat only through the id its hooks are handed. With none, the resolver's app-start
    // seat would stand in for the chat - a shared identity, and on a hub that ignores DEFER_SEAT a real row. The
    // proxy reads that seat itself (resolveSessionId); a hook without an id gets no identity at all.
    if ((supplied === undefined || supplied === null) && sessionIdSourceFor(name)?.from === "stamp") return null;
    const resolved = resolveSessionId({ source: sessionIdSourceFor(name), sessionId: supplied, env });
    if (!resolved.ok) return null;
    return sessionHeaders({
      client: name,
      sessionId: resolved.id,
      // The keeper variable belongs to the client whose table row names it (Claude Code). Read for any other client, a
      // tool started from a Claude Code shell (copilot, gemini…) would inherit it and name the Claude Code chat's seat.
      hostSessionId: hostSessionId || (sessionIdSourceFor(name)?.keeper ? env[sessionIdSourceFor(name).keeper] : undefined),
      cwd,
    });
  };
  for (const name of [client ?? "antigravity"].flat()) {
    // explainDeviceCredential rather than readDeviceCredential: same credential, plus WHY it
    // was chosen. A machine entry that exists but is unusable falls back to an older per-tool
    // entry BY DESIGN, but that used to happen silently — the caller could not tell a healthy
    // machine credential from a corrupt one being masked by a stale leftover. The returned
    // `credential` is identical to what readDeviceCredential would give, so this is not a
    // behaviour change for callers; it only makes the resolution reportable.
    const { credential: device, machineEntryUnusable, note } = explainDeviceCredential({ client: name, home, env });
    if (!device) continue;
    // Local opt-in: a folder whose project is not on this computer's enabled list is never named to the hub. The
    // answer carries no key, so every caller's "no identity here" path applies; `notEnabled` lets one that must
    // behave as if OpenCadre weren't installed (the approval gate) say so. `allowUnlisted` is connect's alone: running
    // it in a folder is how that folder gets enabled.
    const access = allowUnlisted ? "listed" : folderAccess({ cwd, hub: device.hub, credential: device.credential, home, env });
    if (access === "unlisted") return { source: "device", notEnabled: true, allowlist: access };
    const headers = headersFor(name);
    if (headers) {
      // Trusted stamps name the exact chat; never deduce it from another live seat. Codex also runs
      // awareness hooks for disposable background sessions, so passive hook traffic must not create
      // an agent. A real stamped MCP call creates its own channel; the approval gate may explicitly
      // create this trusted chat's seat when it must request clearance for a risky command.
      // Other stamp clients keep their existing hook-side creation behavior.
      const ownSeat = !create && name === client && sessionId !== undefined && sessionId !== null
        && stampActive({ client: name, home, env });
      const resolvedHeaders = create || (ownSeat && name !== "codex") ? headers
        : ownSeat ? { ...headers, [RESOLVE_ONLY_HEADER]: "1" } : resolveOnlyHeaders(name, headers);
      const resolved = hub(device.hub, device.credential, "device", resolvedHeaders);
      // Attached rather than written here: this module is imported by the hub, hooks and the
      // CLI, so a resolver that printed would be noisy. Callers that own a stderr (the MCP
      // proxy, the wake daemon) read these and decide; everyone else ignores them.
      //
      // ONLY the abnormal case is annotated. A legacy-only install is a legitimate state, not
      // a problem to report on every resolve - annotating it made resolveHub's return value
      // differ from its documented shape on the ORDINARY path, which broke a caller asserting
      // that shape. A note that appears on a healthy path is noise, and noise gets filtered
      // out along with the signal it was meant to carry.
      if (note && machineEntryUnusable) {
        resolved.credentialNote = note;
        resolved.machineEntryUnusable = true;
      }
      return resolved;
    }
  }
  return {};
}

// The key a project's clearance mode is stored under on the hub: host/owner/repo from a git remote,
// lowercased, with no scheme, credentials, port or .git suffix ("" = workspace default, null = not a
// plausible remote). Keep in step with normalizeProject in src/clearance-policy.ts.
export function normalizeProject(raw) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const key = raw.trim()
    .replace(/\\/g, "/")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^/]*@/, "")
    .replace(/^([^/:]+):\d+(?=\/)/, "$1")
    .replace(/^([^/:]+):(?!\/)/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (key.length > 200) return null;
  if (key && (!/^[a-z0-9][a-z0-9._~/-]*$/.test(key) || key.split("/").includes(".."))) return null;
  return key;
}

// --- The approval gate's configuration layers (F7 / board Q1f) -----------------------------------------------------
//
// Shared by the gate (examples/hooks/opencadre-approval-gate.mjs) and `opencadre doctor`, so what doctor reports is
// what the gate does. Precedence, explicitly:
//   1. TRUSTED layers, later wins: built-in defaults < ~/.opencadre/approval-gate.json < the file at
//      $OPENCADRE_GATE_CONFIG < env (OPENCADRE_GATE_MODE, OPENCADRE_APPROVER, OPENCADRE_APPROVAL_WAIT). The lists
//      (rules, allow, disabledCategories) combine; protectedBranches is replaced.
//   2. The REPOSITORY layer, <cwd>/.opencadre/approval-gate.json, arrives with the code a chat opens, so it can only
//      TIGHTEN what the trusted layers say, and it composes with them instead of replacing them:
//        mode            the stricter of the two (off < notify < ask < strict; an unknown mode ranks as ask)
//        onTimeout,
//        onHubUnreachable "deny" wins; a repository's "allow" is ignored
//        rules           added to the trusted rules; nothing a repository says removes one
//        protectedBranches added to the trusted list
//        useDefaultRules  may turn the built-in rules on, never off
//        useDefaultAllowlist may turn the built-in allowlist off, never on
//        waitSeconds     may lengthen the wait, never shorten it
//        approver        honoured (it changes who is asked, never whether)
//        allow, disabledCategories: ignored (each one loosens)
//      Anything ignored is reported in `repoIgnored` and in one warning line, BY FIELD NAME ONLY: a repository's value
//      (an allow pattern, say) may hold a credential, so it is never echoed to stderr or to doctor (review of #680, 3).
//   3. Strict forces both fallbacks to "deny" whatever any layer says.
// A fallback "allow" never approves a command: the gate hands the command back to the tool's own permission settings
// with no opinion, and records it as a policy pass (never as an approval, never as a person's decision).
export const GATE_MODES = ["off", "notify", "ask", "strict"];
export const GATE_DEFAULTS = Object.freeze({
  mode: "notify",
  approver: undefined,
  waitSeconds: 540,
  onTimeout: "deny",
  onHubUnreachable: "deny",
  useDefaultRules: true,
  useDefaultAllowlist: true,
  protectedBranches: Object.freeze(["main", "master", "production", "prod", "release"]),
  rules: Object.freeze([]),
  allow: Object.freeze([]),
  disabledCategories: Object.freeze([]),
});
const GATE_LISTS = ["rules", "allow", "disabledCategories"];
/** A mode's strictness: off 0 < notify 1 < ask 2 < strict 3. The gate holds an unknown mode like ask, so it ranks as ask. */
export const gateModeRank = (mode) => (GATE_MODES.includes(mode) ? GATE_MODES.indexOf(mode) : GATE_MODES.indexOf("ask"));
const isLayer = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The effective gate config from its layers: { cfg, repoIgnored, allowKnobs, warnings }.
 *  home, envFile, repo: the parsed files ({} when absent or malformed). env: process.env or a test's. */
export function composeGateConfig({ home = {}, envFile = {}, repo = {}, env = {} } = {}) {
  const cfg = { ...GATE_DEFAULTS, protectedBranches: [...GATE_DEFAULTS.protectedBranches], rules: [], allow: [], disabledCategories: [] };
  const source = { onTimeout: "defaults", onHubUnreachable: "defaults", mode: "defaults" };
  for (const [name, layer] of [["~/.opencadre/approval-gate.json", home], ["$OPENCADRE_GATE_CONFIG", envFile]]) {
    if (!isLayer(layer)) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (GATE_LISTS.includes(k)) {
        if (Array.isArray(v)) cfg[k] = [...cfg[k], ...v];
      } else if (v !== undefined) {
        cfg[k] = v;
        if (k in source) source[k] = name;
      }
    }
  }
  if (env.OPENCADRE_GATE_MODE) { cfg.mode = env.OPENCADRE_GATE_MODE; source.mode = "OPENCADRE_GATE_MODE"; }
  if (env.OPENCADRE_APPROVER) cfg.approver = env.OPENCADRE_APPROVER;
  if (env.OPENCADRE_APPROVAL_WAIT) cfg.waitSeconds = Number(env.OPENCADRE_APPROVAL_WAIT);

  const repoIgnored = [];
  const ignore = (key) => { if (!repoIgnored.some((i) => i.key === key)) repoIgnored.push({ key }); };
  if (isLayer(repo)) {
    for (const [k, v] of Object.entries(repo)) {
      if (v === undefined) continue;
      if (k === "mode") {
        if (gateModeRank(v) >= gateModeRank(cfg.mode)) { cfg.mode = v; source.mode = "repository"; } else ignore(k, v);
      } else if (k === "onTimeout" || k === "onHubUnreachable") {
        if (v === "allow") ignore(k, v);
        else { cfg[k] = "deny"; source[k] = "repository"; }
      } else if (k === "rules") {
        if (Array.isArray(v)) cfg.rules = [...cfg.rules, ...v];
      } else if (k === "protectedBranches") {
        if (Array.isArray(v)) cfg.protectedBranches = [...new Set([...(Array.isArray(cfg.protectedBranches) ? cfg.protectedBranches : []), ...v.filter((b) => typeof b === "string" && b)])];
      } else if (k === "useDefaultRules") {
        if (v) cfg.useDefaultRules = true; else if (cfg.useDefaultRules) ignore(k, v);
      } else if (k === "useDefaultAllowlist") {
        if (!v) cfg.useDefaultAllowlist = false; else if (!cfg.useDefaultAllowlist) ignore(k, v);
      } else if (k === "waitSeconds") {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0 && !(Number(cfg.waitSeconds) > n)) cfg.waitSeconds = n; else ignore(k, v);
      } else if (k === "approver") {
        cfg.approver = v;
      } else if (k === "allow" || k === "disabledCategories") {
        if (Array.isArray(v) && v.length) ignore(k, v);
      }
    }
  }
  if (cfg.mode === "strict") {
    cfg.onTimeout = "deny";
    cfg.onHubUnreachable = "deny";
  }
  const allowKnobs = ["onTimeout", "onHubUnreachable"].filter((k) => cfg[k] === "allow").map((knob) => ({ knob, layer: source[knob] }));
  const warnings = [];
  if (repoIgnored.length) {
    const what = repoIgnored.map(({ key }) => key).join(", ");
    warnings.push(`OpenCadre approval gate: ignored ${what} in this repository's .opencadre/approval-gate.json: a repository's config can tighten the gate, never loosen it.`);
  }
  if (allowKnobs.length) {
    warnings.push(`OpenCadre approval gate: ${allowKnobs.map(({ knob }) => `${knob} "allow"`).join(" and ")} is set; that is unsupported for verified person clearance, so a risky command nobody approves falls back to your tool's own permission settings, never an OpenCadre approval.`);
  }
  return { cfg, repoIgnored, allowKnobs, warnings };
}
