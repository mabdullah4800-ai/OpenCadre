// `connect --upgrade` brings every ALREADY-CONNECTED client's OpenCadre-owned config onto the current plan (premise plan
// §3.C, PR-B). Before this, `--upgrade` refreshed helper files only: a matcher change such as F8's PowerShell gate (#676)
// never reached an existing install, doctor said `gate_outdated`, and the fix was a second, different command.
//
// THE RULES (review of the PR-B plan, Codex-049a):
//   - Only a client that is already connected is touched, and inside it only an entry whose OpenCadre ownership is
//     PROVEN: an `opencadre-session` server entry whose args name THIS install's proxy, or a hook handler whose command
//     names a helper in THIS install's bin. Hooks that point at a repo checkout (scripts/install-session-hooks.mjs) or
//     another home are reported and left alone: rewriting them would move every command string.
//   - Never ADD an entry here. A handler the current plan has and the file lacks may have been removed on purpose, and
//     nothing records which; it is reported with the command that adds it (`connect`). Explicit disables are kept and
//     reported: a Codex `[hooks.state.'…'] enabled = false`, an MCP entry's `disabled: true` / `enabled: false`.
//   - Positions never move on Codex. Codex keys trust and `enabled` by `<file>:<event>:<group>:<handler>` and hashes the
//     event, the group's matcher and the whole normalised handler (openai/codex codex-rs/hooks/src/engine/discovery.rs
//     `hook_hash`, `crate::hook_key`; read at rust-v0.157.0, unchanged at rust-v0.159.2 and main 8ea2428c). A reconcile
//     that would move any handler's slot there is not applied; one that changes a hashed field is applied and names
//     every hook Codex may list for review -- "review status unverified", never "trust is now stale": OpenCadre does
//     not compute Codex's hash, so it cannot know (review of #692 at f640bf73).
//   - Snapshot -> plan -> apply -> revalidate, under the installer lock (generations.mjs acquireInstaller). Each file is
//     compared with its snapshot immediately before it is replaced; a mismatch re-plans from the new bytes once, and a
//     second mismatch leaves that file exactly as the other writer left it. Never an overwrite of bytes not planned from.
//   - Every replaced file is first copied, fsynced, to <file>.bak-<timestamp> (connect's naming), then replaced through
//     a temp file and a rename, so a reader sees the old bytes or the new ones.
//
// WHAT IS APPLIED vs REPORTED. Claude Code, Codex, Cursor, Gemini CLI and Qwen Code (the HOOK_CLIENTS, whose writers
// live in session-hooks.mjs) are reconciled here. Every other connected computer tool is PLANNED with connect's own
// writer and, when that plan differs from its file, reported with the command that applies it (`connect --client <x>`):
// their writers re-add removed entries and were not built to tell a removed entry from a missing one.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { codexHome, clientConfigFile, readExistingServer, SESSION_SERVER } from "./clients.mjs";
import {
  sessionServerArgs, planOpencodeSessionServer, planWindsurfHooks, planCopilotSessionServer, planCopilotHooks, planGooseSessionServer,
  planGoosePlugin, planAmpSessionServer, planAmpPlugin, planAntigravitySessionServer, planDevinSessionServer, planDevinHooks,
  planDroidSessionServer, planDroidHooks, planCrushConfig, planVibeSessionServer, planVibeHooks, planGrokSessionServer, planGrokHooks,
  planClineSessionServer, planClineHooks, planKiloConfig, DEVICE_CLIENTS,
} from "./device.mjs";
import { planAntigravityHooks } from "./antigravity-hooks.mjs";
import { planAntigravityRules } from "./antigravity-rules.mjs";
import { HOOK_MARKERS, planSessionHooks, sessionHooksFile } from "./session-hooks.mjs";
import { acquireInstaller, readPointer, renameRetry } from "./generations.mjs";
import { codexHookStates, recordHookChanges } from "./codex-hook-state.mjs";

export { codexHookStates };

export const LABELS = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI", qwen: "Qwen Code", opencode: "OpenCode", amp: "Amp", kilo: "Kilo Code", cline: "Cline", devin: "Devin", droid: "Factory Droid", crush: "Crush", vibe: "Mistral Vibe", goose: "Goose", copilot: "Copilot CLI", windsurf: "Windsurf", antigravity: "Antigravity", grok: "Grok Build" };

/** Clients whose OpenCadre-owned entries this module applies; the rest of DEVICE_CLIENTS are planned and reported. */
export const APPLY_CLIENTS = ["claude-code", "codex", "cursor", "gemini", "qwen"];

/** What each vendor records about a hook, as far as OpenCadre has established it.
 *   none     Claude Code: no per-hook trust record that OpenCadre knows of; a changed hook loads in the next session.
 *   hash     Codex: MEASURED from its source (see the header); trust is per position and per hashed identity.
 *   unknown  Cursor, Gemini CLI, Qwen Code: no per-hook trust record found (Cursor's docs describe workspace trust only),
 *            and none ruled out, so a change tells the user to check the app rather than promising nothing is owed. */
export const TRUST_MODEL = { "claude-code": "none", codex: "hash", cursor: "unknown", gemini: "unknown", qwen: "unknown" };

const HANDLER_NAMES = { awareness: "awareness", wake: "idle wake", usage: "usage report", gate: "approval gate", "gate-report": "command record", "gate-typed-commit": "typed-commit record", stamp: "identity stamp", statusLine: "status line" };

/** Which OpenCadre handler a command is, finer than HOOK_MARKERS: the gate file also runs the Codex recorders. */
export function handlerId(command) {
  const c = String(command ?? "");
  if (c.includes(HOOK_MARKERS.gate)) return c.includes("--report") ? "gate-report" : c.includes("--typed-commit") ? "gate-typed-commit" : "gate";
  for (const name of ["wake", "awareness", "usage", "stamp"]) if (c.includes(HOOK_MARKERS[name])) return name;
  return null;
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const norm = (p) => String(p).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
// The helper files a hook command may run, by name (HOOK_MARKERS' values: awareness, wake, usage, gate, stamp).
const HELPER_FILES = new Set(Object.values(HOOK_MARKERS));
// Exactly the shapes session-hooks.mjs writes: `node "<dir>/<helper>.mjs"` then only flag words, client names and
// Qwen's `"$PPID"`. No shell operators, no other executable, nothing unquoted in the path.
const EXECUTED = /^node\s+"([^"\n]+)"((?:\s+(?:--[a-z][a-z-]*|[a-z][a-z0-9-]*|"\$PPID"))*)\s*$/;

