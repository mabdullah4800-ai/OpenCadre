// Postgres-compatible mirror of the SQLite schema in src/db.ts.
//
// This file does NOT change what database the app uses at runtime -- it is
// additive infrastructure for the Postgres migration path (see
// docs/ops/POSTGRES_MIGRATION.md). The application continues to run on
// SQLite by default; nothing here is imported by src/index.ts or any other
// runtime module.
//
// Column-for-column parity contract: every table, column, default, and index
// present in src/db.ts (including the idempotent ALTER TABLE migrations run
// at the bottom of that file) has a Postgres equivalent here. Tests in
// tests/db-postgres-schema.test.ts assert this parity mechanically so the
// two schemas cannot silently drift.
//
// Type mapping notes:
//   - SQLite TEXT primary/foreign keys (UUIDs) -> Postgres TEXT (no change;
//     avoids a lossy UUID<->TEXT conversion during migration).
//   - SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` (events.seq) -> Postgres
//     BIGSERIAL (technically GENERATED ALWAYS AS IDENTITY equivalent).
//   - SQLite TEXT timestamps written via datetime('now') (ISO-8601-ish,
//     space-separated, UTC) -> Postgres TIMESTAMPTZ. The migration script
//     converts each value with `new Date(value + "Z")` before insert.
//   - SQLite INTEGER 0/1 flags (messages.awaiting_reply) -> Postgres BOOLEAN.
//   - SQLite BLOB (files.content) -> Postgres BYTEA.
//   - SQLite INTEGER byte counts -> Postgres BIGINT.
//
// All CREATE statements are idempotent (IF NOT EXISTS) so this script is
// safe to run repeatedly against the same target database.

