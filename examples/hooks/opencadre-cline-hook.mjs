#!/usr/bin/env node
// OpenCadre for Cline's CLI. Cline runs every hook file named for an event in every hooks folder it reads
// (~/.cline/hooks/PreToolUse.mjs, PostToolUse.mjs, …); `opencadre connect` writes these two as one-line modules that
// load this file, and this file hands
// the payload to the shared hook that owns it, all speaking the `cline` dialect (scripts/opencadre-hook-dialect.mjs):
//
//   tool_call   on OpenCadre's own tools (`opencadre-session__…`)   the identity stamp (opencadre-session-stamp.mjs)
//   tool_call   on `run_commands`                                 the approval gate (opencadre-approval-gate.mjs)
//   tool_result                                                   awareness: the session's name once, then mail and
//                                                                 what changed, throttled (opencadre-awareness.mjs)
//
// Cline awaits these for 120 s and then RUNS the call, so the gate waits at most 100 s, and a gate that crashes, times
// out or answers something unreadable is turned into a deny here. Every other failure is `{}`: no opinion.
//
// A deny is normally said by replacing the command with an echo of the reason (the model reads it). But Cline runs the
// PreToolUse hook of EVERY hooks folder and the LAST `overrideInput` wins, so any other PreToolUse hook (the user's own
// in ~/Documents/Cline/Hooks, or one a repository ships in .clinerules/hooks) could put the command back (review of
// 2ff9038, B2). Where one exists, the deny is `cancel`, which Cline ORs across hooks: the run ends, the command never
// runs. Only Node built-ins are imported statically, so a helper that fails to load still ends in a deny (S2).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const SESSION_SERVER = "opencadre-session";
const GATE_KILL_MS = 110_000;

const cancel = (reason) => {
  process.stdout.write(JSON.stringify({ cancel: true, errorMessage: reason }));
  process.exit(0);
};

let raw = "";
let input;
try {
  raw = readFileSync(0, "utf8");
  input = JSON.parse(raw);
} catch {
  // A hook that cannot read what it is asked about cannot say it is safe.
  cancel("OpenCadre's Cline hook could not read this call, so the run was stopped.");
}

const quiet = () => {
  process.stdout.write("{}");
  process.exit(0);
};

/** Another PreToolUse hook Cline will also run for this call, in any hooks folder it reads (resolveHooksConfigSearchPaths
 * in @cline/shared: ~/Documents/Cline/Hooks, ~/.cline/hooks, <ws>/.clinerules/hooks, <ws>/.cline/hooks, plus
 * CLINE_HOOKS_DIR). */
function otherPreToolUseHook() {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const ws = [input?.workspaceRoots?.[0], input?.workspaceInfo?.rootPath, process.cwd()].find((d) => typeof d === "string" && d);
  const dirs = [join(home, "Documents", "Cline", "Hooks"), join(process.env.CLINE_DIR || join(home, ".cline"), "hooks"), ...(ws ? [join(ws, ".clinerules", "hooks"), join(ws, ".cline", "hooks")] : []), ...(process.env.CLINE_HOOKS_DIR ? [process.env.CLINE_HOOKS_DIR] : [])];
  for (const dir of dirs) {
    let names = [];
    try {
      names = existsSync(dir) ? readdirSync(dir) : [];
    } catch { /* unreadable folder: counted as a hook, below */ return true; }
    for (const name of names) {
      // Cline compares the name before the extension case-insensitively, over a dozen extensions (.sh, .py, .ps1, …;
      // review of 7ffc12c, S1). Any `pretooluse.<anything>` counts: a false match only turns a deny into a cancel.
      if (name.split(".")[0].trim().toLowerCase() !== "pretooluse") continue;
      let text = "";
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch { return true; }
      if (!text.includes("opencadre-cline-hook.mjs")) return true;
    }
  }
  return false;
}

const deny = async (reason) => {
  if (otherPreToolUseHook()) cancel(`${reason} (The run was stopped because another PreToolUse hook could otherwise undo this.)`);
  let said;
  try {
    said = (await import("../../scripts/opencadre-hook-dialect.mjs")).permissionOutput("cline", "deny", reason);
  } catch {
    cancel(reason);
  }
  process.stdout.write(said);
  process.exit(0);
};

/** Runs one shared hook with this payload: { code, out } (code null when it was killed). */
function run(script, killMs) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(process.execPath, [here(script), "--client", "cline"], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    } catch {
      return resolve({ code: -1, out: "" });
    }
    const timer = killMs ? setTimeout(() => child.kill("SIGKILL"), killMs) : null;
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve({ code: -1, out: "" }));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(raw);
  });
}

const readable = (out) => {
  try {
    const parsed = JSON.parse(out || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
};

const call = input?.tool_call;
if (input?.hookName === "tool_call" && typeof call?.name === "string") {
  if (call.name.startsWith(`${SESSION_SERVER}__`)) {
    const { out } = await run("opencadre-session-stamp.mjs", 20_000);
    if (readable(out)) {
      process.stdout.write(out);
      process.exit(0);
    }
    quiet();
  }
  if (call.name === "run_commands") {
    const { code, out } = await run("opencadre-approval-gate.mjs", GATE_KILL_MS);
    if (code === 0 && readable(out)) {
      const said = JSON.parse(out);
      // A deny from the gate is an echo replacement; where another hook could undo it, it becomes a cancel instead.
      if (said.overrideInput && otherPreToolUseHook()) cancel(`${typeof said.context === "string" ? said.context : "Blocked by OpenCadre."} (The run was stopped because another PreToolUse hook could otherwise undo this.)`);
      process.stdout.write(out);
      process.exit(0);
    }
    await deny("OpenCadre's approval gate could not decide this command, so it was blocked. Ask the user before trying another way.");
  }
  quiet();
}
if (input?.hookName === "tool_result") {
  const { out } = await run("opencadre-awareness.mjs", 20_000);
  if (readable(out)) {
    process.stdout.write(out);
    process.exit(0);
  }
}
quiet();
