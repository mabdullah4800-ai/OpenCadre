// Child process for tests/migrations.test.ts: runs the real runMigrations against a shared file with an
// extra migration that holds its write transaction open. It prints "ready", blocks until the parent
// writes a line to stdin, then migrates, so two workers are guaranteed to start their transactions together.
import Database from "better-sqlite3";
import { readSync } from "node:fs";
import { MIGRATIONS, runMigrations } from "../../src/migrations.js";
import { openFast } from "./sqlite.js";

const [file, holdMs, id] = process.argv.slice(2);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The `timeout` option is better-sqlite3's BUSY timeout for the lock race this worker exists to
// lose or win -- not vitest's. openFast applies FAST_PRAGMAS on top and leaves the option intact:
// the pragmas do not touch the locking protocol, so the race still races (see helpers/sqlite.ts).
const db = openFast(file, { timeout: 15_000 });
const slow = {
  version: 1001,
  name: "slow",
  up: (d: Database.Database) => {
    d.exec(`CREATE TABLE IF NOT EXISTS slow_marker (id TEXT)`);
    d.prepare(`INSERT INTO slow_marker (id) VALUES (?)`).run(id);
    sleep(Number(holdMs));
  },
};
process.stdout.write("ready\n");
readSync(0, Buffer.alloc(8));
const result = runMigrations(db, [...MIGRATIONS, slow]);
db.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
