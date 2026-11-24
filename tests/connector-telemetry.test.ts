// PR-E1b, pure pieces (PLAN-PR-E addendum §1.2, §3.4, §4.1; amendment 2 §4.1 and §5).
//
// The statuses say what the evidence shows and nothing more: `no-recent-report` is missing telemetry (seen in 24 h, no
// report in 24 h), refusal counts are observed reasons, a cohort is named only from a whole-set full-hash match, and
// "security update required" comes only from a reviewed `required` entry. The shipped policy has NO required entries.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { bumpRefusal, connectorHealth, MAX_COUNT, mergeConnectorReports, refusalCounts, validateConnectorReport } from "../src/connector-health.js";
import { DISPLAY_TEXT, parseCompatPolicy, recognizeCohort, validateCompatPolicy } from "../src/compat-policy.js";

const H = (c: string) => c.repeat(64);
const report = (over: Record<string, unknown> = {}) => ({
  schema: 1, client: "codex", component: "hooks", installationId: "a".repeat(32), bundleId: "123456789abc",
  integrity: "matches-metadata", helpers: { "opencadre-config.mjs": H("a"), "opencadre-mcp.mjs": H("b") }, ...over,
});
const stored = (...reports: Array<Record<string, unknown>>) => {
  let raw = "[]";
  for (const r of reports) raw = JSON.stringify(mergeConnectorReports(raw, validateConnectorReport(r)!, 1000));
  return raw;
};
const NOW = 2000;
const TARGET = { "opencadre-config.mjs": H("a"), "opencadre-mcp.mjs": H("b") };
const HOUR = 3600_000;

const cohortPolicy = (required: unknown[] = []) => ({
  schema: 1,
  cohorts: [
    { id: "c-old", helpers: { "opencadre-config.mjs": [H("1"), H("2")], "opencadre-mcp.mjs": H("3") }, status: "supported", evidence: "tests/connector-previous-bundle.test.ts", contracts: ["identity", "mail"] },
    { id: "c-other", helpers: { "opencadre-config.mjs": H("4") }, status: "supported", evidence: "tests/connector-previous-bundle.test.ts", contracts: ["identity"] },
  ],
  required,
});
const requiredEntry = (over: Record<string, unknown> = {}) => ({
  id: "r-undated-stamp", cohorts: ["c-old"], class: "security", feature: "per-chat identity on stamp clients",
  reason: "an undated stamp can be replayed", decision: "decision #1", recovery: "connect --upgrade, then restart the tool", ...over,
});

describe("no-recent-report: missing telemetry, never an age or a verdict", () => {
  it("is set only when the computer was seen in the last 24 h and sent no report in that time", () => {
    const seen = new Date(NOW - 1000).toISOString();
    expect(connectorHealth("[]", TARGET, NOW, { lastSeenAt: seen }).status).toBe("no-recent-report");
    // Never seen, or seen more than 24 h ago: nothing is known, so nothing is claimed.
    expect(connectorHealth("[]", TARGET, NOW, { lastSeenAt: null }).status).toBe("unknown");
    expect(connectorHealth("[]", TARGET, NOW + 25 * HOUR, { lastSeenAt: seen }).status).toBe("unknown");
    // A recent report means telemetry is present: the report's own status applies.
    expect(connectorHealth(stored(report()), TARGET, NOW, { lastSeenAt: seen }).status).toBe("reported-current");
    // A report older than 24 h is gone, so a computer seen since then reads as no recent report.
    expect(connectorHealth(stored(report()), TARGET, 1000 + 24 * HOUR + 1, { lastSeenAt: new Date(1000 + 24 * HOUR).toISOString() }).status).toBe("no-recent-report");
  });
  it("keeps the existing statuses unchanged", () => {
    expect(connectorHealth(stored(report({ helpers: { "opencadre-config.mjs": H("c") } })), TARGET, NOW).status).toBe("update-available");
    expect(connectorHealth(stored(report({ integrity: "modified-or-missing" })), TARGET, NOW).status).toBe("check-installation");
    expect(connectorHealth(stored(report()), null, NOW).status).toBe("unknown");
  });
});

