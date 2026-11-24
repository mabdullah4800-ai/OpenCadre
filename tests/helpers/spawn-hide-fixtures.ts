// Fixtures for tests/product-spawn-static-guard.test.ts, in their own module so a receipt script can run the same
// sources against older versions of tests/helpers/spawn-hide-scan.ts.
//
// Escaped fixtures are written with "~" standing for a backslash and expanded by esc(): a literal backslash-u sequence
// in this file can be decoded by an editor or a tool before it reaches disk, which silently turns an escaped fixture into
// a plain one (it happened to the first two review fixtures at eae06a92). esc() makes the backslash survive, and the test
// asserts it did.

/** "~" -> a backslash. */
export const esc = (s: string) => s.replaceAll("~", String.fromCharCode(92));

const CP = `import { spawn } from "node:child_process";\n`;

// Olive's review of 1e684aec: 12 sources that start a child WITHOUT windowsHide (checked against a mock child_process)
// which that scan certified hidden.
export const REVIEW_1E684AEC: Array<[string, string]> = [
  ["property mutation", CP + `const opts = { windowsHide: true };\nopts.windowsHide = false;\nspawn("x", [], opts);`],
  ["binding reassignment", CP + `let opts = { windowsHide: true };\nopts = { windowsHide: false };\nspawn("x", [], opts);`],
  ["Object.assign mutation", CP + `const opts = { windowsHide: true };\nObject.assign(opts, { windowsHide: false });\nspawn("x", [], opts);`],
  ["a parameter shadowing outer options", CP + `const opts = { windowsHide: true };\nfunction run(opts) { spawn("x", [], opts); }\nrun({ windowsHide: false });`],
  ["same-name options in another function", CP + `function unused() { const opts = { windowsHide: true }; }\nfunction run(opts) { spawn("x", [], opts); }\nrun({ windowsHide: false });`],
  ["a computed duplicate key", CP + `spawn("x", [], { windowsHide: true, ["windowsHide"]: false });`],
  ["a getter duplicate key", CP + `spawn("x", [], { windowsHide: true, get windowsHide() { return false; } });`],
  ["a spawner injected under another key", CP + `function run(o) { o.launch("x", [], {}); }\nrun({ launch: spawn });`],
  ["a spawner injected by shorthand", CP + `function run(o) { o.spawn("x", [], {}); }\nrun({ spawn });`],
  ["a spawner injected, read by computed member", CP + `function run(o) { o["spawn"]("x", [], {}); }\nrun({ spawn });`],
  ["a unicode-escaped module name", esc(`import { spawn } from "node:child~u005fprocess";\nspawn("x", [], {});`)],
  ["a unicode-escaped member name", esc(`import * as cp from "node:child_process";\ncp["sp~u0061wn"]("x", [], {});`)],
];

// Olive's review of eae06a92: 10 sources that start a child without windowsHide, or reach a process API the scan does not
// model, which that scan accepted.
export const REVIEW_EAE06A92: Array<[string, string]> = [
  ["a shadowed undefined parameter", CP + `function run(undefined) { spawn("x", undefined, { windowsHide: true }); }\nrun({ windowsHide: false });`],
  ["a shadowed undefined local", CP + `{ const undefined = { windowsHide: false }; spawn("x", undefined, { windowsHide: true }); }`],
  ["Bun?.spawn", `Bun?.spawn(["x"]);`],
  ["Bun?.spawnSync", `Bun?.spawnSync(["x"]);`],
  ["Deno?.Command aliased and constructed", `const Cmd = Deno?.Command;\nnew Cmd("x");`],
  ["Deno?.run", `Deno?.run({ cmd: ["x"] });`],
  ["process?.binding", `process?.binding("spawn_sync");`],
  ["process[\"binding\"]", `process["binding"]("spawn_sync");`],
  ["Bun[\"$\"]", `Bun["$"](["x"]);`],
  ["a legacy-octal-escaped module name", esc(`const { spawn } = require("child~137process");\nspawn("x", [], {});`)],
];

// Olive's review of f97811e0: 5 native-entry flows that scan accepted with no finding.
export const REVIEW_F97811E0: Array<[string, string]> = [
  ["a quoted key destructured from require(\"node:process\")", `const { "binding": start } = require("node:process");\nstart("spawn_sync");`],
  ["a computed key destructured from require(\"node:process\")", `const { ["binding"]: start } = require("node:process");\nstart("spawn_sync");`],
  ["globalThis.process aliased, then destructured", `const proc = globalThis.process;\nconst { binding: start } = proc;\nstart("spawn_sync");`],
  ["globalThis[\"process\"] aliased, then destructured", `const proc = globalThis["process"];\nconst { binding: start } = proc;\nstart("spawn_sync");`],
  ["require(\"node:process\") aliased, then destructured", `const proc = require("node:process");\nconst { binding: start } = proc;\nstart("spawn_sync");`],
];

