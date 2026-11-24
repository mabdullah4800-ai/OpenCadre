import { db, newId } from "./db.js";
import { emitEvent } from "./events.js";
import { MASKING_VERSION, maskAndCap, maskSecrets } from "./secrets.js";
import { agentProject, projectExists, resolveProjectKey } from "./project-stamps.js";
import { PROJECT_KEY_ERROR, projectKeyOf } from "./projects.js";
import { canSee, inProjectSet, projectSetSql, visibleOf, type ProjectSet } from "./scope.js";
import { MAX_CURSOR_CHARS, readTaskCursor, signTaskCursor, type CursorBinding } from "./task-cursor.js";
import { effectiveWipCap } from "./project-settings.js";
import { asData } from "./agent-text.js";

/** Shared task board with leased claims (issue #7). Claims are coordination
 * signals, not locks: a lease that isn't renewed expires, and the task becomes
 * claimable by anyone -- so a crashed or abandoned agent can't hold work
 * hostage. Every mutation is a single conditional UPDATE, so two agents racing
 * for the same task can't both win. */

export type TaskStatus = "open" | "claimed" | "done";
/** Where a task sits on the work board (migration 61, src/task-board.ts). DONE is status 'done', never a lane. */
export type TaskLane = "now" | "next" | "held";
export const TASK_LANES: readonly TaskLane[] = ["now", "next", "held"];
export const TASK_RANK_MAX = 100_000;
const RANK_ERROR = `rank must be a whole number from 0 to ${TASK_RANK_MAX}, or null`;
const HELD_REASON_ERROR = 'A held task needs a reason, e.g. "waiting for operator".';
const HELD_REASON_MAX = 200;

export interface TaskRecord {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  created_by_agent_id: string;
  created_by_agent_name: string;
  claimed_by_agent_id: string | null;
  claimed_by_agent_name: string | null;
  lease_expires_at: string | null;
  lease_expiry_emitted_at: string | null;
  completion_summary: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** The project the task belongs to, stamped at write time (write-once); null for a workspace-level task. */
  project_key: string | null;
  /** Second-pair-of-eyes axis, independent of status (see acceptTask/rejectTask doc below). completeTask's "done" is
   * only the claimant's own claim that the work is finished; reviewed stays 0 until a distinct agent accepts it.
   * Stored as SQLite's 0/1 INTEGER convention, same as messages.awaiting_reply. */
  reviewed: number;
  reviewed_by_agent_id: string | null;
  reviewed_by_agent_name: string | null;
  reviewed_at: string | null;
  /** Set by rejectTask; cleared on the next completeTask so a stale note doesn't survive a fresh completion. */
  review_note: string | null;
  /** JSON array of capability strings (e.g. ["shell", "git-write"]) the claimant must already have
   * declared (agents.capabilities, set_capabilities) before claim_task will let them claim this task.
   * Raw column storage; TaskView exposes the parsed form as required_capabilities_list. Empty array
   * ('[]', the default) means no requirement -- every task created before this existed, and every
   * task nobody bothers to scope, works exactly as before. */
  required_capabilities: string;
  /** Minimum tool-call round budget a claimant must have declared (agents.round_budget, via
   * set_round_budget) before claim_task lets it claim this task. NULL means no minimum -- any
   * agent, declared budget or not, can claim it, exactly as before this existed. */
  min_round_budget: number | null;
  /** How many DISTINCT agents must accept a completion before it finalizes as reviewed (Stage 2
   * retro finding: "redundant adversarial verification on load-bearing claims"). Defaults to 1 --
   * every task created before this existed, and every task nobody bothers to raise it for, behaves
   * exactly as before: one other agent's accept is enough. */
  required_reviews: number;
  /** The task this is a subtask of (Stage 2 retro finding: "hierarchical plan->execute->verify->
   * synthesize as the default task lifecycle"). NULL for a top-level task -- every task predating
   * this feature is, and stays, top-level. A parent's own completeTask is blocked while any child
   * isn't both done and reviewed (see completeTask): the hierarchy IS the enforcement, not just
   * bookkeeping. No depth limit -- a subtask can itself have subtasks. */
  parent_task_id: string | null;
  /** The task that CORRECTS this one, or NULL when this row is still the live record. Written by
   * supersedeTask on the OLD row, mirroring `memory_entries.superseded_by` (migration 22).
   *
   * A correction is its own task rather than an edit, because editing a filed row would rewrite the
   * record of what someone actually filed -- so the LINK is what makes a correction discoverable.
   * NULL here is a positive answer ("nothing supersedes this"), not a missing one: absence of a
   * supersession IS the fact, which is why this needs no "not measured" state.
   *
   * NEVER a chain: supersedeTask refuses a target that is itself superseded, so following one hop
   * always reaches the live record. */
  superseded_by: string | null;
  /** The task its creator was working on when it saved this one as a side request (save_task; migration 55). A
   * relationship only: unlike parent_task_id it never blocks the other task's completion. NULL for any other task. */
  side_request_of: string | null;
  /** The board lane (migration 61). now is set only by a claim (and a rejection back to the claimant); next by creation
   * and a release; held by set_task_lane, with held_reason. A lapsed lease stays in now: the board flags it stale
   * (lease_active false) rather than moving it, because the claimant may still renew it. */
  lane: TaskLane;
  /** NEXT's order: smaller first, null last (then oldest first). */
  rank: number | null;
  /** Why a task is held (required for held, cleared when it leaves held). Masked when stored. */
  held_reason: string | null;
}

export type TaskView = TaskRecord & {
  lease_active: boolean;
  required_capabilities_list: string[];
  /** Distinct accept votes recorded for the CURRENT completion round (task_reviews), reset on every
   * fresh completeTask/rejectTask. 0 for a task that isn't done, or hasn't been voted on yet. */
  review_count: number;
  /** Direct children only (not the whole subtree). 0/0 for a task with no subtasks. */
  subtask_count: number;
  subtasks_done: number;
  /** True when a correction replaces this row. THE LOAD-BEARING FIELD: a link nothing displays is
   * decoration, so the default listing must surface it -- this boolean is what a board view reads
   * without parsing `superseded_by` itself. Derived, never stored, so it cannot disagree with the id. */
  superseded: boolean;
  /** The superseding row's TITLE, so a reader of a corrected row is told what replaced it without a
   * second fetch. Null when the row is live, or when the superseding row is not visible to this
   * viewer -- a title the viewer may not read would leak a hidden task's subject. */
  superseded_by_title: string | null;
  /** The TITLE of the task this one was saved from (save_task), when this viewer may see that task; null otherwise, and
   * then readers show neither the title nor the id (the same rule as superseded_by_title). */
  side_request_of_title: string | null;
};

type Agent = { id: string; name: string };
type Result = { ok: true; task: TaskView } | { ok: false; error: string };

export const DEFAULT_LEASE_SECONDS = 30 * 60;
const MAX_LEASE_SECONDS = 24 * 60 * 60;

const nowIso = () => new Date().toISOString();

/** Parses a capabilities-shaped JSON column, tolerating malformed or pre-migration data: anything
 * that isn't a JSON array of strings reads as "no requirement"/"no declared capabilities" rather
 * than throwing, since a parse failure here must never block claiming or reading a task. */
function parseCapabilities(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/**
 * @param viewer Optional, and its absence is a deliberate default rather than an oversight: with no
 * viewer the supersession is REPORTED but the replacement's title is WITHHELD, because visibility
 * cannot be checked without knowing who is asking and leaking a title is the failure that matters.
 * Every caller in this file that has an actor passes it; the ones that do not are the ones that
 * already filtered by scope before calling here.
 */
function view(row: TaskRecord, viewer?: { id: string }): TaskView {
  const leaseActive = row.status === "claimed" && !!row.lease_expires_at && row.lease_expires_at > nowIso();
  const reviewCount = (db.prepare(`SELECT COUNT(*) AS c FROM task_reviews WHERE task_id = ?`).get(row.id) as { c: number }).c;
  const subtasks = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'done' AND reviewed = 1 THEN 1 ELSE 0 END), 0) AS done FROM tasks WHERE org_id = ? AND parent_task_id = ?`)
    .get(row.org_id, row.id) as { total: number; done: number };
  // The supersession pointer, resolved to a TITLE so a reader of a corrected row learns what replaced
  // it without a second fetch. `hiddenFrom` is applied because a task outside this viewer's visible
  // projects must not leak its subject through a title here: the row stays marked superseded (which
  // is a fact about THIS row and is the viewer's to know) while the replacement's title is withheld.
  const supersededByTitle =
    row.superseded_by && viewer && !hiddenFrom(row.org_id, viewer, row.superseded_by)
      ? (getTask(row.org_id, row.superseded_by)?.title ?? null)
      : null;
  const sideRequestOfTitle =
    row.side_request_of && viewer && !hiddenFrom(row.org_id, viewer, row.side_request_of)
      ? (getTask(row.org_id, row.side_request_of)?.title ?? null)
      : null;
  return {
    ...row, lease_active: leaseActive, required_capabilities_list: parseCapabilities(row.required_capabilities), review_count: reviewCount,
    subtask_count: subtasks.total, subtasks_done: subtasks.done,
    superseded: row.superseded_by !== null, superseded_by_title: supersededByTitle,
    side_request_of_title: sideRequestOfTitle,
  };
}

/** Task text (title, description, completion summary) is agent-supplied and shown to the whole workspace. It is masked
 * when written (createTask, completeTask; migration 13 for older rows) and again whenever a row is read here, so every
 * output (REST, MCP, error messages, event payloads built from a row) gets masked text. No length limit is added. */
const maskText = (text: string | null) => (text === null ? null : maskSecrets(text));

/** Columns the hub keeps for itself (migration 54): the search index, its masking version, the ordering tie-breaker and the
 * content revision. Never part of a TaskRecord: the full row every caller reads keeps exactly its shape from before
 * (GET /v1/tasks with no paging parameter, GET /v1/tasks/:id, MCP). The paged list adds `revision` itself. */
type StoredTask = TaskRecord & { search_text?: string | null; search_masking?: string | null; seq?: number | null; revision?: number };

function readRow(stored: TaskRecord): TaskRecord {
  const { search_text: _text, search_masking: _masking, seq: _seq, revision: _revision, ...row } = stored as StoredTask;
  return {
    ...row,
    title: maskSecrets(row.title),
    description: maskText(row.description),
    completion_summary: maskText(row.completion_summary),
    review_note: maskText(row.review_note),
    held_reason: maskText(row.held_reason),
  };
}

function getTask(orgId: string, taskId: string): TaskRecord | undefined {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ? AND org_id = ?`).get(taskId, orgId) as TaskRecord | undefined;
  return row && readRow(row);
}