describe("refusal counts: observed reasons and counts for the last 24 h, bounded", () => {
  it("counts per reason, in hourly buckets that age out after 24 h", () => {
    let raw = "{}";
    raw = bumpRefusal(raw, "no_session", 0);
    raw = bumpRefusal(raw, "no_session", 10 * HOUR);
    raw = bumpRefusal(raw, "ambiguous_session", 10 * HOUR);
    expect(refusalCounts(raw, 10 * HOUR)).toEqual({ no_session: 2, ambiguous_session: 1 });
    // Hour 0 is outside the window 24 h later; hour 10 is still inside.
    expect(refusalCounts(raw, 24 * HOUR)).toEqual({ no_session: 1, ambiguous_session: 1 });
    expect(refusalCounts(raw, 34 * HOUR)).toEqual({ no_session: 0, ambiguous_session: 0 });
    // Pruned on write: a bump 24 h on keeps no stale bucket.
    const pruned = JSON.parse(bumpRefusal(raw, "no_session", 40 * HOUR));
    expect(Object.keys(pruned.no_session)).toEqual(["40"]);
    expect(pruned.ambiguous_session).toBeUndefined();
  });
  it("caps every count, and stores nothing but a reason, an hour and a count", () => {
    const full = JSON.stringify({ no_session: { "5": MAX_COUNT } });
    expect(refusalCounts(bumpRefusal(full, "no_session", 5 * HOUR), 5 * HOUR).no_session).toBe(MAX_COUNT);
    const many = JSON.stringify({ no_session: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(100 + i), MAX_COUNT])) });
    expect(refusalCounts(many, 123 * HOUR).no_session).toBe(MAX_COUNT);
    const written = JSON.parse(bumpRefusal(JSON.stringify({ no_session: { "5": 1 }, path: "C:/secret", chat: "abc" }), "ambiguous_session", 5 * HOUR));
    expect(Object.keys(written).sort()).toEqual(["ambiguous_session", "no_session"]);
    for (const garbage of ["not json", "[]", "null", JSON.stringify({ no_session: { abc: 3, "5": -1, "6": 1.5 } })]) {
      expect(refusalCounts(garbage, 6 * HOUR)).toEqual({ no_session: 0, ambiguous_session: 0 });
    }
  });
  it("surfaces counts beside any status, and is null when there were none", () => {
    const refusals = bumpRefusal(bumpRefusal("{}", "no_session", NOW), "ambiguous_session", NOW);
    const health = connectorHealth(stored(report()), TARGET, NOW, { refusals });
    expect(health.status).toBe("reported-current");
    expect(health.refusals).toEqual({ noSession: 1, ambiguousSession: 1, selfReportedStamp: null });
    expect(connectorHealth(stored(report()), TARGET, NOW, { refusals: "{}" }).refusals).toBeNull();
  });
});

describe("report schema 2: self-reported local stamp refusals", () => {
  const v2 = (over: Record<string, unknown> = {}) => report({ schema: 2, component: "proxy", stampRefusals24h: 3, stampRefusalReason: "undated", ...over });
  it("accepts a bounded count with a reason class, and rejects anything else", () => {
    expect(validateConnectorReport(v2())).not.toBeNull();
    expect(validateConnectorReport(v2({ stampRefusals24h: 0, stampRefusalReason: null }))).not.toBeNull();
    for (const bad of [
      v2({ stampRefusals24h: MAX_COUNT + 1 }), v2({ stampRefusals24h: -1 }), v2({ stampRefusals24h: 1.5 }), v2({ stampRefusals24h: "3" }),
      v2({ stampRefusalReason: "the stamp sid=abc" }), v2({ stampRefusals24h: 0, stampRefusalReason: "undated" }), v2({ stampRefusalReason: null }),
      report({ stampRefusals24h: 3, stampRefusalReason: "undated" }), // schema 1 carries no count
      (() => { const r: Record<string, unknown> = v2(); delete r.stampRefusalReason; return r; })(),
      report({ schema: 3 }),
    ]) expect(validateConnectorReport(bad)).toBeNull();
  });
  it("is shown beside the hub's own counts, labelled as the computer's, and never changes the status", () => {
    const health = connectorHealth(stored(report(), v2()), TARGET, NOW);
    expect(health.status).toBe("reported-current");
    expect(health.refusals).toEqual({ noSession: 0, ambiguousSession: 0, selfReportedStamp: { count: 3, reason: "undated" } });
  });
});

