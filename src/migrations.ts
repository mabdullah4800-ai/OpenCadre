import type Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { computeEventHash } from "./event-hash.js";
import { maskSecrets } from "./secrets.js";
import { toSqliteTime } from "./timestamps.js";

/** Versioned schema migrations. Each migration runs once, in its own transaction, and is recorded
 * in schema_migrations. Migrations must be ADDITIVE (new tables, new nullable or defaulted
 * columns, new indexes): the deploy script can roll back to the previous image, and that image
 * must still run against the newer schema. Never rename or drop in the same release that stops
 * using a column; do it in a later migration once no deployed image reads it. Keep each migration
 * well under the 15 s busy timeout set in db.ts; a long backfill should run in batches outside startup. */
export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline",
    // The schema as of 2026-09-14, including the idempotent column guards that predate versioning,
    // so an existing database (production) and a fresh one both arrive at the same version-1 schema.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bootstrap_key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url_key TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | paused (paused = auto-suspended for heartbeat staleness)
  last_heartbeat_at TEXT,
  webhook_url TEXT,
  webhook_auth_header TEXT,
  current_task TEXT,
  editing_files TEXT, -- JSON array of file paths, informational only
  status_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, url_key)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  from_agent_name TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  to_agent_name TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message', -- message | question | reply
  priority TEXT NOT NULL DEFAULT 'medium', -- high | medium | low
  awaiting_reply INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS messages_to_agent_idx ON messages (org_id, to_agent_id, read_at);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (org_id, thread_id);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by_agent_id TEXT NOT NULL,
  uploaded_by_agent_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Shared task board. A claim is a lease: claimed_by_* plus lease_expires_at
-- (ISO-8601 UTC). An expired lease leaves status 'claimed' in storage but the
-- task is claimable again; readers compute lease_active.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | claimed | done
  created_by_agent_id TEXT NOT NULL,
  created_by_agent_name TEXT NOT NULL,
  claimed_by_agent_id TEXT,
  claimed_by_agent_name TEXT,
  lease_expires_at TEXT,
  completion_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS tasks_org_status_idx ON tasks (org_id, status);

-- Human/agent approval gate for risky actions. Fail closed: a request that
-- isn't decided before expires_at (ISO-8601 UTC) becomes 'expired', which
-- callers must treat as denied.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by_agent_id TEXT NOT NULL,
  requested_by_agent_name TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  risk TEXT NOT NULL DEFAULT 'medium', -- low | medium | high
  category TEXT, -- stable action kind, e.g. force-push; grants match on it
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | expired | noted
  decided_by_agent_id TEXT,
  decided_by_agent_name TEXT,
  decision_note TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS approvals_org_status_idx ON approvals (org_id, status);

-- Time-boxed "approve for N minutes": auto-approves one agent's requests in one category.
CREATE TABLE IF NOT EXISTS approval_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  category TEXT NOT NULL,
  granted_by_agent_id TEXT NOT NULL,
  granted_by_agent_name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Early-access waitlist from the public site. ip_hash is a salted hash, never the raw IP.
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  team_size TEXT,
  tools TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  ip_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved
  org_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);

-- Append-only organization timeline (Ambient Awareness v1). Written in the same
-- transaction as the state change it describes; never updated or deleted in code.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_agent_id TEXT,
  actor_agent_name TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  target_agent_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  prev_hash TEXT,   -- hash of the preceding event row for this org_id; null for the first chained event
  hash TEXT         -- sha256 of this row's own columns + prev_hash (Ambient Intelligence v2 S3.4); computed by emitEvent, never by SQL default
);

CREATE INDEX IF NOT EXISTS events_org_seq_idx ON events (org_id, seq);
CREATE INDEX IF NOT EXISTS events_target_idx ON events (org_id, target_agent_id, seq);

-- Per-agent delivery state for directed events (slice 2). "delivered" is a
-- transport receipt; acknowledged/acted/dismissed come only from the agent's own ack.
CREATE TABLE IF NOT EXISTS event_deliveries (
  event_seq INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL, -- queued | delivered | acknowledged | acted | dismissed
  delivered_at TEXT,
  acknowledged_at TEXT,
  resolved_at TEXT,
  PRIMARY KEY (event_seq, agent_id)
);

CREATE INDEX IF NOT EXISTS event_deliveries_open_idx ON event_deliveries (agent_id, state, event_seq);

-- One-time console connect codes. Only the sha256 of the code is stored; a code
-- is spent once redeemed_at is set, and agent_id then names the agent it created.
CREATE TABLE IF NOT EXISTS connect_codes (
  code_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  client TEXT NOT NULL,
  created_by_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  agent_id TEXT
);

CREATE INDEX IF NOT EXISTS approval_grants_lookup_idx ON approval_grants (org_id, agent_id, category, expires_at);

-- Hub-side operator escalation of unread high-priority mail (UNIVERSAL_WAKE T6).
-- level 1..3 = escalated at N, 2N, 4N minutes; kept so each level fires once.
CREATE TABLE IF NOT EXISTS message_escalations (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  last_notified_at TEXT NOT NULL
);
      `);

      // Idempotent migration for DBs created before webhook_url existed --
      // CREATE TABLE IF NOT EXISTS above only helps on a fresh database.
      const agentColumns = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
      if (!agentColumns.some((c) => c.name === "webhook_url")) {
        db.exec(`ALTER TABLE agents ADD COLUMN webhook_url TEXT`);
      }
      if (!agentColumns.some((c) => c.name === "webhook_auth_header")) {
        db.exec(`ALTER TABLE agents ADD COLUMN webhook_auth_header TEXT`);
      }
      if (!agentColumns.some((c) => c.name === "current_task")) {
        db.exec(`ALTER TABLE agents ADD COLUMN current_task TEXT`);
      }
      if (!agentColumns.some((c) => c.name === "editing_files")) {
        db.exec(`ALTER TABLE agents ADD COLUMN editing_files TEXT`);
      }
      if (!agentColumns.some((c) => c.name === "status_updated_at")) {
        db.exec(`ALTER TABLE agents ADD COLUMN status_updated_at TEXT`);
      }
      const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
      if (!messageColumns.some((c) => c.name === "priority")) {
        db.exec(`ALTER TABLE messages ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'`);
      }
      if (!messageColumns.some((c) => c.name === "file_id")) {
        db.exec(`ALTER TABLE messages ADD COLUMN file_id TEXT`);
      }

      const approvalColumns = db.prepare(`PRAGMA table_info(approvals)`).all() as Array<{ name: string }>;
      if (!approvalColumns.some((c) => c.name === "category")) {
        db.exec(`ALTER TABLE approvals ADD COLUMN category TEXT`);
      }
      if (!agentColumns.some((c) => c.name === "phase")) {
        db.exec(`ALTER TABLE agents ADD COLUMN phase TEXT`); // planning | editing | testing | reviewing | waiting
      }
      const taskColumns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
      if (!taskColumns.some((c) => c.name === "lease_expiry_emitted_at")) {
        // Set once task.lease_expired is emitted for the current claim; cleared on claim/renew.
        db.exec(`ALTER TABLE tasks ADD COLUMN lease_expiry_emitted_at TEXT`);
      }
      if (!agentColumns.some((c) => c.name === "awareness_cursor")) {
        // Last event seq covered by this agent's awareness digest.
        db.exec(`ALTER TABLE agents ADD COLUMN awareness_cursor INTEGER`);
      }
      if (!agentColumns.some((c) => c.name === "key_class")) {
        // agent = read-on-fetch default; watcher = peek-by-default (Incident 1 scaling fix).
        db.exec(`ALTER TABLE agents ADD COLUMN key_class TEXT NOT NULL DEFAULT 'agent'`);
      }
      if (!agentColumns.some((c) => c.name === "role")) {
        // operator | agent. Operators manage the org's agent keys from the console.
        // Before roles existed, the waitlist's "Operator" agent was the operator by convention.
        db.exec(`ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'agent'`);
        db.exec(`UPDATE agents SET role = 'operator' WHERE name = 'Operator'`);
      }
      if (!agentColumns.some((c) => c.name === "usage")) {
        // Latest subscription usage report as JSON (src/usage.ts), so "out of usage" reads differently from "crashed".
        db.exec(`ALTER TABLE agents ADD COLUMN usage TEXT`);
      }

      // Idempotent migration for DBs created before hash-chaining existed (Ambient
      // Intelligence v2 S3.4, tamper-evident audit trail). Rows written before this
      // migration keep hash = NULL: verifyEventChain treats a NULL hash as the start
      // of a fresh chain rather than a break, so pre-existing data is never flagged
      // as tampered -- the guarantee only covers events emitted from here on.
      const eventColumns = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
      if (!eventColumns.some((c) => c.name === "prev_hash")) {
        db.exec(`ALTER TABLE events ADD COLUMN prev_hash TEXT`);
      }
      if (!eventColumns.some((c) => c.name === "hash")) {
        db.exec(`ALTER TABLE events ADD COLUMN hash TEXT`);
      }
    },
  },
  {
    version: 2,
    name: "idempotency_keys",
    // Retry-safe writes (src/idempotency.ts). status is NULL while the first request is still running.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS idempotency_keys (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, agent_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);
      `);
    },
  },
  {
    version: 3,
    name: "messages_delivered_at",
    // delivered_at: the message reached the recipient (live push, or returned by a read or peek).
    // read_at: the recipient consumed it. Mail already read counts as delivered at that time.
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "delivered_at")) db.exec(`ALTER TABLE messages ADD COLUMN delivered_at TEXT`);
      db.exec(`UPDATE messages SET delivered_at = read_at WHERE delivered_at IS NULL AND read_at IS NOT NULL`);
    },
  },
  {
    version: 4,
    name: "clearance_policies",
    // Per-project clearance mode (src/clearance-policy.ts). project "" is the workspace default.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS clearance_policies (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('off', 'notify', 'ask', 'strict')),
  updated_by_agent_id TEXT,
  updated_by_agent_name TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, project)
);
      `);
    },
  },
  {
    version: 5,
    name: "workspace_pause",
    // Workspace kill switch (src/kill-switch.ts): paused_at is set while an operator has paused the workspace.
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "paused_at")) db.exec(`ALTER TABLE organizations ADD COLUMN paused_at TEXT`);
      if (!columns.some((c) => c.name === "paused_by_agent_name")) db.exec(`ALTER TABLE organizations ADD COLUMN paused_by_agent_name TEXT`);
    },
  },
  {
    version: 6,
    name: "people_accounts",
    // People sign in with GitHub, Google or email (src/accounts.ts, docs/design/ACCOUNTS.md). A member acts through
    // an agents row with key_class 'human'; sessions and invite tokens are stored as SHA-256 only.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  last_sign_in_at TEXT
);
CREATE INDEX IF NOT EXISTS people_email_idx ON people (email);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_person_idx ON sessions (person_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS workspace_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  agent_id TEXT NOT NULL,
  invited_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, person_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_person_idx ON workspace_members (person_id);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  email TEXT,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT,
  revoked_at TEXT
);
      `);
    },
  },
  {
    version: 7,
    name: "push_subscriptions",
    // Phone approvals (src/push.ts): a person's browser or installed console subscribes to Web Push, one row per
    // device. The endpoint is unique, so a browser that signs in as someone else moves to that person.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_label TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_person_idx ON push_subscriptions (person_id);
      `);
    },
  },
  {
    version: 8,
    name: "devices_and_sessions",
    // Per-session identity (src/devices.ts). A device is one tool on one computer, credentialed once with a
    // one-time ocd_ code; only SHA-256 hashes of the code and the dev_ credential are stored. Every tool session
    // on that device becomes its own agents row (kind 'session'), keyed by (device_id, seat_id). Existing rows
    // default to kind 'named', so agt_ agents are untouched.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  client TEXT NOT NULL,
  credential_hash TEXT UNIQUE, -- NULL until the code is redeemed
  code_hash TEXT NOT NULL UNIQUE,
  code_expires_at TEXT NOT NULL,
  code_redeemed_at TEXT,
  created_by_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS devices_org_idx ON devices (org_id);
      `);
      const columns = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
      const has = (name: string) => columns.some((c) => c.name === name);
      if (!has("kind")) db.exec(`ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'named'`); // named | session
      if (!has("device_id")) db.exec(`ALTER TABLE agents ADD COLUMN device_id TEXT`);
      // The stable seat: the host session id when the tool gives one (it survives /clear), else the tool session id.
      if (!has("seat_id")) db.exec(`ALTER TABLE agents ADD COLUMN seat_id TEXT`);
      if (!has("tool_session_id")) db.exec(`ALTER TABLE agents ADD COLUMN tool_session_id TEXT`); // the latest one
      if (!has("project")) db.exec(`ALTER TABLE agents ADD COLUMN project TEXT`);
      if (!has("ended_at")) db.exec(`ALTER TABLE agents ADD COLUMN ended_at TEXT`);
      // One session agent per seat per device; this is what makes concurrent first requests converge on one row.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agents_device_seat_idx ON agents (device_id, seat_id) WHERE kind = 'session'`);
    },
  },
  {
    version: 9,
    name: "agent_removal",
    // An operator removes an agent (removeAgent in src/service.ts): the row stays so its messages, events and tasks keep
    // their names, but removed_at retires the identity. Its key hash is replaced at the same moment, so its key is dead.
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "removed_at")) db.exec(`ALTER TABLE agents ADD COLUMN removed_at TEXT`);
      if (!columns.some((c) => c.name === "removed_by_agent_name")) db.exec(`ALTER TABLE agents ADD COLUMN removed_by_agent_name TEXT`);
    },
  },
  {
    version: 10,
    name: "computers_tools_projects",
    // Computer -> tools -> project -> sessions (src/devices.ts, src/projects.ts). A device is now a computer: devices.tools
    // lists the tools a connect run set up there (devices.client stays for old rows, informational). A session agent
    // records its tool (agents.client) and its project's display name next to its key (agents.project). Projects are
    // opt-in: a computer joins sessions only in projects whose row is enabled.
    //
    // Existing sessions: only the OpenCadre repository is enabled here, and only in a workspace that already has a live
    // session in it (under the old folder-name key "OpenCadre", or its remote key), so the chats already working on it
    // keep working. Its remote key is enabled with it, so those chats also keep working once their computer reconnects
    // with a CLI that sends remote keys. No other project is enabled: sessions there are refused from their next request.
    up: (db) => {
      const has = (table: string, name: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!has("devices", "tools")) db.exec(`ALTER TABLE devices ADD COLUMN tools TEXT`); // JSON array of tool ids
      if (!has("agents", "client")) db.exec(`ALTER TABLE agents ADD COLUMN client TEXT`);
      if (!has("agents", "project_name")) db.exec(`ALTER TABLE agents ADD COLUMN project_name TEXT`);
      db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT,
  last_seen_at TEXT,
  enabled_at TEXT,
  enabled_by_agent_name TEXT,
  PRIMARY KEY (org_id, project_key)
);
      `);
      const orgs = db.prepare(
        `SELECT DISTINCT org_id FROM agents WHERE kind = 'session' AND ended_at IS NULL AND removed_at IS NULL AND (project = ? OR lower(project) = ?)`,
      ).all(OPENCADRE_LEGACY_PROJECT, OPENCADRE_REPO_PROJECT) as Array<{ org_id: string }>;
      const now = new Date().toISOString();
      const enable = db.prepare(
        `INSERT INTO projects (org_id, project_key, name, enabled, first_seen_at, last_seen_at, enabled_at, enabled_by_agent_name)
         VALUES (?, ?, 'OpenCadre', 1, ?, ?, ?, 'migration')
         ON CONFLICT (org_id, project_key) DO UPDATE SET enabled = 1, enabled_at = excluded.enabled_at, enabled_by_agent_name = excluded.enabled_by_agent_name`,
      );
      for (const { org_id } of orgs) {
        enable.run(org_id, OPENCADRE_LEGACY_PROJECT, now, now, now);
        enable.run(org_id, OPENCADRE_REPO_PROJECT, null, null, now);
      }
    },
  },
  {
    version: 11,
    name: "device_reconnect_merge",
    // Reconnecting a computer updates the same computer (redeemDeviceCode in src/devices.ts): the fresh device row of a
    // code redeemed with that computer's own credential never gets a credential and points at the computer instead.
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "merged_into_device_id")) db.exec(`ALTER TABLE devices ADD COLUMN merged_into_device_id TEXT`);
    },
  },
  {
    version: 12,
    name: "mask_approval_secrets",
    // Clearance records stored whole commands, keys included (src/secrets.ts). Mask the action and details of every
    // existing approval in place: approvals rows aren't hash-chained, and a masked row reads the same to an older build.
    // Events are hash-chained (src/events.ts), so their stored payloads are left as they are and masked on every read.
    up: (db) => {
      const rows = db.prepare(`SELECT id, action, details FROM approvals`).all() as Array<{ id: string; action: string; details: string | null }>;
      const update = db.prepare(`UPDATE approvals SET action = ?, details = ? WHERE id = ?`);
      for (const row of rows) {
        const action = maskSecrets(row.action);
        const details = row.details === null ? null : maskSecrets(row.details);
        if (action !== row.action || details !== row.details) update.run(action, details, row.id);
      }
    },
  },
  {
    version: 13,
    name: "mask_task_secrets",
    // Task text was stored as agents sent it (src/tasks.ts now masks on write and read). Mask each existing task's title,
    // description and completion summary in place: tasks rows aren't hash-chained (only events are). Approvals get a
    // second pass under the same rules, which now also cover unterminated quotes, glued keys and decision notes.
    up: (db) => {
      const mask = (text: string | null) => (text === null ? null : maskSecrets(text));
      const tasks = db.prepare(`SELECT id, title, description, completion_summary FROM tasks`).all() as Array<{ id: string; title: string; description: string | null; completion_summary: string | null }>;
      const updateTask = db.prepare(`UPDATE tasks SET title = ?, description = ?, completion_summary = ? WHERE id = ?`);
      for (const row of tasks) {
        const next = [maskSecrets(row.title), mask(row.description), mask(row.completion_summary)] as const;
        if (next[0] !== row.title || next[1] !== row.description || next[2] !== row.completion_summary) updateTask.run(...next, row.id);
      }
      const approvals = db.prepare(`SELECT id, action, details, decision_note FROM approvals`).all() as Array<{ id: string; action: string; details: string | null; decision_note: string | null }>;
      const updateApproval = db.prepare(`UPDATE approvals SET action = ?, details = ?, decision_note = ? WHERE id = ?`);
      for (const row of approvals) {
        const next = [maskSecrets(row.action), mask(row.details), mask(row.decision_note)] as const;
        if (next[0] !== row.action || next[1] !== row.details || next[2] !== row.decision_note) updateApproval.run(...next, row.id);
      }
    },
  },
  {
    version: 14,
    name: "mask_free_text_secrets",
    // Phase 3 of secret masking (docs/decisions #1789): status text, message bodies (covers messages, questions and
    // replies -- one table) and shared file names, following #169's audit of surfaces that were still unmasked. None
    // of these three tables are hash-chained (only events are), so existing rows are masked in place; each write path
    // now masks on write too (src/service.ts's setAgentStatus/insertMessage/uploadFile), and reads mask again as
    // defense-in-depth. editing_files/file CONTENT/clarification metadata are out of scope, per the decision.
    up: (db) => {
      const agents = db.prepare(`SELECT id, current_task FROM agents WHERE current_task IS NOT NULL`).all() as Array<{ id: string; current_task: string }>;
      const updateAgent = db.prepare(`UPDATE agents SET current_task = ? WHERE id = ?`);
      for (const row of agents) {
        const next = maskSecrets(row.current_task);
        if (next !== row.current_task) updateAgent.run(next, row.id);
      }
      const messages = db.prepare(`SELECT id, body FROM messages`).all() as Array<{ id: string; body: string }>;
      const updateMessage = db.prepare(`UPDATE messages SET body = ? WHERE id = ?`);
      for (const row of messages) {
        const next = maskSecrets(row.body);
        if (next !== row.body) updateMessage.run(next, row.id);
      }
      const files = db.prepare(`SELECT id, filename FROM files`).all() as Array<{ id: string; filename: string }>;
      const updateFile = db.prepare(`UPDATE files SET filename = ? WHERE id = ?`);
      for (const row of files) {
        const next = maskSecrets(row.filename);
        if (next !== row.filename) updateFile.run(next, row.id);
      }
    },
  },
  {
    version: 15,
    name: "project_aliases_and_agent_scope",
    // Project isolation, stamping (docs/design/PROJECT_ISOLATION.md §3.1, §3.2). Records data only; nothing filters on it yet.
    // - project_aliases: a legacy folder-name key (e.g. "OpenCadre") resolves to the one enabled remote key of the same
    //   name, so one repository yields one project key. The legacy projects row stays.
    // - agents.home_project / agents.scope / agent_projects: a session agent's home is the (resolved) project it joined in,
    //   scope 'project'. Named agt_ agents and people get scope 'workspace' (operator decision 1: workspace-wide plus badge).
    // Seats bound to their project need no schema change: a chat's agent in a further project takes its own seat id
    // (src/devices.ts), so the unique (device_id, seat_id) index stays as it is.
    up: (db) => {
      const has = (table: string, name: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === name);
      db.exec(`
CREATE TABLE IF NOT EXISTS project_aliases (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alias_key TEXT NOT NULL,
  project_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, alias_key)
);
CREATE TABLE IF NOT EXISTS agent_projects (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  PRIMARY KEY (agent_id, project_key)
);
      `);
      if (!has("agents", "home_project")) db.exec(`ALTER TABLE agents ADD COLUMN home_project TEXT`);
      if (!has("agents", "scope")) db.exec(`ALTER TABLE agents ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`); // project | projects | workspace

      const legacy = db.prepare(`SELECT org_id, project_key FROM projects`).all() as Array<{ org_id: string; project_key: string }>;
      for (const row of legacy) createLegacyAlias(db, row.org_id, row.project_key);

      db.exec(`UPDATE agents SET scope = 'workspace' WHERE kind != 'session'`);
      db.exec(`UPDATE agents SET scope = 'project', home_project = ${resolvedKeySql("agents.org_id", "agents.project")} WHERE kind = 'session'`);
    },
  },
  {
    version: 16,
    name: "project_stamps",
    // Project isolation, stamping (PROJECT_ISOLATION.md §4). Every row that belongs to a project records it at write time:
    // messages (plus the recipient's project in to_project_key), tasks, approvals, approval_grants, files and events.
    // - Write-once: a trigger refuses any UPDATE of a stamp that is already set; only a NULL stamp can be filled.
    // - Backfill: old rows are stamped from their sender / creator / requester's agents.project through the aliases, and
    //   stay NULL (workspace-level) where nothing can be derived. Events get the column only: their payloads are
    //   hash-chained (src/events.ts), so a backfilled event's stamp isn't tamper-evident, unlike a new event's.
    up: (db) => {
      const has = (table: string, name: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === name);
      for (const table of STAMPED_TABLES) {
        if (!has(table, "project_key")) db.exec(`ALTER TABLE ${table} ADD COLUMN project_key TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS ${table}_project_idx ON ${table} (org_id, project_key)`);
      }
      if (!has("messages", "to_project_key")) db.exec(`ALTER TABLE messages ADD COLUMN to_project_key TEXT`);
      for (const [table, column] of STAMP_COLUMNS) {
        db.exec(`