function leaseExpiry(leaseSeconds: number): string | null {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > MAX_LEASE_SECONDS) return null;
  return new Date(Date.now() + leaseSeconds * 1000).toISOString();
}

const notFound = (taskId: string): Result => ({ ok: false, error: `No task found matching "${taskId}"` });

/** Project isolation (PROJECT_ISOLATION.md §5): a task outside the agent's visible projects doesn't exist for it. */
function hiddenFrom(orgId: string, agent: { id: string }, taskId: string): boolean {
  const row = db.prepare(`SELECT project_key FROM tasks WHERE id = ? AND org_id = ?`).get(taskId, orgId) as { project_key: string | null } | undefined;
  return Boolean(row) && !canSee({ orgId, agentId: agent.id }, row!.project_key);
}

function failure(orgId: string, taskId: string, fallback: string): Result {
  const task = getTask(orgId, taskId);
  if (!task) return notFound(taskId);
  if (task.status === "done") return { ok: false, error: `Task "${task.title}" is already done` };
  const t = view(task);
  if (t.lease_active) return { ok: false, error: `Task "${task.title}" is claimed by ${task.claimed_by_agent_name} until ${task.lease_expires_at}` };
  return { ok: false, error: fallback };
}

/** A task input that names a project this workspace doesn't have, or isn't a project key at all. */
export class TaskInputError extends Error {}
/** A change only a held task's creator or an admin may make (verification of #782, M-1): a 403, not a 400. */
export class TaskHeldError extends TaskInputError {}

/** The project a new task belongs to (PROJECT_ISOLATION.md §4): a project-scope creator's home, always. A workspace-wide
 * (or multi-project) creator names it with `project`; without one the task is workspace-level (null). */
function taskStamp(orgId: string, creator: Agent, rawProject: unknown): string | null {
  const { home, scope } = agentProject(orgId, creator.id);
  if (scope === "project") return home;
  if (rawProject === undefined || rawProject === null || rawProject === "") return null;
  const key = resolveProjectKey(orgId, projectKeyOf(rawProject));
  if (!key) throw new TaskInputError(`project: ${PROJECT_KEY_ERROR}`);
  if (!projectExists(orgId, key)) throw new TaskInputError(`project ${key} isn't a project in this workspace`);
  // A multi-project agent may file a task only into a project it can see (always true while isolation is off).
  if (!canSee({ orgId, agentId: creator.id }, key)) throw new TaskInputError(`project ${key} isn't one of your projects`);
  return key;
}

export function createTask(
  orgId: string,
  creator: Agent,
  input: {
    title: string; description?: string | null; project?: string | null; requiredCapabilities?: string[];
    minRoundBudget?: number | null; requiredReviews?: number | null; parentTaskId?: string | null; sideRequestOf?: string | null;
    /** next (the default) or held, with heldReason. now is only ever a claim. */
    lane?: TaskLane; rank?: number | null; heldReason?: string | null;
  },
): TaskView {
  const title = maskSecrets(input.title?.trim() ?? "");
  if (!title) throw new Error("title is required");
  const lane = input.lane ?? "next";
  if (lane === "now") throw new TaskInputError("A new task can't start in NOW: create it, then claim it with claim_task.");
  if (lane !== "next" && lane !== "held") throw new TaskInputError('lane must be "next" or "held"');
  const rank = input.rank === undefined ? null : input.rank;
  if (!isValidRank(rank)) throw new TaskInputError(RANK_ERROR);
  const heldReason = lane === "held" ? cleanReason(input.heldReason) : null;
  if (lane === "held" && !heldReason) throw new TaskInputError(HELD_REASON_ERROR);
  const projectKey = taskStamp(orgId, creator, input.project);
  const requiredCapabilities = (input.requiredCapabilities ?? []).map((c) => c.trim()).filter(Boolean);
  const minRoundBudget =
    input.minRoundBudget === undefined || input.minRoundBudget === null ? null : Math.trunc(input.minRoundBudget);
  if (minRoundBudget !== null && (!Number.isFinite(minRoundBudget) || minRoundBudget <= 0)) {
    throw new TaskInputError("minRoundBudget must be a positive integer");
  }
  const requiredReviews = input.requiredReviews === undefined || input.requiredReviews === null ? 1 : Math.trunc(input.requiredReviews);
  if (!Number.isFinite(requiredReviews) || requiredReviews < 1) {
    throw new TaskInputError("requiredReviews must be a positive integer (1 or more)");
  }
  const parentTaskId = input.parentTaskId?.trim() || null;
  if (parentTaskId) {
    if (hiddenFrom(orgId, creator, parentTaskId)) throw new TaskInputError(`No task found matching parentTaskId "${parentTaskId}"`);
    const parent = getTask(orgId, parentTaskId);
    if (!parent) throw new TaskInputError(`No task found matching parentTaskId "${parentTaskId}"`);
  }
  const sideRequestOf = input.sideRequestOf?.trim() || null;
  if (sideRequestOf && (hiddenFrom(orgId, creator, sideRequestOf) || !getTask(orgId, sideRequestOf))) {
    throw new TaskInputError(`No task found matching "${sideRequestOf}"`);
  }
  const id = newId();
  const description = input.description?.trim() ? maskSecrets(input.description.trim()) : null;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (id, org_id, title, description, created_by_agent_id, created_by_agent_name, project_key, required_capabilities, min_round_budget, required_reviews, parent_task_id, side_request_of, search_text, search_masking, lane, rank, held_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, orgId, title, description, creator.id, creator.name, projectKey,
      JSON.stringify(requiredCapabilities), minRoundBudget, requiredReviews, parentTaskId, sideRequestOf, taskSearchText(title, description), MASKING_VERSION,
      lane, rank, heldReason,
    );
    emitEvent({
      orgId, type: "task.created", actor: creator, subjectType: "task", subjectId: id,
      payload: {
        title, ...(requiredCapabilities.length ? { requiredCapabilities } : {}), ...(minRoundBudget ? { minRoundBudget } : {}),
        ...(requiredReviews > 1 ? { requiredReviews } : {}), ...(parentTaskId ? { parentTaskId } : {}),
        ...(sideRequestOf ? { sideRequestOf } : {}),
      },
    });
  })();
  return view(getTask(orgId, id)!);
}

/**
 * Files a correction as its OWN task and links it to the row it corrects — never by editing that row.
 *
 * MEASURED, and this is why the function exists: ~26 of the ~80 open board rows are CORRECTION /
 * DELTA / CLOSURE records filed against other rows, each naming the same cause in its own body
 * ("there is no `update_task` in src/tasks.ts"). The absence is verified — ten exports, no amend
 * path — and THE ABSENCE IS CORRECT: editing a filed task rewrites a record of what someone actually
 * filed, which this fleet ruled against four times in one night. The defect was never that
 * corrections ride as their own record; it is that nothing LINKED them, so a reader reconciling a
 * chain by scanning titles could silently miss one.
 *
 * MIRRORS `supersedeMemory` (src/memory.ts) AND MIGRATION 22'S COLUMN, deliberately rather than
 * inventing a shape:
 *   - the replacement is created AND the old row marked, in ONE transaction, so a superseded row is
 *     never left pointing at a replacement that does not exist;
 *   - it REFUSES when the target is unknown or already superseded — "re-superseding a superseded note
 *     would silently rewrite history". The refusal is LOUD rather than a silent chain, because a
 *     chain of supersessions is exactly what makes the history unreadable.
 *
 * THE DIRECTION OF THE LINK IS THE POINT. `superseded_by` is written on the OLD row so it is
 * discoverable from the row a reader already has open; a `supersedes` pointer on the NEW row would
 * only help a reader who had already found the new row, i.e. only a reader who did not need it.
 *
 * THE CORRECTED ROW KEEPS ITS STATUS on purpose. A superseded task may be open, claimed, or done,
 * and a correction does not resolve it — an open row whose subject was mis-stated is still open work,
 * just described differently. Changing the status here would make this `update_task` by the back door
 * and destroy the distinction the whole design rests on.
 */
