#!/usr/bin/env node
// Checks OpenCadre's Cursor hooks against CURSOR'S OWN hook engine, not against its docs.
//
//   node scripts/dev/cursor-hook-contract.mjs <cursor-agent dist-package directory>
//
// Get the package the way Cursor's installer does (https://cursor.com/install prints the URL it fetches:
// https://downloads.cursor.com/lab/<version>/<os>/<arch>/agent-cli-package.tar.gz) and unpack it anywhere; this
// reads `index.js` from it and runs nothing else. No sign-in, no network, nothing installed.
//
// WHAT IT CHECKS, each with the input that would make it fail:
//   1. the ~/.cursor/hooks.json connect writes passes Cursor's config validator      (a misspelt event name fails)
//   2. every event it names is one Cursor fires                                         (same)
//   3. the stamp's matcher selects Cursor's MCP calls and nothing else                 (a matcher of "mcp__" fails)
//   4. each answer our hooks print is accepted by the validator for its step, and
//      comes out carrying the field Cursor acts on: `permission` for the gate,
//      `updated_input` for the stamp, `additional_context` for awareness,
//      `followup_message` for mail                                                     (a nested Claude answer fails
//                                                                                       the gate: Cursor ignores it
//                                                                                       unless a compat flag is on)
//   5. "no opinion" (`{}`) is valid on every step we answer on, and carries no
//      permission                                                                      (an empty stdout is not
//                                                                                       checked here: Cursor logs it
//                                                                                       as a failed hook run)
// Exit 0 when all hold, 1 when any fails, 2 when the bundle cannot be read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planSessionHooks } from "../../cli/lib/session-hooks.mjs";
import { mintStamp } from "../opencadre-config.mjs";
import { contextOutput, followupOutput, permissionOutput, silenceFor, updatedInputOutput } from "../opencadre-hook-dialect.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/dev/cursor-hook-contract.mjs <cursor-agent dist-package directory>");
  process.exit(2);
}

/** Loads the `hooks` module out of Cursor's webpack bundle: it is self-contained (its only runtime import is
 * webpack's export helper), so it can be evaluated on its own. */
function loadCursorHooks(bundleDir) {
  const text = readFileSync(join(bundleDir, "index.js"), "utf8");
  const start = text.indexOf('"../hooks/dist/index.js"(e,t,r){');
  if (start < 0) throw new Error("no hooks module in this bundle (is this a cursor-agent dist-package?)");
  const end = text.indexOf('},"../', start);
  const body = text.slice(text.indexOf("{", start) + 1, end);
  const exports = {};
  const r = { d: (target, defs) => { for (const [k, get] of Object.entries(defs)) Object.defineProperty(target, k, { get, enumerable: true }); } };
  new Function("e", "t", "r", body)({}, exports, r);
  const version = /(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7})/.exec(text.slice(0, 2_000_000))?.[1] ?? "unknown";
  return { hooks: exports, version };
}

let cursor;
try {
  cursor = loadCursorHooks(dir);
} catch (err) {
  console.error(`cannot read Cursor's hook engine: ${err.message}`);
  process.exit(2);
}
// The minified names are the bundle's own export letters; each is checked for the shape we rely on first.
const { _E: EVENTS, RV: validateConfig, jO: acceptOutput, Qk: matching } = cursor.hooks;
if (typeof EVENTS !== "object" || typeof validateConfig !== "function" || typeof acceptOutput !== "function" || typeof matching !== "function") {
  console.error("this bundle's hooks module does not have the exports this check was written against; re-derive them");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });

// 1-2. The file connect writes.
const plan = planSessionHooks({ home: "/nonexistent-home", client: "cursor", awarenessPath: "/b/opencadre-awareness.mjs", gatePath: "/b/opencadre-approval-gate.mjs", stampPath: "/b/opencadre-session-stamp.mjs" });
const config = JSON.parse(plan.after);
const valid = validateConfig(config);
check("hooks.json passes Cursor's config validator", valid.isValid, valid.errors?.join("; "));
const known = new Set(Object.values(EVENTS));
for (const event of Object.keys(config.hooks)) check(`Cursor fires "${event}"`, known.has(event));

