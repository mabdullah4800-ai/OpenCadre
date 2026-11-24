import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// migrate-to-postgres.mjs and db.ts are both module-level singletons keyed
// off OPENCADRE_DB_PATH at import time, so this whole file gets its own
// temp SQLite file and its own dynamic import of src/db.ts -- vitest already
// isolates each test FILE into a fresh module registry (see
// vitest.config.ts's comment on db.ts), so this does not collide with any
// other test file's :memory: database.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencadre-pg-migrate-"));
const sqlitePath = path.join(tmpDir, "source.db");
process.env.OPENCADRE_DB_PATH = sqlitePath;

afterAll(async () => {
  // Windows refuses to delete a SQLite file that is still open (EBUSY).
  const { db } = await import("../src/db.js");
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedSampleData() {
  const { db, newId } = await import("../src/db.js");

  const orgId = newId();
  db.prepare(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES (?, ?, ?)`).run(
    orgId,
    "Acme Corp",
    "hash-org"
  );

  const agentId = newId();
  db.prepare(
    `INSERT INTO agents (id, org_id, name, url_key, api_key_hash) VALUES (?, ?, ?, ?, ?)`
  ).run(agentId, orgId, "builder-1", "builder-1", "hash-agent");

  const agent2Id = newId();
  db.prepare(
    `INSERT INTO agents (id, org_id, name, url_key, api_key_hash) VALUES (?, ?, ?, ?, ?)`
  ).run(agent2Id, orgId, "reviewer-1", "reviewer-1", "hash-agent-2");

  const msgId = newId();
  db.prepare(
    `INSERT INTO messages (id, org_id, thread_id, from_agent_id, from_agent_name, to_agent_id, to_agent_name, body, awaiting_reply)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(msgId, orgId, "thread-1", agentId, "builder-1", agent2Id, "reviewer-1", "please review PR #4", 1);

  const taskId = newId();
  db.prepare(
    `INSERT INTO tasks (id, org_id, title, created_by_agent_id, created_by_agent_name) VALUES (?, ?, ?, ?, ?)`
  ).run(taskId, orgId, "Fix flaky test", agentId, "builder-1");

  const approvalId = newId();
  db.prepare(
    `INSERT INTO approvals (id, org_id, requested_by_agent_id, requested_by_agent_name, action, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', '+1 hour'))`
  ).run(approvalId, orgId, agentId, "builder-1", "force-push");

  const eventId1 = newId();
  const eventId2 = newId();
  db.prepare(
    `INSERT INTO events (id, org_id, type, subject_type, subject_id, target_agent_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(eventId1, orgId, "task.created", "task", taskId, null);
  db.prepare(
    `INSERT INTO events (id, org_id, type, subject_type, subject_id, target_agent_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(eventId2, orgId, "message.sent", "message", msgId, agent2Id);

  const eventRows = db.prepare(`SELECT seq, id FROM events ORDER BY seq`).all() as Array<{
    seq: number;
    id: string;
  }>;
  db.prepare(
    `INSERT INTO event_deliveries (event_seq, agent_id, state) VALUES (?, ?, ?)`
  ).run(eventRows[1].seq, agent2Id, "delivered");

  db.prepare(
    `INSERT INTO connect_codes (code_hash, org_id, agent_name, client, created_by_agent_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now', '+1 hour'))`
  ).run("codehash-" + randomUUID(), orgId, "new-agent", "claude-code", agentId);

  db.prepare(
    `INSERT INTO message_escalations (message_id, level, last_notified_at) VALUES (?, ?, datetime('now'))`
  ).run(msgId, 1);

  return { orgId, agentId, agent2Id, msgId, taskId, approvalId };
}

// Seed the temp SQLite file exactly once for the whole file: every test
// below (dry-run and real-Postgres alike) reads the same fixed dataset, so
// row counts asserted anywhere in this file stay meaningful regardless of
// which describe block runs first.
let seeded: Awaited<ReturnType<typeof seedSampleData>>;
beforeAll(async () => {
  seeded = await seedSampleData();
});

describe("migrate-to-postgres.mjs (dry run, no Postgres required)", () => {
  it("reports row counts for every table without connecting to Postgres", async () => {
    const { migrateToPostgres } = await import("../scripts/migrate-to-postgres.mjs");

    const result = await migrateToPostgres({ sqlitePath, dryRun: true, log: () => {} });

    expect(result.written).toBe(false);
    expect(result.counts.organizations).toBe(1);
    expect(result.counts.agents).toBe(2);
    expect(result.counts.messages).toBe(1);
    expect(result.counts.tasks).toBe(1);
    expect(result.counts.approvals).toBe(1);
    expect(result.counts.events).toBe(2);
    expect(result.counts.event_deliveries).toBe(1);
    expect(result.counts.connect_codes).toBe(1);
    expect(result.counts.message_escalations).toBe(1);
    expect(seeded.orgId).toBeTruthy();
  });

  it("throws a clear error when neither --dry-run nor a Postgres URL is given", async () => {
    const { migrateToPostgres } = await import("../scripts/migrate-to-postgres.mjs");
    await expect(migrateToPostgres({ sqlitePath, postgresUrl: undefined, log: () => {} })).rejects.toThrow(
      /DATABASE_URL/
    );
  });
});

// Real round-trip tests against a live Postgres. Skipped unless
// OPENCADRE_TEST_POSTGRES_URL is set -- CI and most local dev environments
// have no Postgres available, and this migration path is infrastructure for
// a future cutover, not something the default test suite depends on.
//
// To run these locally:
//   createdb opencadre_pg_test
//   OPENCADRE_TEST_POSTGRES_URL=postgres://localhost/opencadre_pg_test npx vitest run tests/migrate-to-postgres.test.ts
const postgresUrl = process.env.OPENCADRE_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)("migrate-to-postgres.mjs (real Postgres round-trip)", () => {
  let pg: typeof import("pg");
  let pool: InstanceType<typeof import("pg").Pool>;

  beforeAll(async () => {
    pg = await import("pg");
    pool = new pg.Pool({ connectionString: postgresUrl });
    // Start from a clean slate so counts below are exact, not cumulative
    // across repeated local test runs against the same throwaway database.
    const { TABLE_INSERT_ORDER } = await import("../src/db-postgres.js");
    for (const table of [...TABLE_INSERT_ORDER].reverse()) {
      await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`).catch(() => {});
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("copies every row with correct types and preserves relationships", async () => {
    const { migrateToPostgres } = await import("../scripts/migrate-to-postgres.mjs");

    const result = await migrateToPostgres({ sqlitePath, postgresUrl, log: () => {} });
    expect(result.written).toBe(true);

    const org = await pool.query(`SELECT * FROM organizations WHERE id = $1`, [seeded.orgId]);
    expect(org.rows).toHaveLength(1);
    expect(org.rows[0].name).toBe("Acme Corp");
    expect(org.rows[0].created_at).toBeInstanceOf(Date);

    const msg = await pool.query(`SELECT * FROM messages WHERE id = $1`, [seeded.msgId]);
    expect(msg.rows[0].awaiting_reply).toBe(true); // SQLite 1 -> Postgres boolean

    const approval = await pool.query(`SELECT * FROM approvals WHERE id = $1`, [seeded.approvalId]);
    expect(approval.rows[0].expires_at).toBeInstanceOf(Date);

    // event_deliveries.event_seq must resolve to the NEW Postgres seq, not
    // the source SQLite seq (which are not portable across BIGSERIAL reassignment).
    const delivery = await pool.query(
      `SELECT ed.* FROM event_deliveries ed JOIN events e ON e.seq = ed.event_seq WHERE e.type = 'message.sent'`
    );
    expect(delivery.rows).toHaveLength(1);
    expect(delivery.rows[0].agent_id).toBe(seeded.agent2Id);
  });

  it("is idempotent: running the migration twice does not duplicate rows", async () => {
    const { migrateToPostgres } = await import("../scripts/migrate-to-postgres.mjs");

    const before = await pool.query(`SELECT count(*)::int AS n FROM organizations`);
    await migrateToPostgres({ sqlitePath, postgresUrl, log: () => {} });
    const after = await pool.query(`SELECT count(*)::int AS n FROM organizations`);

    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
