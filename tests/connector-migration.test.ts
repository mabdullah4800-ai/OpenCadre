import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS, runMigrations } from "../src/migrations.js";
describe("migration 56 connector inventory", () => {
  it("adds an empty default to a populated version55 without changing existing device data and applies once", () => {
    const fixture = new Database(":memory:");
    try {
      runMigrations(fixture, MIGRATIONS.filter((m) => m.version <= 55));
      fixture.prepare("INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('inventory-org', 'Inventory', 'not-a-credential')").run();
      fixture.prepare("INSERT INTO devices (id, org_id, name, client, code_hash, code_expires_at, created_by_agent_id, created_at) VALUES ('inventory-device', 'inventory-org', 'Laptop', 'codex', 'unusable', '2099-01-01', 'creator', '2026-09-30T00:00:00.000Z')").run();
      const columns = (fixture.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name).join(",");
      const before = fixture.prepare(`SELECT ${columns} FROM devices`).all();
      expect(runMigrations(fixture, MIGRATIONS.filter((m) => m.version <= 56)).applied).toEqual([56]);
      expect(fixture.prepare(`SELECT ${columns} FROM devices`).all()).toEqual(before);
      expect(fixture.prepare("SELECT connector_reports FROM devices").get()).toEqual({ connector_reports: "[]" });
      expect(runMigrations(fixture, MIGRATIONS.filter((m) => m.version <= 56)).applied).toEqual([]);
    } finally { fixture.close(); }
  });
});
describe("migration 57 connector telemetry (PR-E1b)", () => {
  it("adds empty refusal counts and empty digest claims to a populated version56 without changing existing data, once", () => {
    const fixture = new Database(":memory:");
    try {
      runMigrations(fixture, MIGRATIONS.filter((m) => m.version <= 56));
      fixture.prepare("INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('telemetry-org', 'Telemetry', 'not-a-credential')").run();
      fixture.prepare("INSERT INTO devices (id, org_id, name, client, code_hash, code_expires_at, created_by_agent_id, created_at, connector_reports) VALUES ('telemetry-device', 'telemetry-org', 'Laptop', 'codex', 'unusable', '2099-01-01', 'creator', '2026-09-30T00:00:00.000Z', '[{\"kept\":true}]')").run();
      const columns = (fixture.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name).join(",");
      const before = fixture.prepare(`SELECT ${columns} FROM devices`).all();
      expect(runMigrations(fixture, MIGRATIONS.filter((m) => m.version <= 57)).applied).toEqual([57]);
      expect(fixture.prepare(`SELECT ${columns} FROM devices`).all()).toEqual(before);
      expect(fixture.prepare("SELECT connector_refusals, connector_digest FROM devices").get())
        .toEqual({ connector_refusals: "{}", connector_digest: "{}" });
      expect(runMigrations(fixture, MIGRATIONS.filter((m) => m.version <= 57)).applied).toEqual([]);
    } finally { fixture.close(); }
  });
  it("has its Postgres mirror: the CREATE, the late ALTERs and the column registry", async () => {
    const { POSTGRES_SCHEMA_SQL, POSTGRES_TABLE_COLUMNS } = await import("../src/db-postgres.js");
    for (const sql of [
      "ALTER TABLE devices ADD COLUMN IF NOT EXISTS connector_refusals TEXT NOT NULL DEFAULT '{}';",
      "ALTER TABLE devices ADD COLUMN IF NOT EXISTS connector_digest TEXT NOT NULL DEFAULT '{}';",
    ]) expect(POSTGRES_SCHEMA_SQL).toContain(sql);
    expect(POSTGRES_TABLE_COLUMNS.devices).toEqual(expect.arrayContaining(["connector_refusals", "connector_digest"]));
  });
});
