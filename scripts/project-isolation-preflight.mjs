#!/usr/bin/env node
// Project isolation pre-flight (docs/design/PROJECT_ISOLATION.md §7, item 3). READ-ONLY: it opens the hub's SQLite
// database read-only, changes nothing and enables nothing.
//
// For each workspace it lists every enabled project with its live agents and how many rows are stamped with it, and it
// flags a repository whose live agents use more than one project key (e.g. the legacy "OpenCadre" folder key next to
// github.com/mabdullah4800-ai/opencadre, with no alias joining them). Enforcement must not be switched on while anything is
// flagged: one fleet would split into two halves that can't see each other.
//
//   node scripts/project-isolation-preflight.mjs [--db <path>] [--org <orgId>] [--json]
//
// The database defaults to OPENCADRE_DB_PATH, else ./data/opencadre.db (as src/db.ts). Exit code: 0 when nothing is
// flagged, 2 when a split is flagged, 1 on an error.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// The logic lives in src/project-preflight.ts, the copy the hub runs when an operator switches project isolation on. Node
// strips its types (Node 22.18 or later); a checkout on an older Node that has run `npm run build` uses dist/ instead.
const source = new URL("../src/project-preflight.ts", import.meta.url);
const built = new URL("../dist/project-preflight.js", import.meta.url);
let preflight;
try {
  preflight = await import(source.href);
} catch (err) {
  if (!existsSync(fileURLToPath(built))) throw err;
  preflight = await import(built.href);
}

export const STAMPED_TABLES = preflight.PREFLIGHT_TABLES;
/** The pre-flight report for one workspace, or for every workspace when orgId is omitted. Reads only. */
export const projectIsolationPreflight = preflight.projectIsolationPreflight;
/** The report as aligned, readable text. */
export const formatPreflight = preflight.formatPreflight;

function main(argv) {
  const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const file = arg("--db") ?? process.env.OPENCADRE_DB_PATH ?? path.join(process.cwd(), "data", "opencadre.db");
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const report = projectIsolationPreflight(db, { orgId: arg("--org") });
    console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : formatPreflight(report));
    return report.flagged ? 2 : 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`Pre-flight error: ${err.message}`);
    process.exitCode = 1;
  }
}
