#!/usr/bin/env node
// Pre-tool hook: stamps every OpenCadre MCP call with THIS chat's identity. One script for every harness
// whose pre-tool hook can add arguments to an MCP call; the differences are in opencadre-hook-dialect.mjs.
//
//   node opencadre-session-stamp.mjs [--client codex|cursor|gemini]      (default codex)
//
// Neither Codex nor Cursor gives its MCP server a per-chat value in any channel (docs/design/HARNESS-CODEX.md
// §5.4.1, HARNESS-CURSOR-LOCAL.md §11), so on its own the server can only guess which chat is calling. A
// pre-tool hook is told the chat's `session_id`, and both harnesses let it change an MCP call's arguments:
//   - Codex, at `rust-v0.155.1`: `McpHandler::with_updated_hook_input` (core/src/tools/handlers/mcp.rs:427),
//     applied only when the same output says `permissionDecision:"allow"` (hooks/src/engine/
//     output_parser.rs:162-168). That "allow" does not pre-approve the call: dispatch only knows Blocked or
//     Continue (core/src/tools/registry.rs ~588-640). The arguments are REPLACED by `updatedInput`.
//   - Cursor, at 2026.09.23-86fc751: the MCP executor runs `preToolUse` with `tool_name: "MCP:<tool>"` and
//     MERGES each key of `updated_input` into the call's arguments. No permission field is needed, so none
//     is sent (a preToolUse "allow" is a decision this hook has no business making).
//   - Gemini CLI, at 0.61.0: on the scheduler's path (hook-utils.ts `evaluateBeforeToolHook`, the one that runs;
//     the executor passes skipBeforeHook) BeforeTool's `hookSpecificOutput.tool_input` REPLACES the arguments -
//     `tool.build(modifiedInput)`, then `toolCall.request.args = modifiedArgs` - and is validated against the
//     tool's schema (the hub's schemas allow extra properties). So, as for Codex, the whole argument set goes back.
//     The payload names the MCP server in `mcp_context.server_name`, so only OUR server's calls are stamped.
//
// So this hook adds a signed STAMP_FIELD to the call. scripts/opencadre-mcp.mjs verifies it, removes it
// before anything reaches the hub, and answers the call as this chat's agent.
//
// SILENT BY DEFAULT: "no opinion" for a call that is not ours, a payload with no `session_id`, and a machine
// with no device credential to sign with. The hook never denies and never emits `ask` (Codex parses `ask`
// and then fails the hook run).
import { existsSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { explainDeviceCredential, installRoot, mintStamp, STAMP_FIELD } from "../../scripts/opencadre-config.mjs";
import { metaStampFor, parseJsonc, stampsFolder, toolPrefixFor } from "../../scripts/opencadre-clients.mjs";
import { dialectFor, foreignHost, hookCwd, parseHookInput, silenceFor, updatedInputOutput } from "../../scripts/opencadre-hook-dialect.mjs";

// The name connect gives OpenCadre's stdio server in every client (cli/lib/clients.mjs SESSION_SERVER).
const SESSION_SERVER = "opencadre-session";

const args = process.argv.slice(2);
const client = args.includes("--client") ? args[args.indexOf("--client") + 1] : "codex";

const silent = () => {
  const quiet = silenceFor(client);
  if (quiet) writeSync(1, quiet);
  process.exit(0);
};

// Which calls are OpenCadre's, per harness.
//   codex   Codex's TOOL names use an UNDERSCORE (`mcp__opencadre_session__set_status`), while its CONFIG key
//           has a hyphen (`opencadre-session`). MEASURED: 58 of 58 tool names in a live rollout were
//           underscored. `mcp__opencadre__` is the legacy named-agent server, stamped too.
//   cursor  Cursor's preToolUse names an MCP call `MCP:<tool>` WITHOUT its server, so the server cannot be
//           matched. The proxy lists the hub's tools to Cursor under a prefix (`opencadre_<tool>`,
//           opencadre-clients.mjs toolPrefix), and only a name carrying it is ours.
//   gemini  Gemini CLI names the server in `mcp_context.server_name`, so only OUR server's calls are stamped.
function isOurs(toolName, input) {
  if (typeof toolName !== "string") return false;
  if (client === "gemini") {
    // By name AND by what it runs: a project's own .gemini/settings.json could redefine `opencadre-session` as a
    // remote server, and a stamp must only ever go to this machine's proxy (review of 8c294fd, finding 4).
    const ctx = input?.mcp_context;
    return ctx?.server_name === SESSION_SERVER && !ctx.url && Array.isArray(ctx.args)
      && ctx.args.some((a) => /opencadre-mcp\.mjs$/.test(String(a))) && ctx.args.includes("gemini");
  }
  if (client === "cursor") return toolName.startsWith(`MCP:${toolPrefixFor("cursor")}`) && toolName.length > `MCP:${toolPrefixFor("cursor")}`.length;
  //   devin   Devin keeps the hyphen: `mcp__opencadre-session__<tool>` (measured on 3000.6.11).
  if (client === "devin") return toolName.startsWith(`mcp__${SESSION_SERVER}__`);
  //   vibe    `<server>_<tool>`: `opencadre-session_<tool>` (measured on 2.25.8).
  if (client === "vibe") return toolName.startsWith(`${SESSION_SERVER}_`);
  //   crush   `mcp_<server>_<tool>`: `mcp_opencadre-session_<tool>` (measured on 0.96.1).
  if (client === "crush") return toolName.startsWith(`mcp_${SESSION_SERVER}_`);
  return /^mcp__opencadre(_session)?__/.test(toolName);
}

let input;
try {
  input = parseHookInput(readFileSync(0, "utf8"));
} catch {
  silent();
}

// Installed for one harness, running inside another (Cursor loads Claude Code's hooks): not ours to stamp. Said in the
// HOST's own "no opinion", which is what the host reads.
const host = foreignHost(client, input);
if (host) {
  const quiet = silenceFor(host);
  if (quiet) writeSync(1, quiet);
  process.exit(0);
}

// Copilot CLI: the stamp rides the request's `_meta`, not the arguments. Its `preMcpToolCall` hook sees
// { sessionId, serverName, toolName, arguments, _meta } and its `metaToUse` REPLACES the request's `_meta` (Copilot then
// adds its own progressToken), so the existing `_meta` is carried through with the stamp added. Only OUR server's calls:
// `serverName` is the config key, and the stamp is a dated HMAC, never the credential. MEASURED on 1.0.88.
if (client === "copilot") {
  if (input?.serverName !== SESSION_SERVER) silent();
  const sid = input?.sessionId;
  if (typeof sid !== "string" || !sid.trim()) silent();
  const { credential: cred } = explainDeviceCredential({ client });
  if (!cred?.credential) silent();
  const meta = input?._meta && typeof input._meta === "object" && !Array.isArray(input._meta) ? input._meta : {};
  process.stdout.write(JSON.stringify({ metaToUse: { ...meta, [metaStampFor("copilot")]: mintStamp(cred.credential, sid) } }));
  process.exit(0);
}

// Cline: a `tool_call` file hook. MCP tools are `<server>__<tool>`, so ours are `opencadre-session__…` (Cline's MCP
// servers are global only, so a project cannot redefine the name). `overrideInput` REPLACES the input.
if (client === "cline") {
  const call = input?.tool_call;
  const sid = input?.sessionContext?.rootSessionId;
  if (input?.hookName !== "tool_call" || typeof call?.name !== "string" || !call.name.startsWith(`${SESSION_SERVER}__`)) silent();
  if (typeof sid !== "string" || !sid.trim()) silent();
  if (call.input !== undefined && (call.input === null || typeof call.input !== "object" || Array.isArray(call.input))) silent();
  const { credential: cred } = explainDeviceCredential({ client });
  if (!cred?.credential) silent();
  process.stdout.write(updatedInputOutput(client, { ...(call.input ?? {}), [STAMP_FIELD]: mintStamp(cred.credential, sid) }));
  process.exit(0);
}

const toolName = input?.tool_name;
const sessionId = input?.session_id;
const toolInput = input?.tool_input;
if (!isOurs(toolName, input)) silent();
if (typeof sessionId !== "string" || !sessionId.trim()) silent();
// `updatedInput` REPLACES the arguments in Codex, so only an object we can copy whole is rewritten.
if (toolInput !== undefined && (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput))) silent();