export function supersedeTask(
  orgId: string,
  actor: Agent,
  supersededId: string,
  input: { title: string; description?: string | null; project?: string | null; requiredCapabilities?: string[]; minRoundBudget?: number | null; requiredReviews?: number | null },
  /** `admin`: the caller's role allows tasks.manage (src/permissions.ts), which lets it supersede a held task. */
  opts: { admin?: boolean } = {},
): TaskView {
  const current = hiddenFrom(orgId, actor, supersededId) ? undefined : getTask(orgId, supersededId);
  if (!current) throw new TaskInputError(`No task found matching "${supersededId}"`);
  // A hold can't be bypassed by correcting the task (verification of #782, M-1): the correction inherits the hold, but
  // its creator would be the superseder, who could then claim it. So only the held task's creator or an admin may
  // supersede it, the same people who may claim it. Refused before the correction is filed, so nothing is left behind.
  if (current.lane === "held" && current.status !== "done" && !opts.admin && current.created_by_agent_id !== actor.id) {
    throw new TaskHeldError(`This task is held: ${asData(current.held_reason ?? "no reason given", 80)}. Only its creator or an admin can supersede it.`);
  }
  // THE MANDATORY REFUSAL, and it is not a silent chain. Reaching a row that is itself a correction
  // would make the reader follow two hops to the live record, and each further correction adds one.
  // Loud here, so the caller supersedes the row that is actually current.
  if (current.superseded_by) {
    throw new TaskInputError(
      `Task "${supersededId}" is already superseded by "${current.superseded_by}" — supersede that row instead, so the chain stays one hop deep`,
    );
  }
  const created = createTask(orgId, actor, {
    title: input.title, description: input.description, project: input.project,
    requiredCapabilities: input.requiredCapabilities, minRoundBudget: input.minRoundBudget, requiredReviews: input.requiredReviews,
    // The correction takes the predecessor's place on the board: a hold (with its reason) stays a hold, and the rank
    // carries over. A claimed predecessor's correction is unclaimed work, so it starts in NEXT.
    lane: current.lane === "held" ? "held" : "next", heldReason: current.lane === "held" ? current.held_reason : null, rank: current.rank,
  });
  db.transaction(() => {
    // Read `.changes`: the guard `AND superseded_by IS NULL` can decline to write if another writer
    // supersedes this row between the pre-check above and this statement (the correction was already
    // created OUTSIDE this transaction, which is what opens that window). THE EVENT MUST NOT FIRE
    // UNCONDITIONALLY: `task.superseded` is the audit trail asserting a correction happened, and this
    // PR exists to make corrections traceable — an event that can claim a supersession that did not
    // happen puts that defect inside the mechanism itself. Same pattern as sweepExpiredLeases below:
    // guarded UPDATE, read .changes, and bail BEFORE the emit.
    //
    // THROW rather than return: the correction row was already created at the call above, so a silent
    // return would orphan it with no pointer to what it corrects — the untraceable-correction defect.
    // Throwing tells the caller the supersession did not take, and the orphan row is visible plain.
    const marked = db.prepare(`UPDATE tasks SET superseded_by = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ? AND superseded_by IS NULL`)
      .run(created.id, supersededId, orgId).changes;
    if (marked === 0) {
      throw new TaskInputError(
        `Task "${supersededId}" was just superseded by another writer — the correction ${created.id} exists with no superseding link. Supersede the CURRENT row instead.`,
      );
    }
    emitEvent({
      orgId, type: "task.superseded", actor, subjectType: "task", subjectId: supersededId,
      payload: { title: current.title, supersededBy: created.id },
    });
  })();
  return view(getTask(orgId, created.id)!);
}

/** The most lease-expiry notices one sweep emits for one workspace. A backlog drains over later sweeps. */
export const LEASE_SWEEP_BATCH = 200;

/** Emits task.lease_expired once per lapsed claim, directed at the claimant.
 * Leases lapse silently in storage, so this runs lazily before reads and claims, and on the server's 60 s timer
 * (sweepAllExpiredLeases). It only NOTIFIES: it never releases a task or changes its status, claimant or lease. */
export function sweepExpiredLeases(orgId: string): void {
  const lapsed = (db.prepare(
    `SELECT * FROM tasks WHERE org_id = ? AND status = 'claimed' AND lease_expires_at <= ? AND lease_expiry_emitted_at IS NULL
      ORDER BY lease_expires_at, rowid LIMIT ?`,
  ).all(orgId, nowIso(), LEASE_SWEEP_BATCH) as TaskRecord[]).map(readRow);
  for (const task of lapsed) noteLapsedLease(orgId, task);
}

/** Records and announces one lapsed lease, as the sweep saw it. The write is conditional on the row still being
 * that exact claim -- still claimed, by the same agent, with the same expired lease, not yet announced -- so a
 * renewal, takeover or completion that lands between the sweep's read and this write makes it a no-op instead of
 * a notice about a lease that no longer exists. Returns whether it emitted. Exported for the race tests. */
export function noteLapsedLease(orgId: string, task: TaskRecord): boolean {
  return db.transaction(() => {
    const marked = db.prepare(
      `UPDATE tasks SET lease_expiry_emitted_at = datetime('now')
        WHERE id = ? AND org_id = ? AND status = 'claimed' AND claimed_by_agent_id = ? AND lease_expires_at = ?
          AND lease_expiry_emitted_at IS NULL`,
    ).run(task.id, orgId, task.claimed_by_agent_id, task.lease_expires_at).changes;
    if (marked === 0) return false;
    emitEvent({
      orgId, type: "task.lease_expired", subjectType: "task", subjectId: task.id, targetAgentId: task.claimed_by_agent_id,
      payload: { title: task.title, claimant: task.claimed_by_agent_name, leaseExpiresAt: task.lease_expires_at },
    });
    return true;
  })();
}

/** The server timer's sweep: every workspace with a lapsed, unannounced claim, so a notice goes out on time
 * rather than on the workspace's next read. Each workspace is bounded by LEASE_SWEEP_BATCH. */
export function sweepAllExpiredLeases(): void {
  const orgIds = db.prepare(
    `SELECT DISTINCT org_id FROM tasks WHERE status = 'claimed' AND lease_expires_at <= ? AND lease_expiry_emitted_at IS NULL`,
  ).pluck().all(nowIso()) as string[];
  for (const orgId of orgIds) sweepExpiredLeases(orgId);
}

// --- Listing (tasks tranche 2: docs/superpowers/plans/2026-09-30-task-paging.md, §0 is the binding ruling) -------------

/** The most ids one IN list carries. SQLite allows 32,766 variables; a bounded page (500 at most) fits in one chunk, and
 * the legacy unbounded list costs one statement per chunk per batch query instead of three statements per row. */
