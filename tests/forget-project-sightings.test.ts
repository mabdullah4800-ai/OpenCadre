// src/project-sightings.ts: the hub stops recording folders a computer merely had open (src/projects.ts
// isProjectEnabled), and this forgets the ones it already recorded. A row is deleted only when NOTHING shows that
// anyone meant or used the project, so each reason to keep a row gets its own project here: if a clause of the
// DELETE were dropped, exactly that project would vanish and this test would name it. Measured: removing any one of
// the 17 clauses of SIGHTING_WHERE, one at a time, fails this test.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrations.js";
import { forgetProjectSightings, listProjectSightings } from "../src/project-sightings.js";

/** Inserts a row, filling every other NOT NULL column that has no default with a placeholder, so the fixture states
 * only the columns the migration reads. Foreign keys are off: the placeholders point nowhere. */
function insert(db: Database.Database, table: string, values: Record<string, unknown>): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
  const row: Record<string, unknown> = { ...values };
  for (const c of columns) {
    if (c.name in row || !c.notnull || c.dflt_value !== null) continue;
    row[c.name] = /INT/i.test(c.type) ? 0 : `${table}-${c.name}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const names = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((n) => row[n]));
}

const K = (reason: string) => `github.com/keep/${reason}`;

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  runMigrations(db);
  insert(db, "organizations", { id: "o1", name: "Operator PC", bootstrap_key_hash: "h" });
  insert(db, "organizations", { id: "o2", name: "Other", bootstrap_key_hash: "h" });
  const project = (org: string, key: string, enabled = 0) => insert(db, "projects", { org_id: org, project_key: key, name: key.split(/[/:]/).pop(), enabled });

  // Sightings: disabled, never used, nothing refers to them. Both key forms, in both workspaces.
  project("o1", "github.com/seen/widgets");
  project("o1", "local:scratch");
  project("o2", "gitlab.com/seen/tool");

  // Keeps.
  project("o1", K("enabled"), 1);
  project("o1", "OpenCadre"); // legacy folder-name key
  project("o1", K("ended-agent"));
  insert(db, "agents", { id: "a1", org_id: "o1", name: "ClaudeCode-x-1", url_key: "a1", api_key_hash: "h1", kind: "session", project: K("ended-agent"), ended_at: "2026-09-01 00:00:00" });
  project("o1", K("home-agent"));
  insert(db, "agents", { id: "a2", org_id: "o1", name: "ClaudeCode-x-2", url_key: "a2", api_key_hash: "h2", kind: "session", home_project: K("home-agent") });
  project("o1", K("agent-projects"));
  insert(db, "agents", { id: "a3", org_id: "o1", name: "Named", url_key: "a3", api_key_hash: "h3", kind: "agent" });
  insert(db, "agent_projects", { agent_id: "a3", project_key: K("agent-projects") });
  project("o1", K("alias-target"));
  insert(db, "project_aliases", { org_id: "o1", alias_key: "Legacy", project_key: K("alias-target"), created_at: "t" });
  project("o1", K("alias-source"));
  insert(db, "project_aliases", { org_id: "o1", alias_key: K("alias-source"), project_key: "github.com/elsewhere/x", created_at: "t" });
  project("o1", K("link-a"));
  insert(db, "project_links", { org_id: "o1", project_a: K("link-a"), project_b: "github.com/zzz/other", created_by: "op", created_at: "t" });
  project("o1", K("policy"));
  insert(db, "clearance_policies", { org_id: "o1", project: K("policy"), mode: "ask" });
  project("o1", K("event-subject"));
  insert(db, "events", { org_id: "o1", type: "project.disabled", subject_type: "project", subject_id: K("event-subject") });
  project("o1", K("event-stamp"));
  insert(db, "events", { org_id: "o1", type: "task.created", project_key: K("event-stamp") });
  project("o1", K("message"));
  insert(db, "messages", { id: "m1", org_id: "o1", project_key: K("message") });
  project("o1", K("message-to"));
  insert(db, "messages", { id: "m2", org_id: "o1", to_project_key: K("message-to") });
  project("o1", K("task"));
  insert(db, "tasks", { id: "t1", org_id: "o1", project_key: K("task") });
  project("o1", K("approval"));
  insert(db, "approvals", { id: "ap1", org_id: "o1", project_key: K("approval") });
  project("o1", K("grant"));
  insert(db, "approval_grants", { id: "g1", org_id: "o1", project_key: K("grant") });
  project("o1", K("file"));
  insert(db, "files", { id: "f1", org_id: "o1", project_key: K("file") });
  project("o1", K("goal"));
  insert(db, "goals_ns", { org_id: "o1", scope_key: K("goal"), text: "g" });
  project("o1", K("fact"));
  insert(db, "blackboard_facts_ns", { org_id: "o1", scope_key: K("fact"), key: "k" });
  project("o1", K("lock"));
  insert(db, "resource_locks_ns", { org_id: "o1", scope_key: K("lock"), resource_key: "r" });
  project("o1", K("memory"));
  insert(db, "memory_entries", { id: "me1", org_id: "o1", scope_key: K("memory") });

  // A reference in ANOTHER workspace does not keep a sighting: every clause is scoped to the row's own org.
  project("o2", "github.com/seen/crossorg");
  insert(db, "project_aliases", { org_id: "o1", alias_key: "Cross", project_key: "github.com/seen/crossorg", created_at: "t" });
  return db;
}

const keysOf = (db: Database.Database) =>
  (db.prepare(`SELECT org_id || ' ' || project_key AS k FROM projects ORDER BY org_id, project_key`).all() as Array<{ k: string }>).map((r) => r.k);

const EXPECTED_SIGHTINGS = [
  "o1 github.com/seen/widgets",
  "o1 local:scratch",
  "o2 github.com/seen/crossorg",
  "o2 gitlab.com/seen/tool",
];
const KEEP_REASONS = ["enabled", "ended-agent", "home-agent", "agent-projects", "alias-target", "alias-source", "link-a", "policy",
  "event-subject", "event-stamp", "message", "message-to", "task", "approval", "grant", "file", "goal", "fact", "lock", "memory"];

describe("forgetting project sightings", () => {
  it("deletes exactly the sightings and keeps every project someone meant or used, each for its own reason", () => {
    const db = fixture();
    const before = keysOf(db);
    const removed = forgetProjectSightings(db);
    expect(removed.map((r) => `${r.orgId} ${r.projectKey}`)).toEqual(EXPECTED_SIGHTINGS);
    expect(before.filter((k) => !keysOf(db).includes(k))).toEqual(EXPECTED_SIGHTINGS);
    // Every keep survived, named, so a dropped clause shows up as the one project it was guarding.
    for (const reason of KEEP_REASONS) expect(keysOf(db), reason).toContain(`o1 ${K(reason)}`);
    expect(keysOf(db)).toContain("o1 OpenCadre");
  });

  it("listing reads only; forgetting again finds nothing; --org limits both to one workspace", () => {
    const db = fixture();
    const before = keysOf(db);
    expect(listProjectSightings(db).map((r) => `${r.orgId} ${r.projectKey}`)).toEqual(EXPECTED_SIGHTINGS);
    expect(keysOf(db)).toEqual(before);
    expect(forgetProjectSightings(db, { orgId: "o2" }).map((r) => r.projectKey)).toEqual(["github.com/seen/crossorg", "gitlab.com/seen/tool"]);
    expect(listProjectSightings(db).map((r) => `${r.orgId} ${r.projectKey}`)).toEqual(["o1 github.com/seen/widgets", "o1 local:scratch"]);
    forgetProjectSightings(db);
    expect(forgetProjectSightings(db)).toEqual([]);
  });
});

describe("scripts/forget-project-sightings.mjs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-sightings-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (file: string, ...args: string[]) =>
    execFileSync(process.execPath, [path.resolve("scripts/forget-project-sightings.mjs"), "--db", file, ...args], { encoding: "utf8" });

  it("lists by default and changes nothing; deletes only with --apply", () => {
    const file = path.join(dir, "hub.db");
    // Built in memory and written once: migrating a file directly fsyncs every migration, which is seconds on a slow disk.
    const seeded = fixture();
    const before = keysOf(seeded);
    writeFileSync(file, seeded.serialize());
    seeded.close();

    const listed = run(file);
    expect(listed).toContain("4 project sightings found. Nothing was changed; run again with --apply to delete them.");
    for (const k of EXPECTED_SIGHTINGS) expect(listed).toContain(k.replace(" ", "  "));
    const afterList = new Database(file, { readonly: true });
    expect(keysOf(afterList)).toEqual(before);
    afterList.close();

    expect(JSON.parse(run(file, "--apply", "--json"))).toEqual({
      applied: true,
      sightings: EXPECTED_SIGHTINGS.map((k) => { const [orgId, projectKey] = k.split(" "); return { orgId, projectKey, name: expect.any(String) }; }),
    });
    const afterApply = new Database(file, { readonly: true });
    expect(keysOf(afterApply)).toEqual(before.filter((k) => !EXPECTED_SIGHTINGS.includes(k)));
    afterApply.close();
    expect(run(file)).toContain("0 project sightings found.");
  });

  it("refuses a missing value, an unknown flag or a repeated one BEFORE opening the database, and deletes nothing", () => {
    const file = path.join(dir, "strict.db");
    const seeded = fixture();
    const before = keysOf(seeded);
    writeFileSync(file, seeded.serialize());
    seeded.close();
    const attempt = (...args: string[]) => spawnSync(process.execPath, [path.resolve("scripts/forget-project-sightings.mjs"), ...args], { encoding: "utf8" });
    for (const [args, says] of [
      [["--db", file, "--apply", "--org"], "--org needs a value"], // would have meant EVERY workspace
      [["--db", file, "--org", "--apply"], "--org needs a value"],
      [["--db", "--apply"], "--db needs a value"], // would have meant the default database
      [["--db", file, "--apply", "--org", "o1", "--org", "o2"], "--org given more than once"],
      [["--db", file, "--apply", "--orgs", "o1"], 'unknown argument "--orgs"'],
      [["--db", file, "--apply", "o1"], 'unknown argument "o1"'],
    ] as const) {
      const r = attempt(...args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain(says);
    }
    const after = new Database(file, { readonly: true });
    expect(keysOf(after)).toEqual(before);
    after.close();
  });
});
