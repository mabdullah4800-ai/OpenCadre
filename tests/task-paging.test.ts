import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { invalidateScopes } from "../src/scope.js";
import Database from "better-sqlite3";
import { acceptTask, claimTask, completeTask, createTask, getTaskById, listTasks, parseTaskListQuery, rebuildTaskSearchText, rejectTask, renewClaim, taskCursorBinding } from "../src/tasks.js";
import { MIGRATIONS, runMigrations } from "../src/migrations.js";
import { MASKING_VERSION } from "../src/secrets.js";
import { cursorSecretFrom, signTaskCursor } from "../src/task-cursor.js";

/**
 * Tasks tranche 2 (docs/superpowers/plans/2026-09-30-task-paging.md; §0 is Codex-OpenCadre-049a's binding ruling):
 * summaries, keyset paging with an authenticated cursor, the five count buckets, and the batched view.
 *
 * GET /v1/tasks with no new parameter keeps today's unbounded full response and its exact shape. Every new parameter
 * opts into the paged response: { tasks, nextCursor, counts, projects }.
 */

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let ip = 0;
async function get(key: string, route: string): Promise<{ status: number; body: any; bytes: number }> {
  const res = await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${key}`, "x-forwarded-for": `10.77.${Math.floor(++ip / 250)}.${ip % 250}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, bytes: Buffer.byteLength(text) };
}

// --- Fixtures ------------------------------------------------------------------------------------------------------
let orgCounter = 0;
function workspace() {
  const { orgId } = createOrganization(`Paging Org ${++orgCounter}`);
  const mk = (name: string, role: "operator" | "agent" = "agent") => {
    const r = registerAgent(orgId, name, { role });
    return { id: r.agentId, name, key: r.apiKey };
  };
  return { orgId, a: mk("Ada", "operator"), b: mk("Bo"), c: mk("Cy") };
}

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
const PAST = () => new Date(Date.now() - 3_600_000).toISOString();
let taskCounter = 0;
type Row = Partial<{
  id: string; title: string; description: string | null; status: string; created_by_agent_id: string; created_by_agent_name: string;
  claimed_by_agent_id: string | null; claimed_by_agent_name: string | null; lease_expires_at: string | null; completion_summary: string | null;
  created_at: string; updated_at: string; completed_at: string | null; reviewed: number; review_note: string | null; project_key: string | null;
  superseded_by: string | null; parent_task_id: string | null; required_reviews: number; side_request_of: string | null;
}>;
/** Inserts a task row directly, so timestamps (and their collisions) are exact. Returns its id. */
function put(orgId: string, creator: { id: string; name: string }, row: Row = {}): string {
  const id = row.id ?? `task-${++taskCounter}`;
  const at = row.created_at ?? "2026-09-01 10:00:00";
  const full = {
    id, org_id: orgId, title: row.title ?? `Task ${id}`, description: row.description ?? null, status: row.status ?? "open",
    created_by_agent_id: row.created_by_agent_id ?? creator.id, created_by_agent_name: row.created_by_agent_name ?? creator.name,
    claimed_by_agent_id: row.claimed_by_agent_id ?? null, claimed_by_agent_name: row.claimed_by_agent_name ?? null,
    lease_expires_at: row.lease_expires_at ?? null, completion_summary: row.completion_summary ?? null, created_at: at,
    updated_at: row.updated_at ?? at, completed_at: row.completed_at ?? null, reviewed: row.reviewed ?? 0, review_note: row.review_note ?? null,
    project_key: row.project_key ?? null, superseded_by: row.superseded_by ?? null, parent_task_id: row.parent_task_id ?? null,
    required_reviews: row.required_reviews ?? 1, side_request_of: row.side_request_of ?? null,
  };
  const cols = Object.keys(full);
  db.prepare(`INSERT INTO tasks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(full));
  return id;
}
const claimed = (who: { id: string; name: string }, active: boolean): Row =>
  ({ status: "claimed", claimed_by_agent_id: who.id, claimed_by_agent_name: who.name, lease_expires_at: active ? FUTURE() : PAST() });
const done = (who: { id: string; name: string }, reviewed: boolean, completedAt = "2026-09-02 10:00:00"): Row =>
  ({ status: "done", claimed_by_agent_id: who.id, claimed_by_agent_name: who.name, completed_at: completedAt, reviewed: reviewed ? 1 : 0, completion_summary: "Shipped." });

/** Project isolation on, with `agent` a project-scope agent at home in `home`. Projects are created as needed. */
function isolate(orgId: string, agent: { id: string }, home: string, ...others: string[]) {
  for (const key of [home, ...others]) {
    db.prepare(`INSERT OR IGNORE INTO projects (org_id, project_key, name, enabled) VALUES (?, ?, ?, 1)`).run(orgId, key, key.split("/").pop());
  }
  db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(home, agent.id);
  db.prepare(`UPDATE organizations SET project_isolation = 1 WHERE id = ?`).run(orgId);
  invalidateScopes();
}

/** Every statement execution, counted at the one prototype all better-sqlite3 statements share. */
function countStatements() {
  const proto = Object.getPrototypeOf(db.prepare("SELECT 1")) as Record<string, (...a: unknown[]) => unknown>;
  const originals: Record<string, (...a: unknown[]) => unknown> = {};
  const seen: string[] = [];
  for (const m of ["run", "get", "all", "iterate"]) {
    originals[m] = proto[m];
    proto[m] = function (this: { source: string }, ...args: unknown[]) { seen.push(this.source); return originals[m].apply(this, args); };
  }
  return { seen, stop: () => { for (const m of Object.keys(originals)) proto[m] = originals[m]; } };
}
async function measured(key: string, route: string) {
  const counter = countStatements();
  try {
    const res = await get(key, route);
    return { ...res, statements: counter.seen.length, sources: [...counter.seen] };
  } finally {
    counter.stop();
  }
}

const allPages = async (key: string, route: string, limit: number) => {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const r = await get(key, `${route}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    ids.push(...r.body.tasks.map((t: { id: string }) => t.id));
    cursor = r.body.nextCursor;
    if (!cursor) return ids;
  }
  throw new Error("more than 100 pages");
};