const { credential: device } = explainDeviceCredential({ client });
if (!device?.credential) silent();

/** Devin ranks a project's own MCP config above the user's, so a repository that defines a server named
 * `opencadre-session` gets the calls this hook would stamp, and the stamp with them (review of 47dab9a, S2; Gemini's
 * guard is by the server's command, which Devin's payload does not carry). Devin reads its own `.devin/mcp_config*.json`
 * and imports other tools' project files too (`.mcp.json`, `.cursor/mcp.json`, `.claude/settings*.json`,
 * `opencode.json[c]`, `.zed/settings.json`; measured, review of 3a79037, S2). Looked for from the session's folder up
 * to the project root Devin names, as a JSON KEY (a hook command naming opencadre-session-stamp.mjs is not one); an
 * unreadable file counts as one. No stamp then: the call reaches OpenCadre's proxy, if at all, unstamped, and is
 * refused. */
const PROJECT_MCP_FILES = [".mcp.json", ".cursor/mcp.json", ".claude/settings.json", ".claude/settings.local.json", "opencode.json", "opencode.jsonc", ".zed/settings.json"];
/** Whether a parsed config names `opencadre-session` as a KEY anywhere (mcpServers, context_servers, mcp, …): parsed,
 * so an escaped key or a comment cannot hide it (review of 8fe0ca9, S3). A file that does not parse counts as one. */
