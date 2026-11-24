import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFast } from "./helpers/sqlite.js";

// A database created before agents had a role: the migration in db.ts must add
// the column and promote the existing "Operator" agent, and nothing else.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencadre-role-"));
const file = path.join(dir, "old.db");
let migrated: Database.Database | undefined;

afterAll(() => {
  migrated?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent role migration", () => {
  it("adds role and promotes agents named exactly Operator", async () => {
    const old = openFast(file);
    old.exec(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, bootstrap_key_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE agents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, url_key TEXT NOT NULL, api_key_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', last_heartbeat_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(org_id, url_key));
      INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Old Org', 'h');
      INSERT INTO agents (id, org_id, name, url_key, api_key_hash) VALUES
        ('a1', 'o1', 'Operator', 'operator', 'h1'),
        ('a2', 'o1', 'Coder', 'coder', 'h2'),
        ('a3', 'o1', 'operator-bot', 'operator-bot', 'h3');
    `);
    old.close();

    process.env.OPENCADRE_DB_PATH = file;
    ({ db: migrated } = await import("../src/db.js"));
    const roles = migrated!.prepare(`SELECT name, role FROM agents ORDER BY id`).all();
    expect(roles).toEqual([
      { name: "Operator", role: "operator" },
      { name: "Coder", role: "agent" },
      { name: "operator-bot", role: "agent" },
    ]);
  });
});