/** The helper path a hook command PROVABLY executes (the exact form our writers emit), or null. */
export function executedHelper(command) {
  const m = EXECUTED.exec(String(command ?? ""));
  if (!m) return null;
  const file = m[1].replaceAll("\\", "/").split("/").pop();
  return HELPER_FILES.has(file) ? m[1] : null;
}
/** A file's text, or null ONLY when it does not exist (ENOENT). Any other read error (EISDIR, EACCES, EBUSY…) THROWS:
 * an unreadable config is a component in an unknown state, never an absent one (review of #692, Olive, reproduced: an
 * EISDIR settings.json was dropped as "no hooks config" and the run said only "action"). Callers turn it into
 * "blocked", and an unknown state never authorises a write. */
const readRaw = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
};
/** One component's plan, with any read/parse error turned into a BLOCKED part that names the file and the error. */
const guarded = (file, plan) => {
  try {
    return plan();
  } catch (err) {
    return { status: "blocked", file, code: err.code, notes: [`${file} could not be read (${err.code ?? err.message}), so its state is unknown and it was left as it is. Fix access to it, then run the same command again.`] };
  }
};
const parseJson = (text) => JSON.parse(text.replace(/^﻿/, ""));
/** An error's message for a note that is printed and saved, without the source text V8 quotes into a JSON.parse error
 * (`Unexpected token 'o', "{"a": tokenSECRET"... is not valid JSON`): that text is the user's file, and may hold anything
 * (review of #708, F2). */
const safeMessage = (err) => String(err?.message ?? err).replace(/,\s*(?:\.\.\.)?".*"(?:\.\.\.)?\s+is not valid JSON/s, " (the file's text is not shown)");

export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const hookPathsFor = (binDir) => ({
  awarenessPath: join(binDir, "opencadre-awareness.mjs"), wakePath: join(binDir, "opencadre-wake.mjs"), usagePath: join(binDir, "opencadre-usage.mjs"),
  gatePath: join(binDir, "opencadre-approval-gate.mjs"), stampPath: join(binDir, "opencadre-session-stamp.mjs"),
});

// ---- hook files ------------------------------------------------------------------------------------------------------

/** Every handler in a hooks config, in file order: { event, gi, hi, handler, matcher, id }. Claude Code, Codex, Gemini and
 * Qwen group handlers (`[{ matcher, hooks: [...] }]`); Cursor lists them flat, so each entry is its own slot. */
function slots(config, flat) {
  const out = [];
  for (const [event, groups] of Object.entries(isObject(config?.hooks) ? config.hooks : {})) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) => {
      const handlers = flat ? [g] : Array.isArray(g?.hooks) ? g.hooks : [];
      handlers.forEach((h, hi) => out.push({ event, gi, hi, handler: h, matcher: flat ? h?.matcher : g?.matcher, id: handlerId(h?.command) }));
    });
  }
  return out;
}

