// A static scan of product source: every child_process call must pass `windowsHide: true` in a form this scan can PROVE,
// and anything it cannot prove is a finding. It fails closed by construction.
//
// Why the rule exists: on Windows, a console child started WITHOUT windowsHide by a parent that has no console of its
// own can open a terminal window that is then hidden, leaving a stale Alt-Tab entry. That window behaviour was observed
// natively, and its receipt lives separately in B:\ai-work\temp\9d1f-ghost-windows\. Neither this scan nor
// tests/product-spawn-windows-hide.test.ts observes Windows: the runtime suite RECORDS the options a script passes to
// child_process, and this scan reads them from source. Neither proves that Windows or Explorer shows no window or Alt-Tab
// entry, and neither covers what a child's own descendants start or what the client harness that runs our hooks does.
//
// Accepted as hidden, and nothing else:
//   - a DIRECT call of a child_process spawner (spawn, spawnSync, execFile, execFileSync, exec, execSync, fork), named by
//     an import or a destructured require/dynamic import of child_process (`import { spawn as sp }`,
//     `const { spawn } = require(...)`), or as a member of the module object (`cp.spawn(...)`,
//     `require("child_process").spawn(...)`);
//   - whose args (for every spawner but exec/execSync) are an array literal, `null`, `void 0`, or absent, so an object
//     there cannot silently become the options (the identifier `undefined` is refused: it can be shadowed);
//   - and whose options argument is an INLINE object literal holding exactly one property keyed `windowsHide`, written as
//     a plain identifier key with the literal `true`, with no spread after it, no computed key and no get/set accessor
//     anywhere in that literal. Spreads before it, and nested objects inside other values, are fine.
// Everything else is a finding: options from a variable (even a const), a parameter or a call; a spawner (or the module
// object) used any way but as the callee of a direct call - an alias, a parameter default, an object or array literal,
// an argument, a return, an export, `typeof`, `.call`; a computed member of the module (`cp["spawn"]`); a spawner name
// read as a member of any other object (`deps.spawn(...)`, `o["spawn"]`); a re-export; createRequire; process-starting
// modules it does not model (execa, cross-spawn, node-pty, zx); ANY reference to Bun or Deno (plain, optional, computed,
// aliased, a member of globalThis); a binding/_linkedBinding/dlopen member of anything; `process` used other than as
// `process.<name>` or `process?.<name>` (aliased, destructured, computed, or qualified as globalThis.process and the
// like); and the process module in any form but the exact default import `import process from "node:process"`. String, template and identifier escapes (u-escapes in both forms, x-escapes,
// legacy octal such as the one spelling "_" as 137) are decoded before names are matched.
//
// Dependency injection needs no exemption: a file wraps its spawner in a local function whose one direct call is proven
// hidden (`function hiddenSpawn(c, a, o) { return spawn(c, [...a], { ...o, windowsHide: true }); }`) and makes THAT the
// injectable default. A test may inject a mock; product code cannot hand a raw spawner anywhere without a finding in the
// file that names child_process.
//
// One narrow, named exemption: a `.exec` member read on a non-module object is not flagged, because RegExp#exec is
// everywhere. A child_process exec can reach another object only through a flow, which is a finding where the module is
// named.
//
// What it cannot see: a module name built at runtime ("child" + "_process"), and processes started other than through
// child_process (a .cmd/.sh the CLI writes, a scheduled task, the agent harness running our hooks). Names are matched per
// file, not per scope: a local that shadows a spawner's name is checked as if it were the spawner (a false alarm, never a
// miss).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SPAWNERS = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"] as const;
export type SpawnerName = (typeof SPAWNERS)[number];

const CP_MODULES = new Set(["child_process", "node:child_process"]);
/** Process-starting modules the scan does not model: importing one is a finding. */
const UNMODELLED_MODULES = new Set([
  "execa", "cross-spawn", "node-pty", "@lydell/node-pty", "zx", "shelljs", "tinyexec", "nano-spawn", "@npmcli/promise-spawn",
  "child-process-promise", "spawn-sync", "bun", "node:cluster", "cluster",
]);
/** Spawner names flagged when read as a member of something other than the module. `exec` is exempt: RegExp#exec. */
const MEMBER_FLAGGED = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "execSync", "fork"]);
/** Native entry points that can start a process without child_process: flagged as a member of anything. */
const NATIVE_MEMBERS = new Set(["binding", "_linkedBinding", "dlopen"]);
const PROCESS_MODULES = new Set(["process", "node:process"]);

