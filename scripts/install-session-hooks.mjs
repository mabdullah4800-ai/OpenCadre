#!/usr/bin/env node
// Wires the OpenCadre session hook into Claude Code or Codex. Zero dependencies.
//
//   node scripts/install-session-hooks.mjs --client codex|claude-code|cursor [--dry-run]
//
// Merges SessionStart, UserPromptSubmit, PostToolUse and Stop entries into
// ~/.codex/hooks.json or ~/.claude/settings.json, pointing at this checkout's
// examples/hooks/opencadre-awareness.mjs. For Claude Code the Stop entry also gets
// scripts/opencadre-wake.mjs --rewake as an asyncRewake handler, which wakes an idle session
// when mail arrives. Codex uses an async Stop watcher that queues a turn to its own thread.
// Usage limits are reported by scripts/opencadre-usage.mjs:
// a Codex Stop handler, or Claude Code's statusLine when the user has none. Safe to re-run: existing OpenCadre entries are
// refreshed in place, unrelated hooks and settings are never removed or reordered, and the
// previous file is kept as <file>.bak-<timestamp>. It never reads or writes keys: the hooks
// find the key in the client's own MCP config at run time.
//
// `opencadre connect` (cli/) installs the same hooks against ~/.opencadre/bin; both share
// cli/lib/session-hooks.mjs so the merge rules can't drift.
//
// Env: OPENCADRE_HOOK_HOME overrides the home directory (tests).

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeWithBackup } from "../cli/lib/files.mjs";
import { HOOK_CLIENTS, planSessionHooks } from "../cli/lib/session-hooks.mjs";

const AWARENESS_PATH = fileURLToPath(new URL("../examples/hooks/opencadre-awareness.mjs", import.meta.url));
const WAKE_PATH = fileURLToPath(new URL("opencadre-wake.mjs", import.meta.url));
const USAGE_PATH = fileURLToPath(new URL("opencadre-usage.mjs", import.meta.url));
const GATE_PATH = fileURLToPath(new URL("../examples/hooks/opencadre-approval-gate.mjs", import.meta.url));
const STAMP_PATH = fileURLToPath(new URL("../examples/hooks/opencadre-session-stamp.mjs", import.meta.url));

const args = process.argv.slice(2);
const client = args[args.indexOf("--client") + 1];
const dryRun = args.includes("--dry-run");
if (!args.includes("--client") || !HOOK_CLIENTS.includes(client)) {
  console.error(`usage: node scripts/install-session-hooks.mjs --client ${HOOK_CLIENTS.join("|")} [--dry-run]`);
  process.exit(2);
}

let plan;
try {
  plan = planSessionHooks({ home: process.env.OPENCADRE_HOOK_HOME || homedir(), client, awarenessPath: AWARENESS_PATH, wakePath: WAKE_PATH, usagePath: USAGE_PATH, gatePath: GATE_PATH, stampPath: STAMP_PATH });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (dryRun) {
  console.log(plan.after);
  process.exit(0);
}
const { changed, backup } = writeWithBackup(plan.file, plan.before, plan.after);
if (!changed) {
  console.log(`OpenCadre hooks already installed in ${plan.file}`);
} else {
  if (backup) console.log(`Backed up ${plan.file} to ${backup}`);
  console.log(`Installed OpenCadre session hooks in ${plan.file}`);
}
if (client === "claude-code") {
  console.log("Idle wake: the Stop hook starts opencadre-wake.mjs with asyncRewake, so new mail wakes an idle session. No Monitor watcher is needed.");
}
if (client === "codex") console.log("Idle wake: the async Stop hook queues new mail to this Codex thread.");
if (client === "claude-code") {
  const statusLine = JSON.parse(plan.after).statusLine;
  console.log(String(statusLine?.command ?? "").includes("opencadre-usage.mjs")
    ? "Status line: shows your usage limit and reports it to the fleet (opencadre-usage.mjs)."
    : `Status line: you already have one, so it was left alone. To report usage limits, pipe the same stdin JSON to node "${USAGE_PATH}" --client claude-code --from-stdin`);
}
if (client === "codex") console.log("Next: open /hooks in Codex once and trust the new OpenCadre hooks, or they will not run.");
