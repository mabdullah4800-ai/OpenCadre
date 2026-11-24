import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  POSTGRES_SCHEMA_SQL,
  POSTGRES_TABLE_COLUMNS,
  TABLE_INSERT_ORDER,
  TABLE_PRIMARY_KEY,
  TIMESTAMP_COLUMNS,
  BOOLEAN_COLUMNS,
} from "../src/db-postgres.js";

// Schema-parity tests: every table and column that a *fresh* run of src/db.ts
// creates (including its idempotent ALTER TABLE migrations) must have an
// entry in src/db-postgres.ts. This catches the failure mode where db.ts
// gains a column via a new ALTER TABLE block and db-postgres.ts is not
// updated to match -- the two files have no shared source of truth other
// than this test.
//
// We build the SQLite side by importing src/db.ts's module (which runs its
// own CREATE TABLE + ALTER TABLE statements against OPENCADRE_DB_PATH,
// pointed at :memory: by vitest.config.ts) and reading back its real,
// resulting schema with PRAGMA table_info -- not by re-reading db.ts's
// source text, which would just test that the file agrees with itself.

async function loadLiveSqliteSchema() {
  const { db } = await import("../src/db.js");
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;

  const schema: Record<string, string[]> = {};
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    schema[name] = columns.map((c) => c.name);
  }
  return schema;
}

describe("Postgres schema parity with the live SQLite schema", () => {
  it("has a Postgres table for every SQLite table", async () => {
    const sqliteSchema = await loadLiveSqliteSchema();
    const sqliteTables = Object.keys(sqliteSchema).sort();
    const postgresTables = Object.keys(POSTGRES_TABLE_COLUMNS).sort();
    expect(postgresTables).toEqual(sqliteTables);
  });

  it("has every SQLite table also in TABLE_INSERT_ORDER, exactly once", async () => {
    const sqliteSchema = await loadLiveSqliteSchema();
    const sqliteTables = Object.keys(sqliteSchema).sort();
    expect([...TABLE_INSERT_ORDER].sort()).toEqual(sqliteTables);
    expect(new Set(TABLE_INSERT_ORDER).size).toBe(TABLE_INSERT_ORDER.length);
  });

  it("has every SQLite table also in TABLE_PRIMARY_KEY", async () => {
    const sqliteSchema = await loadLiveSqliteSchema();
    for (const table of Object.keys(sqliteSchema)) {
      expect(TABLE_PRIMARY_KEY[table], `missing TABLE_PRIMARY_KEY entry for ${table}`).toBeDefined();
      expect(TABLE_PRIMARY_KEY[table].length).toBeGreaterThan(0);
    }
  });

  it("mirrors every column of every SQLite table (order-independent)", async () => {
    const sqliteSchema = await loadLiveSqliteSchema();
    for (const [table, sqliteColumns] of Object.entries(sqliteSchema)) {
      const postgresColumns = POSTGRES_TABLE_COLUMNS[table];
      expect(postgresColumns, `no Postgres columns registered for table ${table}`).toBeDefined();
      expect([...postgresColumns].sort(), `column mismatch on table ${table}`).toEqual([...sqliteColumns].sort());
    }
  });

  it("declares CREATE TABLE for every table named in POSTGRES_TABLE_COLUMNS", () => {
    for (const table of Object.keys(POSTGRES_TABLE_COLUMNS)) {
      expect(POSTGRES_SCHEMA_SQL, `POSTGRES_SCHEMA_SQL has no CREATE TABLE for ${table}`).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`)
      );
    }
  });

  // On an existing database CREATE TABLE IF NOT EXISTS changes nothing, so a column the schema adds with a late
  // ALTER ... ADD COLUMN IF NOT EXISTS doesn't exist until that ALTER runs. An index on it placed earlier in the script
  // fails first, and the upgrade never reaches the ALTER (review of #618 by Codex-OpenCadre-8160).
  it("creates every index on an upgrade-added column only after the ALTER that adds it", () => {
    const sql = POSTGRES_SCHEMA_SQL;
    const added = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => ({ table: m[1], column: m[2], at: m.index! }));
    expect(added.length).toBeGreaterThan(0);
    for (const { table, column, at } of added) {
      const indexes = [...sql.matchAll(new RegExp(`CREATE (?:UNIQUE )?INDEX[^;]*\\bON ${table} \\(([^)]*)\\)`, "g"))]
        .filter((m) => m[1].split(",").map((c) => c.trim()).includes(column));
      for (const index of indexes) expect(index.index!, `${table}.${column} is indexed before the ALTER that adds it`).toBeGreaterThan(at);
    }
  });

  it("every CREATE TABLE / CREATE INDEX statement is idempotent (IF NOT EXISTS)", () => {
    const createStatements = POSTGRES_SCHEMA_SQL.match(/CREATE (TABLE|INDEX)[^;]*/g) ?? [];
    expect(createStatements.length).toBeGreaterThan(0);
    for (const stmt of createStatements) {
      expect(stmt, `not idempotent: ${stmt.slice(0, 60)}...`).toMatch(/IF NOT EXISTS/);
    }
  });

  it("declares FOREIGN KEY ... REFERENCES for every org_id / *_id column SQLite also FKs to organizations", () => {
    // organizations, waitlist.org_id (nullable, no FK in SQLite either) are
    // exceptions; every other org_id column is a real FK in src/db.ts.
    const orgFkTables = TABLE_INSERT_ORDER.filter(
      (t) => POSTGRES_TABLE_COLUMNS[t].includes("org_id") && t !== "waitlist"
    );
    for (const table of orgFkTables) {
      const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`);
      const match = POSTGRES_SCHEMA_SQL.match(re);
      expect(match, `could not find CREATE TABLE body for ${table}`).toBeTruthy();
      expect(match![1]).toMatch(/org_id TEXT NOT NULL REFERENCES organizations\(id\) ON DELETE CASCADE/);
    }
  });

  it("marks every *_at column that SQLite treats as a timestamp, and only those", async () => {
    const sqliteSchema = await loadLiveSqliteSchema();
    for (const [table, columns] of Object.entries(sqliteSchema)) {
      for (const column of columns) {
        if (column.endsWith("_at")) {
          expect(
            TIMESTAMP_COLUMNS.has(column) || column === "created_at" || column === "expires_at",
            `${table}.${column} looks like a timestamp but is not in TIMESTAMP_COLUMNS`
          ).toBe(true);
        }
      }
    }
    // created_at / expires_at are the most common columns and must be present.
    expect(TIMESTAMP_COLUMNS.has("created_at")).toBe(true);
    expect(TIMESTAMP_COLUMNS.has("expires_at")).toBe(true);
  });

  it("marks awaiting_reply as boolean, matching messages' SQLite 0/1 flag", () => {
    expect(BOOLEAN_COLUMNS.has("awaiting_reply")).toBe(true);
  });
});
