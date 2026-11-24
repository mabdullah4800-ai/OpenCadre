#!/usr/bin/env node
// opencadre connect: trades a one-time connect code from the console for this agent's key and wires
// ONE client to the hub. Zero dependencies, Node 20+. The key is written only into that client's MCP
// config and is never printed.
//
// <stamp> below is the first 12 hex of the package's sha256: the console, `doctor` and GET <hub>/cli/manifest.json print
// the whole command with the current one. The bare /cli/opencadre-cli.tgz is never printed: npx caches a tarball by its URL
// and never fetches a new build at an unchanged one (Q1g, measured), so a bare command can run an old CLI indefinitely.
//
//   npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz connect --code oc_XXXXXXXXXX
//       [--hub URL] [--client auto|claude-code|codex|cursor|antigravity|gemini] [--home DIR] [--dry-run]
//   npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz connect --code ocd_XXXXXXXXXX [--client auto|claude-code|codex]
//       Connect a computer: every supported tool it finds (Claude Code, Codex; --client narrows to one) is set
//       up with the one computer credential, and every chat in them gets its own identity, in the projects the
//       workspace enables. The credential goes only into ~/.opencadre/credentials.json; the stdio server
//       "opencadre-session" (~/.opencadre/bin/opencadre-mcp.mjs) in each tool names each chat to the hub.
//       Run from a Claude Code chat, it also enables that chat's project. On a computer that's already connected, the
//       stored credential goes along with the code and the hub updates that same computer instead of adding another.
//   npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz connect [--client auto|claude-code|codex] [--dry-run]
//       On a computer that's already connected: sets up its tools again with the credential it holds (a newly
//       installed tool, say). No console needed.
//   npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz doctor --client <tool> [--home DIR]
//   npx -y https://hub.opencadre.example/cli/<stamp>/opencadre-cli.tgz connect --upgrade [--hub URL] [--force] [--dry-run] [--offline]
//       Install this CLI's helpers into ~/.opencadre/bin as a new generation behind stable entry stubs
//       (cli/lib/generations.mjs), after checking against <hub>/cli/manifest.json that this CLI IS the hub's
//       current build (refused, with no writes, otherwise). --offline skips that check and says so. Then brings
//       the OpenCadre-owned config of every tool ALREADY connected here current (cli/lib/reconcile.mjs): hook
//       matchers and fields, the opencadre-session server entry. No code, no credential, never a new tool.
//       Exit 0: current, nothing owed. 3: done, but the user must act ("What you need to do"). 2: blocked, run it again.
//       Prints a short report (one result line, a numbered "What you need to do" list only when something is owed, and
//       whether backups were made); --verbose prints the full one, which is also saved to ~/.opencadre/last-upgrade.txt.
//       `connect` does the same with its file list (~/.opencadre/last-connect.txt).
//
// Steps: pick the client, check its config parses, redeem the code, write the MCP entry (with a
// .bak-<timestamp> of the old file), install the fleet helpers into ~/.opencadre/bin, merge session
// hooks (Claude Code, Codex), then prove the key works and set a status so the console shows Online.
// For Codex it also installs the opencadre-inbox skill and prints the scheduled-task message that makes
// the ChatGPT desktop app answer mail on its own; `doctor --client <tool>` reports one tool's launch-gate
// capabilities without changing anything, and says "not measured" (exit 2) rather than a pass when the
// tool cannot be checked on this machine.
//
// Env: OPENCADRE_HOOK_HOME overrides the home directory, like --home (tests).

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CLIENTS, claudeExecutable, detectClients, findOnPath, hasConfigWriter, planClientConfig, readExistingServer } from "../lib/clients.mjs";
import { planInboxSetup, planInboxSkill, planSessionInboxSetup, planSessionInboxSkill, copyToClipboardHint } from "../lib/codex-app.mjs";
import { fetchCliManifest, runDoctor, updateCheck } from "../lib/doctor.mjs";
import { writeWithBackup } from "../lib/files.mjs";
import { HELPERS, readInstallManifest } from "../lib/helpers.mjs";
import { applyInstall, cliBuild, driftLine, installHelpers, installState, liveConsumers, planUpgrade, redactSecrets } from "../lib/generations.mjs";
import { HOOK_CLIENTS, planCursorProjectRule, planSessionHooks, sessionHooksFile } from "../lib/session-hooks.mjs";
import { applyReconcile, describeReconcile, planReconcile, reconcileOutcome, userActions } from "../lib/reconcile.mjs";
import { planAntigravityHooks } from "../lib/antigravity-hooks.mjs";
import { planAntigravityRules } from "../lib/antigravity-rules.mjs";
import {
  credentialsPath, CONNECT_CLIENTS, DEVICE_CLIENTS, gateOnlyFor, holdsComputerEntry, MEASURING_CLIENTS, planCodexSessionServer, planCredentials, planCursorProjectServer, planCursorSessionServer, planGeminiSessionServer, planOpencodeSessionServer, opencodePluginDir, planQwenSessionServer, ampSettingsProblem, planAmpPlugin, planAmpSessionServer, planAntigravitySessionServer, planDevinHooks, planDevinSessionServer, planDroidHooks, planDroidSessionServer, planCrushConfig, crushConfigProblem, planVibeHooks, planVibeSessionServer, planGrokHooks, planGrokSessionServer, planClineHooks, planClineSessionServer, kiloConfigProblem, devinConfigProblem, planKiloConfig, planGoosePlugin, planGooseSessionServer, planCopilotHooks, planCopilotSessionServer, planWindsurfHooks, planSessionServer, readStoredCredential,
  SESSION_SERVER, sessionServerArgs, writeCredentials,
} from "../lib/device.mjs";
import { hubCall, projectHeaders, projectIdentity, resolveHub, runSessionCommand, SESSION_COMMANDS, SESSION_USAGE, syncProjectAllowlist } from "../lib/session.mjs";

const USAGE = `usage: opencadre connect --code oc_XXXXXXXXXX [--hub URL] [--client auto|${CLIENTS.join("|")}] [--project DIR] [--replace] [--dry-run] [--verbose]\n       opencadre connect --code ocd_XXXXXXXXXX [--hub URL] [--client auto|${DEVICE_CLIENTS.join("|")}] [--dry-run] [--verbose]\n       opencadre connect [--client auto|${DEVICE_CLIENTS.join("|")}] [--dry-run] [--verbose]   (re-run setup on a connected computer)\n       opencadre connect --upgrade [--hub URL] [--force] [--dry-run] [--offline] [--verbose]   (install this CLI's helpers, verified against the hub, and bring every connected tool's OpenCadre config current)\n       opencadre doctor --client <tool> [--home DIR]   (one tool: reports the launch gate's capabilities)\n       opencadre update [--status | --check [--hub URL] | --policy notify|off] [--home DIR]   (this computer's update policy, and a manual check against the hub)\n       ${SESSION_USAGE}`;
const DEFAULT_HUB = "https://hub.opencadre.example";
const LABELS = { "claude-code": "Claude Code", codex: "Codex", dsh: "DeepSeek Harness", cursor: "Cursor", antigravity: "Antigravity", gemini: "Gemini CLI", grok: "Grok Build", opencode: "OpenCode", qwen: "Qwen Code", amp: "Amp", kilo: "Kilo Code", cline: "Cline", devin: "Devin", droid: "Factory Droid", crush: "Crush", vibe: "Mistral Vibe", goose: "Goose", copilot: "Copilot CLI", windsurf: "Windsurf", reasonix: "Reasonix" };
// Overridable so tests can exercise a hub that never answers without waiting 30 s.
const TIMEOUT_MS = Number(process.env.OPENCADRE_CONNECT_TIMEOUT_MS) || 30_000;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Prints a run's report: the `short` lines by default, the `full` lines with --verbose. The full report is ALSO saved,
 * every run that writes anything, to ~/.opencadre/<name> (owner-only, replaced each run), and its path is printed,
 * so the detail a short run leaves out is one file away rather than a re-run away. Next to codex-inbox-setup.txt, which
 * connect already writes there. It holds what the run printed and nothing else: file paths, revisions and hook names,
 * never a key (no caller passes one; the key is written only into a client's config and is never printed), and never
 * the previous command or arguments of the server entry, or a config file's quoted text (reconcile omits them; they are
 * in each file's backup). A hook's old MATCHER is still shown. The saved copy is also redacted: defence in depth, not a
 * proof that arbitrary text is secret-free (review of #708, Olive's wording note).
 *
 * Saving is best-effort: a report that cannot be written changes neither the run's outcome nor its exit code, and the
 * output says so and points at --verbose. A --dry-run never gets here: it writes nothing, and prints everything.
 */
function printReport({ home, name, title, full, short, verbose }) {
  const file = join(home, ".opencadre", name);
  let where;
  try {
    mkdirSync(join(home, ".opencadre"), { recursive: true });
    // The saved copy is DURABLE, unlike the terminal, so it also goes through redactSecrets (review of #708, F2). The
    // report already omits the server entry's previous values and quoted file text; this catches a credential-shaped
    // string anywhere else (old hook matchers are still shown). Written
    // to a temp file and renamed over the report, so a report path that is a hard link is replaced, never written
    // through to whatever it links to.
    const temp = `${file}.tmp-${process.pid}`;
    try {
      writeFileSync(temp, redactSecrets(`${title}, ${new Date().toISOString()}\n\n${full.join("\n")}\n`), { mode: 0o600 });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    where = verbose ? `This report is also saved in ${file}.` : `Full report: ${file} (or add --verbose to print it here).`;
  } catch (err) {
    where = `The full report could not be saved to ${file} (${err.code ?? err.message})${verbose ? "" : "; run the same command with --verbose to see it"}.`;
  }
  console.log([...(verbose ? full : short), "", where].join("\n"));
}

/** The short form of a "Files written" list: how many, and whether (and how) the changed ones were backed up. The list
 * itself, with every backup's path, is in the full report. */
function filesLine(written) {
  const backups = written.map((f) => /\(previous version kept as ([^)]+)\)/.exec(f)?.[1]).filter(Boolean);
  const suffix = backups.length ? backups[0].slice(backups[0].lastIndexOf(".bak-")) : "";
  return `Set up ${written.length} file${written.length === 1 ? "" : "s"}${backups.length ? `; the previous version of ${backups.length === 1 ? "the changed file" : `each of the ${backups.length} changed files`} was kept next to it, ending in ${suffix}` : ""}.`;
}

/**
 * The sentence a re-run owes the user when it CHANGED a hook's command, or null when it changed none.
 *
 * WHY THIS EXISTS (HARNESS-CODEX.md §9 item 5). Codex records hook trust against the hook's current
 * hash, so a CHANGED command may be listed for review and skipped until a human trusts it — silently,
 * with only a startup warning as signal. OpenCadre does not compute that hash, so it says Codex MAY list the hook for review (review status unverified), never that it certainly skips it: a command restored to one Codex already trusted would still be trusted (review of #692). `planSessionHooks` refreshes handler paths in place, which is
 * deliberate (it is how a moved helper is repaired without reordering the file), so the two collide:
 * a re-run can turn off awareness, usage reporting and the approval gate at once.
 *
 * IT IS WARN-ONLY, AND THAT IS THE MEASURED RESULT RATHER THAN A SHORTCUT. An UNCHANGED re-run writes
 * a byte-identical file (measured 2026-09-20, and independently by lane 2), so the content the hash
 * covers does not move and nothing is invalidated. `changed` is therefore empty for the common case
 * and the warning is silent there — which is required, because a warning that fires on every connect
 * stops being read as a warning.
 *
 * THE CAUSE IS NAMED, NOT JUST THE EFFECT, AND THAT IS LOAD-BEARING. A user told only "your hooks were
 * not trusted" will re-run `connect` — which cannot fix it, because the path did not come from there.
 * The trigger is an INSTALL LOCATION change: a moved profile, OPENCADRE_HOOK_HOME, or switching
 * between a `connect` install (~/.opencadre/bin) and the repo installer (scripts/install-session-hooks.mjs,
 * which points at a checkout). `connect --upgrade` never relocates an entry (it switches the generation behind
 * the same entry paths, cli/lib/generations.mjs), but since PR-B it can change a hook's MATCHER or fields, which
 * Codex also hashes; it reports those itself, hook by hook (cli/lib/reconcile.mjs trustActions), and never
 * moves a Codex hook to a new position.
 *
 * WHAT IT DOES NOT CLAIM: that Claude Code behaves the same way. Codex's hash-gating is the documented
 * behaviour; Claude Code's hook trust is not asserted here, so the sentence names Codex when the client
 * is Codex and describes the path change otherwise.
 */
function hookRetrustWarning(client, changed) {
  if (!changed || changed.length === 0) return null;
  // One clause per distinct marker, not per handler: awareness is wired into four events and naming it
  // four times buries the one fact the user needs. The events are listed so the reader can see the
  // blast radius without opening the file.
  const byMarker = new Map();
  for (const c of changed) byMarker.set(c.marker, [...(byMarker.get(c.marker) ?? []), c.event]);
  const parts = [...byMarker.entries()].map(([marker, events]) => `${marker} (${[...new Set(events)].join(", ")})`);
  const isCodex = client === "codex";
  return [
    // Worded as a review to CHECK, not a certainty (review of #692 at f640bf73): Codex hashes the command, but OpenCadre
    // does not compute that hash, and a command restored to one Codex already trusted would still be trusted.
    `The hook commands in this file CHANGED, so ${isCodex ? "Codex may list them as changed and skip them until you review and trust them" : "your client may ask you to review them again"}: ${parts.join(", ")}.`,
    isCodex ? "In the Codex app, send one ordinary message in the folder you work in (Codex lists a folder's hooks only after a chat has run there), then open Settings > Hooks and trust any OpenCadre entry listed for review (or use /hooks in Codex CLI); while one is listed, awareness, usage reporting and the approval gate may be off." : "Check the OpenCadre hook entries in your client and allow them if it asks.",
    // The cause, because re-running connect is the obvious wrong remedy — the path did not come from
    // there. This is the difference between an actionable warning and a line the user learns to ignore.
    "This happens when the install location moves (a different home directory, OPENCADRE_HOOK_HOME, or switching between a `connect` install and the repo's install-session-hooks). Re-running connect will not undo it — the paths it writes are the new ones.",
  ].join(" ");
}

/** Record the planner's `changed` as a note on the run, if it changed anything. Shared so the three
 * write sites (device/claude-code, device/codex, named-agent) cannot drift in how they report it. */
function noteHookRetrust(client, hooks, notes) {
  const warning = hookRetrustWarning(client, hooks?.changed);
  if (warning) notes.push(warning);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        code: { type: "string" }, hub: { type: "string" }, client: { type: "string" }, home: { type: "string" }, project: { type: "string" },
        "dry-run": { type: "boolean" }, replace: { type: "boolean" }, help: { type: "boolean", short: "h" },
        upgrade: { type: "boolean" }, force: { type: "boolean" }, offline: { type: "boolean" },
        peek: { type: "boolean" }, seconds: { type: "string" }, priority: { type: "string" },
        policy: { type: "string" }, status: { type: "boolean" }, check: { type: "boolean" }, verbose: { type: "boolean" },
      },
    });
  } catch (err) {
    throw new CliError(`${err.message}\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (values.help) return null;
  const homeOverride = values.home || process.env.OPENCADRE_HOOK_HOME;
  // --verbose: `connect` and `connect --upgrade` print their full report instead of the short one (the full one is
  // always saved under ~/.opencadre too). A --dry-run already prints everything. Nothing else has a short form, so it is
  // refused there rather than ignored.
  const verbose = Boolean(values.verbose);
  if (verbose && positionals[0] !== "connect" && !values.upgrade) throw new CliError(`--verbose applies to connect and connect --upgrade only.\n${USAGE}`, 2);
  // `update`: this computer's update policy and a manual check (PR-E1). Answered before everything else; it needs no
  // client and no code.
  if (positionals[0] === "update") {
    const modes = [values.policy !== undefined, Boolean(values.status), Boolean(values.check)].filter(Boolean).length;
    if (modes > 1) throw new CliError(`update takes one of --status, --check or --policy.\n${USAGE}`, 2);
    if (values.upgrade || values.force || values.offline || values.code !== undefined) throw new CliError(`update takes only --status, --check [--hub URL] or --policy notify|off [--home DIR].\n${USAGE}`, 2);
    return {
      command: "update", mode: values.policy !== undefined ? "policy" : values.check ? "check" : "status", policy: values.policy,
      home: homeOverride || homedir(), hub: values.hub ? values.hub.replace(/\/+$/, "") : undefined,
    };
  }
  for (const flag of ["policy", "status", "check"]) {
    if (values[flag] !== undefined) throw new CliError(`--${flag} applies to update only.\n${USAGE}`, 2);
  }
  if (SESSION_COMMANDS.includes(positionals[0])) {
    return { command: "session", name: positionals[0], args: positionals.slice(1), values, home: homeOverride || undefined };
  }
  if (positionals[0] === "doctor") {
    // ANY known client, not codex only. The old check threw "doctor supports --client codex only"
    // for every other value INCLUDING names that are not clients at all, so `--client nonsense` and
    // `--client cursor` got the same misleading message. Validating against the registry gives an
    // unknown name its own honest error, and `client` is now CARRIED to runDoctor -- it used to be
    // dropped here, which meant the doctor could not see which client it had been asked about.
    const client = values.client ?? "codex";
    if (!CONNECT_CLIENTS.includes(client)) {
      // Deliberately NOT followed by the whole USAGE: that string's connect lines name the narrower
      // detection list, so printing it under a line that just listed all eight known clients reads
      // as two disagreeing sets. The one sentence a caller needs is the valid set, which is here.
      throw new CliError(`unknown client "${client}"; known clients are ${CONNECT_CLIENTS.join(", ")}`, 2);
    }
    return { command: "doctor", client, home: homeOverride || homedir(), homeOverride };
  }
  // `connect --upgrade`: refresh the installed helpers in ~/.opencadre/bin from THIS CLI's own
  // copies. Needs no code, no hub and no client config -- it only touches that one directory -- so
  // it is answered before any of the client-selection logic below, which would otherwise demand a
  // client that this command does not care about.
  if (values.upgrade) {
    return {
      command: "upgrade", home: homeOverride || homedir(), homeOverride, force: Boolean(values.force), dryRun: Boolean(values["dry-run"]), offline: Boolean(values.offline), verbose,
      hub: values.hub ? values.hub.replace(/\/+$/, "") : undefined,
    };
  }
  if (values.force) throw new CliError(`--force applies to --upgrade only.\n${USAGE}`, 2);
  if (values.offline) throw new CliError(`--offline applies to --upgrade only.\n${USAGE}`, 2);
  if (positionals[0] !== "connect") throw new CliError(USAGE, 2);
  const client = values.client ?? "auto";
  // No code at all: re-run setup on a computer that's already connected, with the credential it holds.
  if (values.code === undefined) {
    if (client !== "auto" && !DEVICE_CLIENTS.includes(client)) {
      throw new CliError(`${LABELS[client] ?? client} isn't supported on a connected computer yet (being measured); ${DEVICE_CLIENTS.map((c) => LABELS[c]).join(" and ")} are.`, 2);
    }
    if (values.project || values.replace) throw new CliError(`${values.project ? "--project" : "--replace"} needs a connect code.\n${USAGE}`, 2);
    return {
      command: "connect-machine", code: undefined, client, homeOverride, home: homeOverride || homedir(), dryRun: Boolean(values["dry-run"]), verbose,
      hub: values.hub ? values.hub.replace(/\/+$/, "") : undefined,
    };
  }
  // ocd_ is a machine (device) code; oc_ is a named agent's code.
  const machine = /^ocd_/i.test(values.code ?? "");
  if (machine ? !/^ocd_[A-Za-z0-9]{10}$/.test(values.code) : !/^oc_[A-Za-z0-9]{10}$/.test(values.code ?? "")) {
    throw new CliError(`--code must look like ${machine ? "ocd_" : "oc_"}XXXXXXXXXX; copy the command from the console again.\n${USAGE}`, 2);
  }
  // A client a computer credential serves is valid even when it is absent from CLIENTS (detection),
  // so this guard asks a device code's own list before falling through to the generic one. Without
  // the machine clause, `--client dsh` is refused here with a message built from CLIENTS -- which
  // does not contain dsh -- so the user is told dsh is unsupported by a sentence that omits it,
  // while DEVICE_CLIENTS advertises dsh as one of the three tools a computer serves.
  if (client !== "auto" && !CLIENTS.includes(client) && !(machine && DEVICE_CLIENTS.includes(client))) {
    throw new CliError(`"${client}" isn't a supported client. Use --client with one of: auto, ${CLIENTS.join(", ")}.`, 2);
  }
  if (machine) {
    if (client !== "auto" && !DEVICE_CLIENTS.includes(client)) throw new CliError(unsupportedMachineClient(client), 2);
    if (values.project) throw new CliError(`--project doesn't apply to a computer code: every chat on this computer gets its own identity, in the projects the workspace enables.\n${USAGE}`, 2);
    return {
      command: "connect-machine", code: values.code, client, homeOverride, home: homeOverride || homedir(), dryRun: Boolean(values["dry-run"]), verbose,
      hub: (values.hub || DEFAULT_HUB).replace(/\/+$/, ""),
    };
  }
  // Only Claude Code has per-folder MCP config; for the others a second agent on one machine needs its own home.
  if (values.project && client !== "claude-code") throw new CliError(`--project needs --client claude-code: other clients keep one MCP config per user\n${USAGE}`, 2);
  if (values.project && !existsSync(values.project)) throw new CliError(`--project folder not found: ${values.project}`, 2);
  return {
    command: "connect", code: values.code, client, homeOverride, project: values.project ? resolve(values.project) : undefined, home: homeOverride || homedir(), dryRun: Boolean(values["dry-run"]), replace: Boolean(values.replace), verbose,
    hub: (values.hub || DEFAULT_HUB).replace(/\/+$/, ""),
  };
}

