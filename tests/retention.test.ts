import { toSqliteTime } from "../src/timestamps.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { emitEvent, listEvents } from "../src/events.js";
import { createMemory, listMemory, getMemory } from "../src/memory.js";
import { listTimeline, waitForTimeline } from "../src/timeline.js";
import { retentionCutoff, retentionDaysFor, retentionNotice } from "../src/retention.js";

/** Plan retention windows (docs/planning/PRICING.md §8 item 2). The promise under test is narrow:
 * rows older than the plan's window are **hidden from reads, never deleted**. Every test that hides a
 * row also asserts the row is still in the database, because "hidden" and "gone" are the two things
 * this feature must never be confused about -- the second one is a data-loss incident and a broken
 * sales promise, the first is a plan limit.
 *
 * The window is set explicitly in each test: on main every `plans.retention_days` is NULL (lane 9's
 * #430 supplies the values), so an unset workspace hides nothing and a test that relied on the seeded
 * data would pass for the wrong reason. */

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function setupOrg(name: string) {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  return { orgId, a: { id: a.agentId, name: "Agent A", key: a.apiKey } };
}

/** Sets the workspace's plan and that plan's window, which is what lane 9's column will do. */
function setWindow(orgId: string, planKey: string, days: number | null, planName = planKey) {
  db.prepare(`INSERT INTO plans (key, name, retention_days) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, retention_days = excluded.retention_days`)
    .run(planKey, planName, days);
  db.prepare(`UPDATE organizations SET plan = ? WHERE id = ?`).run(planKey, orgId);
}

/** Backdates a row so it falls outside any sane window, without touching the code under test.
 *
 * It writes the PRODUCTION format, which is the whole point: `created_at` defaults to SQLite's
 * `datetime('now')` -> `"2026-09-19 14:30:00"` (space separator, no `Z`). An earlier version of this
 * helper wrote `new Date().toISOString()` -> `"2026-09-19T14:30:00.000Z"`, which is a DIFFERENT string
 * that sorts differently (' ' < 'T' at index 10), so these tests passed against a cutoff format that
 * would have hidden a day's worth of rows in production. The helper must speak the same dialect as the
 * column, or every boundary test built on it is measuring the helper. */
function backdate(table: "events" | "memory_entries", id: number | string, days: number) {
  const at = toSqliteTime(Date.now() - days * 86_400_000);
  if (table === "events") db.prepare(`UPDATE events SET created_at = ? WHERE seq = ?`).run(at, id);
  else db.prepare(`UPDATE memory_entries SET created_at = ? WHERE id = ?`).run(at, id);
}

/** Pins a row's `created_at` to an exact production-format instant, for boundary work. */
function setCreatedAt(table: "events" | "memory_entries", id: number | string, atMs: number) {
  const at = toSqliteTime(atMs);
  if (table === "events") db.prepare(`UPDATE events SET created_at = ? WHERE seq = ?`).run(at, id);
  else db.prepare(`UPDATE memory_entries SET created_at = ? WHERE id = ?`).run(at, id);
}