export const POSTGRES_SCHEMA_SQL = `
-- Plans (src/migrations.ts migrations 29 and 32). Global, not per-org: the limits a workspace gets are
-- a property of the plan it is on. Every limit column is NULLABLE and NULL means UNLIMITED -- which is
-- the real value for Business on machines, agents, projects, webhooks and history, and for the internal
-- plan on everything. NULL is not "unset": a NULL that was meant to be a number enforces nothing and
-- looks like a plan with no ceiling, so a column added here must also be added to migrations.ts and to
-- the projection in src/billing.ts, or the two schemas silently disagree about what a plan grants.
--
-- max_machines / max_agents on Team are PER SEAT AND POOLED (PRICING.md section 2): the stored value is
-- per seat, and the enforcement path multiplies by the seat count. Storing a pre-multiplied total here
-- would be wrong the moment someone invites or removes a teammate.
CREATE TABLE IF NOT EXISTS plans (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_agents INTEGER,
  retention_days INTEGER,
  trial_days INTEGER,
  max_machines INTEGER,
  max_projects INTEGER,
  max_workspaces INTEGER,
  max_webhooks INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bootstrap_key_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paused_at TIMESTAMPTZ,
  paused_by_agent_name TEXT,
  project_isolation INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at TIMESTAMPTZ,
  subscription_status TEXT NOT NULL DEFAULT 'active',
  billing_customer_ref TEXT,
  billing_event_at TIMESTAMPTZ,
  lapsed_at TIMESTAMPTZ,
  billing_subscription_ref TEXT,
  billing_provider TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  provider_price_id TEXT,
  provider_quantity INTEGER,
  scheduled_change_action TEXT,
  scheduled_change_at TIMESTAMPTZ,
  provider_customer_email TEXT,
  provider_customer_email_error_at TIMESTAMPTZ,
  trial_used_at TIMESTAMPTZ,
  first_paid_at TIMESTAMPTZ,
  provider_next_billed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_billing_customer_ref_idx ON organizations (billing_customer_ref);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url_key TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  last_heartbeat_at TIMESTAMPTZ,
  webhook_url TEXT,
  webhook_auth_header TEXT,
  current_task TEXT,
  editing_files TEXT,
  status_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  phase TEXT,
  awareness_cursor BIGINT,
  key_class TEXT NOT NULL DEFAULT 'agent',
  role TEXT NOT NULL DEFAULT 'agent',
  usage TEXT,
  kind TEXT NOT NULL DEFAULT 'named',
  device_id TEXT,
  seat_id TEXT,
  tool_session_id TEXT,
  project TEXT,
  ended_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  removed_by_agent_name TEXT,
  client TEXT,
  project_name TEXT,
  home_project TEXT,
  scope TEXT NOT NULL DEFAULT 'project',
  liveness TEXT,
  capabilities TEXT NOT NULL DEFAULT '[]',
  round_budget INTEGER,
  UNIQUE (org_id, url_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_device_seat_idx ON agents (device_id, seat_id) WHERE kind = 'session';

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  from_agent_name TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  to_agent_name TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',
  priority TEXT NOT NULL DEFAULT 'medium',
  awaiting_reply BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  file_id TEXT,
  project_key TEXT,
  to_project_key TEXT
);

CREATE INDEX IF NOT EXISTS messages_to_agent_idx ON messages (org_id, to_agent_id, read_at);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (org_id, thread_id);
CREATE INDEX IF NOT EXISTS messages_project_idx ON messages (org_id, project_key);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by_agent_id TEXT NOT NULL,
  uploaded_by_agent_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_key TEXT
);

CREATE INDEX IF NOT EXISTS files_project_idx ON files (org_id, project_key);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_by_agent_id TEXT NOT NULL,
  created_by_agent_name TEXT NOT NULL,
  claimed_by_agent_id TEXT,
  claimed_by_agent_name TEXT,
  lease_expires_at TIMESTAMPTZ,
  completion_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  lease_expiry_emitted_at TIMESTAMPTZ,
  project_key TEXT,
  reviewed BOOLEAN NOT NULL DEFAULT false,
  reviewed_by_agent_id TEXT,
  reviewed_by_agent_name TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  required_capabilities TEXT NOT NULL DEFAULT '[]',
  min_round_budget INTEGER,
  required_reviews INTEGER NOT NULL DEFAULT 1,
  -- Not a hard FK (unlike task_reviews.task_id): it's a self-reference within this same table, and
  -- the SQLite->Postgres cutover script bulk-inserts tasks in one pass, which could transiently
  -- insert a child before its parent. Referential validity is enforced at the application layer
  -- (createTask checks the parent exists and is visible) instead, same reasoning resource_locks'
  -- resource_key already documents for not being a real FK to anything.
  parent_task_id TEXT,
  -- The task that CORRECTS this one (migration 39), mirroring memory_entries.superseded_by. Same
  -- no-FK reasoning as parent_task_id above: supersedeTask checks the target exists and is visible
  -- rather than relying on a constraint, and a real FK would make the row un-deletable.
  superseded_by TEXT
);

CREATE INDEX IF NOT EXISTS tasks_org_status_idx ON tasks (org_id, status);
CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (org_id, parent_task_id);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (org_id, project_key);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by_agent_id TEXT NOT NULL,
  requested_by_agent_name TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  risk TEXT NOT NULL DEFAULT 'medium',
  category TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by_agent_id TEXT,
  decided_by_agent_name TEXT,
  decision_note TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  project_key TEXT
);

CREATE INDEX IF NOT EXISTS approvals_org_status_idx ON approvals (org_id, status);
CREATE INDEX IF NOT EXISTS approvals_project_idx ON approvals (org_id, project_key);

CREATE TABLE IF NOT EXISTS approval_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  category TEXT NOT NULL,
  granted_by_agent_id TEXT NOT NULL,
  granted_by_agent_name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_key TEXT
);

CREATE INDEX IF NOT EXISTS approval_grants_lookup_idx ON approval_grants (org_id, agent_id, category, expires_at);
CREATE INDEX IF NOT EXISTS approval_grants_project_idx ON approval_grants (org_id, project_key);

CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  team_size TEXT,
  tools TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  ip_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  org_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS events (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_agent_id TEXT,
  actor_agent_name TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  target_agent_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash TEXT,
  hash TEXT,
  project_key TEXT
);

CREATE INDEX IF NOT EXISTS events_org_seq_idx ON events (org_id, seq);
CREATE INDEX IF NOT EXISTS events_project_idx ON events (org_id, project_key);
CREATE INDEX IF NOT EXISTS events_target_idx ON events (org_id, target_agent_id, seq);

CREATE TABLE IF NOT EXISTS event_deliveries (
  event_seq BIGINT NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (event_seq, agent_id)
);

CREATE INDEX IF NOT EXISTS event_deliveries_open_idx ON event_deliveries (agent_id, state, event_seq);

CREATE TABLE IF NOT EXISTS connect_codes (
  code_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  client TEXT NOT NULL,
  created_by_agent_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  agent_id TEXT
);

CREATE TABLE IF NOT EXISTS message_escalations (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  last_notified_at TIMESTAMPTZ NOT NULL
);

-- Retry-safe writes (src/idempotency.ts).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, agent_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Per-project clearance mode (src/clearance-policy.ts). project '' is the workspace default.
CREATE TABLE IF NOT EXISTS clearance_policies (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('off', 'notify', 'ask', 'strict')),
  updated_by_agent_id TEXT,
  updated_by_agent_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, project)
);

-- People accounts (src/accounts.ts).
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_sign_in_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS people_email_idx ON people (email);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_person_idx ON sessions (person_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS workspace_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  agent_id TEXT NOT NULL,
  invited_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
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
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_label TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_person_idx ON push_subscriptions (person_id);

-- Devices for per-session identity (src/devices.ts). Only hashes of the code and credential are stored.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  client TEXT NOT NULL,
  credential_hash TEXT UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  code_expires_at TIMESTAMPTZ NOT NULL,
  code_redeemed_at TIMESTAMPTZ,
  created_by_agent_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  tools TEXT,
  merged_into_device_id TEXT,
  connector_reports TEXT NOT NULL DEFAULT '[]',
  connector_refusals TEXT NOT NULL DEFAULT '{}',
  connector_digest TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS devices_org_idx ON devices (org_id);

-- Opt-in projects (src/projects.ts): a computer joins sessions only in enabled ones.
CREATE TABLE IF NOT EXISTS projects (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  enabled_at TIMESTAMPTZ,
  enabled_by_agent_name TEXT,
  PRIMARY KEY (org_id, project_key)
);

-- Project isolation (src/project-stamps.ts, migrations 15 and 16). A legacy folder-name key resolves to its remote key.
-- The SQLite write-once triggers on the project_key stamps have no copy here yet: a cutover must add one that still lets
-- migrate-to-postgres.mjs re-run its idempotent upserts (which rewrite a stamp with the same value).
CREATE TABLE IF NOT EXISTS project_aliases (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alias_key TEXT NOT NULL,
  project_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, alias_key)
);

-- The chosen projects of an agent whose scope is 'projects'.
CREATE TABLE IF NOT EXISTS agent_projects (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  PRIMARY KEY (agent_id, project_key)
);

-- Linked projects (src/project-isolation.ts, migration 17): one row per pair, project_a < project_b.
CREATE TABLE IF NOT EXISTS project_links (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_a TEXT NOT NULL,
  project_b TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_agent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, project_a, project_b),
  CHECK (project_a < project_b)
);
CREATE INDEX IF NOT EXISTS project_links_b_idx ON project_links (org_id, project_b);

-- Shared project memory (src/memory.ts, migration 19): durable, searchable institutional knowledge.
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tag TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  archived_reason TEXT,
  superseded_by TEXT REFERENCES memory_entries(id),
  created_by_agent_id TEXT NOT NULL,
  created_by_agent_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  scope_key TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS memory_entries_org_status_idx ON memory_entries (org_id, status);
CREATE INDEX IF NOT EXISTS memory_entries_org_tag_idx ON memory_entries (org_id, tag);

-- Ongoing escalation thread per (org, recipient, operator) (src/escalation.ts, migration 20).
CREATE TABLE IF NOT EXISTS escalation_threads (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_agent_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, recipient_agent_id, operator_id)
);

-- Fleet-wide goal (src/goals.ts, migration 21): one row per org.
CREATE TABLE IF NOT EXISTS goals (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  set_by_agent_id TEXT NOT NULL,
  set_by_agent_name TEXT NOT NULL,
  set_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id)
);

-- Named-resource mutex (src/resource-locks.ts, migration 23): a leased claim on an opaque
-- caller-defined string, same shape as tasks' leased claims.
CREATE TABLE IF NOT EXISTS resource_locks (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL,
  holder_agent_name TEXT NOT NULL,
  note TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  lease_expiry_emitted_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, resource_key)
);
CREATE INDEX IF NOT EXISTS resource_locks_org_expires_idx ON resource_locks (org_id, lease_expires_at);

-- Shared blackboard fact store (src/blackboard.ts, migration 25): one row per (org, key), with an
-- optimistic-concurrency version so a disputed fact can't be silently clobbered by a racing writer.
CREATE TABLE IF NOT EXISTS blackboard_facts (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  set_by_agent_id TEXT NOT NULL,
  set_by_agent_name TEXT NOT NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);

-- Namespaced goal, facts and locks (src/scope.ts namespacesOf, migration 44): '' is shared with every project, else the
-- project key. New tables rather than a widened primary key, because migrations stay additive; the tables above are
-- left for a rolled-back image.
CREATE TABLE IF NOT EXISTS goals_ns (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  set_by_agent_id TEXT NOT NULL,
  set_by_agent_name TEXT NOT NULL,
  set_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, scope_key)
);
CREATE TABLE IF NOT EXISTS blackboard_facts_ns (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  set_by_agent_id TEXT NOT NULL,
  set_by_agent_name TEXT NOT NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope_key, key)
);
CREATE TABLE IF NOT EXISTS resource_locks_ns (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL DEFAULT '',
  resource_key TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL,
  holder_agent_name TEXT NOT NULL,
  note TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  lease_expiry_emitted_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, scope_key, resource_key)
);
CREATE INDEX IF NOT EXISTS resource_locks_ns_org_expires_idx ON resource_locks_ns (org_id, lease_expires_at);

-- Per-reviewer accept votes toward tasks.required_reviews (src/tasks.ts, migration 26): one row per
-- (task, reviewer) so the same reviewer voting twice never counts twice toward the threshold.
CREATE TABLE IF NOT EXISTS task_reviews (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_agent_id TEXT NOT NULL,
  reviewer_agent_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, reviewer_agent_id)
);

-- Versioned schema migrations applied (src/migrations.ts). Copied so a cutover keeps the version.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL
);

-- The founding offer's global counter (src/billing.ts, migration 41): ONE row, id = 1, holding how many
-- of the 100 places have been taken. Deliberately NOT per workspace -- the promise is "the first 100
-- CUSTOMERS", so the count is a property of the offer, not of any one buyer. A single-row table is the
-- shape that makes the read-and-increment claim in ONE transaction, which is what stops two simultaneous
-- buyers both taking the last place.
CREATE TABLE IF NOT EXISTS founding_places (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  taken INTEGER NOT NULL DEFAULT 0
);

-- The MCP connector (migration 43): OAuth clients, single-use codes, and access/refresh tokens stored as hashes.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  expires_at TIMESTAMPTZ NOT NULL,
  spent_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family_idx ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_agent_idx ON oauth_tokens (agent_id);

-- Transactional email ledger (migration 45): at most one send per workspace, email kind and period.
CREATE TABLE IF NOT EXISTS email_sends (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  provider_message_id TEXT,
  last_error TEXT,
  payload TEXT,
  ambiguous_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, kind, period)
);
CREATE INDEX IF NOT EXISTS email_sends_due_idx ON email_sends (status, next_attempt_at);

-- Migration 44 for a database created before it: CREATE TABLE IF NOT EXISTS leaves an existing memory_entries as it was,
-- so the column is added here, and its index only after it: on an existing database an index on scope_key created any
-- earlier fails before this ALTER runs (review of #618 by Codex-OpenCadre-8160).
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS scope_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS memory_entries_org_scope_idx ON memory_entries (org_id, scope_key);

-- Migration 46 (the payment provider billing, src/billing.ts): provider refs tagged with the provider AND environment they came from,
-- the checkout transactions this hub created (the server-side pending state and the only way a subscription is
-- attributed to a workspace), and the webhook event ids already processed. Additive: the Stripe-era columns stay.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_provider TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS provider_customer_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT;
CREATE INDEX IF NOT EXISTS organizations_provider_subscription_idx ON organizations (provider_subscription_id);
CREATE TABLE IF NOT EXISTS billing_checkouts (
  transaction_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  plan TEXT NOT NULL,
  billing_interval TEXT NOT NULL,
  founding INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS billing_checkouts_org_idx ON billing_checkouts (org_id, created_at);
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL
);

-- Migration 47 (src/billing.ts writeProviderSubscription): what the payment provider is billing, mirrored beside the status, and the
-- the payment provider customer's email (customer.created / customer.updated).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS provider_price_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS provider_quantity INTEGER;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS scheduled_change_action TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS scheduled_change_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS provider_customer_email TEXT;
CREATE INDEX IF NOT EXISTS organizations_provider_customer_idx ON organizations (provider_customer_id);

-- Migration 48: when reading the the payment provider customer's email last failed (the reconcile path retries it).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS provider_customer_email_error_at TIMESTAMPTZ;

-- Migration 49 (card-required trial, src/billing.ts): when the workspace's the payment provider trial started, when it first completed
-- a payment, and the payment provider's next_billed_at (the trial's conversion instant while trialing). The 'pending' plans row
-- ("No plan yet", every enforced limit 0) arrives with the plans table's rows.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_used_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS first_paid_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS provider_next_billed_at TIMESTAMPTZ;

-- Migration 56: additive optional computer build inventory.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS connector_reports TEXT NOT NULL DEFAULT '[]';

-- Migration 57 (PR-E1b connector telemetry): bounded 24 h refusal counts per computer, and the awareness digest's
-- per-computer claims for its connector item ({"<stamp>:<status>": claimedAt epoch ms}, every claim younger than 24 h).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS connector_refusals TEXT NOT NULL DEFAULT '{}';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS connector_digest TEXT NOT NULL DEFAULT '{}';

-- Migration 58: short-lived checkout ownership, fenced by a random token.
CREATE TABLE IF NOT EXISTS billing_checkout_reservations (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  PRIMARY KEY (org_id)
);

-- Migration 59: the last wake POST's outcome per agent (when, delivered/rejected/failed/gave_up, the HTTP status code).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_wake_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_wake_outcome TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_wake_status INTEGER;

-- Migration 61: the work board (src/task-board.ts): lane now | next | held (done is status), NEXT's rank, a held reason.
-- No backfill here: this file is the schema only. The SQLite migration (src/migrations.ts, 61) moves claimed tasks to now,
-- and the data copy (scripts/migrate-to-postgres.mjs) carries each row's lane over as it is.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'next' CHECK (lane IN ('now', 'next', 'held'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rank INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS held_reason TEXT;

-- Migration 60: per-project settings, the WIP cap (src/project-settings.ts). project_key '' is the workspace default.
CREATE TABLE IF NOT EXISTS project_settings (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  wip_cap INTEGER CHECK (wip_cap IS NULL OR (wip_cap BETWEEN 1 AND 50)),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_person_id TEXT,
  PRIMARY KEY (org_id, project_key)
);

-- Migration 50 (one free trial per PERSON, src/billing.ts trialEligible): the person-level trial marker, the workspace's
-- creator, and who started each checkout. Never cleared by a role change or a member leaving.
ALTER TABLE people ADD COLUMN IF NOT EXISTS trial_used_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_by_person_id TEXT;
ALTER TABLE billing_checkouts ADD COLUMN IF NOT EXISTS person_id TEXT;

-- Migration 51 (the MCP connector's authorization side): durable grants, unique among ACTIVE ones only, pending consents
-- keyed by the hash of the consent id, and each code and token naming its grant.
CREATE TABLE IF NOT EXISTS oauth_grants (
  grant_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
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
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_consents_client_idx ON oauth_consents (client_id);
ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS grant_id TEXT;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS grant_id TEXT;

-- Migration 52: the token family an authorization code minted, so a reused code revokes exactly that family.
ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS family_id TEXT;

-- Migration 53 (a PERSON decides clearances, src/approvals.ts): who may decide a request, the person who decided it (a
-- name snapshot and the channel with it), and the person behind a grant. The person columns are write-once in the
-- application (SQLite also enforces it with triggers). No 'supervisor' row may exist until a person can designate a
-- supervisor (plan §4.1): SQLite refuses one with a trigger, Postgres with the constraint below, which the migration
-- that ships designation drops. The data half of migration 53 (revoking every grant with no person provenance) runs on
-- SQLite before a copy, so the copied rows already satisfy it.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decider_kind TEXT NOT NULL DEFAULT 'person' CHECK (decider_kind IN ('person', 'supervisor'));
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_by_person_id TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_by_person_name TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_via TEXT;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_decider_kind_person_only;
ALTER TABLE approvals ADD CONSTRAINT approvals_decider_kind_person_only CHECK (decider_kind = 'person');
ALTER TABLE approval_grants ADD COLUMN IF NOT EXISTS granted_by_person_id TEXT;
ALTER TABLE approval_grants ADD COLUMN IF NOT EXISTS granted_by_person_name TEXT;

-- Migration 54 (tasks tranche 2): the masked search text and the masking version it was built under, a content revision,
-- and a persistent ordering tie-breaker (seq) drawn from task_sequence, which only grows. On SQLite, triggers assign seq
-- on insert and bump revision on every content change; here the copy carries both values as they were, and the
-- application layer is SQLite-only today (src/db-driver-config.ts), so no trigger is mirrored, like migration 53's.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS search_text TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS search_masking TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS seq BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_seq_idx ON tasks (seq);
CREATE INDEX IF NOT EXISTS tasks_org_search_masking_idx ON tasks (org_id, search_masking);
CREATE TABLE IF NOT EXISTS task_sequence (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL
);

-- Migration 55 (sessions PR1, src/agent-names.ts): operator-owned profiles, every address any agent ever held (never
-- reassigned; on SQLite, triggers write it on every agent insert and rename, and like migrations 53 and 54 no trigger is
-- mirrored here), the session a person named into a profile, when the one-time naming prompt was answered, and a saved
-- task's side-request link. agents.profile_id carries no FK here, like agents.device_id: the copy inserts agents first.
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  next_ordinal INTEGER NOT NULL DEFAULT 1,
  created_by_person_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name_key)
);
CREATE TABLE IF NOT EXISTS agent_addresses (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name_key TEXT NOT NULL,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, name_key)
);
CREATE INDEX IF NOT EXISTS agent_addresses_agent_idx ON agent_addresses (agent_id);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS name_prompt_done_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS side_request_of TEXT;
CREATE INDEX IF NOT EXISTS agents_profile_idx ON agents (profile_id);
`;