function definesOurs(text) {
  const parsed = parseJsonc(text);
  if (parsed === null) return true;
  const seen = [parsed];
  while (seen.length) {
    const node = seen.pop();
    if (!node || typeof node !== "object") continue;
    if (!Array.isArray(node) && Object.hasOwn(node, SESSION_SERVER)) return true;
    seen.push(...Object.values(node));
  }
  return false;
}
// The project files each client reads MCP servers from, above the user's own (reviews of 47dab9a S2, 8fe0ca9 S2), and the
// variable its hooks get naming the project root, where the search stops. `dirs` are folders whose files match a name.
// Crush's `crushrc` and Vibe's TOML are not JSON: any mention of the server counts there.
const PROJECT_SERVER_FILES = {
  devin: { top: "DEVIN_PROJECT_DIR", files: PROJECT_MCP_FILES, dirs: [[".devin", /^mcp_config.*\.json$/i]] },
  // Crush reads up to the git root (its lookupConfigs), not CRUSH_PROJECT_DIR, which is the session's folder, and also
  // its data folder's .crush/crush.json (review of e6c51ae, S1).
  crush: { top: "git", files: ["crush.json", ".crush.json", "crushrc", ".crushrc", ".crush/crush.json"], dirs: [] },
  // Vibe reads a project's .vibe/config.toml (in a trusted folder); TOML, so any mention counts.
  vibe: { top: "", files: [".vibe/config.toml"], dirs: [] },
};

