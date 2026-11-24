#!/usr/bin/env node
// A hook that records exactly what a harness sends it, and decides nothing. For MEASURING a harness on a real,
// signed-in install: which fields its payload carries, which event names it uses, what an MCP tool call is called
// when it reaches a hook. docs/qa/HARNESS-MEASUREMENT.md says where to install it for each harness.
//
//   node scripts/dev/hook-probe.mjs [--tag <label>] [--answer "{}"|""]
//
// Appends one JSON line per invocation to OPENCADRE_PROBE_LOG (default ~/.opencadre/hook-probe.jsonl):
//   { at, tag, argv, cwd, env: { <harness-looking names only> }, stdin }
// `stdin` is the payload parsed as JSON when it parses, else the raw text. Values of any environment variable whose
// name looks secret (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, AUTH) are replaced by "[redacted]", and so is anything
// in the payload that looks like an OpenCadre credential (agt_…, org_…, dev_…) or an email address.
//
// It answers `--answer` (default `{}`, the "no opinion" Cursor needs; pass `--answer ""` for Claude Code, Codex,
// Gemini CLI and Antigravity, which read an empty answer as no opinion, and Antigravity reads `{}` as a DENY), and
// always exits 0, so it never blocks or changes the harness it is measuring.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback);
const tag = opt("--tag", null);
const answer = opt("--answer", "{}");
const log = process.env.OPENCADRE_PROBE_LOG || join(homedir(), ".opencadre", "hook-probe.jsonl");

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;
// Only the variables a harness sets for its hooks, so the log says what the harness provides and not what the
// user's shell happens to hold.
const HARNESS_NAME = /^(CURSOR_|CLAUDE_|CODEX_|GEMINI_|QWEN_|ANTIGRAVITY|AGY_|GROK_|COPILOT_|GOOSE_|AMP_|OPENCODE_|AGENT_)/i;
// OpenCadre credentials and email addresses (Cursor sends `user_email`; harnesses export the account's) never reach
// the log, which is meant to be pasted into a harness document as evidence.
const scrub = (text) => String(text)
  .replace(/\b(agt|org|dev)_[A-Za-z0-9]{8,}/g, "$1_[redacted]")
  .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]");

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch { /* no stdin */ }
let stdin;
try {
  stdin = JSON.parse(scrub(raw));
} catch {
  stdin = scrub(raw);
}
const env = Object.fromEntries(
  Object.entries(process.env)
    .filter(([name]) => HARNESS_NAME.test(name))
    .map(([name, value]) => [name, SECRET_NAME.test(name) ? "[redacted]" : scrub(value)]),
);
try {
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), tag, argv: args, cwd: process.cwd(), env, stdin })}\n`);
} catch { /* a probe that cannot write must still not disturb the harness */ }
if (answer) process.stdout.write(answer);
process.exit(0);
