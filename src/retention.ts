import { db } from "./db.js";
import { toSqliteTime } from "./timestamps.js";

/** Plan retention windows (docs/planning/PRICING.md §8 item 2, lane 9 / lane 6).
 *
 * The promise this module exists to keep is narrow and deliberate: a row past its plan's window is
 * **hidden from reads, never deleted**. Nothing here removes data. A customer who downgrades and later
 * upgrades gets their history back, because it never left — which is the only version of "retention"
 * that is safe to ship without a deletion path, warning emails and an export.
 *
 * Delivery, deletion and the 90-day warn-then-delete sequence are PRICING.md's §8 item 5 and are NOT
 * here. When they land they must be a deliberate act with a customer-visible warning, not a side effect
 * of this filter.
 */

/** The window a workspace's rows are visible for, in days. `null` means no window: everything is
 * visible, which is what an unmetered/unplanned workspace gets -- the same fail-open direction the rest
 * of the hub uses for a workspace with no plan, since hiding a paying customer's history would be the
 * worse error.
 *
 * ONE accessor, on purpose. Lane 9's `plans.retention_days` column (#430) will feed it; until that
 * lands this reads the same `plans` table the billing work introduces, and falls back to null when the
 * row, the column or the workspace's plan is absent. Keeping every caller on this function means the
 * swap is one line here rather than a hunt for call sites. */
export function retentionDaysFor(orgId: string): number | null {
  const row = db
    .prepare(
      `SELECT p.retention_days AS days
         FROM organizations o
         LEFT JOIN plans p ON p.key = o.plan
        WHERE o.id = ?`,
    )
    .get(orgId) as { days: number | null } | undefined;
  const days = row?.days;
  return typeof days === "number" && days > 0 ? days : null;
}

/** The earliest instant a row may still be visible: rows created at or after this are shown, older ones
 * are hidden. `null` when there is no window, so callers can skip adding a clause entirely.
 *
 * THE FORMAT MATTERS AND IS NOT COSMETIC. This value is compared as a STRING against `created_at`,
 * which columns default to SQLite's `datetime('now')` -> `"2026-09-19 14:30:00"`. An ISO string
 * (`"2026-09-19T14:30:00.000Z"`) differs at index 10, where `' '` sorts BELOW `'T'`, so the comparison
 * resolves there and never reaches the time: every row on the cutoff's calendar day compares as older
 * and is hidden although it is still inside the window -- a silent extra day of hiding that grows with
 * the plan's window. So this emits the SQLite spelling, every caller compares like with like, and
 * `tests/retention.test.ts` pins the boundary an hour either side.
 *
 * (src/billing.ts:66 records that this hub holds BOTH spellings -- zoned ISO for values it writes
 * itself, SQLite's for column defaults -- and parses accordingly. A retention clause cannot parse, so
 * it must match the column it filters; that is why the test helper writes the production format too.) */
export function retentionCutoff(orgId: string, nowMs = Date.now()): string | null {
  const days = retentionDaysFor(orgId);
  if (days === null) return null;
  // Same shape as SQLite's datetime('now'): "YYYY-MM-DD HH:MM:SS", space separator, no zone.
  return toSqliteTime(nowMs - days * 86_400_000);
}

/** What the console and API say instead of the hidden rows. Naming the plan is the point: "kept on
 * Team" tells the customer their data exists and what would bring it back, where a bare empty list
 * reads as data loss. */
export function retentionNotice(orgId: string): { hidden: true; retentionDays: number; keptOn: string } | null {
  const days = retentionDaysFor(orgId);
  if (days === null) return null;
  const plan = db.prepare(`SELECT p.name FROM organizations o LEFT JOIN plans p ON p.key = o.plan WHERE o.id = ?`).get(orgId) as
    | { name: string | null }
    | undefined;
  return { hidden: true, retentionDays: days, keptOn: plan?.name ?? "your plan" };
}