type Tok = { t: "id" | "str" | "tpl" | "num" | "re" | "p"; v: string; line: number };

export type SpawnCall = {
  file: string;
  line: number;
  fn: SpawnerName;
  /** The name the call is made through (spawn, sp, cp.spawn, ...). */
  via: string;
  /** Source text of the first argument, compacted. */
  command: string;
  windowsHide: boolean;
  detached: boolean;
  /** Why the call does not pass, or null when it passes `windowsHide: true` in an accepted form. */
  problem: string | null;
};
export type Finding = { file: string; line: number; message: string };
export type ScanResult = { calls: SpawnCall[]; findings: Finding[] };

const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const PUNCT = ["...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**"];
const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

/** Decode the escape at src[i] === "\\": [decoded text, index after it]. */
function readEscape(src: string, i: number): [string, number] {
  const c = src[i + 1] ?? "";
  if (c === "u" && src[i + 2] === "{") {
    const end = src.indexOf("}", i + 3);
    const cp = parseInt(src.slice(i + 3, end), 16);
    return [Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : "", end < 0 ? src.length : end + 1];
  }
  if (c === "u") return [String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)), i + 6];
  if (c === "x") return [String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)), i + 4];
  if (c === "\r" && src[i + 2] === "\n") return ["", i + 3];
  if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") return ["", i + 2];
  // Legacy octal, legal in sloppy-mode scripts: up to three digits while the value stays within 0o377.
  if (/[0-7]/.test(c)) {
    let j = i + 1;
    let digits = "";
    while (j < src.length && digits.length < 3 && /[0-7]/.test(src[j]) && parseInt(digits + src[j], 8) <= 0o377) digits += src[j++];
    return [String.fromCharCode(parseInt(digits, 8)), j];
  }
  if (c in SIMPLE_ESCAPES) return [SIMPLE_ESCAPES[c], i + 2];
  return [c, i + 2];
}

