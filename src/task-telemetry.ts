import { db } from "./db.js";
import { projectFilterSql, type ScopeAgent } from "./scope.js";

/** Task-shape telemetry (Stage 2 retro finding: "a feedback loop that retrains task granularity and
 * agent assignment from telemetry automatically"). This is the telemetry, not the feedback loop --
 * an actual automatic retraining/reassignment controller is a genuinely separate, larger system
 * (it would need to decide, unattended, to split/merge future tasks or change routing rules) and
 * isn't claimed here. What this gives instead is the honest data substrate such a loop would
 * consume: for each distinct "shape" a task can have (today: its required_capabilities set, the
 * closest thing to a task type already in the schema), how long a completed task of that shape
 * actually took end to end, and how often it was accepted vs rejected on review.
 * A human (or, eventually, an automated policy) reading this can decide "tasks needing shell+git
 * take 3x longer and get rejected twice as often -- that shape should probably be split smaller,"
 * exactly the judgment call a granularity-retraining loop would need real numbers to make instead
 * of guessing. */

export interface TaskShapeStats {
  /** The sorted required_capabilities list that defines this shape; [] means "no capabilities
   * required," itself a real, meaningful shape (the majority of tasks, most likely). */
  shape: string[];
  /** Completed tasks of this shape (status = 'done'), regardless of review outcome. */
  completedCount: number;
  /** created_at -> completed_at, averaged, in seconds. Whole-lifecycle time (filed to finished), not
   * just active work time -- a task that sat unclaimed for a day inflates this the same way a task
   * that took a day of real effort would, which is a real limitation of using created_at rather than
   * a claim timestamp this schema doesn't track; documented rather than silently assumed accurate. */
  avgLifecycleSeconds: number | null;
  accepted: number;
  rejected: number;
  /** accepted / (accepted + rejected), or null with no review history for this shape yet. */
  acceptRate: number | null;
}

function parseShape(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string").sort() : [];
  } catch {
    return [];
  }
}

/** The canonical key for a shape: capabilities sorted and re-stringified, so ["git", "shell"] and
 * ["shell", "git"] (same requirement, different insertion order) count as the same shape rather than
 * silently fragmenting the stats. */
function shapeKey(shape: string[]): string {
  return JSON.stringify(shape);
}

/** While projects are kept apart, only the viewer's own projects' tasks count (the task board's own rule, visibleOf), so
 * the stats don't reveal another project's activity. Without a viewer (internal callers), every task. */
export function getTaskShapeStats(orgId: string, viewer?: ScopeAgent): TaskShapeStats[] {
  const scope = viewer ? projectFilterSql(viewer, "project_key", { mode: "visible" }) : { sql: "1 = 1", params: [] as string[] };
  const scopeT = viewer ? projectFilterSql(viewer, "t.project_key", { mode: "visible" }) : scope;
  // Grouped by the RAW stored column, which is not itself canonical -- ["shell","git"] and
  // ["git","shell"] are the same requirement but different JSON text, so SQL sees them as separate
  // groups here. Canonicalization (sort + merge) happens below in JS; SUM/COUNT (not AVG) is used so
  // merging two raw variants of the same shape is a plain accumulation, not a weighted-average bug.
  const lifecycle = db.prepare(
    `SELECT required_capabilities AS raw, COUNT(*) AS n,
            SUM((julianday(completed_at) - julianday(created_at)) * 86400) AS sumSeconds
       FROM tasks
      WHERE org_id = ? AND status = 'done' AND completed_at IS NOT NULL AND ${scope.sql}
      GROUP BY required_capabilities`,
  ).all(orgId, ...scope.params) as Array<{ raw: string; n: number; sumSeconds: number | null }>;

  const reviews = db.prepare(
    `SELECT t.required_capabilities AS raw, e.type AS type, COUNT(*) AS n
       FROM events e
       JOIN tasks t ON t.id = e.subject_id AND t.org_id = e.org_id
      WHERE e.org_id = ? AND e.subject_type = 'task' AND e.type IN ('task.accepted', 'task.rejected') AND ${scopeT.sql}
      GROUP BY t.required_capabilities, e.type`,
  ).all(orgId, ...scopeT.params) as Array<{ raw: string; type: string; n: number }>;

  const byShape = new Map<string, TaskShapeStats & { lifecycleSecondsSum: number; lifecycleCount: number }>();
  const entry = (raw: string) => {
    const key = shapeKey(parseShape(raw));
    const existing = byShape.get(key);
    if (existing) return existing;
    const fresh = { shape: parseShape(raw), completedCount: 0, avgLifecycleSeconds: null, accepted: 0, rejected: 0, acceptRate: null, lifecycleSecondsSum: 0, lifecycleCount: 0 };
    byShape.set(key, fresh);
    return fresh;
  };

  for (const row of lifecycle) {
    const stats = entry(row.raw);
    stats.completedCount += row.n;
    if (row.sumSeconds !== null) {
      stats.lifecycleSecondsSum += row.sumSeconds;
      stats.lifecycleCount += row.n;
    }
  }
  for (const stats of byShape.values()) {
    stats.avgLifecycleSeconds = stats.lifecycleCount === 0 ? null : Math.round(stats.lifecycleSecondsSum / stats.lifecycleCount);
  }
  for (const row of reviews) {
    const stats = entry(row.raw);
    if (row.type === "task.accepted") stats.accepted += row.n;
    else stats.rejected += row.n;
  }
  for (const stats of byShape.values()) {
    const total = stats.accepted + stats.rejected;
    stats.acceptRate = total === 0 ? null : stats.accepted / total;
  }

  return [...byShape.values()]
    .map(({ shape, completedCount, avgLifecycleSeconds, accepted, rejected, acceptRate }): TaskShapeStats =>
      ({ shape, completedCount, avgLifecycleSeconds, accepted, rejected, acceptRate }))
    .sort((a, b) => b.completedCount - a.completedCount);
}