CREATE TRIGGER IF NOT EXISTS ${table}_${column}_write_once BEFORE UPDATE OF ${column} ON ${table}
WHEN OLD.${column} IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '${table}.${column} is write-once');
END;
        `);
      }
      backfillProjectStamps(db);
    },
  },
  {
    version: 17,
    name: "project_links_and_isolation_setting",
    // Project isolation, enforcement (PROJECT_ISOLATION.md §3.4, §5, §7 item 3).
    // - project_links: an admin links two projects so their agents can talk (communication only). One row per pair, stored
    //   with project_a < project_b, so a link is symmetric and unique.
    // - organizations.project_isolation: enforcement is a workspace setting. Every workspace that exists now keeps today's
    //   behaviour (0); a workspace created from here on starts with it on (createOrganization in src/service.ts).
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS project_links (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_a TEXT NOT NULL,
  project_b TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_agent_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, project_a, project_b),
  CHECK (project_a < project_b)
);
CREATE INDEX IF NOT EXISTS project_links_b_idx ON project_links (org_id, project_b);
      `);
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "project_isolation")) db.exec(`ALTER TABLE organizations ADD COLUMN project_isolation INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 18,
    name: "task_review",
    // A second pair of eyes on completed work, independent of the open/claimed/done lifecycle (src/tasks.ts).
    // completeTask's "done" is only the claimant's own claim that the work is finished; `reviewed` stays 0 until
    // a distinct agent calls acceptTask. rejectTask bounces a done task back to claimed with a note in
    // review_note and clears reviewed, so the claimant can fix and re-complete. Self-review is refused in
    // src/tasks.ts (reviewGuard), not by any constraint here -- the schema has no notion of "who's calling".
    up: (db) => {
      const has = (name: string) => (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!has("reviewed")) db.exec(`ALTER TABLE tasks ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0`);
      if (!has("reviewed_by_agent_id")) db.exec(`ALTER TABLE tasks ADD COLUMN reviewed_by_agent_id TEXT`);
      if (!has("reviewed_by_agent_name")) db.exec(`ALTER TABLE tasks ADD COLUMN reviewed_by_agent_name TEXT`);
      if (!has("reviewed_at")) db.exec(`ALTER TABLE tasks ADD COLUMN reviewed_at TEXT`);
      if (!has("review_note")) db.exec(`ALTER TABLE tasks ADD COLUMN review_note TEXT`);
    },
  },
  {
    version: 19,
    name: "memory_entries",
    // Shared project memory (src/memory.ts): durable, queryable institutional knowledge -- architectural decisions,
    // gotchas, "we tried X and it didn't work" -- that should outlive any one conversation. org-scoped like every
    // other table here; not yet project-stamped (a deliberate first-cut scope call, see src/memory.ts's header comment).
    //
    // Staleness: status ('active' | 'archived') plus an optional archived_reason covers a note an operator just
    // marks stale, and superseded_by additionally names the newer entry when a fresher note replaces an older one
    // outright. Both a manual archive and a supersede set status = 'archived', so every reader has exactly one flag
    // to check to leave an entry out of the default view; superseded_by is extra detail for "what replaced this",
    // not a second source of truth about whether the entry is current. An archived row is never deleted, so it
    // stays reachable by id (get_memory) for anyone tracing why an old approach was abandoned.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tag TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | archived
  archived_reason TEXT,
  superseded_by TEXT REFERENCES memory_entries(id),
  created_by_agent_id TEXT NOT NULL,
  created_by_agent_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS memory_entries_org_status_idx ON memory_entries (org_id, status);
CREATE INDEX IF NOT EXISTS memory_entries_org_tag_idx ON memory_entries (org_id, tag);
      `);
    },
  },
  {
    version: 20,
    name: "escalation_threads",
    // src/escalation.ts: without this, every sweep that crosses a new N/2N/4N threshold opened a brand-new
    // message to each operator, so a backlogged recipient with several distinct stuck messages produced a
    // pile of near-duplicate ESCALATION notices instead of one updating thread. One row per (org, recipient,
    // operator) remembers the thread to reply into; reply() already knows how to answer a thread the system
    // itself started (src/service.ts's "ownSent" fallback), so no messaging changes were needed beyond this.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS escalation_threads (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_agent_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, recipient_agent_id, operator_id)
);
      `);
    },
  },
  {
    version: 21,
    name: "goals",
    // Fleet-wide goal (issue: "/goal"). One row per org -- a singleton, not a history table. Past
    // goals stay recoverable via goal.set events (the tamper-evident timeline), so overwriting here
    // loses no audit trail.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS goals (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  set_by_agent_id TEXT NOT NULL,
  set_by_agent_name TEXT NOT NULL,
  set_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id)
);
      `);
    },
  },
  {
    version: 22,
    name: "task_capabilities",
    // Design retro finding: DeepSeek agents spent real effort producing text specs for another agent
    // to apply, because their bridge only ever exposed hub-coordination tools -- a scoping gap made
    // once, upstream, that surfaced mid-task instead of at assignment time. agents.capabilities is
    // what an agent's own client declares it can actually do (e.g. ["shell", "git-write",
    // "file-write"]); tasks.required_capabilities is what create_task asks for. claim_task
    // (src/tasks.ts) refuses a claim missing a required capability, so the gap is caught at claim
    // time, not discovered five agents deep into "why hasn't this task moved."
    // Both are JSON arrays stored as TEXT (SQLite has no array type); empty/absent means "no
    // declared capabilities" for an agent, or "no requirement" for a task -- so every agent already
    // in the fleet, and every already-open task, keeps working exactly as before this migration.
    up: (db) => {
      const hasAgentsCol = (name: string) => (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!hasAgentsCol("capabilities")) db.exec(`ALTER TABLE agents ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'`);
      const hasTasksCol = (name: string) => (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!hasTasksCol("required_capabilities")) db.exec(`ALTER TABLE tasks ADD COLUMN required_capabilities TEXT NOT NULL DEFAULT '[]'`);
    },
  },
  {
    version: 23,
    name: "resource_locks",
    // Design retro finding: the hub can't provision a git worktree on a remote agent's own machine --
    // that's inherently client-side, out of a multi-tenant server's reach. What the hub CAN give
    // every client (any model, any bridge) is a generic named-resource mutex: claim a string
    // (a path, a branch name, a lockfile, whatever two agents might collide on), get it back if
    // nobody else holds it, release it when done -- same leased-claim shape as tasks.ts (a lease
    // that isn't renewed expires, so a crashed agent can't hold a resource hostage forever). This is
    // the buildable version of "one worktree per task": the coordination primitive that lets any
    // client serialize access to a shared mutable path before mutating it, without the hub ever
    // touching that client's filesystem.
    // resource_key is an opaque string the caller defines (a path, "branch:main", anything) --
    // deliberately not validated as a real filesystem path, since the hub has no filesystem of its
    // own to check it against.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS resource_locks (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL,
  holder_agent_name TEXT NOT NULL,
  note TEXT,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT NOT NULL,
  lease_expiry_emitted_at TEXT,
  PRIMARY KEY (org_id, resource_key)
);
CREATE INDEX IF NOT EXISTS resource_locks_org_expires_idx ON resource_locks (org_id, lease_expires_at);
      `);
    },
  },
  {
    version: 24,
    name: "task_cost_routing",
    // Design retro finding (Stage 1, "cost-aware task routing"): a task that genuinely needs deep,
    // many-round work can land on an agent whose bridge caps tool-calling at a small round budget
    // (MAX_TOOL_ROUNDS), which silently fails mid-task once the cap is hit -- the same shape as the
    // capability gap task_capabilities (migration 22) closes, but for round budget instead of tool
    // access. agents.round_budget is what an agent's own client declares as its configured round cap;
    // tasks.min_round_budget is what create_task asks for. claim_task refuses a claim whose declared
    // budget is below the task's minimum, so a bridge that will silently truncate mid-task never
    // takes it in the first place.
    // Both are nullable INTEGER: NULL means "hasn't declared a budget" (agents) or "no minimum, any
    // budget is fine" (tasks) -- every agent already in the fleet, and every already-open task, keeps
    // working exactly as before this migration.
    up: (db) => {
      const hasAgentsCol = (name: string) => (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!hasAgentsCol("round_budget")) db.exec(`ALTER TABLE agents ADD COLUMN round_budget INTEGER`);
      const hasTasksCol = (name: string) => (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!hasTasksCol("min_round_budget")) db.exec(`ALTER TABLE tasks ADD COLUMN min_round_budget INTEGER`);
    },
  },
  {
    version: 25,
    name: "blackboard_facts",
    // Design retro finding (Stage 2, "a shared blackboard/world-model replacing N^2 point-to-point
    // messaging"): today, a fact two or more agents need (the deploy target, the chosen approach, the
    // current blocker) only exists in whoever's inbox it was sent to -- every other agent either
    // re-asks or re-derives it, and a stale answer from a few messages back looks identical to a
    // fresh one. blackboard_facts is a shared, org-wide key/value store any agent can read without
    // having been on the thread where the fact was decided: one row per (org, key), not a message
    // history, so "what's the answer right now" is always a single read.
    // version is optimistic-concurrency, not an audit log: set_fact can pass expectedVersion so two
    // agents racing to update the same disputed fact don't silently clobber each other -- the loser
    // gets a conflict error naming the current value, instead of the fact silently reverting under
    // them. Every write still emits an event (blackboard.fact_set/fact_deleted), so the full history
    // is recoverable from the tamper-evident timeline the same way goals.set already works.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS blackboard_facts (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  set_by_agent_id TEXT NOT NULL,
  set_by_agent_name TEXT NOT NULL,
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, key)
);
      `);
    },
  },
  {
    version: 26,
    name: "task_adversarial_review",
    // Design retro finding (Stage 2, "redundant adversarial verification on load-bearing claims"):
    // today a task's "done" claim needs exactly one other agent's accept -- fine for routine work,
    // not enough for a claim other work will build on, where one reviewer's blind spot becomes
    // everyone's blind spot. tasks.required_reviews (create_task's requiredReviews, default 1 --
    // every existing/unscoped task behaves exactly as before) is how many DISTINCT agents must
    // accept before the task actually finalizes as reviewed; task_reviews records each individual
    // accept vote (one row per (task, reviewer), so the same reviewer voting twice never counts
    // twice -- redundancy means independent reviewers, not repeated clicks from one).
    // A single reject still bounces the task back immediately, same as before this existed: catching
    // a real problem doesn't need consensus, only confirming "no problem" does. rejectTask/
    // completeTask both clear task_reviews for the task, so a fresh completion round starts with a
    // clean slate, same rationale as the existing reviewed/review_note reset there.
    up: (db) => {
      const hasTasksCol = (name: string) => (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!hasTasksCol("required_reviews")) db.exec(`ALTER TABLE tasks ADD COLUMN required_reviews INTEGER NOT NULL DEFAULT 1`);
      db.exec(`
CREATE TABLE IF NOT EXISTS task_reviews (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_agent_id TEXT NOT NULL,
  reviewer_agent_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, reviewer_agent_id)
);
      `);
    },
  },
  {
    version: 27,
    name: "task_hierarchy",
    // Design retro finding (Stage 2, "hierarchical plan->execute->verify->synthesize as the default
    // task lifecycle, not a one-off script"): today every task is a flat leaf -- decomposing real
    // work into a plan with sub-steps was a convention agents had to invent themselves (a free-text
    // description listing sub-items, with no actual dependency the hub enforces), not something the
    // task model itself understands or checks.
    // tasks.parent_task_id makes a task a subtask of another (create_task's parentTaskId). The
    // hierarchy IS the lifecycle: a parent's own completeTask is blocked while any child isn't both
    // done AND reviewed (src/tasks.ts) -- "synthesize" (the parent's completion) can't happen until
    // every child has gone through its own execute (completeTask) and verify (acceptTask) stages.
    // No depth limit: a subtask can itself have subtasks, the same way a real plan nests.
    up: (db) => {
      const hasTasksCol = (name: string) => (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!hasTasksCol("parent_task_id")) db.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (org_id, parent_task_id)`);
    },
  },
  {
    version: 28,
    name: "agent_api_key_hash_unique",
    // Design retro finding (Stage 3, "per-tenant API keys and agent identities, with impersonation
    // structurally impossible, not policy-enforced"): agents.api_key_hash was NOT NULL but had no
    // uniqueness constraint at all -- two agents (in the same org, or different ones) sharing one
    // hash was prevented only by 192 bits of randomBytes(24) entropy in generateApiKey, never by the
    // schema. That's "practically impossible," which is a different, weaker claim than "structurally
    // impossible": findAgentByHash (src/auth.ts) does a bare SELECT with no ORDER BY, so a collision
    // -- however the row got there (a bug, a restored backup, manual DB surgery) -- would let
    // whichever row SQLite happened to return authenticate as that agent, with no error, no signal,
    // and no way to tell from the API alone that it had happened.
    // Since 192-bit random values never collide in any real dataset, a defensive pass first (there
    // should be nothing to find) breaks any duplicate group by giving every row after the first in
    // each group a fresh, guaranteed-unique placeholder hash -- the same "no real key can hash to
    // this" trick removeAgent already uses (src/service.ts) -- so the unique index below can never
    // fail to apply, on any real database.
    up: (db) => {
      const dupGroups = db.prepare(
        `SELECT api_key_hash FROM agents GROUP BY api_key_hash HAVING COUNT(*) > 1`,
      ).all() as Array<{ api_key_hash: string }>;
      for (const { api_key_hash: hash } of dupGroups) {
        const rows = db.prepare(`SELECT rowid AS rid FROM agents WHERE api_key_hash = ? ORDER BY rowid`).all(hash) as Array<{ rid: number }>;
        for (const { rid } of rows.slice(1)) {
          const placeholder = `dup-break:${randomBytes(32).toString("hex")}`;
          db.prepare(`UPDATE agents SET api_key_hash = ? WHERE rowid = ?`).run(placeholder, rid);
        }
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agents_api_key_hash_idx ON agents (api_key_hash)`);
    },
  },
  {
    version: 29,
    name: "billing_plan_and_trial",
    // Billing Phase 1 (board 425a2e9f, docs/research/PRICING-AND-METERING.md §3.2): a workspace had no
    // plan, no clock and no way to lapse -- every workspace this hub ever created was permanent, which
    // is a fine property for a tool and a fatal one for a product. This adds the three facts the
    // enforcement path reads (src/billing.ts): which plan a workspace is on, when its clock runs out,
    // and what the payment provider says about it.
    //
    // The limits live in a TABLE, not in code, because PRICING-AND-METERING rule 5 is "publish the
    // limits": a cap nobody can read off the product is a cap that gets changed in a deploy nobody
    // reviewed. The two NULL limits below are NULL deliberately -- the published pricing page promises
    // "unlimited agents" on Pro and says nothing at all about history retention, so there is no number
    // to invent here. Filling them in later is one INSERT/UPDATE, not a migration.
    //
    // `trial_days` is also the whole of the non-expiring-plan mechanism, and that is the point of
    // putting it in a row: `internal` has no trial_days, so a workspace on it never gets a
    // trial_ends_at, so the predicate -- which reads the DATE the plan produced, never the org's name
    // -- can never take it read-only. A hardcoded org name in the predicate is exactly the defect
    // class this fleet keeps paying for; a plan row is a fact about the world that survives a rename,
    // and a later migration that expires rows by date cannot reach the fleet's own workspace through it.
    //
    // The backfill grandfathers by MECHANISM rather than by identity: every workspace that exists at
    // the moment this migration runs predates billing, and gets the non-expiring plan. It is scoped to
    // rows that have no clock, so it cannot touch a workspace created after it -- createOrganization
    // (src/service.ts) always writes a real trial_ends_at from the plan's trial_days.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_agents INTEGER,
  retention_days INTEGER,
  trial_days INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
      `);
      db.exec(`
INSERT OR IGNORE INTO plans (key, name, max_agents, retention_days, trial_days) VALUES
  ('trial',    'Trial',    NULL, NULL, 7),
  ('pro',      'Pro',      NULL, NULL, NULL),
  ('team',     'Team',     NULL, NULL, NULL),
  ('internal', 'Internal', NULL, NULL, NULL);
      `);
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "plan")) db.exec(`ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'trial'`);
      if (!columns.some((c) => c.name === "trial_ends_at")) db.exec(`ALTER TABLE organizations ADD COLUMN trial_ends_at TEXT`);
      if (!columns.some((c) => c.name === "subscription_status")) db.exec(`ALTER TABLE organizations ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'active'`);
      db.exec(`UPDATE organizations SET plan = 'internal', trial_ends_at = NULL WHERE plan = 'trial' AND trial_ends_at IS NULL`);
    },
  },
  {
    version: 30,
    name: "billing_customer_ref",
    // Billing Phase 2 increment 2 (board bce5de80). docs/design/SELF-SERVE-BACKEND.md §7 item 1 names
    // this column as the one decision worth locking now: "`billing_customer_ref` is an opaque string;
    // the hub never sees card data, which keeps PCI scope out of this codebase entirely."
    //
    // That is the whole shape. The card lives with the provider, the provider hands back one opaque
    // string, and that string is the only thing this schema stores about a customer's billing
    // relationship -- so there is no column here that could ever hold a PAN, and no code path that
    // would have to be audited as one. The column is NOT the entitlement: it says which provider
    // customer a workspace IS, never what it has paid for. What it has paid for is plan +
    // subscription_status (migration 29), which stay the only inputs to src/billing.ts's predicate.
    //
    // Nullable with no backfill and no default, because absence is the ordinary state: every workspace
    // that has never been through a checkout has no reference, which is nearly every workspace, and a
    // migration that rewrote that many rows would be a migration that could fail on real data.
    //
    // UNIQUE because of what reads it. The webhook (increment 4) arrives carrying only this string and
    // has to resolve the workspace BY it, so a reference held by two workspaces is not a duplicate row
    // -- it is an ambiguous lookup whose failure mode is granting the wrong workspace's plan. Both
    // engines treat NULLs as distinct in a unique index, so many workspaces may hold no reference;
    // partial-index syntax is not needed to get that, and this index deliberately does not use it.
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "billing_customer_ref")) db.exec(`ALTER TABLE organizations ADD COLUMN billing_customer_ref TEXT`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS organizations_billing_customer_ref_idx ON organizations (billing_customer_ref)`);
    },
  },
  {
    version: 31,
    name: "billing_subscription_event",
    // Billing Phase 2 increment 4 (board bce5de80). One column, and it is an ORDERING KEY rather than
    // state: it records the PROVIDER's instant for the last subscription event this hub accepted, so a
    // late-arriving event cannot undo a newer one (src/billing.ts's applySubscriptionEvent).
    //
    // It exists because providers do not promise delivery order and do retry. `customer.subscription.
    // updated {status: active}` can arrive AFTER the `deleted` that superseded it, and without a
    // recorded instant the hub has no way to tell the two apart -- it would simply apply whichever
    // envelope the network handed it last, and a cancellation would silently un-cancel. Arrival time
    // is not a substitute: the whole point is that arrival order is the thing that is wrong.
    //
    // ISO-8601 UTC, so a lexicographic TEXT comparison IS a chronological one. That is why this column
    // is TEXT and not an integer: it matches every other instant this schema stores (trial_ends_at,
    // created_at, the TIMESTAMP_COLUMNS contract in src/db-postgres.ts), and the shape is fixed-width
    // by the standard, so the comparison the guard depends on is total. A stored value that is not
    // ISO-8601 would compare wrongly rather than fail, which is why the writer normalises with
    // `new Date(created * 1000).toISOString()` and never stores the provider's own string.
    //
    // NULLABLE with no backfill, and NULL means "this hub has never accepted a subscription event for
    // this workspace" -- which is true of nearly every row. The guard reads NULL as "anything is
    // newer", so an existing workspace is not frozen out of its own first webhook by a migration that
    // had no instant to give it. There is deliberately NO index: the only query that touches this
    // column filters on the primary key first (WHERE id = ? AND ...), so it is already a single-row
    // lookup and an index here would be a write cost with nothing to buy.
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "billing_event_at")) db.exec(`ALTER TABLE organizations ADD COLUMN billing_event_at TEXT`);
    },
  },
  {
    version: 32,
    name: "plans_table_v2",
    // Build item 1 of docs/planning/PRICING.md §8: the four plans, their per-unit limits, and a 14-day
    // trial. The columns are here rather than in code for the reason migration 29 already gave -- the
    // limits are PUBLISHED, and a cap nobody can read off the product is a cap that gets changed in a
    // deploy nobody reviewed.
    //
    // WHY NOT A RE-SEED, and this is the whole reason this migration has an UPDATE in it. Migration 29
    // seeds these rows with `INSERT OR IGNORE` (see :998). Editing the literal there and letting the
    // same statement run is a NO-OP on every database that has already executed it -- which is every
    // deployed hub -- because the `key` collides and `OR IGNORE` discards the row. A fresh test
    // database has no row, the insert lands, and the test is green. Production keeps the old value.
    // The test passes for the wrong reason and the deploy does nothing. A value that must CHANGE is
    // written (`UPDATE`), never offered (`INSERT`); a row that does not exist yet still needs the
    // INSERT, so this migration does both and each statement is scoped to the state it can fix.
    //
    // THE `WHERE key = 'trial'` IS A CORRECTNESS PROPERTY, NOT TIDINESS. `internal` carries
    // `trial_days = NULL` DELIBERATELY: that NULL is the entire non-expiring mechanism (see migration
    // 29's comment), and its backfill at :1008 grandfathers every pre-billing workspace onto it. An
    // unscoped UPDATE reaching that row would end the fleet's own workspace's permanence -- the exact
    // defect the plan-row design exists to make impossible. Every statement below names its rows.
    //
    // WHAT THIS DOES TO A WORKSPACE ALREADY MID-TRIAL, and why it is an EXTENSION rather than a reset.
    // `trial_ends_at` is COMPUTED AND STORED at creation (src/billing.ts's trialEndsAtFor, called by
    // assignPlan and by createOrganization in src/service.ts), so changing the plan row does NOT move a
    // workspace whose date was already written from the old value. Three populations, and this
    // migration treats them differently ON PURPOSE:
    //
    //   new workspaces  -- get 14 days by construction, because createOrganization reads the plan row.
    //   in-flight       -- EXTENDED to created_at + 14 days, but only ever FORWARD (see the MAX below).
    //   internal        -- not reached. Its trial_days is NULL and its clock is NULL by design; the
    //                      WHERE clauses below name their plan key so it cannot be caught by accident.
    //
    // The extension was ruled by the merger (9d1f) on the honest reading of "the trial is 14 days": a
    // workspace partway through a 7-day trial when this lands was promised a trial, not a duration, and
    // moving it to 14 costs nothing at the time of this change (sign-up is
    // waitlisted). `created_at` is NOT NULL in both engines (migrations.ts's CREATE, and the Postgres
    // schema in src/db-postgres.ts), so the base is always there.
    //
    // IT CANNOT SHORTEN A CLOCK, and that is enforced here rather than assumed: a workspace already more
    // than 14 days past created_at (created before the old clock existed, or set by hand) would have
    // created_at + 14 days in the PAST, and writing that would take a writable workspace read-only --
    // the migration would CAUSE the lapse it is meant to prevent. MAX() against the existing value makes
    // the move monotone, so the only possible effect on any row is a later date or no change.
    up: (db) => {
      // The table is created by migration 29; a database fresh enough to lack it is handled by the
      // INSERT below, so the CREATE is only here so this migration is self-contained if run alone.
      db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_agents INTEGER,
  retention_days INTEGER,
  trial_days INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
      `);

      // Additive columns. SQLite has no "ADD COLUMN IF NOT EXISTS", so each is guarded by a PRAGMA
      // read -- the same shape migrations 29-31 use, and the reason this migration is re-runnable.
      const planColumns = db.prepare(`PRAGMA table_info(plans)`).all() as Array<{ name: string }>;
      for (const column of ["max_machines", "max_projects", "max_workspaces", "max_webhooks"] as const) {
        if (!planColumns.some((c) => c.name === column)) db.exec(`ALTER TABLE plans ADD COLUMN ${column} INTEGER`);
      }

      // The trial plan, and the four limits PRICING.md names for it.
      //
      // `trial_days = 14` HERE IS SUPERSEDED. It cited PRICING.md §2 when written and §2 said 14; the
      // operator ruled the trial to SEVEN days on 2026-09-20 and §2 now says 7, which migration 35
      // writes. This statement is left as it ran -- a migration records what already happened, and
      // editing it would change history on every database that took it -- so the citation is corrected
      // rather than the value. Do not "fix" the 14 here, and do not delete migration 35 on the strength
      // of this line.
      //
      // `retention_days = 14` is NOT superseded: it is the plan's history window rather than the trial
      // clock -- PRICING.md §2 still lists "History and memory kept: 14 days" for Trial, a separate
      // number that happens to share its value. A later reader must not merge the two, and the ruling
      // that moved the trial length deliberately did not touch this one.
      db.prepare(
        `UPDATE plans SET trial_days = 14, max_machines = 3, max_agents = 10, max_projects = 3,
                          max_workspaces = 1, max_webhooks = 1, retention_days = 14
          WHERE key = 'trial'`,
      ).run();

      // Pro and Team: THE CAPS ARE DELIBERATELY NOT WRITTEN, and this is the most important comment in
      // the migration. PRICING.md section 2 says Pro caps live agents at 10. THE LIVE SITE SELLS PRO AT
      // $15 WITH "Unlimited agents across vendors" -- measured on https://opencadre.example, and it is the
      // ONLY numeric plan promise anywhere on that page. Writing max_agents = 10 here would enforce
      // against a customer who bought unlimited, and the refusal would be correct by the planning doc
      // and indefensible to the person reading it. Nothing in the plans table changes that: the promise
      // was published by the site, not by this database.
      //
      // PRICING.md's own rule 5 is "publish the limits: anything that is capped is named on the site",
      // and its rule 2 (as merged) said a cap goes on the page FIRST, then in code. The page still
      // names none of the five caps. So the order is inverted here on purpose: this migration adds the
      // COLUMNS, which refuse nothing, and leaves the capped VALUES to the operator. A column nobody
      // reads cannot refuse a customer; a value can.
      //
      // These statements therefore set ONLY the values that are not a promise anyone has bought:
      // `trial_days` stays NULL (Pro and Team are PAID, so a non-NULL value would make a paying
      // workspace lapse on a date it was never promised), and everything else is left NULL. NULL means
      // UNLIMITED on every limit column here, so today's behaviour against a live customer is exactly
      // what the live page promises -- which is the state to ship in.
      //
      // When the operator rules, the caps go in ONE migration, and public/site/index.html changes in
      // the SAME PR as the code that enforces them. Never earlier: a cap on the site with no enforcement
      // is merely a promise not yet kept, but a cap enforced in code while the promise is still up is
      // the failure FFH9 caught here.
      db.prepare(
        `UPDATE plans SET max_machines = NULL, max_agents = NULL, max_projects = NULL,
                          max_workspaces = NULL, max_webhooks = NULL, retention_days = NULL
          WHERE key = 'pro'`,
      ).run();

      // Team is the same conflict one step further: 25 agents per seat is still a cap, and the site's
      // Team card says "Everything in Pro" -- which, while Pro reads "Unlimited agents", means Team is
      // sold as unlimited too. The per-seat shape of these numbers (5 machines / 25 agents PER SEAT,
      // pooled) is recorded in PRICING.md for whoever writes the enforcement, not here.
      db.prepare(
        `UPDATE plans SET max_machines = NULL, max_agents = NULL, max_projects = NULL,
                          max_workspaces = NULL, max_webhooks = NULL, retention_days = NULL
          WHERE key = 'team'`,
      ).run();

      // Business: $49 per seat, minimum 5. Unlimited on every unit (NULL), 5 workspaces, and the only
      // plan with a machine and agent ceiling that is not a number. `retention_days` NULL is unlimited.
      db.prepare(
        `UPDATE plans SET max_machines = NULL, max_agents = NULL, max_projects = NULL,
                          max_workspaces = 5, max_webhooks = NULL, retention_days = NULL
          WHERE key = 'business'`,
      ).run();

      // The rows themselves, for a database that has never seeded (a fresh install running this
      // migration directly). `internal` is included with every limit NULL, which is the state it must
      // hold: it is the non-expiring plan and no statement here may give it a trial clock.
      //
      // NOTE the trial row alone carries numbers: a trial that ends into read-only is the PUBLISHED
      // behaviour (PRICING.md section 4, and the changelog), and nobody buys a free trial, so its caps
      // cannot contradict a promise. Pro and Team are all NULL for the reason above.
      //
      // THE `14` IN trial_days BELOW IS SUPERSEDED AND MUST NOT BE EDITED. The operator ruled the trial
      // to SEVEN days on 2026-09-20 and migration 35 writes that; this seed keeps 14 because a migration
      // is a record of what already ran and editing it would change history on databases that took it.
      // The net effect on any database, fresh or existing, is 7, because 35 runs after this. Two things
      // follow for whoever reads this next: do not "correct" the 14 here (the seed is INSERT OR IGNORE,
      // so on every database that already seeded, an edit is a silent no-op anyway), and do not delete
      // migration 35 on the strength of this comment. `retention_days` 14 is NOT superseded -- Trial
      // keeps fourteen days of history, a different number that merely shares the value.
      db.exec(`
INSERT OR IGNORE INTO plans (key, name, max_machines, max_agents, max_projects, max_workspaces, max_webhooks, retention_days, trial_days) VALUES
  ('trial',    'Trial',    3,    10,   3,   1, 1,    14,   14),
  ('pro',      'Pro',      NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('team',     'Team',     NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('business', 'Business', NULL, NULL, NULL, 5, NULL, NULL, NULL),
  ('internal', 'Internal', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
      `);

      // EXTEND the clocks of workspaces already inside a trial. Ordering note: this runs AFTER the plan
      // rows are written above, so the 14 it adds is the value this same migration just set -- a
      // database that skipped the UPDATE in the plans table would extend to 7 and this comment would be
      // a lie. Both statements move together or neither does.
      //
      // Three WHERE clauses, each load-bearing:
      //   o.plan = 'trial'                 -- never the internal plan, whose NULL clock is the
      //                                       non-expiring mechanism (migration 29's design).
      //   o.trial_ends_at IS NOT NULL      -- NEVER GRANTS A CLOCK to a row that has none. A workspace
      //                                       with no trial_ends_at is either on a non-expiring plan or
      //                                       a pre-billing row grandfathers backfilled to internal;
      //                                       giving it one here would start a countdown that never
      //                                       existed, which is a lapse this migration invented.
      //   created_at IS NOT NULL           -- defensive; NOT NULL in both engines, but a NULL would
      //                                       make the whole expression NULL and the row would be
      //                                       silently left on 7, which is the failure this migration
      //                                       exists to fix and the worst way to fail it.
      //
      // A REVIEW NOTE SAID THE MAX() IS A REDUNDANT SECOND GUARD, AND THE MEASUREMENT SAYS BOTH GUARDS
      // ARE REDUNDANT -- FOR EVERY ROW THAT CAN EXIST. That is a stronger statement than the note, so
      // it is written here rather than left to be rediscovered. Three mutations were run against this
      // statement on the population the fixture can build (one `internal` row with a NULL clock, one
      // `trial` row with a clock):
      //
      //   1. delete the MAX()                            -> suite GREEN
      //   2. delete `plan = 'trial'`                     -> suite GREEN
      //   3. delete `trial_ends_at IS NOT NULL`          -> suite GREEN
      //   4. delete `plan` AND `IS NOT NULL` together    -> suite GREEN
      //   5. delete the final `trial_ends_at < ...`      -> (the real gate)
      //
      // WHY: the final predicate is the one that decides. For the `internal` row it evaluates against a
      // NULL clock, so the comparison is NULL, so `WHERE NULL` EXCLUDES the row -- and that single
      // clause silently covers for every other clause in this WHERE. `plan = 'trial'` and
      // `trial_ends_at IS NOT NULL` each duplicate a case the final comparison already handles.
      //
      // SO WHICH ARE KEPT, AND WHY: all of them, deliberately, as DEFENCE IN DEPTH rather than as four
      // independent guards. Each clause is individually sufficient AND individually covered; the point
      // of the extras is that a later edit loosening one of them does not silently open the hole it
      // closed. Concretely, and this is the reason not to "simplify" this statement:
      //
      //   - WITHOUT the MAX(), a row whose clock is further out than the target moves BACKWARDS -- a
      //     lapse caused by this migration. The final predicate prevents it today; the MAX() keeps it
      //     from being reachable if that predicate is ever loosened.
      //   - WITHOUT `plan = 'trial'`, `internal` is reachable, and `internal`'s NULL clock is its
      //     PERMANENCE (migration 29's design, and its backfill at :1008 grandfathers every pre-billing
      //     workspace onto it). `MAX(NULL, target)` is `target`, so the MAX() cannot save this case --
      //     it causes it.
      //
      // NO TEST PINS ANY SINGLE CLAUSE, and none can: deleting any one of them leaves the observed
      // behaviour identical. So do not expect a red test to tell you a clause was load-bearing. The
      // assertions in tests/migrations.test.ts pin the OUTCOMES (extended / never shortened / internal
      // untouched), which are the only things observable from outside.
      //
      // `datetime(x, '+14 days')` is SQLite's own arithmetic and returns the same "YYYY-MM-DD HH:MM:SS"
      // shape SQLite's `datetime('now')` writes, which is one of the two shapes src/billing.ts's
      // parseStamp already accepts (it reads a zone-less value as UTC, which is what SQLite's
      // datetime() is).
      db.exec(`
UPDATE organizations
   SET trial_ends_at = MAX(trial_ends_at, datetime(created_at, '+14 days'))
 WHERE plan = 'trial'
   AND trial_ends_at IS NOT NULL
   AND created_at IS NOT NULL
   AND trial_ends_at < datetime(created_at, '+14 days');
      `);
    },
  },
  {
    version: 33,
    name: "billing_subscription_ref",
    // The provider SUBSCRIPTION handle, so a seat change can be applied to the subscription rather than
    // guessed at. Ruled by 9d1f (thread 3c4e0e96) from the provider's own API shape: a subscription
    // UPDATE is addressed by subscription item, and `billing_customer_ref` is NOT an update handle.
    // The id-free alternative -- list the customer's subscriptions and pick -- costs an extra request on
    // every invite and is AMBIGUOUS the moment a customer has two, which is a silent-wrong-bill waiting
    // to happen. src/seat-proration.ts already documents this dependency by name; this is the column it
    // was written against.
    //
    // NULLABLE with no backfill, and NULL is the ordinary value rather than a missing one: most
    // workspaces have never been through a checkout, and a workspace that has is not retroactively
    // known to a provider subscription this hub has never been told about. Null is also the correct
    // answer for a failed checkout: the column records what the PROVIDER last confirmed, never what
    // this hub hoped for, so a proration caller must read NULL as "cannot move this one" rather than as
    // "zero" or "create one".
    //
    // WHY A SECOND COLUMN AND NOT A REPURPOSED ONE: `billing_customer_ref` (migration 30) is the
    // reverse-lookup key a webhook resolves a WORKSPACE by, and it is UNIQUE-indexed for exactly that
    // reason. The subscription ref is not a lookup key for anything -- it is an effect handle -- and
    // giving it the customer column's index would be a constraint that means nothing. Two columns, two
    // jobs, and the webhook is the only writer of both.
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "billing_subscription_ref")) {
        db.exec(`ALTER TABLE organizations ADD COLUMN billing_subscription_ref TEXT`);
      }

      // THE BUSINESS PLANS ROW. Migration 32 already writes it (its INSERT covers all five plans), so
      // this is a no-op on every database that ran 32 -- and that is precisely why it is written as an
      // UPDATE-converging statement rather than as another INSERT OR IGNORE: a re-offered row is
      // discarded by the collision (the trap migration 32's comment documents), so a database that
      // somehow lacks the row needs it CREATED, and one that has it needs its limits CONFIRMED.
      //
      // Business is $49/seat, minimum 5 seats, and is the ONE plan whose machine and agent ceilings are
      // genuinely unlimited (NULL). Its 5 workspaces is the only numeric limit it carries. `trial_days`
      // stays NULL -- Business is PAID, and a non-NULL trial clock here would lapse a paying workspace
      // on a date it was never promised.
      //
      // Insert-if-absent, then set the values, so both states converge without an `OR IGNORE` that can
      // silently skip the second half.
      db.prepare(
        `INSERT INTO plans (key, name, max_machines, max_agents, max_projects, max_workspaces, max_webhooks, retention_days, trial_days)
         SELECT 'business', 'Business', NULL, NULL, NULL, 5, NULL, NULL, NULL
          WHERE NOT EXISTS (SELECT 1 FROM plans WHERE key = 'business')`,
      ).run();
      db.prepare(
        `UPDATE plans SET name = 'Business', max_machines = NULL, max_agents = NULL, max_projects = NULL,
                          max_workspaces = 5, max_webhooks = NULL, retention_days = NULL, trial_days = NULL
          WHERE key = 'business'`,
      ).run();
    },
  },
  {
    version: 34,
    name: "billing_grace",
    // RENUMBERED 33 -> 34 while this PR was open: e617's #442 (the subscription handle and the business
    // plans row) claims 33 and was ahead of this one in the merge queue. Two branches must never both
    // land the same version -- the runner records applied versions in schema_migrations, so the second
    // to arrive would be treated as already applied and its `up` would NEVER RUN on any database that
    // took the first. The column would silently not exist in production while every fresh test database
    // had it, which is the failure mode migration 32's comment (the re-seed trap) describes one layer
    // over. Version numbers are a claim about ORDER, so the one that lands later takes the later number.
    //
    // PRICING.md §8 item 5 (the lapse half) and §4's promise: "Payment fails -> Stripe retries
    // automatically and emails them; EVERYTHING KEEPS WORKING FOR 7 DAYS".
    //
    // WHAT WAS WRONG BEFORE THIS COLUMN. `workspaceBilling` decided read-only from `subscription_status`
    // ALONE (see migration 29's ENTITLED_STATUSES), so the moment a provider reported `past_due` the
    // workspace went read-only -- immediately, contradicting the seven days §4 sells. The predicate had
    // no way to express "not entitled YET, but still inside the grace", because grace is a fact about
    // TIME and the row held no time at which the lapse began.
    //
    // WHY NOT REUSE `billing_event_at`. That column (migration 31) is an OUT-OF-ORDER GUARD: it holds
    // the provider's event time and every later event overwrites it, including the one that restores
    // entitlement. So it cannot answer "when did this lapse start" -- by the time you could read it, it
    // describes the most recent event, not the lapse. A value that must not move needs its own column.
    //
    // NULL MEANS "NOT LAPSED", and that is the only meaning it carries: it is set on the transition
    // INTO a non-entitled status and CLEARED when entitlement returns (`assignPlan` and a recovered
    // subscription both clear it). A workspace that is entitled having a stale `lapsed_at` would be a
    // contradiction the predicate would have to special-case; clearing it makes the invariant "non-NULL
    // implies currently non-entitled" true by construction, so the grace window can be computed from
    // this one value without consulting the status again.
    //
    // ADDITIVE AND NULLABLE, so every existing workspace reads as "not lapsed" and nothing changes
    // behaviour until a real lapse is recorded. Mirrored in src/db-postgres.ts (the guard test enforces
    // the mirror). No backfill is possible or wanted: the hub has never recorded a lapse time, so
    // inventing one would be fiction -- the worst a missing value can do is start a grace window at the
    // next event, which is the conservative direction (see workspaceBilling's comment).
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "lapsed_at")) db.exec(`ALTER TABLE organizations ADD COLUMN lapsed_at TEXT`);
    },
  },
  {
    version: 35,
    name: "trial_back_to_seven_days",
    // THE TRIAL IS SEVEN DAYS. Operator ruling, 2026-09-20, given directly: "It's 7 days".
    //
    // Migration 32 set `trial_days = 14` and PRICING.md §2 published it, but the length of a free trial
    // is a PRICING DECISION, and pricing is the operator's to make -- AGENTS.md puts paying, terms and
    // the commercial calls on the operator, not on a lane. No agent had the authority to move it, and
    // this migration puts it back rather than leaving the hub granting a term nobody sold.
    //
    // `retention_days` IS NOT TOUCHED, and migration 32's own comment is why: Trial keeps 14 days of
    // history and memory, which is a DIFFERENT number that merely shares the value 14. Setting both
    // from one ruling about "the trial" is exactly the merge that comment warned the next reader not to
    // make, so this statement names one column and only one.
    //
    // EXISTING CLOCKS ARE LEFT ALONE -- DELIBERATELY, AND THE OPERATOR SHOULD READ THIS ONE.
    // Migration 32 also EXTENDED `trial_ends_at` on trials already running, by the difference between
    // the two lengths. This migration does not reverse that, because reversing it SHORTENS a clock that
    // is already ticking, and shortening a customer's trial is the destructive direction: it needs the
    // operator's word, not an agent's inference from a sentence about the default.
    //
    // What that means concretely at the next deploy: a database that has not yet applied migration 32 (it may be
    // well behind) will run 32 and 35
    // back to back in the same deploy -- 32 extends the trials it finds, 35 sets the plan row to 7, and
    // the extension it just granted stays. New workspaces get 7. Workspaces already mid-trial at that
    // deploy keep 14, and no customer ever observes the 14 as an advertised term because the two
    // migrations are not separated by a running hub. If the operator wants those extended clocks pulled
    // back to 7 as well, that is a second migration and a separate decision, and it is the only part of
    // this ruling left unimplemented.
    up: (db) => {
      db.prepare(`UPDATE plans SET trial_days = 7 WHERE key = 'trial'`).run();
    },
  },
  {
    version: 38,
    name: "session_liveness",
    // 38, not 35/36/37: measured at open, main carried up to 34, and #458 and #455 claim 35 and 36. The
    // discipline is migration 34's own comment -- versions are a claim about ORDER, so the branch that
    // lands later takes the later number, and two branches must never land the same one (the runner
    // records applied versions, so the second would be silently skipped and its column would not exist
    // in production while every fresh test database had it).
    //
    // THE PHANTOM PROBLEM, measured (docs/design/HARNESS-CODEX.md §5.2A, board c7679423): Codex spawns
    // the MCP proxy eagerly -- three times per app start with ZERO chats open (four such processes
    // against the control shape of two launches and two threads) -- and each spawn mints a session row
    // for a chat that does not exist. Those rows are not merely clutter: mail routed to one is accepted
    // and never read, because nothing is behind it.
    //
    // WHY THE ROW IS STILL CREATED, which is the whole design and was ruled twice. The obvious fix --
    // resolve-only until a tool call is served -- was built, measured to work, and REJECTED: the proxy
    // is the only per-chat creator a device-connected session has, and the wake hook is resolve-only and
    // treats `no_session` as a silent no-op, so a chat that opens, idles and waits for mail makes no
    // tool call and would get NO row, no name and no watcher, silently. Ruling #16116 stands: create at
    // initialize as today, and make the row DISTINGUISHABLE instead of suppressing it.
    //
    // SO THIS COLUMN IS A LABEL THAT MOVES, and its two transitions are the whole contract:
    //   - written `process` at mint -- the row exists because a proxy started, and nothing more;
    //   - PROMOTED to `chat` on the first `tools/call`, which is the one signal a phantom never
    //     produces (measured: all four phantoms had zero tool-call rows; 8 of 13 real chats had them,
    //     up to 2,537).
    // `chat` is a claim that something is behind the row. `process` is a claim about a process, and it
    // is deliberately not a claim that anything is wrong: an idle chat that has not yet called a tool
    // is `process` too, which is why the label must never be read as "dead" -- only as "not yet proven".
    //
    // NOT CALLED `scope` (that is project visibility, `project | projects | workspace`) and not folded
    // into `kind` (`named | session`, which is how the row was created, not whether a chat is behind
    // it). Those two names are taken and mean something else; the design doc recorded that trap.
    //
    // NULL MEANS UNKNOWN, and it is the safe default in the direction that matters: every pre-existing
    // row reads as NULL rather than being back-filled to one of the two labels. Inventing `chat` for
    // rows nobody measured would be fiction; inventing `process` would mark real chats as unproven. A
    // reader that needs the distinction treats NULL as "not measured", which is exactly what it is.
    //
    // THE BLIND SPOT, named because an unwritten one is a defect and a written one is a limitation:
    // **a Codex chat whose only traffic is HOOK traffic stays 'process' for its whole session.** The
    // proof this label accepts is a `tools/call` — the one signal a phantom never produces — and only
    // the MCP proxy can assert it, because only the proxy sees the JSON-RPC method. A hook carries the
    // chat's id but no such proof, so the hook's adoption path deliberately does NOT promote (see the
    // comment at that site in src/devices.ts). The console will group such a chat as a background
    // process.
    //
    // MEASURED 2026-09-20 so the size of this is not a guess: of 13 chat-shaped processes in this
    // machine's Codex log, **1** had zero tool-call rows — the other four with none were `thread/start`
    // probes with 5-9s spans, not chats. It is an UNDER-claim and it fails safe: a chat labelled
    // 'process' is wrong in the direction that costs a grouping, whereas treating a hook as proof would
    // widen 'chat' to mean "something happened" on every row, permanently, to fix a mislabel on a rare
    // one. That is the ruling's reason: a precise label with a named blind spot beats a vague label
    // with none.
    //
    // ADDITIVE AND NULLABLE, so nothing changes behaviour until a proxy writes the label. Mirrored in
    // src/db-postgres.ts (the guard test enforces the mirror).
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "liveness")) db.exec(`ALTER TABLE agents ADD COLUMN liveness TEXT`);
    },
  },
  {
    version: 39,
    name: "task_supersession",
    // 39, read from the PUSHED BLOB at the moment of writing rather than carried over: main carries up to
    // 38, and #455/#458 claim 36 and 37. Versions are a claim about ORDER, and two branches must never
    // land the same one — the runner records applied versions, so the second would be silently skipped
    // and its column would not exist in production while every fresh test database had it.
    //
    // THE PROBLEM THIS EXISTS FOR, measured rather than relayed: ~26 of the ~80 open board rows are
    // CORRECTION / DELTA / CLOSURE records filed AGAINST other rows. Every one names the same cause in
    // its own body — "there is no `update_task` in src/tasks.ts" — and that absence is VERIFIED, not
    // assumed: ten exports, no amend path, every `UPDATE tasks` statement is lease/status mechanics.
    //
    // THE FIX IS NOT `update_task`, and this column is what makes the alternative work. Editing a filed
    // task would rewrite a record of what someone actually filed — the failure this fleet ruled against
    // four separate times in one night (a recorded transcript, a migration body, five published verdict
    // comments, a superseded runbook section). **The lanes' instinct is right: a correction SHOULD be its
    // own record.** What was missing is that nothing LINKED them, so a reader had to reconcile a chain by
    // scanning titles and could silently miss one: `859bd42f` needs `0421c06a` AND `2d7df1df` to be read
    // correctly, and `3f75ad96` carries THREE corrections each amending the last.
    //
    // THE PRECEDENT IS IN THIS CODEBASE AND THIS MIRRORS IT RATHER THAN INVENTING A SHAPE:
    // `memory_entries.superseded_by` (migration 22, `:723`) plus `supersedeMemory` (src/memory.ts) —
    // which creates the replacement AND marks the old row superseded, in ONE transaction, and REFUSES
    // when the target is unknown or already superseded, "because re-superseding a superseded note would
    // silently rewrite history".
    //
    // WHY THE COLUMN IS ON THE OLD ROW AND NOT THE NEW ONE. `superseded_by` is written on the row being
    // replaced, so the link is discoverable from the row a reader already has open — which is the whole
    // requirement: a reader who opens the superseded row must be pointed at what replaced it. A
    // `supersedes` pointer on the NEW row would only work for a reader who already found the new row,
    // i.e. only for a reader who did not need it.
    //
    // NULL MEANS "NOT SUPERSEDED" and it is the only meaning, matching the memory precedent: every
    // pre-existing row reads as NULL, no back-fill is possible (nothing recorded which rows were
    // corrected by which), and inventing links would be fiction. Unlike the liveness label, a NULL here
    // is not "unknown" — the absence of a supersession IS the fact, so NULL is a positive answer rather
    // than a gap, which is why this column needs no separate "not measured" state.
    //
    // ADDITIVE AND NULLABLE, so nothing changes behaviour until a task is explicitly superseded. Mirrored
    // in src/db-postgres.ts (the guard test enforces the mirror).
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "superseded_by")) db.exec(`ALTER TABLE tasks ADD COLUMN superseded_by TEXT`);
    },
  },
  {
    version: 40,
    name: "plan_caps",
    // THE CAPS THEMSELVES, held back from migration 32 on purpose and released here.
    //
    // Migration 32 added the six limit COLUMNS and wrote pro and team as NULL (unlimited), because the
    // live site sold Pro at $15 with "Unlimited agents across vendors" and writing a cap there would have
    // refused a customer who had bought that. NULL was the honest value while the promise was still up.
    //
    // THIS MIGRATION IS THE RELEASE, and it is paired with the site's pricing page publishing every one of
    // these numbers in the SAME merge batch. That pairing is not tidiness: a cap enforced in code while
    // the promise is still up is the exact failure this pair exists to avoid, and it is worth less than
    // nothing to have the code right and the page wrong. If this migration lands without that page, the
    // bug is the ORDER, not the numbers.
    //
    // A SEPARATE MIGRATION RATHER THAN AN EDIT TO 32, for the same reason 32 exists rather than an edit to
    // 29: 32 has already run on every deployed hub, so changing its body would change nothing there while
    // a fresh database would get the new values -- the drift where the test and the deployment disagree,
    // with the test looking green.
    //
    // VALUES come from PRICING.md section 2, read at the ref this branch was cut from. Team's machine and
    // agent limits are stored PER SEAT and pooled by the enforcement path (PER_SEAT_LIMITS), so 5 and 25
    // are per-seat figures, not totals -- storing a pre-multiplied total would be wrong the moment someone
    // invites or removes a teammate.
    //
    // `trial` IS NOT TOUCHED. It already carries its numbers from migration 32 (3/10/3/1/1, 14 days) and
    // they were enforced in the gates PR. Re-writing them here would be a second source of truth for the
    // same values, which is how one of them ends up stale.
    //
    // `internal` IS NOT TOUCHED AND MUST NEVER BE: every limit NULL is what makes it uncapped, and its
    // NULL trial clock is its permanence. Every statement below names its rows.
    up: (db) => {
      // Pro: $15, one seat. 3 machines, 10 live agents, 5 projects, 1 workspace, 90 days, 2 webhooks.
      db.prepare(
        `UPDATE plans SET max_machines = 3, max_agents = 10, max_projects = 5,
                          max_workspaces = 1, max_webhooks = 2, retention_days = 90
          WHERE key = 'pro'`,
      ).run();

      // Team: $25 per seat, minimum 2 seats. Machines and live agents are PER SEAT and pooled; projects
      // and history are unlimited (NULL). 1 workspace, 10 webhooks.
      db.prepare(
        `UPDATE plans SET max_machines = 5, max_agents = 25, max_projects = NULL,
                          max_workspaces = 1, max_webhooks = 10, retention_days = 365
          WHERE key = 'team'`,
      ).run();

      // Business is unchanged and deliberately NOT written: it is unlimited on machines, agents, projects,
      // webhooks and history, with 5 workspaces -- which is what migration 32 already set. A statement
      // here would be a second writer of the same row for no change.
    },
  },
    // 41, NOT 36 -- RENUMBERED ON REBASE. This block was written as 36 when the branch was cut against a
    // stale main. Measured at the rebase base: main runs ...34 35 38 39 40, and 36 is STILL HELD by the
    // open #455 (read_only_since), so 36 was never available to take. Versions are a claim about ORDER
    // (migration 34's own comment), so the branch that lands later takes the later number.
    //
    // KEEP THIS BLOCK LAST IN THE ARRAY. assertOrdered walks SOURCE ORDER, not sorted version order: a 41
    // placed above 38/39/40 throws at startup. Verified by tsc and the suite rather than by inspection.
  {
    version: 41,
    name: "founding_offer",
    // The founding offer (PRICING.md:37): "$10 / month locked for the first 100 customers, while they stay
    // subscribed". Two facts, and they are different KINDS of fact:
    //
    //   founding_places_taken   how many places the promise has consumed, GLOBAL rather than per workspace.
    //                           The whole offer is "the first 100 CUSTOMERS", so the count cannot live on a
    //                           workspace row -- it is a property of the offer, not of any one buyer.
    //   organizations.founding_at   when THIS workspace became one of them. NULL is the ordinary value and
    //                           means "not founding", which is true of nearly every row. It is an INSTANT
    //                           rather than a boolean because a boolean records that something happened and
    //                           this one is worth knowing WHEN -- support will be asked, and "they were
    //                           customer number N" is the answer to most questions about a founding price.
    //
    // WHY THE COUNT IS IN THE HUB AND NOT AT THE PROVIDER, ruled by the merger: a customer is only known to
    // be founding at checkout time, so the count has to be decided where the checkout starts. A provider-side
    // promotion cap is worth adding as belt-and-braces, but it would be a cap this repo cannot read and
    // therefore cannot test, and the hub must be the one that can refuse.
    //
    // A ONE-ROW TABLE rather than a column somewhere, because there is no existing row that means "the
    // offer", and putting the count on `plans` or on a workspace would be fiction: the limit is 100
    // customers across the whole hub, whatever plan they are on and however many workspaces they have.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS founding_places (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  taken INTEGER NOT NULL DEFAULT 0
);
      `);
      // The single row, created here rather than assumed. `INSERT OR IGNORE` is correct FOR THIS TABLE and
      // not the trap migration 32 documents: this row's whole content IS its initial value (zero taken), it
      // is never re-seeded with a different number, and a database that already has it must keep whatever
      // count it has. There is no value to change, so there is nothing for OR IGNORE to swallow.
      db.exec(`INSERT OR IGNORE INTO founding_places (id, taken) VALUES (1, 0)`);

      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "founding_at")) db.exec(`ALTER TABLE organizations ADD COLUMN founding_at TEXT`);
    },
  },
  {
    version: 42,
    name: "events_subject_index",
    // One subject's history (GET /v1/events?subjectType=task&subjectId=...): the console's task history reads it on
    // every open, and without this index each read scans the workspace's whole event stream.
    up: (db) => {
      db.exec(`CREATE INDEX IF NOT EXISTS events_subject_idx ON events (org_id, subject_type, subject_id, seq)`);
    },
  },
  {
    version: 43,
    name: "oauth_connector",
    // The MCP connector (docs/design/MCP-CONNECTOR.md): registered OAuth clients, single-use authorization codes and the
    // access/refresh tokens, all stored as hashes. A token row names its family (one approval) so a reused refresh
    // token can revoke the whole family, and its resource, so /mcp can check the audience.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  person_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  spent_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family_idx ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_agent_idx ON oauth_tokens (agent_id);
      `);
    },
  },
  {
    version: 44,
    name: "namespaced_shared_state",
    // Project isolation reaches the four stores that were workspace-wide: the goal, facts, resource locks and memory
    // (src/scope.ts namespacesOf). Each row gets a namespace, `scope_key`: '' is shared with every project, a project
    // key is that project's own. The goal, facts and locks need it in their primary key, and migrations stay additive
    // (a rollback runs the previous image against this schema), so they move to new *_ns tables rather than rebuilding
    // the old ones: the old tables are left as they were, so a rolled-back image still reads and writes them. Memory
    // keeps its id key and just gains the column.
    //
    // Every existing row starts shared (''), which is exactly today's behaviour. Then, in workspaces that already keep
    // projects apart, rows a project agent wrote move into its project (classifySharedState), so turning this on can't
    // leave one project's goal and facts in front of another's agents.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS goals_ns (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  set_by_agent_id TEXT NOT NULL,
  set_by_agent_name TEXT NOT NULL,
  set_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, scope_key)
);
INSERT OR IGNORE INTO goals_ns (org_id, scope_key, text, set_by_agent_id, set_by_agent_name, set_at, updated_at)
  SELECT org_id, '', text, set_by_agent_id, set_by_agent_name, set_at, updated_at FROM goals;

CREATE TABLE IF NOT EXISTS blackboard_facts_ns (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  set_by_agent_id TEXT NOT NULL,
  set_by_agent_name TEXT NOT NULL,
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, scope_key, key)
);
INSERT OR IGNORE INTO blackboard_facts_ns (org_id, scope_key, key, value, version, set_by_agent_id, set_by_agent_name, set_at, updated_at)
  SELECT org_id, '', key, value, version, set_by_agent_id, set_by_agent_name, set_at, updated_at FROM blackboard_facts;

CREATE TABLE IF NOT EXISTS resource_locks_ns (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL DEFAULT '',
  resource_key TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL,
  holder_agent_name TEXT NOT NULL,
  note TEXT,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT NOT NULL,
  lease_expiry_emitted_at TEXT,
  PRIMARY KEY (org_id, scope_key, resource_key)
);
INSERT OR IGNORE INTO resource_locks_ns (org_id, scope_key, resource_key, holder_agent_id, holder_agent_name, note, acquired_at, lease_expires_at, lease_expiry_emitted_at)
  SELECT org_id, '', resource_key, holder_agent_id, holder_agent_name, note, acquired_at, lease_expires_at, lease_expiry_emitted_at FROM resource_locks;
CREATE INDEX IF NOT EXISTS resource_locks_ns_org_expires_idx ON resource_locks_ns (org_id, lease_expires_at);
      `);
      const memoryColumns = db.prepare(`PRAGMA table_info(memory_entries)`).all() as Array<{ name: string }>;
      if (!memoryColumns.some((c) => c.name === "scope_key")) db.exec(`ALTER TABLE memory_entries ADD COLUMN scope_key TEXT NOT NULL DEFAULT ''`);
      db.exec(`CREATE INDEX IF NOT EXISTS memory_entries_org_scope_idx ON memory_entries (org_id, scope_key)`);
      const kept = db.prepare(`SELECT id FROM organizations WHERE project_isolation = 1`).all() as Array<{ id: string }>;
      for (const { id } of kept) classifySharedState(db, id);
    },
  },
  {
    version: 45,
    name: "email_sends",
    // The transactional email ledger (src/emails.ts): one row per (workspace, email kind, period), so each email is sent
    // at most once. The row is CLAIMED before the send (INSERT OR IGNORE, and the send happens only if the insert created
    // it), so two triggers racing, a re-delivered webhook or a sweep running twice cannot mail the owner twice; a crash
    // mid-send leaves a 'pending' row the sweep retries under the same provider idempotency key, never a second email.
    // `period` is what makes a repeat legitimate: the trial's end instant, the lapse's start instant, 'once' for the
    // welcome. A new table only, so a rolled-back image simply never reads it.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS email_sends (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  provider_message_id TEXT,
  last_error TEXT,
  -- The exact request (JSON: from, to, subject, html, text), frozen at the first request to the provider, so a retry
  -- under the same idempotency key sends a byte-identical body.
  payload TEXT,
  -- Set by the first attempt whose outcome is unknown (5xx, timeout, network): from then on the email may have been
  -- delivered, so a retry is safe only inside the provider's 24-hour idempotency window.
  ambiguous_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (org_id, kind, period)
);
CREATE INDEX IF NOT EXISTS email_sends_due_idx ON email_sends (status, next_attempt_at);
      `);
    },
  },
  {
    version: 46,
    name: "paddle_billing",
    // RENUMBERED 45 -> 46 on merging main: #634 took 45 for email_sends.
    // Billing moves to the payment provider (Merchant of Record), operator decision 2026-09-28. ADDITIVE ONLY: nothing is dropped
    // and no existing value is rewritten, so a rolled-back image still reads every column it knew, and a database whose
    // workspaces hold Stripe-era refs (`billing_customer_ref` cus_…, `billing_subscription_ref` sub_…) migrates
    // without touching them. No Stripe key was ever configured in production, so those columns are empty there; on any
    // other database they simply stop being read.
    //
    // WHY NEW REF COLUMNS rather than reusing the Stripe-era ones:
    //   - `billing_customer_ref` is UNIQUE (migration 30), and a the payment provider customer is one per EMAIL: an owner who pays for
    //     two workspaces is one the payment provider customer with two subscriptions. Reusing the column would refuse the second
    //     workspace's binding on the index. `provider_customer_id` is deliberately NOT unique.
    //   - A stale Stripe id left in a reused column would be sent to the payment provider as a customer or subscription id.
    //
    // `billing_provider` names the provider AND environment the refs came from ("paddle-sandbox" / "paddle-live"). A ref
    // is used only when its tag equals the hub's current one -- the equivalent of Stripe's livemode guard, since the payment provider
    // webhook payloads carry no environment field. Switching a hub from sandbox to live therefore cannot send a
    // sandbox customer to the live API or let a sandbox purchase entitle a workspace.
    //
    // `billing_checkouts` is every checkout transaction the hub created, recorded BEFORE its id is returned to the
    // browser. It is how a subscription is attributed to a workspace (subscription.created carries the transaction id
    // that caused it, and a transaction nobody here created attributes nothing), and it is the durable, server-side
    // pending state: a checkout the provider reports as paid is "pending" until the subscription is applied, however
    // long that takes, and no timer ends it.
    //
    // `billing_webhook_events` makes the webhook idempotent on the payment provider's `event_id` ("Use this to deduplicate events
    // you may receive more than once", https://developer.paddle.com/webhooks/about/how-webhooks-work).
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      for (const column of ["billing_provider", "provider_customer_id", "provider_subscription_id"]) {
        if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE organizations ADD COLUMN ${column} TEXT`);
      }
      db.exec(`
CREATE INDEX IF NOT EXISTS organizations_provider_subscription_idx ON organizations (provider_subscription_id);
CREATE TABLE IF NOT EXISTS billing_checkouts (
  transaction_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  plan TEXT NOT NULL,
  billing_interval TEXT NOT NULL,
  founding INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS billing_checkouts_org_idx ON billing_checkouts (org_id, created_at);
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL
);
      `);
    },
  },
  {
    version: 47,
    name: "paddle_billing_mirror",
    // What the payment provider is billing, mirrored on the workspace and written by the SAME guarded statement as the status
    // (src/billing.ts writeProviderSubscription), so the mirror can never describe a different event than the status:
    //   provider_price_id        the price being billed (the one the plan was read from); kept even when it maps to no
    //                            plan, so an operator can see WHICH price a `price_unmapped` workspace is on
    //   provider_quantity        the billed quantity of that price (seats)
    //   scheduled_change_action  a pending "cancel" / "pause" / "resume", NULL when none is scheduled
    //   scheduled_change_at      when it takes effect (full-precision RFC 3339, like billing_event_at)
    //   provider_customer_email  the the payment provider customer's email, from customer.created / customer.updated
    // Additive only: a rolled-back image never reads them. NULL is the ordinary value (never checked out).
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      const add: Array<[string, string]> = [
        ["provider_price_id", "TEXT"],
        ["provider_quantity", "INTEGER"],
        ["scheduled_change_action", "TEXT"],
        ["scheduled_change_at", "TEXT"],
        ["provider_customer_email", "TEXT"],
      ];
      for (const [column, type] of add) {
        if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE organizations ADD COLUMN ${column} ${type}`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS organizations_provider_customer_idx ON organizations (provider_customer_id)`);
    },
  },
  {
    version: 48,
    name: "paddle_customer_email_signal",
    // `provider_customer_email_error_at`: when reading the the payment provider customer's email last FAILED (at the first binding, or
    // a reconcile retry), NULL otherwise. the payment provider creates the customer during checkout, so customer.created usually
    // arrives before any workspace holds that customer and is recorded without a write; the binding then reads the
    // customer itself. A failed read must not fail the binding (the email grants nothing), so this column is its
    // durable, queryable trace, and the reconcile path retries every bound workspace whose email is still NULL.
    // Additive only.
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "provider_customer_email_error_at")) {
        db.exec(`ALTER TABLE organizations ADD COLUMN provider_customer_email_error_at TEXT`);
      }
    },
  },
  {
    version: 49,
    name: "card_required_trial",
    // The CARD-REQUIRED 7-day trial (operator decision 2026-09-29): a new workspace starts its trial THROUGH the payment provider
    // checkout, on a price with a 7-day `trial_period` that requires a payment method, and the payment provider bills it when the trial
    // ends unless it is canceled first. Additive only; no existing value is rewritten, so every workspace that exists
    // today keeps exactly the clock it has (the cardless hub trial, or `internal`).
    //
    //   plans row `pending`      "No plan yet": where a new workspace waits until its trial starts (src/billing.ts
    //                            PENDING_PLAN). Every enforced limit is 0, so the EXISTING gates (agent keys, connect
    //                            redemption, computers, projects) refuse it for everyone, operators included, until a
    //                            subscription is trialing or active; `trial_days` NULL, so no hub clock ever runs on it.
    //   trial_used_at            when this workspace's the payment provider trial started (the first subscription state observed as
    //                            `trialing`, or on a trial price). One trial per workspace.
    //   first_paid_at            when this workspace first COMPLETED a payment (a transaction.completed with a non-zero
    //                            total, or a subscription the payment provider reports active after its first bill). A past_due on a
    //                            workspace that used a trial and has never paid gets no grace: otherwise the 7-day trial
    //                            would become 14 free days.
    //   provider_next_billed_at  the payment provider's `next_billed_at`, mirrored by the same guarded statement as the status. For a
    //                            trialing subscription it is the instant the trial converts, which the console shows and
    //                            the trial-ending email is timed against.
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(organizations)`).all() as Array<{ name: string }>;
      for (const column of ["trial_used_at", "first_paid_at", "provider_next_billed_at"]) {
        if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE organizations ADD COLUMN ${column} TEXT`);
      }
      // Insert-if-absent, then converge the values (the pattern migration 33 uses for `business`).
      db.prepare(
        `INSERT INTO plans (key, name, max_machines, max_agents, max_projects, max_workspaces, max_webhooks, retention_days, trial_days)
         SELECT 'pending', 'No plan yet', 0, 0, 0, 1, 0, NULL, NULL
          WHERE NOT EXISTS (SELECT 1 FROM plans WHERE key = 'pending')`,
      ).run();
      db.prepare(
        `UPDATE plans SET name = 'No plan yet', max_machines = 0, max_agents = 0, max_projects = 0, max_workspaces = 1,
                          max_webhooks = 0, retention_days = NULL, trial_days = NULL
          WHERE key = 'pending'`,
      ).run();
    },
  },
  {
    version: 50,
    name: "trial_per_person",
    // ONE FREE TRIAL PER PERSON (operator policy 2026-09-29), made DURABLE. Migration 49's markers live on the workspace,
    // and "who owns it" is a live role: a person could add another owner, step down, and look like someone who never
    // trialed. So the history moves onto the PERSON, where no role change or removal can reach it. Additive only.
    //
    //   people.trial_used_at                 when this person's first the payment provider trial started: stamped for every owner of the
    //                                        workspace at that moment, its creator, and whoever started its checkout.
    //                                        Never cleared.
    //   organizations.created_by_person_id   the person who created the workspace (self-serve sign-up). The "one live
    //                                        trial" and "one unstarted workspace" checks key on it as well as on current
    //                                        ownership, so handing ownership away does not free the person to start
    //                                        another. NULL for a workspace created before this (or by an admin route).
    //   billing_checkouts.person_id          the signed-in person who started that checkout (NULL for an agent key).
    up: (db) => {
      const add = (table: string, column: string) => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      };
      add("people", "trial_used_at");
      add("organizations", "created_by_person_id");
      add("billing_checkouts", "person_id");
    },
  },
  {
    version: 51,
    name: "oauth_grants_consents",
    // The MCP connector's authorization side (plan 2026-09-29 §7, Codex-OpenCadre-049a's binding amendments):
    //
    //   oauth_grants    one durable approval: a person let a client act in a workspace, within one consent scope
    //                   (`scope_key` = the chosen project, or '*' for the whole workspace), as one connector agent.
    //                   UNIQUE among ACTIVE grants only (§7.6, a partial index): a Disconnect or an agent removal sets
    //                   revoked_at, and a later approval for the same tuple then inserts a fresh grant and agent. The
    //                   index is also what makes approve's get-or-create atomic across writers (§7.2): a concurrent
    //                   duplicate loses on it and retries as a reuse.
    //   oauth_consents  one validated GET /oauth/authorize waiting for the person's answer (§7.3), keyed by the HASH
    //                   of the consent id the page carries. The approve/deny POST reads client, redirect, resource,
    //                   PKCE challenge and state from this row, never from the form, and marks it used atomically.
    //   grant_id        on codes and tokens, so a family belongs to a grant (NULL on rows from before this).
    // Additive only.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS oauth_grants (
  grant_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_active_idx ON oauth_grants (person_id, client_id, org_id, scope_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_grants_agent_idx ON oauth_grants (agent_id);
CREATE INDEX IF NOT EXISTS oauth_grants_client_idx ON oauth_grants (client_id);
CREATE TABLE IF NOT EXISTS oauth_consents (
  consent_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_consents_client_idx ON oauth_consents (client_id);
      `);
      for (const table of ["oauth_codes", "oauth_tokens"]) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!columns.some((c) => c.name === "grant_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN grant_id TEXT`);
      }
    },
  },
  {
    version: 52,
    name: "oauth_code_family",
    // The token family an authorization code minted (POST /oauth/token), so presenting that code AGAIN can revoke exactly
    // that family (OAuth 2.1 §4.1.2: a code used twice has leaked). NULL until the code is exchanged. Additive only.
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(oauth_codes)`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "family_id")) db.exec(`ALTER TABLE oauth_codes ADD COLUMN family_id TEXT`);
    },
  },
  {
    version: 53,
    name: "person_approvals",
    // A PERSON decides clearances (docs/superpowers/plans/2026-09-30-person-approvals.md, finding Codex-OpenCadre-049a):
    // until now any agent could decide another agent's clearance, and the record could not say a person decided.
    //
    //   approvals.decider_kind            who may decide the row: 'person' (the default, and the only kind anything
    //                                     creates in this build) or 'supervisor' (an agent a person has designated; that
    //                                     designation does not exist yet, plan §4.1). Write-once. Every existing row gets
    //                                     'person': nothing is silently reclassified as agent-decidable.
    //   approvals.decided_by_person_id    the signed-in person who decided the row (or whose grant auto-approved it), a
    //   approvals.decided_by_person_name  snapshot of their display name, and the channel (`console` or `grant`). NULL
    //   approvals.decided_via             for an agent decision or one made before this migration. Write-once.
    //   approval_grants.granted_by_person_id / granted_by_person_name
    //                                     the person behind a grant. Write-once. Only such a grant may auto-approve a
    //                                     person row (src/approvals.ts activeGrant).
    //
    // Guarded in the database as well as the code: a 'supervisor' row cannot be inserted (the migration that ships
    // designation drops `approvals_decider_kind_person_only`), and no row's kind can change. An older image (a rollback)
    // still runs: it never names decider_kind, so its inserts get the default.
    //
    // Rollout: every still-active grant with no person provenance -- i.e. every active grant, since none recorded one -- is
    // expired now (plan §2.6 "deletes (or expires)"; expired keeps this migration additive), and each is put on its
    // workspace's timeline as `approval.grant_revoked` (actor: the hub) and queued to its agent, so the fleet sees its
    // auto-approvals end instead of finding out at the next held command.
    up: (db) => {
      const has = (table: string, name: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!has("approvals", "decider_kind")) {
        db.exec(`ALTER TABLE approvals ADD COLUMN decider_kind TEXT NOT NULL DEFAULT 'person' CHECK (decider_kind IN ('person', 'supervisor'))`);
      }
      for (const column of ["decided_by_person_id", "decided_by_person_name", "decided_via"]) {
        if (!has("approvals", column)) db.exec(`ALTER TABLE approvals ADD COLUMN ${column} TEXT`);
      }
      for (const column of ["granted_by_person_id", "granted_by_person_name"]) {
        if (!has("approval_grants", column)) db.exec(`ALTER TABLE approval_grants ADD COLUMN ${column} TEXT`);
      }
      db.exec(`
CREATE TRIGGER IF NOT EXISTS approvals_decider_kind_person_only BEFORE INSERT ON approvals
WHEN NEW.decider_kind IS NOT 'person'
BEGIN
  SELECT RAISE(ABORT, 'approvals.decider_kind supervisor needs a supervisor designation, which does not exist yet');
END;
CREATE TRIGGER IF NOT EXISTS approvals_decider_kind_write_once BEFORE UPDATE OF decider_kind ON approvals
WHEN NEW.decider_kind IS NOT OLD.decider_kind
BEGIN
  SELECT RAISE(ABORT, 'approvals.decider_kind is write-once');
END;
      `);
      for (const [table, column] of PERSON_PROVENANCE_COLUMNS) {
        db.exec(`
CREATE TRIGGER IF NOT EXISTS ${table}_${column}_write_once BEFORE UPDATE OF ${column} ON ${table}
WHEN OLD.${column} IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '${table}.${column} is write-once');
END;
        `);
      }

      // Expired, not deleted: migrations stay additive (a rollback image still reads the rows), and an expired grant covers
      // nothing in either image. Re-running finds nothing still active, so it emits nothing twice.
      const now = Date.now();
      const legacy = db.prepare(
        `UPDATE approval_grants SET expires_at = ? WHERE granted_by_person_id IS NULL AND expires_at > ? RETURNING *`,
      ).all(new Date(now).toISOString(), new Date(now).toISOString()) as Array<{
        id: string; org_id: string; agent_id: string; category: string; project_key: string | null;
      }>;
      // Written the way emitEvent writes an event (src/events.ts), hash chain and delivery included: that module cannot be
      // imported from a migration, since it opens the database that runs the migrations.
      const lastHash = db.prepare(`SELECT hash FROM events WHERE org_id = ? ORDER BY seq DESC LIMIT 1`);
      const insertEvent = db.prepare(
        `INSERT INTO events (id, org_id, type, actor_agent_id, actor_agent_name, subject_type, subject_id, target_agent_id, payload, created_at, prev_hash, hash, project_key)
         VALUES (?, ?, 'approval.grant_revoked', NULL, NULL, 'grant', ?, ?, ?, ?, ?, ?, ?)`,
      );
      const queue = db.prepare(`INSERT INTO event_deliveries (event_seq, agent_id, state) VALUES (?, ?, 'queued')`);
      for (const grant of legacy) {
        const id = randomUUID();
        const createdAt = toSqliteTime(now);
        const payload = JSON.stringify({
          category: grant.category, reason: "a person now decides every clearance",
          ...(grant.project_key ? { project_key: grant.project_key } : {}),
        });
        const prevHash = (lastHash.get(grant.org_id) as { hash: string | null } | undefined)?.hash ?? null;
        const hash = computeEventHash({
          id, org_id: grant.org_id, type: "approval.grant_revoked", actor_agent_id: null, subject_type: "grant", subject_id: grant.id,
          target_agent_id: grant.agent_id, payload, created_at: createdAt,
        }, prevHash);
        const seq = Number(insertEvent.run(id, grant.org_id, grant.id, grant.agent_id, payload, createdAt, prevHash, hash, grant.project_key).lastInsertRowid);
        queue.run(seq, grant.agent_id);
      }
    },
  },
  {
    version: 54,
    name: "task_search_revision_seq",
    // Tasks tranche 2, Codex-OpenCadre-049a's review of #660 at d236df40 (plan 2026-09-30-task-paging.md).
    //
    //   tasks.search_text     what GET /v1/tasks?q= searches: the title and description as CURRENT masking shows them
    //                         (src/tasks.ts taskSearchText). Search never reads the raw columns, so text that masking
    //                         hides on output (a row stored before a masking rule existed) cannot be probed by search.
    //   tasks.search_masking  the masking version search_text was built under (src/secrets.ts MASKING_VERSION). Search
    //                         and counts consider only rows built under the current version; the hub rebuilds the rest
    //                         in bounded batches (src/tasks.ts rebuildTaskSearchText). NULL here: not built yet, so no
    //                         row matches any q until it is. Nothing is built by this migration: it cannot import the
    //                         masker without opening the database that runs it.
    //   tasks.revision        bumped by the trigger below on every change to a column a task's summary or details show,
    //                         and by every accept vote added or cleared (task_reviews), so the console's cached details
    //                         can never survive a change, even two in one second. Renewing a claim bumps it: the lease
    //                         is shown on the card.
    //   tasks.seq             the ordering tie-breaker and cursor position in place of rowid, which VACUUM may renumber.
    //                         Existing rows get their rowid (today's order, exactly); new rows take the next value of
    //                         task_sequence, which only ever grows, so a seq is never reused after a delete. Assigned
    //                         inside the INSERT's own transaction by a trigger, and SQLite serialises writers, so two
    //                         creators can't draw the same value.
    //
    // Additive: new columns, one new table, indexes and triggers. An older image (a rollback) never names these columns;
    // its inserts still get a seq from the trigger, and its updates still bump revision.
    up: (db) => {
      const has = (name: string) => (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!has("search_text")) db.exec(`ALTER TABLE tasks ADD COLUMN search_text TEXT`);
      if (!has("search_masking")) db.exec(`ALTER TABLE tasks ADD COLUMN search_masking TEXT`);
      if (!has("revision")) db.exec(`ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
      if (!has("seq")) db.exec(`ALTER TABLE tasks ADD COLUMN seq INTEGER`);
      db.exec(`
UPDATE tasks SET seq = rowid WHERE seq IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_seq_idx ON tasks (seq);
CREATE INDEX IF NOT EXISTS tasks_org_search_masking_idx ON tasks (org_id, search_masking);
CREATE TABLE IF NOT EXISTS task_sequence (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO task_sequence (name, value) VALUES ('tasks', (SELECT COALESCE(MAX(seq), 0) FROM tasks));
UPDATE task_sequence SET value = MAX(value, (SELECT COALESCE(MAX(seq), 0) FROM tasks)) WHERE name = 'tasks';
CREATE TRIGGER IF NOT EXISTS tasks_seq_assign AFTER INSERT ON tasks
WHEN NEW.seq IS NULL
BEGIN
  UPDATE task_sequence SET value = value + 1 WHERE name = 'tasks';
  UPDATE tasks SET seq = (SELECT value FROM task_sequence WHERE name = 'tasks') WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS tasks_seq_given AFTER INSERT ON tasks
WHEN NEW.seq IS NOT NULL
BEGIN
  UPDATE task_sequence SET value = MAX(value, NEW.seq) WHERE name = 'tasks';
END;
CREATE TRIGGER IF NOT EXISTS tasks_revision_bump AFTER UPDATE OF
  title, description, status, claimed_by_agent_id, claimed_by_agent_name, lease_expires_at, completion_summary, completed_at,
  reviewed, reviewed_by_agent_id, reviewed_by_agent_name, reviewed_at, review_note, required_capabilities, min_round_budget,
  required_reviews, parent_task_id, superseded_by, project_key
ON tasks
BEGIN
  UPDATE tasks SET revision = OLD.revision + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS task_reviews_revision_add AFTER INSERT ON task_reviews
BEGIN
  UPDATE tasks SET revision = revision + 1 WHERE id = NEW.task_id;
END;
CREATE TRIGGER IF NOT EXISTS task_reviews_revision_clear AFTER DELETE ON task_reviews
BEGIN
  UPDATE tasks SET revision = revision + 1 WHERE id = OLD.task_id;
END;
      `);
    },
  },
  {
    version: 55,
    name: "agent_profiles_and_addresses",
    // Sessions PR1 (board task 822803e1; Codex-OpenCadre-049a's rulings of 2026-09-30, src/agent-names.ts).
    //
    //   agent_profiles        an operator-owned name ("Atlas"): immutable id, a name unique per workspace ignoring case
    //                         (name_key, folded in JS, so the UNIQUE holds for every script), and next_ordinal, the
    //                         counter behind each session address "Atlas #<n>". It only ever grows. Display metadata
    //                         only: no key, mailbox, claim or permission hangs off it.
    //   agent_addresses       every name ever held by any agent in the workspace, removed agents included: an address,
    //                         once held, is never reassigned (so a late message or a stale client config can never reach
    //                         a different agent). PRIMARY KEY (org_id, name_key) makes that a database guarantee, and the
    //                         two triggers below write it on EVERY insert and rename of an agent, whatever code path does
    //                         it, so no service can forget. A rename keeps the old row (released_at set) as its lineage.
    //                         name_key here is lower(trim(name)): the triggers can use only built-in functions, so that a
    //                         rollback image (which knows nothing of this table) still inserts agents through them. SQLite's
    //                         lower() folds ASCII only; checkAgentName folds full Unicode in JS before any write, and the
    //                         database adds the race-free guarantee for every ASCII case variant.
    //   agents.profile_id     which profile a session was named into. NULL for every existing row: nothing is backfilled.
    //   agents.name_prompt_done_at   when a person answered the one-time naming prompt (named it, or kept its name).
    //   tasks.side_request_of the task an agent was working on when it saved this one (save_task). A relationship only:
    //                         unlike parent_task_id it never blocks the other task's completion. Write-once.
    //
    // The backfill records each existing agent's current name, live agents first. Where history already reused a name (a
    // removed agent's name taken by a later one), the live holder keeps it and the removed agent's copy is not recorded:
    // nothing existing is changed or refused. No existing agents, tasks or events row is modified.
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  next_ordinal INTEGER NOT NULL DEFAULT 1,
  created_by_person_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, name_key)
);
CREATE TABLE IF NOT EXISTS agent_addresses (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name_key TEXT NOT NULL,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT,
  PRIMARY KEY (org_id, name_key)
);
CREATE INDEX IF NOT EXISTS agent_addresses_agent_idx ON agent_addresses (agent_id);
INSERT OR IGNORE INTO agent_addresses (org_id, name_key, name, agent_id, created_at)
  SELECT org_id, lower(trim(name)), name, id, created_at FROM agents
   ORDER BY (removed_at IS NOT NULL), created_at, rowid;