/** Occurrence-qualified key per OpenCadre handler, so two of the same kind in one event stay distinct. */
function ownedByKey(list) {
  const seen = new Map();
  const map = new Map();
  for (const s of list) {
    if (!s.id) continue;
    const base = `${s.event}|${s.id}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    map.set(`${base}|${n}`, s);
  }
  return map;
}

const snake = (event) => event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
// codex-rs/hooks/src/events/common.rs matcher_pattern_for_event: these events drop the matcher before it is hashed.
const CODEX_MATCHERLESS = new Set(["UserPromptSubmit", "Stop", "Interrupt"]);

/** The fields Codex hashes for one handler (see the header), normalised the way discovery.rs normalises them: the
 * timeout defaults to 600 s (SessionEnd/Interrupt: 1 s, clamped to 1..3), additionalContextLimit 2500 is the default.
 * Used only to COMPARE before and after, never to claim a hash value: equal identities mean an unchanged hash. */
function codexIdentity(slot) {
  const h = slot.handler ?? {};
  const short = slot.event === "SessionEnd" || slot.event === "Interrupt";
  const t = typeof h.timeout === "number" ? h.timeout : typeof h.timeoutSec === "number" ? h.timeoutSec : undefined;
  const timeout = short ? Math.min(Math.max(t ?? 1, 1), 3) : Math.max(t ?? 600, 1);
  const limit = h.additionalContextLimit ?? h.additional_context_limit;
  return {
    event: slot.event,
    matcher: CODEX_MATCHERLESS.has(slot.event) ? null : (slot.matcher ?? null),
    type: h.type ?? "command",
    command: process.platform === "win32" ? (h.commandWindows ?? h.command_windows ?? h.command) : h.command,
    timeout,
    async: h.async ?? false,
    statusMessage: h.statusMessage ?? h.status_message ?? null,
    additionalContextLimit: limit === 2500 ? null : (limit ?? null),
  };
}

/**
 * One hooks file of a HOOK_CLIENT: { status, file, before, after, changes, notes, actions, reviewHooks }.
 * status: "absent" (no OpenCadre handler: this part is not connected), "current", "apply", "report" (left alone, the user
 * must act), "blocked" (could not be read).
 */
function planHooksPart({ home, client, binDir }) {
  const file = sessionHooksFile(home, client);
  const raw = readRaw(file);
  if (raw === null || !Object.values(HOOK_MARKERS).some((m) => raw.includes(m))) return { status: "absent", file };
  const flat = client === "cursor";
  let original;
  try {
    original = parseJson(raw);
  } catch (err) {
    return { status: "blocked", file, before: raw, notes: [`${file} is not valid JSON (${safeMessage(err)}); it was left as it is. Fix it, then run the same command again.`] };
  }
  const beforeSlots = slots(original, flat);
  const owned = beforeSlots.filter((s) => s.id);
  if (owned.length === 0) return { status: "absent", file };
  // OWNERSHIP IS PROVEN BY EXECUTION, NOT BY A SUBSTRING (review of #692, Olive, reproduced): `echo "<bin>/opencadre-
  // awareness.mjs"` names our helper without running it, and the writer would have turned it into a `node` invocation the
  // user never ran. A handler naming one of our helpers is OURS only in the exact form our writers emit; anything else
  // (echo, a wrapper, a pipe, extra shell text) leaves the whole file as it is, reported.
  const withStatusLine = client === "claude-code" && String(original.statusLine?.command ?? "").includes(HOOK_MARKERS.usage)
    ? [...owned, { event: "statusLine", id: "statusLine", handler: original.statusLine }] : owned;
  const ambiguous = withStatusLine.filter((s) => !executedHelper(s.handler?.command));
  if (ambiguous.length) {
    return { status: "report", file, before: raw, notes: [`${file} has hooks that mention an OpenCadre helper without simply running it (${ambiguous.map((s) => `${s.event} ${HANDLER_NAMES[s.id] ?? s.id}`).join(", ")}), so this file was left as it is.`], actions: ["Review those hooks yourself; run `connect` if you want OpenCadre's own entries written."], todo: [`Some hooks in ${file} mention an OpenCadre helper without simply running it, so OpenCadre left that file alone. Check those hooks, or run \`connect\` to write OpenCadre's own.`] };
  }
  const elsewhere = withStatusLine.filter((s) => norm(dirname(executedHelper(s.handler?.command))) !== norm(binDir));
  if (elsewhere.length) {
    const where = [...new Set(elsewhere.map((s) => dirname(executedHelper(s.handler?.command))))];
    return { status: "report", file, before: raw, notes: [`OpenCadre's hooks in ${file} run helpers from ${where.join(", ")}, not this install (${binDir}), so they were left as they are.`], actions: [`Re-run whatever installed them (scripts/install-session-hooks.mjs in a checkout), or run \`connect\` to point them at ${binDir}.`], todo: [`OpenCadre's hooks in ${file} run helpers from another folder (${where.join(", ")}), so they were left alone. Run \`connect\` to point them at this install.`] };
  }
  let plan;
  try {
    plan = planSessionHooks({ home, client, ...hookPathsFor(binDir) });
  } catch (err) {
    return { status: "blocked", file, before: raw, notes: [safeMessage(err)] };
  }
  const before = plan.before; // the bytes the plan was made from: the snapshot every later write is compared with
  const config = JSON.parse(plan.after);
  // Never ADD: drop every OpenCadre handler the plan added (by kind and event), then the empty shells left behind.
  const beforeKeys = new Set(ownedByKey(beforeSlots).keys());
  const missing = [];
  const counts = new Map();
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const keep = (h) => {
      const id = handlerId(h?.command);
      if (!id) return true;
      const base = `${event}|${id}`;
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      if (beforeKeys.has(`${base}|${n}`)) return true;
      missing.push({ event, id });
      return false;
    };
    const kept = [];
    for (const g of groups) {
      if (flat) {
        if (keep(g)) kept.push(g);
        continue;
      }
      if (!Array.isArray(g?.hooks)) {
        kept.push(g);
        continue;
      }
      const had = g.hooks.length;
      g.hooks = g.hooks.filter(keep);
      if (g.hooks.length > 0 || had === 0) kept.push(g);
    }
    if (kept.length === 0 && !Object.hasOwn(original.hooks ?? {}, event)) delete config.hooks[event];
    else config.hooks[event] = kept;
  }
  if (client === "claude-code" && !original.statusLine && config.statusLine) {
    delete config.statusLine;
    missing.push({ event: "statusLine", id: "statusLine" });
  }
  if (flat && original.version === undefined) delete config.version;

  const notes = [];
  const actions = [];
  // `todo`: the same actions in plain words, for the short report (userActions). `actions` stays the full form.
  const todo = [];
  const them = (n) => (n === 1 ? "it" : "them");
  if (missing.length) {
    const names = missing.map((m) => `${m.event} ${HANDLER_NAMES[m.id] ?? m.id}`).join(", ");
    actions.push(`Not added, because it may have been removed on purpose: ${names}. Run \`connect\` to add ${them(missing.length)}.`);
    todo.push(`${missing.length === 1 ? "One OpenCadre hook was" : `${missing.length} OpenCadre hooks were`} not added back, because you may have removed ${them(missing.length)} on purpose: ${names}. Run \`connect\` if you want ${them(missing.length)}.`);
  }
  // An OpenCadre hook switched OFF in Codex stays off, and is always said, changed or not (review of #692): doctor calls
  // it a fault (hooks_disabled), so the upgrade must not report "nothing owed" over it.
  if (TRUST_MODEL[client] === "hash") {
    const states = codexHookStates(home, file);
    const off = owned.filter((s) => states.get(`${snake(s.event)}:${s.gi}:${s.hi}`)?.enabled === false);
    if (off.length) {
      const names = off.map((s) => `${s.event} ${HANDLER_NAMES[s.id] ?? s.id}`).join(", ");
      actions.push(`You turned off ${names} in Codex; it stays off. Turn it back on in Codex Settings > Hooks (or /hooks in Codex CLI) if OpenCadre should run it.`);
      todo.push(`You turned off ${names} in Codex, and ${off.length === 1 ? "it stays" : "they stay"} off. To turn ${them(off.length)} back on, use Settings > Hooks in Codex (or /hooks in Codex CLI).`);
    }
  }
  if (deepEqual(original, config)) {
    return { status: actions.length ? "report" : "current", file, before, after: before, changes: [], notes, actions, todo };
  }

  // What changed, handler by handler (ours only: nothing else may change, and the check below proves it).
  const afterSlots = slots(config, flat);
  const ownBefore = ownedByKey(beforeSlots);
  const ownAfter = ownedByKey(afterSlots);
  const changes = [];
  for (const [key, b] of ownBefore) {
    const a = ownAfter.get(key);
    const name = `${b.event} ${HANDLER_NAMES[b.id] ?? b.id}`;
    if (!a) {
      changes.push({ key, kind: "removed", text: `${name}: removed (the current plan no longer installs it here)` });
      continue;
    }
    if ((b.matcher ?? "") !== (a.matcher ?? "")) changes.push({ key, kind: "matcher", text: `${name}: matcher ${JSON.stringify(b.matcher ?? "")} -> ${JSON.stringify(a.matcher ?? "")}` });
    if (b.handler?.command !== a.handler?.command) changes.push({ key, kind: "command", text: `${name}: command changed` });
    const rest = (h) => Object.fromEntries(Object.entries(h ?? {}).filter(([k]) => k !== "command" && !(flat && k === "matcher")));
    if (!deepEqual(rest(b.handler), rest(a.handler))) changes.push({ key, kind: "fields", text: `${name}: ${Object.keys({ ...rest(b.handler), ...rest(a.handler) }).filter((k) => !deepEqual(b.handler?.[k], a.handler?.[k])).join(", ")} changed` });
    if (b.gi !== a.gi || b.hi !== a.hi) changes.push({ key, kind: "position", text: `${name}: moved from group ${b.gi} handler ${b.hi} to group ${a.gi} handler ${a.hi}` });
  }
  if (!deepEqual(original.statusLine, config.statusLine)) changes.push({ key: "statusLine", kind: "command", text: "status line command changed" });
  // Foreign handlers must be untouched in content; their POSITION may move only where nothing keys trust by position.
  const foreignBefore = beforeSlots.filter((s) => !s.id);
  const foreignAfter = afterSlots.filter((s) => !s.id);
  const foreignSame = foreignBefore.length === foreignAfter.length && foreignBefore.every((s, i) => s.event === foreignAfter[i].event && deepEqual(s.handler, foreignAfter[i].handler));
  if (!foreignSame) {
    return { status: "report", file, before, notes: [`Bringing OpenCadre's hooks in ${file} current would change a hook that is not OpenCadre's, so this file was left as it is.`], actions: ["Run `connect` and review the result, or tell OpenCadre support."], todo: [`${file} was left alone, because updating OpenCadre's hooks there would change a hook that isn't OpenCadre's. Run \`connect\` and review the result.`] };
  }
  const foreignMoved = foreignBefore.some((s, i) => s.gi !== foreignAfter[i].gi || s.hi !== foreignAfter[i].hi || (s.matcher ?? "") !== (foreignAfter[i].matcher ?? ""));
  const moved = foreignMoved || changes.some((c) => c.kind === "position" || c.kind === "removed");

  let reviewHooks = [];
  let reviewSlots = [];
  if (TRUST_MODEL[client] === "hash") {
    // Codex keys trust and `enabled` by position: moving any handler would hand one hook's decision to another.
    if (moved) {
      return { status: "report", file, before, changes, notes: [`Bringing OpenCadre's hooks in ${file} current would move hooks to new positions, and Codex keeps each hook's trust and on/off setting by position, so this file was left as it is.`], actions: ["Run `connect` to apply it, then open Codex Settings > Hooks (or /hooks in Codex CLI) and review every hook in this file, OpenCadre's and your own."], todo: [`${file} was left alone, because updating it would move hooks, and Codex keeps each hook's approval by position. Run \`connect\`, then review every hook in that file in Settings > Hooks in Codex (or /hooks in Codex CLI).`] };
    }
    const states = codexHookStates(home, file);
    const hashChanged = [...ownBefore].filter(([key, b]) => !deepEqual(codexIdentity(b), codexIdentity(ownAfter.get(key))));
    const disabled = hashChanged.filter(([, b]) => states.get(`${snake(b.event)}:${b.gi}:${b.hi}`)?.enabled === false);
    if (disabled.length) {
      return { status: "report", file, before, changes, notes: [`You turned off ${disabled.map(([, b]) => `${b.event} ${HANDLER_NAMES[b.id] ?? b.id}`).join(", ")} in Codex, so OpenCadre's hooks in ${file} were left exactly as they are.`], actions: ["Turn it back on in Codex Settings > Hooks (or /hooks in Codex CLI) and run the same command again, or keep it off."], todo: [`You turned off ${disabled.map(([, b]) => `${b.event} ${HANDLER_NAMES[b.id] ?? b.id}`).join(", ")} in Codex, so OpenCadre's hooks in ${file} were left as they are. Turn ${them(disabled.length)} back on in Settings > Hooks in Codex (or /hooks in Codex CLI) and run the same command again, or leave ${them(disabled.length)} off.`] };
    }
    reviewHooks = hashChanged.map(([, b]) => `${b.event} ${HANDLER_NAMES[b.id] ?? b.id}`);
    // Positions are unchanged here (moves are refused above), so each slot key is the same before and after.
    reviewSlots = hashChanged.map(([, b]) => ({ slot: `${snake(b.event)}:${b.gi}:${b.hi}`, name: `${b.event} ${HANDLER_NAMES[b.id] ?? b.id}` }));
  }
  const after = `${JSON.stringify(config, null, 2)}\n`;
  return { status: "apply", file, before, after, changes, notes, actions, todo, reviewHooks, reviewSlots };
}