describe("the compatibility policy (addendum §1.2, §3.4)", () => {
  it("ships with NO required entries, and every cohort names an evidence file that exists", () => {
    const shipped = parseCompatPolicy(readFileSync("cli/compat-policy.json"));
    expect(shipped).not.toBeNull();
    expect(shipped!.required).toEqual([]);
    for (const cohort of shipped!.cohorts) expect(existsSync(cohort.evidence), cohort.id).toBe(true);
  });
  it("is packed: cli/package.json lists it", () => {
    expect(JSON.parse(readFileSync("cli/package.json", "utf8")).files).toContain("compat-policy.json");
  });
  it("rejects the WHOLE policy when any part is malformed, so nothing is claimed from a partial read", () => {
    expect(validateCompatPolicy(cohortPolicy([requiredEntry()]))).not.toBeNull();
    for (const bad of [
      { ...cohortPolicy(), schema: 2 },
      { ...cohortPolicy(), extra: true },
      cohortPolicy([requiredEntry({ cohorts: ["c-missing"] })]),
      cohortPolicy([requiredEntry({ class: "optional" })]),
      cohortPolicy([requiredEntry({ decision: "" })]),
      cohortPolicy([requiredEntry({ recovery: "" })]),
      cohortPolicy([requiredEntry(), requiredEntry()]),
      { ...cohortPolicy(), cohorts: [...cohortPolicy().cohorts, cohortPolicy().cohorts[0]] },
      { ...cohortPolicy(), cohorts: [{ ...cohortPolicy().cohorts[0], evidence: "tests/../../etc/passwd.test.ts" }] },
      { ...cohortPolicy(), cohorts: [{ ...cohortPolicy().cohorts[0], helpers: { "../credentials.json": H("1") } }] },
      { ...cohortPolicy(), cohorts: [{ ...cohortPolicy().cohorts[0], helpers: { "opencadre-config.mjs": [H("1"), H("2"), H("5")] } }] },
      { ...cohortPolicy(), cohorts: [{ ...cohortPolicy().cohorts[0], status: "unsupported" }] },
    ]) expect(validateCompatPolicy(bad)).toBeNull();
    expect(parseCompatPolicy(Buffer.from("{"))).toBeNull();
    expect(parseCompatPolicy(null)).toBeNull();
  });
  // The class is the plan's own (addendum §3.4). It admits `;` and `/`, which is safe because this text is only ever
  // DISPLAYED; what it refuses is command substitution, markup, pipes, redirection and quoting.
  it("displays hub text only inside its character class: substitution, markup, pipes and quotes are refused", () => {
    for (const hostile of ["$(curl evil)", "`id`", "${HOME}", "<script>", "x && y", "a | b", "a > b", 'say "hi"', "x".repeat(201), "line\nbreak"]) {
      expect(DISPLAY_TEXT.test(hostile), hostile).toBe(false);
      expect(validateCompatPolicy(cohortPolicy([requiredEntry({ feature: hostile })])), hostile).toBeNull();
      expect(validateCompatPolicy(cohortPolicy([requiredEntry({ reason: hostile })])), hostile).toBeNull();
      expect(validateCompatPolicy(cohortPolicy([requiredEntry({ recovery: hostile })])), hostile).toBeNull();
    }
  });
});

