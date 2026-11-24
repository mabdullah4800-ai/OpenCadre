#!/usr/bin/env node
/**
 * Zero-token wake prompt — delegates to agent-inbox-prompt for pending replies.
 * Does NOT generate reply text.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearWakeIfNoPending, clearWakeSignals } from "./agent-wake-signal.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export function buildWakePrompt() {
  const result = spawnSync("node", [path.join(ROOT, "agent-inbox-prompt.mjs")], { encoding: "utf8", windowsHide: true });
  const prompt = (result.stdout ?? "").trim();
  const empty = prompt === "OPENCADRE_INBOX_EMPTY" || !prompt;
  return { empty, count: empty ? 0 : 1, prompt: empty ? "OPENCADRE_INBOX_EMPTY" : prompt };
}

export function flushWakePrompt() {
  const result = buildWakePrompt();
  if (result.empty) clearWakeIfNoPending();
  else clearWakeSignals();
  return result;
}

if (process.argv[1]?.endsWith("webhook-wake-prompt.mjs")) {
  const result = flushWakePrompt();
  console.log(result.prompt);
}