/** Table -> ordered column list, used by schema-parity tests and the migration script. */
export const POSTGRES_TABLE_COLUMNS: Record<string, string[]> = {
  billing_checkout_reservations: ["org_id", "token", "expires_at_ms"],
  plans: ["key", "name", "max_agents", "retention_days", "trial_days", "max_machines", "max_projects", "max_workspaces", "max_webhooks", "created_at"],
  organizations: ["id", "name", "bootstrap_key_hash", "created_at", "paused_at", "paused_by_agent_name", "project_isolation", "plan", "trial_ends_at", "subscription_status", "billing_customer_ref", "billing_event_at", "lapsed_at", "billing_subscription_ref", "founding_at", "billing_provider", "provider_customer_id", "provider_subscription_id", "provider_price_id", "provider_quantity", "scheduled_change_action", "scheduled_change_at", "provider_customer_email", "provider_customer_email_error_at", "trial_used_at", "first_paid_at", "provider_next_billed_at", "created_by_person_id"],
  agents: [
    "id",
    "org_id",
    "name",
    "url_key",
    "api_key_hash",
    "status",
    "last_heartbeat_at",
    "webhook_url",
    "webhook_auth_header",
    "current_task",
    "editing_files",
    "status_updated_at",
    "created_at",
    "phase",
    "awareness_cursor",
    "key_class",
    "role",
    "usage",
    "kind",
    "device_id",
    "seat_id",
    "tool_session_id",
    "project",
    "ended_at",
    "removed_at",
    "removed_by_agent_name",
    "client",
    "project_name",
    "home_project",
    "scope",
    "liveness",
    "capabilities",
    "round_budget",
    "profile_id",
    "name_prompt_done_at",
    "last_wake_at",
    "last_wake_outcome",
    "last_wake_status",
  ],
  messages: [
    "id",
    "org_id",
    "thread_id",
    "from_agent_id",
    "from_agent_name",
    "to_agent_id",
    "to_agent_name",
    "body",
    "kind",
    "priority",
    "awaiting_reply",
    "created_at",
    "read_at",
    "delivered_at",
    "file_id",
    "project_key",
    "to_project_key",
  ],
  files: [
    "id",
    "org_id",
    "uploaded_by_agent_id",
    "uploaded_by_agent_name",
    "filename",
    "mime_type",
    "size_bytes",
    "content",
    "created_at",
    "project_key",
  ],
  tasks: [
    "id",
    "org_id",
    "title",
    "description",
    "status",
    "created_by_agent_id",
    "created_by_agent_name",
    "claimed_by_agent_id",
    "claimed_by_agent_name",
    "lease_expires_at",
    "completion_summary",
    "created_at",
    "updated_at",
    "completed_at",
    "lease_expiry_emitted_at",
    "project_key",
    "reviewed",
    "reviewed_by_agent_id",
    "reviewed_by_agent_name",
    "reviewed_at",
    "review_note",
    "required_capabilities",
    "min_round_budget",
    "required_reviews",
    "parent_task_id",
    "superseded_by",
    "search_text",
    "search_masking",
    "revision",
    "seq",
    "side_request_of",
    "lane",
    "rank",
    "held_reason",
  ],
  task_sequence: ["name", "value"],
  agent_profiles: ["id", "org_id", "name", "name_key", "next_ordinal", "created_by_person_id", "created_at"],
  agent_addresses: ["org_id", "name_key", "name", "agent_id", "created_at", "released_at"],
  approvals: [
    "id",
    "org_id",
    "requested_by_agent_id",
    "requested_by_agent_name",
    "action",
    "details",
    "risk",
    "category",
    "status",
    "decided_by_agent_id",
    "decided_by_agent_name",
    "decision_note",
    "expires_at",
    "created_at",
    "decided_at",
    "project_key",
    "decider_kind",
    "decided_by_person_id",
    "decided_by_person_name",
    "decided_via",
  ],
  approval_grants: [
    "id",
    "org_id",
    "agent_id",
    "agent_name",
    "category",
    "granted_by_agent_id",
    "granted_by_agent_name",
    "expires_at",
    "created_at",
    "project_key",
    "granted_by_person_id",
    "granted_by_person_name",
  ],
  waitlist: [
    "id",
    "email",
    "name",
    "team_size",
    "tools",
    "note",
    "ip_hash",
    "status",
    "org_id",
    "created_at",
    "approved_at",
  ],
  events: [
    "seq",
    "id",
    "org_id",
    "type",
    "actor_agent_id",
    "actor_agent_name",
    "subject_type",
    "subject_id",
    "target_agent_id",
    "payload",
    "created_at",
    "prev_hash",
    "hash",
    "project_key",
  ],
  event_deliveries: ["event_seq", "agent_id", "state", "delivered_at", "acknowledged_at", "resolved_at"],
  connect_codes: [
    "code_hash",
    "org_id",
    "agent_name",
    "client",
    "created_by_agent_id",
    "created_at",
    "expires_at",
    "redeemed_at",
    "agent_id",
  ],
  message_escalations: ["message_id", "level", "last_notified_at"],
  schema_migrations: ["version", "name", "applied_at"],
  idempotency_keys: ["org_id", "agent_id", "key", "scope", "request_hash", "status", "response", "created_at"],
  clearance_policies: ["org_id", "project", "mode", "updated_by_agent_id", "updated_by_agent_name", "updated_at"],
  project_settings: ["org_id", "project_key", "wip_cap", "updated_at", "updated_by_person_id"],
  people: ["id", "email", "email_verified", "name", "avatar_url", "created_at", "last_sign_in_at", "trial_used_at"],
  sessions: ["token_hash", "person_id", "created_at", "last_used_at", "expires_at"],
  workspace_members: ["org_id", "person_id", "role", "agent_id", "invited_by", "created_at"],
  workspace_invites: ["id", "org_id", "token_hash", "role", "email", "created_by_name", "created_at", "expires_at", "accepted_at", "accepted_by", "revoked_at"],
  push_subscriptions: ["id", "person_id", "endpoint", "p256dh", "auth", "device_label", "created_at", "last_success_at", "last_failure_at", "failure_count"],
  devices: [
    "id",
    "org_id",
    "name",
    "client",
    "credential_hash",
    "code_hash",
    "code_expires_at",
    "code_redeemed_at",
    "created_by_agent_id",
    "created_at",
    "last_seen_at",
    "revoked_at",
    "tools",
    "merged_into_device_id",
    "connector_reports",
    "connector_refusals",
    "connector_digest",
  ],
  projects: ["org_id", "project_key", "name", "enabled", "first_seen_at", "last_seen_at", "enabled_at", "enabled_by_agent_name"],
  project_aliases: ["org_id", "alias_key", "project_key", "created_at"],
  agent_projects: ["agent_id", "project_key"],
  project_links: ["org_id", "project_a", "project_b", "created_by", "created_by_agent_id", "created_at"],
  memory_entries: [
    "id",
    "org_id",
    "title",
    "body",
    "tag",
    "status",
    "archived_reason",
    "superseded_by",
    "created_by_agent_id",
    "created_by_agent_name",
    "created_at",
    "updated_at",
    "archived_at",
    "scope_key",
  ],
  escalation_threads: ["org_id", "recipient_agent_id", "operator_id", "thread_id", "updated_at"],
  goals: ["org_id", "text", "set_by_agent_id", "set_by_agent_name", "set_at", "updated_at"],
  resource_locks: ["org_id", "resource_key", "holder_agent_id", "holder_agent_name", "note", "acquired_at", "lease_expires_at", "lease_expiry_emitted_at"],
  blackboard_facts: ["org_id", "key", "value", "version", "set_by_agent_id", "set_by_agent_name", "set_at", "updated_at"],
  goals_ns: ["org_id", "scope_key", "text", "set_by_agent_id", "set_by_agent_name", "set_at", "updated_at"],
  blackboard_facts_ns: ["org_id", "scope_key", "key", "value", "version", "set_by_agent_id", "set_by_agent_name", "set_at", "updated_at"],
  resource_locks_ns: ["org_id", "scope_key", "resource_key", "holder_agent_id", "holder_agent_name", "note", "acquired_at", "lease_expires_at", "lease_expiry_emitted_at"],
  task_reviews: ["org_id", "task_id", "reviewer_agent_id", "reviewer_agent_name", "created_at"],
  founding_places: ["id", "taken"],
  oauth_clients: ["client_id", "kind", "client_name", "redirect_uris", "created_at"],
  oauth_codes: ["code_hash", "client_id", "redirect_uri", "code_challenge", "resource", "person_id", "org_id", "agent_id", "expires_at", "used_at", "created_at", "grant_id", "family_id"],
  billing_checkouts: ["transaction_id", "org_id", "provider", "plan", "billing_interval", "founding", "created_at", "resolved_at", "outcome", "person_id"],
  billing_webhook_events: ["event_id", "event_type", "processed_at"],
  oauth_tokens: ["token_hash", "kind", "family_id", "client_id", "org_id", "agent_id", "person_id", "resource", "expires_at", "spent_at", "revoked_at", "created_at", "grant_id"],
  oauth_grants: ["grant_id", "person_id", "client_id", "org_id", "scope_key", "agent_id", "created_at", "revoked_at"],
  oauth_consents: ["consent_hash", "person_id", "client_id", "redirect_uri", "resource", "code_challenge", "state", "expires_at", "used_at", "created_at"],
  email_sends: ["org_id", "kind", "period", "status", "attempts", "next_attempt_at", "provider_message_id", "last_error", "payload", "ambiguous_at", "created_at", "updated_at", "sent_at"],
};

