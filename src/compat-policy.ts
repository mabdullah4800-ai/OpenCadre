// The connector compatibility policy (PLAN-PR-E addendum §1.2; amendment 2 §4.1, §5): a reviewed, checked-in file,
// cli/compat-policy.json, packed into the CLI package and read back by the hub from the SAME snapshot as build.json
// (src/cli-package.ts), so the manifest, the package and the policy describe one deployment. It is served as the
// additive `compat` field of GET /cli/manifest.json; readers that predate it check only the fields they name and ignore
// it.
//
//   { "schema": 1,
//     "cohorts":  [ { "id": "c-<name>", "helpers": { "<helper>": "<sha256>" | ["<sha256 LF>", "<sha256 CRLF>"] },
//                     "status": "supported", "evidence": "tests/<file>.test.ts", "contracts": ["identity", ...] } ],
//     "required": [ { "id": "r-<name>", "cohorts": ["c-<name>"], "class": "security", "feature": "<text>",
//                     "reason": "<text>", "decision": "<record id or doc anchor>", "recovery": "<text>" } ] }
//
// RULES THIS FILE ENFORCES
// - A cohort is recognised only from the WHOLE reported helper set, matched by full sha256: the same names, and every
//   hash one of that helper's listed renderings (LF and CRLF of one revision are both that revision). A partial match,
//   a stamp, or a bundle id is never enough (PR-C §9.4).
// - Unknown is never escalated to security-required by a guess: an unrecognised set is simply no cohort.
// - Entries come from PLAN-COMPAT's measured contract tests; PR-E adds none on its own authority. Required entries stay
//   PROPOSED until the reserved, evidence-backed recorded decision exists, so the shipped `required` array is EMPTY
//   (amendment 2 §5) and the required path is exercised with fixture policies only.
// - Hub-provided text (`feature`, `reason`, `recovery`) is DISPLAYED, never executed, and must match the narrow
//   character class below (addendum §3.4). A policy with ANY malformed part is rejected whole: the hub then serves no
//   `compat` field and claims nothing, rather than serving the parts it could read.
//
// Self-reported inventory only: nothing here authenticates, authorises, bills or refuses anything.