// --- Legacy shape ----------------------------------------------------------------------------------------------------
describe("GET /v1/tasks with no new parameter is exactly today's response", () => {
  it("returns only { tasks }, every task in full, unbounded, oldest first", async () => {
    const { orgId, a, b } = workspace();
    for (let i = 0; i < 520; i++) put(orgId, a, { title: `t${i}`, description: "d".repeat(50), created_at: `2026-09-01 10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}` });
    put(orgId, a, { ...done(b, false), title: "finished", created_at: "2026-09-01 11:00:00" });
    const r = await get(a.key, "/v1/tasks");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(["tasks"]);
    expect(r.body.tasks).toHaveLength(521); // no default limit for a legacy caller
    expect(r.body.tasks[0].title).toBe("t0");
    expect(r.body.tasks.at(-1).title).toBe("finished");
    // The full TaskView, field for field, as the single-row read gives it.
    const one = getTaskById(orgId, a, r.body.tasks.at(-1).id)!;
    expect(r.body.tasks.at(-1)).toEqual(JSON.parse(JSON.stringify(one)));
    expect(Object.keys(r.body.tasks[0]).sort()).toEqual(Object.keys(one).sort());
    // Exactly the keys the legacy list had before tranche 2 (main 69c4ef00): nothing migration 54 adds leaks into it. Plus
    // side_request_of and its visible-only title, the additive fields migration 55 gives every task (save_task's link; null otherwise),
    // and the work board's lane, rank and held_reason (migration 61).
    expect(Object.keys(r.body.tasks[0]).sort()).toEqual([
      "claimed_by_agent_id", "claimed_by_agent_name", "completed_at", "completion_summary", "created_at", "created_by_agent_id",
      "created_by_agent_name", "description", "held_reason", "id", "lane", "lease_active", "lease_expires_at", "lease_expiry_emitted_at", "min_round_budget",
      "org_id", "parent_task_id", "project_key", "rank", "required_capabilities", "required_capabilities_list", "required_reviews", "review_count",
      "review_note", "reviewed", "reviewed_at", "reviewed_by_agent_id", "reviewed_by_agent_name", "side_request_of", "side_request_of_title", "status", "subtask_count", "subtasks_done",
      "superseded", "superseded_by", "superseded_by_title", "title", "updated_at",
    ]);
    expect(r.body.tasks.at(-1).completion_summary).toBe("Shipped.");
    expect(r.body.tasks[0]).not.toHaveProperty("has_description");
  });

  it("status stays the legacy raw filter, and an unknown status is still ignored (unchanged)", async () => {
    const { orgId, a, b } = workspace();
    put(orgId, a, { title: "open one" });
    put(orgId, a, { ...claimed(b, false), title: "expired claim" });
    put(orgId, a, { ...done(b, true), title: "done one" });
    const claimedOnly = await get(a.key, "/v1/tasks?status=claimed");
    expect(Object.keys(claimedOnly.body)).toEqual(["tasks"]);
    expect(claimedOnly.body.tasks.map((t: { title: string }) => t.title)).toEqual(["expired claim"]);
    const bogus = await get(a.key, "/v1/tasks?status=bogus");
    expect(bogus.status).toBe(200);
    expect(bogus.body.tasks).toHaveLength(3);
  });
});

// --- Batched view ------------------------------------------------------------------------------------------------------
describe("the batched list view equals the per-row view", () => {
  function fixture() {
    const w = workspace();
    const { orgId, a, b, c } = w;
    isolate(orgId, c, "github.com/acme/alpha", "github.com/acme/beta");
    // a and b stay workspace scope; c sees only alpha.
    const reviewed2 = put(orgId, a, { ...done(b, false), title: "needs two reviews", required_reviews: 2, project_key: "github.com/acme/alpha" });
    db.prepare(`INSERT INTO task_reviews (org_id, task_id, reviewer_agent_id, reviewer_agent_name) VALUES (?, ?, ?, ?)`).run(orgId, reviewed2, a.id, a.name);
    const parent = put(orgId, a, { title: "parent", project_key: "github.com/acme/alpha" });
    put(orgId, a, { ...done(b, true), title: "child done", parent_task_id: parent, project_key: "github.com/acme/alpha" });
    put(orgId, a, { title: "child open", parent_task_id: parent, project_key: "github.com/acme/alpha" });
    const visibleNew = put(orgId, a, { title: "visible replacement", project_key: "github.com/acme/alpha" });
    put(orgId, a, { title: "replaced, visibly", superseded_by: visibleNew, project_key: "github.com/acme/alpha" });
    const hiddenNew = put(orgId, a, { title: "HIDDEN replacement title", project_key: "github.com/acme/beta" });
    put(orgId, a, { title: "replaced, hidden", superseded_by: hiddenNew, project_key: "github.com/acme/alpha" });
    // save_task's link resolves its title under the same rule: visible origin named, hidden origin withheld.
    put(orgId, a, { title: "side, visibly", side_request_of: visibleNew, project_key: "github.com/acme/alpha" });
    put(orgId, a, { title: "side, hidden", side_request_of: hiddenNew, project_key: "github.com/acme/alpha" });
    put(orgId, a, { ...claimed(b, false), title: "expired lease", project_key: "github.com/acme/alpha" });
    put(orgId, a, { ...claimed(b, true), title: "active lease", project_key: "github.com/acme/alpha" });
    put(orgId, a, { title: "leaky sk-ant-api03-" + "A".repeat(40), description: "key ghp_" + "b".repeat(36), project_key: "github.com/acme/alpha" });
    put(orgId, a, { title: "workspace-level" });
    return w;
  }

  it("for every viewer, each listed row deep-equals getTaskById's row, a hidden replacement included", () => {
    const { orgId, a, c } = fixture();
    for (const viewer of [a, c]) {
      const listed = listTasks(orgId, { viewer: viewer.id });
      expect(listed.length).toBeGreaterThan(5);
      for (const row of listed) expect(row, row.title).toEqual(getTaskById(orgId, viewer, row.id));
    }
    const cRows = listTasks(orgId, { viewer: c.id });
    expect(cRows.find((t) => t.title === "replaced, hidden")!.superseded_by_title).toBeNull();
    expect(cRows.find((t) => t.title === "replaced, visibly")!.superseded_by_title).toBe("visible replacement");
    expect(cRows.find((t) => t.title === "side, hidden")!.side_request_of_title).toBeNull();
    expect(cRows.find((t) => t.title === "side, visibly")!.side_request_of_title).toBe("visible replacement");
    expect(cRows.find((t) => t.title === "needs two reviews")!.review_count).toBe(1);
    expect(cRows.find((t) => t.title === "parent")).toMatchObject({ subtask_count: 2, subtasks_done: 1 });
    expect(JSON.stringify(cRows)).not.toContain("HIDDEN replacement title");
    expect(JSON.stringify(cRows)).not.toContain("A".repeat(40)); // masked on the batched path too
    expect(listTasks(orgId, { viewer: a.id }).find((t) => t.title === "replaced, hidden")!.superseded_by_title).toBe("HIDDEN replacement title");
    expect(listTasks(orgId, { viewer: a.id }).find((t) => t.title === "side, hidden")!.side_request_of_title).toBe("HIDDEN replacement title");
  });

  it("the paged full rows (summary off) equal the per-row view too, and so does a list longer than one IN chunk", async () => {
    const { orgId, a, c } = fixture();
    const r = await get(c.key, "/v1/tasks?limit=500");
    // A paged row adds only its content revision (migration 54); the rest is the per-row view, field for field.
    for (const { revision, ...row } of r.body.tasks) {
      expect(Number.isInteger(revision), row.title).toBe(true);
      expect(row, row.title).toEqual(JSON.parse(JSON.stringify(getTaskById(orgId, c, row.id))));
    }
    const big = workspace();
    const ids = Array.from({ length: 1234 }, (_, i) => put(big.orgId, big.a, { title: `bulk ${i}` }));
    for (let i = 0; i < ids.length; i += 7) db.prepare(`INSERT INTO task_reviews (org_id, task_id, reviewer_agent_id, reviewer_agent_name) VALUES (?, ?, ?, ?)`).run(big.orgId, ids[i], big.b.id, big.b.name);
    const listed = listTasks(big.orgId, { viewer: big.a.id });
    expect(listed).toHaveLength(1234);
    for (const i of [0, 7, 499, 500, 501, 1000, 1001, 1232, 1233]) expect(listed[i]).toEqual(getTaskById(big.orgId, big.a, ids[i]));
  });
});

