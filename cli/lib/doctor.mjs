import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ampHome, clientConfigFile, clineDirs, codexHome, copilotHome, crushHome, vibeHome, devinHome, droidHome, gooseDirs, grokHome, hasConfigWriter, kiloHome, parseJsonc, readExistingServer, readCodexServer } from "./clients.mjs";
import { CURSOR_PROJECT_SERVER, readStoredCredential } from "./device.mjs";
import { readText } from "./files.mjs";
import { inboxSkillFile } from "./codex-app.mjs";
import { MEASURING_CLIENTS } from "./device.mjs";
import { CLAUDE_GATE_TOOLS, claudeMatcherCovers, HOOK_CLIENTS, HOOK_MARKERS, sessionHooksFile } from "./session-hooks.mjs";
import { installState } from "./generations.mjs";
import { helperSource } from "./helpers.mjs";
import { hookChangesFor, parseHookStateTables } from "./codex-hook-state.mjs";
import { codexDaemonVersionWarning } from "./codex-daemon.mjs";

/** `opencadre doctor --client <tool>`: read-only checks of one tool's OpenCadre wiring on THIS
 * machine. The output is a coarse, redacted report an agent can share as-is: agent name only, never
 * the key, agent/org IDs, session or thread IDs, or resolved local paths.
 *
 * THREE OUTCOMES PER CHECK, not two — `pass`, `fail`, `not-measured`. The third exists because
 * three of the tools the launch gate names cannot be installed on a fleet machine, and a report
 * that renders "this machine has no Cursor" as a red row will be read as a product defect by
 * whoever runs it. The gate's own rule is the same discipline from the other side: "it must never
 * be claimed as full."
 *
 * `not-measured` NEVER renders as a pass and never exits 0 on its own. The exit code itself is set
 * by the caller, not here: see the three-outcome block in cli/bin/opencadre.mjs, in the
 * `opts.command === "doctor"` branch of main(). Silence is not evidence.
 *
 * THE REPORT SAYS WHAT IT CHECKED. Every line names its own subject, because the fleet's most
 * expensive error class is a correct measurement reported as a claim about something else, and this
 * is the artifact other lanes will cite as evidence for their own gate cells. */

const FRESH_MS = 3 * 60_000;
const AMBER_MS = 60 * 60_000;
const TIMEOUT_MS = 15_000;
// Asks the hub not to count these reads as liveness, so the heartbeat age is the loop's, not doctor's.
const PROBE = "no-heartbeat";
const COLORS = { green: "\x1b[32m", amber: "\x1b[33m", red: "\x1b[31m" };

const ageText = (ms) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 2 * AMBER_MS ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / AMBER_MS)} h`);

/** The hub's current upgrade command, read from its CLI manifest (GET <hub>/cli/manifest.json, src/cli-package.ts):
 * { ok: true, stamp, command } or { ok: false, reason }.
 *
 * Q1g, ruling 049a §4: doctor used to print the BARE package URL with `connect --upgrade`, and npx caches a tarball by its
 * URL, so on any machine that had run it before, following doctor's own advice re-ran the old CLI (measured). The only URL
 * worth printing is the immutable, stamped one the hub vouches for. When the manifest cannot be read (unreachable, not
 * 2xx, not JSON, or not the shape below) there is NO safe URL to print, and the caller says the manifest could not be
 * verified rather than falling back to the bare one.
 *
 * Only the stamp is taken from the answer; the host stays the hub this doctor asked, as cliUrlFor does in
 * cli/bin/opencadre.mjs: the manifest's own `command` names the hub's PUBLIC url, which on a self-hosted or local hub can
 * be a different host whose current stamp is another build's. The stamp is cross-checked against the answer's sha256 and
 * its command, so a truncated or hand-edited answer is "not a CLI manifest", never a command. */
export async function hubUpgradeCommand(hub, { timeoutMs = TIMEOUT_MS } = {}) {
  const read = await fetchCliManifest(hub, { timeoutMs });
  return read.ok ? { ok: true, stamp: read.stamp, command: read.command } : { ok: false, reason: read.reason };
}

// The update policy and the one bounded manifest reader live in a HELPER (scripts/opencadre-update-check.mjs), because the
// installed advisory notice needs the same reader and policy and a generation carries only helpers.
export const updateCheck = await import(pathToFileURL(helperSource("opencadre-update-check.mjs")).href);

/** GET <hub>/cli/manifest.json, read and checked once for doctor and `connect --upgrade`: { ok: true, stamp, command,
 * build } or { ok: false, reason, kind }. `build` is { inputsDigest, helpers, imports } when the answer describes its
 * build well enough to verify an install against (every helper hash a sha256, an imports table), else null: a manifest
 * can carry a usable command and still be unusable as a verification target.
 *
 * HARDENED (PR-E1, plan §5.2), through readCliManifest: no credential; a redirect is REJECTED, not followed; one deadline
 * covers the headers and the body; the body is capped at 4 MiB and cancelled past it; the hub must be https unless it is
 * loopback (127.0.0.1, localhost, [::1]); the shape is validated (stamp, sha256, tarball bytes and url, command, and any
 * helpers, imports, inputsDigest or officialHistory present).
 *
 * EFFECT ON A HUB THAT REDIRECTS (an http address that redirects to https, a bare host that redirects to www, a moved
 * path): doctor reports "the hub answered with a redirect, which is not followed" and prints no upgrade command, and
 * `connect --upgrade` refuses with no writes. The fix is to use the hub's final https address (`--hub`, or connect again
 * with it). A plain-http hub that is not loopback gets the same treatment with its own reason. `connect --upgrade
 * --offline` still installs this CLI's own build without a hub check, and says it is unverified. */
export async function fetchCliManifest(hub, { timeoutMs = TIMEOUT_MS } = {}) {
  const read = await updateCheck.readCliManifest(hub, { timeoutMs });
  if (!read.ok) return { ok: false, reason: read.reason, kind: read.kind };
  return { ok: true, stamp: read.stamp, command: read.command, build: read.build };
}

async function getJson(url, key) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}`, "x-opencadre-probe": PROBE }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { res, body: await res.json().catch(() => ({})) };
}

/**
 * How this client's config is named to a human, for a line that has to describe where it looked.
 *
 * A missing label falls back to the raw client name rather than a guess: printing the wrong
 * `~/.something/config` for a tool is worse than printing its name, because a path is a claim about
 * a file that may not exist.
 *
 * KEEP THIS IN STEP WITH the same map in cli/bin/opencadre.mjs, which the merge of #445 showed is
 * easy to get wrong: that change added `opencode` to the CLI's map while this one still had only
 * `reasonix`, so the two disagreed — one printed "OpenCode", the other the raw slug. A test in
 * tests/doctor-all-clients.test.ts compares the two maps key by key, since a duplicated per-client
 * fact is the drift this table's own history warns about.
 */
const LABELS = { "claude-code": "Claude Code", codex: "Codex", dsh: "DeepSeek Harness", cursor: "Cursor", antigravity: "Antigravity", gemini: "Gemini CLI", grok: "Grok Build", opencode: "OpenCode", qwen: "Qwen Code", amp: "Amp", kilo: "Kilo Code", cline: "Cline", devin: "Devin", droid: "Factory Droid", crush: "Crush", vibe: "Mistral Vibe", goose: "Goose", copilot: "Copilot CLI", windsurf: "Windsurf", reasonix: "Reasonix" };
const label = (client) => LABELS[client] ?? client;

/**
 * Read one client's opencadre entry, or say why it could not be read.
 *
 * TWO REFUSALS BEFORE ANY READ, and both are real states rather than errors:
 *
 *   1. A client being measured is not served yet (the registry's own words), so there is nothing on
 *      this machine to inspect. That is `not-measured` with cause "not-served".
 *   2. A client with no config writer has no file `clientConfigFile` can even name — it throws a raw
 *      `TypeError` for one (see `hasConfigWriter` in clients.mjs, whose comment records Grok as the
 *      case that "throws 'Cannot read properties of undefined (reading path)' — a raw TypeError
 *      where a refusal belongs"). That is `not-measured` with cause "no-reader".
 *
 * Guarding on those two by ASKING rather than by catching means a future writer-less client is
 * reported in words instead of discovered as a crash, and the two causes stay distinguishable —
 * "not served yet" and "nothing to read" have different owners.
 */
