#!/usr/bin/env node
/**
 * Copy every row from the local SQLite database (src/db.ts's file, default
 * data/opencadre.db) into a target Postgres database whose schema mirrors
 * src/db-postgres.ts.
 *
 * This script is READ-ONLY against SQLite: it never writes to, deletes from,
 * or locks the source .db file. Postgres writes are upserts keyed on each
 * table's primary key (see TABLE_PRIMARY_KEY in src/db-postgres.ts), so
 * running this script twice against the same target is safe and does not
 * double-insert rows -- the second run just re-applies the same data.
 *
 * Usage:
 *   DATABASE_URL=postgres://user:pass@host:5432/dbname \
 *     node scripts/migrate-to-postgres.mjs [--dry-run] [--sqlite-path <path>]
 *
 * Flags:
 *   --dry-run        Read SQLite and report what would be migrated (row
 *                     counts per table). Makes zero connections to Postgres.
 *   --sqlite-path P  Override the source SQLite file. Defaults to
 *                     $OPENCADRE_DB_PATH or ./data/opencadre.db (same
 *                     default src/db.ts uses).
 *
 * Rollback: this script never modifies the source SQLite file, so "rollback"
 * is simply continuing to run the app with OPENCADRE_DB_DRIVER unset (or
 * "sqlite") -- nothing needs to be undone on the SQLite side. To discard a
 * bad Postgres migration, drop and recreate the target database or its
 * tables and re-run.
 */
import path from "node:path";
import process from "node:process";
import Database from "better-sqlite3";
import pg from "pg";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.join(HERE, "..");

async function loadPostgresSchemaModule() {
  // src/db-postgres.ts is compiled to dist/db-postgres.js by `npm run build`.
  // Fall back to a direct .ts import under tsx for `npm run` dev usage.
  try {
    return await import(path.join(REPO_ROOT, "dist", "db-postgres.js"));
  } catch {
    return await import(path.join(REPO_ROOT, "src", "db-postgres.ts"));
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, sqlitePath: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--sqlite-path") args.sqlitePath = argv[++i];
  }
  return args;
}

function defaultSqlitePath() {
  return process.env.OPENCADRE_DB_PATH || path.join(process.cwd(), "data", "opencadre.db");
}

/** Convert a SQLite row's timestamp/boolean columns to Postgres-friendly JS values. */
function coerceRow(table, row, { TIMESTAMP_COLUMNS, BOOLEAN_COLUMNS }) {
  const out = {};
  for (const [col, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      out[col] = null;
    } else if (BOOLEAN_COLUMNS.has(col)) {
      out[col] = Boolean(value);
    } else if (TIMESTAMP_COLUMNS.has(col) && typeof value === "string") {
      // SQLite datetime('now') produces "YYYY-MM-DD HH:MM:SS" (UTC, no offset).
      // Treat bare space-separated values as UTC; leave anything already
      // ISO-8601 with a zone (has "T" or trailing Z/offset) untouched.
      const iso = /T|Z|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
      out[col] = new Date(iso);
    } else {
      out[col] = value;
    }
  }
  return out;
}

function buildUpsertSql(table, columns, primaryKey) {
  const cols = columns.join(", ");
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const conflictCols = primaryKey.join(", ");
  const updateCols = columns.filter((c) => !primaryKey.includes(c));
  const setClause =
    updateCols.length > 0
      ? updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")
      : undefined;
  const onConflict = setClause
    ? `ON CONFLICT (${conflictCols}) DO UPDATE SET ${setClause}`
    : `ON CONFLICT (${conflictCols}) DO NOTHING`;
  return `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ${onConflict}`;
}

export async function migrateToPostgres({
  sqlitePath = defaultSqlitePath(),
  postgresUrl = process.env.DATABASE_URL,
  dryRun = false,
  log = console.log,
} = {}) {
  const {
    POSTGRES_SCHEMA_SQL,
    POSTGRES_TABLE_COLUMNS,
    TIMESTAMP_COLUMNS,
    BOOLEAN_COLUMNS,
    TABLE_INSERT_ORDER,
    TABLE_PRIMARY_KEY,
  } = await loadPostgresSchemaModule();

  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const counts = {};
  const rowsByTable = {};
  for (const table of TABLE_INSERT_ORDER) {
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    rowsByTable[table] = rows;
    counts[table] = rows.length;
  }
  sqlite.close();

  log(`Read ${sqlitePath}:`);
  for (const table of TABLE_INSERT_ORDER) log(`  ${table}: ${counts[table]} row(s)`);

  if (dryRun) {
    log("\n--dry-run: no Postgres connection made, no rows written.");
    return { counts, written: false };
  }

  if (!postgresUrl) {
    throw new Error("DATABASE_URL (or an explicit postgresUrl) is required unless --dry-run is passed.");
  }

  const pool = new pg.Pool({ connectionString: postgresUrl });
  const written = {};
  // Maps old SQLite events.seq -> new Postgres events.seq, needed because
  // events.seq is reassigned by Postgres's own BIGSERIAL on upsert/insert and
  // event_deliveries.event_seq must reference the NEW seq, not the source one.
  const oldSeqToNewSeq = new Map();

  try {
    await pool.query(POSTGRES_SCHEMA_SQL);

    for (const table of TABLE_INSERT_ORDER) {
      const columns = POSTGRES_TABLE_COLUMNS[table];
      const primaryKey = TABLE_PRIMARY_KEY[table];
      let insertColumns = columns;
      if (table === "events") {
        // seq is Postgres-assigned; never insert the source seq value.
        insertColumns = columns.filter((c) => c !== "seq");
      }
      const sql = buildUpsertSql(table, insertColumns, primaryKey);
      const returningSeq = table === "events" ? ` RETURNING seq, id` : "";
      let count = 0;

      for (const rawRow of rowsByTable[table]) {
        const row = coerceRow(table, rawRow, { TIMESTAMP_COLUMNS, BOOLEAN_COLUMNS });

        if (table === "event_deliveries") {
          const newSeq = oldSeqToNewSeq.get(rawRow.event_seq);
          if (newSeq === undefined) {
            throw new Error(
              `event_deliveries references event_seq=${rawRow.event_seq}, which was not found among ` +
                `migrated events. Migrate the 'events' table before 'event_deliveries' (TABLE_INSERT_ORDER ` +
                `already orders them this way) and do not skip rows.`
            );
          }
          row.event_seq = newSeq;
        }

        const values = insertColumns.map((c) => row[c]);
        const result = await pool.query(`${sql}${returningSeq}`, values);
        if (table === "events" && result.rows[0]) {
          oldSeqToNewSeq.set(rawRow.seq, result.rows[0].seq);
        }
        count += 1;
      }
      written[table] = count;
      log(`Wrote ${table}: ${count} row(s)`);
    }
  } finally {
    await pool.end();
  }

  return { counts, written: true, writtenCounts: written };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    await migrateToPostgres({
      sqlitePath: args.sqlitePath,
      dryRun: args.dryRun,
    });
  } catch (err) {
    console.error(`migrate-to-postgres failed: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