CREATE TRIGGER IF NOT EXISTS agents_address_claim AFTER INSERT ON agents
BEGIN
  SELECT RAISE(ABORT, 'agent address already held') WHERE EXISTS (
    SELECT 1 FROM agent_addresses WHERE org_id = NEW.org_id AND name_key = lower(trim(NEW.name)) AND agent_id <> NEW.id);
  INSERT OR IGNORE INTO agent_addresses (org_id, name_key, name, agent_id) VALUES (NEW.org_id, lower(trim(NEW.name)), NEW.name, NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS agents_address_rename AFTER UPDATE OF name ON agents
WHEN lower(trim(NEW.name)) <> lower(trim(OLD.name))
BEGIN
  SELECT RAISE(ABORT, 'agent address already held') WHERE EXISTS (
    SELECT 1 FROM agent_addresses WHERE org_id = NEW.org_id AND name_key = lower(trim(NEW.name)) AND agent_id <> NEW.id);
  UPDATE agent_addresses SET released_at = datetime('now')
   WHERE org_id = OLD.org_id AND name_key = lower(trim(OLD.name)) AND agent_id = OLD.id AND released_at IS NULL;
  INSERT OR IGNORE INTO agent_addresses (org_id, name_key, name, agent_id) VALUES (NEW.org_id, lower(trim(NEW.name)), NEW.name, NEW.id);
  UPDATE agent_addresses SET released_at = NULL WHERE org_id = NEW.org_id AND name_key = lower(trim(NEW.name)) AND agent_id = NEW.id;
END;
      `);
      const has = (name: string) => (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!has("profile_id")) db.exec(`ALTER TABLE agents ADD COLUMN profile_id TEXT REFERENCES agent_profiles(id)`);
      if (!has("name_prompt_done_at")) db.exec(`ALTER TABLE agents ADD COLUMN name_prompt_done_at TEXT`);
      const taskHas = (name: string) => (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!taskHas("side_request_of")) db.exec(`ALTER TABLE tasks ADD COLUMN side_request_of TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS agents_profile_idx ON agents (profile_id)`);
    },
  },
  {
    version: 56,
    name: "Bounded self-reported connector builds per computer",
    up(db) {
      const has = (db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>).some((c) => c.name === "connector_reports");
      if (!has) db.exec(`ALTER TABLE devices ADD COLUMN connector_reports TEXT NOT NULL DEFAULT '[]'`);
    },
  },
  {
    version: 57,
    name: "Connector telemetry: per-computer refusal counts and the digest item's claims",
    // PLAN-PR-E addendum §3.2(b) and §4.1, as corrected by amendment 2 §4 (PR-E1b). Additive and optional, like 56:
    // - connector_refusals: {"<reason>": {"<hour index>": count}} for the last 24 h, reasons no_session and
    //   ambiguous_session only, capped and pruned on write (src/connector-health.ts). No path, chat or credential.
    // - connector_digest: {"<package stamp>:<status>": claimedAt epoch ms} for EVERY item the awareness digest carried for
    //   this computer in the last 24 h, so each (package, status) is carried at most once per computer per rolling 24 h,
    //   even when the status or package flips away and back (src/connector-digest.ts).
    up(db) {
      const has = (name: string) => (db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!has("connector_refusals")) db.exec(`ALTER TABLE devices ADD COLUMN connector_refusals TEXT NOT NULL DEFAULT '{}'`);
      if (!has("connector_digest")) db.exec(`ALTER TABLE devices ADD COLUMN connector_digest TEXT NOT NULL DEFAULT '{}'`);
    },
  },
  {
    version: 58,
    name: "Workspace checkout reservations",
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS billing_checkout_reservations (
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY (org_id)
      )`);
    },
  },
  {
    version: 59,
    name: "Wake webhook: the last wake POST's outcome",
    // The most recent wake POST to an agent's webhook (src/service.ts recordWakeOutcome): when, the outcome (delivered,
    // rejected, failed, gave_up) and the HTTP status code. Never the response body. Cleared when the address or header
    // changes, so it always describes the webhook that is set now.
    up(db) {
      const has = (name: string) => (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!has("last_wake_at")) db.exec(`ALTER TABLE agents ADD COLUMN last_wake_at TEXT`);
      if (!has("last_wake_outcome")) db.exec(`ALTER TABLE agents ADD COLUMN last_wake_outcome TEXT`);
      if (!has("last_wake_status")) db.exec(`ALTER TABLE agents ADD COLUMN last_wake_status INTEGER`);
    },
  },
  {
    version: 60,
    name: "Project settings: the per-project WIP cap",
    // One row per project an admin configured (src/project-settings.ts); project_key '' is the workspace default, as in
    // clearance_policies. wip_cap NULL means no cap there: a project row with NULL overrides a workspace cap. No row is
    // today's behaviour, unlimited. project_key here is the row's SUBJECT, not a writer's stamp, so it is not in
    // STAMPED_TABLES: a stamp is write-once provenance taken from the writer's home project, and an admin sets another
    // project's (or the workspace's) row.
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS project_settings (
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_key TEXT NOT NULL,
        wip_cap INTEGER CHECK (wip_cap IS NULL OR (wip_cap BETWEEN 1 AND 50)),
        updated_at TEXT NOT NULL,
        updated_by_person_id TEXT,
        PRIMARY KEY (org_id, project_key)
      )`);
    },
  },
  {
    version: 61,
    name: "Work board: task lane, rank and held reason",
    // The board (src/task-board.ts): lane now | next | held; DONE is status 'done', never a lane. now comes only from a
    // claim, next from creation or a release, held from set_task_lane with a reason. rank orders NEXT (smaller first,
    // NULL last). Every task claimed when this runs is in progress, so it starts in NOW; everything else stays NEXT.
    up(db) {
      const has = (name: string) => (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some((c) => c.name === name);
      if (!has("lane")) db.exec(`ALTER TABLE tasks ADD COLUMN lane TEXT NOT NULL DEFAULT 'next' CHECK (lane IN ('now', 'next', 'held'))`);
      if (!has("rank")) db.exec(`ALTER TABLE tasks ADD COLUMN rank INTEGER`);
      if (!has("held_reason")) db.exec(`ALTER TABLE tasks ADD COLUMN held_reason TEXT`);
      db.exec(`UPDATE tasks SET lane = 'now' WHERE status = 'claimed' AND lane = 'next'`);
    },
  },
];

/** The person-provenance columns migration 53 adds, each write-once. */
const PERSON_PROVENANCE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["approvals", "decided_by_person_id"], ["approvals", "decided_by_person_name"], ["approvals", "decided_via"],
  ["approval_grants", "granted_by_person_id"], ["approval_grants", "granted_by_person_name"],
];

/** Where shared state goes that no provable writer can place: out of every project's sight until an operator decides.
 * It must be impossible as a project key, or a project with that name would read every orphaned row: a bare folder
 * name is still a valid legacy key (src/projects.ts projectKeyOf), so "unclassified" alone could be one. Every key is
 * printable ASCII with no spaces (projectKeyOf rejects anything outside \x21-\x7e), so this value, which contains
 * spaces, can't be (review of #618 by Codex-OpenCadre-8160). A workspace-scope reader still sees it, because it reads
 * every namespace. */
export const UNCLASSIFIED_NAMESPACE = "unclassified (no provable project)";

/** Moves each shared ('') goal, fact, lock and memory entry into the namespace its writer's scope proves, so switching
 * isolation on hides one project's state from another. A row stays shared only when its writer is provably
 * workspace-wide (a person, the hub, a workspace-scope agent). A writer with a home project moves it there. Anything
 * else (a removed or unknown writer, a project agent with no home) goes to UNCLASSIFIED_NAMESPACE rather than staying
 * shared, because staying shared is the leak (review of the plan by Codex-OpenCadre-8160). Idempotent: it only ever
 * reads shared rows. A goal or fact whose key already exists in the destination keeps the destination's row. */
export function classifySharedState(db: Database.Database, orgId: string): void {
  const writerNamespace = (agentExpr: string) => `(
    SELECT CASE
      WHEN a.id IS NULL OR a.removed_at IS NOT NULL THEN '${UNCLASSIFIED_NAMESPACE}'
      WHEN a.key_class IN ('human', 'system') OR a.scope = 'workspace' THEN ''
      -- A multi-project agent's row goes to its home only when home is one of its chosen projects: the rule
      -- namespacesOf writes by. A stale home outside them would hand its state to a project it isn't in, so such a row
      -- is parked unclassified instead (review of #618 by Codex-OpenCadre-8160).
      WHEN a.scope = 'projects' AND a.home_project IS NOT NULL AND EXISTS (
        SELECT 1 FROM agent_projects ap WHERE ap.agent_id = a.id
          AND ${resolvedKeySql("a.org_id", "ap.project_key")} = ${resolvedKeySql("a.org_id", "a.home_project")}
      ) THEN ${resolvedKeySql("a.org_id", "a.home_project")}
      WHEN a.scope = 'projects' THEN '${UNCLASSIFIED_NAMESPACE}'
      WHEN a.home_project IS NOT NULL THEN ${resolvedKeySql("a.org_id", "a.home_project")}
      ELSE '${UNCLASSIFIED_NAMESPACE}'
    END
    FROM (SELECT 1) one LEFT JOIN agents a ON a.id = ${agentExpr} AND a.org_id = ?
  )`;
  // Each store: its table, the column naming its writer, and whether a key collision is possible on move.
  const stores: Array<{ table: string; writer: string }> = [
    { table: "goals_ns", writer: "set_by_agent_id" },
    { table: "blackboard_facts_ns", writer: "set_by_agent_id" },
    { table: "resource_locks_ns", writer: "holder_agent_id" },
    { table: "memory_entries", writer: "created_by_agent_id" },
  ];
  for (const { table, writer } of stores) {
    const target = writerNamespace(`${table}.${writer}`);
    // Pass 1, into the writer's project. OR IGNORE: a destination row with the same key wins (it was written
    // deliberately into that project), and the shared row it would have replaced is parked by pass 2.
    db.prepare(`UPDATE OR IGNORE ${table} SET scope_key = ${target} WHERE org_id = ? AND scope_key = '' AND ${target} NOT IN ('', '${UNCLASSIFIED_NAMESPACE}')`)
      .run(orgId, orgId, orgId);
    // Pass 2, park everything else that isn't provably workspace-wide. Each parked row gets a namespace of its own (the
    // reserved prefix plus its rowid), so parking can never collide with an earlier parked row of the same key -- a
    // collision here would otherwise leave the row shared, visible to every project (review of #620 by
    // Codex-OpenCadre-8160). No OR IGNORE: if this could ever conflict, the migration fails rather than leak.
    db.prepare(`UPDATE ${table} SET scope_key = '${UNCLASSIFIED_NAMESPACE} #' || rowid WHERE org_id = ? AND scope_key = '' AND ${target} <> ''`)
      .run(orgId, orgId);
  }
}

/** Whether a namespace is a parked (unclassified) one: only readers of every namespace see these. */
export const isUnclassifiedNamespace = (namespace: string) => namespace.startsWith(UNCLASSIFIED_NAMESPACE);

/** Tables whose rows carry a project_key stamp (PROJECT_ISOLATION.md §4). */
export const STAMPED_TABLES = ["messages", "tasks", "approvals", "approval_grants", "files", "events"] as const;
/** Every write-once stamp column, as [table, column]. */
export const STAMP_COLUMNS: ReadonlyArray<readonly [string, string]> = [...STAMPED_TABLES.map((t) => [t, "project_key"] as const), ["messages", "to_project_key"]];

/** A folder-name key from a client before remote keys (e.g. "OpenCadre"): no "/" and not local:<folder>. The same rule
 * listProjects in src/projects.ts uses. */
export const isLegacyProjectKey = (key: string) => !key.includes("/") && !/^local:/i.test(key);

/** SQL for a key resolved through project_aliases (the key itself when it has no alias). Aliases are one hop: only a
 * legacy key is ever an alias, and it always points at a remote key. */
export const resolvedKeySql = (orgExpr: string, keyExpr: string) =>
  `COALESCE((SELECT pa.project_key FROM project_aliases pa WHERE pa.org_id = ${orgExpr} AND pa.alias_key = ${keyExpr}), ${keyExpr})`;

/** Creates the alias for a legacy key whose name (case-insensitive) matches exactly one enabled remote key in the same
 * workspace: the rule listProjects uses to hide the duplicate. Returns the key it resolves to now, alias or not. An alias,
 * once made, stays: stamps are write-once, so the key a repository resolves to must not change back. */
export function createLegacyAlias(db: Database.Database, orgId: string, key: string): string {
  const existing = db.prepare(`SELECT project_key FROM project_aliases WHERE org_id = ? AND alias_key = ?`).get(orgId, key) as { project_key: string } | undefined;
  if (existing) return existing.project_key;
  if (!isLegacyProjectKey(key)) return key;
  const row = db.prepare(`SELECT name FROM projects WHERE org_id = ? AND project_key = ?`).get(orgId, key) as { name: string } | undefined;
  const name = (row?.name ?? key).toLowerCase();
  const remotes = db.prepare(`SELECT project_key FROM projects WHERE org_id = ? AND enabled = 1 AND instr(project_key, '/') > 0 AND lower(name) = ? LIMIT 2`)
    .all(orgId, name) as Array<{ project_key: string }>;
  if (remotes.length !== 1) return key;
  db.prepare(`INSERT INTO project_aliases (org_id, alias_key, project_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, alias_key) DO NOTHING`)
    .run(orgId, key, remotes[0].project_key, new Date().toISOString());
  return (db.prepare(`SELECT project_key FROM project_aliases WHERE org_id = ? AND alias_key = ?`).get(orgId, key) as { project_key: string }).project_key;
}

/** Stamps every row whose stamp is still NULL from the agent that wrote it (agents.project, resolved through the aliases).
 * Only NULLs are filled, and a row nothing can be derived for stays NULL, so running it again changes nothing. Events get
 * the column only, never a payload rewrite (the payload is hash-chained):
 * - message, task, approval and grant events take their subject row's stamp;
 * - agent events take the subject agent's project;
 * - decisions, conflicts, reviews and clearance bypass reports take the actor's project;
 * - a clearance policy change and a project enable/disable take the project they name;
 * - workspace, member and device events stay NULL. */
export function backfillProjectStamps(db: Database.Database): void {
  const agentKey = (idExpr: string, orgExpr: string) =>
    resolvedKeySql(orgExpr, `(SELECT a.project FROM agents a WHERE a.id = ${idExpr} AND a.org_id = ${orgExpr})`);
  const stamp = (table: string, column: string, value: string) =>
    db.exec(`UPDATE ${table} SET ${column} = ${value} WHERE ${column} IS NULL`);
  stamp("messages", "project_key", agentKey("messages.from_agent_id", "messages.org_id"));
  stamp("messages", "to_project_key", agentKey("messages.to_agent_id", "messages.org_id"));
  stamp("tasks", "project_key", agentKey("tasks.created_by_agent_id", "tasks.org_id"));
  stamp("approvals", "project_key", agentKey("approvals.requested_by_agent_id", "approvals.org_id"));
  stamp("approval_grants", "project_key", agentKey("approval_grants.agent_id", "approval_grants.org_id"));
  stamp("files", "project_key", agentKey("files.uploaded_by_agent_id", "files.org_id"));
  const subjectRow = (table: string) => `(SELECT s.project_key FROM ${table} s WHERE s.id = events.subject_id AND s.org_id = events.org_id)`;
  stamp("events", "project_key", `CASE
    WHEN events.subject_type = 'message' THEN ${subjectRow("messages")}
    WHEN events.subject_type = 'task' THEN ${subjectRow("tasks")}
    WHEN events.subject_type = 'approval' THEN ${subjectRow("approvals")}
    WHEN events.subject_type = 'grant' THEN ${subjectRow("approval_grants")}
    WHEN events.subject_type = 'agent' THEN ${agentKey("events.subject_id", "events.org_id")}
    WHEN events.type = 'clearance.policy_changed' THEN CASE WHEN events.subject_id IN ('', 'workspace') THEN NULL ELSE ${resolvedKeySql("events.org_id", "events.subject_id")} END
    WHEN events.subject_type IN ('decision', 'conflict', 'review', 'clearance') THEN ${agentKey("events.actor_agent_id", "events.org_id")}
    WHEN events.subject_type = 'project' THEN ${resolvedKeySql("events.org_id", "events.subject_id")}
    ELSE NULL
  END`);
}

/** The keys migration 10 enables for workspaces already running sessions on the OpenCadre repository. */
export const OPENCADRE_LEGACY_PROJECT = "OpenCadre";
export const OPENCADRE_REPO_PROJECT = "github.com/mabdullah4800-ai/opencadre";

export interface MigrationResult {
  applied: number[];
  /** Highest version recorded in the database after running. */
  current: number;
  /** True when the database is at a version this build doesn't know (e.g. after a rollback). */
  ahead: boolean;
}

function assertOrdered(migrations: Migration[]): void {
  migrations.forEach((m, i) => {
    if (!Number.isInteger(m.version) || m.version < 1) throw new Error(`migration "${m.name}" has an invalid version ${m.version}`);
    if (i > 0 && m.version <= migrations[i - 1].version) {
      throw new Error(`migrations must have strictly increasing versions: ${migrations[i - 1].version} then ${m.version}`);
    }
  });
}

/** Applies every migration newer than the database's current version. Safe to call on every start:
 * each migration re-checks under an immediate (write-locking) transaction, so two processes starting
 * together can't apply the same migration twice. A migration that throws rolls back completely and
 * is not recorded, and the error propagates so the process doesn't start on a half-migrated schema. */
export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): MigrationResult {
  assertOrdered(migrations);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const currentVersion = () => (db.prepare(`SELECT MAX(version) AS v FROM schema_migrations`).get() as { v: number | null }).v ?? 0;
  const applied: number[] = [];
  for (const migration of migrations) {
    const apply = db.transaction(() => {
      const done = db.prepare(`SELECT 1 FROM schema_migrations WHERE version = ?`).get(migration.version);
      if (done) return false;
      migration.up(db);
      db.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`)
        .run(migration.version, migration.name, new Date().toISOString());
      return true;
    });
    if (apply.immediate()) applied.push(migration.version);
  }
  const current = currentVersion();
  const known = migrations.at(-1)?.version ?? 0;
  return { applied, current, ahead: current > known };
}
