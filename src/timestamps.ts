/**
 * The hub stores timestamps in TWO spellings, and these are the only two conversions.
 *
 *   - JS writes `new Date().toISOString()` -> `2026-09-19T14:30:00.000Z`
 *   - SQLite writes `datetime('now')`      -> `2026-09-19 14:30:00`
 *
 * They are the same instant, and they differ at **index 10**, where `' '` (32) sorts BELOW `'T'`
 * (84). Two consequences, both of which have bitten this repo:
 *
 *   1. Comparing them as STRINGS resolves at index 10 and never reaches the time — every row on the
 *      cutoff's own calendar day falls on the wrong side (see src/org-usage.ts, src/retention.ts).
 *   2. PARSING a SQLite string needs a `T` inserted and a `Z` appended; doing that to a value that
 *      is ALREADY ISO yields `"...000ZZ"` -> `NaN`, and `NaN` in a comparison is `false`, so it
 *      fails silently in whichever direction the comparison happens to point.
 *
 * So: convert explicitly at the boundary, and never let a raw string from one world meet a raw
 * comparison from the other. Both directions live here rather than in a caller so there is one
 * definition of each — this pair was independently re-derived 25 times across src/ and tests/,
 * with the READ direction split into a guarded form and a naive one that disagreed on ISO input.
 */

/** JS instant -> SQLite's `datetime('now')` spelling. The WRITE direction. */
export function toSqliteTime(ms: number | Date): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** SQLite's `datetime('now')` spelling for NOW, generated in JS rather than left to the column
 * default — so a caller knows the value before it inserts, and hashes it in the same statement. */
export function sqliteNow(): string {
  return toSqliteTime(Date.now());
}

/**
 * Either spelling -> epoch ms. The READ direction.
 *
 * GUARDED ON PURPOSE: a value that already carries `T`/`Z`/an offset is parsed as-is, and only a
 * zone-less SQLite string gets the `T`/`Z` treatment. The naive form — always appending `Z` — is
 * correct for SQLite input and returns `NaN` for ISO input, which is the silent-failure direction.
 *
 * A zone-less value is read as UTC, which is what SQLite's `datetime('now')` is.
 *
 * WHY NOT A BARE `Date.parse`. Two wrong forms exist and they fail DIFFERENTLY, which is why both
 * are named here rather than one:
 *
 *   - `Date.parse("2026-09-19 14:30:00")` — the engine reads a zone-less string as LOCAL time, so
 *     on any machine whose offset is not zero it returns an instant **off by that offset**. Measured
 *     at Europe/London (UTC+1): `1789824600000` = `13:30:00Z` for a value that means `14:30:00Z` —
 *     **one hour wrong, plausible, and silent**. This is WORSE than a NaN precisely because it is a
 *     valid number: nothing downstream can tell it from a correct one. And it is **invisible under
 *     `TZ=UTC`**, which is what a CI box uses, so a unit test there cannot catch it.
 *   - The naive wrapper — always appending `Z` — is correct for SQLite input and returns **NaN** for
 *     an ISO value (`"...000ZZ"`). Also silent, in the opposite direction: NaN in a comparison is
 *     `false`, so it lands on whichever side the comparison points.
 *
 * This function is guarded on the input's own shape, and is the only form that is right for both.
 */
export function parseStamp(value: string): number {
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

/** `parseStamp`, but null for a null input — for nullable columns, so callers do not each write the
 * ternary. A value that does not parse yields NaN, as `Date.parse` does; callers decide what that
 * means for them (e.g. an unparseable heartbeat reads as offline, the direction that under-counts
 * rather than refusing a live workspace). */
export function parseStampOrNull(value: string | null | undefined): number | null {
  return value == null || value === "" ? null : parseStamp(value);
}

/** A provider's RFC 3339 instant at FULL precision, in one fixed-width UTC spelling: `YYYY-MM-DDTHH:MM:SS.ffffffZ`
 * (always six fractional digits). Null when the value is not an RFC 3339 date-time with a four-digit year.
 *
 * WHY NOT `toISOString()`. the payment provider stamps events in MICROSECONDS ("2024-04-12T11:24:55.637846Z"), and the billing
 * ordering guard compares these values. Truncating to milliseconds makes two changes inside one millisecond equal,
 * and an equal pair is ordered by arrival -- which the provider does not guarantee. Six digits keeps every digit
 * the payment provider sends (a finer value is truncated, a coarser one zero-padded), and the FIXED WIDTH keeps string order equal
 * to time order, which is what lets SQL compare the column directly.
 *
 * The digits are read off the string, not through `Date` (which has only milliseconds); `Date` is used for the
 * whole-second part, so an offset such as `+01:00` is still converted to UTC. Offsets are whole minutes, so they never
 * touch the fraction. */
export function preciseInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!shape) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const whole = new Date(Math.floor(ms / 1000) * 1000).toISOString();
  if (!/^\d{4}-/.test(whole)) return null;
  return `${whole.slice(0, 19)}.${(shape[1] ?? "").padEnd(6, "0").slice(0, 6)}Z`;
}

/** SQL that reads an instant column written in EITHER precision -- the millisecond `toISOString()` spelling (24
 * characters, written before provider instants kept microseconds) or `preciseInstant`'s (27) -- as the 27-character
 * spelling, so a guard comparing it against a `preciseInstant` value orders by time rather than by the `Z` that a
 * shorter value puts where a longer one has digits. */
export const preciseInstantSql = (column: string) =>
  `CASE WHEN length(${column}) = 24 THEN substr(${column}, 1, 23) || '000Z' ELSE ${column} END`;