const IN_CHUNK = 500;
const chunked = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
};
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The per-row fields view() derives, computed for a whole page at once: one statement per batch query (per IN chunk),
 * whatever the page's size. Identical to view() row for row (tests/task-paging.test.ts pins it), with three deliberate
 * differences in how, never in what:
 * - ONE comparison time (`now`) for every row, the one the caller also used for its counts and column predicates;
 * - the visible project set is resolved once and applied to every replacement row, instead of one hiddenFrom per row;
 * - every batch query carries the org predicate (view()'s review count did not; task_reviews rows are always in their
 *   task's org, so the answer is the same).
 * Children are aggregated (count and done+reviewed count), never listed, so no child title is disclosed. */
function viewMany<R extends Pick<TaskRecord, "id" | "status" | "lease_expires_at" | "superseded_by" | "required_capabilities"> & { side_request_of?: string | null }>(
  orgId: string, rows: R[], viewer: { id: string } | undefined, now: string, visible?: ProjectSet,
): Array<R & Omit<TaskView, keyof TaskRecord>> {
  const reviews = new Map<string, number>();
  const subtasks = new Map<string, { total: number; done: number }>();
  const titles = new Map<string, string>();
  for (const ids of chunked(rows.map((r) => r.id))) {
    for (const r of db.prepare(`SELECT task_id, COUNT(*) AS c FROM task_reviews WHERE org_id = ? AND task_id IN (${marks(ids.length)}) GROUP BY task_id`)
      .all(orgId, ...ids) as Array<{ task_id: string; c: number }>) reviews.set(r.task_id, r.c);
    for (const r of db.prepare(
      `SELECT parent_task_id, COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'done' AND reviewed = 1 THEN 1 ELSE 0 END), 0) AS done
         FROM tasks WHERE org_id = ? AND parent_task_id IN (${marks(ids.length)}) GROUP BY parent_task_id`,
    ).all(orgId, ...ids) as Array<{ parent_task_id: string; total: number; done: number }>) subtasks.set(r.parent_task_id, { total: r.total, done: r.done });
  }
  // A replacement's title only for a viewer whose visible projects include the replacement's project; without a viewer
  // the title is withheld, exactly as view() does. A replacement that doesn't resolve in this org reads as withheld too.
  if (viewer) {
    const set = visible ?? visibleOf({ orgId, agentId: viewer.id });
    // Both link kinds resolve a title under the same visibility rule: a replacement, and a side request's origin.
    const wanted = [...new Set(rows.flatMap((r) => [r.superseded_by, r.side_request_of ?? null]).filter((id): id is string => Boolean(id)))];
    for (const ids of chunked(wanted)) {
      for (const r of db.prepare(`SELECT id, title, project_key FROM tasks WHERE org_id = ? AND id IN (${marks(ids.length)})`)
        .all(orgId, ...ids) as Array<{ id: string; title: string; project_key: string | null }>) {
        if (inProjectSet(set, r.project_key)) titles.set(r.id, maskSecrets(r.title));
      }
    }
  }
  return rows.map((row) => {
    const sub = subtasks.get(row.id) ?? { total: 0, done: 0 };
    return {
      ...row,
      lease_active: row.status === "claimed" && !!row.lease_expires_at && row.lease_expires_at > now,
      required_capabilities_list: parseCapabilities(row.required_capabilities),
      review_count: reviews.get(row.id) ?? 0,
      subtask_count: sub.total, subtasks_done: sub.done,
      superseded: row.superseded_by !== null,
      superseded_by_title: row.superseded_by ? (titles.get(row.superseded_by) ?? null) : null,
      side_request_of_title: row.side_request_of ? (titles.get(row.side_request_of) ?? null) : null,
    };
  });
}

/** viewer: the reading agent, whose visible projects filter the board (src/scope.ts). Without one, every task is listed.
 * The legacy, unbounded full list: GET /v1/tasks with no paging parameter. Its rows and shape are unchanged; its cost is
 * now a constant number of statements per 500 rows instead of three per row. */
export function listTasks(orgId: string, filter: { status?: TaskStatus; viewer?: string } = {}): TaskView[] {
  sweepExpiredLeases(orgId);
  const set = filter.viewer ? visibleOf({ orgId, agentId: filter.viewer }) : undefined;
  const scope = set ? projectSetSql(set, "project_key") : { sql: "1 = 1", params: [] };
  const rows = filter.status
    ? (db.prepare(`SELECT * FROM tasks WHERE org_id = ? AND status = ? AND ${scope.sql} ORDER BY created_at, seq`).all(orgId, filter.status, ...scope.params) as TaskRecord[])
    : (db.prepare(`SELECT * FROM tasks WHERE org_id = ? AND ${scope.sql} ORDER BY created_at, seq`).all(orgId, ...scope.params) as TaskRecord[]);
  return viewMany(orgId, rows.map(readRow), filter.viewer ? { id: filter.viewer } : undefined, nowIso(), set);
}

/** MCP list_tasks' selection (§0 item 7): the newest `limit` rows by (created_at, seq), chosen in SQL with DESC LIMIT
 * and returned oldest first, plus how many there are. The same rows, order and total as listing everything and keeping
 * the tail, which is what list_tasks did before. */
export function listNewestTasks(orgId: string, viewer: string, { status, limit }: { status?: TaskStatus; limit: number }): { tasks: TaskView[]; total: number } {
  sweepExpiredLeases(orgId);
  const set = visibleOf({ orgId, agentId: viewer });
  const scope = projectSetSql(set, "project_key");
  const where = `org_id = ?${status ? " AND status = ?" : ""} AND ${scope.sql}`;
  const params = [orgId, ...(status ? [status] : []), ...scope.params];
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE ${where}`).get(...params) as { c: number }).c;
  const rows = (db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY created_at DESC, seq DESC LIMIT ?`).all(...params, limit) as TaskRecord[]).reverse();
  return { tasks: viewMany(orgId, rows.map(readRow), { id: viewer }, nowIso(), set), total };
}

// --- Search index (migration 54) -------------------------------------------------------------------------------------

/** What q searches for one task: its title and description as current masking shows them. Built from the stored text
 * through maskSecrets, never from anything a reader can't see. */
export function taskSearchText(title: string, description: string | null): string {
  return `${maskSecrets(title ?? "")}\n${description ? maskSecrets(description) : ""}`;
}

/** Rows rebuilt per call: one bounded transaction. */
export const SEARCH_REBUILD_BATCH = 500;

/** Rebuilds search_text for rows indexed under another masking version, or never indexed (NULL): at most `limit` of them,
 * one workspace's or any. Returns how many it rebuilt. The hub drains every stale row in batches at startup
 * (src/index.ts); a search also rebuilds a batch of its own workspace's first. Until a row is rebuilt it matches no q. */
export function rebuildTaskSearchText({ orgId, limit = SEARCH_REBUILD_BATCH }: { orgId?: string; limit?: number } = {}): number {
  const stale = db.prepare(
    `SELECT id, title, description FROM tasks WHERE ${orgId ? "org_id = ? AND " : ""}(search_masking IS NULL OR search_masking <> ?) LIMIT ?`,
  ).all(...(orgId ? [orgId] : []), MASKING_VERSION, limit) as Array<{ id: string; title: string; description: string | null }>;
  if (!stale.length) return 0;
  const write = db.prepare(`UPDATE tasks SET search_text = ?, search_masking = ? WHERE id = ?`);
  db.transaction(() => { for (const row of stale) write.run(taskSearchText(row.title, row.description), MASKING_VERSION, row.id); })();
  return stale.length;
}

// --- Paged listing: GET /v1/tasks with summary, limit, cursor, column, mine, q or project --------------------------------

export type TaskColumn = "open" | "in_progress" | "done";
export type TaskMine = "created" | "claimed" | "review";
const TASK_STATUSES: TaskStatus[] = ["open", "claimed", "done"];
const TASK_COLUMNS: TaskColumn[] = ["open", "in_progress", "done"];
const TASK_MINE: TaskMine[] = ["created", "claimed", "review"];
/** The parameters that opt a caller into the paged response. With none of them, GET /v1/tasks is the legacy full list. */
const PAGED_PARAMS = ["summary", "limit", "cursor", "column", "mine", "q", "project"] as const;
export const TASK_PAGE_DEFAULT = 200;
export const TASK_PAGE_MAX = 500;
const Q_MAX_CHARS = 200;
/** The longest review note a summary row carries. A longer one is withheld whole (never clipped: masking a clipped string
 * could let the part of a secret before the cut through) and read from GET /v1/tasks/:id. */
const SUMMARY_REVIEW_NOTE_MAX = 500;

export interface TaskPageQuery {
  summary: boolean;
  limit: number;
  cursor?: string;
  column?: TaskColumn;
  mine?: TaskMine;
  status?: TaskStatus;
  q?: string;
  /** As the caller spelled it, validated as a project key; resolved through project_aliases per workspace. */
  project?: string;
}
export interface TaskCounts { open: number; expired: number; in_progress: number; needs_review: number; done: number }
export type TaskSummaryView = Omit<TaskView, "description" | "completion_summary" | "lane" | "rank" | "held_reason"> & {
  has_description: boolean; has_completion_summary: boolean; has_review_note: boolean;
};
export interface TaskPage {
  tasks: Array<TaskView | TaskSummaryView>;
  /** Null on the last page. */
  nextCursor: string | null;
  /** Over the viewer's scope and this request's q, project and mine, before column, status, cursor and limit. */
  counts: TaskCounts;
  /** Every project key among the tasks this viewer may see (q, project and mine not applied): the filter's options. */
  projects: string[];
}

/** A bad paging parameter: a 400 naming it. */
export class TaskQueryError extends Error {}

/** Reads GET /v1/tasks' query. Legacy (no paging parameter): only `status`, as leniently as ever (an unknown value lists
 * everything, unchanged). Paged: every parameter is validated and a bad one is a TaskQueryError, never reinterpreted. */
export function parseTaskListQuery(raw: Record<string, unknown>): { legacy: true; status?: TaskStatus } | { legacy: false; query: TaskPageQuery } {
  if (!PAGED_PARAMS.some((name) => raw[name] !== undefined)) {
    return { legacy: true, status: TASK_STATUSES.find((s) => s === raw.status) };
  }
  const one = (name: string): string | undefined => {
    const value = raw[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new TaskQueryError(`${name} must be given once, as text`);
    return value;
  };
  const oneOf = <T extends string>(name: string, allowed: readonly T[]): T | undefined => {
    const value = one(name);
    if (value === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(value)) throw new TaskQueryError(`${name} must be one of ${allowed.join(", ")}`);
    return value as T;
  };
  const summaryRaw = one("summary");
  let summary = false;
  if (summaryRaw !== undefined) {
    if (summaryRaw === "1" || summaryRaw === "true") summary = true;
    else if (summaryRaw !== "0" && summaryRaw !== "false") throw new TaskQueryError("summary must be 1, 0, true or false");
  }
  const limitRaw = one("limit");
  let limit = TASK_PAGE_DEFAULT;
  if (limitRaw !== undefined) {
    if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) > TASK_PAGE_MAX) throw new TaskQueryError(`limit must be a whole number from 0 to ${TASK_PAGE_MAX}`);
    limit = Number(limitRaw);
  }
  const cursor = one("cursor");
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > MAX_CURSOR_CHARS)) {
    throw new TaskQueryError("That cursor isn't valid for this list. Start again from the first page.");
  }
  const qRaw = one("q");
  if (qRaw !== undefined && qRaw.length > Q_MAX_CHARS) throw new TaskQueryError(`q must be at most ${Q_MAX_CHARS} characters`);
  const q = qRaw?.trim() || undefined; // an empty search is no search
  const projectRaw = one("project");
  let project: string | undefined;
  if (projectRaw !== undefined) {
    const key = projectKeyOf(projectRaw);
    if (!key) throw new TaskQueryError(`project: ${PROJECT_KEY_ERROR}`);
    project = key;
  }
  return {
    legacy: false,
    query: {
      summary, limit, cursor, q, project,
      column: oneOf("column", TASK_COLUMNS), mine: oneOf("mine", TASK_MINE), status: oneOf("status", TASK_STATUSES),
    },
  };
}

