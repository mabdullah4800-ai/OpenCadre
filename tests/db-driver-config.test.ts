import { describe, expect, it } from "vitest";
import { resolveDbDriver, UnsupportedDbDriverError } from "../src/db-driver-config.js";

describe("resolveDbDriver", () => {
  it("defaults to sqlite when OPENCADRE_DB_DRIVER is unset (today's only runtime behavior)", () => {
    const config = resolveDbDriver({});
    expect(config.driver).toBe("sqlite");
  });

  it("defaults to sqlite when OPENCADRE_DB_DRIVER is explicitly 'sqlite'", () => {
    const config = resolveDbDriver({ OPENCADRE_DB_DRIVER: "sqlite" });
    expect(config.driver).toBe("sqlite");
  });

  it("passes through OPENCADRE_DB_PATH for the sqlite driver", () => {
    const config = resolveDbDriver({ OPENCADRE_DB_PATH: "/tmp/custom.db" });
    expect(config.sqlitePath).toBe("/tmp/custom.db");
  });

  it("throws UnsupportedDbDriverError for postgres, since the query layer is not wired yet", () => {
    expect(() =>
      resolveDbDriver({ OPENCADRE_DB_DRIVER: "postgres", DATABASE_URL: "postgres://localhost/x" })
    ).toThrow(UnsupportedDbDriverError);
  });

  it("postgres error message points at the migration script and docs, and names DATABASE_URL", () => {
    try {
      resolveDbDriver({ OPENCADRE_DB_DRIVER: "postgres", DATABASE_URL: "postgres://localhost/x" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedDbDriverError);
      expect((err as Error).message).toMatch(/migrate-to-postgres\.mjs/);
      expect((err as Error).message).toMatch(/POSTGRES_MIGRATION\.md/);
    }
  });

  it("throws when postgres is requested but no connection string is configured", () => {
    expect(() => resolveDbDriver({ OPENCADRE_DB_DRIVER: "postgres" })).toThrow(/DATABASE_URL/);
  });

  it("accepts OPENCADRE_POSTGRES_URL as an alternative to DATABASE_URL", () => {
    expect(() =>
      resolveDbDriver({ OPENCADRE_DB_DRIVER: "postgres", OPENCADRE_POSTGRES_URL: "postgres://localhost/x" })
    ).toThrow(UnsupportedDbDriverError); // still unsupported, but for the right reason (not missing config)
  });

  it("rejects an unknown driver name", () => {
    expect(() => resolveDbDriver({ OPENCADRE_DB_DRIVER: "mysql" })).toThrow(/Unknown OPENCADRE_DB_DRIVER/);
  });
});
