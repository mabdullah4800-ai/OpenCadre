// What one installed helper loads, exports and spawns, read from its TEXT. Pure (no fs, no process), node builtins only,
// so both the packer (scripts/cli-build-info.mjs, which writes build.json `imports`) and the installer
// (cli/lib/generations.mjs, which validates a staged generation and inventories cross-entry edges) use ONE definition.
// Moved here from scripts/cli-build-info.mjs, which re-exports these names unchanged: the packed CLI carries cli/lib but
// not scripts/, and the installer must parse exactly as the packer did.

import { posix } from "node:path";

// Every relative specifier a module loads: `import x from "./a"`, `export { y } from "./b"`, `import "./c"` and
// `import("./d")` with a string literal. A specifier built at run time (a template, a variable, `new URL(...)`) is not a
// literal and is not seen: that is a limit of parsing, stated rather than hidden. Those run-time paths are what
// `spawnTargets` and `absoluteInstallRootRefs` below exist to find instead.
const IMPORT_PATTERNS = [
  /\bfrom\s*(["'])([^"'\r\n]+)\1/g,
  /\bimport\s*\(\s*(["'])([^"'\r\n]+)\1\s*\)/g,
  /(?:^|[;\r\n])\s*import\s*(["'])([^"'\r\n]+)\1/g,
];

/** The relative import specifiers in `text`, in first-seen order, each once. Non-relative ones (node:fs, packages) are
 * not part of the install and are dropped. */
export function relativeImports(text) {
  const found = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const m of text.matchAll(pattern)) if (m[2].startsWith("./") || m[2].startsWith("../")) found.push(m[2]);
  }
  return [...new Set(found)];
}

/** The installed-sibling names `name` imports: each specifier resolved against the helper's own folder inside bin/
 * (opencode-plugin/index.js's "./mail.js" is opencode-plugin/mail.js). Sorted, each once. A result starting with "../"
 * points OUTSIDE the install and is returned as is, so the caller can refuse it. */
export function resolveImports(name, installed) {
  const dir = posix.dirname(name);
  return [...new Set(relativeImports(installed).map((spec) => posix.normalize(posix.join(dir, spec))))].sort();
}

/** { name: [siblings] } for every helper, from its INSTALLED text (after installTransform, so the repo's
 * "../../scripts/x.mjs" is already "./x.mjs"). */
export function helperImports(installedByName) {
  return Object.fromEntries(Object.keys(installedByName).sort().map((name) => [name, resolveImports(name, installedByName[name])]));
}

/** The imports that are not an installed helper: an install built from this package would fail to load them. */
export function unresolvedImports(imports) {
  return Object.entries(imports).flatMap(([name, deps]) => deps.filter((d) => !(d in imports)).map((d) => `${name} -> ${d}`));
}

// A sibling a helper STARTS as a process, by path relative to its own file: `new URL("./x.mjs", import.meta.url)` (the
// gate spawned by the Amp and Kilo plugins and by OpenCode's clearance, the wake watcher spawned by awareness and
// antigravity), and the Cline hook's `here("x.mjs")` / `run("x.mjs", ...)`. These are the run-time edges
// IMPORT_PATTERNS cannot see.
const SPAWN_PATTERNS = [
  /new\s+URL\(\s*(["'`])(\.{1,2}\/[^"'`\r\n$]+)\1\s*,\s*import\.meta\.url\s*\)/g,
  /\bhere\(\s*(["'])([^"'\r\n]+)\1\s*\)/g,
  /\brun\(\s*(["'])([^"'\r\n]+\.m?js)\1/g,
];

/** The installed-sibling names `name` reaches by a path built from its own location (see SPAWN_PATTERNS), sorted. */
export function spawnTargets(name, installed) {
  const dir = posix.dirname(name);
  const found = [];
  for (const pattern of SPAWN_PATTERNS) {
    for (const m of installed.matchAll(pattern)) {
      const spec = m[2].startsWith(".") ? m[2] : `./${m[2]}`;
      found.push(posix.normalize(posix.join(dir, spec)));
    }
  }
  return [...new Set(found)].sort();
}

/** True when `installed` builds a path into the INSTALL ROOT (`<home>/.opencadre/bin/...`) rather than beside itself:
 * such a reference escapes the generation its file lives in, so every one must be listed and justified
 * (tests/generations-inventory.test.ts). */
export const absoluteInstallRootRefs = (installed) => /["']\.opencadre["']\s*,\s*["']bin["']/.test(installed);

/** The export names a module declares, sorted: `export function f`, `export async function f`, `export const|let|var x`,
 * `export class C`, `export default`, `export { a, b as c }` (with or without `from`). `export *` is reported as "*" so
 * a caller that must re-export by name can refuse it. Used to generate the stable stub of an IMPORTED plugin entry, which
 * must re-export its generation module's names (cli/lib/stubs.mjs). */
export function exportNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/^\s*export\s+(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  if (/^\s*export\s+default\b/m.test(text)) names.add("default");
  for (const m of text.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",").map((s) => s.trim()).filter(Boolean)) names.add(part.split(/\s+as\s+/).pop().trim());
  }
  if (/^\s*export\s*\*\s*from/m.test(text)) names.add("*");
  return [...names].sort();
}