// --- Counts --------------------------------------------------------------------------------------------------------
describe("counts: five disjoint buckets over the same q/project/mine scope, before any column or page", () => {
  it("open, expired, in_progress, needs_review and done partition the tasks", async () => {
    const { orgId, a, b } = workspace();
    put(orgId, a, { title: "o1" }); put(orgId, a, { title: "o2" });
    put(orgId, a, { ...claimed(b, false), title: "x1" });
    put(orgId, a, { ...claimed(b, false), lease_expires_at: null, title: "x2 (no lease)" });
    put(orgId, a, { ...claimed(b, true), title: "p1" });
    put(orgId, a, { ...done(b, false), title: "r1" }); put(orgId, a, { ...done(b, false), title: "r2" });
    put(orgId, a, { ...done(b, true), title: "d1" });
    const r = await get(a.key, "/v1/tasks?summary=1&column=in_progress&limit=1");
    expect(r.body.counts).toEqual({ open: 2, expired: 2, in_progress: 1, needs_review: 2, done: 1 });
    // The columns: Open = open + expired, In progress = in_progress, Done = needs_review + done.
    const titles = async (column: string) => (await get(a.key, `/v1/tasks?summary=1&column=${column}`)).body.tasks.map((t: { title: string }) => t.title).sort();
    expect(await titles("open")).toEqual(["o1", "o2", "x1", "x2 (no lease)"]);
    expect(await titles("in_progress")).toEqual(["p1"]);
    expect(await titles("done")).toEqual(["d1", "r1", "r2"]);
  });

  it("follow q, project and mine, and the viewer's scope", async () => {
    const { orgId, a, b, c } = workspace();
    isolate(orgId, c, "github.com/acme/alpha", "github.com/acme/beta");
    put(orgId, a, { title: "Fix login", project_key: "github.com/acme/alpha" });
    put(orgId, b, { ...claimed(a, true), title: "Fix logout", project_key: "github.com/acme/beta" });
    put(orgId, b, { ...done(b, false), title: "Write docs", description: "about login", project_key: "github.com/acme/alpha" });
    put(orgId, a, { ...done(a, false), title: "Own work" });
    put(orgId, b, { ...done(c, true), title: "Reviewed work", project_key: "github.com/acme/alpha" });
    const counts = async (key: string, q: string) => (await get(key, `/v1/tasks?summary=1&limit=0${q}`)).body.counts;
    expect(await counts(a.key, "")).toEqual({ open: 1, expired: 0, in_progress: 1, needs_review: 2, done: 1 });
    expect(await counts(a.key, "&q=login")).toEqual({ open: 1, expired: 0, in_progress: 0, needs_review: 1, done: 0 }); // title or description
    expect(await counts(a.key, "&project=github.com/acme/beta")).toEqual({ open: 0, expired: 0, in_progress: 1, needs_review: 0, done: 0 });
    expect(await counts(a.key, "&mine=created")).toEqual({ open: 1, expired: 0, in_progress: 0, needs_review: 1, done: 0 });
    expect(await counts(a.key, "&mine=claimed")).toEqual({ open: 0, expired: 0, in_progress: 1, needs_review: 0, done: 0 });
    // review: done, unreviewed, and not held by this viewer ("Own work" is a's own).
    expect(await counts(a.key, "&mine=review")).toEqual({ open: 0, expired: 0, in_progress: 0, needs_review: 1, done: 0 });
    // c sees alpha only: no beta, no workspace-level row.
    expect(await counts(c.key, "")).toEqual({ open: 1, expired: 0, in_progress: 0, needs_review: 1, done: 1 });
    expect(await counts(c.key, "&project=github.com/acme/beta")).toEqual({ open: 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 });
    // limit=0 is counts only.
    expect((await get(a.key, "/v1/tasks?summary=1&limit=0")).body.tasks).toEqual([]);
  });

  it("one comparison time serves rows and counts: a lease on the boundary is in exactly one bucket", async () => {
    const { orgId, a, b } = workspace();
    for (let i = 0; i < 30; i++) put(orgId, a, { ...claimed(b, true), lease_expires_at: new Date(Date.now() + 5 + i).toISOString(), title: `edge ${i}` });
    const open = await get(a.key, "/v1/tasks?summary=1&column=open&limit=500");
    const counts = open.body.counts;
    expect(counts.expired + counts.in_progress).toBe(30);
    expect(open.body.tasks.length).toBe(counts.open + counts.expired);
    for (const t of open.body.tasks) expect(t.lease_active).toBe(false);
  });
});

// --- Parameters ------------------------------------------------------------------------------------------------------
describe("parameters are validated, never reinterpreted", () => {
  it.each([
    "summary=2", "summary=yes", "limit=501", "limit=-1", "limit=abc", "limit=1.5", "limit=", "column=closed", "mine=everyone",
    "status=bogus&summary=1", "q=" + "x".repeat(201), "project=" + encodeURIComponent("not a key!"), "limit=1&limit=2", "cursor=nope",
    "cursor=" + "c".repeat(600),
  ])("400 for %s", async (query) => {
    const { a } = workspace();
    const r = await get(a.key, `/v1/tasks?${query}`);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(typeof r.body.error).toBe("string");
  });

  it("summary=1 without a limit gives 200 rows and a cursor; the maximum is 500", async () => {
    const { orgId, a } = workspace();
    for (let i = 0; i < 520; i++) put(orgId, a, { title: `t${i}`, created_at: `2026-09-01 10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}` });
    const first = await get(a.key, "/v1/tasks?summary=1");
    expect(first.body.tasks).toHaveLength(200);
    expect(typeof first.body.nextCursor).toBe("string");
    expect(Object.keys(first.body).sort()).toEqual(["counts", "nextCursor", "projects", "tasks"]);
    const max = await get(a.key, "/v1/tasks?summary=1&limit=500");
    expect(max.body.tasks).toHaveLength(500);
    const last = await get(a.key, `/v1/tasks?summary=1&limit=500&cursor=${encodeURIComponent(max.body.nextCursor)}`);
    expect(last.body.tasks).toHaveLength(20);
    expect(last.body.nextCursor).toBeNull();
  });

  it("summary=true and summary=0 are read as booleans; q may be empty", async () => {
    const { orgId, a } = workspace();
    put(orgId, a, { title: "one", description: "long" });
    expect((await get(a.key, "/v1/tasks?summary=true")).body.tasks[0]).not.toHaveProperty("description");
    expect((await get(a.key, "/v1/tasks?summary=0&limit=5")).body.tasks[0].description).toBe("long");
    expect((await get(a.key, "/v1/tasks?summary=1&q=")).body.tasks).toHaveLength(1);
  });
});