/** Which client should take this key, when the user did not say.
 *
 * Only clients this run can actually SET UP are offered. A client can be detected and still have no
 * config writer (grok today), and offering it would be a trap: the user picks the number the CLI
 * printed, and the next thing they see is a refusal. `detected` is therefore split -- servable
 * clients become the choice, unservable ones become a note -- so the prompt never names a client it
 * will then turn down.
 */
async function chooseClient(home) {
  const detected = detectClients(home);
  const servable = detected.filter((c) => hasConfigWriter(c));
  const unservable = detected.filter((c) => !hasConfigWriter(c));
  const foundButUnusable = unservable.length > 0 ? ` ${unservable.map((c) => LABELS[c] ?? c).join(", ")} ${unservable.length === 1 ? "was" : "were"} also found but cannot be set up yet (being measured), so ${unservable.length === 1 ? "it is" : "they are"} not offered.` : "";
  if (servable.length === 1) {
    if (foundButUnusable) console.log(`Found ${LABELS[servable[0]]}.${foundButUnusable}`);
    return servable[0];
  }
  if (servable.length === 0) {
    throw new CliError(`No supported client found in ${home}.${foundButUnusable} Re-run with --client ${CLIENTS.filter((c) => hasConfigWriter(c)).join("|")}.`, 2);
  }
  // One key is one agent: writing it into two clients would make two sessions share an inbox.
  if (!process.stdin.isTTY) {
    throw new CliError(`Found several clients (${servable.join(", ")}). This key belongs to one agent, so pick one: re-run with --client ${servable.join("|")}.${foundButUnusable}`, 2);
  }
  console.log(`Found several clients. This key belongs to one agent; which one should use it?${foundButUnusable}`);
  servable.forEach((c, i) => console.log(`  ${i + 1}) ${LABELS[c]}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const n = Number((await rl.question(`Choose 1-${servable.length}: `)).trim());
      if (Number.isInteger(n) && n >= 1 && n <= servable.length) return servable[n - 1];
    }
  } finally {
    rl.close();
  }
}

/** Who an existing config's key belongs to: the agent name, null when the hub rejects the key (a stale entry),
 * or undefined when it couldn't be checked. Never refreshes that agent's liveness. */
async function existingAgentName(url, fallbackHub, key) {
  const base = (url ?? `${fallbackHub}/mcp`).replace(/\/mcp\/?$/, "");
  try {
    const res = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${key}`, "x-opencadre-probe": "no-heartbeat" }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) return null;
    if (!res.ok) return undefined;
    return (await res.json()).agentName ?? undefined;
  } catch {
    return undefined;
  }
}

/** A machine's client already running an OpenCadre agent must never be switched to another one silently: every open
 * session's hooks would start acting as the new agent at once. Without a terminal to ask (an agent running this
 * command), Claude Code connects the new agent for the current folder only; other clients stop before the code is spent. */