export const COMPAT_ENTRY = "package/compat-policy.json";
export const COMPAT_MAX_BYTES = 256 * 1024;
const MAX_COHORTS = 64;
const MAX_REQUIRED = 32;
const HASH = /^[0-9a-f]{64}$/;
const HELPER_NAME = /^(?:opencadre-[a-z0-9-]+\.mjs|pure-ack\.mjs|opencadre-kilo-plugin\.js|opencode-plugin\/(?:index|mail|clearance)\.js)$/;
const COHORT_ID = /^c-[a-z0-9][a-z0-9-]{0,39}$/;
const REQUIRED_ID = /^r-[a-z0-9][a-z0-9-]{0,39}$/;
/** Addendum §3.4: the only characters hub-provided display text may hold. No `$`, backtick, quote, `<`, `&` or `|`. */
export const DISPLAY_TEXT = /^[A-Za-z0-9 .,:;()'/_-]{1,200}$/;
const DECISION = /^[A-Za-z0-9 .,:;()'/_#-]{1,200}$/;
const EVIDENCE = /^tests\/[A-Za-z0-9._/-]{1,120}\.test\.ts$/;
const CONTRACT = /^[a-z][a-z0-9-]{0,39}$/;

export interface CompatCohort {
  id: string;
  /** Helper name -> its accepted renderings (one or two full sha256 values). */
  helpers: Record<string, string[]>;
  status: "supported";
  evidence: string;
  contracts: string[];
}
export interface CompatRequired {
  id: string;
  cohorts: string[];
  class: "security";
  feature: string;
  reason: string;
  decision: string;
  recovery: string;
}
export interface CompatPolicy {
  schema: 1;
  cohorts: CompatCohort[];
  required: CompatRequired[];
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && Object.keys(o).every((k) => keys.includes(k));
const stringList = (v: unknown, test: RegExp, max: number): v is string[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= max && v.every((s) => typeof s === "string" && test.test(s)) && new Set(v).size === v.length;

function cohortOf(raw: unknown): CompatCohort | null {
  if (!isObject(raw) || !exactKeys(raw, ["id", "helpers", "status", "evidence", "contracts"])) return null;
  if (typeof raw.id !== "string" || !COHORT_ID.test(raw.id) || raw.status !== "supported") return null;
  if (typeof raw.evidence !== "string" || !EVIDENCE.test(raw.evidence) || raw.evidence.includes("..")) return null;
  if (!stringList(raw.contracts, CONTRACT, 16)) return null;
  if (!isObject(raw.helpers)) return null;
  const entries = Object.entries(raw.helpers);
  if (entries.length < 1 || entries.length > 32) return null;
  const helpers: Record<string, string[]> = {};
  for (const [name, value] of entries) {
    if (name.length > 80 || !HELPER_NAME.test(name)) return null;
    const renderings = typeof value === "string" ? [value] : value;
    if (!Array.isArray(renderings) || renderings.length > 2 || !stringList(renderings, HASH, 2)) return null;
    helpers[name] = [...renderings];
  }
  return { id: raw.id, helpers, status: "supported", evidence: raw.evidence, contracts: [...raw.contracts] };
}

function requiredOf(raw: unknown, cohortIds: Set<string>): CompatRequired | null {
  if (!isObject(raw) || !exactKeys(raw, ["id", "cohorts", "class", "feature", "reason", "decision", "recovery"])) return null;
  if (typeof raw.id !== "string" || !REQUIRED_ID.test(raw.id) || raw.class !== "security") return null;
  if (!stringList(raw.cohorts, COHORT_ID, MAX_COHORTS) || !raw.cohorts.every((id) => cohortIds.has(id))) return null;
  for (const field of ["feature", "reason", "recovery"] as const) {
    if (typeof raw[field] !== "string" || !DISPLAY_TEXT.test(raw[field] as string)) return null;
  }
  if (typeof raw.decision !== "string" || !DECISION.test(raw.decision)) return null;
  return {
    id: raw.id, cohorts: [...raw.cohorts], class: "security",
    feature: raw.feature as string, reason: raw.reason as string, decision: raw.decision, recovery: raw.recovery as string,
  };
}

/** The policy, or null when any part of it is malformed. A null policy claims nothing: no cohort, no required entry. */
export function validateCompatPolicy(raw: unknown): CompatPolicy | null {
  if (!isObject(raw) || !exactKeys(raw, ["schema", "cohorts", "required"]) || raw.schema !== 1) return null;
  if (!Array.isArray(raw.cohorts) || raw.cohorts.length > MAX_COHORTS) return null;
  if (!Array.isArray(raw.required) || raw.required.length > MAX_REQUIRED) return null;
  const cohorts: CompatCohort[] = [];
  for (const c of raw.cohorts) {
    const cohort = cohortOf(c);
    if (!cohort || cohorts.some((seen) => seen.id === cohort.id)) return null;
    cohorts.push(cohort);
  }
  const ids = new Set(cohorts.map((c) => c.id));
  const required: CompatRequired[] = [];
  for (const r of raw.required) {
    const entry = requiredOf(r, ids);
    if (!entry || required.some((seen) => seen.id === entry.id)) return null;
    required.push(entry);
  }
  return { schema: 1, cohorts, required };
}

/** Parses the policy file's bytes: null when absent, oversized, not JSON, or malformed. */
export function parseCompatPolicy(bytes: Buffer | null): CompatPolicy | null {
  if (!bytes || bytes.length > COMPAT_MAX_BYTES) return null;
  try {
    return validateCompatPolicy(JSON.parse(bytes.toString("utf8")));
  } catch {
    return null;
  }
}

/** The cohort whose WHOLE helper set equals `helpers` by full sha256, or null. Never a partial or best-effort match. */
export function recognizeCohort(policy: CompatPolicy | null, helpers: Record<string, string> | null): CompatCohort | null {
  if (!policy || !helpers) return null;
  const names = Object.keys(helpers);
  for (const cohort of policy.cohorts) {
    const want = Object.keys(cohort.helpers);
    if (want.length !== names.length) continue;
    if (names.every((name) => Object.hasOwn(cohort.helpers, name) && cohort.helpers[name].includes(helpers[name]))) return cohort;
  }
  return null;
}

/** The first `required` entry naming `cohortId`, or null. */
export function requiredFor(policy: CompatPolicy | null, cohortId: string): CompatRequired | null {
  return policy?.required.find((r) => r.cohorts.includes(cohortId)) ?? null;
}