// ---- server entries --------------------------------------------------------------------------------------------------

function wantedServer(client, proxyPath) {
  const args = sessionServerArgs(proxyPath, client);
  if (client === "claude-code" || client === "cursor") return { type: "stdio", command: "node", args };
  return { command: "node", args, ...(client === "qwen" ? { alwaysLoadTools: true } : {}) };
}

/** The `opencadre-session` entry of a JSON client's MCP config (Claude Code ~/.claude.json, Cursor ~/.cursor/mcp.json,
 * Gemini/Qwen settings.json). Only the fields OpenCadre writes are compared and set; every other field of the entry
 * (`env`, `disabled`, a user's own additions) and every other key of the file is kept. */
function planJsonServerPart({ home, client, proxyPath }) {
  const file = client === "claude-code" ? join(home, ".claude.json") : clientConfigFile(home, client);
  const raw = readRaw(file);
  if (raw === null || !raw.includes(SESSION_SERVER)) return { status: "absent", file };
  let config;
  try {
    config = parseJson(raw);
  } catch (err) {
    return { status: "blocked", file, before: raw, notes: [`${file} is not valid JSON (${safeMessage(err)}); it was left as it is.`] };
  }
  const entry = config?.mcpServers?.[SESSION_SERVER];
  if (!isObject(entry)) return { status: "absent", file };
  const { notes, actions, todo } = serverOff(entry.disabled === true || entry.enabled === false, client, file);
  if (!Array.isArray(entry.args) || norm(entry.args[0] ?? "") !== norm(proxyPath)) {
    return { status: "report", file, before: raw, notes: [...notes, `The ${SESSION_SERVER} server in ${file} runs ${Array.isArray(entry.args) ? shownPath(entry.args[0]) : "something else"}, not this install's ${proxyPath}, so it was left as it is.`], actions: [...actions, "Run `connect` to point it at this install."], todo: [...todo, `The OpenCadre server entry in ${file} runs another install, so it was left alone. Run \`connect\` to point it at this one.`] };
  }
  const wanted = wantedServer(client, proxyPath);
  const stale = Object.keys(wanted).filter((k) => !deepEqual(entry[k], wanted[k]));
  if (stale.length === 0) return { status: "current", file, before: raw, after: raw, changes: [], notes, actions, todo };
  const next = { ...config, mcpServers: { ...config.mcpServers, [SESSION_SERVER]: { ...entry, ...wanted } } };
  // The PREVIOUS value is never shown: it is the user's text and may carry anything (a token in `args`, say), and this
  // report is printed and saved. It is in the backup. OpenCadre's new value is its own, so it is shown.
  return { status: "apply", file, before: raw, after: `${JSON.stringify(next, null, 2)}\n`, changes: stale.map((k) => ({ kind: "server", text: `${SESSION_SERVER} ${k}: ${k in entry ? "changed" : "added"}, now ${JSON.stringify(wanted[k])} (the previous value is in the backup)` })), notes, actions, todo, reviewHooks: [] };
}