async function resolveTarget(opts, client) {
  if (opts.project || opts.replace) return { project: opts.project };
  const existing = readExistingServer({ home: opts.home, client });
  if (!existing.found || !existing.key) return { project: undefined };
  const current = await existingAgentName(existing.url, opts.hub, existing.key);
  if (current === null) return { project: undefined, note: "Replacing an OpenCadre entry whose key the hub no longer accepts." };
  const who = current ? `agent "${current}"` : "an OpenCadre agent";
  const perFolder = client === "claude-code";
  if (!process.stdin.isTTY) {
    if (perFolder) {
      return { project: process.cwd(), note: `${LABELS[client]} on this machine already runs ${who}, so the new agent was connected for this folder only (${process.cwd()}). To switch every session on this machine to the new agent instead, re-run with --replace.` };
    }
    throw new CliError(`${LABELS[client]} on this machine already runs ${who}, and ${LABELS[client]} holds one OpenCadre agent per user. The code wasn't used. To switch it to the new agent, re-run the same command with --replace.`, 2);
  }
  console.log(`${LABELS[client]} on this machine already runs ${who}.`);
  const choices = perFolder
    ? [["f", `connect the new agent for this folder only (${process.cwd()})`], ["r", `replace ${current ?? "it"} everywhere on this machine`], ["c", "cancel"]]
    : [["r", `replace ${current ?? "it"} with the new agent`], ["c", "cancel"]];
  choices.forEach(([k, label]) => console.log(`  ${k}) ${label}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`Choose ${choices.map(([k]) => k).join("/")}: `)).trim().toLowerCase();
      if (answer === "f" && perFolder) return { project: process.cwd() };
      if (answer === "r") return { project: undefined };
      if (answer === "c") throw new CliError("Cancelled. The code wasn't used.", 1);
    }
  } finally {
    rl.close();
  }
}

/** `field` is what a successful redeem carries: apiKey for an agent code, deviceCredential for a machine code (or, when
 * the hub merged the code into this computer, merged: true and no credential). `currentCredential`, a machine code
 * only, is the credential this computer already holds: it goes in the JSON body, never in the URL. */
async function redeem(hub, code, field = "apiKey", currentCredential = undefined) {
  let res;
  try {
    res = await fetch(`${hub}/v1/connect/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(currentCredential ? { code, currentCredential } : { code }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout can fire after the hub already spent the code, so only a failure to connect is sure it wasn't used.
    if (err.name === "TimeoutError") {
      throw new CliError(`${hub} didn't answer within ${TIMEOUT_MS / 1000} s, so the code may have been used. Run the same command again; if it says the code was already used, generate a new command in the console.`);
    }
    throw new CliError(`Could not reach ${hub} (${err.cause?.code ?? err.message}). The code wasn't used. Check your network and the --hub URL, then run the same command again.`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok && typeof body[field] === "string") return body;
  if (res.ok && field === "deviceCredential" && body.merged === true && typeof body.deviceId === "string") return body;
  const serverSays = typeof body.error === "string" ? `${body.error[0].toUpperCase()}${body.error.slice(1)}.` : "";
  const reasons = {
    404: "That connect code isn't valid. Copy the command from the console again, or generate a new one.",
    409: `${serverSays || "That agent name is already taken."} Generate a new command in the console with a different name.`,
    410: serverSays || "That connect code expired or was already used. Generate a new command in the console.",
    423: `${serverSays || "This workspace is paused by an operator."} The code wasn't used.`,
    429: "Too many connect attempts from this network. Wait a minute, then run the command again.",
  };
  if (reasons[res.status]) throw new CliError(reasons[res.status]);
  if (res.status >= 500) {
    throw new CliError(`The hub hit an error (HTTP ${res.status}). Wait a minute and run the same command again; if it says the code was already used, generate a new command in the console.`);
  }
  throw new CliError(`The hub refused the connect code (HTTP ${res.status}). Generate a new command in the console and try again.`);
}

/** Argument array and no shell, so the key never passes through shell parsing or history. Output is
 * discarded because the claude CLI may echo the header back. With a project the entry is local scope,
 * run from inside that folder, so the user-wide agent on this machine is left alone. */
function addViaClaudeCli({ command, args }, hub, key, project) {
  const scope = project ? "local" : "user";
  const at = project ? { cwd: project } : {};
  // `mcp add` refuses an existing name, so drop a previous entry in the same scope first; failure just means there was none.
  // Options are written inline at each call: tests/product-spawn-static-guard.test.ts accepts no other form.
  spawnSync(command, [...args, "mcp", "remove", "-s", scope, "opencadre"], { stdio: "ignore", timeout: 60_000, ...at, windowsHide: true });
  return spawnSync(command, [...args, "mcp", "add", "--transport", "http", "-s", scope, "opencadre", `${hub}/mcp`, "--header", `Authorization: Bearer ${key}`], { stdio: "ignore", timeout: 60_000, ...at, windowsHide: true }).status === 0;
}

async function smokeTest(hub, key, agentName) {
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const fail = (reason) => new CliError(`The config was written, but the hub didn't accept the new key (${reason}). Check the hub URL, then generate a new command in the console.`);
  let me;
  try {
    const res = await fetch(`${hub}/v1/me`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 423) {
      // The hub's own words say who can fix it; the key is fine and starts working once the workspace resumes.
      const { error } = await res.json().catch(() => ({}));
      throw new CliError(`The config was written, but ${error ? error.replace(/\.$/, "").replace(/^This/, "this") : "this workspace is paused by an operator"}. Ask an operator to resume it, then restart the client; nothing needs reconnecting.`);
    }
    if (!res.ok) throw fail(`HTTP ${res.status} from /v1/me`);
    me = await res.json();
    // Any authenticated call is a heartbeat; a status also gives the console something to show.
    const status = await fetch(`${hub}/v1/status`, {
      method: "POST", headers, body: JSON.stringify({ task: "Connected via opencadre connect" }), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!status.ok) throw fail(`HTTP ${status.status} from /v1/status`);
  } catch (err) {
    throw err instanceof CliError ? err : fail(err.cause?.code ?? err.message);
  }
  if (me.agentName !== agentName) throw fail(`it belongs to ${me.agentName}, expected ${agentName}`);
}

// --- Computer connect (ocd_ codes): computer -> tools -> project -> sessions -----------------------

const SUPPORTED_TOOLS_TEXT = DEVICE_CLIENTS.map((c) => LABELS[c]).join(" and ");

function unsupportedMachineClient(client) {
  const label = LABELS[client] ?? client;
  return `${label} isn't supported on a connected computer yet (being measured); ${SUPPORTED_TOOLS_TEXT} are. The code wasn't used. To connect ${label} now, generate an agent connect command (oc_) in the console instead.`;
}

/** The tools this run sets up (--client auto: every supported tool found here) and the ones found but not supported yet. */
function chooseMachineTools(home, client, { rerun = false } = {}) {
  const detected = detectClients(home);
  const unused = rerun ? "Nothing was changed." : "The code wasn't used.";
  // An explicitly named client must still be DETECTABLE. DEVICE_CLIENTS says which tools a computer
  // credential serves; detectClients says which this command can find. dsh is in the first and not
  // the second, so `--client dsh` used to be accepted on the strength of its name alone and the
  // run carried on as if the tool had been found -- the rest of this function, and everything
  // after it, assumes `detected` vouched for the tool. Refuse instead of pretending, and say the
  // real reason: the tool is supported, it just cannot be found, so pointing --home elsewhere
  // will not help.
  if (client !== "auto" && DEVICE_CLIENTS.includes(client) && !CLIENTS.includes(client)) {
    throw new CliError(`${LABELS[client] ?? client} can't be detected automatically yet, so connect can't tell whether it is installed here. ${unused} Add it with an agent connect command (oc_) from the console instead.`, 2);
  }
  const tools = client === "auto" ? DEVICE_CLIENTS.filter((c) => detected.includes(c)) : [client];
  const measuring = MEASURING_CLIENTS.filter((c) => detected.includes(c));
  if (tools.length > 0) return { tools, measuring };
  if (measuring.length > 0) throw new CliError(unsupportedMachineClient(measuring[0]).replace("The code wasn't used.", unused), 2);
  throw new CliError(`No supported tool found in ${home}. ${unused} Re-run with --client ${DEVICE_CLIENTS.join(" or --client ")}.`, 2);
}

const NOT_CONNECTED = "This computer isn't connected. Add it in the console.";

/** Whether `connect` must leave a pre-generation install's helpers alone: { consumers, caveats } when installing would
 * CONVERT it (cli/lib/generations.mjs) while live consumers are detected, else null.
 *
 * Ruling 049a §2b-3 / §5: converting a shared live install needs a coordinated quiescent window, and `connect` is what
 * operators re-run on every machine. So connect does not convert under live consumers: it leaves every file in bin
 * byte-identical, finishes the rest of setup (credential, client configs, hooks: they name the same entry paths, which
 * still hold the legacy files), and says loudly what was not done and how to do it once the consumers are closed. */
function conversionHold(home, binDir) {
  let plan;
  try {
    plan = planUpgrade(binDir, { force: true });
  } catch {
    return null;
  }
  if (!plan.converting) return null;
  const found = liveConsumers({ home, bin: binDir });
  return found.consumers.length ? found : null;
}

/** The warning for a held conversion, as lines. `cli` is the stamped `npx -y <url>` this connect would print anyway. */
function conversionHeldWarning(held, binDir, cli) {
  return [
    `WARNING: OpenCadre's helpers in ${binDir} were NOT updated. This install predates generations, and converting it needs no OpenCadre process running from it, but these are live:`,
    ...held.consumers.map((c) => `  ${c.kind} pid ${c.pid}: ${c.detail}`),
    ...(held.ignored ?? []).map((c) => `  ${c.kind}, pid ${c.pid}: ${c.detail}`),
    ...held.caveats.map((c) => `  (${c})`),
    "  Every file there was left exactly as it was, so those processes and new chats keep running the old helpers. Everything else in this setup was done.",
    `  Close those tools and let the watchers exit, then run: ${cli} connect --upgrade`,
    "  Add --force to that command only if you accept converting while they are still running.",
  ];
}

/** `connect --upgrade`: install THIS CLI's helpers into ~/.opencadre/bin as a new generation, verified against the hub.
 *
 * The problem it answers, measured on this PC 2026-09-18: that directory holds the files that actually RUN -- hooks and
 * the approval gate are invoked from it by absolute path -- so a machine could run a security control hundreds of lines
 * behind the repo indefinitely, with no signal.
 *
 * Q1g PR-2 (plan §2.B-C, ruling 049a §2-4):
 *   - Before ANY write it reads <hub>/cli/manifest.json and refuses (exit 2) unless this CLI is the hub's current build,
 *     printing the hub's stamped command. An offline, malformed or mismatched manifest is a refusal with no writes and no
 *     bare URL. `--offline` installs this CLI's own build without that check, and says it is unverified.
 *   - The helpers go into a new immutable generation, switched to by one pointer rename (cli/lib/generations.mjs); the
 *     staged tree must equal the hub manifest's hashes. Nothing a client runs is rewritten in place.
 *   - A file of unknown provenance or edited on this machine is refused and listed; `--force` backs it up durably to
 *     bin/.backup/<ts>/ first. Converting a pre-generation install refuses while live consumers are detected, unless
 *     --force. */
async function runUpgrade({ home, force, dryRun, offline, hub, verbose }) {
  const binDir = join(home, ".opencadre", "bin");
  const build = cliBuild();
  const buildName = build.kind === "build" ? `build ${build.inputsDigest.slice(0, 12)}` : "a CLI run from a checkout (no build.json)";
  let verifyHelpers = null;
  let verified;
  let verifiedShort; // the same fact in one sentence, for the short report
  if (offline) {
    verified = `Not verified against a hub (--offline): this is ${buildName}, installed exactly as this CLI carries it.`;
    verifiedShort = "Not verified against a hub (--offline).";
  } else {
    const storedHub = (() => {
      try {
        return readStoredCredential({ home })?.hub;
      } catch {
        return undefined; // an unreadable credentials file names no hub; the default is asked instead
      }
    })();
    const hubRoot = (hub ?? storedHub ?? DEFAULT_HUB).replace(/\/+$/, "");
    const manifest = await fetchCliManifest(hubRoot);
    if (!manifest.ok || !manifest.build) {
      throw new CliError(`Could not verify this CLI against ${hubRoot}/cli/manifest.json (${manifest.ok ? "it does not describe its build" : manifest.reason}), so nothing was changed. Copy the current command from the console once the hub answers. (--offline installs this CLI's own copies without that check.)`, 2);
    }
    if (build.inputsDigest !== manifest.build.inputsDigest) {
      throw new CliError(`This CLI is ${buildName}, not the hub's current CLI (build ${manifest.build.inputsDigest.slice(0, 12)}), so nothing was changed. Run the hub's current CLI:\n  ${manifest.command}`, 2);
    }
    verifyHelpers = manifest.build.helpers;
    verified = `Verified against ${hubRoot}: this CLI is the hub's current build (${build.inputsDigest.slice(0, 12)}).`;
    verifiedShort = `Verified against ${hubRoot}.`;
  }
  const before = readInstallManifest(binDir);
  const plan = planUpgrade(binDir, { force });
  const consumers = plan.converting ? liveConsumers({ home, bin: binDir }) : null;
  const refusedLines = plan.slots.filter((x) => x.action === "refuse").map((x) => `  ${x.name} (${x.cls === "edited" ? "edited on this machine since it was installed" : "not a file OpenCadre installed, or of a revision it does not know"})`);
  const libraryLines = plan.libraries.map((l) => `  ${l.name}${l.cls === "unknown" || l.cls === "edited" ? " (not an OpenCadre revision: kept, and nothing new uses it)" : ""}`);
  const consumerLines = consumers ? consumers.consumers.map((c) => `  ${c.kind} pid ${c.pid}: ${c.detail}`) : [];
  // Records naming a pid that is no longer their helper (reused or dead): shown so an operator sees why, never counted.
  const ignoredLines = consumers ? consumers.ignored.map((c) => `  ${c.kind}, pid ${c.pid}: ${c.detail}`) : [];
  if (dryRun) {
    console.log([
      `Dry run: nothing was written.\nWould install generation ${plan.id} into ${binDir}:`,
      `  ${plan.changed.length === 0 ? "already current" : `${plan.changed.length} helper(s) would change: ${plan.changed.join(", ")}`}`,
      ...(plan.written.length ? [`  entry stubs would be written: ${plan.written.join(", ")}`] : []),
      ...(refusedLines.length ? [`  ${refusedLines.length} left alone (${force ? "--force would back them up, then replace them" : "refused"}):`, ...refusedLines.map((l) => `  ${l}`)] : []),
      ...(plan.blockers.length ? [`  REFUSED as a whole: ${plan.blockers.map((b) => `${b.refused} imports ${b.imports}`).join("; ")}`] : []),
      ...(plan.removed.length > 0 ? [`  ${plan.removed.length} stale backup(s) would be removed: ${plan.removed.join(", ")}`] : []),
      ...(consumerLines.length ? ["  converting this install needs these stopped first (or --force):", ...consumerLines.map((l) => `  ${l}`)] : []),
      ...(ignoredLines.length ? ["  not counted as live:", ...ignoredLines.map((l) => `  ${l}`)] : []),
      `  ${verified}`,
      "",
      ...describeReconcile(planReconcile({ home }).clients, { dryRun: true }),
      "",
      "Re-run without --dry-run to apply.",
    ].join("\n"));
    return;
  }
  if (consumers && consumers.consumers.length && !force) {
    throw new CliError([
      `This install predates generations, and converting it needs no OpenCadre process running from ${binDir}. These are live, so nothing was changed:`,
      ...consumerLines,
      ...(ignoredLines.length ? ["Not counted as live:", ...ignoredLines] : []),
      ...consumers.caveats.map((c) => `Note: ${c}`),
      "Stop them (close the tools using them, and let watchers exit), then run the same command again, or add --force to convert anyway.",
      "Client config was not read or changed either: the same command brings it current once it runs.",
    ].join("\n"), 2);
  }
  const result = applyInstall(binDir, plan, { verifyHelpers });
  // The helpers are switched; now every connected client's OpenCadre-owned config (cli/lib/reconcile.mjs). A failure
  // here leaves the helpers switched, and the output says exactly that rather than "nothing was changed".
  let configLines;
  let outcome;
  let reconciledClients = [];
  let configProblem = null; // a failure before any client config file was written, in the short report's words
  try {
    const reconciled = applyReconcile({ home });
    reconciledClients = reconciled.clients;
    configLines = [...(reconciled.failure ? [`Client config: ${reconciled.failure}; no client config file was changed.`] : []), ...describeReconcile(reconciled.clients, { dryRun: false })];
    outcome = reconcileOutcome(reconciled.clients, reconciled.failure);
    if (reconciled.failure) configProblem = `not brought current (${reconciled.failure}); no client config file was changed. Run the same command again.`;
  } catch (err) {
    // applyReconcile returns every per-file failure as a receipt (changed / failed / deferred, with backups). Only a failure
    // to take the installer lock reaches here, before any client config file is opened for writing, so this is true.
    configLines = [`Client config: not brought current (${err.message.replace(/\.$/, "")}). The helpers above were switched; no client config file was changed. Run the same command again.`];
    configProblem = `not brought current (${err.message.replace(/\.$/, "")}). The helpers were updated; no client config file was changed. Run the same command again.`;
    outcome = "blocked";
  }
  const already = plan.changed.length === 0 && plan.written.length === 0 && plan.refused.length === 0 && plan.pointer.id === plan.id;
  // The FULL report: every file, revision, matcher diff and trust note. Saved to ~/.opencadre/last-upgrade.txt on every
  // run and printed with --verbose; the short report below is what prints by default.
  const detail = [
    already ? `Already current: ${binDir}` : `Upgraded ${binDir}`,
    verified,
    ...(plan.changed.length > 0 ? ["", `Refreshed (generation ${plan.id}):`, ...plan.changed.map((f) => `  ${f}`)] : []),
    ...(plan.written.length > 0 ? ["", "Entry stubs written (each loads the active generation):", ...plan.written.map((f) => `  ${f}`)] : []),
    ...(refusedLines.length > 0 ? ["", "Left alone (so not replaced):", ...refusedLines, "  Re-run with --force to back them up and replace them."] : []),
    ...(result.backups.length > 0 ? ["", "Backed up, then replaced (--force):", ...result.backups.map((f) => `  ${f}`)] : []),
    ...(libraryLines.length > 0 && plan.converting ? ["", "Left in place at the install root (older copies, used only by OpenCadre processes started before this upgrade):", ...libraryLines] : []),
    ...(plan.removed.length > 0 ? ["", "Removed stale backups:", ...plan.removed.map((f) => `  ${f}`)] : []),
    ...(consumers && consumers.consumers.length ? ["", "Converted while these were live (--force): restart them so they load the new generation:", ...consumerLines] : []),
    // The asymmetry with `connect` is deliberate: connect is setup and never refuses (it backs up, then replaces).
    "Note: `opencadre connect` backs up and replaces a changed helper without asking, because it is setting up the install. Only `--upgrade` refuses first.",
    "",
    `Installed revision: ${result.stamp}, generation ${result.id}${before ? ` (was ${before.stamp})` : " (no previous record: this install had no stamp)"}`,
    "",
    ...configLines,
  ];

  // The SHORT report: one result line, then only what the user must do, in plain words, then where the backups and the
  // full report are. Nothing safety-relevant is left to the full report: a refused helper, a live process still on the old
  // helpers, a config file that could not be read or written, every hook a tool may want approved again, and the fact
  // that backups were made all show here (userActions, cli/lib/reconcile.mjs).
  const parts = reconciledClients.flatMap((c) => c.parts);
  const configChanged = parts.filter((p) => p.status === "applied" || p.status === "applied-unverified").length;
  const files = (n) => `${n} client config file${n === 1 ? "" : "s"}`;
  const head = already
    ? configChanged ? `Helpers already current (revision ${result.stamp}, generation ${result.id}); brought OpenCadre's entries in ${files(configChanged)} current.` : `Already current: revision ${result.stamp} (generation ${result.id}).`
    : `Updated to revision ${result.stamp} (generation ${result.id}${before ? `, was ${before.stamp}` : ""})${configChanged ? ` and brought OpenCadre's entries in ${files(configChanged)} current` : ""}.`;
  const groups = [];
  const refusedNames = plan.slots.filter((x) => x.action === "refuse").map((x) => x.name);
  const helperItems = [
    ...(refusedNames.length ? [`${refusedNames.length === 1 ? "One helper file was" : `${refusedNames.length} helper files were`} left alone, because ${refusedNames.length === 1 ? "it was" : "they were"} edited on this machine or OpenCadre did not install ${refusedNames.length === 1 ? "it" : "them"}: ${refusedNames.join(", ")} (in ${binDir}). To back ${refusedNames.length === 1 ? "it" : "them"} up and replace ${refusedNames.length === 1 ? "it" : "them"}, run the same command with --force.`] : []),
    ...(consumers && consumers.consumers.length ? [`Restart these, which were running while the install was converted (--force), so they load the new helpers: ${consumers.consumers.map((c) => `${c.kind} pid ${c.pid}`).join(", ")}.`] : []),
  ];
  if (helperItems.length) groups.push({ label: "OpenCadre helpers", items: helperItems });
  // A refused helper or a process to restart is owed by the user just as a config action is: exit 3, never 0 under a
  // "What you need to do" list (the exit code and the list must not disagree).
  if (helperItems.length && outcome === "green") outcome = "action";
  if (configProblem) groups.push({ label: "Client config", items: [configProblem] });
  groups.push(...userActions(reconciledClients));
  let n = 0;
  const todo = groups.flatMap((g) => g.items.map((item) => `  ${++n}. ${g.label}: ${item}`));
  const tail = outcome === "blocked" ? " Not finished: see below, then run the same command again." : todo.length ? "" : " Nothing for you to do.";
  const configBackups = parts.map((p) => p.backup).filter(Boolean);
  const backupLine = [
    ...(configBackups.length ? [`the previous version of ${configBackups.length === 1 ? "the changed file" : `each of the ${configBackups.length} changed files`} was kept next to it, ending in ${configBackups[0].slice(configBackups[0].lastIndexOf(".bak-"))}`] : []),
    ...(result.backups.length ? [`${result.backups.length === 1 ? "the replaced helper was" : `the ${result.backups.length} replaced helpers were`} copied to ${join(binDir, ".backup")} first`] : []),
  ].join("; ");
  const summary = [
    `${head} ${verifiedShort}${tail}`,
    ...(todo.length ? ["", "What you need to do:", ...todo] : []),
    ...(backupLine ? ["", `Backups: ${backupLine}.`] : []),
  ];
  printReport({ home, name: "last-upgrade.txt", title: "opencadre connect --upgrade", full: [...detail, "", ...summary], short: summary, verbose });
  // 0: done, nothing owed. 3: done, but the user must act (every item). 2: blocked, retry (nothing is pretended).
  if (outcome !== "green") process.exitCode = outcome === "blocked" ? 2 : 3;
}

/** `opencadre update`: this computer's update policy, and a manual check (PR-E1, plan §4 and §6).
 *   --status            the effective policy and why it is narrowed (the default mode)
 *   --policy notify|off  sets it; `auto` is refused, with no write: it is not available in this release
 *   --check [--hub URL]  reads the hub's manifest and compares this computer's helpers with it, under EVERY policy,
 *                        because the user asked. It changes nothing and installs nothing.
 * Exit 0: done. 2: refused or could not check (nothing was changed). */
async function runUpdate({ mode, policy, home, hub }) {
  // The policy helper, loaded once by doctor.mjs (a helper library, so it lives in the generation too).
  const check = updateCheck;
  const BUILD_REPORT = "The connector build report (inventory the console shows per computer) is separate from the update check and is not affected by this policy.";
  if (mode === "policy") {
    if (policy === "auto") throw new CliError(check.AUTO_UNAVAILABLE, 2);
    if (!check.SETTABLE_POLICIES.includes(policy)) throw new CliError(`Unknown update policy "${policy}": use --policy notify or --policy off. Nothing was changed.`, 2);
    check.writeUpdatePolicy({ home, policy });
    const now = check.readUpdatePolicy({ home, env: process.env });
    console.log([
      `Update policy set to ${policy} for this computer (${check.updatePolicyPath(home)}).`,
      policy === "off"
        ? "OpenCadre's hooks will not check the hub for updates. doctor and `opencadre update --check` still check when you run them."
        : "OpenCadre's hooks check the hub at most once every six hours and tell a chat when an update is available. Nothing is installed automatically.",
      BUILD_REPORT,
      ...(now.policy !== policy ? [`Effective policy here: ${now.policy} (${now.reasons.join("; ")}).`] : []),
    ].join("\n"));
    return;
  }
  const current = check.readUpdatePolicy({ home, env: process.env });
  const statusLines = [
    `Update policy: ${current.policy}${current.source === "default" ? " (the default: no policy has been set on this computer)" : ""}.`,
    ...current.reasons.map((r) => `  Narrowed: ${r}.`),
    ...(current.source === "unreadable" ? ["  Fix: run `opencadre update --policy notify` (or `--policy off`) to rewrite the policy file."] : []),
    current.policy === "off"
      ? "  No background update check runs. doctor and `opencadre update --check` still check when you run them."
      : "  Hooks check the hub at most once every six hours and only notify. Automatic updates are not available in this release.",
    `  ${BUILD_REPORT}`,
  ];
  if (mode === "status") {
    console.log(statusLines.join("\n"));
    return;
  }
  // --check: user-requested, so it runs under every policy.
  const storedHub = (() => {
    try {
      return readStoredCredential({ home })?.hub;
    } catch {
      return undefined;
    }
  })();
  const hubRoot = (hub ?? storedHub ?? DEFAULT_HUB).replace(/\/+$/, "");
  const manifest = await fetchCliManifest(hubRoot);
  if (!manifest.ok) {
    throw new CliError(`Could not check ${hubRoot}/cli/manifest.json (${manifest.reason}). Nothing was changed, and no upgrade command is printed.`, 2);
  }
  const binDir = join(home, ".opencadre", "bin");
  const install = manifest.build ? installState(binDir, { expected: { helpers: manifest.build.helpers, imports: manifest.build.imports } }) : null;
  const lines = [`Hub ${hubRoot}: CLI package ${manifest.stamp}${manifest.build ? `, build ${manifest.build.inputsDigest.slice(0, 12)}` : ""}.`];
  if (!install) lines.push("The hub's manifest does not describe its helpers, so this computer's install cannot be compared with it.", `Upgrade command: ${manifest.command}`);
  else if (install.state === "missing") lines.push(`No OpenCadre helpers are installed in ${binDir}.`);
  else if (install.state === "current") lines.push(`This computer's helpers match the hub's current CLI${install.pointer ? ` (generation ${install.pointer})` : ""}. Nothing to do.`);
  else {
    lines.push(
      `This computer's helpers do not match the hub's current CLI (install state: ${install.state}). This is not a compatibility verdict: a difference cannot say which side is newer.`,
      `Upgrade command (run it yourself, after saving work and closing affected tools): ${manifest.command}`,
    );
  }
  console.log([...lines, "", ...statusLines].join("\n"));
}

/** GET /v1/devices/me for `connect` with no code: the stored credential still works, and whose computer it is. Runs before
 * anything is written. A hub without the route (an older one) is checked the way a connect checks a new credential. */
async function describeStoredComputer(hub, stored) {
  const unreachable = (err) => new CliError(`Could not reach ${hub} (${err.cause?.code ?? err.message}). Nothing was changed. Check your network, then run the same command again.`);
  const refused = (status) => {
    if (status === 401) return new CliError(NOT_CONNECTED);
    if (status === 423) return new CliError("This workspace is paused by an operator. Nothing was changed. Ask an operator to resume it, then run the same command again.");
    return new CliError(`The hub couldn't check this computer's credential (HTTP ${status}). Nothing was changed. Run the same command again in a minute.`);
  };
  const auth = { authorization: `Bearer ${stored.credential}` };
  let res;
  try {
    res = await fetch(`${hub}/v1/devices/me`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw unreachable(err);
  }
  if (res.ok) {
    const me = await res.json().catch(() => ({}));
    // cliUrl: the hub's stamped package URL (Q1g). A re-run with no code has no redeem answer to take it from, and
    // without it every command printed below was the bare URL npx had cached. An older hub omits it; cliUrlFor copes.
    return { deviceId: typeof me.deviceId === "string" ? me.deviceId : stored.deviceId, name: typeof me.name === "string" ? me.name : null, client: typeof me.client === "string" ? me.client : "auto", cliUrl: typeof me.cliUrl === "string" ? me.cliUrl : null };
  }
  if (res.status !== 404) throw refused(res.status);
  try {
    res = await fetch(`${hub}/v1/sessions/leave`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-opencadre-session": `opencadre-connect-check-${randomUUID()}` },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw unreachable(err);
  }
  if (!res.ok) throw refused(res.status);
  return { deviceId: stored.deviceId, name: null, client: "auto" };
}

/** What each tool does after this run, one aligned line per tool, set up or not. */
function toolLines(tools, measuring, { codexSkill }) {
  const pad = (label) => label.padEnd(Math.max(...[...tools, ...measuring].map((t) => LABELS[t].length)) + 2);
  const does = {
    "claude-code": "set up: every chat joins as its own session (opencadre-session server, session hooks, mail at turn end)",
    codex: `installed, pending hook trust: every chat joins as its own session after you trust OpenCadre in Codex Settings > Hooks (opencadre-session server, session hooks, idle wake${codexSkill ? ", opencadre-inbox skill" : ""})`,
    opencode: "set up: every chat joins as its own session (opencadre-session local server; the chat id arrives with each tool call)",
    cursor: "set up: every chat joins as its own session (opencadre-session server, identity stamp, clearance gate, mail at turn end)",
    gemini: "set up: every chat joins as its own session (opencadre-session server, identity stamp, clearance gate, mail at turn end)",
    qwen: "set up: every session joins as its own agent (opencadre-session server, session hooks, clearance gate, mail at turn end)",
    amp: "set up: every thread joins as its own agent (opencadre-session server, OpenCadre plugin: identity stamp, clearance gate, mail, idle wake)",
    antigravity: "set up: every conversation joins as its own agent (opencadre-session server, hooks: clearance gate, identity, mail at turn end)",
    devin: "set up: every session joins as its own agent (opencadre-session server, hooks: identity stamp, clearance gate, mail at turn end)",
    droid: "set up: every session joins as its own agent (opencadre-session server, hooks: clearance gate, mail at turn end)",
    crush: "set up: every session joins as its own agent (opencadre-session server, hooks: identity stamp, clearance gate, mail with tool results)",
    vibe: "set up: every session joins as its own agent (opencadre-session server, hooks: identity stamp, clearance gate, mail at turn end)",
    grok: "set up: every session joins as its own agent (opencadre-session server, hooks: clearance gate, mail at turn end)",
    cline: "set up: every session joins as its own agent (opencadre-session server, hooks: identity stamp, clearance gate, mail while it works)",
    kilo: "set up: every session joins as its own agent (opencadre-session server, OpenCadre plugin: identity stamp, clearance gate, mail, idle wake)",
    windsurf: "set up: risky shell commands in Cascade conversations are held for approval (clearance only: Windsurf's hooks cannot name a chat to OpenCadre's tools)",
    copilot: "set up: every session joins as its own agent (opencadre-session server, hooks: identity stamp, clearance gate, mail at turn end)",
    goose: "set up: every session joins as its own agent (opencadre-session extension, OpenCadre plugin: clearance gate, mail at turn end)",
  };
  return [
    ...tools.map((t) => `  ${pad(LABELS[t])}${does[t]}`),
    ...measuring.map((t) => `  ${pad(LABELS[t])}found, not yet supported (being measured)`),
  ];
}

/** Argument array and no shell. The command line holds a file path only; the credential stays in credentials.json. */
function addSessionServerViaClaudeCli({ command, args }, proxyPath, client) {
  spawnSync(command, [...args, "mcp", "remove", "-s", "user", SESSION_SERVER], { stdio: "ignore", timeout: 60_000, windowsHide: true });
  return spawnSync(command, [...args, "mcp", "add", "-s", "user", SESSION_SERVER, "--", "node", ...sessionServerArgs(proxyPath, client)], { stdio: "ignore", timeout: 60_000, windowsHide: true }).status === 0;
}

/** Proves the credential works without creating a session: leaving a seat nobody holds ends nothing. */
async function checkDeviceCredential(hub, credential) {
  const fail = (reason) => new CliError(`The computer was set up, but the hub didn't accept its credential (${reason}). Check the hub URL, then add the computer again in the console.`);
  let res;
  try {
    res = await fetch(`${hub}/v1/sessions/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "x-opencadre-session": `opencadre-connect-check-${randomUUID()}` },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw fail(err.cause?.code ?? err.message);
  }
  if (res.status === 423) {
    throw new CliError("The computer was set up, but this workspace is paused by an operator. Ask an operator to resume it, then restart your tools; nothing needs reconnecting.");
  }
  if (!res.ok) throw fail(`HTTP ${res.status}`);
}

/** POST /v1/devices/tools: tells the console which tools this computer runs. A hub that can't record them (an older one)
 * doesn't make the connect fail; the note says so. */
async function recordTools(hub, credential, tools) {
  try {
    const res = await fetch(`${hub}/v1/devices/tools`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ tools }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err.cause?.code ?? err.message;
  }
}

async function connectMachine(opts) {
  const { home, code } = opts;
  // No code: re-run setup with the credential this computer holds (--hub, if given, picks which one).
  const rerun = !code;
  // Parse everything this run will merge BEFORE redeeming: a broken file found afterwards would strand the credential.
  planCredentials({ home, hub: opts.hub ?? DEFAULT_HUB, credential: "<computer credential>", deviceId: "<device>" });
  // With a code, the credential this computer already holds for the same hub goes along, so the hub can update this same
  // computer instead of adding a second one. It is only ever sent in the redeem body.
  const stored = readStoredCredential({ home, hub: opts.hub });
  if (rerun && !stored) throw new CliError(NOT_CONNECTED);
  const hub = rerun ? stored.hub : opts.hub;
  const chosen = chooseMachineTools(home, opts.client, { rerun });
  let { tools } = chosen;
  const { measuring } = chosen;
  // Amp's settings may be JSONC, which this writer would strip of its comments. Asked for by name, that stops the run
  // before the code is spent; found by detection, Amp is skipped and every other tool is still set up.
  const earlyNotes = [];
  const ampProblem = tools.includes("amp") && ampSettingsProblem({ home, proxyPath: join(home, ".opencadre", "bin", "opencadre-mcp.mjs") });
  if (ampProblem) {
    if (opts.client === "amp" || tools.length === 1) throw new CliError(ampProblem);
    tools = tools.filter((t) => t !== "amp");
    earlyNotes.push(`Amp was not set up. ${ampProblem}`);
  }
  // Kilo's kilo.json, likewise.
  const kiloProblem = tools.includes("kilo") && kiloConfigProblem({ home, proxyPath: join(home, ".opencadre", "bin", "opencadre-mcp.mjs"), pluginPath: join(home, ".opencadre", "bin", "opencadre-kilo-plugin.js") });
  if (kiloProblem) {
    if (opts.client === "kilo" || tools.length === 1) throw new CliError(kiloProblem);
    tools = tools.filter((t) => t !== "kilo");
    earlyNotes.push(`Kilo Code was not set up. ${kiloProblem}`);
  }
  // Devin's config.json and mcp_config.json, likewise (JSON with comments).
  const devinProblem = tools.includes("devin") && devinConfigProblem({ home });
  if (devinProblem) {
    if (opts.client === "devin" || tools.length === 1) throw new CliError(devinProblem);
    tools = tools.filter((t) => t !== "devin");
    earlyNotes.push(`Devin was not set up. ${devinProblem}`);
  }
  // Crush's crush.json, likewise.
  const crushProblem = tools.includes("crush") && crushConfigProblem({ home });
  if (crushProblem) {
    if (opts.client === "crush" || tools.length === 1) throw new CliError(crushProblem);
    tools = tools.filter((t) => t !== "crush");
    earlyNotes.push(`Crush was not set up. ${crushProblem}`);
  }
  // --home means "write files under this folder", which the claude CLI can't honor.
  const claude = !opts.homeOverride ? claudeExecutable() : null;
  const binDir = join(home, ".opencadre", "bin");
  const proxyPath = join(binDir, "opencadre-mcp.mjs");
  const hookPaths = { awarenessPath: join(binDir, "opencadre-awareness.mjs"), wakePath: join(binDir, "opencadre-wake.mjs"), usagePath: join(binDir, "opencadre-usage.mjs"), gatePath: join(binDir, "opencadre-approval-gate.mjs"), stampPath: join(binDir, "opencadre-session-stamp.mjs") };
  const claudePlans = tools.includes("claude-code") && { server: planSessionServer({ home, proxyPath, client: "claude-code" }), hooks: planSessionHooks({ home, client: "claude-code", ...hookPaths }) };
  const codexPlan = tools.includes("codex") && planCodexSessionServer({ home, proxyPath });
  const opencodePlan = tools.includes("opencode") && planOpencodeSessionServer({ home, proxyPath });
  const cursorProjectRoot = !opts.homeOverride && resolve(process.cwd()).toLowerCase() !== resolve(home).toLowerCase() ? process.cwd() : null;
  const cursorPlans = tools.includes("cursor") && { server: planCursorSessionServer({ home, proxyPath }), project: cursorProjectRoot ? planCursorProjectServer({ projectRoot: cursorProjectRoot, proxyPath }) : null, rule: cursorProjectRoot ? planCursorProjectRule({ projectRoot: cursorProjectRoot }) : null, hooks: planSessionHooks({ home, client: "cursor", ...hookPaths }) };
  // One file holds Gemini's server and its hooks, so the dry run describes both from the server plan's file.
  const geminiPlan = tools.includes("gemini") && planGeminiSessionServer({ home, proxyPath });
  const qwenPlan = tools.includes("qwen") && planQwenSessionServer({ home, proxyPath });
  // Planned before the code is spent: a config.yaml whose shape the writer will not edit stops the run here.
  const windsurfPlan = tools.includes("windsurf") && planWindsurfHooks({ home, gatePath: hookPaths.gatePath });
  const copilotPlans = tools.includes("copilot") && { server: planCopilotSessionServer({ home, proxyPath }), hooks: planCopilotHooks({ home, ...hookPaths }) };
  const goosePlans = tools.includes("goose") && { server: planGooseSessionServer({ home, proxyPath }), plugin: planGoosePlugin({ home, ...hookPaths }) };
  const ampPlans = tools.includes("amp") && { server: planAmpSessionServer({ home, proxyPath }), plugin: planAmpPlugin({ home, pluginPath: join(binDir, "opencadre-amp-plugin.mjs") }) };
  const antigravityPlans = tools.includes("antigravity") && { server: planAntigravitySessionServer({ home, proxyPath }), hooks: planAntigravityHooks({ home, binDir }), rules: planAntigravityRules({ home, binDir }) };
  const devinPlans = tools.includes("devin") && { server: planDevinSessionServer({ home, proxyPath }), hooks: planDevinHooks({ home, ...hookPaths }) };
  const droidPlans = tools.includes("droid") && { server: planDroidSessionServer({ home, proxyPath }), hooks: planDroidHooks({ home, ...hookPaths }) };
  const crushPlan = tools.includes("crush") && planCrushConfig({ home, proxyPath, ...hookPaths });
  const vibePlans = tools.includes("vibe") && { server: planVibeSessionServer({ home, proxyPath }), hooks: planVibeHooks({ home, ...hookPaths }) };
  const grokPlans = tools.includes("grok") && { server: planGrokSessionServer({ home, proxyPath }), hooks: planGrokHooks({ home, ...hookPaths }) };
  // Planned before the code is spent: a Cline hook file of the user's own stops the run here.
  const clinePlans = tools.includes("cline") && { server: planClineSessionServer({ home, proxyPath }), hooks: planClineHooks({ home, hookPath: join(binDir, "opencadre-cline-hook.mjs") }) };
  const kiloPlan = tools.includes("kilo") && planKiloConfig({ home, proxyPath, pluginPath: join(binDir, "opencadre-kilo-plugin.js") });
  const namedClaude = tools.includes("claude-code") ? readExistingServer({ home, client: "claude-code" }) : { found: false };
  const namedCodex = tools.includes("codex") ? readExistingServer({ home, client: "codex" }) : { found: false };
  // Only a Claude Code chat's Bash tool tells this command which chat it runs in (Codex gives no session id).
  const fromChat = tools.includes("claude-code") && /^[\x21-\x7e]{1,200}$/.test((process.env.CLAUDE_CODE_SESSION_ID ?? "").trim());
  const project = fromChat ? projectIdentity(process.cwd()) : null;

  if (opts.dryRun) {
    console.log([
      rerun
        ? `Dry run: nothing was checked or written.\nWould set this computer up again with the credential it holds for ${hub}:`
        : `Dry run: the code was not redeemed and nothing was written.\nWould connect this computer to ${hub}:`,
      `  ${join(home, ".opencadre", "credentials.json")}: this computer's credential (the only file that holds it)${rerun ? ", kept as it is" : stored ? ", kept if the hub updates this same computer" : ""}`,
      `  ${binDir}: ${Object.keys(HELPERS).join(", ")}`,
      ...(claudePlans ? [
        `  ${claudePlans.server.file}${claude ? " (via claude mcp add)" : ""}: mcpServers ${SESSION_SERVER} -> node ${proxyPath} --client claude-code`,
        `  ${claudePlans.hooks.file}: OpenCadre session hooks`,
      ] : []),
      ...(codexPlan ? [
        `  ${codexPlan.file}: [mcp_servers.${SESSION_SERVER}] -> node ${proxyPath} --client codex`,
        `  ${sessionHooksFile(home, "codex")}: OpenCadre session hooks`,
        ...(namedCodex.key ? [] : [`  ${planSessionInboxSkill({ home }).file}: opencadre-inbox skill`, `  ${planSessionInboxSetup({ home }).file}: scheduled-task setup message`]),
      ] : []),
      ...(opencodePlan ? [
        `  ${opencodePlan.file}: mcp.servers.${SESSION_SERVER} -> node ${proxyPath} --client opencode (type: local)`,
        `  ${opencodePlan.file}: plugins += ${opencodePluginDir(proxyPath)} (OpenCadre mail and clearance)`,
      ] : []),
      ...(cursorPlans ? [
        `  ${cursorPlans.server.file}: mcpServers ${SESSION_SERVER} -> node ${proxyPath} --client cursor`,
        `  ${cursorPlans.hooks.file}: OpenCadre session hooks (identity stamp, clearance gate, awareness)`,
        ...(cursorPlans.project ? [`  ${cursorPlans.project.file}: project MCP server pinned to this folder`, `  ${cursorPlans.rule.file}: native MCP tool rule`] : []),
      ] : []),
      ...(geminiPlan ? [
        `  ${geminiPlan.file}: mcpServers ${SESSION_SERVER} -> node ${proxyPath} --client gemini, and OpenCadre session hooks (identity stamp, clearance gate, awareness)`,
      ] : []),
      ...(qwenPlan ? [
        `  ${qwenPlan.file}: mcpServers ${SESSION_SERVER} -> node ${proxyPath} --client qwen, and OpenCadre session hooks (clearance gate, awareness)`,
      ] : []),
      ...(ampPlans ? [
        `  ${ampPlans.server.file}: amp.mcpServers ${SESSION_SERVER} -> node ${proxyPath} --client amp`,
        `  ${ampPlans.plugin.file}: the OpenCadre plugin (identity stamp, clearance gate, mail, idle wake)`,
      ] : []),
      ...(antigravityPlans ? [
        `  ${antigravityPlans.server.file}: mcpServers ${SESSION_SERVER} -> node ${proxyPath} --client antigravity`,
        `  ${antigravityPlans.hooks.file}: OpenCadre hooks (inbox, clearance gate)`,
        `  ${antigravityPlans.rules.file}: the OpenCadre rules block`,
      ] : []),
      ...(vibePlans ? [
        `  ${vibePlans.server.file}: [[mcp_servers]] ${SESSION_SERVER} -> node ${proxyPath} --client vibe`,
        `  ${vibePlans.hooks.file}: OpenCadre hooks (identity stamp, clearance gate, awareness, mail at turn end)`,
      ] : []),
      ...(crushPlan ? [
        `  ${crushPlan.file}: mcp ${SESSION_SERVER} -> node ${proxyPath} --client crush, and OpenCadre hooks (identity stamp, clearance gate, awareness)`,
      ] : []),
      ...(droidPlans ? [
        `  ${droidPlans.server.file}: mcpServers ${SESSION_SERVER} -> node ${proxyPath} --client droid`,
        `  ${droidPlans.hooks.file}: OpenCadre hooks (clearance gate, awareness, mail at turn end)`,
      ] : []),
      ...(devinPlans ? [
        `  ${devinPlans.server.file}: mcpServers ${SESSION_SERVER} -> node ${proxyPath} --client devin`,
        `  ${devinPlans.hooks.file}: OpenCadre hooks (identity stamp, clearance gate, awareness, mail at turn end)`,
      ] : []),
      ...(grokPlans ? [
        `  ${grokPlans.server.file}: [mcp_servers.${SESSION_SERVER}] -> node ${proxyPath} --client grok`,
        `  ${grokPlans.hooks.file}: OpenCadre hooks (clearance gate, awareness, mail at turn end)`,
      ] : []),
      ...(clinePlans ? [
        `  ${clinePlans.server.file}: mcpServers ${SESSION_SERVER} -> node ${proxyPath} --client cline`,
        ...clinePlans.hooks.map((h) => `  ${h.file}: OpenCadre's Cline hook (identity stamp, clearance gate, mail)`),
      ] : []),
      ...(kiloPlan ? [
        `  ${kiloPlan.file}: mcp.${SESSION_SERVER} -> node ${proxyPath} --client kilo, and the OpenCadre plugin (identity stamp, clearance gate, mail, idle wake)`,
      ] : []),
      ...(windsurfPlan ? [`  ${windsurfPlan.file}: the OpenCadre approval gate on pre_run_command`] : []),
      ...(copilotPlans ? [
        `  ${copilotPlans.server.file}: mcpServers ${SESSION_SERVER} -> node ${proxyPath} --client copilot`,
        `  ${copilotPlans.hooks.file}: OpenCadre hooks (identity stamp, clearance gate, awareness)`,
      ] : []),
      ...(goosePlans ? [
        `  ${goosePlans.server.file}: extensions.${SESSION_SERVER} -> node ${proxyPath} --client goose`,
        ...goosePlans.plugin.map((p) => `  ${p.file}: the OpenCadre plugin for Goose (clearance gate, mail at turn end)`),
      ] : []),
      ...earlyNotes.map((n) => `  Note: ${n}`),
      ...(project ? [`  Would enable this chat's project: ${project.name} (${project.key})`] : []),
      "",
      "Tools on this computer:",
      ...toolLines(tools, measuring, { codexSkill: !namedCodex.key }),
    ].join("\n"));
    return;
  }

  // device: what the hub says about this computer ({ deviceId, client, computerName, orgName?, cliUrl? }).
  let device;
  let credential;
  let merged = false;
  if (rerun) {
    const me = await describeStoredComputer(hub, stored);
    device = { deviceId: me.deviceId, client: me.client, computerName: me.name, cliUrl: me.cliUrl };
    credential = stored.credential;
  } else {
    device = await redeem(hub, code, "deviceCredential", stored?.credential);
    merged = device.merged === true;
    if (merged && !stored) throw new CliError("The hub answered as if this computer were already connected, but it holds no credential. Nothing was written. Add the computer again in the console.");
    credential = merged ? stored.credential : device.deviceCredential;
  }
  const notes = [...earlyNotes];
  // An older code (or computer) was minted for one tool, and the hub names every session on it after that tool: set up only that one.
  if (device.client && device.client !== "auto") {
    const madeFor = rerun ? "This computer was added" : "This code was made";
    if (!tools.includes(device.client)) {
      const made = LABELS[device.client] ?? device.client;
      throw new CliError(`${rerun ? "This computer was added" : "This computer code was made"} for ${made} only, so it can't set up ${tools.map((t) => LABELS[t]).join(" or ")}. Nothing was written. Add the computer again in the console: new codes cover every tool.`);
    }
    if (tools.length > 1) {
      notes.push(`${madeFor} for ${LABELS[device.client]} only, so only ${LABELS[device.client]} was set up. To set up ${tools.filter((t) => t !== device.client).map((t) => LABELS[t]).join(" and ")} too, add the computer again in the console.`);
      tools = [device.client];
    }
  }
  const written = [];
  const record = (file, { changed, backup }) => written.push(`${file}${changed ? "" : " (unchanged)"}${backup ? ` (previous version kept as ${backup})` : ""}`);

  if (merged || rerun) {
    // The same computer keeps the same credential. A file already holding exactly this computer entry isn't touched at
    // all; an older per-tool file moves the same credential to the computer entry, so every tool set up here can read it.
    if (holdsComputerEntry({ home, hub, credential, deviceId: device.deviceId })) {
      written.push(`${credentialsPath(home)} (this computer's credential, unchanged)`);
    } else {
      const credPlan = planCredentials({ home, hub, credential, deviceId: device.deviceId });
      record(`${credPlan.file} (this computer's credential, kept)`, writeCredentials(credPlan));
    }
  } else {
    const credPlan = planCredentials({ home, hub, credential, deviceId: device.deviceId });
    if (credPlan.replacing) notes.push("This computer already had an OpenCadre credential; it was replaced. Remove the old computer in the console if it's no longer used.");
    record(`${credPlan.file} (this computer's credential)`, writeCredentials(credPlan));
  }
  // Report drift BEFORE the install erased it: installHelpers repairs as it writes, so a machine
  // that had been running a stale approval gate looked identical to a current one immediately after.
  // Measured on this PC 2026-09-18 -- the stale gate was invisible for exactly this reason.
  // A pre-generation install with live consumers is NOT converted here (conversionHold): bin stays byte-identical.
  const held = conversionHold(home, binDir);
  const heldWarning = held ? conversionHeldWarning(held, binDir, `npx -y ${cliUrlFor(hub, device)}`) : null;
  if (!held) {
    const helpers = installHelpers(binDir);
    written.push(...helpers);
    const drift = driftLine(helpers.drift);
    if (drift) notes.push(drift);
    if (helpers.backups.length) notes.push(`Changed helper(s) were backed up before being replaced: ${helpers.backups.join(", ")}`);
  }
  if (tools.includes("claude-code")) {
    if (claude && addSessionServerViaClaudeCli(claude, proxyPath, "claude-code")) {
      written.push(`${claudePlans.server.file} (via claude mcp add -s user ${SESSION_SERVER})`);
    } else {
      const plan = planSessionServer({ home, proxyPath, client: "claude-code" });
      record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    }
    const hooks = planSessionHooks({ home, client: "claude-code", ...hookPaths });
    record(hooks.file, writeWithBackup(hooks.file, hooks.before, hooks.after));
    noteHookRetrust("claude-code", hooks, notes);
  }
  let setup = null;
  if (tools.includes("codex")) {
    const plan = planCodexSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    // Codex's session hooks, the counterpart of the claude-code write above. WITHOUT THIS the
    // computer-credential path set up an MCP server and nothing else: a Codex chat got the tools,
    // with no awareness injection, no usage reporting and no risky-command report. That is
    // HARNESS-CODEX.md §9 item 4 verbatim ("install hooks.json on a computer-credential connect")
    // and §4.3's measured state -- hooks present on the named-agent path, absent here.
    //
    // Found by doctor's own new hooks check on its first run against a real connect (2026-09-20):
    // the check is what made this visible, which is why both halves land together.
    const hooks = planSessionHooks({ home, client: "codex", ...hookPaths });
    record(hooks.file, writeWithBackup(hooks.file, hooks.before, hooks.after));
    noteHookRetrust("codex", hooks, notes);
    if (namedCodex.found && namedCodex.key) {
      notes.push("Codex on this computer also has a named agent ([mcp_servers.opencadre]). A named agent wins, so Codex chats keep acting as it and its opencadre-inbox skill was left as it is. Remove that table to give every Codex chat its own identity.");
    } else {
      const skill = planSessionInboxSkill({ home });
      record(skill.file, writeWithBackup(skill.file, skill.before, skill.after));
      setup = planSessionInboxSetup({ home });
      record(setup.file, writeWithBackup(setup.file, setup.before, setup.after));
    }
  }
  if (tools.includes("opencode")) {
    const plan = planOpencodeSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
  }
  if (tools.includes("cursor")) {
    // A named agent an older `connect --code oc_` wrote into ~/.cursor/mcp.json wins over the session server (the proxy
    // stands down for it), so say so rather than leave the user wondering why every chat has the same name.
    const namedCursor = readExistingServer({ home, client: "cursor" });
    if (namedCursor.found && namedCursor.key) {
      notes.push("Cursor on this computer also has a named agent (mcpServers.opencadre in ~/.cursor/mcp.json). A named agent wins, so Cursor chats keep acting as it. Remove that entry to give every Cursor chat its own identity.");
    }
    const plan = planCursorSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    if (cursorPlans.project) record(cursorPlans.project.file, writeWithBackup(cursorPlans.project.file, cursorPlans.project.before, cursorPlans.project.after));
    if (cursorPlans.rule) record(cursorPlans.rule.file, writeWithBackup(cursorPlans.rule.file, cursorPlans.rule.before, cursorPlans.rule.after));
    // The hooks are half of Cursor's identity: without the stamp every OpenCadre call is refused, because
    // Cursor's MCP child may serve every chat and an unstamped call has no chat to act as.
    const hooks = planSessionHooks({ home, client: "cursor", ...hookPaths });
    record(hooks.file, writeWithBackup(hooks.file, hooks.before, hooks.after));
  }
  if (tools.includes("gemini")) {
    const namedGemini = readExistingServer({ home, client: "gemini" });
    if (namedGemini.found && namedGemini.key) {
      notes.push("Gemini CLI on this computer also has a named agent (mcpServers.opencadre in ~/.gemini/settings.json). A named agent wins, so Gemini chats keep acting as it. Remove that entry to give every Gemini chat its own identity.");
    }
    // Server first, then hooks, each planned from the file as it is by then: both live in ~/.gemini/settings.json.
    const plan = planGeminiSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    const hooks = planSessionHooks({ home, client: "gemini", ...hookPaths });
    record(`${hooks.file} (session hooks)`, writeWithBackup(hooks.file, hooks.before, hooks.after));
  }
  if (tools.includes("qwen")) {
    const namedQwen = readExistingServer({ home, client: "qwen" });
    if (namedQwen.found && namedQwen.key) {
      notes.push("Qwen Code on this computer also has a named agent (mcpServers.opencadre in ~/.qwen/settings.json). A named agent wins, so Qwen sessions keep acting as it. Remove that entry to give every Qwen session its own identity.");
    }
    // Server first, then hooks: both live in ~/.qwen/settings.json.
    const plan = planQwenSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    const hooks = planSessionHooks({ home, client: "qwen", ...hookPaths });
    record(`${hooks.file} (session hooks)`, writeWithBackup(hooks.file, hooks.before, hooks.after));
  }

  if (tools.includes("windsurf")) {
    const plan = planWindsurfHooks({ home, gatePath: hookPaths.gatePath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
  }
  if (tools.includes("copilot")) {
    const namedCopilot = readExistingServer({ home, client: "copilot" });
    if (namedCopilot.found && namedCopilot.key) {
      notes.push("Copilot CLI on this computer also has a named agent (mcpServers.opencadre in ~/.copilot/mcp-config.json). A named agent wins, so Copilot sessions keep acting as it. Remove that entry to give every session its own identity.");
    }
    const plan = planCopilotSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    const hooks = planCopilotHooks({ home, ...hookPaths });
    record(hooks.file, writeWithBackup(hooks.file, hooks.before, hooks.after));
  }
  if (tools.includes("goose")) {
    // Goose runs every hook with `sh -c`, on Windows too; without an `sh` on PATH (Git for Windows puts one there) each
    // hook fails, and the gate, set to fail closed, blocks every shell command.
    if (process.platform === "win32" && !findOnPath("sh")) {
      notes.push("Goose runs its hooks with `sh`, which is not on this computer's PATH. Install Git for Windows (or add its usr\\bin to PATH), or Goose will block every shell command.");
    }
    const plan = planGooseSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    for (const p of planGoosePlugin({ home, ...hookPaths })) record(p.file, writeWithBackup(p.file, p.before, p.after));
  }
  if (tools.includes("amp")) {
    // The server and the plugin are one feature: without the plugin's stamp every OpenCadre call from Amp is refused,
    // because one Amp MCP child serves every thread and an unstamped call has no thread to act as.
    const plan = planAmpSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    const plugin = planAmpPlugin({ home, pluginPath: join(binDir, "opencadre-amp-plugin.mjs") });
    record(plugin.file, writeWithBackup(plugin.file, plugin.before, plugin.after));
  }
  if (tools.includes("antigravity")) {
    // A named agent in the file Antigravity reads wins, as for the others; one only in the legacy file is never loaded.
    if (readExistingServer({ home, client: "antigravity" }).table === "opencadre") {
      notes.push("Antigravity on this computer also has a named agent (mcpServers.opencadre in ~/.gemini/config/mcp_config.json). A named agent wins, so Antigravity conversations keep acting as it. Remove that entry to give every conversation its own identity.");
    }
    const plan = planAntigravitySessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    const hooks = planAntigravityHooks({ home, binDir });
    record(hooks.file, writeWithBackup(hooks.file, hooks.before, hooks.after));
    const rules = planAntigravityRules({ home, binDir });
    record(rules.file, writeWithBackup(rules.file, rules.before, rules.after));
  }
  if (tools.includes("devin")) {
    // The server and the hooks are one feature: without the stamp every OpenCadre call from Devin is refused.
    const plan = planDevinSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    const hooks = planDevinHooks({ home, ...hookPaths });
    record(hooks.file, writeWithBackup(hooks.file, hooks.before, hooks.after));
  }
  if (tools.includes("vibe")) {
    // The server and the hooks are one feature: without the stamp every OpenCadre call from Vibe is refused.
    const plan = planVibeSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    const hooks = planVibeHooks({ home, ...hookPaths });
    record(hooks.file, writeWithBackup(hooks.file, hooks.before, hooks.after));
  }
  if (tools.includes("crush")) {
    // The server and the hooks are one feature and one file: without the stamp every OpenCadre call is refused.
    const plan = planCrushConfig({ home, proxyPath, ...hookPaths });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
  }
  if (tools.includes("droid")) {
    const plan = planDroidSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    const hooks = planDroidHooks({ home, ...hookPaths });
    record(hooks.file, writeWithBackup(hooks.file, hooks.before, hooks.after));
  }
  if (tools.includes("grok")) {
    const plan = planGrokSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    const hooks = planGrokHooks({ home, ...hookPaths });
    record(hooks.file, writeWithBackup(hooks.file, hooks.before, hooks.after));
  }
  if (tools.includes("cline")) {
    // The server and the hooks are one feature: without the PreToolUse hook's stamp every OpenCadre call is refused.
    const plan = planClineSessionServer({ home, proxyPath });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    for (const h of planClineHooks({ home, hookPath: join(binDir, "opencadre-cline-hook.mjs") })) record(h.file, writeWithBackup(h.file, h.before, h.after));
    // Cline also runs ~/Documents/Cline/Hooks, and the last hook's rewrite of a command wins; OpenCadre's hook then
    // denies by stopping the run instead (examples/hooks/opencadre-cline-hook.mjs). Said, so it is not a surprise.
    const docs = join(home, "Documents", "Cline", "Hooks");
    if (existsSync(docs) && readdirSync(docs).some((n) => n.replace(/\.[^.]*$/, "") === "PreToolUse")) {
      notes.push(`Cline: ${docs} has a PreToolUse hook of your own. Cline runs both, and either could rewrite a command, so when OpenCadre denies one it stops the whole run rather than replacing the command.`);
    }
  }
  if (tools.includes("kilo")) {
    // The server and the plugin are one feature, in one file: without the plugin's stamp every OpenCadre call from Kilo
    // is refused, because one Kilo MCP child serves every session in a folder.
    const plan = planKiloConfig({ home, proxyPath, pluginPath: join(binDir, "opencadre-kilo-plugin.js") });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    // Only where this run created Kilo's first config: see planKiloConfig.
    if (plan.marker && !existsSync(plan.marker)) writeFileSync(plan.marker, "");
  }

  // A re-run already proved its credential before writing anything.
  if (!rerun) await checkDeviceCredential(hub, credential);
  const toolsNotRecorded = await recordTools(hub, credential, tools);
  if (toolsNotRecorded) notes.push(`The hub didn't record which tools this computer runs (${toolsNotRecorded}), so the console may not list them yet. Everything else is set up.`);

  // The chat running this command (Claude Code sets the session ids in its Bash tool) keeps working as its agent now,
  // resolved exactly as its hooks will resolve it: a named agent for this folder wins, else this session's own identity.
  const cli = `npx -y ${cliUrlFor(hub, device)}`;
  // allowUnlisted: connect is the one command that names a folder the local project list doesn't have yet -- running it
  // here is how this folder gets enabled (scripts/opencadre-config.mjs, local opt-in).
  const here = fromChat ? resolveHub({ client: "claude-code", cwd: process.cwd(), home, create: true, allowUnlisted: true }) : {};
  let enabled = null;
  let intro = null;
  let next;
  let joined = null;
  // Enabling this folder is a DEVICE action, not a chat one: enableCurrentProject (src/devices.ts)
  // needs the device credential and X-OpenCadre-Project, and no session hints at all -- unlike
  // leaveDeviceSession right below it. Gating it on `here.source === "device"` therefore tied it to
  // running from a Claude Code chat for no reason the hub requires, and that was issue #367: the
  // console's PRIMARY button hands over a command to run in a TERMINAL, where fromChat is false, so
  // no project was ever enabled. The credential worked, the console said "Connected", and the first
  // chat in that folder got answerAsEmptyServer -- HTTP 200, zero tools, no error to notice.
  //
  // The operator runs connect in this folder on purpose, in a terminal exactly as in a chat, so the
  // folder is enabled on both paths now. No OTHER project is; the console still owns the rest, and
  // the line printed below names the one that was enabled so an unintended folder is visible and
  // reversible rather than silent.
  // The identity here is built fresh rather than spread from `here`, and NOT carrying `source` is
  // load-bearing -- do not "restore" the spread. hubCall (cli/lib/session.mjs:67) rewrites a
  // project-not-enabled response into PROJECT_OFF_MESSAGE ("Enable it in the console under
  // Fleet -> Projects") only when `identity.source === "device"`. On the old chat path that special
  // case could fire on THIS call -- the one whose whole job is to enable the project -- and answer a
  // user who is already running connect by telling them to go and enable it by hand. Without
  // `source` the hub's real error text survives into the note instead, which is the thing a reader
  // can act on. Credit to the reviewer who spotted this; the PR did not claim it.
  const projectHere = projectHeaders(process.cwd());
  // projectHeaders() documents {} as "this folder names no project", so an empty object is the
  // guard: without a project key the hub would refuse with a 400 telling us to send one.
  if (credential && Object.keys(projectHere).length > 0) {
    try {
      ({ project: enabled } = await hubCall({ base: hub, key: credential, headers: projectHere }, "PUT", "/v1/devices/projects/enable-current"));
    } catch (err) {
      const which = fromChat ? "This chat's project" : "This folder's project";
      notes.push(`${which} couldn't be enabled (${err.message.replace(/\.$/, "")}). Enable it in the console under Settings → Projects.`);
    }
  }
  // This computer's first (or fresh) copy of the enabled-project list, asked with the credential alone. From here on the
  // hooks and the MCP server name only listed folders to the hub. A failure keeps whatever list was there.
  if (credential) {
    const synced = await syncProjectAllowlist({ hub, credential, home });
    if (!synced.ok && synced.reason !== "hub_cannot_list") notes.push(`This computer couldn't fetch its list of enabled projects yet (${synced.reason}); it will try again when a chat starts.`);
  }
  // The connect-time join creates this chat's session (hooks only ever resolve one that exists), so
  // it stays chat-only: a terminal has no chat to seat.
  if (here.source === "device" && enabled) {
    try {
      joined = await hubCall(here, "POST", "/v1/sessions/join", { body: {} });
    } catch (err) {
      notes.push(`The computer is connected, but this chat couldn't join yet (${err.message.replace(/\.$/, "")}).`);
    }
  }
  const claudeLabel = LABELS["claude-code"];
  if (joined) {
    // A running chat never starts an MCP server added mid-chat, but its seat is the host session id, which survives a
    // restart: the same chat after a restart is this same agent, now with the full tools.
    next = [
      `This chat is now ${joined.agentName}. It works right away through the opencadre commands (inbox, reply, send, status, wait).`,
      `To get the full OpenCadre tools in this chat, restart ${claudeLabel} and come back to THIS SAME chat. Don't open a new one. It stays ${joined.agentName}.`,
      "Chats you open later in this project join automatically with their own names; no restart needed.",
      `Run the commands as: ${cli} inbox (also: reply <threadId> "<message>", send <agent> "<message>", status "<task>", wait, whoami).`,
    ];
  } else if (here.key && here.source !== "device") {
    const who = await existingAgentName(`${here.base}/mcp`, hub, here.key);
    intro = `This chat's folder has a named OpenCadre agent${who ? ` ("${who}")` : ""}, and a named agent wins where it's configured, so this chat keeps acting as it.`;
    next = ["Chats you open later in other enabled projects join automatically with their own names; no restart needed."];
  } else {
    // A gate-only tool (Windsurf) gets no session server, so its chats do not join: its own line below says what it gets.
    const joining = tools.filter((t) => !gateOnlyFor(t));
    next = joining.length > 0 ? [`Restart ${joining.map((t) => LABELS[t]).join(" and ")}: from then on every chat in an enabled project joins OpenCadre automatically under its own name, a word like Birch, shown with its tool and project; name it anything in the console.`] : [];
  }
  if (!enabled) next.push("Enable the projects this computer should join in the console under Settings → Projects. Chats in other projects see no OpenCadre at all.");
  if (tools.includes("windsurf")) {
    next.push("Windsurf: risky shell commands in Cascade conversations wait for approval in OpenCadre; each Cascade conversation that runs one appears as an agent of its own. Devin Desktop's default Devin Local agent does not run Cascade hooks; connect it with --client devin. Windsurf's hooks cannot give a chat OpenCadre's tools or mail; for those, connect Windsurf as a named agent with an agent code (oc_) from the console.");
  }
  if (tools.includes("copilot")) {
    next.push("Copilot CLI: each session is its own agent, and /new or /clear starts a new one. Risky shell commands wait for approval in OpenCadre; new mail reaches a session when its turn ends. Copilot CLI has no supported way to wake an idle session.");
  }
  if (tools.includes("goose")) {
    next.push("Goose: each session is its own agent, and a new session (/new) is a new agent; a subagent that uses OpenCadre joins as an agent of its own. Risky shell commands wait for approval in OpenCadre; new mail reaches a session when its turn ends. Goose cannot wake an idle session, and it runs no plugin hooks for subagents or code mode, so commands those run are not held by OpenCadre.");
  }
  if (tools.includes("devin")) {
    next.push("Devin: each session is its own agent, in the CLI and in Devin Desktop's Devin Local. Risky shell commands wait for approval in OpenCadre, a session is told its name when it starts, and new mail reaches it when its turn ends. Devin still asks before any OpenCadre tool runs, unless you allow them in Devin. A legacy Cascade conversation reads the same MCP file but cannot name itself, so its OpenCadre calls are refused. Start a new Devin session to load the hooks.");
  }
  if (tools.includes("vibe")) {
    next.push("Mistral Vibe: each session is its own agent. Risky shell commands wait for approval in OpenCadre for up to 9 minutes, and a gate that fails blocks the command. A session is told its name with its first tool result, and new mail continues its turn when it ends (up to Vibe's three times a turn). Vibe cannot wake an idle session. Start a new Vibe session to load the hooks.");
  }
  if (tools.includes("crush")) {
    next.push("Crush: each session is its own agent. Risky shell commands wait for approval in OpenCadre for up to 9 minutes, a session is told its name at its first tool, and new mail reaches it with its tool results while it works. Crush has no hook at the end of a turn, so mail cannot continue a turn or wake an idle session. Crush still asks before an OpenCadre tool runs unless you allow it in Crush. Start a new Crush session to load the hooks.");
  }
  if (tools.includes("droid")) {
    next.push("Factory Droid: each session is its own agent (every OpenCadre call names its session). Risky shell commands wait for approval in OpenCadre for up to 9 minutes, a session is told its name when it starts, and new mail reaches it when its turn ends. Droid still asks before an OpenCadre tool runs unless you allow it in Droid. Start a new Droid session to load the hooks.");
  }
  if (tools.includes("grok")) {
    next.push("Grok Build: each session is its own agent; a subagent's OpenCadre calls act as its parent. Risky shell commands (run_terminal_command and monitor) wait for approval in OpenCadre, and a subagent's are blocked, since it has no session of its own to ask as. New mail reaches a session when its turn ends. Grok also runs Claude Code's hooks from ~/.claude/settings.json; those stay out of Grok's sessions now that Grok has its own. Start a new Grok session to load them.");
  }
  if (tools.includes("cline")) {
    next.push("Cline: each session is its own agent. Risky shell commands wait for approval in OpenCadre for up to 100 seconds (Cline stops waiting for a hook at 120), and a denied command is replaced by a note saying why. New mail and what changed reach a session while it works, after its tools run; Cline gives no way to continue a turn or wake an idle session. Start a new Cline session to load the hooks.");
  }
  if (tools.includes("antigravity")) {
    next.push("Antigravity: each conversation is its own agent. Risky shell commands wait for approval in OpenCadre; new mail reaches a conversation when its turn ends, and the conversation is told to keep a wake watcher running in the background for mail that arrives while it is idle. Restart Antigravity so it loads the OpenCadre server and hooks.");
  }
  if (tools.includes("kilo")) {
    next.push("Kilo Code: each session is its own agent, and a subagent that uses OpenCadre is an agent of its own. Risky shell commands wait for approval in OpenCadre (notebook cells the VS Code extension runs are not held); new mail reaches a session when its turn ends, and a session used in the last two hours gets a message when mail arrives while Kilo is running (each starts a turn). Restart Kilo to load the OpenCadre plugin.");
  }
  if (tools.includes("amp")) {
    next.push("Amp: each thread is its own agent. New mail reaches a thread when its turn ends, and a thread used in the last two hours gets a message when mail arrives while Amp is running (each starts a turn). Run \"plugins: reload\" in Amp, or restart it, to load the OpenCadre plugin.");
  }
  if (tools.includes("qwen")) {
    next.push("Qwen Code: each qwen process is its own agent, and keeps its name across /clear. New mail reaches it when its turn ends; Qwen Code has no way to wake an idle session.");
  }
  if (tools.includes("gemini")) {
    next.push("Gemini CLI: each session is its own agent. New mail reaches it when its turn ends; Gemini CLI has no way to wake an idle session, so it sees new mail on your next message. Hooks run only in folders Gemini trusts.");
  }
  if (tools.includes("cursor")) {
    if (!cursorPlans.project) next.push("Cursor: run connect from your project folder to add project tools; running it from your home folder installs only the global session server and hooks.");
    next.push("Cursor: open the enabled project folder in Cursor and start the chat there. The empty Agents window has no project MCP tools. Enable opencadre-project in Customize > MCPs and select Opencadre Project under Add agents, context, tools > MCP for that chat.");
    next.push("Cursor: call OpenCadre with native CallMcpTool or GetDynamicTools + CallDynamicTool, using the discovered project server and opencadre_<tool> name. Never run opencadre-mcp.mjs from Shell; that bypasses the chat identity hook.");
    next.push("Cursor: each chat is its own session, named by its conversation. New mail reaches a chat when its turn ends or while it uses tools; Cursor has no supported idle wake in this setup, so a chat you are not using sees its mail on your next message.");
    next.push("Cursor: if it asks whether to allow the OpenCadre MCP server or its hooks, allow them; risky shell commands are held in OpenCadre for approval before they run.");
  }
  if (tools.includes("codex")) {
    next.push("Codex: each chat uses its own OpenCadre identity. Returning with the same OpenCadre identity can keep its name and inbox; a new identity does not inherit them.");
    next.push("Codex: in the desktop app, send one ordinary message in the folder you work in (Codex lists a folder's hooks only after a chat has run there), then open Settings > Hooks, review and trust each OpenCadre hook, then start a new chat. In Codex CLI, use /hooks instead. Until trusted, identity, mail and the approval gate are not ready.");
    if (setup) next.push(`The optional Codex inbox message below is also saved to ${setup.file}.`);
  }
  if (namedClaude.found && namedClaude.key && here.source !== "claude-code") {
    const who = await existingAgentName(namedClaude.url, hub, namedClaude.key);
    notes.push(`${claudeLabel} on this computer also has a user-wide named agent${who ? ` ("${who}")` : ""}. A named agent wins wherever it's configured, so sessions keep acting as it until that entry is removed (claude mcp remove -s user opencadre).`);
  }

  const setUp = tools.map((t) => LABELS[t]).join(" and ");
  const headline = merged
    ? `Updated this computer, ${device.computerName ?? "the one already connected"}: set up ${setUp}. Chats in enabled projects join automatically.`
    : rerun
      ? `Re-ran setup for ${device.computerName ?? "this computer"}: set up ${setUp}. Chats in enabled projects join automatically.`
      : `Connected this computer to ${device.orgName}. Every chat in its tools gets its own name automatically, in the projects you enable.`;
  // The file list (every path, every backup) is the full report's; the short one says how many and that backups exist.
  // Notes, the held-helpers warning and the next steps print either way: they are what the user acts on.
  const report = (filesBlock) => [
    headline,
    ...(intro ? ["", intro] : []),
    "",
    "Tools on this computer:",
    ...toolLines(tools, measuring.filter((t) => !tools.includes(t)), { codexSkill: Boolean(setup) }),
    ...(enabled ? ["", `Enabled this project: ${enabled.name}. Other projects on this computer stay off until you enable them in the console.`] : []),
    "",
    ...filesBlock,
    ...notes.flatMap((n) => ["", `Note: ${n}`]),
    ...(heldWarning ? ["", ...heldWarning] : []),
    "",
    "Next steps (if an AI agent ran this command: show these to the user word for word):",
    ...next.map((s) => `  - ${s}`),
    "  - A folder that has its own named OpenCadre agent keeps it: sessions there act as that agent.",
    ...(tools.includes("claude-code") ? ["  - Claude Code: next-turn mail was measured on a local hub. The Stop hook installs opencadre-wake.mjs with asyncRewake; that wiring does not prove idle wake. Idle wake in an interactive terminal and the current desktop app is not yet verified."] : []),
    ...(setup ? ["", "Codex inbox message:", "", `  ${setup.message}`] : []),
  ];
  printReport({ home, name: "last-connect.txt", title: "opencadre connect", full: report(["Files written:", ...written.map((f) => `  ${f}`)]), short: report([filesLine(written)]), verbose: opts.verbose });
  // Also on stderr, so a wrapper that keeps only stderr (or only shows it in red) still sees that the helpers were held.
  if (heldWarning) console.error(heldWarning.join("\n"));
}

async function main() {
  const opts = parseCli();
  if (!opts) return console.log(USAGE);
  if (opts.command === "doctor") {
    const cwd = process.cwd();
    const cursorProject = opts.client === "cursor" && !opts.homeOverride && resolve(cwd).toLowerCase() !== resolve(opts.home).toLowerCase() && (existsSync(join(cwd, ".cursor")) || existsSync(join(cwd, ".git")));
    const { healthy, unmeasured, actionRequired, lines } = await runDoctor({ client: opts.client, home: opts.home, color: Boolean(process.stdout.isTTY), projectRoot: cursorProject ? cwd : null, cwd, env: process.env });
    console.log(lines.join("\n"));
    /**
     * Three outcomes, three codes — the same vocabulary the ops checks use (version-gap.mjs,
     * alert-check.mjs, deploy-survival-check.mjs: 0 intact, 1 real fault, 2 could not determine).
     *
     * `unmeasured` takes 2 and NOT 0: a tool that could not be checked has not passed anything, and
     * a caller reading only the status must not be able to mistake it for a green. It also must not
     * take 1, which would report a product fault for a machine that simply lacks the tool — the
     * misreading the third outcome exists to prevent.
     */
    // A FOURTH outcome since PR-B's follow-up: 3, user action required (hook_trust_unverified). Nothing is known wrong,
    // so not 1; activation is unproven, so not 0. The same 3 `connect --upgrade` uses for "done, but you must act".
    if (unmeasured) process.exitCode = 2;
    else if (actionRequired) process.exitCode = 3;
    else if (!healthy) process.exitCode = 1;
    return;
  }
  if (opts.command === "connect-machine") return connectMachine(opts);
  if (opts.command === "upgrade") return runUpgrade(opts);
  if (opts.command === "update") return runUpdate(opts);
  if (opts.command === "session") return console.log((await runSessionCommand(opts)).join("\n"));
  const { hub, home, code } = opts;
  const client = opts.client === "auto" ? await chooseClient(home) : opts.client;
  // --home means "write files under this folder", which the claude CLI can't honor.
  const claude = client === "claude-code" && !opts.homeOverride ? claudeExecutable() : null;
  const binDir = join(home, ".opencadre", "bin");
  // Parse everything this run will merge BEFORE redeeming: a broken file found afterwards would strand the key.
  //
  // A client with no config writer (grok today) would make planClientConfig below throw a raw
  // "Cannot read properties of undefined (reading 'path')" -- a crash where a refusal belongs.
  // Measuring clients are NOT refused wholesale: antigravity is measuring and connectable (as are the
  // served cursor, gemini, opencode and qwen), so the test is writers, not measurement state. On this path the user has already
  // used an oc_ code, so the "go and make an oc_ command" advice the ocd_ path gives would be
  // nonsense here; say what the key is and what can actually be done with it.
  if (!hasConfigWriter(client)) {
    const label = LABELS[client] ?? client;
    const connectable = CLIENTS.filter((c) => hasConfigWriter(c)).map((c) => LABELS[c]).join(", ");
    throw new CliError(
      `${label} isn't supported yet: reading its config is still being measured. The code wasn't used. ` +
        `This key is for one agent; connect it with one of ${connectable}, or wait for ${label} support.`,
      2,
    );
  }
  const { project, note: targetNote } = await resolveTarget(opts, client);
  const configPlan = planClientConfig({ home, client, hub, key: "<agent key>", project });
  const hookArgs = { home, client, awarenessPath: join(binDir, "opencadre-awareness.mjs"), wakePath: join(binDir, "opencadre-wake.mjs"), usagePath: join(binDir, "opencadre-usage.mjs"), gatePath: join(binDir, "opencadre-approval-gate.mjs"), stampPath: join(binDir, "opencadre-session-stamp.mjs") };
  const hookPlan = HOOK_CLIENTS.includes(client) ? planSessionHooks(hookArgs) : null;
  const antigravityPlan = client === "antigravity" ? planAntigravityHooks({ home, binDir }) : null;
  // Parsed before redeeming too: a rules file that cannot be read must not strand a code either.
  const rulesPlan = client === "antigravity" ? planAntigravityRules({ home, binDir }) : null;

  if (opts.dryRun) {
    console.log(`Dry run: the code was not redeemed and nothing was written.\nWould connect ${LABELS[client]} to ${hub}:`);
    if (targetNote) console.log(`  Note: ${targetNote}`);
    console.log(`  ${configPlan.file}${claude ? " (via claude mcp add)" : ""}: ${project ? `opencadre for ${project} only` : "mcpServers opencadre"} -> ${hub}/mcp`);
    console.log(`  ${binDir}: ${Object.keys(HELPERS).join(", ")}`);
    if (hookPlan) console.log(`  ${hookPlan.file}: OpenCadre session hooks`);
    if (antigravityPlan) console.log(`  ${antigravityPlan.file}: OpenCadre inbox hooks (global; a workspace's own .agent/hooks.json, if any, still wins there)`);
    if (rulesPlan) console.log(`  ${rulesPlan.file}: OpenCadre inbox rule (global; existing rules are kept)`);
    if (client === "codex") {
      console.log(`  ${planInboxSkill({ home, agentName: "<agent>" }).file}: opencadre-inbox skill`);
      console.log(`  ${planInboxSetup({ home }).file}: scheduled-task setup message`);
    }
    return;
  }

  const agent = await redeem(hub, code);
  const written = [];
  const record = (file, { changed, backup }) => written.push(`${file}${changed ? "" : " (unchanged)"}${backup ? ` (previous version kept as ${backup})` : ""}`);

  if (claude && addViaClaudeCli(claude, hub, agent.apiKey, project)) {
    written.push(`${configPlan.file} (via claude mcp add${project ? ` -s local, for ${project}` : ""})`);
  } else {
    const plan = planClientConfig({ home, client, hub, key: agent.apiKey, project });
    record(plan.file, writeWithBackup(plan.file, plan.before, plan.after));
    for (const w of plan.warnings) console.log(`Note: ${w}`);
  }
  // A pre-generation install with live consumers is NOT converted here (conversionHold): bin stays byte-identical.
  const held = conversionHold(home, binDir);
  if (held) {
    const warning = conversionHeldWarning(held, binDir, `npx -y ${cliUrlFor(hub, agent)}`).join("\n");
    console.log(warning);
    console.error(warning);
  } else {
    const helpers = installHelpers(binDir);
    written.push(...helpers);
    // Same reason as the machine path: the install repairs as it writes, so what was stale a moment
    // ago is gone by the time the summary prints unless it is captured here.
    const agentDrift = driftLine(helpers.drift);
    if (agentDrift) console.log(`Note: ${agentDrift}`);
    if (helpers.backups.length) console.log(`Note: changed helper(s) were backed up before being replaced: ${helpers.backups.join(", ")}`);
  }
  if (hookPlan) {
    const label = client === "codex" ? " (session hooks: Codex app and CLI; review in Settings > Hooks before use)" : "";
    // Planned AGAIN from the file as it is now: Gemini CLI keeps its hooks in the same settings.json the config write
    // above just changed, and writing the plan made before it would put the old file back over the new entry.
    const fresh = planSessionHooks(hookArgs);
    record(`${fresh.file}${label}`, writeWithBackup(fresh.file, fresh.before, fresh.after));
    // This path reports through console.log rather than a `notes` array, so the warning is emitted
    // here directly. It must not be dropped just because the plumbing differs: a named agent is one
    // configuration where Codex hash-gates these hooks, and a changed command here is exactly the case
    // the warning exists for.
    const retrust = hookRetrustWarning(client, fresh.changed);
    if (retrust) console.log(`
Note: ${retrust}
`);
  }
  if (antigravityPlan) {
    record(`${antigravityPlan.file} (global inbox hooks)`, writeWithBackup(antigravityPlan.file, antigravityPlan.before, antigravityPlan.after));
    record(`${rulesPlan.file} (global inbox rule)`, writeWithBackup(rulesPlan.file, rulesPlan.before, rulesPlan.after));
  }
  let setup = null;
  if (client === "codex") {
    const skill = planInboxSkill({ home, agentName: agent.agentName });
    record(skill.file, writeWithBackup(skill.file, skill.before, skill.after));
    setup = planInboxSetup({ home });
    record(setup.file, writeWithBackup(setup.file, setup.before, setup.after));
  }

  await smokeTest(hub, agent.apiKey, agent.agentName);

  if (setup) return printCodexNext(agent, written, setup, cliUrlFor(hub, agent), { home, verbose: opts.verbose });
  const next = project
    ? [`Open a NEW Claude Code session in ${project}: this agent exists only there. Sessions in other folders keep their own agent.`]
    : [`Restart ${LABELS[client]} (or reload its MCP servers) so it loads the opencadre server.`];
  if (client === "claude-code") next.push("Idle wake is on: the Stop hook runs opencadre-wake.mjs with asyncRewake, so new mail wakes an idle session.");
  if (client === "codex") next.push("Codex: in the desktop app, send one ordinary message in the folder you work in (Codex lists a folder's hooks only after a chat has run there), then open Settings > Hooks, review and trust each OpenCadre hook, then start a new chat. In Codex CLI, use /hooks instead. Until trusted, identity, mail and the approval gate are not ready.");
  if (client === "antigravity") next.push("Inbox hooks are installed globally (~/.gemini/config/hooks.json), so every workspace gets them. If a workspace already has its own .agent/hooks.json (or .agents/hooks.json), that one wins there instead -- add the same opencadre-inbox entry to it, or remove it to use the global one.");
  const report = (filesBlock) => [
    `Connected as ${agent.agentName} in ${agent.orgName} via ${client}`,
    "",
    ...filesBlock,
    ...(targetNote ? ["", `Note: ${targetNote}`] : []),
    "",
    "Next steps (if an AI agent ran this command: show these to the user word for word):",
    ...next.map((s) => `  - ${s}`),
    "",
    "Each agent needs its own working folder: never run two agents in the same checkout.",
  ];
  printReport({ home, name: "last-connect.txt", title: "opencadre connect", full: report(["Files written:", ...written.map((f) => `  ${f}`)]), short: report([filesLine(written)]), verbose: opts.verbose });
}

/** Codex in the ChatGPT desktop app: one chat handles mail and work, woken by a scheduled task. */
/** This hub's CLI URL with the version stamp the hub sent, so printed commands never hit npx's cache of an older CLI.
 * Only the stamp is taken from the hub's answer: the host stays the one this command talked to.
 *
 * Two shapes, because the stamp's shape is the HUB's: a current hub sends the immutable path alias
 * `<hub>/cli/<12 hex>/opencadre-cli.tgz` (src/connect.ts cliTarballUrl), and the same shape is printed back. A hub from
 * before that sends `?v=<hex>` on the bare route and has no alias route at all, so its stamp is printed in ITS shape;
 * rewriting it into a path would print a URL that hub answers 404. */
function cliUrlFor(hub, redeemed) {
  let url = null;
  try {
    url = new URL(redeemed?.cliUrl ?? "");
  } catch {
    url = null;
  }
  const alias = url?.pathname.match(/\/cli\/([0-9a-f]{12})\/opencadre-cli\.tgz$/);
  if (alias) return `${hub}/cli/${alias[1]}/opencadre-cli.tgz`;
  const v = url?.searchParams.get("v");
  if (v && /^[0-9a-f]{6,64}$/.test(v)) return `${hub}/cli/opencadre-cli.tgz?v=${v}`;
  // guard-allow(no-stamp-from-hub): the hub sent no stamp (an older hub's /v1/devices/me, or a hub with no package built),
  // so no stamped URL exists to print. tests/cli-unstamped-guard.test.ts lists this exception.
  return `${hub}/cli/opencadre-cli.tgz`;
}

function printCodexNext(agent, written, setup, cliUrl, { home, verbose }) {
  const report = (filesBlock) => [
    `Connected as ${agent.agentName} in ${agent.orgName} via codex`,
    "",
    ...filesBlock,
    "",
    `Inbox setup message (if an AI agent ran this command: show it to the user word for word; also saved to ${setup.file}):`,
    "",
    `  ${setup.message}`,
    "",
    "Next steps:",
    "  1) In the Codex app, send one ordinary message in the folder you work in (Codex lists a folder's hooks only after a chat has run there), then open Settings > Hooks, review and trust each OpenCadre hook. Then restart ChatGPT/Codex, or at least start a NEW chat, so the server, hooks and inbox skill load.",
    `  2) Open ONE new chat in this agent's own working folder and name it "OpenCadre". Select the model you want doing the work FIRST (the scheduled task uses this chat's model), then paste the message from ${setup.file}.`,
    ...(copyToClipboardHint(setup.file) ? [`     Copy it in one step: ${copyToClipboardHint(setup.file)}`] : []),
    "  3) Keep the computer on and the app running.",
    "  4) Use that one chat for everything: it handles mail and does the work, checking mail between steps. Don't add a second OpenCadre chat, or it would take this agent's mail.",
    "  5) Run doctor --client codex to check the installation and hook trust record. Codex CLI users can review the same hooks with /hooks.",
    "",
    `Check the loop any time: npx -y ${cliUrl} doctor --client codex`,
    "Each agent needs its own working folder: never run two agents in the same checkout.",
  ];
  printReport({ home, name: "last-connect.txt", title: "opencadre connect", full: report(["Files written:", ...written.map((f) => `  ${f}`)]), short: report([filesLine(written)]), verbose });
}

try {
  await main();
} catch (err) {
  // Messages only, never a stack: every error here is written for the operator, and none carries the key.
  console.error(`opencadre: ${err.message}`);
  process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
}