function readClientServer({ client, home }) {
  if (MEASURING_CLIENTS.includes(client)) return { unmeasured: "not-served" };
  // Windsurf gets the approval gate only: no session server by design, so a named agent (if any) is the one server.
  if (client === "windsurf") {
    const named = readExistingServer({ home, client });
    return { server: named.found ? named : { found: false, gateOnly: true } };
  }
  // Goose's config is YAML, written by its own writer (device.mjs planGooseSessionServer) and read as text.
  if (!hasConfigWriter(client) && client !== "goose" && client !== "grok" && client !== "devin" && client !== "droid" && client !== "crush" && client !== "vibe") return { unmeasured: "no-reader" };
  // readExistingServer dispatches internally: codex reads its TOML tables, the JSON clients their
  // mcpServers entry. It calls clientConfigFile itself, which is why the guard above must come first.
  return { server: readExistingServer({ home, client }) };
}

/** The one sentence a reader needs when a client could not be measured, naming the cause. */
function unmeasuredLine(client, cause) {
  return cause === "not-served"
    ? `${label(client)} is recognized but not set up yet (still being measured), so there is nothing on this machine to check`
    : `No config writer for ${label(client)} yet, so there is no file to read on this machine`;
}

/**
 * Read one client's session-hook file and report which OpenCadre hooks are in it.
 *
 * WHY THIS EXISTS. `opencadre connect` writes this file (session-hooks.mjs, written at
 * cli/bin/opencadre.mjs:759) and for a long time NOTHING READ IT BACK. HARNESS-CODEX.md §4.3 named
 * the consequence on the one machine where it was measured: hooks were installed, then removed, and
 * the result was "a Codex chat has the MCP tools and nothing else — no awareness injection, no usage
 * reporting, no risky-command report. `opencadre doctor --client codex` checks the HTTP table and the
 * inbox skill. It does not check `hooks.json`, so it cannot see this." This is the reader that sees it.
 *
 * FOUR OUTCOMES, and the third is the one that keeps the check honest:
 *   "present"  the file parses and carries an OpenCadre awareness handler
 *   "missing"  the file is absent, unparseable, or carries no OpenCadre handler at all
 *   "partial"  it carries SOME OpenCadre handlers but not the awareness one
 *   "unsupported" this client has no hooks file, so there is nothing to check
 *
 * `partial` is deliberately distinct from `present`. The awareness hook is the one that briefs a chat;
 * gate and usage are useful but a file carrying only those leaves the chat unbriefed, which is the
 * state §4.3 describes. Reporting that as a full green is the "count >= 0" failure this project has
 * already shipped once, so it gets its own outcome and its own line.
 *
 * An EMPTY `{hooks:{}}` is `missing`, not `present`: the file existing is not the claim, the entries
 * being in it is.
 */