/** The ordering a paged list uses: the board's own. Done is newest completion first; everything else is creation order,
 * as the legacy list and the Open and In progress columns always were. seq (migration 54) is the unique tie-breaker in
 * both: rowid for every row that existed before it, so the order is unchanged, and never renumbered by VACUUM or reused
 * after a delete, so a cursor stays valid across both. */
const orderOf = (query: TaskPageQuery): "created_asc" | "completed_desc" => (query.column === "done" ? "completed_desc" : "created_asc");

/** What a cursor is bound to (src/task-cursor.ts): this workspace, this viewer, this ordering and these normalised
 * filters. Limit and cursor are not part of it: a cursor is valid at any page size. */
export function taskCursorBinding(orgId: string, viewerId: string, query: TaskPageQuery): CursorBinding {
  const project = query.project ? resolveProjectKey(orgId, query.project) : null;
  return {
    orgId, viewerId, order: orderOf(query),
    filters: JSON.stringify([query.column ?? null, query.status ?? null, query.mine ?? null, query.q ?? null, project, query.summary]),
  };
}

/** The columns a summary row carries: every task column except the two unbounded texts, plus whether each exists. The
 * review note, the one other unbounded text, is carried only while it is short. Chosen in SQL, so the large text is never
 * read for a summary. */
const SUMMARY_PROJECTION = [
  "id", "org_id", "title", "status", "created_by_agent_id", "created_by_agent_name", "claimed_by_agent_id", "claimed_by_agent_name",
  "lease_expires_at", "lease_expiry_emitted_at", "created_at", "updated_at", "completed_at", "project_key", "reviewed",
  "reviewed_by_agent_id", "reviewed_by_agent_name", "reviewed_at", "required_capabilities", "min_round_budget", "required_reviews",
  "parent_task_id", "superseded_by", "side_request_of", "revision",
  `CASE WHEN length(review_note) <= ${SUMMARY_REVIEW_NOTE_MAX} THEN review_note END AS review_note`,
  "NULLIF(description, '') IS NOT NULL AS has_description",
  "NULLIF(completion_summary, '') IS NOT NULL AS has_completion_summary",
  "NULLIF(review_note, '') IS NOT NULL AS has_review_note",
].join(", ");

type SummaryRow = Omit<TaskRecord, "description" | "completion_summary"> & { has_description: number | boolean; has_completion_summary: number | boolean; has_review_note: number | boolean };

/**
 * One page of the board. Keyset paging, NOT a snapshot: each page is read at its own time, so
 * - a task created after the first page appears at the end of a creation-ordered list (Open, In progress, no column);
 * - a task deleted, or moved out of this column/filter (claimed, completed, expired, superseded into another project the
 *   viewer can't see), is simply not on later pages, and a cursor whose own row is gone still works;
 * - a task that moves INTO the column behind the cursor (in Done, a completion is newest, so it lands before the cursor)
 *   is not on later pages; the next first-page read shows it. The console re-reads its loaded pages from the start on
 *   every refresh for exactly this reason.
 * The viewer's current scope and every filter are applied before LIMIT on every page, so a cursor never widens what is read.
 */
export function listTaskPage(orgId: string, viewerId: string, query: TaskPageQuery): TaskPage {
  const binding = taskCursorBinding(orgId, viewerId, query);
  const position = query.cursor ? readTaskCursor(query.cursor, binding) : null;
  sweepExpiredLeases(orgId);
  const now = nowIso(); // ONE comparison time for this request: rows, lease_active, column predicates and counts
  const set = visibleOf({ orgId, agentId: viewerId });
  const scope = projectSetSql(set, "project_key");

  // The scope every number and row shares: workspace, viewer's projects, q, project, mine.
  const shared: string[] = ["org_id = ?", scope.sql];
  const sharedParams: unknown[] = [orgId, ...scope.params];
  if (query.q) {
    const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // Search reads only search_text, the title and description as CURRENT masking shows them, and only rows indexed
    // under the current masking version: a row not rebuilt yet matches no q (fail closed), so no search or count can
    // probe text that masking hides on output. A bounded batch of this workspace's stale rows is rebuilt first.
    rebuildTaskSearchText({ orgId });
    shared.push("search_masking = ? AND search_text LIKE ? ESCAPE '\\'");
    sharedParams.push(MASKING_VERSION, pattern);
  }
  if (query.project) {
    shared.push("project_key = ?");
    sharedParams.push(resolveProjectKey(orgId, query.project));
  }
  if (query.mine === "created") {
    shared.push("created_by_agent_id = ?");
    sharedParams.push(viewerId);
  } else if (query.mine === "claimed") {
    // Held now: status claimed by this viewer, lease active or lapsed (the claimant can still complete or release it).
    shared.push("status = 'claimed' AND claimed_by_agent_id = ?");
    sharedParams.push(viewerId);
  } else if (query.mine === "review") {
    // Waiting for a review this viewer may give: done, unreviewed, and not completed by this viewer (never self-review).
    shared.push("status = 'done' AND COALESCE(reviewed, 0) = 0 AND (claimed_by_agent_id IS NULL OR claimed_by_agent_id <> ?)");
    sharedParams.push(viewerId);
  }

  const counts = db.prepare(
    `SELECT COALESCE(SUM(status = 'open'), 0) AS open,
            COALESCE(SUM(status = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)), 0) AS expired,
            COALESCE(SUM(status = 'claimed' AND lease_expires_at > ?), 0) AS in_progress,
            COALESCE(SUM(status = 'done' AND COALESCE(reviewed, 0) = 0), 0) AS needs_review,
            COALESCE(SUM(status = 'done' AND COALESCE(reviewed, 0) <> 0), 0) AS done
       FROM tasks WHERE ${shared.join(" AND ")}`,
  ).get(now, now, ...sharedParams) as TaskCounts;

  const projects = (db.prepare(
    `SELECT DISTINCT project_key FROM tasks WHERE org_id = ? AND ${scope.sql} AND project_key IS NOT NULL ORDER BY project_key`,
  ).pluck().all(orgId, ...scope.params) as string[]);

  if (query.limit === 0) return { tasks: [], nextCursor: null, counts, projects };

  const where = [...shared];
  const params = [...sharedParams];
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  // The board's columns, over the five buckets: Open = open + expired, In progress = in_progress, Done = needs_review + done.
  if (query.column === "open") {
    where.push("(status = 'open' OR (status = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))");
    params.push(now);
  } else if (query.column === "in_progress") {
    where.push("status = 'claimed' AND lease_expires_at > ?");
    params.push(now);
  } else if (query.column === "done") {
    where.push("status = 'done'");
  }
  const order = orderOf(query);
  const sortKey = order === "completed_desc" ? "COALESCE(completed_at, '')" : "created_at";
  if (position) {
    where.push(order === "completed_desc"
      ? `(${sortKey} < ? OR (${sortKey} = ? AND seq < ?))`
      : `(${sortKey} > ? OR (${sortKey} = ? AND seq > ?))`);
    params.push(position.k, position.k, position.r);
  }
  const direction = order === "completed_desc" ? "DESC" : "ASC";
  const projection = query.summary ? SUMMARY_PROJECTION : "*";
  const rows = db.prepare(
    `SELECT ${projection}, ${sortKey} AS page_key, seq AS page_seq FROM tasks WHERE ${where.join(" AND ")}
      ORDER BY ${sortKey} ${direction}, seq ${direction} LIMIT ?`,
  ).all(...params, query.limit + 1) as Array<(TaskRecord | SummaryRow) & { page_key: string; page_seq: number }>;

  const more = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = more && last ? signTaskCursor(binding, { k: last.page_key, r: last.page_seq }) : null;
  const read = page.map(({ page_key: _k, page_seq: _s, ...row }) => {
    // A paged row carries its content revision (migration 54), which the console keys its cached details on.
    if (!query.summary) return { ...readRow(row as TaskRecord), revision: (row as StoredTask).revision ?? 0 };
    const s = row as SummaryRow;
    return {
      ...s, title: maskSecrets(s.title), review_note: maskText(s.review_note),
      has_description: Boolean(s.has_description), has_completion_summary: Boolean(s.has_completion_summary), has_review_note: Boolean(s.has_review_note),
    };
  });
  return { tasks: viewMany(orgId, read, { id: viewerId }, now, set) as Array<TaskView | TaskSummaryView>, nextCursor, counts, projects };
}

