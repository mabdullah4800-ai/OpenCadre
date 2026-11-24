import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runMigrations } from "./migrations.js";
import { log } from "./log.js";

const DB_PATH = process.env.OPENCADRE_DB_PATH || path.join(process.cwd(), "data", "opencadre.db");

import fs from "node:fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Wait up to 15 s for a write lock (e.g. another process running a migration) instead of failing at startup.
export const db = new Database(DB_PATH, { timeout: 15_000 });
db.pragma("journal_mode = WAL");

const migration = runMigrations(db);
if (migration.applied.length) log.info("schema migrations applied", { applied: migration.applied, version: migration.current });
if (migration.ahead) {
  // Expected right after a rollback: migrations are additive, so this older build still works.
  log.warn("database schema is newer than this build; continuing (migrations are additive)", { version: migration.current });
}

export function newId(): string {
  return randomUUID();
}
