// Preload for a product script a test runs as a child (`node --import <this file's URL> script.mjs`): appends one JSON
// line per child_process call to $SPAWN_RECORD_FILE ({ fn, file, args, windowsHide }) and then makes the call as asked,
// so a test can assert the options an unattended script passes without changing what the script does.
import cp from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const out = process.env.SPAWN_RECORD_FILE;
for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const original = cp[fn];
  cp[fn] = function (...args) {
    // The options slot, as Node reads it: after the command for exec*, else after an args array (or a null args).
    const slot = fn === "exec" || fn === "execSync" ? 1 : Array.isArray(args[1]) || (args.length > 1 && args[1] == null) ? 2 : 1;
    const opts = args[slot] && typeof args[slot] === "object" && !Array.isArray(args[slot]) ? args[slot] : {};
    const argv = Array.isArray(args[1]) ? args[1].map(String) : [];
    if (out) appendFileSync(out, `${JSON.stringify({ fn, file: String(args[0]), args: argv, windowsHide: opts.windowsHide ?? null })}\n`);
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