/**
 * The opencadre-session server switched OFF in a client's config: OpenCadre keeps it off (the user's choice) but says
 * so as something owed, in the full report and the short one, exactly like an OpenCadre hook switched off in Codex: the
 * tool cannot reach OpenCadre there (no identity, mail or approvals), and doctor calls it a fault, so the upgrade must
 * not report "nothing for you to do" over it (review of #708, F1).
 */
function serverOff(off, client, file) {
  if (!off) return { notes: [], actions: [], todo: [] };
  const tool = LABELS[client] ?? client;
  return {
    notes: [`The ${SESSION_SERVER} server is switched off in ${file}; it stays off.`],
    actions: [`The ${SESSION_SERVER} server is switched off in ${file}, so ${tool} cannot reach OpenCadre there. Switch it back on in ${tool}'s MCP settings if OpenCadre should run there.`],
    todo: [`OpenCadre's server is switched off in ${tool} (${file}), so ${tool} has no OpenCadre identity, mail or approvals. Switch it back on in ${tool}'s MCP settings if you want OpenCadre there; OpenCadre leaves it off.`],
  };
}

/** A configured program path, for a note that is printed and saved: shown only when it is a plain path to a script, so a
 * value that is not one (it could hold anything) never reaches the report. */
function shownPath(value) {
  return typeof value === "string" && /^[^\s"'`]+\.(?:mjs|cjs|js)$/i.test(value) ? value : "something else";
}

/** Codex's `[mcp_servers.opencadre-session]` table in config.toml, edited LINE BY LINE: only its `command`, `args` and
 * `tool_timeout_sec` lines (what planCodexSessionServer writes) are compared and replaced; every other line of the file,
 * including an `enabled = false` in this table, is kept byte for byte. */
function planCodexServerPart({ home, proxyPath }) {
  const file = join(codexHome(home), "config.toml");
  const raw = readRaw(file);
  if (raw === null) return { status: "absent", file };
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[\s*mcp_servers\s*\.\s*(["']?)opencadre-session\1\s*\]\s*(#.*)?$/.test(l));
  if (start < 0) return { status: "absent", file };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^\s*\[/.test(lines[i])) { end = i; break; }
  const str = (s) => JSON.stringify(s);
  const wanted = { command: `command = ${str("node")}`, args: `args = [${sessionServerArgs(proxyPath, "codex").map(str).join(", ")}]`, tool_timeout_sec: "tool_timeout_sec = 300" };
  const at = (key) => {
    for (let i = start + 1; i < end; i++) if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) return i;
    return -1;
  };
  const { notes, actions, todo } = serverOff(lines.slice(start + 1, end).some((l) => /^\s*enabled\s*=\s*false\b/.test(l)), "codex", file);
  const argsLine = at("args");
  let args = null;
  try {
    args = argsLine < 0 ? null : JSON.parse(lines[argsLine].replace(/^\s*args\s*=\s*/, "").replace(/\s*#.*$/, ""));
  } catch { /* not a plain array of basic strings */ }
  if (!Array.isArray(args) || norm(args[0] ?? "") !== norm(proxyPath)) {
    return { status: "report", file, before: raw, notes: [...notes, `The ${SESSION_SERVER} server in ${file} does not run this install's ${proxyPath}, so it was left as it is.`], actions: [...actions, "Run `connect` to point it at this install."], todo: [...todo, `The OpenCadre server entry in ${file} runs another install, so it was left alone. Run \`connect\` to point it at this one.`] };
  }
  const changes = [];
  const next = [...lines];
  let insertAt = end;
  while (insertAt - 1 > start && next[insertAt - 1].trim() === "") insertAt--;
  for (const [key, line] of Object.entries(wanted)) {
    const i = at(key);
    if (i >= 0 && lines[i].trim() === line) continue;
    // Never the previous line (the user's text; it is in the backup), only OpenCadre's own new one.
    changes.push({ kind: "server", text: `${SESSION_SERVER} ${key}: ${i >= 0 ? "changed" : "added"}, now ${line} (the previous value is in the backup)` });
    if (i >= 0) next[i] = line;
    else next.splice(insertAt++, 0, line);
  }
  if (changes.length === 0) return { status: "current", file, before: raw, after: raw, changes: [], notes, actions, todo };
  return { status: "apply", file, before: raw, after: next.join(eol), changes, notes, actions, todo, reviewHooks: [] };
}

// ---- report-only clients ---------------------------------------------------------------------------------------------

/** connect's own writers for the computer tools this module does not apply (cli/bin/opencadre.mjs connectMachine). */
function reportPlanners({ home, binDir }) {
  const proxyPath = join(binDir, "opencadre-mcp.mjs");
  const hp = hookPathsFor(binDir);
  const a = { home, proxyPath, ...hp };
  return {
    opencode: () => [planOpencodeSessionServer(a)],
    windsurf: () => [planWindsurfHooks({ home, gatePath: hp.gatePath })],
    copilot: () => [planCopilotSessionServer(a), planCopilotHooks(a)],
    goose: () => [planGooseSessionServer(a), ...planGoosePlugin(a)],
    amp: () => [planAmpSessionServer(a), planAmpPlugin({ home, pluginPath: join(binDir, "opencadre-amp-plugin.mjs") })],
    antigravity: () => [planAntigravitySessionServer(a), planAntigravityHooks({ home, binDir }), planAntigravityRules({ home, binDir })],
    devin: () => [planDevinSessionServer(a), planDevinHooks(a)],
    droid: () => [planDroidSessionServer(a), planDroidHooks(a)],
    crush: () => [planCrushConfig(a)],
    vibe: () => [planVibeSessionServer(a), planVibeHooks(a)],
    grok: () => [planGrokSessionServer(a), planGrokHooks(a)],
    cline: () => [planClineSessionServer(a), ...planClineHooks({ home, hookPath: join(binDir, "opencadre-cline-hook.mjs") })],
    kilo: () => [planKiloConfig({ home, proxyPath, pluginPath: join(binDir, "opencadre-kilo-plugin.js") })],
  };
}

function sameContent(before, after) {
  if (before === after) return true;
  try {
    return deepEqual(parseJson(before), parseJson(after));
  } catch {
    return false;
  }
}

/** true / false, or the read error: a config that exists but cannot be read is UNKNOWN, reported blocked, not "absent". */
function connectedReportClient({ home, client }) {
  try {
    if (client === "windsurf") return (readRaw(join(home, ".codeium", "windsurf", "hooks.json")) ?? "").includes("opencadre-approval-gate");
    return readExistingServer({ home, client }).sessionServer === true;
  } catch (err) {
    return err?.code && err.code !== "ENOENT" ? err : false;
  }
}

// ---- plan and apply --------------------------------------------------------------------------------------------------

function planClientParts({ home, client, binDir }) {
  const proxyPath = join(binDir, "opencadre-mcp.mjs");
  return [
    { kind: "server", plan: () => guarded(client === "codex" ? join(codexHome(home), "config.toml") : client === "claude-code" ? join(home, ".claude.json") : clientConfigFile(home, client), () => (client === "codex" ? planCodexServerPart({ home, proxyPath }) : planJsonServerPart({ home, client, proxyPath }))) },
    { kind: "hooks", plan: () => guarded(sessionHooksFile(home, client), () => planHooksPart({ home, client, binDir })) },
  ];
}

/** Plans every connected client without writing: { clients: [{ client, parts: [{ kind, ...partPlan }] }] }. Used for
 * --dry-run as is, and again under the lock by applyReconcile. */
export function planReconcile({ home }) {
  const binDir = join(home, ".opencadre", "bin");
  const clients = [];
  for (const client of APPLY_CLIENTS) {
    const parts = planClientParts({ home, client, binDir }).map((p) => ({ kind: p.kind, replan: p.plan, ...p.plan() }));
    // Gemini and Qwen keep the server and the hooks in ONE settings.json: both parts are applied in turn, each
    // re-planned from the file as the previous one left it (applyReconcile).
    const present = parts.filter((p) => p.status !== "absent");
    if (present.length) clients.push({ client, parts: present });
  }
  const planners = reportPlanners({ home, binDir });
  for (const client of DEVICE_CLIENTS) {
    if (APPLY_CLIENTS.includes(client) || !planners[client]) continue;
    const connected = connectedReportClient({ home, client });
    if (connected instanceof Error) {
      clients.push({ client, parts: [{ kind: "config", status: "blocked", file: connected.path ?? clientConfigFile(home, client), notes: [`${connected.path ?? "Its config"} could not be read (${connected.code}), so whether OpenCadre is connected there is unknown; it was left as it is.`] }] });
      continue;
    }
    if (!connected) continue;
    let plans;
    try {
      plans = planners[client]();
    } catch (err) {
      clients.push({ client, parts: [{ kind: "config", status: "blocked", file: clientConfigFile(home, client), notes: [safeMessage(err)] }] });
      continue;
    }
    const stale = plans.filter((p) => !sameContent(p.before ?? "", p.after ?? ""));
    clients.push({
      client,
      parts: stale.length === 0
        ? [{ kind: "config", status: "current", file: plans[0]?.file, changes: [] }]
        : stale.map((p) => ({ kind: "config", status: "report", file: p.file, notes: [`${p.file} differs from what this version of OpenCadre writes; --upgrade does not rewrite ${LABELS[client] ?? client}'s files yet.`], actions: [`Run \`connect --client ${client}\` to bring it current.`], todo: [`${p.file} is out of date, and --upgrade does not update ${LABELS[client] ?? client} yet. Run \`connect --client ${client}\` to update it.`] })),
    });
  }
  return { binDir, clients };
}

function writeDurableCopy(file, text) {
  const fd = openSync(file, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes `text` to a NEW backup file next to `file` and returns its path. Never overwrites anything: the name is
 * `<file>.bak-<timestamp>`, then `-2`, `-3`… until one can be created exclusively (`wx`). Two parts of one shared file
 * (Gemini and Qwen keep the server and the hooks in one settings.json) therefore get two receipts, and the first still
 * holds the ORIGINAL bytes (review of #692, Olive, reproduced: one timestamp for both made the second backup overwrite
 * the first). A pre-existing `.bak-*` of the same name -- a file or a directory -- is skipped, never replaced.
 * `onCreated(name)` runs as soon as the file exists, so a failure while writing it still names it in the receipt. */
function createBackup(file, text, now, onCreated = () => {}) {
  const stamp = `${file}.bak-${now.toISOString().replace(/[:.]/g, "-")}`;
  for (let n = 1; n <= 100; n++) {
    const name = n === 1 ? stamp : `${stamp}-${n}`;
    let fd;
    try {
      fd = openSync(name, "wx", 0o600);
    } catch (err) {
      if (err.code === "EEXIST" || err.code === "EISDIR" || (err.code === "EPERM" && existsAny(name))) continue;
      throw err;
    }
    onCreated(name);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return name;
  }
  throw Object.assign(new Error(`no free backup name next to ${file}`), { code: "EEXIST" });
}
const existsAny = (p) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Replace `file` with `text` through a temp file and a rename, owner-only (a client config may hold an agent key). */
function replaceAtomically(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.opencadre-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeDurableCopy(tmp, text);
  try {
    renameRetry(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Applies a reconcile under the installer lock. For every part: plan from the file as it is now (the snapshot), and if
 * it is to be applied, compare the file with that snapshot again immediately before replacing it; a mismatch re-plans
 * once, a second mismatch leaves the file as the other writer left it ("blocked"). After the write the file is read
 * back and planned again: it must hold what was written and plan as current.
 *
 * `onStep(step, info)` lets tests act at exactly these points: "planned" (before the snapshot comparison), "backup"
 * (before the backup is written), "replace" (before the rename), "replaced" (after it, before revalidation). A step that
 * THROWS is treated like an I/O failure at that point.
 *
 * A PARTIAL APPLY KEEPS ITS RECEIPT (review of #692, reproduced by Olive and Codex-049a): an error at any stage of any
 * file never escapes and never erases what was already done. The failing file is "failed" (not changed; any partial
 * backup named) or, after its rename, "applied-unverified" (changed; its backup named); every file not yet attempted is
 * "deferred" (not read for writing, not changed); every file already written keeps "applied" and its backup. Nothing is
 * rolled back: a rollback could overwrite another writer, and each file is consistent on its own.
 */
export function applyReconcile({ home, onStep = () => {}, now = new Date() }) {
  const binDir = join(home, ".opencadre", "bin");
  const release = acquireInstaller(binDir);
  try {
    let clients;
    try {
      ({ clients } = planReconcile({ home }));
    } catch (err) {
      return { binDir, clients: [], failure: `planning failed before any file was written (${safeMessage(err)})` };
    }
    let stopped = null; // the first failure: every later "apply" part is deferred, not attempted
    for (const c of clients) {
      c.parts = c.parts.map((part) => {
        if (part.status !== "apply" || typeof part.replan !== "function") return part;
        if (stopped) return { ...part, status: "deferred", notes: [...(part.notes ?? []), `Not attempted, because ${stopped} failed first; this file was not changed. Run the same command again.`] };
        return applyPart(c.client, part);
      });
    }
    return { binDir, clients };

    function applyPart(client, part) {
      let p = { file: part.file };
      let stage = "planning";
      let written = false;
      let backupPath = null; // the receipt: set only once a backup file of OURS exists
      try {
        p = part.replan(); // the snapshot, taken under the lock
        for (let attempt = 0; attempt < 2; attempt++) {
          if (p.status !== "apply") return { kind: part.kind, replan: part.replan, ...p };
          stage = "planning";
          onStep("planned", { client, file: p.file, attempt });
          if (readRaw(p.file) !== p.before) {
            p = part.replan();
            continue;
          }
          stage = "backup";
          onStep("backup", { client, file: p.file });
          // The copy must equal the snapshot (it is what a manual restore uses); fsynced so it outlives a crash; created
          // EXCLUSIVELY under a name no earlier receipt holds (createBackup).
          backupPath = createBackup(p.file, p.before, now, (name) => { backupPath = name; });
          stage = "replace";
          onStep("replace", { client, file: p.file });
          replaceAtomically(p.file, p.after);
          written = true;
          stage = "revalidation";
          onStep("replaced", { client, file: p.file });
          const back = readRaw(p.file);
          const again = part.replan();
          if (again.status === "blocked") throw Object.assign(new Error((again.notes ?? []).join(" ")), { code: again.code ?? "EUNKNOWN" });
          // A field Codex hashes changed in these OpenCadre hooks. Recorded as WHAT and WHEN only (cli/lib/codex-hook-state.mjs)
          // so doctor can say "OpenCadre changed these hooks on <date> (review status unverified)". No Codex hash is read
          // or kept, and nothing here claims Codex's trust is now stale (review of #692 at f640bf73, Codex-049a).
          if (client === "codex" && part.kind === "hooks" && (p.reviewSlots ?? []).length) recordHookChanges(home, p.file, p.reviewSlots, { at: now, generation: readPointer(binDir).id });
          const verified = back === p.after && (again.status === "current" || (again.status === "report" && !(again.changes ?? []).length));
          return { kind: part.kind, replan: part.replan, ...p, status: verified ? "applied" : "applied-unverified", backup: backupPath, notes: [...(p.notes ?? []), ...(verified ? [] : [`${p.file} was written, then changed again by something else before OpenCadre could check it. Your previous version is kept as ${backupPath}. Run the same command again to review it.`])] };
        }
        stopped = p.file;
        return { kind: part.kind, status: "blocked", file: p.file, notes: [`${p.file} changed while OpenCadre was updating it, twice, so it was left exactly as the other program wrote it. Run the same command again when that program is idle.`] };
      } catch (err) {
        stopped = p.file ?? part.file;
        const file = p.file ?? part.file;
        const why = `${stage} failed (${err.code ?? err.message})`;
        if (written) {
          return { kind: part.kind, ...p, status: "applied-unverified", backup: backupPath, error: why, notes: [...(p.notes ?? []), `${file} WAS changed, then ${why}. Your previous version is kept as ${backupPath}. Run the same command again to check it.`] };
        }
        const partial = backupPath ? ` A backup copy of the unchanged file was ${stage === "backup" ? "started" : "made"} at ${backupPath}.` : "";
        return { kind: part.kind, ...p, status: "failed", error: why, notes: [...(p.notes ?? []), `${file} was NOT changed: ${why}.${partial}`] };
      }
    }
  } finally {
    release();
  }
}

/** green | action | blocked, over every part: the worst wins. "applied" with a Codex review to check is an action. */
export function reconcileOutcome(clients, failure = null) {
  if (failure) return "blocked";
  let outcome = "green";
  for (const c of clients) {
    for (const p of c.parts) {
      if (["blocked", "applied-unverified", "failed", "deferred"].includes(p.status)) return "blocked";
      if (p.status === "report" || (p.actions ?? []).length || trustActions(c.client, p).length) outcome = "action";
    }
  }
  return outcome;
}

/** The user actions a part leaves owed for vendor trust, given what it changes (or changed). */
export function trustActions(client, part) {
  if (!["apply", "applied", "applied-unverified"].includes(part.status) || part.kind !== "hooks") return [];
  if (TRUST_MODEL[client] === "hash") {
    return (part.reviewHooks ?? []).length ? [`Codex may list these OpenCadre hooks as changed and ask you to review them, because a setting it hashes changed: ${part.reviewHooks.join(", ")}. Review status unverified: check Codex Settings > Hooks (in the desktop app, after one ordinary message in your work folder) or /hooks in Codex CLI, and trust them if they are listed for review.`] : [];
  }
  if (TRUST_MODEL[client] === "unknown") return [`${LABELS[client]} may ask you to allow the changed OpenCadre hooks: whether it records approval per hook is not known. Check ${LABELS[client]}'s hooks settings once and allow them if asked.`];
  return [];
}

/** trustActions in plain words, for the short report: what to open and what to approve, nothing about hashes. */
export function trustTodo(client, part) {
  if (!["apply", "applied", "applied-unverified"].includes(part.status) || part.kind !== "hooks") return [];
  if (TRUST_MODEL[client] === "hash") {
    const n = (part.reviewHooks ?? []).length;
    return n ? [`Open Settings > Hooks in the Codex app (send one ordinary message in your work folder first, so Codex lists its hooks), or /hooks in Codex CLI, and approve the ${n === 1 ? "changed OpenCadre hook" : `${n} changed OpenCadre hooks`} if ${n === 1 ? "it is" : "they are"} listed for review.`] : [];
  }
  if (TRUST_MODEL[client] === "unknown") return [`${LABELS[client]} may ask you to allow the changed OpenCadre hooks. Check its hooks settings once and allow them if asked.`];
  return [];
}

const PROBLEM = ["blocked", "failed", "deferred", "applied-unverified"];

/**
 * What the user must do, in plain words, grouped per client: [{ client, label, items }], only clients with something to
 * do. The short report of `connect --upgrade` prints this as its numbered list; describeReconcile stays the full form.
 *
 * NOTHING SAFETY-RELEVANT MAY BE LEFT OUT HERE, because the short report is what most users read: a file that could not
 * be read or written (its own note, which says what happened and to run the command again), every action a part owes
 * (`todo`, one per `actions` entry), and every hook a vendor may want approved again (trustTodo). reconcileOutcome is
 * "action" or "blocked" exactly when this returns an item, so the exit code and the list cannot disagree.
 */
export function userActions(clients) {
  const out = [];
  for (const c of clients) {
    const items = [];
    for (const p of c.parts) {
      // The last note of a problem part is the one that says what went wrong with THIS file (applyReconcile appends it).
      if (PROBLEM.includes(p.status)) {
        const notes = p.notes ?? [];
        items.push(notes.length ? notes[notes.length - 1] : `${p.file}: ${p.status}. Run the same command again.`);
      }
      // Approvals first: until a hook Codex lists for review is approved, it may not run at all.
      items.push(...trustTodo(c.client, p), ...(p.todo ?? p.actions ?? []));
    }
    if (items.length) out.push({ client: c.client, label: LABELS[c.client] ?? c.client, items });
  }
  return out;
}

/** Lines describing a plan or an applied result, grouped per client, every remaining action listed under its client. */
export function describeReconcile(clients, { dryRun }) {
  if (clients.length === 0) return ["Client config: no tool on this computer has OpenCadre connected, so no client config was read or changed."];
  const word = {
    current: "unchanged (already current)",
    apply: "would change",
    applied: "changed",
    "applied-unverified": "changed, then changed again by another program",
    report: dryRun ? "would be left as it is (needs you)" : "left as it is (needs you)",
    blocked: dryRun ? "cannot be read" : "left as it is (blocked)",
    failed: "NOT changed (failed)",
    deferred: "not attempted (an earlier file failed); not changed",
  };
  const lines = [dryRun ? "Client config that would be brought current (OpenCadre-owned entries only; nothing else in these files changes):" : "Client config (OpenCadre-owned entries only; nothing else in these files was changed):"];
  for (const c of clients) {
    lines.push(`  ${LABELS[c.client] ?? c.client}`);
    const owed = [];
    for (const p of c.parts) {
      lines.push(`    ${p.file}: ${word[p.status] ?? p.status}${p.backup ? ` (previous version kept as ${p.backup})` : ""}`);
      for (const ch of p.changes ?? []) lines.push(`      ${ch.text}`);
      if (["apply", "applied", "applied-unverified"].includes(p.status) && p.kind === "hooks") {
        const kinds = new Set((p.changes ?? []).map((x) => x.kind));
        const trust = TRUST_MODEL[c.client];
        lines.push(`      trust: ${trust === "none" ? `${kinds.has("command") ? "command-changing" : "matcher/field-only"}; ${LABELS[c.client]} keeps no per-hook trust record, so nothing needs approving (new sessions load it)`
          : trust === "hash" ? ((p.reviewHooks ?? []).length ? `Codex hashes ${p.reviewHooks.length === 1 ? "this hook's" : "these hooks'"} settings, so it may list ${p.reviewHooks.length} for review (${kinds.has("command") ? "command-changing" : "matcher/field-only"}; review status unverified)` : "outside what Codex hashes: nothing for Codex to review")
          : `unknown for ${LABELS[c.client]}`}`);
      }
      for (const n of p.notes ?? []) lines.push(`      note: ${n}`);
      owed.push(...(p.actions ?? []), ...trustActions(c.client, p));
    }
    for (const a of owed) lines.push(`    TO DO: ${a}`);
  }
  return lines;
}
