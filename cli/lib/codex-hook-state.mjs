// What OpenCadre READS about Codex's per-hook state, and the one thing it RECORDS about its own hook changes.
//
// Codex runs a non-managed hook only while `[hooks.state.'<hooks.json>:<event>:<group>:<handler>'] trusted_hash` equals
// the hook's current hash (event + the group's matcher + the whole normalised handler; openai/codex
// codex-rs/hooks/src/engine/discovery.rs `hook_hash`, read at rust-v0.157.0). OpenCadre does not compute that hash, so
// it can never say whether a recorded trust is still valid -- not even after changing a hashed field itself: a hash
// recorded earlier was never verified either, and restoring an older, already-trusted configuration would make an
// "it must be stale now" claim false (review of #692 at f640bf73, Codex-049a). So there is NO stale/known-stale claim
// anywhere: doctor's best Codex verdict is the amber `hook_trust_unverified`.
//
// What IS read directly, and therefore stated: an explicit `enabled = false` (doctor's red `hooks_disabled`).
// What IS recorded: which OpenCadre hooks `connect --upgrade` changed in a way Codex hashes, and when -- no hash, no
// verdict -- so doctor can say "OpenCadre changed these hooks on <date> (review status unverified)".
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexHome } from "./clients.mjs";

export const hookChangesPath = (home) => join(home, ".opencadre", "codex-hook-changes.json");

const norm = (p) => String(p).replaceAll("\\", "/").toLowerCase();
/** Text, or "" ONLY when the file does not exist: any other read error throws, because an unreadable Codex config is an
 * UNKNOWN trust/disable state, and an unknown disable state must never authorise a rewrite (review of #692). */
const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
};

/** The value of one TOML quoted key or string token, DECODED (TOML 1.0 §Keys, §String):
 *   'literal'  -> its characters exactly, no escapes (Codex writes OUR keys this way);
 *   "basic"    -> escapes: \\ \" \b \t \n \f \r \uXXXX \UXXXXXXXX (a Windows path arrives as "C:\\Users\\…").
 * Returns null for a token that is not a well-formed quoted string, so it can never match by accident.
 * Review of #692 (Olive, reproduced): the raw basic token kept its doubled backslashes, so a `"C:\\…"` key matched no
 * slot, an explicit `enabled = false` was not seen, and the disabled hook was rewritten. */
export function decodeTomlQuoted(token) {
  if (/^'[^'\n]*'$/.test(token)) return token.slice(1, -1);
  if (!/^"(?:[^"\\\n]|\\.)*"$/.test(token)) return null;
  let bad = false;
  const out = token.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) => {
    const simple = { "\\": "\\", '"': '"', b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" }[e];
    if (simple !== undefined) return simple;
    if (/^[uU]/.test(e) && e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    bad = true;
    return "";
  });
  return bad ? null : out;
}

const QUOTED = String.raw`("(?:[^"\\\n]|\\.)*"|'[^'\n]*')`;
const STATE_HEADER = new RegExp(String.raw`^\s*\[\s*hooks\s*\.\s*state\s*\.\s*` + QUOTED + String.raw`\s*\]\s*(?:#.*)?$`);
const TABLE_START = /^\s*\[/;
const VALUE = (name) => new RegExp(String.raw`^\s*` + name + String.raw`\s*=\s*(?:` + QUOTED + String.raw`|(true|false))\s*(?:#.*)?$`);

/** Every `[hooks.state.<quoted key>]` table in a Codex config.toml, keys DECODED: [{ key, enabled, trustedHash }].
 * `enabled` is false only for an explicit `enabled = false`; `trustedHash` is the decoded string, or null. A trailing
 * `# comment` on a header or value line is allowed, as TOML allows it. */
export function parseHookStateTables(text) {
  const tables = [];
  let current = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const header = STATE_HEADER.exec(line);
    if (header) {
      const key = decodeTomlQuoted(header[1]);
      current = key === null ? null : { key, enabled: true, trustedHash: null };
      if (current) tables.push(current);
      continue;
    }
    if (TABLE_START.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const enabled = VALUE("enabled").exec(line);
    if (enabled && enabled[2] === "false") current.enabled = false;
    const hash = VALUE("trusted_hash").exec(line);
    if (hash && hash[1]) current.trustedHash = decodeTomlQuoted(hash[1]);
  }
  return tables;
}

/** Codex `[hooks.state.*]` tables for one hooks.json: slot ("post_tool_use:0:1") -> { enabled, trustedHash }. */
export function codexHookStates(home, hooksFile) {
  const source = norm(hooksFile);
  const states = new Map();
  for (const t of parseHookStateTables(read(join(codexHome(home), "config.toml")))) {
    const key = norm(t.key);
    if (key.startsWith(`${source}:`)) states.set(key.slice(source.length + 1), { enabled: t.enabled, trustedHash: t.trustedHash });
  }
  return states;
}

/** OpenCadre's OWN change history for Codex hooks, and nothing else: per SOURCE (the hooks.json path, as Codex keys its
 * state) and per slot, which hook `connect --upgrade` changed in a field Codex hashes, WHEN, and by WHICH helper
 * generation. It holds no Codex trust value and states no verdict: it is never evidence of a vendor review or of
 * whether a recorded trust is still valid (review of #692 at f640bf73). A later change to a slot replaces its entry. */
export function recordHookChanges(home, hooksFile, changed, { at = new Date(), generation = null } = {}) {
  const prior = readHookChanges(home);
  const sources = { ...(prior?.sources ?? {}) };
  const key = Object.keys(sources).find((k) => norm(k) === norm(hooksFile)) ?? hooksFile;
  const slots = { ...(sources[key] ?? {}) };
  for (const { slot, name } of changed) slots[slot] = { name, changedAt: at.toISOString(), generation };
  sources[key] = slots;
  const file = hookChangesPath(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ kind: "opencadre-hook-change-history", sources }, null, 2)}\n`);
  renameSync(tmp, file);
}

/** { kind, sources: { [hooksFile]: { [slot]: { name, changedAt, generation } } } } or null. Absent or unreadable is null:
 * this is a note for the user, never a gate on anything. */
export function readHookChanges(home) {
  try {
    const r = JSON.parse(readFileSync(hookChangesPath(home), "utf8"));
    return r && r.sources && typeof r.sources === "object" && !Array.isArray(r.sources) ? r : null;
  } catch {
    return null;
  }
}

/** OpenCadre's recorded changes to this hooks.json, newest first: [{ slot, name, changedAt, generation }]. */
export function hookChangesFor(home, hooksFile) {
  const r = readHookChanges(home);
  const key = r ? Object.keys(r.sources).find((k) => norm(k) === norm(hooksFile)) : undefined;
  if (!key) return [];
  return Object.entries(r.sources[key] ?? {})
    .map(([slot, s]) => ({ slot, name: s?.name ?? slot, changedAt: String(s?.changedAt ?? ""), generation: s?.generation ?? null }))
    .sort((a, b) => b.changedAt.localeCompare(a.changedAt));
}