// 3. The stamp's matcher, through Cursor's own filter.
const pre = config.hooks.preToolUse;
check("the stamp runs for an OpenCadre call (MCP:opencadre_set_status)", matching(pre, "MCP:opencadre_set_status").length === 1);
check("the stamp does not run for ANOTHER server's same-named tool (MCP:send_message)", matching(pre, "MCP:send_message").length === 0);
check("the stamp does not run for the shell tool", matching(pre, "Shell").length === 0);
check("the stamp does not run for a file read", matching(pre, "Read").length === 0);

// 4-5. Each answer, through the validator + transform Cursor applies to a hook's JSON, with the options the CLI
// ships with (`enableClaudeNestedHookSpecificOutputCompatibility: true` in its three entry points).
const SHIPPED = { enableClaudeNestedHookSpecificOutputCompatibility: true };
const accept = (step, text) => acceptOutput(step, JSON.parse(text), SHIPPED);
const gateDeny = accept("beforeShellExecution", permissionOutput("cursor", "deny", "held by OpenCadre"));
check("gate deny -> permission: deny", gateDeny.success && gateDeny.data.permission === "deny" && gateDeny.data.user_message === "held by OpenCadre");
const gateAllow = accept("beforeShellExecution", permissionOutput("cursor", "allow", "approved by Operator", { byPerson: true }));
check("gate approval -> permission: allow", gateAllow.success && gateAllow.data.permission === "allow");
const gatePolicy = accept("beforeShellExecution", permissionOutput("cursor", "allow", "onTimeout allow"));
check("gate policy allow -> no permission (Cursor's own approval stands)", gatePolicy.success && gatePolicy.data.permission === undefined);
const stamp = accept("preToolUse", updatedInputOutput("cursor", { _opencadre_stamp: mintStamp("dev_" + "0".repeat(48), "c") }));
check("stamp -> updated_input, no permission", stamp.success && stamp.data.updated_input?._opencadre_stamp?.sid === "c" && stamp.data.permission === undefined);
for (const step of ["sessionStart", "beforeSubmitPrompt", "postToolUse"]) {
  const ctx = accept(step, contextOutput("cursor", "SessionStart", "You are Cursor-X"));
  check(`awareness on ${step} -> additional_context`, ctx.success && ctx.data.additional_context === "You are Cursor-X");
}
const mail = accept("stop", followupOutput("cursor", "You have 1 unread OpenCadre message(s)."));
check("mail at stop -> followup_message", mail.success && mail.data.followup_message === "You have 1 unread OpenCadre message(s).");
for (const step of ["sessionStart", "beforeSubmitPrompt", "postToolUse", "stop", "preToolUse", "beforeShellExecution"]) {
  const quiet = accept(step, silenceFor("cursor"));
  check(`"{}" on ${step} is valid and decides nothing`, quiet.success && quiet.data.permission === undefined && quiet.data.followup_message === undefined);
}
// The Claude Code copy of the gate, which Cursor also runs, IS honoured as shipped (nested compat on). That is why
// that copy stands down only where Cursor's own gate is installed: elsewhere it is the only gate a Cursor chat has.
const nested = acceptOutput("preToolUse", JSON.parse(permissionOutput("claude-code", "deny", "x")), SHIPPED);
check("a Claude Code gate deny is a Cursor deny as shipped (nested compat on)", nested.success && nested.data.permission === "deny");
// CONTROL: with compat off the same answer decides nothing, so our Cursor copy answers in Cursor's own fields.
const nestedOff = acceptOutput("preToolUse", JSON.parse(permissionOutput("claude-code", "deny", "x")), {});
check("CONTROL: with compat off, a nested Claude answer is not a Cursor deny", !(nestedOff.success && nestedOff.data.permission === "deny"));

const failed = results.filter((r) => !r.ok);
console.log(`Cursor hook engine ${cursor.version}: ${results.length - failed.length}/${results.length} checks hold`);
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${!r.ok && r.detail ? ` (${r.detail})` : ""}`);
process.exit(failed.length ? 1 : 0);
