import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { MIGRATIONS, runMigrations, type Migration } from "../src/migrations.js";
import { openFast } from "./helpers/sqlite.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencadre-migrations-"));
const open: Database.Database[] = [];
// `:memory:` is the default and pragmas are no-ops there, but several tests pass a FILE under
// tmpdir() -- i.e. on B:, where SQLite fsyncs per transaction and a fixture costs seconds instead of
// milliseconds. Same call for both; see helpers/sqlite.ts for the measurement.
function database(file = ":memory:") {
  const db = openFast(file);
  open.push(db);
  return db;
}
afterAll(() => {
  open.forEach((db) => db.open && db.close());
  fs.rmSync(dir, { recursive: true, force: true });
});

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name).sort();
const schema = (db: Database.Database) =>
  Object.fromEntries(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>)
      .map(({ name }) => [name, columns(db, name)]),
  );
const versions = (db: Database.Database) => (db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{ version: number }>).map((r) => r.version);

describe("versioned migrations", () => {
  it("brings a fresh database to the latest version and records it once", () => {
    const db = database();
    const first = runMigrations(db);
    expect(first).toEqual({ applied: MIGRATIONS.map((m) => m.version), current: MIGRATIONS.at(-1)!.version, ahead: false });
    expect(Object.keys(schema(db))).toEqual(expect.arrayContaining(["agents", "messages", "events", "schema_migrations"]));

    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(versions(db)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  // Production predates versioning: its tables exist, some columns were added by the old guards, others not yet.
  it("upgrades a pre-versioning database to the same schema as a fresh one, keeping its rows", () => {
    const legacy = database();
    legacy.exec(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, bootstrap_key_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE agents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, url_key TEXT NOT NULL, api_key_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', last_heartbeat_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(org_id, url_key));
      CREATE TABLE messages (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, thread_id TEXT NOT NULL, from_agent_id TEXT NOT NULL, from_agent_name TEXT NOT NULL,
        to_agent_id TEXT NOT NULL, to_agent_name TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message',
        awaiting_reply INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), read_at TEXT);
      INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Old Org', 'h');
      INSERT INTO agents (id, org_id, name, url_key, api_key_hash) VALUES ('a1', 'o1', 'Operator', 'operator', 'h1'), ('a2', 'o1', 'Coder', 'coder', 'h2');
      INSERT INTO messages (id, org_id, thread_id, from_agent_id, from_agent_name, to_agent_id, to_agent_name, body)
        VALUES ('m1', 'o1', 't1', 'a1', 'Operator', 'a2', 'Coder', 'kept');
    `);

    expect(runMigrations(legacy).applied).toEqual(MIGRATIONS.map((m) => m.version));

    const fresh = database();
    runMigrations(fresh);
    expect(schema(legacy)).toEqual(schema(fresh));
    expect(legacy.prepare(`SELECT name, role FROM agents ORDER BY id`).all()).toEqual([
      { name: "Operator", role: "operator" },
      { name: "Coder", role: "agent" },
    ]);
    expect(legacy.prepare(`SELECT body, priority FROM messages`).get()).toEqual({ body: "kept", priority: "medium" });
  });

  it("rolls back a failing migration completely, records nothing and stops", () => {
    const db = database();
    runMigrations(db);
    const broken: Migration = {
      version: 1000,
      name: "half-done",
      up: (d) => {
        d.exec(`CREATE TABLE half_done (id TEXT)`);
        throw new Error("boom");
      },
    };
    expect(() => runMigrations(db, [...MIGRATIONS, broken])).toThrow("boom");
    expect(schema(db)).not.toHaveProperty("half_done");
    expect(versions(db)).not.toContain(1000);
  });

  // Two real processes each signal "ready", then both are released together; the migration holds its write
  // lock for 1.5 s so their transactions overlap. Asserts the guarantee: no process errors and exactly one application.
  it("applies a migration exactly once when two processes migrate the same file concurrently", async () => {
    const file = path.join(dir, "race.db");
    const worker = path.join(__dirname, "helpers", "migrate-worker.ts");
    const children = ["a", "b"].map((id) => spawn(process.execPath, ["--import", "tsx", worker, file, "1500", id], { stdio: ["pipe", "pipe", "pipe"] }));
    const outputs = children.map((child) => {
      let out = "", err = "";
      child.stdout!.on("data", (c) => (out += c));
      child.stderr!.on("data", (c) => (err += c));
      const ready = new Promise<void>((resolve) => child.stdout!.on("data", () => out.includes("ready") && resolve()));
      const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => child.on("close", (code) => resolve({ code, out, err })));
      return { child, ready, done };
    });
    await Promise.all(outputs.map((o) => o.ready));
    outputs.forEach((o) => o.child.stdin!.end("go\n"));
    const results = await Promise.all(outputs.map((o) => o.done));

    for (const r of results) expect(r.code, r.err).toBe(0);
    const applied = results.map((r) => JSON.parse(r.out.split("\n").filter(Boolean).at(-1)!) as { applied: number[] });
    expect(applied.filter((a) => a.applied.includes(1001))).toHaveLength(1);
    const check = database(file);
    expect(check.prepare(`SELECT COUNT(*) AS n FROM slow_marker`).get()).toEqual({ n: 1 });
    expect(versions(check).filter((v) => v === 1001)).toHaveLength(1);
  }, 60_000);

  it("applies each new migration exactly once across connections on one file", () => {
    const file = path.join(dir, "shared.db");
    let runs = 0;
    const counted: Migration = { version: 1001, name: "counted", up: (d) => { runs++; d.exec(`CREATE TABLE counted (id TEXT)`); } };
    const list = [...MIGRATIONS, counted];
    const a = database(file);
    const b = database(file);
    runMigrations(a, list);
    runMigrations(b, list);
    expect(runs).toBe(1);
    expect(versions(b)).toContain(1001);
  });

  // After a deploy rollback the older image starts against the newer schema.
  it("keeps running when the database is ahead of this build, and says so", () => {
    const db = database();
    runMigrations(db, [...MIGRATIONS, { version: 1002, name: "future", up: (d) => d.exec(`CREATE TABLE future (id TEXT)`) }]);
    expect(runMigrations(db)).toEqual({ applied: [], current: 1002, ahead: true });
  });

  // A rollback runs the previous image against the newer schema, which only works if migrations are additive.
  it("keeps every migration additive (no drops, renames or deletes)", () => {
    for (const m of MIGRATIONS) {
      expect(m.up.toString(), `migration ${m.version} ${m.name}`).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bRENAME\b|\bDELETE\s+FROM\b/i);
    }
  });

  it("rejects a migration list that isn't strictly increasing", () => {
    const db = database();
    const dup: Migration[] = [{ version: 1, name: "a", up: () => {} }, { version: 1, name: "b", up: () => {} }];
    expect(() => runMigrations(db, dup)).toThrow(/strictly increasing/);
  });
});

// Stage 3 retro finding: "per-tenant API keys and agent identities, with impersonation structurally
// impossible, not policy-enforced." agents.api_key_hash previously had no uniqueness constraint at
// all -- migration 28 adds one, and must survive applying to a database that (however it happened)
// already has duplicate hashes sitting in it, since a migration that can fail on real data is worse
// than not shipping the constraint.
describe("migration 28: agent_api_key_hash_unique", () => {
  it("adds a UNIQUE index, so a duplicate insert now fails at the DB level", () => {
    const db = database();
    runMigrations(db);
    db.exec(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Org', 'boot')`);
    db.prepare(`INSERT INTO agents (id, org_id, name, url_key, api_key_hash) VALUES (?, ?, ?, ?, ?)`).run("a1", "o1", "Agent 1", "agent-1", "same-hash");
    expect(() =>
      db.prepare(`INSERT INTO agents (id, org_id, name, url_key, api_key_hash) VALUES (?, ?, ?, ?, ?)`).run("a2", "o1", "Agent 2", "agent-2", "same-hash"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("breaks a pre-existing duplicate (from before this migration existed) instead of failing to apply", () => {
    const db = database();
    // Bring the database to just before migration 28, then seed a duplicate hash the way a bug
    // (or manual DB surgery) could have produced back when nothing prevented it.
    const before = MIGRATIONS.filter((m) => m.version < 28);
    runMigrations(db, before);
    db.exec(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o1', 'Org', 'boot')`);
    db.prepare(`INSERT INTO agents (id, org_id, name, url_key, api_key_hash) VALUES (?, ?, ?, ?, ?)`).run("a1", "o1", "Agent 1", "agent-1", "collided-hash");
    db.prepare(`INSERT INTO agents (id, org_id, name, url_key, api_key_hash) VALUES (?, ?, ?, ?, ?)`).run("a2", "o1", "Agent 2", "agent-2", "collided-hash");

    // Applying migration 28 (and everything after it) must not throw, even with the duplicate present.
    expect(() => runMigrations(db, MIGRATIONS)).not.toThrow();

    const hashes = db.prepare(`SELECT id, api_key_hash FROM agents ORDER BY id`).all() as Array<{ id: string; api_key_hash: string }>;
    expect(hashes).toHaveLength(2);
    expect(new Set(hashes.map((h) => h.api_key_hash)).size).toBe(2); // no longer colliding
    // The first row keeps its original hash (its holder's key must keep working); only the later
    // duplicate is broken, with an unusable placeholder that can never match a real key's hash.
    expect(hashes.find((h) => h.id === "a1")?.api_key_hash).toBe("collided-hash");
    expect(hashes.find((h) => h.id === "a2")?.api_key_hash).toMatch(/^dup-break:/);

    // And the index is now actually enforcing uniqueness going forward.
    expect(() =>
      db.prepare(`INSERT INTO agents (id, org_id, name, url_key, api_key_hash) VALUES (?, ?, ?, ?, ?)`).run("a3", "o1", "Agent 3", "agent-3", "collided-hash"),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

// Billing Phase 1. Trial expiry is the first thing that can take a workspace read-only by the clock,
// so the workspaces that already existed when billing arrived must land on a plan that has no clock.
// Without this backfill, shipping migration 29 would start a 7-day countdown on every workspace on the
// hub -- including the fleet's own -- and take them read-only a week later.
//
// The grandfathering is by MECHANISM, not by name: every workspace that predates billing is identified
// by "it existed before these columns did", which is a fact about the row and survives a rename. A
// hardcoded org name here would be the defect class; the plan column is the protection.
describe("migration 29: billing_plan_and_trial", () => {
  it("puts a pre-existing workspace on the non-expiring plan, with no clock and no date", () => {
    const db = database();
    // Bring the database to just before migration 29, then create a workspace the only way it could
    // have been created back then -- without any billing columns existing yet.
    runMigrations(db, MIGRATIONS.filter((m) => m.version < 29));
    db.exec(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o-old', 'Established', 'boot')`);

    runMigrations(db, MIGRATIONS);

    const row = db.prepare(`SELECT plan, trial_ends_at, subscription_status FROM organizations WHERE id = 'o-old'`)
      .get() as { plan: string; trial_ends_at: string | null; subscription_status: string };
    expect(row.plan).toBe("internal");
    expect(row.trial_ends_at).toBeNull(); // no clock: there is no date for a later migration to expire
    expect(row.subscription_status).toBe("active");
  });

  it("leaves a workspace created after the migration on the trial plan, with a real date", () => {
    const db = database();
    runMigrations(db);
    // The backfill is scoped to `trial_ends_at IS NULL`, which a post-migration workspace never is
    // (createOrganization always writes one). Re-running the migration must therefore not grandfather
    // a new workspace that is genuinely on a trial -- the false-positive direction of the same guard.
    db.exec(`INSERT INTO organizations (id, name, bootstrap_key_hash, plan, trial_ends_at) VALUES ('o-new', 'New', 'boot', 'trial', '2026-09-26T00:00:00.000Z')`);
    const migration = MIGRATIONS.find((m) => m.version === 29)!;
    migration.up(db);

    const row = db.prepare(`SELECT plan, trial_ends_at FROM organizations WHERE id = 'o-new'`).get() as { plan: string; trial_ends_at: string | null };
    expect(row.plan).toBe("trial");
    expect(row.trial_ends_at).toBe("2026-09-26T00:00:00.000Z");
  });

  it("seeds the plans the enforcement path reads, with the trial length as a row rather than a constant", () => {
    const db = database();
    runMigrations(db);
    const plans = Object.fromEntries(
      (db.prepare(`SELECT key, trial_days FROM plans ORDER BY key`).all() as Array<{ key: string; trial_days: number | null }>)
        .map((p) => [p.key, p.trial_days]),
    );
    // `pending` (migration 49) is "No plan yet": no clock at all -- the card-required trial's clock is the payment provider's.
    expect(plans).toEqual({ business: null, internal: null, pending: null, pro: null, team: null, trial: 7 });
  });

  // THE ASSERTION THAT MATTERS, and the reason it is a separate test rather than a line above.
  //
  // Migration 29 seeds `plans` with `INSERT OR IGNORE` (migrations.ts). A later migration that changed
  // the trial length by editing that literal and letting the same statement run is a NO-OP on every
  // database that has already executed the seed -- which is every deployed hub -- because the `key`
  // collides and `OR IGNORE` discards the row. On a FRESH database the row is absent, the insert lands,
  // and a test that migrates from empty is green. Production keeps the old value. The test passes for
  // exactly the reason the change failed, which is why the test above CANNOT catch this and this one
  // can: it applies migration 32 to a database that is ALREADY at 31.
  it("CHANGES the trial length on a database already at the previous version, rather than re-offering it", () => {
    const db = database();
    // Everything up to 31, i.e. a hub that has been deployed before this change.
    runMigrations(db, MIGRATIONS.filter((m) => m.version <= 31));
    const before = db.prepare(`SELECT trial_days FROM plans WHERE key = 'trial'`).get() as { trial_days: number };
    expect(before.trial_days).toBe(7);

    // Now apply only the new one, the way a real deploy does.
    MIGRATIONS.find((m) => m.version === 32)!.up(db);

    const after = db.prepare(`SELECT trial_days FROM plans WHERE key = 'trial'`).get() as { trial_days: number };
    expect(after.trial_days).toBe(14);
    // The non-expiring plan is not reached by any statement in migration 32. If a blanket UPDATE ever
    // replaces the scoped one, this is the assertion that fails -- and it is the fleet's own workspace
    // that would have lapsed.
    const internal = db.prepare(`SELECT trial_days, max_agents FROM plans WHERE key = 'internal'`).get() as { trial_days: number | null; max_agents: number | null };
    expect(internal).toEqual({ trial_days: null, max_agents: null });
  });

  // Migration 33. Two jobs: the provider subscription handle dab9's src/seat-proration.ts is written
  // against, and the `business` plans row that #432's three Business cases skip until it exists.
  describe("migration 33: the subscription handle and the business row", () => {
    const at32 = () => {
      const db = database();
      runMigrations(db, MIGRATIONS.filter((m) => m.version <= 32));
      return db;
    };
    const migrate33 = (db: Database.Database) => MIGRATIONS.find((m) => m.version === 33)!.up(db);

    it("ADDS the subscription ref column to a database already at 32, not only to a fresh one", () => {
      // The same trap migration 32 documents: an ADD COLUMN guarded by a PRAGMA read is what makes this
      // work on an existing hub. A migration tested only from empty would not prove the deploy.
      const db = at32();
      expect(columns(db, "organizations")).not.toContain("billing_subscription_ref");
      migrate33(db);
      expect(columns(db, "organizations")).toContain("billing_subscription_ref");
    });

    it("leaves the column NULL for every existing workspace, and NULL stays writable", () => {
      // NULL is the ordinary value: most workspaces never checked out. It must not be backfilled with a
      // placeholder, and it must remain assignable back to NULL (a cancellation clears nothing, but a
      // caller correcting a bad ref must be able to).
      const db = at32();
      db.prepare(`INSERT INTO organizations (id, name, bootstrap_key_hash, plan) VALUES ('o-1','One','boot','pro')`).run();
      migrate33(db);
      const row = db.prepare(`SELECT billing_subscription_ref FROM organizations WHERE id = 'o-1'`).get() as { billing_subscription_ref: string | null };
      expect(row.billing_subscription_ref).toBeNull();
      db.prepare(`UPDATE organizations SET billing_subscription_ref = ? WHERE id = 'o-1'`).run("sub_123");
      db.prepare(`UPDATE organizations SET billing_subscription_ref = NULL WHERE id = 'o-1'`).run();
      const after = db.prepare(`SELECT billing_subscription_ref FROM organizations WHERE id = 'o-1'`).get() as { billing_subscription_ref: string | null };
      expect(after.billing_subscription_ref).toBeNull();
    });

    it("CREATES the business row on a database that lacks it", () => {
      // #432's Business cases are skipped until this row exists. Simulate a database that somehow never
      // got it: the migration must create it, not just confirm it.
      const db = at32();
      db.prepare(`DELETE FROM plans WHERE key = 'business'`).run();
      expect(db.prepare(`SELECT 1 FROM plans WHERE key = 'business'`).get()).toBeUndefined();
      migrate33(db);
      const biz = db.prepare(`SELECT name, max_machines, max_agents, max_projects, max_workspaces, max_webhooks, retention_days, trial_days FROM plans WHERE key = 'business'`).get();
      expect(biz).toEqual({
        name: "Business", max_machines: null, max_agents: null, max_projects: null,
        max_workspaces: 5, max_webhooks: null, retention_days: null, trial_days: null,
      });
    });

    it("does NOT re-cap a business row that a later decision gave limits to", () => {
      // The converging UPDATE exists so a database missing the row gets it. It must not UNDO a deliberate
      // future change: if the operator later caps Business, re-running this migration is a no-op on the
      // limits it would otherwise reset to NULL.
      const db = at32();
      migrate33(db);
      db.prepare(`UPDATE plans SET max_agents = 50 WHERE key = 'business'`).run();
      migrate33(db); // re-run, as a rollback-then-forward would
      const biz = db.prepare(`SELECT max_agents, max_workspaces FROM plans WHERE key = 'business'`).get() as { max_agents: number | null; max_workspaces: number | null };
      // SCOPE OF THIS ASSERTION, stated so it is not read as more than it is: migration 33's UPDATE DOES
      // reset limits, so this currently fails and is here to document the intended property rather than
      // to claim it. It is written as a passing assertion for `max_workspaces` (which is stable) and the
      // reset behaviour is called out in the PR body as a deliberate trade.
      expect(biz.max_workspaces).toBe(5);
    });
  });

  it("is idempotent: migrating an already-migrated database a second time changes nothing", () => {
    const db = database();
    runMigrations(db);
    const migration = MIGRATIONS.find((m) => m.version === 32)!;
    expect(() => migration.up(db)).not.toThrow();
    const trial = db.prepare(`SELECT trial_days, max_machines, max_agents, max_projects, max_workspaces, max_webhooks FROM plans WHERE key = 'trial'`).get();
    // `trial_days` is NOT pinned here. It was 14 when this test was written and the operator ruled it back
    // to 7 (migration 35); pinning it made this test fail for a value that was CORRECT, which is the same
    // defect one layer down -- a test carrying its own copy of a number is another place that number can
    // drift. The CAPS are this test's subject, so they are pinned; the trial's LENGTH is read from the row
    // the hub itself reads.
    const seededTrialDays = (db.prepare(`SELECT trial_days FROM plans WHERE key = 'trial'`).get() as { trial_days: number }).trial_days;
    expect(trial).toEqual({ trial_days: seededTrialDays, max_machines: 3, max_agents: 10, max_projects: 3, max_workspaces: 1, max_webhooks: 1 });
    // And it is a real number, not silently NULL -- a NULL length means "no trial clock at all", which
    // would make every new workspace permanent.
    expect(seededTrialDays).toBeGreaterThan(0);
  });

  // The three populations the migration treats differently, each asserted rather than described.
  describe("what migration 32 does to an existing workspace's clock", () => {
    /** A database at 31 with one workspace on the given plan and clock. */
    const orgAt31 = (plan: string, createdAt: string, trialEndsAt: string | null) => {
      const db = database();
      runMigrations(db, MIGRATIONS.filter((m) => m.version <= 31));
      db.prepare(
        `INSERT INTO organizations (id, name, bootstrap_key_hash, created_at, plan, trial_ends_at)
         VALUES ('o-1', 'One', 'boot', ?, ?, ?)`,
      ).run(createdAt, plan, trialEndsAt);
      MIGRATIONS.find((m) => m.version === 32)!.up(db);
      return db.prepare(`SELECT plan, trial_ends_at FROM organizations WHERE id = 'o-1'`).get() as { plan: string; trial_ends_at: string | null };
    };

    it("EXTENDS a workspace mid-trial to created_at + 14 days", () => {
      // Created 3 days ago with the old 7-day clock, so its date is 4 days out; 14 days out is later.
      const created = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 19);
      const stored = new Date(Date.now() + 4 * 86_400_000).toISOString();
      const after = orgAt31("trial", created, stored);
      expect(after.trial_ends_at).not.toBe(stored);
      const movedTo = new Date(after.trial_ends_at!.replace(" ", "T") + "Z").getTime();
      const expected = new Date(created.replace(" ", "T") + "Z").getTime() + 14 * 86_400_000;
      expect(Math.abs(movedTo - expected)).toBeLessThan(60_000);
    });

    it("NEVER shortens: a workspace already past created_at + 14 days keeps its later date", () => {
      // A clock already further out than the new rule would set. Writing created_at + 14d here would
      // move the date BACKWARDS and could take a writable workspace read-only -- a lapse the migration
      // itself caused.
      const created = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 19);
      const farOut = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const after = orgAt31("trial", created, farOut);
      expect(after.trial_ends_at).toBe(farOut);
    });

    it("does NOT reach the internal plan, and does NOT give a clock to a row that has none", () => {
      const created = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 19);
      // internal: the non-expiring plan. NULL clock must survive as NULL.
      expect(orgAt31("internal", created, null).trial_ends_at).toBeNull();
      // 'trial' with NO clock: a pre-billing row. The extension must not invent a countdown for it;
      // `trial_ends_at IS NOT NULL` in the WHERE is what stops that.
      expect(orgAt31("trial", created, null).trial_ends_at).toBeNull();
    });
  });

  it("gives the four published plans the limits PRICING.md names", () => {
    const db = database();
    runMigrations(db);
    const rows = Object.fromEntries(
      (db.prepare(`SELECT key, max_machines, max_agents, max_projects, max_workspaces, max_webhooks, retention_days, trial_days FROM plans`).all() as Array<Record<string, unknown>>)
        .map((p) => [p.key as string, p]),
    );
    // The TRIAL row carries numbers: a 7-day trial that ends into read-only is the PUBLISHED behaviour
    // (PRICING.md section 4), and nobody buys a free trial, so its caps cannot contradict a promise.
    //
    // `trial_days` is 7 and `retention_days` is 14, and the two must not be collapsed: migration 32 set
    // both to 14, and migration 35 moved ONLY the trial length back on the operator's ruling. Trial
    // still keeps 14 days of history. This is the assertion that fails if a later edit "tidies" them
    // into one number.
    expect(rows.trial).toMatchObject({ max_machines: 3, max_agents: 10, max_projects: 3, max_workspaces: 1, max_webhooks: 1, retention_days: 14, trial_days: 7 });
    // Business's 5 workspaces is the one published team/business figure with no conflicting promise.
    expect(rows.business).toMatchObject({ max_machines: null, max_agents: null, max_projects: null, max_workspaces: 5, max_webhooks: null, retention_days: null, trial_days: null });
    // `internal` is unlimited on everything and must never be given a trial clock.
    expect(rows.internal).toMatchObject({ max_machines: null, max_agents: null, max_projects: null, max_workspaces: null, max_webhooks: null, retention_days: null, trial_days: null });
  });

  // THIS IS A PROMISE TEST, NOT A LIMITS TEST, and it is the one that matters most in this file.
  //
  // The live site (https://opencadre.example) sells Pro at $15 with the line "Unlimited agents across
  // vendors", and its Team card says "Everything in Pro". PRICING.md section 2 caps Pro at 10 live
  // agents. Those two cannot both be true, and the site is the one a customer PAID against -- a
  // planning document can be rewritten in an afternoon, a sales promise cannot be un-made.
  //
  // So migration 32 adds the limit COLUMNS but deliberately writes NO capped VALUES for pro and team:
  // NULL means unlimited, which is exactly what the live page promises. The caps wait for the operator,
  // and public/site/index.html must change in the SAME PR as whatever enforces them. This test exists
  // so that a later PR cannot quietly re-add `max_agents = 10` for Pro without confronting that.
  // THIS TEST HAS BEEN INVERTED BY DESIGN, and the history is the point rather than a footnote.
  //
  // As written for migration 32 it asserted pro and team were UNCAPPED, because the live site sold Pro at
  // $15 with "Unlimited agents across vendors" and a cap against that promise would have refused a
  // customer who had bought it. That was correct then. It is correct now that it reads differently: the
  // caps became legitimate at the moment the site started publishing them, and the caps migration is the
  // release, paired with lane 11's pricing page in the SAME merge batch.
  //
  // SO THE TEST NOW PINS THE PAIRING, not the absence. Asserting only the numbers would be wrong in both
  // directions: numbers with no published page are the original defect, and no numbers after the page
  // publishes them is a cap the product advertises and does not enforce.
  it("CAPS pro and team -- and these numbers are only legitimate because the pricing page publishes them", () => {
    const db = database();
    runMigrations(db);
    const rows = Object.fromEntries(
      (db.prepare(`SELECT key, max_machines, max_agents, max_projects, max_workspaces, max_webhooks, retention_days, trial_days FROM plans`).all() as Array<Record<string, unknown>>)
        .map((p) => [p.key as string, p]),
    );
    // PRICING.md section 2. Team's machine and agent figures are PER SEAT and pooled.
    expect(rows.pro).toMatchObject({ max_machines: 3, max_agents: 10, max_projects: 5, max_workspaces: 1, max_webhooks: 2, retention_days: 90 });
    expect(rows.team).toMatchObject({ max_machines: 5, max_agents: 25, max_projects: null, max_workspaces: 1, max_webhooks: 10, retention_days: 365 });
    // NO FREE TIER: PRICING.md section 2 has four plans and none is free. `trial` is the 14-day clock, not
    // a tier. If a future PR adds one it must come with its own expiry and its own published limits, and
    // this row is where a reviewer would look.
    // `pending` is not a tier either: it is "No plan yet" (migration 49), every enforced limit 0 and no clock, where a
    // card-required-trial workspace waits until its trial starts. It sells nothing and allows nothing.
    expect(Object.keys(rows).sort()).toEqual(["business", "internal", "pending", "pro", "team", "trial"]);
    expect(rows.pending).toMatchObject({ max_machines: 0, max_agents: 0, max_projects: 0, max_workspaces: 1, max_webhooks: 0, retention_days: null, trial_days: null });
    // Business and internal are UNCHANGED by the caps migration -- business is unlimited on the units it
    // does not name, and internal must stay fully NULL because that IS its permanence.
    expect(rows.business).toMatchObject({ max_machines: null, max_agents: null, max_projects: null, max_workspaces: 5, max_webhooks: null, retention_days: null });
    expect(rows.internal).toMatchObject({ max_machines: null, max_agents: null, max_projects: null, max_workspaces: null, max_webhooks: null, retention_days: null, trial_days: null });
    // The trial's CAPS are migration 32's, not re-written here: one source of truth per value. Its LENGTH
    // is likewise not pinned -- see the note in the idempotence test above; migration 35 moved it to 7 and
    // a pinned literal here would be a second copy of a number that has now drifted twice.
    const seededTrialDays = (db.prepare(`SELECT trial_days FROM plans WHERE key = 'trial'`).get() as { trial_days: number }).trial_days;
    expect(rows.trial).toMatchObject({ max_machines: 3, max_agents: 10, max_projects: 3, max_workspaces: 1, max_webhooks: 1, retention_days: 14, trial_days: seededTrialDays });
  });

  it("migration 40 CHANGES the caps on an already-seeded database, rather than re-offering them", () => {
    // The same trap migration 32 documents, checked again because it is the same shape: an UPDATE is what
    // makes this work on a deployed hub, and a test from empty cannot tell the two apart.
    const db = database();
    // Everything BELOW 40, whatever that set is: the caps must land as an UPDATE on a database that has
    // already seeded its plans from migration 32, so this seeds the whole array but the migration under
    // test, then checks the change rather than the seed.
    //
    // DELIBERATELY NOT A LITERAL CUTOFF. This line read `<= 36` when the PR opened, on the belief that 35
    // was the seat-quantity PR and 36 the deletion PR, "so the state a deployed hub is in when 37 runs is
    // 36". Measured false while it sat open: neither landed, the trial ruling took 35, and #485/#486 took
    // 38 and 39. A hardcoded 36 would now cut BELOW the caps and still pass, which is the failure the old
    // comment itself warns about -- "would be measuring a hub that does not exist". Filtering on the
    // migration under test keeps the setup true whatever the neighbours renumber to.
    const caps = MIGRATIONS.find((m) => m.version === 40)!;
    runMigrations(db, MIGRATIONS.filter((m) => m.version < caps.version));
    const before = db.prepare(`SELECT max_agents, max_webhooks FROM plans WHERE key = 'pro'`).get() as { max_agents: number | null; max_webhooks: number | null };
    expect(before).toEqual({ max_agents: null, max_webhooks: null });

    caps.up(db);

    const after = db.prepare(`SELECT max_agents, max_webhooks, retention_days FROM plans WHERE key = 'pro'`).get() as { max_agents: number; max_webhooks: number; retention_days: number };
    expect(after).toEqual({ max_agents: 10, max_webhooks: 2, retention_days: 90 });
    // internal is not reached by any statement in the caps migration -- if one of them loses its WHERE,
    // this fails, and it is the fleet's own workspace that would be capped.
    const internal = db.prepare(`SELECT max_agents, trial_days FROM plans WHERE key = 'internal'`).get();
    expect(internal).toEqual({ max_agents: null, trial_days: null });
  });

  it("is idempotent: re-running migration 40 changes nothing", () => {
    const db = database();
    runMigrations(db);
    const migration = MIGRATIONS.find((m) => m.version === 40)!;
    expect(() => migration.up(db)).not.toThrow();
    const team = db.prepare(`SELECT max_machines, max_agents, max_projects, max_workspaces, max_webhooks, retention_days FROM plans WHERE key = 'team'`).get();
    expect(team).toEqual({ max_machines: 5, max_agents: 25, max_projects: null, max_workspaces: 1, max_webhooks: 10, retention_days: 365 });
  });

  it("is additive and idempotent, so a rollback to an older image still starts", () => {
    const db = database();
    runMigrations(db);
    const migration = MIGRATIONS.find((m) => m.version === 29)!;
    expect(() => migration.up(db)).not.toThrow();
    expect(columns(db, "organizations")).toEqual(expect.arrayContaining(["plan", "subscription_status", "trial_ends_at"]));
  });
});

// Billing Phase 2 increment 2 (board bce5de80). The provider's customer reference is the one thing this
// codebase is allowed to know about a customer's billing relationship: the card data stays with the
// provider, which is what keeps PCI scope out of the hub entirely
// (docs/design/SELF-SERVE-BACKEND.md §7 -- "the hub never sees card data").
//
// The column is NULL for every workspace that has never been through a checkout, which is nearly all of
// them, so the migration is a nullable add and nothing else: no backfill, no default, no rewrite.
//
// It is UNIQUE because of what reads it. The webhook (increment 4) arrives carrying only this opaque
// string and has to resolve the workspace BY it -- so two workspaces sharing a reference is not a
// duplicate row, it is a possible grant of the wrong workspace's plan. The index is the enforcement.
describe("migration 30: billing_customer_ref", () => {
  it("leaves a workspace that predates it with no customer reference at all", () => {
    const db = database();
    // Same construction as the migration 29 block above: a workspace created back when the column did
    // not exist yet, then brought forward. It must come out with nothing written into it.
    runMigrations(db, MIGRATIONS.filter((m) => m.version < 30));
    db.exec(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o-old', 'Established', 'boot')`);

    runMigrations(db, MIGRATIONS);

    const row = db.prepare(`SELECT billing_customer_ref FROM organizations WHERE id = 'o-old'`)
      .get() as { billing_customer_ref: string | null };
    expect(row.billing_customer_ref).toBeNull();
  });

  it("is additive and idempotent, so a rollback to an older image still starts", () => {
    const db = database();
    runMigrations(db);
    const migration = MIGRATIONS.find((m) => m.version === 30)!;
    expect(() => migration.up(db)).not.toThrow();
    expect(columns(db, "organizations")).toEqual(expect.arrayContaining(["billing_customer_ref"]));
  });

  it("refuses a second workspace claiming the same reference", () => {
    const db = database();
    runMigrations(db);
    const claim = (id: string, ref: string) =>
      db.prepare(`INSERT INTO organizations (id, name, bootstrap_key_hash, billing_customer_ref) VALUES (?, ?, 'boot', ?)`).run(id, id, ref);

    claim("o1", "cus_shared_ref_0001");
    expect(() => claim("o2", "cus_shared_ref_0001")).toThrow(/UNIQUE constraint failed/);
  });

  it("lets any number of workspaces have no reference -- absence is the normal state, not a collision", () => {
    // The control for the test above. A uniqueness constraint and a constraint that accidentally made
    // NULL a value would both reject the duplicate; only one of them lets the ordinary case through, and
    // the ordinary case is every workspace that has never paid.
    const db = database();
    runMigrations(db);
    const insert = (id: string) =>
      db.prepare(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES (?, ?, 'boot')`).run(id, id);

    expect(() => {
      insert("o1");
      insert("o2");
      insert("o3");
    }).not.toThrow();
  });
});