/** Columns whose SQLite value (ISO-8601-ish TEXT) must be converted to a JS Date before insert. */
export const TIMESTAMP_COLUMNS = new Set([
  "name_prompt_done_at",
  "last_wake_at",
  "released_at",
  "spent_at",
  "used_at",
  "created_at",
  "updated_at",
  "completed_at",
  "decided_at",
  "expires_at",
  "last_heartbeat_at",
  "status_updated_at",
  "read_at",
  "redeemed_at",
  "delivered_at",
  "founding_at",
  "acknowledged_at",
  "resolved_at",
  "last_notified_at",
  "lease_expires_at",
  "lease_expiry_emitted_at",
  "acquired_at",
  "reviewed_at",
  "approved_at",
  "applied_at",
  "paused_at",
  "last_sign_in_at",
  "last_used_at",
  "accepted_at",
  "revoked_at",
  "last_success_at",
  "last_failure_at",
  "ended_at",
  "code_expires_at",
  "code_redeemed_at",
  "last_seen_at",
  "trial_ends_at",
  "billing_event_at",
  "lapsed_at",
  "scheduled_change_at",
  "provider_customer_email_error_at",
  "trial_used_at",
  "first_paid_at",
  "provider_next_billed_at",
  "removed_at",
  "first_seen_at",
  "enabled_at",
  "archived_at",
  "set_at",
  "next_attempt_at",
  "sent_at",
  "ambiguous_at",
  "processed_at",
]);

