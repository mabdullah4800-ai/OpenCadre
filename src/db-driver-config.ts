// Documented config switch for the Postgres migration path.
//
// IMPORTANT -- this module is NOT imported by src/db.ts, src/index.ts, or any
// other runtime module. The application's default (and today, only
// supported) datastore remains SQLite via src/db.ts, unchanged. Nothing
// about existing behavior changes because this file exists.
//
// What this module IS: the single, documented seam a future query-layer
// adapter would read to decide which driver to use, plus a resolver other
// tooling (the migration script, tests) can call today. It exists so the
// env vars below have one real, tested definition instead of being
// reinvented ad hoc in scripts and docs.
//
// What this module is NOT: a working dual-driver query layer. src/db.ts's
// ~120 call sites across 12 files use better-sqlite3's synchronous
// prepare/get/all/run API directly; porting all of them to an async,
// driver-agnostic interface is real work tracked separately (see
// docs/ops/POSTGRES_MIGRATION.md, "What this does not do yet"). Calling
// resolveDbDriver() with OPENCADRE_DB_DRIVER=postgres today correctly
// reports that intent -- it does not silently fall back to SQLite -- but no
// code path acts on a "postgres" result yet.

export type DbDriver = "sqlite" | "postgres";

export interface DbDriverConfig {
  driver: DbDriver;
  /** Only set when driver === "sqlite". Mirrors src/db.ts's own default. */
  sqlitePath?: string;
  /** Only set when driver === "postgres". */
  postgresUrl?: string;
}

export class UnsupportedDbDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDbDriverError";
  }
}

/**
 * Resolve which database driver the app is configured for, from environment
 * variables. Defaults to "sqlite" (today's only supported runtime driver)
 * when OPENCADRE_DB_DRIVER is unset -- identical to today's behavior.
 *
 * Pass an explicit `env` (e.g. in tests) instead of relying on process.env.
 */
export function resolveDbDriver(env: NodeJS.ProcessEnv = process.env): DbDriverConfig {
  const requested = (env.OPENCADRE_DB_DRIVER ?? "sqlite").trim().toLowerCase();

  if (requested === "sqlite" || requested === "") {
    return {
      driver: "sqlite",
      sqlitePath: env.OPENCADRE_DB_PATH || undefined,
    };
  }

  if (requested === "postgres" || requested === "postgresql") {
    const postgresUrl = env.DATABASE_URL || env.OPENCADRE_POSTGRES_URL;
    if (!postgresUrl) {
      throw new UnsupportedDbDriverError(
        "OPENCADRE_DB_DRIVER=postgres requires DATABASE_URL (or OPENCADRE_POSTGRES_URL) to be set."
      );
    }
    throw new UnsupportedDbDriverError(
      "OPENCADRE_DB_DRIVER=postgres is not yet wired into the application query layer. " +
        "src/db.ts and its ~120 call sites still speak better-sqlite3's synchronous API directly. " +
        "Use scripts/migrate-to-postgres.mjs to copy data into Postgres for schema validation, " +
        "or see docs/ops/POSTGRES_MIGRATION.md for the current status of the migration path. " +
        "The app continues to run on SQLite until OPENCADRE_DB_DRIVER is unset or 'sqlite'."
    );
  }

  throw new UnsupportedDbDriverError(
    `Unknown OPENCADRE_DB_DRIVER "${requested}". Supported values: "sqlite" (default), "postgres".`
  );
}