// Further shapes of a missing or unprovable windowsHide: each must be a finding.
export const NEGATIVES: Array<[string, string]> = [
  ["a named import, no options", CP + `spawn("x", ["a"]);`],
  ["a renamed import", `import { spawnSync as run } from "child_process";\nrun("x", [], { stdio: "ignore" });`],
  ["a namespace import", `import * as cp from "node:child_process";\ncp.execFile("x", ["a"], () => {});`],
  ["a default import, computed member", `import cp from "node:child_process";\ncp["spawn"]("x", [], { windowsHide: true });`],
  ["a destructured require", `const { execSync: ex } = require("child_process");\nex("dir");`],
  ["a require member call", `require("child_process").fork("m.js");`],
  ["a dynamic import", `const cp = await import("node:child_process");\ncp.spawn("x", [], { windowsHide: false });`],
  ["a hex-escaped module name", esc(`const { spawn } = require("child~x5fprocess");\nspawn("x");`)],
  ["a code-point-escaped module name", esc(`import { spawn } from "child~u{5f}process";\nspawn("x");`)],
  ["an escaped identifier", esc(`import { sp~u0061wn } from "node:child_process";\nsp~u{61}wn("x");`)],
  ["a two-digit octal-escaped member name", esc(`const cp = require("child_process");\ncp["sp~141wn"]("x");`)],
  ["an injected spawner's default", CP + `export function f({ spawnFn = spawn } = {}) { return spawnFn("x", ["a"], { windowsHide: true }); }`],
  ["an alias", CP + `const run = spawn;\nrun("x", [], { windowsHide: true });`],
  ["an alias through ??", `import { spawnSync } from "node:child_process";\nconst run = opts.run ?? spawnSync;\nrun("x", []);`],
  ["a spawner passed to a same-file function", CP + `function go({ s }) { return s("x", [], { windowsHide: true }); }\ngo({ s: spawn });`],
  ["a spawner in an array", CP + `const all = [spawn];`],
  ["a spawner returned", CP + `export function get() { return spawn; }`],
  ["a spawner exported", CP + `export { spawn };`],
  ["typeof a spawner", CP + `if (typeof spawn === "function") {}`],
  ["a spawner reassigned", `let { spawn } = require("child_process");\nspawn = other;`],
  ["options in a const, even unmutated", CP + `const o = { windowsHide: true };\nspawn("x", [], o);`],
  ["options from a parameter", CP + `export function f(o) { spawn("x", [], o); }`],
  ["options from a call", CP + `spawn("x", [], hidden());`],
  ["args from a variable (an object there becomes the options)", CP + `spawn("x", args, { windowsHide: true });`],
  ["args given as the identifier undefined", CP + `spawn("x", undefined, { windowsHide: true });`],
  ["spread arguments", CP + `spawn(...all);`],
  ["options with a spread after it", CP + `spawn("x", [], { windowsHide: true, ...extra });`],
  ["options with a string-keyed duplicate", CP + `spawn("x", [], { windowsHide: true, "windowsHide": false });`],
  ["options with a later shorthand duplicate", CP + `spawn("x", [], { windowsHide: true, windowsHide });`],
  ["options with a method duplicate", CP + `spawn("x", [], { windowsHide: true, windowsHide() { return false; } });`],
  ["options with only a string key", CP + `spawn("x", [], { "windowsHide": true });`],
  ["options with any computed key", CP + `spawn("x", [], { windowsHide: true, [k]: 1 });`],
  ["options with any accessor", CP + `spawn("x", [], { windowsHide: true, get cwd() { return "."; } });`],
  ["windowsHide not literally true", CP + `spawn("x", [], { windowsHide: hide });`],
  ["exec with only a callback", `import { exec } from "node:child_process";\nexec("x", (e) => {});`],
  ["promisify(execFile)", `import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst p = promisify(execFile);`],
  ["a spawner exported in an object", `const { spawn } = require("child_process");\nmodule.exports = { spawn };`],
  ["a spawner handed to an imported function", CP + `import { run } from "./x.mjs";\nrun({ spawn });`],
  ["a computed module member", `import * as cp from "node:child_process";\ncp[name]("x");`],
  ["the module object passed on", `import * as cp from "node:child_process";\nuse(cp);`],
  ["a spawner read through a non-module object", `export function f(deps) { deps.spawnSync("x", [], { windowsHide: true }); }`],
  ["a re-export", `export { spawn } from "node:child_process";`],
  ["createRequire", `const req = createRequire(import.meta.url);\nconst cp = req("node:child_process");`],
  ["execa", `import { execa } from "execa";\nawait execa("x");`],
  ["Bun.spawn", `Bun.spawn(["x"]);`],
  ["globalThis.Bun", `globalThis.Bun.spawn(["x"]);`],
  ["globalThis[\"Deno\"]", `globalThis["Deno"].run({ cmd: ["x"] });`],
  ["process aliased", `const p = process;\np.binding("spawn_sync");`],
  ["process destructured", `const { binding } = process;\nbinding("spawn_sync");`],
  ["process._linkedBinding", `process._linkedBinding("spawn_sync");`],
  ["process.dlopen", `process.dlopen(m, "x.node");`],
  ["binding imported from node:process", `import { binding } from "node:process";\nbinding("spawn_sync");`],
  ["dlopen destructured from require(\"process\")", `const { dlopen } = require("process");`],
  ["an imported process aliased", `import process from "node:process";\nconst p = process;`],
  ["require(\"process\") with only a harmless member", `const env = require("process").env;`],
  ["a dynamic import of node:process", `const p = await import("node:process");`],
  ["a namespace import of node:process", `import * as proc from "node:process";\nproc.env;`],
  ["a named import from process", `import { env } from "process";`],
  ["a default import under another name", `import proc from "node:process";\nproc.env;`],
  ["a default plus named import", `import process, { env } from "node:process";`],
  ["a re-export of node:process", `export { binding } from "node:process";`],
  ["process destructured, even harmlessly", `const { env } = process;`],
  ["node:process through a createRequire result", `const req = createRequire(import.meta.url);\nconst p = req("node:process");`],
  ["global.process", `global.process.env;`],
  ["self.process", `self.process.env;`],
  ["globalThis?.process", `globalThis?.process.env;`],
  ["globalThis[\"process\"] read", `globalThis["process"].env;`],
];