/** One task's full record, for an agent who wants to read it without claiming it -- list_tasks
 * clips descriptions for the board view (25+ tasks at once would otherwise be unreadable), so an
 * agent investigating a specific task it doesn't hold had no way to read that task's full
 * description short of claiming it just to see it. Same project-visibility rule as everything
 * else here: a task outside the viewer's visible projects doesn't exist for it. */
export function getTaskById(orgId: string, viewer: { id: string }, taskId: string): TaskView | undefined {
  if (hiddenFrom(orgId, viewer, taskId)) return undefined;
  sweepExpiredLeases(orgId);
  const row = getTask(orgId, taskId);
  return row ? view(row, viewer) : undefined;
}

/** Claims an open task, re-claims one whose lease has expired, or refreshes
 * the caller's own claim. Fails while another agent's lease is active. */
/** Design retro finding: a task assigned to an agent whose client structurally can't do the work
 * (no shell, no git) surfaces the gap only mid-task, after real effort. required_capabilities lets
 * create_task name what a claimant needs; this checks the claimant's own agents.capabilities
 * (set via set_capabilities) against it. Missing declared capabilities (an agent that has never
 * called set_capabilities) means the check can't pass a scoped task -- fail closed, not open, since
 * an unscoped agent claiming a scoped task is exactly the failure mode this exists to catch. */
export function missingCapabilities(orgId: string, agentId: string, required: string[]): string[] {
  if (required.length === 0) return [];
  const row = db.prepare(`SELECT capabilities FROM agents WHERE id = ? AND org_id = ?`).get(agentId, orgId) as { capabilities: string } | undefined;
  const have = new Set(parseCapabilities(row?.capabilities));
  return required.filter((c) => !have.has(c));
}

/** Cost-aware routing (Stage 1 retro finding): a task's min_round_budget names the tool-call round
 * budget it genuinely needs; agents.round_budget (set_round_budget) is what an agent's own bridge
 * declares as its configured cap. An agent that never declared a budget is unknown, not unlimited --
 * fail closed, the same call task_capabilities makes for undeclared capabilities, since a bridge
 * silently truncating mid-task is exactly the failure this exists to catch before it happens. Returns
 * null when the claim is fine, or a message naming the shortfall. */
export function budgetShortfall(orgId: string, agentId: string, minRoundBudget: number | null): string | null {
  if (minRoundBudget === null) return null;
  const row = db.prepare(`SELECT round_budget FROM agents WHERE id = ? AND org_id = ?`).get(agentId, orgId) as { round_budget: number | null } | undefined;
  const have = row?.round_budget ?? null;
  if (have === null) {
    return `This task needs a declared round budget of at least ${minRoundBudget}, and you haven't declared one. Call set_round_budget with your bridge's actual configured cap, or leave this task for an agent that has.`;
  }
  if (have < minRoundBudget) {
    return `This task needs a round budget of at least ${minRoundBudget}; yours is declared at ${have}. Leave this task for an agent with more headroom, or raise your budget with set_round_budget if it's actually higher now.`;
  }
  return null;
}

/** The agent's live claims: claimed by it, lease not yet lapsed. A lapsed lease is not work in progress (anyone may take
 * it over), so it never counts toward the WIP cap. Oldest task first. */
export function liveClaimsOf(orgId: string, agentId: string): Array<{ id: string; title: string }> {
  return db.prepare(
    `SELECT id, title FROM tasks WHERE org_id = ? AND status = 'claimed' AND claimed_by_agent_id = ? AND lease_expires_at > ?
      ORDER BY created_at, rowid`,
  ).all(orgId, agentId, nowIso()) as Array<{ id: string; title: string }>;
}

/** The WIP cap that applies to this agent: its home project's (src/project-settings.ts), else the workspace default.
 * Null: no cap. */
export function wipCapFor(orgId: string, agentId: string): number | null {
  return effectiveWipCap(orgId, agentProject(orgId, agentId).home);
}

const WIP_LISTED_TITLES = 10;

/** Fleet coordination plan, failure 3: a NEW claim is refused once the claimant already holds its cap of live claims,
 * naming them, so it finishes or releases one instead of hoarding. Null when the claim may go ahead. */
function wipCapRefusal(orgId: string, agentId: string): string | null {
  const cap = wipCapFor(orgId, agentId);
  if (cap === null) return null;
  const held = liveClaimsOf(orgId, agentId);
  if (held.length < cap) return null;
  const titles = held.slice(0, WIP_LISTED_TITLES).map((t) => `"${maskAndCap(t.title, 80)}"`).join(", ")
    + (held.length > WIP_LISTED_TITLES ? ` and ${held.length - WIP_LISTED_TITLES} more` : "");
  return held.length === 1
    ? `You hold 1 task (cap ${cap}): ${titles}. Finish or release it first.`
    : `You hold ${held.length} tasks (cap ${cap}): ${titles}. Finish or release one first.`;
}

/** The refusal for a claim on a held task by anyone but its creator or an admin (review of #782, M1). */
const heldClaimRefusal = (task: TaskRecord) =>
  `This task is held: ${asData(task.held_reason ?? "no reason given", 80)}. Ask its creator to move it to NEXT (set_task_lane) first.`;

/** `admin`: the caller's role allows tasks.manage (src/permissions.ts), which lets it claim a held task. */
export function claimTask(orgId: string, agent: Agent, taskId: string, leaseSeconds = DEFAULT_LEASE_SECONDS, opts: { admin?: boolean } = {}): Result {
  const expires = leaseExpiry(leaseSeconds);
  if (!expires) return { ok: false, error: `leaseSeconds must be between 0 and ${MAX_LEASE_SECONDS}` };
  if (hiddenFrom(orgId, agent, taskId)) return notFound(taskId);
  sweepExpiredLeases(orgId);
  const target = getTask(orgId, taskId);
  if (!target) return notFound(taskId);
  const required = parseCapabilities(target.required_capabilities);
  // Renewing your own existing claim never re-checks capabilities: you already had them (or the
  // requirement was added after you claimed), and refusing your own renewal mid-task would be worse
  // than the gap this feature closes.
  const isOwnRenewal = target.status === "claimed" && target.claimed_by_agent_id === agent.id;
  // A superseded row takes no NEW claim: its work moved to the correction. The current holder keeps renewing (a claim won
  // before the supersession stays valid until a coordinated handoff); everyone else, including a released former holder
  // or a would-be taker of an expired lease, is refused. The atomic predicate below enforces the same rule.
  if (target.superseded_by && target.status !== "done" && !isOwnRenewal) return supersededRefusal(orgId, agent, target);
  if (!isOwnRenewal) {
    const missing = missingCapabilities(orgId, agent.id, required);
    if (missing.length > 0) {
      return { ok: false, error: `You're missing required capabilities for this task: ${missing.join(", ")}. Declare them with set_capabilities if you actually have them, or leave this task for an agent that does.` };
    }
    const shortfall = budgetShortfall(orgId, agent.id, target.min_round_budget);
    if (shortfall) return { ok: false, error: shortfall };
  }
  let overCap: string | null = null;
  let heldRefusal: string | null = null;
  const changed = db.transaction(() => {
    const before = getTask(orgId, taskId);
    // A hold blocks claims: only the task's creator or an admin takes a held task (into NOW). The claimant renewing its
    // own held claim stays allowed, and a takeover of a lapsed held claim follows the same rule as any new claim.
    // Checked inside the claim's transaction, so a hold that lands just before the UPDATE is not claimed over.
    const ownClaim = before!.status === "claimed" && before!.claimed_by_agent_id === agent.id;
    if (before!.lane === "held" && !ownClaim && !opts.admin && before!.created_by_agent_id !== agent.id) {
      heldRefusal = heldClaimRefusal(before!);
      return 0;
    }
    // The WIP cap is counted inside the claim's own transaction, so a second writer's claim can't land between the count
    // and this UPDATE. Only a NEW claim is checked: renewing a claim you hold, or taking back your own lapsed one (still
    // status 'claimed' and yours), never is refused for the cap.
    if (!isOwnRenewal && !(before!.status === "claimed" && before!.claimed_by_agent_id === agent.id)) {
      overCap = wipCapRefusal(orgId, agent.id);
      if (overCap) return 0;
    }
    const n = db.prepare(
      `UPDATE tasks
          SET status = 'claimed', claimed_by_agent_id = ?, claimed_by_agent_name = ?, lease_expires_at = ?,
              lease_expiry_emitted_at = NULL, updated_at = datetime('now'), lane = 'now', held_reason = NULL
        WHERE id = ? AND org_id = ? AND status != 'done'
          AND (status = 'open' OR claimed_by_agent_id = ? OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          AND (superseded_by IS NULL OR (status = 'claimed' AND claimed_by_agent_id = ?))`,
    ).run(agent.id, agent.name, expires, taskId, orgId, agent.id, nowIso(), agent.id).changes;
    // Re-claiming your own claim is a renewal, not a new claim.
    if (n > 0 && !(before!.status === "claimed" && before!.claimed_by_agent_id === agent.id)) {
      emitEvent({
        orgId, type: "task.claimed", actor: agent, subjectType: "task", subjectId: taskId,
        payload: {
          title: before!.title, leaseExpiresAt: expires,
          ...(before!.claimed_by_agent_id ? { takeoverFrom: before!.claimed_by_agent_name } : {}),
        },
      });
    }
    return n;
  })();
  if (heldRefusal) return { ok: false, error: heldRefusal };
  if (overCap) return { ok: false, error: overCap };
  if (changed === 0) {
    // A supersession that landed between the check above and the UPDATE: report it, not a generic failure.
    const now = getTask(orgId, taskId);
    if (now?.superseded_by && now.status !== "done" && !(now.status === "claimed" && now.claimed_by_agent_id === agent.id)) {
      return supersededRefusal(orgId, agent, now);
    }
    return failure(orgId, taskId, `Could not claim task "${taskId}"`);
  }
  return { ok: true, task: view(getTask(orgId, taskId)!) };
}