// Codex can run the user-level and trusted project hooks for the same MCP call. A project may
// replace the user's opencadre-session server with a different proxy and credential. Only the
// stamp hook installed beside that project's actual proxy may sign its calls. If the project
// server is not our local proxy, neither hook stamps it.
function codexProjectProxyMatchesThisHook() {
  const home = resolve(process.env.HOME || process.env.USERPROFILE || homedir());
  let projectConfig;
  for (let d = resolve(process.cwd()); ; d = dirname(d)) {
    if (d !== home) {
      const file = join(d, ".codex", "config.toml");
      if (existsSync(file)) { projectConfig = file; break; }
    }
    if (existsSync(join(d, ".git")) || dirname(d) === d) break;
  }
  if (!projectConfig) return true;
  let text;
  try { text = readFileSync(projectConfig, "utf8"); } catch { return false; }
  const section = text.match(/^\s*\[\s*mcp_servers\s*\.\s*(?:opencadre-session|"opencadre-session"|'opencadre-session')\s*\]\s*(?:#.*)?$([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m);
  if (!section) return true;
  const body = section[1];
  const command = body.match(/^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m)?.[1];
  const args = body.match(/^\s*args\s*=\s*(\[[^\r\n]*\])\s*(?:#.*)?$/m)?.[1];
  if (!command || !args) return false;
  let program, argv;
  try {
    program = command.startsWith('"') ? JSON.parse(command) : command.slice(1, -1);
    argv = JSON.parse(args);
  } catch { return false; }
  if (!/(?:^|[\\/])node(?:\.exe)?$/i.test(program) || !Array.isArray(argv)) return false;
  const proxy = argv.find((arg) => typeof arg === "string" && /(?:^|[\\/])opencadre-mcp\.mjs$/i.test(arg));
  if (!proxy) return false;
  const norm = (p) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  // The install ROOT, not this file's folder: installed, this hook runs from <root>/.gen/<id>/, while the proxy a client
  // config names is the root's stub (installRoot, Q1g PR-2).
  return norm(dirname(proxy)) === norm(installRoot(import.meta.url));
}
// Cursor: user hooks run from ~/.cursor, and when several sources answer, the USER hook's fields override a project
// hook's ("a lower-priority source overrides a higher-priority one", User being lowest: cursor.com/docs/hooks,
// fetched 2026-09-28). So when the nearest project .cursor/mcp.json runs an OpenCadre proxy installed somewhere else --
// another workspace, another credential -- the machine-wide stamp would win and be rejected by that proxy. Only the
// hook installed beside THAT proxy may sign; this one stays silent. A project server that points at this hook's own
// install (what `connect` writes) is ours, and is stamped as before. Same rule as codexProjectProxyMatchesThisHook.
function cursorProjectProxyMatchesThisHook() {
  const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const here = norm(installRoot(import.meta.url));
  const home = norm(process.env.HOME || process.env.USERPROFILE || homedir());
  for (let d = resolve(hookCwd(input)); ; d = dirname(d)) {
    const file = join(d, ".cursor", "mcp.json");
    // ~/.cursor/mcp.json is the user's own config, not a project's.
    if (norm(d) !== home && existsSync(file)) {
      // parseJsonc answers null (it does not throw) for a file it cannot read: that is "unknown", never "no servers".
      let config;
      try { config = parseJsonc(readFileSync(file, "utf8")); } catch { return false; }
      if (!config || typeof config !== "object") return false;
      const servers = config.mcpServers;
      const proxyOf = (s) => (Array.isArray(s?.args) ? s.args.find((a) => typeof a === "string" && /(?:^|[\\/])opencadre-mcp\.mjs$/i.test(a)) : undefined);
      const ours = Object.entries(servers && typeof servers === "object" ? servers : {})
        .filter(([name, s]) => /^opencadre/i.test(name) || proxyOf(s));
      // The nearest project config decides: every OpenCadre server in it must be the proxy beside this hook.
      return ours.every(([, s]) => proxyOf(s) && norm(dirname(proxyOf(s))) === here);
    }
    if (existsSync(join(d, ".git")) || dirname(d) === d) return true;
  }
}
function projectDefinesOurServer(where) {
  const start = resolve(process.cwd());
  // `git`: the nearest folder up from the session's holding a `.git`, else the filesystem root.
  const gitTop = () => {
    for (let d = start; ; d = dirname(d)) {
      if (existsSync(join(d, ".git"))) return d;
      if (dirname(d) === d) return d;
    }
  };
  const top = where.top === "git" ? gitTop() : process.env[where.top] ? resolve(process.env[where.top]) : start;
  const dirs = [];
  for (let d = start; ; d = dirname(d)) {
    dirs.push(d);
    if (d === top || dirname(d) === d || !(d.startsWith(top.endsWith(sep) ? top : top + sep))) break;
  }
  if (!dirs.includes(top)) dirs.push(top);
  // The home folder's own files are the user's configs, not a project's (connect writes OpenCadre's server into
  // ~/.cursor/mcp.json), so a session working in ~ is not refused for them (review of 8fe0ca9, S4).
  const home = resolve(process.env.HOME || process.env.USERPROFILE || homedir());
  for (const d of dirs) {
    if (d === home) continue;
    const files = where.files.map((f) => join(d, f));
    try {
      for (const [folder, name] of where.dirs) {
        if (existsSync(join(d, folder))) for (const f of readdirSync(join(d, folder))) if (name.test(f)) files.push(join(d, folder, f));
      }
      for (const file of files) {
        if (!existsSync(file)) continue;
        const text = readFileSync(file, "utf8");
        if (/(rc|\.toml)$/.test(file) ? text.includes(SESSION_SERVER) : definesOurs(text)) return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}
if ((client === "codex" && !codexProjectProxyMatchesThisHook())
  || (client === "cursor" && !cursorProjectProxyMatchesThisHook())
  || (PROJECT_SERVER_FILES[client] && projectDefinesOurServer(PROJECT_SERVER_FILES[client]))) {
  process.stderr.write(`opencadre-session-stamp: this project defines its own "${SESSION_SERVER}" server, so its calls are not stamped.\n`);
  silent();
}

// The stamp always OVERWRITES whatever the model put in this field: the model is never a source of
// identity. Every other argument is carried through untouched.
// Dated, so a stamp copied out of a harness's own record of the call (Gemini and Codex keep one on disk) expires.
// A client whose one proxy serves several folders also gets the session's folder signed in (stampsFolder), and, being
// new, no undated v1 signature.
const stamp = stampsFolder(client)
  ? mintStamp(device.credential, sessionId, Date.now(), { folder: hookCwd(input), v1: false })
  : mintStamp(device.credential, sessionId);
// Codex and Gemini replace the arguments, so they get the whole object back; a harness that merges (the dialect row's
// `stampAlone`: Cursor, Devin, Crush) gets only the stamp.
const updatedInput = dialectFor(client).stampAlone ? { [STAMP_FIELD]: stamp } : { ...(toolInput ?? {}), [STAMP_FIELD]: stamp };
// Cursor's Windows hook runner may see exit before the final stdout event when
// several hooks run together. Flush synchronously, then keep the child alive
// briefly so the runner can forward the updated arguments before it exits.
if (client === "cursor") {
  writeSync(1, updatedInputOutput(client, updatedInput) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 200));
} else {
  process.stdout.write(updatedInputOutput(client, updatedInput));
}