/** Columns whose SQLite value (INTEGER 0/1) must be converted to a JS boolean before insert. */
export const BOOLEAN_COLUMNS = new Set(["awaiting_reply", "email_verified", "reviewed"]);

/** Tables in dependency order (referenced tables first) -- also the safe DROP order reversed. */
export const TABLE_INSERT_ORDER = [
  "plans",
  "organizations",
  "billing_checkout_reservations",
  "agents",
  "messages",
  "files",
  "tasks",
  "approvals",
  "approval_grants",
  "waitlist",
  "events",
  "event_deliveries",
  "connect_codes",
  "message_escalations",
  "schema_migrations",
  "idempotency_keys",
  "clearance_policies",
  "project_settings",
  "people",
  "sessions",
  "workspace_members",
  "workspace_invites",
  "push_subscriptions",
  "devices",
  "projects",
  "project_aliases",
  "agent_projects",
  "project_links",
  "memory_entries",
  "escalation_threads",
  "goals",
  "resource_locks",
  "blackboard_facts",
  "goals_ns",
  "blackboard_facts_ns",
  "resource_locks_ns",
  "task_reviews",
  "task_sequence",
  "founding_places",
  "oauth_clients",
  "oauth_codes",
  "oauth_tokens",
  "oauth_grants",
  "oauth_consents",
  "email_sends",
  "billing_checkouts",
  "billing_webhook_events",
  "agent_profiles",
  "agent_addresses",
] as const;