/** The refusal for a new claim on a superseded row. It names the replacement only when the caller can see it (the
 * superseded_by_title rule); otherwise neither its id nor its title appears. */
function supersededRefusal(orgId: string, agent: Agent, task: TaskRecord): Result {
  const replacement = task.superseded_by && !hiddenFrom(orgId, agent, task.superseded_by) ? getTask(orgId, task.superseded_by) : undefined;
  return {
    ok: false,
    error: replacement
      ? `Task "${task.title}" is superseded by "${replacement.title}" (id ${replacement.id}) and takes no new claims; claim that task instead`
      : `Task "${task.title}" is superseded by a newer task and takes no new claims`,
  };
}

/** Extends the caller's lease. Allowed after expiry as long as nobody else
 * has taken the task in the meantime. */
export function renewClaim(orgId: string, agent: Agent, taskId: string, leaseSeconds = DEFAULT_LEASE_SECONDS): Result {
  const expires = leaseExpiry(leaseSeconds);
  if (!expires) return { ok: false, error: `leaseSeconds must be between 0 and ${MAX_LEASE_SECONDS}` };
  if (hiddenFrom(orgId, agent, taskId)) return notFound(taskId);
  const changed = db.prepare(
    `UPDATE tasks SET lease_expires_at = ?, lease_expiry_emitted_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND org_id = ? AND status = 'claimed' AND claimed_by_agent_id = ?`,
  ).run(expires, taskId, orgId, agent.id).changes;
  if (changed === 0) return failure(orgId, taskId, `You don't hold a claim on task "${taskId}"`);
  return { ok: true, task: view(getTask(orgId, taskId)!) };
}

export function releaseTask(orgId: string, agent: Agent, taskId: string): Result {
  if (hiddenFrom(orgId, agent, taskId)) return notFound(taskId);
  const changed = db.transaction(() => {
    const n = db.prepare(
      `UPDATE tasks
          SET status = 'open', claimed_by_agent_id = NULL, claimed_by_agent_name = NULL, lease_expires_at = NULL,
              lease_expiry_emitted_at = NULL, updated_at = datetime('now'),
              -- A release keeps a hold, and its reason (final verification of #782): otherwise releasing a held claim
              -- would hand the task to any third party. Unheld work goes back to NEXT.
              lane = CASE WHEN lane = 'held' THEN 'held' ELSE 'next' END,
              held_reason = CASE WHEN lane = 'held' THEN held_reason ELSE NULL END
        WHERE id = ? AND org_id = ? AND status = 'claimed' AND claimed_by_agent_id = ?`,
    ).run(taskId, orgId, agent.id).changes;
    if (n > 0) {
      emitEvent({ orgId, type: "task.released", actor: agent, subjectType: "task", subjectId: taskId, payload: { title: getTask(orgId, taskId)!.title } });
    }
    return n;
  })();
  if (changed === 0) return failure(orgId, taskId, `You don't hold a claim on task "${taskId}"`);
  return { ok: true, task: view(getTask(orgId, taskId)!) };
}

/** Marks a task done. Only the current claimant can complete it, so "done"
 * always has an owner on record. */
export function completeTask(orgId: string, agent: Agent, taskId: string, summary?: string | null): Result {
  if (hiddenFrom(orgId, agent, taskId)) return notFound(taskId);
  // Hierarchical lifecycle (Stage 2 retro finding): a parent can't "synthesize" (complete) until
  // every subtask has gone through its own execute (completeTask) AND verify (acceptTask) stages.
  // Checked against the CURRENT unfinished count, not cached -- a subtask finishing between two
  // completeTask attempts unblocks the parent without the caller needing to do anything special.
  const unfinished = (db.prepare(
    `SELECT COUNT(*) AS c FROM tasks WHERE org_id = ? AND parent_task_id = ? AND NOT (status = 'done' AND reviewed = 1)`,
  ).get(orgId, taskId) as { c: number }).c;
  if (unfinished > 0) {
    return { ok: false, error: `Cannot complete: ${unfinished} subtask${unfinished === 1 ? "" : "s"} still need${unfinished === 1 ? "s" : ""} to be executed and verified (list_tasks to see which).` };
  }
  const changed = db.transaction(() => {
    // reviewed / review_note reset here, not just at task creation: a task can cycle done -> rejected -> claimed
    // -> done again, and each new completion is a fresh claim of done-ness that needs its own review, unpolluted
    // by whatever a previous rejection said.
    const n = db.prepare(
      `UPDATE tasks
          SET status = 'done', completion_summary = ?, lease_expires_at = NULL, completed_at = datetime('now'), updated_at = datetime('now'),
              reviewed = 0, reviewed_by_agent_id = NULL, reviewed_by_agent_name = NULL, reviewed_at = NULL, review_note = NULL
        WHERE id = ? AND org_id = ? AND status = 'claimed' AND claimed_by_agent_id = ?`,
    ).run(summary?.trim() ? maskSecrets(summary.trim()) : null, taskId, orgId, agent.id).changes;
    if (n > 0) {
      // A fresh completion is a fresh claim of done-ness -- any accept votes from a previous round
      // (e.g. one reviewer already accepted before a second reviewer rejected) must not silently
      // carry over and count toward this round's threshold.
      db.prepare(`DELETE FROM task_reviews WHERE task_id = ?`).run(taskId);
      const task = getTask(orgId, taskId)!;
      emitEvent({
        orgId, type: "task.completed", actor: agent, subjectType: "task", subjectId: taskId,
        payload: { title: task.title, ...(task.completion_summary ? { summary: maskAndCap(task.completion_summary, 200, "") } : {}) },
      });
    }
    return n;
  })();
  if (changed === 0) return failure(orgId, taskId, `Claim task "${taskId}" before completing it`);
  return { ok: true, task: view(getTask(orgId, taskId)!) };
}

/** Shared entry checks for acceptTask/rejectTask: the task must exist (and be visible to this agent -- project
 * isolation), be done, and not already accepted. Self-review is refused here, not in the schema: a task's claimant
 * marking their own "done" claim reviewed would collapse the two-pair-of-eyes distinction the fleet model draws
 * (completed = the claimant's claim; reviewed = someone else's confirmation of that claim) back down to just
 * "done", which is the thing this feature exists to add a check on top of. */
function reviewGuard(orgId: string, actor: Agent, taskId: string): { task: TaskRecord } | Result {
  if (hiddenFrom(orgId, actor, taskId)) return notFound(taskId);
  const task = getTask(orgId, taskId);
  if (!task) return notFound(taskId);
  if (task.status !== "done") return { ok: false, error: `Task "${task.title}" is not done yet -- nothing to review` };
  if (task.reviewed) return { ok: false, error: `Task "${task.title}" has already been accepted` };
  if (task.claimed_by_agent_id === actor.id) {
    return { ok: false, error: `You completed task "${task.title}" yourself -- ask another agent to review it` };
  }
  return { task };
}

/** Records this reviewer's accept vote toward a completed task's claim of done-ness. Must be a
 * distinct agent from the claimant (reviewGuard) -- see the module-level rationale there. When
 * required_reviews is 1 (the default, and every task predating this feature) this is exactly the
 * old single-accept behavior: one vote reaches the threshold and finalizes immediately.
 *
 * When required_reviews is higher, this records the vote and returns early WITHOUT finalizing --
 * the task stays "done"/unreviewed, emitting task.review_recorded (not task.accepted) so callers can
 * see progress ("2 of 3 reviews"). The same reviewer voting again is a no-op, not a second vote
 * (task_reviews' primary key), so redundancy means independent agents, not repeated clicks from one.
 * Terminal once the threshold is reached: an accepted task has no further action (a mistake found
 * later means filing a new task, same as any other institutional record that's already closed). */