// The forms the scan accepts as hidden: [name, source, number of calls it must count].
export const POSITIVES: Array<[string, string, number]> = [
  ["spawn", CP + `spawn("x", ["a"], { stdio: "ignore", windowsHide: true });`, 1],
  ["every spawner, inline literal", `import { spawn, spawnSync, execFile, execFileSync, exec, execSync, fork } from "node:child_process";\n`
    + `spawn("x", [], { windowsHide: true });\nspawnSync("x", [], { windowsHide: true });\nexecFile("x", [], { windowsHide: true }, () => {});\n`
    + `execFileSync("x", [], { windowsHide: true });\nexec("x", { windowsHide: true }, () => {});\nexecSync("x", { windowsHide: true });\n`
    + `fork("m.js", [], { windowsHide: true });`, 7],
  ["args omitted", `import { spawnSync as run } from "child_process";\nrun("x", { windowsHide: true });`, 1],
  ["args as a spread array literal", CP + `spawn("x", [...args], { windowsHide: true });`, 1],
  ["args null", CP + `spawn("x", null, { windowsHide: true });`, 1],
  ["args void 0", CP + `spawn("x", void 0, { windowsHide: true });`, 1],
  ["a spread before it, and nested objects", CP + `spawn("x", [], { ...base, env: { ...process.env, A: "1" }, windowsHide: true, detached: true });`, 1],
  ["an ordinary key named get", CP + `spawn("x", [], { get: 1, windowsHide: true });`, 1],
  ["a namespace import", `import * as cp from "node:child_process";\ncp.execFile("x", ["a"], { windowsHide: true }, () => {});`, 1],
  ["a default import", `import cp from "child_process";\ncp.spawnSync("x", [], { windowsHide: true });`, 1],
  ["a destructured require", `const { execSync: ex } = require("child_process");\nex("dir", { windowsHide: true });`, 1],
  ["a whole-module require", `const cp = require("node:child_process");\ncp.fork("m.js", { windowsHide: true });`, 1],
  ["a require member call", `require("child_process").spawn("x", [], { windowsHide: true });`, 1],
  ["a dynamic import", `const { spawn } = await import("node:child_process");\nspawn("x", [], { windowsHide: true });`, 1],
  ["an escaped module name, decoded and then checked", esc(`const { spawn } = require("child~137process");\nspawn("x", [], { windowsHide: true });`), 1],
  ["a non-spawner member of the module", `import * as cp from "node:child_process";\nconst C = cp.ChildProcess;`, 0],
  ["plain process.<name> reads", `const e = process.env.X ?? process.execPath;\nprocess?.exit(0);`, 0],
  ["process imported from node:process and read by member", `import process from "node:process";\nconst e = process.env.X;`, 0],
  ["process imported from \"process\" exactly", `import process from "process";\nprocess.exitCode = 0;`, 0],
  ["the word process as data", `const m = { from: "process", mode: "process" };\nif (m.from === "process") add("process", 1);`, 0],
  ["a per-file wrapper for injection (the product's pattern)", CP
    + `function hiddenSpawn(command, args, options) { return spawn(command, [...args], { ...options, windowsHide: true }); }\n`
    + `export function f({ spawnImpl = hiddenSpawn } = {}) { return spawnImpl("x", []); }`, 1],
  ["mentions in comments, strings and regexes are not calls", `import { spawn, spawnSync, exec } from "node:child_process";\n// spawn("x") Bun.spawn\n/* exec("y") */\n`
    + `const s = "spawnSync(y) Deno.run";\nconst t = \`exec(\${z})\`;\nconst r = /spawn\\(/;\nr.exec("q");`, 0],
];
