import { describe, expect, it } from "vitest";
import { parseStamp, parseStampOrNull, sqliteNow, toSqliteTime } from "../src/timestamps.js";

/**
 * The two spellings one instant can have in this hub, and the conversions between them.
 *
 * JS writes `new Date().toISOString()` -> `2026-09-19T14:30:00.000Z`
 * SQLite writes `datetime('now')`      -> `2026-09-19 14:30:00`
 *
 * They differ at index 10, where `' '` sorts BELOW `'T'` — so a raw string comparison between them
 * resolves there and never reaches the time, and a naive parse of the ISO one yields NaN.
 */

const ISO = "2026-09-19T14:30:00.000Z";
const SQLITE = "2026-09-19 14:30:00";
const EPOCH = Date.parse(ISO);

describe("toSqliteTime — the write direction", () => {
  it("renders SQLite's datetime('now') spelling from ms or a Date", () => {
    expect(toSqliteTime(EPOCH)).toBe(SQLITE);
    expect(toSqliteTime(new Date(EPOCH))).toBe(SQLITE);
  });

  // THE EPOCH ITSELF, pinned because 0 is the value a falsy-check drops. A `|| default` or an
  // `if (!ms)` anywhere on this path would silently render the epoch as "now" or as the fallback,
  // and every other input in this file is truthy, so nothing else here would notice.
  it("renders the epoch, 0, rather than treating it as absent", () => {
    expect(toSqliteTime(0)).toBe("1970-01-01 00:00:00");
    expect(parseStamp(toSqliteTime(0))).toBe(0);
  });

  it("has no zone and a space at index 10, which is what makes it SQLite-shaped", () => {
    const s = toSqliteTime(EPOCH);
    expect(s).toHaveLength(19);
    expect(s[10]).toBe(" ");
    expect(s).not.toContain("T");
    expect(s).not.toContain("Z");
  });

  it("sqliteNow() produces the same shape", () => {
    expect(sqliteNow()).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });
});

describe("parseStamp — the read direction, GUARDED", () => {
  it("parses SQLite's spelling", () => {
    expect(parseStamp(SQLITE)).toBe(EPOCH);
  });

  // THE CASE THE NAIVE FORM GETS WRONG, and the reason this function exists. The naive spelling —
  // always appending `Z` — is correct for SQLite input and returns NaN for ISO input, because it
  // produces "...000ZZ". Verified against that form directly in the test below.
  it("parses an ISO value, which the naive form returns NaN for", () => {
    expect(parseStamp(ISO)).toBe(EPOCH);
    expect(Number.isNaN(parseStamp(ISO))).toBe(false);
  });

  it("round-trips both directions", () => {
    expect(parseStamp(toSqliteTime(EPOCH))).toBe(EPOCH);
    expect(toSqliteTime(parseStamp(SQLITE))).toBe(SQLITE);
  });

  it("reads a zone-less value as UTC, which is what SQLite's 'now' is", () => {
    // If it were read as local time this would differ by the runner's offset, so the assertion is
    // that both spellings land on the SAME instant rather than on a fixed number.
    expect(parseStamp(SQLITE)).toBe(parseStamp(`${SQLITE}Z`.replace(" ", "T")));
  });

  // THE COUNTER-EXAMPLE THAT JUSTIFIES THE GUARD, written out so a future reader can see the two
  // forms disagree rather than take it on trust. This is the naive spelling that five readers in
  // src/ used before this change; it is CORRECT for SQLite input and NaN for ISO.
  it("the naive form this replaced is correct on SQLite input and NaN on ISO — the whole reason for the guard", () => {
    const naive = (s: string) => Date.parse(`${s.replace(" ", "T")}Z`);
    expect(naive(SQLITE)).toBe(EPOCH);          // agree
    expect(Number.isNaN(naive(ISO))).toBe(true); // disagree — and NaN in a comparison is false
    expect(parseStamp(ISO)).toBe(EPOCH);         // the guard is what fixes it
  });
});

describe("parseStampOrNull — the nullable form", () => {
  it("is null for null and for the empty string, and parses otherwise", () => {
    expect(parseStampOrNull(null)).toBeNull();
    expect(parseStampOrNull(undefined)).toBeNull();
    expect(parseStampOrNull("")).toBeNull();
    expect(parseStampOrNull(SQLITE)).toBe(EPOCH);
    expect(parseStampOrNull(ISO)).toBe(EPOCH);
  });

  // An unparseable value yields NaN rather than null, so a caller that wants "unparseable reads as
  // offline" keeps that meaning (billing.ts's isPresenceLive relies on it) rather than silently
  // getting null, which `null > x` and `null <= x` would both coerce to 0 and read as EPOCH.
  it("yields NaN for garbage, NOT null — so a caller cannot accidentally compare it as 0", () => {
    expect(Number.isNaN(parseStampOrNull("not a date"))).toBe(true);
  });
});