function readClientHooks({ client, home }) {
  // Amp has no hook file: everything OpenCadre does in it is one plugin, written by connect as a one-line module that
  // loads ~/.opencadre/bin/opencadre-amp-plugin.mjs. Present means both halves are there.
  if (client === "amp") {
    const file = join(ampHome(home), "plugins", "opencadre.js");
    const text = existsSync(file) ? readText(file) : "";
    if (!text.includes("opencadre-amp-plugin")) return { state: "missing", file, found: [] };
    // The module the wrapper actually loads, not where it is expected to be.
    let target = null;
    try {
      target = fileURLToPath(JSON.parse(/from\s+("[^"]+")/.exec(text)?.[1] ?? "null"));
    } catch { /* unreadable: partial */ }
    const loads = Boolean(target) && existsSync(target);
    const found = loads ? ["awareness", "stamp", "gate"].map((name) => ({ event: "plugin", name })) : [{ event: "plugin", name: "loader" }];
    return { state: loads ? "present" : "partial", file, found };
  }
  // Kilo has no hook file either: its plugin is a `plugin` entry in kilo.json naming ~/.opencadre/bin/opencadre-kilo-plugin.js.
  // Present means the entry is there AND the file it names exists.
  if (client === "kilo") {
    const file = join(kiloHome(home), "kilo.json");
    let config = null;
    try {
      config = JSON.parse(readText(file).replace(/^\uFEFF/, ""));
    } catch { /* missing, JSONC or broken */ }
    const url = (Array.isArray(config?.plugin) ? config.plugin : []).find((p) => typeof p === "string" && /opencadre-kilo-plugin\.js$/.test(p));
    if (!url) return { state: "missing", file, found: [] };
    let loads = false;
    try {
      loads = existsSync(fileURLToPath(url));
    } catch { /* not a file URL */ }
    const found = loads ? ["awareness", "stamp", "gate"].map((name) => ({ event: "plugin", name })) : [{ event: "plugin", name: "loader" }];
    return { state: loads ? "present" : "partial", file, found };
  }
  // Vibe: `[[hooks]]` entries in hooks.toml; the stamp, the gate and awareness are all needed.
  if (client === "vibe") {
    const file = join(vibeHome(home), "hooks.toml");
    if (!existsSync(file)) return { state: "missing", file, found: [] };
    const found = [];
    for (const line of readText(file).split(/\r?\n/)) {
      if (!/^\s*command\s*=/.test(line) || !line.includes("--client vibe")) continue;
      for (const [name, marker] of Object.entries(HOOK_MARKERS)) if (line.includes(marker)) found.push({ event: "hooks.toml", name });
    }
    const names = new Set(found.map((h) => h.name));
    return { state: ["gate", "awareness", "stamp"].every((n) => names.has(n)) ? "present" : names.size ? "partial" : "missing", file, found };
  }
  // Crush: a flat list under `hooks.PreToolUse` in its crush.json; all three of OpenCadre's are needed.
  if (client === "crush") {
    const file = join(crushHome(home), "crush.json");
    if (!existsSync(file)) return { state: "missing", file, found: [] };
    const config = parseJsonc(readText(file));
    if (!config) return { state: "missing", file, found: [], malformed: true };
    const found = [];
    for (const h of Array.isArray(config?.hooks?.PreToolUse) ? config.hooks.PreToolUse : []) {
      const command = String(h?.command ?? "").replace("opencadre-approval-gate-loader.mjs", "opencadre-approval-gate.mjs");
      for (const [name, marker] of Object.entries(HOOK_MARKERS)) if (command.includes(marker) && command.includes("--client crush")) found.push({ event: "PreToolUse", name });
    }
    const names = new Set(found.map((h) => h.name));
    return { state: ["gate", "awareness", "stamp"].every((n) => names.has(n)) ? "present" : names.size ? "partial" : "missing", file, found };
  }
  // Grok: OpenCadre's own hook file ~/.grok/hooks/opencadre.json; Devin: `hooks` in its config.json. Claude's grouped shape.
  if (client === "grok" || client === "devin" || client === "droid") {
    const file = client === "grok" ? join(grokHome(home), "hooks", "opencadre.json") : client === "droid" ? join(droidHome(home), "hooks.json") : join(devinHome(home), "config.json");
    if (!existsSync(file)) return { state: "missing", file, found: [] };
    // Devin's config.json may hold comments (its own docs show them).
    const config = client === "devin" || client === "droid" ? parseJsonc(readText(file)) : (() => {
      try {
        return JSON.parse(readText(file));
      } catch {
        return null;
      }
    })();
    if (!config) return { state: "missing", file, found: [], malformed: true };
    const found = [];
    // Droid's hooks.json is flat: the events are its top-level keys.
    for (const [event, groups] of Object.entries((client === "droid" ? config : config?.hooks) ?? {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
          // Devin's gate runs through its loader (a gate that fails to load then blocks), which counts as the gate.
          const command = String(h?.command ?? "").replace("opencadre-approval-gate-loader.mjs", "opencadre-approval-gate.mjs");
          for (const [name, marker] of Object.entries(HOOK_MARKERS)) if (command.includes(marker)) found.push({ event, name });
        }
      }
    }
    const names = new Set(found.map((h) => h.name));
    const required = client === "devin" ? ["gate", "awareness", "stamp"] : ["gate", "awareness"];
    return { state: required.every((n) => names.has(n)) ? "present" : names.size ? "partial" : "missing", file, found };
  }
  // Cline: two one-line hook files in ~/.cline/hooks, each loading ~/.opencadre/bin/opencadre-cline-hook.mjs. Present
  // means both are there and the module they load exists.
  if (client === "cline") {
    const dir = clineDirs(home).hooks;
    const file = join(dir, "PreToolUse.mjs");
    const found = [];
    let loads = true;
    for (const [event, names] of [["PreToolUse", ["stamp", "gate"]], ["PostToolUse", ["awareness"]]]) {
      const text = readText(join(dir, `${event}.mjs`));
      if (!text.includes("opencadre-cline-hook.mjs")) continue;
      try {
        loads &&= existsSync(fileURLToPath(JSON.parse(/import\s+("[^"]+")/.exec(text)?.[1] ?? "null")));
      } catch {
        loads = false;
      }
      for (const name of names) found.push({ event, name });
    }
    return { state: found.length === 3 && loads ? "present" : found.length ? "partial" : "missing", file, found };
  }
  // Antigravity: OpenCadre's two named hooks in ~/.gemini/config/hooks.json, `opencadre-inbox` (PreInvocation, Stop) and
  // `opencadre-gate` (PreToolUse). A hook switched off in Antigravity's Hooks menu (`enabled: false`) is not counted.
  if (client === "antigravity") {
    const file = join(home, ".gemini", "config", "hooks.json");
    if (!existsSync(file)) return { state: "missing", file, found: [] };
    let config;
    try {
      config = JSON.parse(readText(file));
    } catch {
      return { state: "missing", file, found: [], malformed: true };
    }
    const commands = (entry, event) => (entry?.enabled === false ? [] : (Array.isArray(entry?.[event]) ? entry[event] : [])
      .flatMap((h) => (Array.isArray(h?.hooks) ? h.hooks : [h])).map((h) => String(h?.command ?? "")));
    const found = [];
    if (commands(config?.["opencadre-inbox"], "Stop").some((c) => c.includes("opencadre-antigravity"))) found.push({ event: "Stop", name: "awareness" });
    if (commands(config?.["opencadre-gate"], "PreToolUse").some((c) => c.includes(HOOK_MARKERS.gate) && c.includes("--client antigravity"))) found.push({ event: "PreToolUse", name: "gate" });
    return { state: found.length === 2 ? "present" : found.length ? "partial" : "missing", file, found };
  }
  // Windsurf: the approval gate on pre_run_command in ~/.codeium/windsurf/hooks.json.
  if (client === "windsurf") {
    const file = join(home, ".codeium", "windsurf", "hooks.json");
    if (!existsSync(file)) return { state: "missing", file, found: [] };
    let config;
    try {
      config = JSON.parse(readText(file));
    } catch {
      return { state: "missing", file, found: [], malformed: true };
    }
    const gate = (config?.hooks?.pre_run_command ?? []).some((h) => /opencadre-approval-gate(-loader)?\.mjs/.test(String(h?.command ?? "")) && String(h.command).includes("--client windsurf"));
    return { state: gate ? "present" : "missing", file, found: gate ? [{ event: "pre_run_command", name: "gate" }] : [] };
  }
  // Copilot CLI: OpenCadre's own hook file, flat camelCase events. All three parts are needed: without the stamp a
  // session switched to in the TUI could act as another, without the gate nothing is held.
  if (client === "copilot") {
    const file = join(copilotHome(home), "hooks", "opencadre.json");
    if (!existsSync(file)) return { state: "missing", file, found: [] };
    let config;
    try {
      config = JSON.parse(readText(file));
    } catch {
      return { state: "missing", file, found: [], malformed: true };
    }
    const found = [];
    for (const [event, handlers] of Object.entries(config?.hooks ?? {})) {
      for (const h of Array.isArray(handlers) ? handlers : []) {
        for (const [name, marker] of Object.entries(HOOK_MARKERS)) if (String(h?.command ?? "").includes(marker)) found.push({ event, name });
      }
    }
    const names = new Set(found.map((h) => h.name));
    return { state: ["awareness", "gate", "stamp"].every((n) => names.has(n)) ? "present" : names.size > 0 ? "partial" : "missing", file, found };
  }
  // Goose's hooks are OpenCadre's own Goose plugin: hooks/hooks.json in Claude's grouped shape, read like the rest.
  if (client === "goose") {
    const file = join(gooseDirs(home).plugins, "opencadre", "hooks", "hooks.json");
    if (!existsSync(file)) return { state: "missing", file, found: [] };
    let config;
    try {
      config = JSON.parse(readText(file));
    } catch {
      return { state: "missing", file, found: [], malformed: true };
    }
    const found = [];
    let gateFailsClosed = false;
    for (const [event, groups] of Object.entries(config?.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
          for (const [name, marker] of Object.entries(HOOK_MARKERS)) if (String(handler?.command ?? "").includes(marker)) found.push({ event, name });
          if (String(handler?.command ?? "").includes(HOOK_MARKERS.gate) && handler.on_failure === "block") gateFailsClosed = true;
        }
      }
    }
    // Goose records every plugin it discovers in config.yaml's `plugins:` map; `enabled: false` under ours switches all
    // of it off while the files stay in place (review of d6a7ef7, S1). A project's own .agents/plugins/opencadre or
    // settings.json can do the same, which a machine-wide doctor cannot see.
    const yaml = readText(clientConfigFile(home, "goose")).replace(/\r\n/g, "\n").split("\n");
    const at = yaml.findIndex((l) => /[\\/]\.agents[\\/]plugins[\\/]opencadre["']?\s*:\s*$/.test(l));
    const disabled = at > -1 && yaml.slice(at + 1, at + 4).some((l) => /^\s+enabled\s*:\s*false\b/.test(l));
    const names = new Set(found.map((h) => h.name));
    const complete = names.has("awareness") && names.has("gate") && gateFailsClosed && !disabled;
    return { state: complete ? "present" : names.size > 0 ? "partial" : "missing", file, found, ...(disabled ? { disabled: true } : {}) };
  }
  if (!HOOK_CLIENTS.includes(client)) return { unmeasured: "unsupported" };
  const file = sessionHooksFile(home, client);
  if (!existsSync(file)) return { state: "missing", file, found: [] };
  let config;
  try {
    // parseJsonConfig is not used here: it THROWS on a malformed file, and doctor reports rather than
    // throws. A hooks file a user hand-edited into invalid JSON is a real state to name, not a crash.
    config = JSON.parse(readText(file));
  } catch {
    return { state: "missing", file, found: [], malformed: true };
  }
  const events = config?.hooks && typeof config.hooks === "object" ? config.hooks : {};
  const found = [];
  // The matcher of every PreToolUse group holding the gate, for the Claude Code coverage check below.
  const gateMatchers = [];
  // Cursor: a gate entry without `failClosed: true` lets the command run when the gate crashes, times out or cannot
  // start (board 70f528b2). Still the gate, so the install reads as present; doctor sends it to upgrade.
  let gateFailsOpen = false;
  for (const [event, groups] of Object.entries(events)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      if (event === "PreToolUse" && Array.isArray(group?.hooks) && group.hooks.some((h) => String(h?.command ?? "").includes(HOOK_MARKERS.gate))) gateMatchers.push(group.matcher);
      if (client === "cursor" && event === "beforeShellExecution" && String(group?.command ?? "").includes(HOOK_MARKERS.gate) && group.failClosed !== true) gateFailsOpen = true;
      // Claude Code and Codex group handlers (`[{ matcher, hooks: [...] }]`); Cursor lists them flat
      // (`[{ command, matcher }]`), so an entry with no `hooks` array IS the handler.
      for (const handler of Array.isArray(group?.hooks) ? group.hooks : [group]) {
        const command = String(handler?.command ?? "");
        for (const [name, marker] of Object.entries(HOOK_MARKERS)) {
          if (command.includes(marker)) found.push({ event, name });
        }
      }
    }
  }
  const names = new Set(found.map((h) => h.name));
  // Cursor: without the identity stamp every OpenCadre call is refused, so a file with awareness but no stamp is
  // not a working install (review of 7948fb9, N7).
  const required = client === "cursor" || client === "gemini" ? ["awareness", "stamp"] : ["awareness"];
  // Claude Code: a gate whose matcher misses one of its shell tools lets that tool run ungated. An install from before
  // F8 gates `Bash` only, so its PowerShell commands are never held; naming the missed tools lets doctor send it to
  // upgrade instead of reading it as healthy.
  const gateUncovered = client === "claude-code" && gateMatchers.length > 0
    ? CLAUDE_GATE_TOOLS.filter((tool) => !gateMatchers.some((m) => claudeMatcherCovers(m, tool)))
    : [];
  return { state: required.every((n) => names.has(n)) ? "present" : names.size > 0 ? "partial" : "missing", file, found, ...(gateUncovered.length ? { gateUncovered } : {}), ...(gateFailsOpen ? { gateFailsOpen } : {}) };
}

/**
 * Whether Codex has recorded trust for EVERY installed OpenCadre hook, read from `[hooks.state]`.
 *
 * REPORTS PRESENCE, NOT VALIDITY — it does NOT verify the hash, and that restraint is the point.
 * Codex records trust against the hook's CURRENT HASH (vendor doc, fetched 2026-09-20: "Codex records
 * trust against the hook's current hash, so new or changed hooks are marked for review and skipped
 * until trusted"). The key format is known but NOTHING IN THIS REPO IMPLEMENTS THE HASH, so a doctor
 * that recomputed it would be inventing a second implementation of someone else's algorithm, and its
 * failures would be indistinguishable from a real trust gap. That is the unsound instrument this row
 * keeps being caught by, so the check stays observational.
 *
 * THE KEY IS SOURCE-QUALIFIED, and getting this wrong is how the first version of this function lied.
 * The real shape on the fleet PC (measured 2026-09-20) is:
 *
 *     [hooks.state]
 *     [hooks.state."superpowers@superpowers-marketplace:hooks/hooks-codex.json:session_start:0:0"]
 *     trusted_hash = "sha256:687e7af8…"
 *
 * `<source>:<file>:<event>:<index>:<handler>` — so OpenCadre's hooks get their OWN entry and do not
 * share another plugin's. The first version anchored on the bare `[hooks.state]` header and stopped
 * at the next `[`, so it read the header's empty body and reported "not recorded" while a real entry
 * sat one table below: a blind instrument manufacturing a false claim. Ask the question the field can
 * actually answer — is there trust for a source that is OURS — rather than "is there any trust at all",
 * which a superpowers entry would satisfy and an OpenCadre install would not.
 *
 * `source` matches the hook file this repo writes (sessionHooksFile), so the check follows the file
 * the writer uses rather than a second hardcoded spelling of it.
 */
function readTrustState({ home, client }) {
  // Through the one resolver (§9 item 7): the trust state lives in the config at CODEX_HOME, so reading
  // the default path would report "no trust recorded" for an install that has recorded it.
  const text = readText(join(codexHome(home), "config.toml"));
  if (!text) return "no-config";
  // Table by table (a lookahead regex once stopped after the first table, 2026-09-20), BOTH quote styles (Codex writes
  // ours single-quoted and another plugin's double-quoted, 2026-09-21), and since #692's review every key DECODED: a
  // basic-quoted Windows key `"C:\\Users\\…"` carries escaped backslashes, and matching its raw token found no slot
  // (Olive, reproduced). One parser (cli/lib/codex-hook-state.mjs) serves this reader and the reconcile writer alike.
  const entries = parseHookStateTables(text);
  if (entries.length === 0) return "empty";
  const file = sessionHooksFile(home, client);
  // Codex keys each handler by source path, snake-case event, group index and handler index. Count
  // the actual OpenCadre handlers in this file: a single trusted SessionStart hook is insufficient
  // when the gate, stamp and wake handlers are still skipped.
  let installed;
  try { installed = JSON.parse(readText(file)); } catch { return "not-trusted"; }
  const expected = [];
  for (const [event, groups] of Object.entries(installed?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const eventKey = event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    groups.forEach((group, groupIndex) => {
      (Array.isArray(group?.hooks) ? group.hooks : []).forEach((handler, handlerIndex) => {
        if (Object.values(HOOK_MARKERS).some((marker) => String(handler?.command ?? "").includes(marker))) {
          expected.push(`${eventKey}:${groupIndex}:${handlerIndex}`);
        }
      });
    });
  }
  if (expected.length === 0) return "not-trusted";
  const source = file.replaceAll("\\", "/").toLowerCase();
  const ours = entries.filter((e) => e.key.replaceAll("\\", "/").toLowerCase().includes(`${source}:`));
  const trusted = (e) => e.trustedHash !== null;
  if (ours.length === 0) return "other-source-only";
  // A hook the user switched OFF in Codex (`enabled = false`, keyed by the same slot as trust) does not run, trusted or
  // not: an actionable fault, reported before any claim about trust.
  const off = (e) => e.enabled === false;
  if (expected.some((slot) => ours.some((e) => e.key.replaceAll("\\", "/").toLowerCase().endsWith(`${source}:${slot}`) && off(e)))) return "disabled";
  if (expected.every((slot) => ours.some((e) => e.key.replaceAll("\\", "/").toLowerCase().endsWith(`${source}:${slot}`) && trusted(e)))) return "recorded";
  return ours.some(trusted) ? "partial" : "not-trusted";
}

export function cursorProjectEntryReady(projectRoot) {
  try {
    const entry = JSON.parse(readText(join(projectRoot, ".cursor", "mcp.json")))?.mcpServers?.[CURSOR_PROJECT_SERVER];
    return entry?.type === "stdio" && entry?.command === "node"
      && Array.isArray(entry.args) && entry.args.at(-4) === "--client" && entry.args.at(-3) === "cursor"
      && entry.args.at(-2) === "--project" && entry.args.at(-1) === projectRoot;
  } catch { return false; }
}
/** The approval gate's config, layer by layer, as the gate composes it (composeGateConfig, F7 / board Q1f). Read-only.
 * `cwd` is the folder whose repository file to read (null: none); `env` supplies $OPENCADRE_GATE_CONFIG and the env
 * overrides. Returns { lines: [{ level, text }], allowFallback, repoLoosening, queued }. Paths are printed redacted. */
export async function gateConfigReport({ home, cwd = null, env = {} }) {
  const { composeGateConfig } = await import(pathToFileURL(helperSource("opencadre-config.mjs")).href);
  const read = (file) => {
    if (!file || !existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const layers = [
    ["~/.opencadre/approval-gate.json", read(join(home, ".opencadre", "approval-gate.json")), "home"],
    ["$OPENCADRE_GATE_CONFIG", env.OPENCADRE_GATE_CONFIG ? read(env.OPENCADRE_GATE_CONFIG) : null, "envFile"],
    ["<project>/.opencadre/approval-gate.json", cwd ? read(join(cwd, ".opencadre", "approval-gate.json")) : null, "repo"],
  ];
  const composed = composeGateConfig({ ...Object.fromEntries(layers.map(([, v, k]) => [k, v ?? {}])), env });
  const lines = [];
  // Only known values are echoed: a layer's raw value may hold anything, a credential included (review of #680, 3).
  const KNOWN = new Set(["off", "notify", "ask", "strict", "allow", "deny"]);
  const show = (v) => (v === undefined ? "unset" : KNOWN.has(v) ? JSON.stringify(v) : "unrecognised");
  const fallBack = "unsupported for verified person clearance: a risky command nobody approves falls back to your tool's own permission settings, never an OpenCadre approval";
  for (const [name, layer, kind] of layers) {
    if (!layer) continue;
    const allows = ["onTimeout", "onHubUnreachable"].filter((k) => layer[k] === "allow");
    const said = `Approval gate config ${name}: mode ${show(layer.mode)}, onTimeout ${show(layer.onTimeout)}, onHubUnreachable ${show(layer.onHubUnreachable)}`;
    if (kind === "repo") {
      if (composed.repoIgnored.length) {
        lines.push({ level: "red", text: `${said}. It tries to loosen the gate (${composed.repoIgnored.map(({ key }) => key).join(", ")}), which is ignored: a repository's config can tighten the gate, never loosen it. Remove those settings, or set them in ~/.opencadre/approval-gate.json if you mean them` });
      } else lines.push({ level: "green", text: `${said} (a repository's config can only tighten the gate)` });
    } else if (allows.length) {
      lines.push({ level: "amber", text: `${said}. ${allows.map((k) => `${k} "allow"`).join(" and ")} is ${fallBack}` });
    } else lines.push({ level: "green", text: said });
  }
  const { cfg } = composed;
  if (lines.length) {
    const allow = composed.allowKnobs.length > 0;
    lines.push({ level: allow ? "amber" : "green", text: `Approval gate effective here: mode ${show(cfg.mode)}, onTimeout ${show(cfg.onTimeout)}, onHubUnreachable ${show(cfg.onHubUnreachable)}${allow ? " (a fallback \"allow\" is no opinion, recorded as a policy pass, never an approval)" : ""}` });
  }
  let queued = 0;
  try {
    queued = readdirSync(join(home, ".opencadre", "run", "policy-pass")).filter((n) => /^[0-9a-f-]{36}\.json$/.test(n)).length;
  } catch { /* none */ }
  if (queued) lines.push({ level: "amber", text: `${queued} policy-pass record(s) waiting to reach the hub: each is sent by the same chat's next gated command once the hub answers, and dropped after 7 days` });
  return { lines, allowFallback: composed.allowKnobs.length > 0, repoLoosening: composed.repoIgnored.length > 0, queued };
}

export async function runDoctor({ client = "codex", home, color = false, projectRoot = null, cwd = null, env = {} }) {
  const checks = [];
  const add = (level, text) => checks.push({ level, text });
  const summary = { client, inbox_skill: "missing", mcp: "missing", key: "missing", hooks: "unknown", hub_identity: "unknown", heartbeat: "unknown", verdict: "not_connected" };

  const read = readClientServer({ client, home });

  // The unmeasured path returns EARLY and with its own shape: no capability was checked, so there is
  // nothing to report as passing. It must not fall through to the checks below, which assume a config
  // was found and would print a wall of reds for a tool that was simply never installed.
  if (read.unmeasured) {
    summary.verdict = "not_measured";
    summary.reason = read.unmeasured;
    // `inbox_skill` is a CODEX-only installation. Left at its "missing" default it would report the
    // absence of a thing this client never had, which on an unmeasured client is the exact
    // conflation the third outcome exists to avoid — so it is marked inapplicable here too.
    if (client !== "codex") summary.inbox_skill = "n/a";
    // Same reason for `hooks`: nothing was read, so the default must not render as a fault.
    summary.hooks = "not-measured";
    return {
      healthy: false,
      unmeasured: true,
      lines: [
        `[unmeasured] ${unmeasuredLine(client, read.unmeasured)}`,
        `[unmeasured] nothing was checked for ${label(client)}: no connect, identity, mail, clearance or lapsed-bill result is claimed`,
        "",
        `Not measured: ${label(client)} cannot be checked on this machine. This is NOT a failure of ${label(client)}.`,
        Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(" "),
      ],
    };
  }

  // An advisory about the installed Codex CLI, separate from the shared CLI/app OpenCadre wiring verdict.
  if (client === "codex") {
    const daemonWarning = codexDaemonVersionWarning();
    if (daemonWarning) add("amber", daemonWarning);
  }

  const server = read.server;
  if (server.found) summary.mcp = "configured";
  // A gate-only client (Windsurf) has no session server by design: no server line is printed, the computer credential is
  // still probed, and the verdict is about the gate (review of 03d4382, S5).
  if (server.gateOnly) summary.mcp = "none(gate-only)";
  if (server.key) summary.key = "present";
  // A session-server machine (the device path) is keyless BY DESIGN: its credential lives in
  // ~/.opencadre/credentials.json and the proxy reads it itself. So a missing key there is the
  // healthy state, not a fault -- reporting it red told every connected computer it was
  // disconnected (measured 2026-09-18). The stored credential is read only to probe the hub and
  // is never printed; `key` stays "session" so the line stays redacted.
  const stored = (server.found && !server.key) || server.gateOnly ? readStoredCredential({ home }) : null;
  const sessionServer = Boolean(server.found && !server.key && stored);
  if (sessionServer) summary.key = "session";
  // A session entry carries no url ON PURPOSE: the proxy resolves the hub from credentials.json
  // itself, so there is no endpoint in the client config to check. Requiring one made a healthy
  // machine print a red line (measured 2026-09-18). The named-agent entry still needs both.
  const hasEndpoint = server.url || sessionServer;
  // The config path is derived, not a codex literal: this line used to say `~/.codex/config.toml`
  // whatever client was asked for, which was invisible while only codex could be asked for and is a
  // false statement about a path the moment any other client can be.
  // Normalise both sides before the replace: `home` is the caller's string (POSIX under a test
  // harness, Windows on a real box) while clientConfigFile always joins with the platform separator,
  // so a bare `replace(home, "~")` silently misses and prints the whole local path — which this
  // report's header promises it never does. Measured 2026-09-20 running doctor with a POSIX --home.
  const configPath = client === "codex" ? "~/.codex/config.toml" : clientConfigFile(home, client).replaceAll("\\", "/").replace(home.replaceAll("\\", "/"), "~");
  if (!server.gateOnly) add(server.found && (server.key || sessionServer) && hasEndpoint ? "green" : "red",
    `${configPath} ${server.found ? "has" : "has no"} [${server.table ?? "mcp_servers.opencadre"}] (${sessionServer ? "session server; credential in credentials.json" : `key present: ${server.key ? "yes" : "no"}`}${server.found && !hasEndpoint ? ", url missing" : ""})`);

  const cursorProjectFault = client === "cursor" && Boolean(projectRoot) && !cursorProjectEntryReady(projectRoot);
  if (client === "cursor") {
    if (projectRoot) add(cursorProjectFault ? "red" : "green", cursorProjectFault
      ? "Cursor project MCP entry missing: run opencadre connect --client cursor from this project folder, then enable opencadre-project in Customize > MCPs"
      : "Cursor project MCP entry points to this folder");
    else add("amber", "Run doctor from your Cursor project folder to check its project tools.");
    add("amber", "Open the enabled project folder in Cursor, not an empty Agents window. In the chat select Add agents, context, tools > MCP > Opencadre Project. Call opencadre_get_active_agents through Cursor native MCP tools (CallMcpTool or CallDynamicTool); a shell-run proxy is not a valid test.");
  }
  // Antigravity's legacy file: agy 1.2.9 no longer reads it, so a named agent left only there does nothing (review of
  // d790104, S2).
  if (client === "antigravity" && !server.found) {
    let legacy = null;
    try {
      legacy = JSON.parse(readText(join(home, ".gemini", "antigravity", "mcp_config.json")))?.mcpServers?.opencadre;
    } catch { /* absent or unreadable */ }
    if (legacy) add("amber", "~/.gemini/antigravity/mcp_config.json has an OpenCadre entry, but Antigravity reads ~/.gemini/config/mcp_config.json and ignores that file: run the connect command again");
  }

  // The inbox skill is a CODEX-SPECIFIC installation (cli/lib/codex-app.mjs owns it), so it is only
  // checked for codex. For any other client the skill is not missing — it is not a thing that client
  // has, and printing a red "missing" line for it would be reporting the absence of a feature nobody
  // claimed. The registry's DOCTOR_CHECKS already says which clients this applies to; this guard is
  // the runtime half of that declaration.
  if (client === "codex") {
    const skill = existsSync(inboxSkillFile(home));
    if (skill) summary.inbox_skill = "installed";
    add(skill ? "green" : "red", skill ? "Inbox skill installed (~/.codex/skills/opencadre-inbox)" : "Inbox skill missing (~/.codex/skills/opencadre-inbox): run the connect command again");
  } else {
    // Named as inapplicable rather than silently absent, so the summary line's `inbox_skill=missing`
    // is not read as a fault on a client that never had one.
    summary.inbox_skill = "n/a";
  }

  // Session hooks: the half of `connect` that had no reader until now (see readClientHooks). This is
  // the check HARNESS-CODEX.md §9 item 4's verify-by names, and it is why a Codex install with the MCP
  // server but no hooks no longer reports healthy.
  const hooks = readClientHooks({ client, home });
  let gateFix = null; // the one command a gate_outdated install is sent to (set below, used again by the verdict)
  if (hooks.unmeasured === "unsupported") {
    // Not a fault and not a pass: this client has no hooks file, so the question does not apply.
    summary.hooks = "n/a";
  } else {
    // Redacted to `~/...` for the same reason the config line is: this report is meant to be shared
    // as-is, and the header promises it carries no resolved local paths. The comparison is done on
    // BOTH separator forms because `home` arrives as the caller's string (a POSIX path under a test
    // harness, a Windows one on a real box) while `file` is always built with the platform's join() —
    // so a bare `replace(home, "~")` silently failed and printed the whole temp path (measured
    // 2026-09-20). Falling back to the raw path is deliberate: a mystery path is worse than a long one.
    const hooksPath = hooks.file.replaceAll("\\", "/").replace(home.replaceAll("\\", "/"), "~");
    summary.hooks = hooks.state;
    if (hooks.state === "present") {
      // Name the EVENTS found, not just the count: which lifecycle points are wired is the actionable
      // part, and it lets a reader see at a glance whether the gate and usage hooks are there too.
      const events = [...new Set(hooks.found.map((h) => h.event))].sort();
      const others = [...new Set(hooks.found.map((h) => h.name))].filter((n) => n !== "awareness");
      add("green", `Session hooks installed (${hooksPath}): ${events.join(", ")}${others.length ? ` (${others.join(", ")})` : ""}`);
      // Installing hooks is not enough: Codex skips non-managed hooks until the user reviews them.
      // The first-run state is expected but is NOT product-ready, so doctor must not print a healthy
      // verdict while identity, mail and the approval gate are inactive. This checks for a trust
      // RECORD only; Codex owns hash validation and a changed hook can still require review.
      if (client === "codex") {
        const trust = readTrustState({ home, client });
        summary.hook_trust = trust;
        // PRESENCE, NOT VALIDITY: Codex trusts a hook only while its recorded hash equals the hook's current hash
        // (codex-rs/hooks/src/engine/discovery.rs hook_hash), and doctor does not recompute that hash. So a recorded
        // trust is AMBER ("hook_trust_unverified", exit 3), never green -- and never red "stale" either: without an
        // equivalent hash implementation measured to match, not even OpenCadre's own change PROVES a recorded trust is
        // stale (restoring an older, already-trusted config is the counterexample; review of #692 at f640bf73). What
        // doctor can state is the fact it recorded: which hooks OpenCadre changed, and when.
        // OpenCadre's own change history (cli/lib/codex-hook-state.mjs): a dated FACT about our writes, shown as an amber
        // note, never as evidence of Codex's review or of trust validity, and never changing the verdict on its own.
        const ourChanges = hookChangesFor(home, sessionHooksFile(home, client));
        if (ourChanges.length) {
          const groups = new Map();
          for (const r of ourChanges) {
            const when = `on ${r.changedAt.slice(0, 10)}${r.generation ? ` (generation ${r.generation})` : ""}`;
            groups.set(when, [...(groups.get(when) ?? []), r.name]);
          }
          add("amber", `OpenCadre changed these hooks ${[...groups].map(([when, names]) => `${when}: ${names.join(", ")}`).join("; and ")}. Review status unverified: Codex may list them as changed, so check Settings > Hooks (or /hooks in Codex CLI) and trust them if they are listed for review`);
        }
        if (trust === "recorded") add("amber", "Codex has recorded hook trust for this hooks.json in ~/.codex/config.toml: recorded, current validity unverified. doctor does not recompute Codex's hook hashes, so check once: in the Codex app open Settings > Hooks (or run /hooks in Codex CLI) and make sure no OpenCadre hook is listed as changed or needing review");
        else if (trust === "disabled") add("red", "An OpenCadre hook is turned off in Codex (hooks.state enabled = false), so it does not run: turn it back on in Codex Settings > Hooks (or /hooks in Codex CLI)");
        else if (trust === "other-source-only") add("red", "Codex has hook trust recorded for another source but not for this hooks.json: open Codex Settings > Hooks and trust the OpenCadre hooks");
        else if (trust === "partial") add("red", "Some OpenCadre hooks have trust records, but others do not: open Codex Settings > Hooks and review every OpenCadre hook");
        else add("red", "OpenCadre hook trust not recorded yet: open Codex Settings > Hooks and trust them (or use /hooks in Codex CLI); Codex skips hooks until trusted");
      }
    } else if (hooks.state === "partial") {
      // Some OpenCadre handler but not the awareness one: the chat is not being briefed. Distinct from
      // both a green and a total absence because the FIX differs — this one has a file to repair.
      const found = new Set(hooks.found.map((h) => h.name));
      const names = [...found].join(", ");
      // Say what is missing and what that costs: no awareness hook leaves chats unbriefed; no stamp (Cursor) means
      // every OpenCadre call is refused because no chat can name itself.
      const why = !found.has("awareness")
        ? "no awareness hook, so chats are not briefed"
        : "no identity stamp, so every OpenCadre call from a chat is refused";
      add("red", `Session hooks incomplete (${hooksPath}): found ${names} but ${why} — run the connect command again`);
    } else {
      add("red", `${hooks.malformed ? "Session hooks file is not valid JSON" : "Session hooks missing"} (${hooksPath}): run the connect command again`);
    }
    // F8: a gate installed before Claude Code's PowerShell tool was covered. A READINESS gap whatever the helpers' state:
    // current helpers behind an old matcher still leave that tool ungated (gateMatcherFault below keeps it unhealthy).
    // The fix named is ONE command, the hub's stamped `connect --upgrade` (PR-1's manifest command), which since PR-B
    // brings the helpers AND this matcher current. With no verifiable manifest no command is printed (never a bare URL).
    if (hooks.gateUncovered) {
      summary.gate_matcher = "outdated";
      const gateHub = (stored?.hub ?? server.url?.replace(/\/mcp\/?$/, "") ?? "https://hub.opencadre.example").replace(/\/+$/, "");
      const gateManifest = await fetchCliManifest(gateHub);
      gateFix = gateManifest.ok
        ? `run \`${gateManifest.command}\` (it brings the helpers and this matcher current), then open new chats`
        : `the hub's CLI manifest (${gateHub}/cli/manifest.json) could not be verified (${gateManifest.reason}), so no command is printed: copy the current connect command from the console, run it, then open new chats`;
      add("red", `Approval gate in ${hooksPath} does not cover Claude Code's ${hooks.gateUncovered.join(", ")} tool, so those commands run without approval: ${gateFix}`);
    }
    // Board 70f528b2: a Cursor gate entry from before `failClosed` lets a risky command run whenever the gate crashes,
    // times out or cannot start. The same one-command fix: `connect --upgrade` adds the field in place.
    if (hooks.gateFailsOpen) {
      summary.gate_fail_closed = "missing";
      const gateHub = (stored?.hub ?? server.url?.replace(/\/mcp\/?$/, "") ?? "https://hub.opencadre.example").replace(/\/+$/, "");
      const gateManifest = await fetchCliManifest(gateHub);
      gateFix = gateManifest.ok
        ? `run \`${gateManifest.command}\` (it brings the helpers and this entry current), then open new chats`
        : `the hub's CLI manifest (${gateHub}/cli/manifest.json) could not be verified (${gateManifest.reason}), so no command is printed: copy the current connect command from the console, run it, then open new chats`;
      add("red", `Approval gate in ${hooksPath} is not marked failClosed, so Cursor runs a risky command whenever the gate crashes, times out or cannot start: ${gateFix}`);
    }
  }

  // The installed helpers in ~/.opencadre/bin (the MCP proxy, the hooks, the approval gate). Measured 2026-09-23: a fix
  // merged to main did nothing on a machine whose helpers predated it, while every line above stayed green. Nothing
  // upgrades an install on its own, so doctor says so. Read-only.
  //
  // Q1g PR-2 (plan §C, ruling 049a §4): exactly ONE state (current, stale, partial, locally modified), judged against the
  // HUB's manifest when it can be read (else against the CLI running this check, and it says so), and the approval
  // gate's whole import closure is compared file by file, because a gate is only as current as the dialect and config
  // it imports. The fix named is the HUB's stamped command, never a bare URL, and none at all when the manifest cannot
  // be read. NO DIRECTION: a difference cannot say which side is newer, so the words are "don't match", never "outdated".
  const binDir = join(home, ".opencadre", "bin");
  if (existsSync(binDir)) {
    const hubRoot = (stored?.hub ?? "https://hub.opencadre.example").replace(/\/+$/, "");
    // The hub this computer is connected to is asked for its manifest up front; with no stored hub, the default hub is
    // asked only when there is something to fix (as before PR-2), so a doctor run never contacts a hub it has no reason to.
    let manifest = stored?.hub ? await fetchCliManifest(hubRoot) : null;
    const against = manifest?.ok && manifest.build ? { helpers: manifest.build.helpers, imports: manifest.build.imports } : null;
    const install = installState(binDir, { expected: against });
    if (!manifest && (install.state === "stale" || install.state === "partial" || install.gate.some((g) => !g.ok))) manifest = await fetchCliManifest(hubRoot);
    const reference = against ? `the hub's CLI (${hubRoot}/cli/manifest.json)` : "the CLI running this check";
    const unverified = manifest ? (manifest.ok ? "it does not describe its build" : manifest.reason) : "this computer has no stored hub to ask";
    const fix = !manifest
      ? "run the hub's current CLI with `connect --upgrade` (copy the command from the console), then open new chats"
      : manifest.ok
      ? `run the hub's current CLI, \`${manifest.command}\`, then open new chats`
      : `the hub's CLI manifest (${hubRoot}/cli/manifest.json) could not be verified (${manifest.reason}), so no upgrade command is printed: copy the current command from the console once the hub answers, then open new chats`;
    const list = (reasons) => reasons.slice(0, 6).join("; ") + (reasons.length > 6 ? `; and ${reasons.length - 6} more` : "");
    summary.install = install.state;
    if (install.state === "partial") {
      summary.helpers = "partial";
      add("red", `The install in ~/.opencadre/bin is partial (${list(install.reasons)}): ${fix}`);
    } else if (install.state === "stale") {
      summary.helpers = "mismatch";
      const what = install.staleNames.length
        ? `${install.staleNames.length} helper(s) in ~/.opencadre/bin don't match ${reference} (${list(install.staleNames)})`
        : `~/.opencadre/bin predates generations (its helpers are fixed files at its root), so it can change under a running hook`;
      add("red", `${what}. One side is older: ${fix}`);
    } else if (install.state === "current") {
      summary.helpers = "current";
      add("green", `Helpers in ~/.opencadre/bin match ${reference}${install.pointer ? ` (generation ${install.pointer})` : ""}`);
    } else if (install.state === "missing") {
      summary.helpers = "missing";
    }
    // Reported whatever the state: an edited helper is the user's, and hiding it behind a mismatch line would leave them
    // surprised that --upgrade skipped it.
    if (install.modifiedNames.length) {
      if (install.state === "modified") summary.helpers = "edited";
      add("amber", `Helper(s) in ~/.opencadre/bin edited on this machine, left as they are (${list(install.modifiedNames)}): \`--upgrade --force\` backs them up, then replaces them`);
    }
    if (install.gate.length && install.state !== "missing") {
      const off = install.gate.filter((g) => !g.ok);
      const shown = (h) => (h ? h.slice(0, 12) : "missing");
      if (off.length) {
        // A gate closure that disagrees is a fault even when the state above is "modified": the gate is the safety control.
        summary.gate_closure = "mismatch";
        add("red", `The approval gate's files don't match ${reference}: ${off.map((g) => `${g.name} is ${shown(g.installed)}, expected ${shown(g.expected)}`).join("; ")}. ${fix[0].toUpperCase()}${fix.slice(1)}`);
      } else {
        summary.gate_closure = against ? "verified" : "matches-cli";
        add(against ? "green" : "amber", against
          ? `The approval gate's ${install.gate.length} files match the hub's CLI manifest`
          : `The approval gate's ${install.gate.length} files match the CLI running this check, but could not be checked against the hub's manifest (${unverified})`);
      }
    }
  } else {
    summary.helpers = "missing";
  }

  // This computer's update policy (PR-E1). Reported, never acted on here: doctor's own manifest reads above are a check
  // the user asked for, so they run under every policy. A line is printed only when the policy is not the default.
  const updatePolicy = updateCheck.readUpdatePolicy({ home, env });
  summary.update_policy = updatePolicy.policy;
  if (updatePolicy.source === "unreadable") {
    add("amber", `Update policy unreadable (${updatePolicy.reasons[0]}), so this computer's background update check is treated as off: run \`opencadre update --policy notify\` (or \`--policy off\`) to rewrite it`);
  } else if (updatePolicy.source === "file" || updatePolicy.reasons.length) {
    add(updatePolicy.reasons.length ? "amber" : "green", `Update policy: ${updatePolicy.policy}${updatePolicy.reasons.length ? ` (${updatePolicy.reasons.join("; ")})` : ""}`
      + (updatePolicy.policy === "off" ? ". No background update check runs; doctor and `opencadre update --check` still check when asked. The connector build report is separate inventory and is not affected" : ""));
  }


  // The approval gate's own config (F7 / Q1f): an "allow" fallback is warned about, and a repository that tries to
  // loosen the gate is an error, though the gate already ignores it.
  const gateConfig = await gateConfigReport({ home, cwd, env });
  for (const line of gateConfig.lines) add(line.level, line.text);
  const gateConfigFault = gateConfig.repoLoosening;
  if (gateConfig.lines.length) summary.gate_config = gateConfigFault ? "repo_loosening" : gateConfig.allowFallback ? "allow_fallback" : "ok";

  // Client configs hold the MCP endpoint; the REST API lives at the hub root. A session server's
  // table carries no url (the proxy resolves the hub itself), so fall back to the stored hub.
  const hub = (server.url ?? stored?.hub)?.replace(/\/+$/, "").replace(/\/mcp$/, "");
  const probeKey = server.key ?? stored?.credential;
  let agentName = null;
  let probeHonored = false;
  if (!probeKey || !hub) {
    add("red", "Hub check skipped: no hub URL and key configured");
  } else {
    try {
      // A session machine has no agent of its own to ask about: its credential names a COMPUTER,
      // and each chat gets its identity at run time. So the probe is the device route, and a
      // healthy answer is "the hub accepts this computer", not an agent name.
      if (sessionServer || server.gateOnly) {
        const device = await getJson(`${hub}/v1/devices/me`, probeKey);
        probeHonored = device.res.headers.get("x-opencadre-probe") === PROBE;
        if (device.res.ok) {
          const name = typeof device.body.name === "string" ? device.body.name : "this computer";
          agentName = name;
          summary.hub_identity = `${name} (computer)`;
          add("green", `Hub accepts this computer's credential: ${name}`);
        } else {
          summary.hub_identity = device.res.status === 401 ? "rejected" : "error";
          add("red", device.res.status === 401 ? "Hub rejected this computer's credential (HTTP 401): add the computer again in the console" : `Hub /v1/devices/me failed (HTTP ${device.res.status})`);
        }
      } else {
        const { res, body } = await getJson(`${hub}/v1/me`, probeKey);
        probeHonored = res.headers.get("x-opencadre-probe") === PROBE;
        if (res.ok && typeof body.agentName === "string") {
          agentName = body.agentName;
          summary.hub_identity = agentName;
          add("green", `Hub accepts the key: agent ${agentName}`);
        } else {
          summary.hub_identity = res.status === 401 ? "rejected" : "error";
          add("red", res.status === 401 ? "Hub rejected the configured key (HTTP 401): generate a new connect command in the console" : `Hub /v1/me failed (HTTP ${res.status})`);
        }
      }
    } catch (err) {
      summary.hub_identity = "unreachable";
      add("red", `Hub unreachable (${err.cause?.code ?? err.name})`);
    }
  }

  // The heartbeat check asks "has THIS identity been seen recently". That question only has an
  // answer for a named agent. A session-server machine has no agent of its own -- its credential
  // names a COMPUTER and each chat is its own agent at run time -- so the check is answered from
  // the device record instead, and the verdict says which model was checked rather than implying
  // an inbox loop that may not be the one running here.
  if (server.gateOnly) {
    summary.heartbeat = "n/a";
  } else if (sessionServer) {
    summary.heartbeat = "computer";
    add("green", "Session server: every chat joins as its own agent, so there is no single inbox loop to time here");
  } else if (agentName) {
    try {
      const { res, body } = await getJson(`${hub}/v1/agents`, server.key);
      probeHonored &&= res.headers.get("x-opencadre-probe") === PROBE;
      const beat = res.ok ? body.agents?.find((a) => a.name === agentName)?.last_heartbeat_at : undefined;
      if (!res.ok) {
        add("red", `Hub /v1/agents failed (HTTP ${res.status})`);
      } else if (!probeHonored) {
        // An older hub refreshes the heartbeat on every call, including these, so its age says nothing.
        add("amber", "Last heartbeat unknown: this hub counts doctor's own check as activity (hub update needed)");
      } else if (!beat) {
        summary.heartbeat = "none";
        add("red", "No heartbeat yet: the inbox loop has never run");
      } else {
        const age = Date.now() - new Date(`${beat.replace(" ", "T")}Z`).getTime();
        summary.heartbeat = age < FRESH_MS ? "fresh(<3m)" : "stale";
        add(age < FRESH_MS ? "green" : age < AMBER_MS ? "amber" : "red", `Last heartbeat ${ageText(age)} ago`);
      }
    } catch (err) {
      add("red", `Hub unreachable (${err.cause?.code ?? err.name})`);
    }
  }

  // Is there an OpenCadre server to speak of at all? The two conditions below both hang off this: a
  // MISSING or PARTIAL hooks install is a fault about an install that EXISTS, so it is only a fault
  // once a server is configured. On a home where nothing has been connected, the honest headline is
  // "not connected" and the hooks are a detail of an install that does not exist yet -- reporting
  // them first would send a reader to repair a detail of something they have not set up.
  const serverConfigured = server.found && (server.key || sessionServer) && hasEndpoint;

  // `healthy` must be false for a MISSING or PARTIAL hooks install, or the new check would be
  // decorative: it would print a red line while the exit code stayed 0, and LAUNCH-CLIENT-GATE.md §1
  // rules that an assertion which cannot change the verdict is not evidence. "n/a" (a client with no
  // hooks file) and "not-measured" are NOT faults, so they do not suppress health.
  const hooksFault = (summary.hooks === "missing" || summary.hooks === "partial") && serverConfigured;
  // Missing, partial or disabled trust is a fault (each READ from Codex's state, never inferred). A recorded trust doctor cannot verify is neither a fault
  // nor green: `hook_trust_unverified`, the user-action-required class (exit 3), so connection and config health stay
  // distinct from hook activation and no unchanged install is told to re-trust.
  const trustFault = client === "codex" && summary.hooks === "present" && summary.hook_trust !== "recorded" && serverConfigured;
  const trustUnverified = client === "codex" && summary.hooks === "present" && summary.hook_trust === "recorded" && serverConfigured;
  // Outdated helpers are a fault for the same reason: the red line must be able to change the verdict and the exit code.
  const helpersFault = (summary.helpers === "mismatch" || summary.helpers === "partial" || summary.gate_closure === "mismatch") && serverConfigured;
  // A gate that misses one of Claude Code's shell tools (F8) is a fault too: that tool's commands run ungated. So is a
  // Cursor gate without failClosed (board 70f528b2): a crash or timeout there runs the risky command.
  const gateMatcherFault = (summary.gate_matcher === "outdated" || summary.gate_fail_closed === "missing") && serverConfigured;
  const hubOk = summary.hub_identity && !["unknown", "rejected", "unreachable", "error"].some((bad) => String(summary.hub_identity).startsWith(bad));
  const healthy = server.gateOnly
    ? summary.hooks === "present" && Boolean(hubOk) && summary.helpers !== "mismatch" && summary.helpers !== "partial" && summary.gate_closure !== "mismatch" && !gateConfigFault
    // hubOk for every client, not only the gate: a session machine's heartbeat is "computer" whatever the hub said, so
    // without it a credential the hub REJECTED read "Inbox loop healthy" at exit 0, under its own red line (measured
    // 2026-09-26 by scripts/dev/claude-live-smoke.ts, whose broken-credential arm this made pass).
    : (summary.heartbeat === "fresh(<3m)" || summary.heartbeat === "computer") && Boolean(hubOk) && !hooksFault && !gateMatcherFault && !trustFault && !trustUnverified && !helpersFault && !cursorProjectFault && !gateConfigFault;
  // Everything a green verdict needs EXCEPT verified hook trust: the only state that becomes hook_trust_unverified.
  const readyButUnverified = trustUnverified && !server.gateOnly && Boolean(hubOk) && (sessionServer || summary.heartbeat === "fresh(<3m)")
    && !hooksFault && !gateMatcherFault && !helpersFault && !cursorProjectFault && !gateConfigFault;
  let verdict;
  // A hooks fault outranks the two HEALTHY verdicts, and only those. Without this the report would
  // print "Session server connected" or "Inbox loop healthy" directly under a red hooks line -- the
  // contradiction §4.3 describes: tools working, awareness silently absent. The wording names what is
  // wrong and where, so the reader need not reconcile the two halves themselves.
  //
  if (server.gateOnly) {
    const gate = summary.hooks === "present";
    const stale = summary.helpers === "mismatch" || summary.helpers === "partial" || summary.gate_closure === "mismatch";
    summary.verdict = gate && hubOk && !stale ? (gateConfigFault ? "gate_config_loosened" : "healthy") : gate && stale ? "helpers_mismatch" : gate ? "check_hub" : stored ? "hooks_not_installed" : "not_connected";
    verdict = gate && hubOk && !stale && gateConfigFault
      ? "The approval gate is installed, but this project's .opencadre/approval-gate.json tries to loosen it (ignored; see the red line above)"
      : gate && stale
      ? "The approval gate is installed, but this computer's OpenCadre helpers don't match this CLI, so it may be running an older gate: run the hub's current CLI with `connect --upgrade`"
      : gate && hubOk
      ? `Approval gate installed: risky shell commands in ${label(client)} wait for approval in OpenCadre. ${label(client)} chats do not get OpenCadre's tools or mail this way`
      : gate ? "The approval gate is installed, but the hub did not accept this computer's credential (see above)"
      : stored ? `The approval gate is not installed, so risky commands in ${label(client)} are not held: run the connect command again`
      : `Not connected: generate a connect command in the console and run it with --client ${client}`;
  } else if (hooksFault) {
    summary.verdict = "hooks_not_installed";
    verdict = `Session hooks are not installed, so ${label(client)} chats are not briefed, usage is not reported and risky commands are not gated: run the connect command again`;
  } else if (gateMatcherFault) {
    summary.verdict = "gate_outdated";
    verdict = summary.gate_matcher === "outdated"
      ? `The approval gate does not cover every ${label(client)} shell tool (the red line above names which), so risky commands in that tool run without approval: ${gateFix}`
      : `The approval gate is installed without failClosed, so ${label(client)} runs a risky command whenever the gate crashes, times out or cannot start: ${gateFix}`;
  } else if (trustFault && summary.hook_trust === "disabled") {
    summary.verdict = "hooks_disabled";
    verdict = "An OpenCadre hook is turned off in Codex, so identity, mail or the approval gate may not run: turn it back on in Codex Settings > Hooks (or /hooks in Codex CLI)";
  } else if (trustFault) {
    summary.verdict = "hooks_untrusted";
    verdict = "Codex hooks are installed but not trusted. In the Codex app, send one ordinary message in the folder you work in (Codex lists a folder's hooks only after a chat has run there), then open Settings > Hooks, review and trust each OpenCadre hook, then start a new chat. Codex CLI users can use /hooks. The app is not ready until this step is complete";
  } else if (helpersFault) {
    summary.verdict = "helpers_mismatch";
    verdict = `This computer's OpenCadre helpers don't match the CLI running this check, so a fix on one side may not reach the other: run the hub's current CLI with \`connect --upgrade\` (the red line above names the command), then open new ${label(client)} chats`;
  } else if (gateConfigFault) {
    summary.verdict = "gate_config_loosened";
    verdict = "This project's .opencadre/approval-gate.json tries to loosen the approval gate. The gate ignores it (see the red line above); remove those settings from the repository";
  } else if (cursorProjectFault) {
    summary.verdict = "project_mcp_missing";
    verdict = "Cursor project tools are not installed for this folder: run opencadre connect --client cursor here, then enable the project server in Cursor";
  } else if (readyButUnverified) {
    // AMBER: connected and configured, hooks installed, trust recorded, but doctor cannot prove Codex's recorded hashes
    // still match. Not a fault (nothing is known wrong) and not green (activation is unproven): exit 3.
    summary.verdict = "hook_trust_unverified";
    verdict = "Connected and set up. Codex has recorded trust for OpenCadre's hooks, but doctor cannot verify it still matches the installed hooks: in the Codex app open Settings > Hooks (or run /hooks in Codex CLI) once, and trust any OpenCadre hook listed as changed or needing review";
  } else if (sessionServer && !trustFault && hubOk) {
    // A session machine is healthy when its credential works and the session server is installed:
    // identity is per chat, so there is no per-machine heartbeat to be fresh.
    summary.verdict = "healthy";
    verdict = "Session server connected: open a chat in either tool and it joins as its own agent";
  } else if (sessionServer) {
    // Everything installed, and the hub did not accept this computer (rejected, unreachable or an error): the red
    // line above says which. Never "healthy": no chat here can reach OpenCadre.
    summary.verdict = "check_hub";
    verdict = "The session server is installed, but the hub did not accept this computer's credential (see above)";
  } else if (healthy) {
    summary.verdict = "healthy";
    verdict = "Inbox loop healthy";
  } else if (agentName) {
    summary.verdict = "check_scheduled_task";
    verdict = "No recent activity: check the scheduled task is Active in ChatGPT → Scheduled and the OpenCadre chat isn't stuck in a long turn";
  } else {
    verdict = `Not connected: generate a connect command in the console and run it with --client ${client}`;
  }

  const tag = (level) => (color ? `${COLORS[level]}[${level}]\x1b[0m` : `[${level}]`);
  const lines = [
    ...checks.map((c) => `${tag(c.level)} ${c.text}`),
    "",
    verdict,
    Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(" "),
  ];
  // actionRequired: not healthy and not a fault -- the user must check something (exit 3 in the CLI).
  return { healthy, actionRequired: summary.verdict === "hook_trust_unverified", lines };
}
