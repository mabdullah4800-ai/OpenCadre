#!/usr/bin/env node
// Forget project sightings (src/project-sightings.ts). Before the no-sightings change, the hub kept a projects row for
// every folder a connected computer had a chat open in, enabled or not. This lists those rows and, with --apply, deletes
// them. It never touches a project anyone enabled or used.
//
//   node scripts/forget-project-sightings.mjs [--db <path>] [--org <orgId>] [--json]            # list only (default)
//   node scripts/forget-project-sightings.mjs [--db <path>] [--org <orgId>] --apply             # delete them
//
// Take a backup first (scripts/ops/opencadre-backup.sh): --apply deletes rows. The database defaults to
// OPENCADRE_DB_PATH, else ./data/opencadre.db (as src/db.ts). Exit code 0 on success, 1 on an error.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// Same loading rule as scripts/project-isolation-preflight.mjs: Node strips the types (22.18 or later); an older Node
// that has run `npm run build` uses dist/ instead.
const source = new URL("../src/project-sightings.ts", import.meta.url);
const built = new URL("../dist/project-sightings.js", import.meta.url);
let sightings;
try {
  sightings = await import(source.href);
} catch (err) {
  if (!existsSync(fileURLToPath(built))) throw err;
  sightings = await import(built.href);
}

export const listProjectSightings = sightings.listProjectSightings;
export const forgetProjectSightings = sightings.forgetProjectSightings;

const VALUE_FLAGS = new Set(["--db", "--org"]);
const SWITCHES = new Set(["--apply", "--json"]);

/** Strict: this can delete rows, so a slip must refuse rather than widen. `--apply --org` with its value missing
 * would otherwise read as "every workspace", and `--db` with none as "the default database" (Codex-OpenCadre-8160 on
 * ee5e4ffa). Every flag once; a value flag needs a value that is not another flag; nothing unknown. */
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!VALUE_FLAGS.has(flag) && !SWITCHES.has(flag)) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    const name = flag.slice(2);
    if (name in opts) throw new Error(`${flag} given more than once`);
    if (SWITCHES.has(flag)) {
      opts[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--") || !value.trim()) throw new Error(`${flag} needs a value`);
    opts[name] = value;
    i++;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const file = opts.db ?? process.env.OPENCADRE_DB_PATH ?? path.join(process.cwd(), "data", "opencadre.db");
  const apply = opts.apply === true;
  const db = new Database(file, { readonly: !apply, fileMustExist: true });
  try {
    const rows = apply ? forgetProjectSightings(db, { orgId: opts.org }) : listProjectSightings(db, { orgId: opts.org });
    if (opts.json) {
      console.log(JSON.stringify({ applied: apply, sightings: rows }, null, 2));
    } else {
      for (const r of rows) console.log(`${r.orgId}  ${r.projectKey}`);
      const noun = `${rows.length} project sighting${rows.length === 1 ? "" : "s"}`;
      console.log(apply ? `Deleted ${noun}.` : `${noun} found. Nothing was changed; run again with --apply to delete them.`);
    }
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`forget-project-sightings: ${err.message}`);
    process.exitCode = 1;
  }
}