describe("retention windows: hide on read, never delete", () => {
  it("hides a memory entry past the window from reads, and the row is still in the database", () => {
    const { orgId, a } = setupOrg("Retention Memory");
    setWindow(orgId, "pro", 30, "Pro");
    const old = createMemory(orgId, a, { title: "Old note", body: "This is older than the window and must be hidden but kept." });
    const fresh = createMemory(orgId, a, { title: "Fresh note", body: "This is inside the window and must stay visible." });
    backdate("memory_entries", old.id, 90);

    const ids = listMemory(orgId).entries.map((e) => e.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(old.id);

    // The half that matters: hidden, NOT deleted. This is the whole promise.
    expect(db.prepare(`SELECT 1 FROM memory_entries WHERE id = ?`).get(old.id)).toBeTruthy();
  });

  it("hides a timeline event past the window from reads, and the row is still in the database", () => {
    const { orgId, a } = setupOrg("Retention Timeline");
    setWindow(orgId, "pro", 30, "Pro");
    emitEvent({ orgId, type: "decision.recorded", actor: a, subjectType: "org", subjectId: orgId, payload: { title: "old" } });
    const newest = listTimeline(orgId, { latest: true, limit: 1 })[0];
    backdate("events", newest.seq, 90);

    const seqs = listTimeline(orgId, { limit: 50 }).map((e) => e.seq);
    expect(seqs).not.toContain(newest.seq);
    expect(db.prepare(`SELECT 1 FROM events WHERE seq = ?`).get(newest.seq)).toBeTruthy();
  });

  it("makes hidden rows visible again on upgrade, because nothing was ever deleted", () => {
    const { orgId, a } = setupOrg("Retention Upgrade");
    setWindow(orgId, "trial", 7, "Trial");
    const old = createMemory(orgId, a, { title: "Trial-era note", body: "Written on the trial, hidden by its short window." });
    backdate("memory_entries", old.id, 30);
    expect(listMemory(orgId).entries.map((e) => e.id)).not.toContain(old.id);

    // Upgrade: a longer window reveals it again with no restore step and no data movement.
    setWindow(orgId, "business", 3650, "Business");
    expect(listMemory(orgId).entries.map((e) => e.id)).toContain(old.id);
    // And the row never moved.
    expect(db.prepare(`SELECT created_at FROM memory_entries WHERE id = ?`).get(old.id)).toBeTruthy();
  });

  it("hides nothing when the plan has no window, which is what an unset column means", () => {
    const { orgId, a } = setupOrg("Retention Unset");
    setWindow(orgId, "pro", null, "Pro"); // main's state today: the column exists and is NULL
    const old = createMemory(orgId, a, { title: "Ancient", body: "With no window configured nothing may be hidden." });
    backdate("memory_entries", old.id, 3650);

    expect(retentionDaysFor(orgId)).toBeNull();
    expect(retentionCutoff(orgId)).toBeNull();
    expect(retentionNotice(orgId)).toBeNull();
    expect(listMemory(orgId).entries.map((e) => e.id)).toContain(old.id);
  });

  it("still serves a hidden row by id, so a link a customer already has does not 404 into a data-loss reading", () => {
    // Deliberate: retention limits the LISTING and the history view. It is not a permission system, and
    // a direct fetch of a row the workspace owns staying available is the conservative direction --
    // hiding it here would be indistinguishable from a bug to the person holding the link.
    const { orgId, a } = setupOrg("Retention Direct");
    setWindow(orgId, "pro", 30, "Pro");
    const old = createMemory(orgId, a, { title: "Linked note", body: "Reachable by id even when the window hides it from lists." });
    backdate("memory_entries", old.id, 90);
    expect(getMemory(orgId, old.id)).toBeTruthy();
  });

  // THE BOUNDARY, and the reason this file exists in the shape it does. `created_at` is SQLite's
  // `datetime('now')` -- "2026-09-19 14:30:00", a SPACE at index 10 and no trailing Z. An ISO cutoff
  // ("2026-09-19T14:30:00.000Z") differs at exactly that index, and ' ' < 'T', so the string comparison
  // never reaches the time: EVERY row on the cutoff's calendar day compares as older and is hidden,
  // however recent it is. The window would quietly hide an extra day, growing with the plan's window.
  //
  // THE CLOCK IS PINNED, WHICH IS WHAT MAKES THESE BITE AT EVERY HOUR. The defect lives at index 10 --
  // the date/time separator -- so it is only exercised when the row and the cutoff share a CALENDAR DAY.
  // Cross midnight and the date parts differ, the comparison is decided by the date, and the two
  // spellings AGREE: the assertions pass on the BROKEN code. No fixed margin removes that, because a
  // margin M is blind whenever the cutoff is within M of midnight, and larger margins are worse (+2h was
  // blind from 22:00 UTC, +1h from 23:00, +30min at 23:30). This pair was merged at ±1h and was blind
  // for an hour a day. Pinning the clock to MIDDAY removes the window instead of shrinking it: the cutoff
  // is noon, so the rows are same-day at any sane margin. `vi.useFakeTimers()` is the repo's idiom.
  it("keeps a row one hour INSIDE the window visible, and hides one an hour outside it", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
      const { orgId, a } = setupOrg("Retention Boundary");
      const days = 30;
      setWindow(orgId, "pro", days, "Pro");
      const cutoffMs = Date.now() - days * 86_400_000;
      const inside = createMemory(orgId, a, { title: "Inside", body: "An hour newer than the cutoff, so it is inside the window." });
      const outside = createMemory(orgId, a, { title: "Outside", body: "An hour older than the cutoff, so it is outside the window." });
      setCreatedAt("memory_entries", inside.id, cutoffMs + 3_600_000);
      setCreatedAt("memory_entries", outside.id, cutoffMs - 3_600_000);

      const ids = listMemory(orgId).entries.map((e) => e.id);
      expect(ids).toContain(inside.id);   // <-- this is the assertion that fails on the ISO cutoff
      expect(ids).not.toContain(outside.id);
      // And both rows still exist, so the boundary is about visibility and never about deletion.
      expect(db.prepare(`SELECT 1 FROM memory_entries WHERE id = ?`).get(outside.id)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // The same boundary on the timeline path, because the two readers compare independently.
  it("applies the same boundary to the timeline, not just memory", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
      const { orgId, a } = setupOrg("Retention Timeline Boundary");
      const days = 30;
      setWindow(orgId, "pro", days, "Pro");
      const cutoffMs = Date.now() - days * 86_400_000;
      emitEvent({ orgId, type: "decision.recorded", actor: a, subjectType: "org", subjectId: orgId, payload: { title: "inside" } });
      const inside = listEvents(orgId).at(-1)!;
      emitEvent({ orgId, type: "decision.recorded", actor: a, subjectType: "org", subjectId: orgId, payload: { title: "outside" } });
      const outside = listEvents(orgId).at(-1)!;
      setCreatedAt("events", inside.seq, cutoffMs + 3_600_000);
      setCreatedAt("events", outside.seq, cutoffMs - 3_600_000);

      const seqs = listTimeline(orgId, { limit: 50 }).map((e) => e.seq);
      expect(seqs).toContain(inside.seq);
      expect(seqs).not.toContain(outside.seq);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the notice the console and API show instead", () => {
  it("names the plan and the window, so an empty list does not read as data loss", () => {
    const { orgId } = setupOrg("Retention Notice");
    setWindow(orgId, "team", 90, "Team");
    expect(retentionNotice(orgId)).toEqual({ hidden: true, retentionDays: 90, keptOn: "Team" });
  });

  it("returns no notice when there is no window, so the copy cannot appear spuriously", () => {
    const { orgId } = setupOrg("Retention No Notice");
    setWindow(orgId, "internal", null, "Internal");
    expect(retentionNotice(orgId)).toBeNull();
  });

  // WIRED, not merely available. A notice no response carries is a building block, and an empty list
  // with no explanation still reads as data loss -- which is the outcome this copy exists to prevent.
  // Asserted over HTTP because that is the surface the console actually reads.
  it("reaches the client on the memory and timeline list responses", async () => {
    const { orgId, a } = setupOrg("Retention Wired");
    setWindow(orgId, "team", 90, "Team");
    const auth = { authorization: `Bearer ${a.key}` };

    const mem = (await (await fetch(`${base}/v1/memory`, { headers: auth })).json()) as { retention?: unknown };
    expect(mem.retention).toEqual({ hidden: true, retentionDays: 90, keptOn: "Team" });

    const ev = (await (await fetch(`${base}/v1/events`, { headers: auth })).json()) as { retention?: unknown };
    expect(ev.retention).toEqual({ hidden: true, retentionDays: 90, keptOn: "Team" });
  });

  it("omits the field entirely when there is no window, so existing response shapes are unchanged", async () => {
    const { orgId, a } = setupOrg("Retention Unwired");
    setWindow(orgId, "internal", null, "Internal");
    const auth = { authorization: `Bearer ${a.key}` };

    const mem = (await (await fetch(`${base}/v1/memory`, { headers: auth })).json()) as Record<string, unknown>;
    expect("retention" in mem).toBe(false);
    const ev = (await (await fetch(`${base}/v1/events`, { headers: auth })).json()) as Record<string, unknown>;
    expect("retention" in ev).toBe(false);
  });
});

/** THE GUARD 9d1f ASKED FOR. This exists to stop a future "widening" rather than to test today's code.
 *
 * The retention filter lives in `listTimeline` and deliberately NOT in `listEvents`, because
 * `listEvents` backs live delivery, the long-poll waiter and the awareness digest. If a later change
 * moves or duplicates the clause into `listEvents` -- which would look like a tidy refactor, one filter
 * in one place -- live coordination would start skipping messages because of a billing window. That is
 * a correctness bug wearing a plan limit's clothes, and it would pass every other test in this file.
 *
 * So these assert the invariant from the OUTSIDE, on an event old enough to be hidden from the
 * timeline: it must still be DELIVERED, and it must still WAKE a waiter. */
describe("retention must never reach live coordination (the guard)", () => {
  it("still delivers an event the timeline hides, so delivery never depends on a billing window", () => {
    const { orgId, a } = setupOrg("Retention Live Path");
    setWindow(orgId, "pro", 30, "Pro");
    emitEvent({ orgId, type: "decision.recorded", actor: a, subjectType: "org", subjectId: orgId, payload: { title: "old but live" } });
    const target = listEvents(orgId).at(-1)!;
    backdate("events", target.seq, 90);

    // Hidden from the history reader...
    expect(listTimeline(orgId, { limit: 50 }).map((e) => e.seq)).not.toContain(target.seq);
    // ...but still on the path live consumers read. THIS is the assertion that fails if anyone moves the
    // filter into listEvents.
    expect(listEvents(orgId).map((e) => e.seq)).toContain(target.seq);
  });

  it("still wakes a long-poll waiter with an event the timeline hides", async () => {
    const { orgId, a } = setupOrg("Retention Waiter");
    setWindow(orgId, "pro", 30, "Pro");
    const before = listEvents(orgId).at(-1)?.seq ?? 0;
    emitEvent({ orgId, type: "decision.recorded", actor: a, subjectType: "org", subjectId: orgId, payload: { title: "wake me" } });
    const target = listEvents(orgId).at(-1)!;
    backdate("events", target.seq, 90);

    // A waiter sitting past the old event must still be woken by it: the wait runs on the live path, not
    // the history path, so a retention window may not silence it.
    const woken = await waitForTimeline(orgId, before, 1);
    expect(woken.map((e) => e.seq)).toContain(target.seq);
  });
});

/**
 * THE WINDOW AND THE PAGE DISAGREE ABOUT ORDERING, and this block is what stops it returning.
 *
 * `listTimeline` used to call `listEvents` (which applies `LIMIT 200` in SQL) and then filter by the
 * cutoff IN JS. So on a windowed plan, expired rows consumed the page and live rows behind them were
 * never reached — and because the route computes
 * `nextAfter: events.at(-1)?.seq ?? cursorFrom(req.query.after)`, an EMPTY filtered page re-served the
 * cursor the caller already had, so a paging caller looped forever.
 *
 * MEASURED BEFORE THE FIX, on the real route: page sizes `0, 0, 0, 0, 0` on an org holding 5 live
 * events, with `nextAfter` never advancing. The console pages this same route
 * (`public/app/app.js:603`), so it was a customer-facing timeline that was silently empty and
 * permanently stuck — on a plan whose page promises "Last 90 days".
 *
 * The window is NOT removed by this fix and must not be: it is a plan limit and the rule is
 * hide-on-read, never delete. What changed is the LAYER it is applied at, so the limit and the filter
 * compose in the right order.
 */
describe("retention window vs paging: the filter must not run after the limit", () => {
  /** Fills an org with `expired` rows OUTSIDE the window followed by `live` rows INSIDE it. The
   * ordering is the point: with the filter applied after the limit, the expired rows are exactly what
   * consumes the page.
   *
   * THE BACKDATE IS DELIBERATELY 200 DAYS AGAINST A 90-DAY WINDOW, and the margin is the whole
   * fixture. My first version backdated by 90 -- the SAME number as the window -- which puts the rows
   * exactly ON the cutoff. `retentionCutoff` returns `now - days` and the comparison is `created_at >=
   * cutoff`, INCLUSIVE, so every one of those rows was INSIDE the window, nothing was hidden, and the
   * test's red described a world it had not built. Measured: `backdated to === cutoff`, `rows >=
   * cutoff: 305 of 305`. A boundary fixture must not sit on the boundary it is testing.
   *
   * AND THE ROWS ARE TARGETED BY SUBJECT, NOT BY A SEQ CEILING, which was the second bug in this
   * helper. `listEvents(orgId).at(-1)?.seq` looks like "the highest seq so far", but `listEvents` caps
   * at MAX_PAGE = 200 -- so reading it after 300 emits yields the seq of the 200TH row, and the
   * backdate covered only 200 of the 300. The remaining 100 stayed inside the window and appeared in
   * the page, so the test measured a mixture. **The instrument used to build the world was silently
   * capped by the same limit the test exists to expose.** `createOrganization` also emits its own
   * events, so a seq ceiling cannot identify our rows at all; the subject_id can. */
  function fill(orgId: string, expired: number, live: number) {
    for (let i = 0; i < expired; i++) emitEvent({ orgId, type: "agent.connected", subjectType: "agent", subjectId: `expired-${i}` });
    for (let i = 0; i < live; i++) emitEvent({ orgId, type: "agent.connected", subjectType: "agent", subjectId: `live-${i}` });
    db.prepare(`UPDATE events SET created_at = ? WHERE org_id = ? AND subject_id LIKE 'expired-%'`)
      .run(new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 19).replace("T", " "), orgId);
  }

  it("composes subject and retention filters before the page limit", () => {
    const { orgId } = setupOrg("Window Subject Composition");
    setWindow(orgId, "team", 90, "Team");
    emitEvent({ orgId, type: "agent.connected", subjectType: "agent", subjectId: "target" });
    const old = db.prepare(`SELECT MAX(seq) AS seq FROM events WHERE org_id = ? AND subject_id = 'target'`).get(orgId) as { seq: number };
    backdate("events", old.seq, 200);
    emitEvent({ orgId, type: "agent.connected", subjectType: "agent", subjectId: "target" });
    emitEvent({ orgId, type: "agent.connected", subjectType: "agent", subjectId: "other" });

    const page = listTimeline(orgId, { subject: { type: "agent", id: "target" }, limit: 1 });
    expect(page.map((event) => event.subject_id)).toEqual(["target"]);
    expect(page[0].seq).toBeGreaterThan(old.seq);
    expect(page[0].created_at >= retentionCutoff(orgId)!).toBe(true);
  });

  it("returns the LIVE rows on one page even when expired rows outnumber the page size", () => {
    // 300 expired > MAX_PAGE (200), so the old code filled the page with rows the window hides and the
    // 5 live ones were unreachable. The assertion is on the live rows' PRESENCE, not on a count: a
    // count could be satisfied by returning the wrong rows.
    const { orgId } = setupOrg("Window Paging");
    setWindow(orgId, "team", 90, "Team");
    fill(orgId, 300, 5);

    const page = listTimeline(orgId, { limit: 200 });
    // Asserted by SUBJECT, not by a seq threshold: the org carries events of its own from
    // `createOrganization`, so a seq cutoff would not identify our rows. The live ones are the only
    // `live-*` rows and every one of them must be on this single page.
    const liveSubjects = new Set(page.filter((e) => e.subject_id.startsWith("live-")).map((e) => e.subject_id));
    expect([...liveSubjects]).toHaveLength(5);
    // And nothing outside the window leaked in: the filter still holds.
    for (const e of page) expect(e.created_at >= retentionCutoff(orgId)!).toBe(true);
  });

  it("does not STALL: nextAfter advances while expired rows are still ahead of the cursor", async () => {
    // The second defect, and the one a filter-only fix would leave. Drive the REAL route as a pager
    // does and require the cursor to move. The old code returned an empty page and the SAME after, so
    // this loop could never terminate.
    const { orgId, a } = setupOrg("Window Stall");
    setWindow(orgId, "team", 90, "Team");
    fill(orgId, 300, 5);

    let after = 0;
    const seen: number[] = [];
    let advancedOnFirstPage = false;
    for (let pageNo = 0; pageNo < 4; pageNo++) {
      const res = await fetch(`${base}/v1/events?after=${after}&limit=200`, { headers: { authorization: `Bearer ${a.key}` } });
      const body = (await res.json()) as { events: Array<{ seq: number }>; nextAfter: number };
      seen.push(...body.events.map((e) => e.seq));
      // THE PROPERTY IS "ADVANCES WHILE THERE IS ANYTHING LEFT", NOT "ADVANCES ON EVERY PAGE". The
      // last page of a finished history legitimately returns the same cursor -- there is nothing beyond
      // it and the caller is meant to stop. My first version asserted `toBeGreaterThan(after)` on every
      // page, which fails on that honest terminal page and would have demanded a cursor that walks off
      // the end of the sequence. What the defect destroyed was the FIRST page: it returned nothing and
      // did not move, so the caller could never reach the rows at all.
      if (pageNo === 0) {
        advancedOnFirstPage = body.nextAfter > after;
        expect(body.nextAfter, "page 0 did not advance: a caller loops on the same empty page forever").toBeGreaterThan(after);
      } else if (body.events.length === 0) {
        expect(body.nextAfter, "the terminal page moved the cursor without returning rows").toBe(after);
      }
      after = body.nextAfter;
    }
    expect(advancedOnFirstPage).toBe(true);
    // Every visible row is reachable by paging, which is the property the stall destroyed.
    const live = listTimeline(orgId, { limit: 200 }).map((e) => e.seq);
    for (const s of live) expect(seen).toContain(s);
  });

  it("still hides everything outside the window, and deletes none of it", () => {
    // The promise this whole feature exists to keep, re-asserted here because a fix that starts
    // returning expired rows to make paging work would satisfy the two tests above and break the plan
    // limit. Hidden is a plan limit; gone is a data-loss incident.
    const { orgId } = setupOrg("Window Hides");
    setWindow(orgId, "team", 90, "Team");
    fill(orgId, 300, 5);

    const page = listTimeline(orgId, { limit: 200 });
    const expired = db.prepare(`SELECT COUNT(*) n FROM events WHERE org_id = ? AND subject_id LIKE 'expired-%'`).get(orgId) as { n: number };
    expect(expired.n).toBe(300); // still IN the database
    const expiredSeqs = db.prepare(`SELECT seq FROM events WHERE org_id = ? AND subject_id LIKE 'expired-%'`).all(orgId) as Array<{ seq: number }>;
    for (const { seq } of expiredSeqs) expect(page.map((e) => e.seq)).not.toContain(seq);
  });
});