/** Tokens of JS/TS source with comments dropped; strings, templates and identifiers carry their DECODED text. */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  // Each entry is the brace depth at which a template's `${` opened.
  const tplStack: number[] = [];
  let braceDepth = 0;
  if (src.startsWith("#!")) while (i < n && src[i] !== "\n") i++;
  const regexAllowed = () => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.t === "num" || p.t === "str" || p.t === "tpl" || p.t === "re") return false;
    if (p.t === "id") return KEYWORDS_BEFORE_REGEX.has(p.v);
    return !(p.v === ")" || p.v === "]" || p.v === "}");
  };
  const countLines = (from: number, to: number) => { for (let k = from; k < to; k++) if (src[k] === "\n") line++; };
  const readTemplate = (startLine: number) => {
    // i is just past the opening backtick or the closing `}` of a substitution.
    let text = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") { const [d, next] = readEscape(src, i); countLines(i, next); text += d; i = next; continue; }
      if (c === "`") { i++; out.push({ t: "tpl", v: text, line: startLine }); return; }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        // A template with a substitution is never a plain module or member name: mark it so.
        out.push({ t: "tpl", v: `\u0000${text}`, line: startLine });
        tplStack.push(braceDepth);
        braceDepth++;
        return;
      }
      if (c === "\n") line++;
      text += c;
      i++;
    }
  };
  const identStart = (k: number) => /[A-Za-z_$#\u0080-\uFFFF]/.test(src[k]) || (src[k] === "\\" && src[k + 1] === "u");
  const identPart = (k: number) => /[\w$\u0080-\uFFFF]/.test(src[k]) || (src[k] === "\\" && src[k + 1] === "u");
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === "\uFEFF" || c === "\u00A0" || c === "\u2028" || c === "\u2029") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      countLines(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      const startLine = line;
      let j = i + 1;
      let text = "";
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") { const [d, next] = readEscape(src, j); countLines(j, next); text += d; j = next; continue; }
        if (src[j] === "\n") break;
        text += src[j];
        j++;
      }
      out.push({ t: "str", v: text, line: startLine });
      i = j + 1;
      continue;
    }
    if (c === "`") { i++; readTemplate(line); continue; }
    if (c === "}" && tplStack.length > 0 && tplStack[tplStack.length - 1] === braceDepth - 1) {
      tplStack.pop();
      braceDepth--;
      i++;
      readTemplate(line);
      continue;
    }
    if (c === "/" && regexAllowed()) {
      const startLine = line;
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      out.push({ t: "re", v: src.slice(i, j), line: startLine });
      i = j;
      continue;
    }
    if (identStart(i)) {
      let text = "";
      let j = i;
      while (j < n && (j === i ? identStart(j) : identPart(j))) {
        if (src[j] === "\\") { const [d, next] = readEscape(src, j); text += d; j = next; } else { text += src[j]; j++; }
      }
      out.push({ t: "id", v: text, line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      out.push({ t: "num", v: src.slice(i, j), line });
      i = j;
      continue;
    }
    const multi = PUNCT.find((p) => src.startsWith(p, i));
    const v = multi ?? c;
    if (v === "{") braceDepth++;
    else if (v === "}") braceDepth--;
    out.push({ t: "p", v, line });
    i += v.length;
  }
  return out;
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
/** Index of the bracket that closes the one at `at`, or toks.length. */
function closeOf(toks: Tok[], at: number): number {
  let depth = 0;
  for (let k = at; k < toks.length; k++) {
    const v = toks[k].t === "p" ? toks[k].v : "";
    if (v in OPEN) depth++;
    else if (v === ")" || v === "]" || v === "}") { depth--; if (depth === 0) return k; }
  }
  return toks.length;
}
/** Index of the bracket that opens the one closing at `at`, or -1. */
function openOf(toks: Tok[], at: number): number {
  let depth = 0;
  for (let k = at; k >= 0; k--) {
    const v = toks[k].t === "p" ? toks[k].v : "";
    if (v === ")" || v === "]" || v === "}") depth++;
    else if (v in OPEN) { depth--; if (depth === 0) return k; }
  }
  return -1;
}
/** Top-level comma-separated [start, end] token ranges between the bracket at `open` and its close. */
function splitArgs(toks: Tok[], open: number): Array<[number, number]> {
  const close = closeOf(toks, open);
  const parts: Array<[number, number]> = [];
  let start = open + 1;
  let depth = 0;
  for (let k = open + 1; k < close; k++) {
    const v = toks[k].t === "p" ? toks[k].v : "";
    if (v in OPEN) depth++;
    else if (v === ")" || v === "]" || v === "}") depth--;
    else if (v === "," && depth === 0) { parts.push([start, k - 1]); start = k + 1; }
  }
  if (start <= close - 1) parts.push([start, close - 1]);
  return parts;
}

const isP = (t: Tok | undefined, v: string) => !!t && t.t === "p" && t.v === v;
const isId = (t: Tok | undefined, v?: string) => !!t && t.t === "id" && (v === undefined || t.v === v);
const staticString = (t: Tok | undefined) => (t && (t.t === "str" || (t.t === "tpl" && !t.v.startsWith("\u0000"))) ? t.v : null);
const asSpawner = (v: string): SpawnerName | null => ((SPAWNERS as readonly string[]).includes(v) ? (v as SpawnerName) : null);
const DECLARE = /^(const|let|var)$/;
const KEYWORD_BEFORE_ARRAY = new Set(["return", "typeof", "case", "in", "of", "yield", "await", "void", "delete", "throw", "new", "else", "do"]);

/** The bindings of an object pattern `{ a, b: c, d = x }` opening at `open`, as [property, local], or null. */
function patternBindings(toks: Tok[], open: number): Array<[string, string]> | null {
  const out: Array<[string, string]> = [];
  for (const [s, e] of splitArgs(toks, open)) {
    if (s > e) continue;
    const key = toks[s];
    const name = isId(key) ? key.v : staticString(key);
    if (name === null) return null;
    if (isId(key) && (s === e || isP(toks[s + 1], "="))) out.push([name, name]);
    else if (isP(toks[s + 1], ":") && isId(toks[s + 2])) out.push([name, toks[s + 2].v]);
    else return null;
  }
  return out;
}

type Options = { windowsHide: boolean; detached: boolean; problem: string | null };
/** Check an inline options literal opening at `open` against the accepted form. */
function readOptions(toks: Tok[], open: number): Options {
  let hideKeys = 0;
  let plainHide = false;
  let detached = false;
  let problem: string | null = null;
  for (const [s, e] of splitArgs(toks, open)) {
    if (s > e) continue;
    const first = toks[s];
    if (isP(first, "...")) { if (hideKeys > 0) problem ??= "a spread after windowsHide may override it"; continue; }
    if (isP(first, "[")) { problem ??= "a computed key in the options literal"; continue; }
    // `get x()` / `set x(v)` is an accessor; `get: 1`, a shorthand `get` and a method `get() {}` are not.
    if (isId(first) && (first.v === "get" || first.v === "set") && s !== e && !isP(toks[s + 1], ":") && !isP(toks[s + 1], "(")) {
      problem ??= "an accessor in the options literal";
      continue;
    }
    let k = s;
    while (isId(toks[k], "async") || isP(toks[k], "*")) k++;
    const key = isId(toks[k]) ? toks[k].v : staticString(toks[k]) ?? (toks[k]?.t === "num" ? toks[k].v : null);
    if (key === "windowsHide") {
      hideKeys++;
      if (isId(toks[k]) && k === s && e === s + 2 && isP(toks[s + 1], ":") && isId(toks[s + 2], "true")) plainHide = true;
      else problem ??= "windowsHide is not written as `windowsHide: true`";
    }
    if (key === "detached" && e === s + 2 && isP(toks[s + 1], ":") && isId(toks[s + 2], "true")) detached = true;
  }
  if (hideKeys > 1) problem ??= "windowsHide is given more than once";
  if (hideKeys === 0) problem ??= "options lack `windowsHide: true`";
  const windowsHide = problem === null && plainHide;
  return { windowsHide, detached, problem: windowsHide ? null : problem ?? "options lack `windowsHide: true`" };
}

export function scanSource(src: string, file: string): ScanResult {
  const toks = tokenize(src);
  const findings: Finding[] = [];
  const calls: SpawnCall[] = [];
  const find = (k: number, message: string) => findings.push({ file, line: toks[Math.min(k, toks.length - 1)]?.line ?? 0, message });

  // Local name -> the spawner it was bound to from the module; names bound to the whole module object.
  const spawnerOf = new Map<string, SpawnerName>();
  const moduleAliases = new Set<string>();
  // Token indexes inside a binding declaration, which the use-walk skips.
  const declared = new Set<number>();
  // `require("child_process").spawn`: the index of `spawn`, a spawner use resolved at binding time.
  const directMembers = new Set<number>();

  for (let k = 0; k < toks.length; k++) {
    const mod = staticString(toks[k]);
    if (mod !== null && UNMODELLED_MODULES.has(mod) && (isP(toks[k - 1], "(") || isId(toks[k - 1], "from") || isId(toks[k - 1], "import"))) {
      find(k, `imports "${mod}", a process-starting module this guard does not model`);
      continue;
    }
    // The process module: the ONE accepted form is the exact default import `import process from "node:process"` (or
    // "process"), binding the name `process`, whose uses are then checked like the global's. Any other import, any
    // require or dynamic import, re-export or destructuring of it is a finding: a native entry point could leave unseen.
    // "process" is also an ordinary word in data, so only a module position counts: `from "process"`, a side-effect
    // `import "process"`, or a call whose sole argument it is (require, import(), a createRequire result, any loader).
    const modulePosition = isId(toks[k - 1], "from") || isId(toks[k - 1], "import") || (isP(toks[k - 1], "(") && isP(toks[k + 1], ")"));
    if (mod !== null && PROCESS_MODULES.has(mod) && modulePosition) {
      const exactDefault = isId(toks[k - 1], "from") && isId(toks[k - 2], "process") && isId(toks[k - 3], "import");
      if (!exactDefault) find(k, `uses the ${mod} module other than as \`import process from "${mod}"\`; the guard cannot follow it`);
      continue;
    }
    if (mod === null || !CP_MODULES.has(mod)) continue;
    // import ... from "child_process"
    if (isId(toks[k - 1], "from")) {
      let s = k - 2;
      while (s >= 0 && !isId(toks[s], "import") && !isId(toks[s], "export") && !isP(toks[s], ";")) s--;
      if (!isId(toks[s], "import")) { find(k, "re-exports child_process; the guard cannot follow callers in other files"); continue; }
      if (isId(toks[s + 1], "type") && !isP(toks[s + 2], ",") && !isId(toks[s + 2], "from")) continue; // types only
      for (let j = s + 1; j < k - 1; j++) {
        declared.add(j);
        if (isP(toks[j], "*") && isId(toks[j + 1], "as") && isId(toks[j + 2])) { moduleAliases.add(toks[j + 2].v); declared.add(j + 1); declared.add(j + 2); j += 2; }
        else if (isP(toks[j], "{")) {
          const close = closeOf(toks, j);
          for (const [s2, e2] of splitArgs(toks, j)) {
            if (s2 > e2) continue;
            const imported = isId(toks[s2]) ? toks[s2].v : staticString(toks[s2]) ?? "";
            const local = isId(toks[s2 + 1], "as") ? toks[s2 + 2].v : imported;
            if (imported === "default") moduleAliases.add(local);
            const sp = asSpawner(imported);
            if (sp) spawnerOf.set(local, sp);
          }
          for (let q = j; q <= close; q++) declared.add(q);
          j = close;
        } else if (isId(toks[j]) && toks[j].v !== "type") moduleAliases.add(toks[j].v);
      }
      continue;
    }
    // require("child_process") / import("child_process")
    if (isP(toks[k - 1], "(") && (isId(toks[k - 2], "require") || isId(toks[k - 2], "import")) && isP(toks[k + 1], ")") && !isP(toks[k - 3], ".")) {
      const after = k + 2;
      if ((isP(toks[after], ".") || isP(toks[after], "?.")) && isId(toks[after + 1])) {
        if (asSpawner(toks[after + 1].v)) directMembers.add(after + 1);
        else if (toks[after + 1].v === "default") find(after + 1, "reaches child_process through .default, which the guard does not follow");
        continue;
      }
      let b = k - 3;
      if (isId(toks[b], "await")) b--;
      if (isP(toks[b], "=") && isId(toks[b - 1]) && DECLARE.test(toks[b - 2]?.v ?? "")) { moduleAliases.add(toks[b - 1].v); declared.add(b - 1); continue; }
      if (isP(toks[b], "=") && isP(toks[b - 1], "}")) {
        const open = openOf(toks, b - 1);
        const binds = open >= 0 && DECLARE.test(toks[open - 1]?.v ?? "") ? patternBindings(toks, open) : null;
        if (binds) {
          for (const [prop, local] of binds) {
            if (prop === "default") moduleAliases.add(local);
            const sp = asSpawner(prop);
            if (sp) spawnerOf.set(local, sp);
          }
          for (let q = open; q <= b - 1; q++) declared.add(q);
          continue;
        }
      }
      find(k, "loads child_process in a form the guard does not follow");
      continue;
    }
    if (isId(toks[k - 1], "import") && (isP(toks[k + 1], ";") || toks[k + 1] === undefined || toks[k + 1].line > toks[k].line)) continue; // side-effect import
    find(k, "names child_process in a form the guard does not follow");
  }

  // Unmodelled runtimes and native entry points that can start processes, failing closed: any reference to Bun or Deno,
  // any binding/_linkedBinding/dlopen member of anything, and `process` used other than as `process.<name>`.
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.t !== "id") continue;
    const memberRead = isP(toks[k - 1], ".") || isP(toks[k - 1], "?.");
    if (!memberRead && isP(toks[k + 1], ":") && (isP(toks[k - 1], "{") || isP(toks[k - 1], ","))) continue; // an object key
    if (tok.v === "Bun" || tok.v === "Deno") { find(k, `references ${tok.v}, a runtime whose process APIs this guard does not model`); continue; }
    if (memberRead && NATIVE_MEMBERS.has(tok.v)) { find(k, `reads .${tok.v}, a native entry point this guard does not model`); continue; }
    // globalThis.process, global.process, self.process, x?.process: any qualified access to process.
    if (memberRead && tok.v === "process") { find(k, "reaches process as a member of another object; the guard cannot follow it"); continue; }
    // `import process from "node:process"` declares the name; its uses are then checked like the global's.
    if (tok.v === "process" && isId(toks[k - 1], "import") && isId(toks[k + 1], "from") && PROCESS_MODULES.has(staticString(toks[k + 2]) ?? "")) continue;
    if (tok.v === "process" && !memberRead && !((isP(toks[k + 1], ".") || isP(toks[k + 1], "?.")) && isId(toks[k + 2]))) {
      find(k, "uses process other than as process.<name>, so a native entry point could be reached unseen");
    }
  }

  const text = (r: [number, number] | undefined) => (r ? toks.slice(r[0], r[1] + 1).map((t) => (t.t === "str" ? JSON.stringify(t.v) : t.t === "tpl" ? "`...`" : t.v)).join(" ") : "");
  const kind = (r: [number, number] | undefined) => {
    if (!r) return "none";
    const first = toks[r[0]];
    // Only `null` and `void 0` are certainly not an object. The identifier `undefined` can be shadowed (a parameter or a
    // local named undefined), and Node reads an object in the args slot as the options, so it is not accepted.
    if (r[0] === r[1] && isId(first, "null")) return "nullish";
    if (r[1] === r[0] + 1 && isId(first, "void") && toks[r[1]].t === "num" && toks[r[1]].v === "0") return "nullish";
    if (isP(first, "[") && closeOf(toks, r[0]) === r[1]) return "array";
    if (isP(first, "{") && closeOf(toks, r[0]) === r[1]) return "object";
    return "other";
  };
  /** A direct spawner call whose argument list opens at `open`: check it against the accepted form. */
  const onCall = (start: number, open: number, fn: SpawnerName, via: string) => {
    const args = splitArgs(toks, open);
    let slot: number | null = null;
    let problem: string | null = null;
    if (args.some(([s]) => isP(toks[s], "..."))) problem = "spreads its arguments, so the options cannot be read";
    if (fn === "exec" || fn === "execSync") slot = args.length > 1 ? 1 : null;
    else {
      const k1 = kind(args[1]);
      if (k1 === "array" || k1 === "nullish") slot = args.length > 2 ? 2 : null;
      else if (k1 === "object") slot = 1;
      else if (k1 === "other") problem ??= `args \`${text(args[1])}\` are not an array literal, so an object there would be read as the options`;
    }
    let windowsHide = false;
    let detached = false;
    const opt = slot === null ? undefined : args[slot];
    if (problem === null) {
      if (opt === undefined) problem = "passes no options, so no windowsHide";
      else if (kind(opt) !== "object") problem = `options \`${text(opt)}\` are not an inline object literal`;
      else ({ windowsHide, detached, problem } = readOptions(toks, opt[0]));
    }
    calls.push({ file, line: toks[start].line, fn, via, command: text(args[0]).slice(0, 80), windowsHide, detached, problem });
  };
  const flow = (k: number, what: string) =>
    find(k, `${what} is used other than as the callee of a direct call (alias, default, value passed, stored or returned); the guard cannot prove its calls hidden`);

  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (directMembers.has(k)) {
      const sp = asSpawner(tok.v)!;
      if (isP(toks[k + 1], "(")) onCall(k - 5, k + 1, sp, `require(child_process).${sp}`);
      else flow(k, `require(child_process).${sp}`);
      continue;
    }
    if (declared.has(k) || tok.t !== "id") continue;
    if (isP(toks[k - 1], ".") || isP(toks[k - 1], "?.")) {
      // A spawner name read as a member of something that is not the module object (module members are consumed below).
      if (MEMBER_FLAGGED.has(tok.v) && !isId(toks[k - 2], "Bun")) {
        find(k, `reads .${tok.v} from an object that is not the child_process module; the guard cannot prove that call hidden`);
      }
      continue;
    }
    const name = tok.v;
    if (moduleAliases.has(name)) {
      if ((isP(toks[k + 1], ".") || isP(toks[k + 1], "?.")) && isId(toks[k + 2])) {
        const member = toks[k + 2].v;
        const sp = asSpawner(member);
        if (sp) {
          const open = isP(toks[k + 3], "(") ? k + 3 : isP(toks[k + 3], "?.") && isP(toks[k + 4], "(") ? k + 4 : -1;
          if (open > 0) onCall(k, open, sp, `${name}.${sp}`);
          else flow(k, `${name}.${sp}`);
        } else if (member === "default") find(k, `${name}.default reaches child_process by a path the guard does not follow`);
        k += 2; // the member token is consumed here, so it is not read as a member of some other object
        continue;
      }
      if (isP(toks[k + 1], "[")) { find(k, `${name}[...] reaches child_process by a computed member`); continue; }
      flow(k, `the child_process module (${name})`);
      continue;
    }
    const sp = spawnerOf.get(name);
    if (!sp) continue;
    // A key in an object literal or pattern (`{ spawn: x }`) names a property, not this binding.
    if (isP(toks[k + 1], ":") && (isP(toks[k - 1], "{") || isP(toks[k - 1], ","))) continue;
    if (isP(toks[k + 1], "(")) onCall(k, k + 1, sp, name);
    else flow(k, name);
  }
  // Computed member reads of a spawner name from any object: o["spawn"], cp["sp\u0061wn"].
  for (let k = 1; k + 2 < toks.length; k++) {
    const name = staticString(toks[k + 1]);
    const flagged = name !== null && (MEMBER_FLAGGED.has(name) || NATIVE_MEMBERS.has(name) || name === "Bun" || name === "Deno" || name === "process");
    if (!isP(toks[k], "[") || !flagged || !isP(toks[k + 2], "]")) continue;
    const prev = toks[k - 1];
    const indexes = (prev.t === "id" && !KEYWORD_BEFORE_ARRAY.has(prev.v)) || isP(prev, ")") || isP(prev, "]") || isP(prev, "?.");
    if (indexes) find(k, `reads ["${name}"] by a computed member; the guard cannot prove that call hidden`);
  }
  for (const c of calls) if (c.problem) findings.push({ file, line: c.line, message: `${c.via}(${c.command}) ${c.problem}` });
  findings.sort((a, b) => a.line - b.line);
  return { calls, findings };
}

// The product: what `opencadre connect` installs and runs on an agent's machine (cli/, the hook and plugin sources under
// examples/, scripts/ entry points and their imports), not the repo's own dev tooling under scripts/dev.
export const PRODUCT_ROOTS = ["cli", "examples", "scripts"] as const;
export const EXCLUDED_DIRS = ["scripts/dev", "node_modules"] as const;
const SOURCE = /\.(mjs|cjs|js|mts|cts|ts)$/;

/** Repo-relative, forward-slash paths of every product source file under `repo`. */
export function productFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(repo, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (EXCLUDED_DIRS.some((d) => child === d || child.endsWith(`/${d}`))) continue;
      if (entry.isDirectory()) walk(child);
      else if (SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(child);
    }
  };
  for (const root of PRODUCT_ROOTS) walk(root);
  return out.sort();
}

/** Scan every product file under `repo`. */
export function scanProduct(repo: string): ScanResult & { files: string[] } {
  const files = productFiles(repo);
  const calls: SpawnCall[] = [];
  const findings: Finding[] = [];
  for (const f of files) {
    const r = scanSource(readFileSync(join(repo, f), "utf8"), f);
    calls.push(...r.calls);
    findings.push(...r.findings);
  }
  return { files, calls, findings };
}