export function acceptTask(orgId: string, actor: Agent, taskId: string): Result {
  const pre = reviewGuard(orgId, actor, taskId);
  if (!("task" in pre)) return pre;
  const requiredReviews = Math.max(1, pre.task.required_reviews || 1);
  return db.transaction((): Result => {
    const votedNow = db.prepare(
      `INSERT OR IGNORE INTO task_reviews (org_id, task_id, reviewer_agent_id, reviewer_agent_name, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(orgId, taskId, actor.id, actor.name).changes > 0;
    const reviewCount = (db.prepare(`SELECT COUNT(*) AS c FROM task_reviews WHERE task_id = ?`).get(taskId) as { c: number }).c;
    const task = getTask(orgId, taskId)!;

    if (reviewCount < requiredReviews) {
      if (votedNow) {
        emitEvent({
          orgId, type: "task.review_recorded", actor, subjectType: "task", subjectId: taskId, targetAgentId: task.claimed_by_agent_id,
          payload: { title: task.title, claimant: task.claimed_by_agent_name, reviewCount, requiredReviews },
        });
      }
      return { ok: true, task: view(task) };
    }

    const n = db.prepare(
      `UPDATE tasks
          SET reviewed = 1, reviewed_by_agent_id = ?, reviewed_by_agent_name = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND org_id = ? AND status = 'done' AND reviewed = 0`,
    ).run(actor.id, actor.name, taskId, orgId).changes;
    if (n > 0) {
      emitEvent({
        orgId, type: "task.accepted", actor, subjectType: "task", subjectId: taskId, targetAgentId: task.claimed_by_agent_id,
        payload: { title: task.title, claimant: task.claimed_by_agent_name, reviewCount, requiredReviews },
      });
    }
    return { ok: true, task: view(getTask(orgId, taskId)!) };
  })();
}

/** Bounces a completed task back to its claimant with a note explaining what's missing, and clears reviewed.
 * Restores a fresh lease (rather than dropping to unclaimed / re-claimable) -- the claimant is already known,
 * already has context, and didn't lose their slot by being told to fix something; making them race the open
 * board to reclaim their own rejected task would add friction with no isolation benefit, since nobody else's
 * claim was ever displaced. Must be a distinct agent from the claimant (reviewGuard), same as acceptTask. */
export function rejectTask(orgId: string, actor: Agent, taskId: string, note?: string | null): Result {
  const pre = reviewGuard(orgId, actor, taskId);
  if (!("task" in pre)) return pre;
  const expires = leaseExpiry(DEFAULT_LEASE_SECONDS);
  const changed = db.transaction(() => {
    const n = db.prepare(
      `UPDATE tasks
          SET status = 'claimed', reviewed = 0, reviewed_by_agent_id = NULL, reviewed_by_agent_name = NULL, reviewed_at = NULL,
              review_note = ?, lease_expires_at = ?, lease_expiry_emitted_at = NULL, completed_at = NULL, updated_at = datetime('now'),
              lane = 'now', held_reason = NULL
        WHERE id = ? AND org_id = ? AND status = 'done' AND reviewed = 0`,
    ).run(note?.trim() ? maskSecrets(note.trim()) : null, expires, taskId, orgId).changes;
    if (n > 0) {
      // A single reject is enough to send the task back -- adversarial verification doesn't need
      // consensus to catch a real problem, only consensus to confirm there isn't one. Any accept
      // votes already cast this round are cleared: the next completion is a fresh round needing
      // fresh, independent review.
      db.prepare(`DELETE FROM task_reviews WHERE task_id = ?`).run(taskId);
      const task = getTask(orgId, taskId)!;
      emitEvent({
        orgId, type: "task.rejected", actor, subjectType: "task", subjectId: taskId, targetAgentId: task.claimed_by_agent_id,
        payload: { title: task.title, claimant: task.claimed_by_agent_name, ...(task.review_note ? { note: maskAndCap(task.review_note, 200, "") } : {}) },
      });
    }
    return n;
  })();
  if (changed === 0) return { ok: false, error: `Could not reject task "${taskId}"` };
  return { ok: true, task: view(getTask(orgId, taskId)!) };
}

/** The one task this agent holds a live claim on, or null when it holds none or several (save_task's default link). */
export function soleClaimedTaskId(orgId: string, agentId: string): string | null {
  const ids = db.prepare(`SELECT id FROM tasks WHERE org_id = ? AND status = 'claimed' AND claimed_by_agent_id = ? AND lease_expires_at > ? LIMIT 2`)
    .pluck().all(orgId, agentId, nowIso()) as string[];
  return ids.length === 1 ? ids[0] : null;
}

// --- Work board lanes (fleet coordination plan, slice D; migration 61) ------------------------------------------------

const isValidRank = (rank: unknown): rank is number | null =>
  rank === null || (typeof rank === "number" && Number.isInteger(rank) && rank >= 0 && rank <= TASK_RANK_MAX);

/** A held reason as stored: trimmed, masked like every other task text, and capped. Empty means none. */
function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return maskAndCap(raw.trim(), HELD_REASON_MAX);
}

export type LaneResult = { ok: true; task: TaskView } | { ok: false; error: string; status: 400 | 403 | 404 | 409 };

/** Moves a task between the board's lanes, or re-ranks it. The task's creator, its claimant, or an admin (`admin`: the
 * caller's role allows tasks.manage, src/permissions.ts) may.
 * - now is a claim, never a move: refused with a pointer to claim_task, so the WIP cap (src/tasks.ts claimTask) applies.
 * - held needs a reason. A claimed task may be held (it keeps its claim: blocked work is still someone's); claiming it
 *   again takes it back to now.
 * - next is for unclaimed work only: a claimed task goes back to NEXT by being released.
 * - a done task's lane never changes.
 * Emits task.lane_changed, directed at the claimant when someone else moved a task it holds. */
export function setTaskLane(
  orgId: string,
  actor: Agent,
  by: { admin: boolean },
  taskId: string,
  input: { lane: unknown; rank?: unknown; reason?: unknown },
): LaneResult {
  if (hiddenFrom(orgId, actor, taskId)) return { ok: false, status: 404, error: `No task found matching "${taskId}"` };
  const task = getTask(orgId, taskId);
  if (!task) return { ok: false, status: 404, error: `No task found matching "${taskId}"` };
  if (!by.admin && actor.id !== task.created_by_agent_id && actor.id !== task.claimed_by_agent_id) {
    return { ok: false, status: 403, error: "Only the task's creator, its claimant or an admin can move it." };
  }
  const lane = input.lane;
  if (lane === "now") {
    return { ok: false, status: 409, error: `Moving a task to NOW means claiming it: call claim_task on ${task.id} (the WIP cap applies).` };
  }
  if (lane !== "next" && lane !== "held") return { ok: false, status: 400, error: 'lane must be "next" or "held" (NOW is claim_task)' };
  const rank = input.rank === undefined ? task.rank : input.rank;
  if (!isValidRank(rank)) return { ok: false, status: 400, error: RANK_ERROR };
  const reason = lane === "held" ? cleanReason(input.reason) : null;
  if (lane === "held" && !reason) return { ok: false, status: 400, error: HELD_REASON_ERROR };
  if (task.status === "done") return { ok: false, status: 409, error: `Task "${task.title}" is done; its lane can't change.` };
  if (lane === "next" && task.status === "claimed") {
    return { ok: false, status: 409, error: `Task "${task.title}" is claimed: release it (release_task) to put it back in NEXT, or hold it with a reason. A claimant whose task someone held takes it back to NOW with claim_task.` };
  }
  const changed = db.transaction(() => {
    // Conditional on the row as read, so a claim, release or completion that lands in between is not overwritten.
    const n = db.prepare(
      `UPDATE tasks SET lane = ?, rank = ?, held_reason = ?, updated_at = datetime('now')
        WHERE id = ? AND org_id = ? AND status = ? AND claimed_by_agent_id IS ? AND status != 'done'`,
    ).run(lane, rank, reason, taskId, orgId, task.status, task.claimed_by_agent_id).changes;
    if (n === 0) return false;
    const someoneElse = task.status === "claimed" && task.claimed_by_agent_id !== actor.id;
    emitEvent({
      orgId, type: "task.lane_changed", actor, subjectType: "task", subjectId: taskId,
      targetAgentId: someoneElse ? task.claimed_by_agent_id : null,
      payload: { title: task.title, from: task.lane, to: lane, ...(rank !== null ? { rank } : {}), ...(reason ? { reason } : {}) },
    });
    return true;
  })();
  if (!changed) return { ok: false, status: 409, error: `Task "${task.title}" changed while it was being moved; read it again and retry.` };
  return { ok: true, task: view(getTask(orgId, taskId)!) };
}

/** How many rows one section of the work board has, in the viewer's visible projects (the board shows at most a page). */
export function boardCount(orgId: string, viewerId: string, where: string, params: unknown[]): number {
  const scope = projectSetSql(visibleOf({ orgId, agentId: viewerId }), "project_key");
  return (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE org_id = ? AND (${where}) AND ${scope.sql}`)
    .get(orgId, ...params, ...scope.params) as { c: number }).c;
}

/** One section of the work board: rows matching `where` (over columns of tasks, no alias), in the viewer's visible
 * projects, as views. Exported for src/task-board.ts, which owns what each section is. */
export function boardSection(orgId: string, viewerId: string, where: string, params: unknown[], orderBy: string, limit?: number): TaskView[] {
  const set = visibleOf({ orgId, agentId: viewerId });
  const scope = projectSetSql(set, "project_key");
  const rows = db.prepare(
    `SELECT * FROM tasks WHERE org_id = ? AND (${where}) AND ${scope.sql} ORDER BY ${orderBy}${limit ? " LIMIT ?" : ""}`,
  ).all(orgId, ...params, ...scope.params, ...(limit ? [limit] : [])) as TaskRecord[];
  return viewMany(orgId, rows.map(readRow), { id: viewerId }, nowIso(), set);
}