// --- Summary projection ---------------------------------------------------------------------------------------------
describe("summary projection", () => {
  it("omits description and completion summary in SQL, and says whether each exists", async () => {
    const { orgId, a, b } = workspace();
    put(orgId, a, { title: "with text", description: "D".repeat(1500) });
    put(orgId, a, { ...done(b, false), title: "finished", completion_summary: "S".repeat(900) });
    put(orgId, a, { title: "bare" });
    const r = await measured(a.key, "/v1/tasks?summary=1&limit=10");
    const byTitle = Object.fromEntries(r.body.tasks.map((t: { title: string }) => [t.title, t]));
    for (const t of r.body.tasks) {
      expect(t).not.toHaveProperty("description");
      expect(t).not.toHaveProperty("completion_summary");
    }
    expect(byTitle["with text"]).toMatchObject({ has_description: true, has_completion_summary: false });
    expect(byTitle.finished).toMatchObject({ has_description: false, has_completion_summary: true });
    expect(byTitle.bare).toMatchObject({ has_description: false, has_completion_summary: false });
    expect(r.bytes).toBeLessThan(5000);
    // Every other field of the full row is there: the summary drops exactly the two large texts -- and, for now, the work
    // board's lane, rank and held_reason (migration 61). A 200-row summary page already sits at ~199 KB of its 200 KB
    // budget (the next describe), so the console's lane columns (a follow-up PR) decide how they fit; the board itself
    // is GET /v1/tasks?board=1.
    const BOARD_ONLY = ["lane", "rank", "held_reason"];
    const fullKeys = Object.keys((await get(a.key, "/v1/tasks")).body.tasks[0]);
    expect(Object.keys(byTitle.bare).sort()).toEqual(
      [...fullKeys.filter((k) => k !== "description" && k !== "completion_summary" && !BOARD_ONLY.includes(k)), "has_description", "has_completion_summary", "has_review_note", "revision"].sort());
    // The page's own SELECT never names the large columns except to test for their presence.
    const page = r.sources.filter((s) => /FROM tasks/.test(s) && /LIMIT/.test(s) && !/lease_expiry_emitted_at IS NULL/.test(s));
    expect(page.length).toBe(1);
    expect(page[0]).not.toMatch(/SELECT \*|\bt\.\*/);
    const presenceTestsRemoved = page[0].replace(/NULLIF\((description|completion_summary), ''\) IS NOT NULL/g, "");
    expect(presenceTestsRemoved.match(/\b(description|completion_summary)\b/g)).toBeNull();
  });

  it("keeps a short review note, and withholds (never clips) a long one", async () => {
    const { orgId, a, b } = workspace();
    put(orgId, a, { ...claimed(b, true), title: "short note", review_note: "tests missing" });
    put(orgId, a, { ...claimed(b, true), title: "long note", review_note: "n".repeat(2000) });
    const r = await get(a.key, "/v1/tasks?summary=1&column=in_progress");
    const byTitle = Object.fromEntries(r.body.tasks.map((t: { title: string }) => [t.title, t]));
    expect(byTitle["short note"]).toMatchObject({ review_note: "tests missing", has_review_note: true });
    expect(byTitle["long note"]).toMatchObject({ review_note: null, has_review_note: true });
    // The full record still has it.
    expect((await get(a.key, `/v1/tasks/${byTitle["long note"].id}`)).body.task.review_note).toBe("n".repeat(2000));
  });

  it("the lazy detail read (GET /v1/tasks/:id) exposes the completion summary, so independent review works", async () => {
    const { orgId, a, b } = workspace();
    const id = put(orgId, a, { ...done(b, false), title: "to review", completion_summary: "Here is what I did." });
    const r = await get(a.key, `/v1/tasks/${id}`);
    expect(r.body.task.completion_summary).toBe("Here is what I did.");
  });
});