describe("cohort recognition: the whole helper set by full sha256, never a partial match", () => {
  const policy = validateCompatPolicy(cohortPolicy())!;
  it("recognises either rendering of each helper, and nothing less than the whole set", () => {
    expect(recognizeCohort(policy, { "opencadre-config.mjs": H("1"), "opencadre-mcp.mjs": H("3") })?.id).toBe("c-old");
    expect(recognizeCohort(policy, { "opencadre-config.mjs": H("2"), "opencadre-mcp.mjs": H("3") })?.id).toBe("c-old");
    // Missing one helper, one extra helper, or one hash from another revision: no cohort.
    expect(recognizeCohort(policy, { "opencadre-mcp.mjs": H("3") })).toBeNull();
    expect(recognizeCohort(policy, { "opencadre-config.mjs": H("1"), "opencadre-mcp.mjs": H("3"), "pure-ack.mjs": H("9") })).toBeNull();
    expect(recognizeCohort(policy, { "opencadre-config.mjs": H("1"), "opencadre-mcp.mjs": H("9") })).toBeNull();
    expect(recognizeCohort(null, { "opencadre-config.mjs": H("4") })).toBeNull();
  });
  it("names a cohort only from coherent matches-metadata reports that all agree", () => {
    const old = report({ helpers: { "opencadre-config.mjs": H("1"), "opencadre-mcp.mjs": H("3") } });
    expect(connectorHealth(stored(old), TARGET, NOW, { compat: policy }).cohort).toEqual({ id: "c-old", required: false });
    expect(connectorHealth(stored(old), TARGET, NOW, { compat: policy }).status).toBe("update-available");
    const other = report({ installationId: "b".repeat(32), helpers: { "opencadre-config.mjs": H("4") } });
    expect(connectorHealth(stored(old, other), TARGET, NOW, { compat: policy }).cohort).toBeNull();
    expect(connectorHealth(stored(report({ integrity: "unknown", helpers: old.helpers })), TARGET, NOW, { compat: policy }).cohort).toBeNull();
  });
});

describe("security-update-required: only from a reviewed required entry (fixture policies only)", () => {
  const old = report({ helpers: { "opencadre-config.mjs": H("1"), "opencadre-mcp.mjs": H("3") } });
  it("names the required feature for a recognised required cohort", () => {
    const policy = validateCompatPolicy(cohortPolicy([requiredEntry()]))!;
    const health = connectorHealth(stored(old), TARGET, NOW, { compat: policy });
    expect(health.status).toBe("security-update-required");
    expect(health.requiredFeature).toBe("per-chat identity on stamp clients");
    expect(health.cohort).toEqual({ id: "c-old", required: true });
  });
  it("is never inferred: an unknown set, a supported cohort, or no policy stays an optional update", () => {
    const policy = validateCompatPolicy(cohortPolicy([requiredEntry()]))!;
    const unknownSet = report({ helpers: { "opencadre-config.mjs": H("7"), "opencadre-mcp.mjs": H("3") } });
    expect(connectorHealth(stored(unknownSet), TARGET, NOW, { compat: policy }).status).toBe("update-available");
    expect(connectorHealth(stored(old), TARGET, NOW, { compat: validateCompatPolicy(cohortPolicy())! }).status).toBe("update-available");
    expect(connectorHealth(stored(old), TARGET, NOW, { compat: null }).status).toBe("update-available");
    expect(connectorHealth(stored(old), TARGET, NOW, { compat: policy }).requiredFeature).not.toBeNull();
    expect(connectorHealth(stored(unknownSet), TARGET, NOW, { compat: policy }).requiredFeature).toBeNull();
  });
  it("modified files still read as check installation first", () => {
    const policy = validateCompatPolicy(cohortPolicy([requiredEntry()]))!;
    expect(connectorHealth(stored(old, report({ installationId: "c".repeat(32), integrity: "modified-or-missing" })), TARGET, NOW, { compat: policy }).status).toBe("check-installation");
  });
});