/** Primary key column(s) for each table, used to build idempotent ON CONFLICT upserts. */
export const TABLE_PRIMARY_KEY: Record<string, string[]> = {
  billing_checkout_reservations: ["org_id"],
  plans: ["key"],
  organizations: ["id"],
  agents: ["id"],
  messages: ["id"],
  files: ["id"],
  tasks: ["id"],
  approvals: ["id"],
  approval_grants: ["id"],
  waitlist: ["id"],
  events: ["id"], // NOT seq: seq is a Postgres-assigned BIGSERIAL, source seq is not portable as a key
  event_deliveries: ["event_seq", "agent_id"],
  connect_codes: ["code_hash"],
  message_escalations: ["message_id"],
  schema_migrations: ["version"],
  idempotency_keys: ["org_id", "agent_id", "key"],
  clearance_policies: ["org_id", "project"],
  project_settings: ["org_id", "project_key"],
  people: ["id"],
  sessions: ["token_hash"],
  workspace_members: ["org_id", "person_id"],
  workspace_invites: ["id"],
  push_subscriptions: ["id"],
  devices: ["id"],
  projects: ["org_id", "project_key"],
  project_aliases: ["org_id", "alias_key"],
  agent_projects: ["agent_id", "project_key"],
  project_links: ["org_id", "project_a", "project_b"],
  memory_entries: ["id"],
  escalation_threads: ["org_id", "recipient_agent_id", "operator_id"],
  goals: ["org_id"],
  resource_locks: ["org_id", "resource_key"],
  blackboard_facts: ["org_id", "key"],
  goals_ns: ["org_id", "scope_key"],
  blackboard_facts_ns: ["org_id", "scope_key", "key"],
  resource_locks_ns: ["org_id", "scope_key", "resource_key"],
  task_reviews: ["task_id", "reviewer_agent_id"],
  task_sequence: ["name"],
  agent_profiles: ["id"],
  agent_addresses: ["org_id", "name_key"],
  founding_places: ["id"],
  oauth_clients: ["client_id"],
  oauth_codes: ["code_hash"],
  oauth_tokens: ["token_hash"],
  oauth_grants: ["grant_id"],
  oauth_consents: ["consent_hash"],
  email_sends: ["org_id", "kind", "period"],
  billing_checkouts: ["transaction_id"],
  billing_webhook_events: ["event_id"],
};