// --- Keyset paging -----------------------------------------------------------------------------------------------------
describe("keyset paging", () => {
  it("holds under duplicate timestamps, in the board's order", async () => {
    const { orgId, a, b } = workspace();
    const same = Array.from({ length: 7 }, (_, i) => put(orgId, a, { title: `same ${i}`, created_at: "2026-09-01 10:00:00" }));
    const doneIds = Array.from({ length: 7 }, (_, i) => put(orgId, a, { ...done(b, i % 2 === 0, i < 4 ? "2026-09-05 10:00:00" : "2026-09-04 10:00:00"), title: `done ${i}` }));
    expect(await allPages(a.key, "/v1/tasks?summary=1&column=open", 3)).toEqual(same);
    // Done: completed_at DESC, then the newest-inserted first among equal times.
    expect(await allPages(a.key, "/v1/tasks?summary=1&column=done", 2)).toEqual([doneIds[3], doneIds[2], doneIds[1], doneIds[0], doneIds[6], doneIds[5], doneIds[4]]);
    // No column: the legacy order (created_at, then insertion).
    expect((await allPages(a.key, "/v1/tasks?summary=1", 4)).slice(0, 7)).toEqual(same);
  });

  it("the Open and In progress columns keep the board's current order", async () => {
    const { orgId, a, b } = workspace();
    const ids = [
      put(orgId, a, { title: "late open", created_at: "2026-09-03 10:00:00" }),
      put(orgId, a, { ...claimed(b, false), title: "early expired", created_at: "2026-09-01 10:00:00" }),
      put(orgId, a, { title: "mid open", created_at: "2026-09-02 10:00:00" }),
    ];
    expect(await allPages(a.key, "/v1/tasks?summary=1&column=open", 1)).toEqual([ids[1], ids[2], ids[0]]);
    expect(listTasks(orgId).filter((t) => t.status === "open" || !t.lease_active).map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("is not a snapshot: inserts land at the end, deleted rows (the cursor's own included) are skipped, moved rows leave", async () => {
    const { orgId, a, b } = workspace();
    const ids = Array.from({ length: 9 }, (_, i) => put(orgId, a, { title: `row ${i}`, created_at: `2026-09-01 10:00:0${i}` }));
    const p1 = await get(a.key, "/v1/tasks?summary=1&column=open&limit=3");
    expect(p1.body.tasks.map((t: { id: string }) => t.id)).toEqual(ids.slice(0, 3));
    db.prepare(`DELETE FROM tasks WHERE id IN (?, ?)`).run(ids[2], ids[4]); // the cursor's row and one ahead of it
    db.prepare(`UPDATE tasks SET status = 'done', completed_at = '2026-09-09 00:00:00', claimed_by_agent_id = ?, claimed_by_agent_name = ? WHERE id = ?`).run(b.id, b.name, ids[5]);
    const added = put(orgId, a, { title: "added later", created_at: "2026-09-02 00:00:00" });
    const rest: string[] = [];
    let cursor = p1.body.nextCursor;
    while (cursor) {
      const r = await get(a.key, `/v1/tasks?summary=1&column=open&limit=3&cursor=${encodeURIComponent(cursor)}`);
      rest.push(...r.body.tasks.map((t: { id: string }) => t.id));
      cursor = r.body.nextCursor;
    }
    expect(rest).toEqual([ids[3], ids[6], ids[7], ids[8], added]);
    expect((await get(a.key, "/v1/tasks?summary=1&column=done")).body.tasks.map((t: { id: string }) => t.id)).toEqual([ids[5]]);
  });

  it("a lease that expires between two calls moves the row from In progress to Open, without duplicates", async () => {
    const { orgId, a, b } = workspace();
    const ids = Array.from({ length: 4 }, (_, i) => put(orgId, a, { ...claimed(b, true), title: `working ${i}`, created_at: `2026-09-01 10:00:0${i}` }));
    const p1 = await get(a.key, "/v1/tasks?summary=1&column=in_progress&limit=2");
    expect(p1.body.tasks.map((t: { id: string }) => t.id)).toEqual(ids.slice(0, 2));
    db.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ?`).run(PAST(), ids[2]);
    const p2 = await get(a.key, `/v1/tasks?summary=1&column=in_progress&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.tasks.map((t: { id: string }) => t.id)).toEqual([ids[3]]);
    expect(p2.body.counts).toMatchObject({ in_progress: 3, expired: 1 });
    expect((await get(a.key, "/v1/tasks?summary=1&column=open")).body.tasks.map((t: { id: string }) => t.id)).toEqual([ids[2]]);
  });

  it("the scope is re-applied on every page: a cursor never grants what the viewer can no longer see", async () => {
    const { orgId, a, c } = workspace();
    const ids = Array.from({ length: 6 }, (_, i) => put(orgId, a, { title: `row ${i}`, created_at: `2026-09-01 10:00:0${i}`, project_key: i % 2 ? "github.com/acme/beta" : "github.com/acme/alpha" }));
    const p1 = await get(c.key, "/v1/tasks?summary=1&limit=2");
    expect(p1.body.tasks.map((t: { id: string }) => t.id)).toEqual(ids.slice(0, 2));
    isolate(orgId, c, "github.com/acme/alpha", "github.com/acme/beta");
    const p2 = await get(c.key, `/v1/tasks?summary=1&limit=10&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.tasks.map((t: { id: string }) => t.id)).toEqual([ids[2], ids[4]]);
  });
});

// --- Cursors ---------------------------------------------------------------------------------------------------------
describe("the cursor is authenticated and bound", () => {
  async function aCursor(key: string, query = "summary=1&column=open") {
    const r = await get(key, `/v1/tasks?${query}&limit=1`);
    expect(r.body.nextCursor).toBeTruthy();
    return r.body.nextCursor as string;
  }
  function seeded() {
    const w = workspace();
    for (let i = 0; i < 4; i++) put(w.orgId, w.a, { title: `login ${i}`, created_at: `2026-09-01 10:00:0${i}`, project_key: "github.com/acme/alpha" });
    db.prepare(`INSERT OR IGNORE INTO projects (org_id, project_key, name, enabled) VALUES (?, ?, 'alpha', 1), (?, ?, 'beta', 1)`)
      .run(w.orgId, "github.com/acme/alpha", w.orgId, "github.com/acme/beta");
    return w;
  }

  it("is refused across filters and orderings", async () => {
    const { a } = seeded();
    const cursor = encodeURIComponent(await aCursor(a.key, "summary=1&column=open&q=login"));
    expect((await get(a.key, `/v1/tasks?summary=1&column=open&q=login&cursor=${cursor}`)).status).toBe(200); // the control
    for (const other of ["summary=1&column=open&q=logi", "summary=1&column=done&q=login", "summary=1&q=login", "summary=1&column=open&q=login&mine=created",
      "summary=1&column=open&q=login&project=github.com/acme/alpha", "summary=1&column=open&q=login&status=open"]) {
      const r = await get(a.key, `/v1/tasks?${other}&cursor=${cursor}`);
      expect(r.status, other).toBe(400);
    }
  });

  it("is refused for another viewer and another workspace", async () => {
    const one = seeded();
    const two = seeded();
    const cursor = encodeURIComponent(await aCursor(one.a.key));
    expect((await get(one.a.key, `/v1/tasks?summary=1&column=open&cursor=${cursor}`)).status).toBe(200);
    expect((await get(one.b.key, `/v1/tasks?summary=1&column=open&cursor=${cursor}`)).status).toBe(400);
    expect((await get(two.a.key, `/v1/tasks?summary=1&column=open&cursor=${cursor}`)).status).toBe(400);
  });

  it("is refused when tampered with, and a signed but out-of-bounds position is refused too", async () => {
    const { orgId, a } = seeded();
    const cursor = await aCursor(a.key);
    const [v, payload, mac] = cursor.split(".");
    const flip = (s: string, at: number) => s.slice(0, at) + (s[at] === "A" ? "B" : "A") + s.slice(at + 1);
    const forged = Buffer.from(JSON.stringify({ k: "2099-01-01 00:00:00", r: 1 })).toString("base64url");
    for (const bad of [`${v}.${flip(payload, 2)}.${mac}`, `${v}.${payload}.${flip(mac, 5)}`, `c9.${payload}.${mac}`, `${v}.${forged}.${mac}`, `${v}.${payload}`, ""]) {
      const r = await get(a.key, `/v1/tasks?summary=1&column=open&cursor=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBe(400);
    }
    // Signed with the hub's own key and the request's own binding, so only the bounds check can refuse these.
    const parsed = parseTaskListQuery({ summary: "1", column: "open" });
    if (parsed.legacy) throw new Error("expected a paged query");
    const binding = taskCursorBinding(orgId, a.id, parsed.query);
    const good = signTaskCursor(binding, { k: "2026-09-01 10:00:00", r: 1 });
    expect((await get(a.key, `/v1/tasks?summary=1&column=open&cursor=${encodeURIComponent(good)}`)).status).toBe(200); // the control
    for (const pos of [{ k: "x".repeat(200), r: 1 }, { k: "2026-09-01 10:00:00", r: -4 }, { k: "2026-09-01 10:00:00", r: 1.5 }, { k: 7, r: 1 }, { k: "2026-09-01 10:00:00" }]) {
      const signed = signTaskCursor(binding, pos as never);
      const r = await get(a.key, `/v1/tasks?summary=1&column=open&cursor=${encodeURIComponent(signed)}`);
      expect(r.status, JSON.stringify(pos)).toBe(400);
    }
  });

  it("the key: OPENCADRE_CURSOR_SECRET when 32+ characters, else a random per-process key and a startup warning", () => {
    const set = cursorSecretFrom({ OPENCADRE_CURSOR_SECRET: "k".repeat(32) });
    expect(set).toEqual({ key: Buffer.from("k".repeat(32), "utf8"), problem: null });
    const short = cursorSecretFrom({ OPENCADRE_CURSOR_SECRET: "short" });
    expect(short.key.length).toBe(32);
    expect(short.key.equals(Buffer.from("short"))).toBe(false);
    expect(short.problem).toMatch(/OPENCADRE_CURSOR_SECRET/);
    const unset = cursorSecretFrom({});
    expect(unset.problem).toBeNull();
    expect(unset.key.equals(cursorSecretFrom({}).key)).toBe(false); // random each time it is drawn
  });
});

// --- Search ------------------------------------------------------------------------------------------------------------
describe("q", () => {
  it("matches title or description, case-insensitively, with % and _ taken literally", async () => {
    const { orgId, a } = workspace();
    put(orgId, a, { title: "100% done" });
    put(orgId, a, { title: "1000 done" });
    put(orgId, a, { title: "snake_case" });
    put(orgId, a, { title: "snakeXcase" });
    put(orgId, a, { title: "other", description: "Mentions LOGIN here" });
    put(orgId, a, { title: "back\\slash" });
    const titles = async (q: string) => (await get(a.key, `/v1/tasks?summary=1&q=${encodeURIComponent(q)}`)).body.tasks.map((t: { title: string }) => t.title);
    expect(await titles("0%")).toEqual(["100% done"]);
    expect(await titles("e_c")).toEqual(["snake_case"]);
    expect(await titles("login")).toEqual(["other"]);
    expect(await titles("k\\s")).toEqual(["back\\slash"]);
  });
});

// --- Scope and access --------------------------------------------------------------------------------------------------
describe("scope and access", () => {
  it("a linked project shares communication only: its tasks stay hidden from list, counts, projects and the detail read", async () => {
    const { orgId, a, c } = workspace();
    isolate(orgId, c, "github.com/acme/alpha", "github.com/acme/beta");
    db.prepare(`INSERT INTO project_links (org_id, project_a, project_b, created_by, created_at) VALUES (?, ?, ?, 'test', datetime('now'))`)
      .run(orgId, "github.com/acme/alpha", "github.com/acme/beta");
    invalidateScopes();
    const mineId = put(orgId, a, { title: "alpha work", project_key: "github.com/acme/alpha" });
    const linkedId = put(orgId, a, { title: "beta secret work", project_key: "github.com/acme/beta" });
    const r = await get(c.key, "/v1/tasks?summary=1");
    expect(r.body.tasks.map((t: { id: string }) => t.id)).toEqual([mineId]);
    expect(r.body.counts.open).toBe(1);
    expect(r.body.projects).toEqual(["github.com/acme/alpha"]);
    expect((await get(c.key, "/v1/tasks?summary=1&project=github.com/acme/beta")).body.tasks).toEqual([]);
    expect((await get(c.key, `/v1/tasks/${linkedId}`)).status).toBe(404);
    expect((await get(c.key, "/v1/tasks")).body.tasks.map((t: { id: string }) => t.id)).toEqual([mineId]); // legacy too
    // Control: the workspace-scope viewer sees both.
    expect((await get(a.key, "/v1/tasks?summary=1")).body.tasks).toHaveLength(2);
  });

  it("a replacement in a project the viewer cannot see is reported, and its title withheld, on every path", async () => {
    const { orgId, a, c } = workspace();
    isolate(orgId, c, "github.com/acme/alpha", "github.com/acme/beta");
    const newer = put(orgId, a, { title: "Beta-only replacement", project_key: "github.com/acme/beta" });
    const old = put(orgId, a, { title: "alpha original", project_key: "github.com/acme/alpha", superseded_by: newer });
    for (const route of ["/v1/tasks", "/v1/tasks?summary=1", "/v1/tasks?summary=0&limit=10", `/v1/tasks/${old}`]) {
      const r = await get(c.key, route);
      const row = r.body.task ?? r.body.tasks.find((t: { id: string }) => t.id === old);
      expect(row, route).toMatchObject({ superseded: true, superseded_by: newer, superseded_by_title: null });
      expect(JSON.stringify(r.body), route).not.toContain("Beta-only replacement");
    }
    const seen = await get(a.key, "/v1/tasks?summary=1");
    expect(seen.body.tasks.find((t: { id: string }) => t.id === old).superseded_by_title).toBe("Beta-only replacement");
  });

  it("projects is the viewer's project metadata, not page 1's", async () => {
    const { orgId, a } = workspace();
    for (let i = 0; i < 5; i++) put(orgId, a, { title: `p${i}`, created_at: `2026-09-01 10:00:0${i}`, project_key: `github.com/acme/p${i}` });
    const r = await get(a.key, "/v1/tasks?summary=1&limit=1&q=p0");
    expect(r.body.tasks).toHaveLength(1);
    expect(r.body.projects).toEqual(["github.com/acme/p0", "github.com/acme/p1", "github.com/acme/p2", "github.com/acme/p3", "github.com/acme/p4"]);
  });
});

// --- Performance bound ---------------------------------------------------------------------------------------------------
describe("the query count is constant (no per-row statement), authorisation included", () => {
  function board(n: number) {
    const w = workspace();
    const ids: string[] = [];
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const kind = i % 5;
        const row: Row = kind === 0 ? claimed(w.b, true) : kind === 1 ? claimed(w.b, false) : kind === 2 ? done(w.b, i % 2 === 0) : {};
        ids.push(put(w.orgId, w.a, { ...row, title: `task ${i}`, description: "d".repeat(1500), created_at: `2026-09-01 ${String(10 + Math.floor(i / 3600)).padStart(2, "0")}:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`, parent_task_id: i > 10 && i % 13 === 0 ? ids[i - 3] : null }));
      }
      for (let i = 2; i < n; i += 11) db.prepare(`INSERT INTO task_reviews (org_id, task_id, reviewer_agent_id, reviewer_agent_name) VALUES (?, ?, ?, ?)`).run(w.orgId, ids[i], w.c.id, w.c.name);
      for (let i = 0; i + 1 < n; i += 17) db.prepare(`UPDATE tasks SET superseded_by = ? WHERE id = ?`).run(ids[i + 1], ids[i]);
    })();
    return w;
  }

  it("a board page costs the same statements at 100 and at 1000 tasks, and the summary stays small", async () => {
    // 100 is the smallest board here whose every column has a replacement, a parent and a review on its first page, so
    // every batch query runs at both sizes (each is skipped when a page has nothing for it to look up).
    const small = board(100);
    const large = board(1000);
    for (const column of ["open", "in_progress", "done"]) {
      const route = `/v1/tasks?summary=1&column=${column}&limit=200`;
      await get(small.a.key, route); // warm the auth path's own lazy statements
      await get(large.a.key, route);
      const s = await measured(small.a.key, route);
      const l = await measured(large.a.key, route);
      expect(l.status).toBe(200);
      expect(l.statements, `${column}: ${l.sources.join("\n")}`).toBe(s.statements);
      expect(l.statements).toBeLessThanOrEqual(20);
      expect(l.bytes).toBeLessThan(200 * 1024);
    }
  });

  it("the legacy list chunks its batch queries: a handful per 500 rows, never one per row", async () => {
    const large = board(1000);
    await get(large.a.key, "/v1/tasks");
    const l = await measured(large.a.key, "/v1/tasks");
    expect(l.body.tasks).toHaveLength(1000);
    expect(l.statements).toBeLessThanOrEqual(25);
  });
});

// --- Codex-OpenCadre-049a's review of #660 at d236df40 ------------------------------------------------------------------

describe("search matches only what current masking lets the reader see (review P1)", () => {
  it("review: paged search never matches text hidden by current read-time masking", async () => {
    const { orgId, a } = workspace();
    const hidden = "REVIEW_ONLY_PASSWORD_7351";
    const id = put(orgId, a, { title: "Historical imported configuration", description: `https://user:${hidden}@example.test` });
    const visible = await get(a.key, `/v1/tasks/${id}`);
    expect(visible.status).toBe(200);
    expect(JSON.stringify(visible.body), "the normal detail path masks the historical value").not.toContain(hidden);
    const search = await get(a.key, `/v1/tasks?summary=1&q=${hidden}`);
    expect(search.status).toBe(200);
    expect(search.body.tasks, "search results reveal which row contains a currently hidden password substring").toEqual([]);
    expect(search.body.counts.open).toBe(0);
  });

  it("a raw historical row is still found by what masking shows (the control)", async () => {
    const { orgId, a } = workspace();
    const id = put(orgId, a, { title: "Historical imported configuration", description: "https://user:SECRETVALUE99@example.test mirror" });
    const r = await get(a.key, "/v1/tasks?summary=1&q=example.test%20mirror");
    expect(r.body.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
    expect((await get(a.key, "/v1/tasks?summary=1&q=user:***@")).body.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
  });

  it("a row indexed under an older masking policy never matches, and is rebuilt under the current one", async () => {
    const { orgId, a } = workspace();
    const task = createTask(orgId, a, { title: "Deploy notes", description: "token in the url https://ci:VISIBLEBEFORE42@build.test" });
    const stored = db.prepare(`SELECT search_text, search_masking FROM tasks WHERE id = ?`).get(task.id) as { search_text: string; search_masking: string };
    expect(stored.search_masking).toBe(MASKING_VERSION);
    expect(stored.search_text).not.toContain("VISIBLEBEFORE42");
    // What an older policy (one that did not mask URL credentials) indexed.
    db.prepare(`UPDATE tasks SET search_text = ?, search_masking = 'older-policy' WHERE id = ?`)
      .run("Deploy notes\ntoken in the url https://ci:VISIBLEBEFORE42@build.test", task.id);
    const r = await get(a.key, "/v1/tasks?summary=1&q=VISIBLEBEFORE42");
    expect(r.body.tasks).toEqual([]);
    expect(r.body.counts).toEqual({ open: 0, expired: 0, in_progress: 0, needs_review: 0, done: 0 });
    expect((db.prepare(`SELECT search_masking FROM tasks WHERE id = ?`).get(task.id) as { search_masking: string }).search_masking).toBe(MASKING_VERSION);
    expect((await get(a.key, "/v1/tasks?summary=1&q=Deploy%20notes")).body.tasks).toHaveLength(1);
  });

  it("fails closed: a row not rebuilt yet matches no q, even when more stale rows exist than one rebuild batch", async () => {
    const { orgId, a } = workspace();
    const ids = Array.from({ length: 501 }, (_, i) => put(orgId, a, { title: `imported ${i}`, created_at: `2026-09-01 10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}` }));
    // Every row indexed by an older policy, raw text included; one search rebuilds at most 500 of them.
    db.prepare(`UPDATE tasks SET search_text = title || ' PROBE_7351', search_masking = 'older-policy' WHERE org_id = ?`).run(orgId);
    const r = await get(a.key, "/v1/tasks?summary=1&q=PROBE_7351");
    expect(r.body.tasks).toEqual([]);
    expect(r.body.counts.open).toBe(0);
    const stale = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND search_masking <> ?`).get(orgId, MASKING_VERSION) as { n: number }).n;
    expect(stale, "exactly one row was left for the next batch, and it did not match").toBe(1);
    expect(rebuildTaskSearchText({ orgId })).toBe(1);
    expect(ids).toHaveLength(501);
  });

  it("the masking version is derived from the masker, and new tasks are stamped with it", () => {
    expect(MASKING_VERSION).toMatch(/^[0-9a-f]{16}$/);
    const { orgId, a } = workspace();
    const task = createTask(orgId, a, { title: "stamped" });
    expect((db.prepare(`SELECT search_masking FROM tasks WHERE id = ?`).get(task.id) as { search_masking: string }).search_masking).toBe(MASKING_VERSION);
  });
});

describe("a content revision that every change bumps (review P2)", () => {
  const revisionOf = async (key: string, id: string) => {
    const r = await get(key, "/v1/tasks?summary=1&limit=500");
    return r.body.tasks.find((t: { id: string }) => t.id === id).revision as number;
  };

  it("completion, rejection, re-completion in the same second, note changes, accepts and renewals each give a new revision", async () => {
    const { orgId, a, b, c } = workspace();
    const task = createTask(orgId, a, { title: "round trips", requiredReviews: 2 });
    const seen: number[] = [await revisionOf(a.key, task.id)];
    const step = async (label: string, fn: () => unknown) => {
      const result = fn() as { ok?: boolean; error?: string };
      if (result && result.ok === false) throw new Error(`${label}: ${result.error}`);
      const next = await revisionOf(a.key, task.id);
      expect(next, label).toBeGreaterThan(seen.at(-1)!);
      seen.push(next);
    };
    await step("claim", () => claimTask(orgId, b, task.id));
    await step("renew (the lease is shown on the card)", () => renewClaim(orgId, b, task.id));
    await step("complete", () => completeTask(orgId, b, task.id, "First completion result."));
    await step("reject with a note", () => rejectTask(orgId, a, task.id, "missing tests"));
    await step("complete again", () => completeTask(orgId, b, task.id, "Corrected completion result."));
    await step("reject with another note", () => rejectTask(orgId, a, task.id, "n".repeat(900)));
    await step("complete a third time", () => completeTask(orgId, b, task.id, "Third result."));
    await step("one accept vote of two", () => acceptTask(orgId, a, task.id));
    await step("the second accept", () => acceptTask(orgId, c, task.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("a rejection and re-completion in the same datetime('now') second leave status and completed_at alike, and the revision not", async () => {
    const { orgId, a, b } = workspace();
    const task = createTask(orgId, a, { title: "same second" });
    claimTask(orgId, b, task.id);
    completeTask(orgId, b, task.id, "First completion result.");
    const before = db.prepare(`SELECT status, completed_at, revision FROM tasks WHERE id = ?`).get(task.id) as { status: string; completed_at: string; revision: number };
    db.transaction(() => {
      rejectTask(orgId, a, task.id, "redo");
      completeTask(orgId, b, task.id, "Corrected completion result.");
    })();
    db.prepare(`UPDATE tasks SET completed_at = ? WHERE id = ?`).run(before.completed_at, task.id); // pin the same second
    const after = db.prepare(`SELECT status, completed_at, revision, completion_summary FROM tasks WHERE id = ?`).get(task.id) as typeof before & { completion_summary: string };
    expect([after.status, after.completed_at]).toEqual([before.status, before.completed_at]);
    expect(after.completion_summary).toBe("Corrected completion result.");
    expect(after.revision).toBeGreaterThan(before.revision);
  });
});

describe("a persistent tie-breaker: seq (review ruling on VACUUM)", () => {
  it("is never reused after a delete, and increases for every creator", () => {
    const { orgId, a, b } = workspace();
    const seqOf = (id: string) => (db.prepare(`SELECT seq FROM tasks WHERE id = ?`).get(id) as { seq: number }).seq;
    const first = createTask(orgId, a, { title: "one" });
    const second = createTask(orgId, b, { title: "two" });
    expect(seqOf(second.id)).toBeGreaterThan(seqOf(first.id));
    const deletedSeq = seqOf(second.id);
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(second.id);
    const third = createTask(orgId, a, { title: "three" });
    expect(seqOf(third.id), "the deleted row's seq is not handed out again").toBeGreaterThan(deletedSeq);
    const direct = put(orgId, a, { title: "inserted directly" });
    expect(seqOf(direct)).toBeGreaterThan(seqOf(third.id));
  });

  it("an actual VACUUM leaves the order and a cursor issued before it intact", async () => {
    const { orgId, a } = workspace();
    const ids = Array.from({ length: 12 }, (_, i) => put(orgId, a, { title: `row ${i}`, created_at: "2026-09-01 10:00:00" }));
    // Deleted rows leave rowid gaps, which VACUUM may close by renumbering.
    const gap = workspace();
    for (let i = 0; i < 40; i++) put(gap.orgId, gap.a, { title: `gap ${i}` });
    db.prepare(`DELETE FROM tasks WHERE org_id = ?`).run(gap.orgId);
    const p1 = await get(a.key, "/v1/tasks?summary=1&column=open&limit=5");
    expect(p1.body.tasks.map((t: { id: string }) => t.id)).toEqual(ids.slice(0, 5));
    const rowids = () => (db.prepare(`SELECT id, rowid AS r, seq FROM tasks WHERE org_id = ? ORDER BY seq`).all(orgId) as Array<{ id: string; r: number; seq: number }>);
    const beforeVacuum = rowids();
    db.exec("VACUUM");
    const afterVacuum = rowids();
    expect(afterVacuum.map((r) => r.seq)).toEqual(beforeVacuum.map((r) => r.seq));
    // Whether or not this VACUUM renumbered rowids (it may), the order and the cursor do not depend on them.
    const rest: string[] = [];
    let cursor = p1.body.nextCursor;
    while (cursor) {
      const r = await get(a.key, `/v1/tasks?summary=1&column=open&limit=5&cursor=${encodeURIComponent(cursor)}`);
      expect(r.status).toBe(200);
      rest.push(...r.body.tasks.map((t: { id: string }) => t.id));
      cursor = r.body.nextCursor;
    }
    expect(rest).toEqual(ids.slice(5));
    expect(listTasks(orgId).map((t) => t.id)).toEqual(ids);
  });

  it("migration 54 keeps today's order exactly: seq is the old rowid, and new rows follow it", () => {
    const legacy = new Database(":memory:");
    runMigrations(legacy, MIGRATIONS.filter((m) => m.version < 54));
    legacy.prepare(`INSERT INTO organizations (id, name, bootstrap_key_hash) VALUES ('o', 'O', 'h')`).run();
    const insert = legacy.prepare(`INSERT INTO tasks (id, org_id, title, description, created_by_agent_id, created_by_agent_name, created_at) VALUES (?, 'o', ?, ?, 'a', 'A', ?)`);
    for (let i = 0; i < 30; i++) insert.run(`t${i}`, `task ${i}`, i === 3 ? "https://u:RAWPASS@x.test" : null, i % 3 ? "2026-09-01 10:00:00" : "2026-09-01 09:00:00");
    legacy.prepare(`DELETE FROM tasks WHERE id IN ('t4', 't29')`).run();
    const order = (sql: string) => (legacy.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);
    const before = order(`SELECT id FROM tasks ORDER BY created_at, rowid`);
    const applied = runMigrations(legacy, MIGRATIONS.filter((m) => m.version <= 54)).applied;
    expect(applied).toEqual([54]);
    expect(order(`SELECT id FROM tasks ORDER BY created_at, seq`)).toEqual(before);
    expect(legacy.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE seq IS NULL OR seq <> rowid`).get()).toEqual({ n: 0 });
    expect(legacy.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE revision <> 0 OR search_masking IS NOT NULL`).get()).toEqual({ n: 0 });
    insert.run("t-new", "new", null, "2026-09-01 08:00:00");
    const maxOld = (legacy.prepare(`SELECT MAX(seq) AS m FROM tasks WHERE id <> 't-new'`).get() as { m: number }).m;
    // The sequence starts after the highest seq the migration assigned. (A row deleted before migration 54 never had a
    // seq, so nothing is reused; its old rowid may be.)
    expect((legacy.prepare(`SELECT seq FROM tasks WHERE id = 't-new'`).get() as { seq: number }).seq).toBe(maxOld + 1);
    expect(runMigrations(legacy, MIGRATIONS.filter((m) => m.version <= 54)).applied).toEqual([]);
    legacy.close();
  });
});
